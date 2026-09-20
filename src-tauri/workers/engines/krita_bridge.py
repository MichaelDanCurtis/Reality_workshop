"""Krita extension for Workshop's private worker process; inert in ordinary Krita."""
import base64, json, os, pathlib, traceback, time
from krita import Krita, Extension, InfoObject, ManagedColor, Selection
from PyQt5.QtCore import QTimer, QPoint, QPointF, QByteArray, QUuid, QObject, QEvent, Qt
from PyQt5.QtGui import QColor, QImage, QPainter, QPolygonF, QGuiApplication, QWindow
from PyQt5.QtWidgets import QApplication, QWidget


def require(value, message):
    if value is False or value is None:
        raise RuntimeError(message)
    return value


def walk(nodes):
    for node in nodes:
        yield node
        yield from walk(node.childNodes())


# Keep the active document and its view alive between jobs. Closing the active
# view while Krita's node-model updates are queued can crash released 5.3 builds.
# Immutable on-disk revisions remain authoritative; switching to an older revision
# opens a fresh document. The private process is recycled after six such switches.
_cached_document = None
_cached_view = None
_cached_path = None
_retained_documents = []


class WorkerWindows(QObject):
    """Keep every private worker window off screen, including transient popups.

    Hiding only the main window once is insufficient: opening a painting view can
    show it again, and Krita also creates independent tool and popup windows.
    Retain the normal Qt platform because its offscreen plugin has no usable
    clipboard on macOS; painting still needs a real (hidden) Krita view.
    """
    def conceal(self, widget):
        if isinstance(widget, QWidget) and widget.isWindow():
            widget.setAttribute(Qt.WA_DontShowOnScreen, True)
            widget.setAttribute(Qt.WA_ShowWithoutActivating, True)
            widget.hide()

    def eventFilter(self, watched, event):
        if isinstance(watched, QWidget) and watched.isWindow():
            if event.type() == QEvent.Polish:
                watched.setAttribute(Qt.WA_DontShowOnScreen, True)
                watched.setAttribute(Qt.WA_ShowWithoutActivating, True)
            elif event.type() == QEvent.Show:
                self.conceal(watched)
        elif isinstance(watched, QWindow) and watched.isTopLevel() and event.type() == QEvent.Show:
            # Qt Quick tooltips/popups do not necessarily have a QWidget owner.
            watched.hide()
        return False

    def conceal_all(self):
        for widget in QApplication.topLevelWidgets():
            self.conceal(widget)
        for window in QGuiApplication.allWindows():
            if window.isTopLevel():
                window.hide()


def run(job):
    global _cached_document, _cached_view, _cached_path
    app = Krita.instance()
    if job.get('input') and job['input'] == _cached_path:
        doc, view = _cached_document, _cached_view
    else:
        doc = require(app.openDocument(job['input']), 'Cannot open document') if job.get('input') else require(app.createDocument(job.get('width',1600), job.get('height',1000), 'Untitled', 'RGBA', 'U8', '', 100.0), 'Cannot create document')
        doc.setBatchmode(True)
        window = require(app.activeWindow(), 'Krita has no worker window')
        view = require(window.addView(doc), 'Cannot create painting view')
        _retained_documents.append(doc)
    _cached_path = None
    _cached_document, _cached_view = doc, view
    doc.waitForDone()
    selected = None
    modes = {'normal':'normal', 'multiply':'multiply', 'screen':'screen', 'overlay':'overlay'}
    try:
        if not doc.topLevelNodes():
            layer = doc.createNode('Background', 'paintlayer')
            doc.rootNode().addChildNode(layer, None)
        for op in job.get('operations', []):
            kind = op['kind']
            layer = next((n for n in walk(doc.topLevelNodes()) if n.uniqueId().toString() == op.get('layer')), None)
            if kind not in ('add_layer','add_group','select','clear_selection','crop','rotate','import_layer') and layer is None:
                raise ValueError('The selected layer no longer exists')
            if layer:
                doc.setActiveNode(layer)
                selected = layer.uniqueId().toString()
            if kind in ('add_layer','add_group'):
                node = doc.createNode(op.get('name', 'Paint layer' if kind == 'add_layer' else 'Group'), 'paintlayer' if kind == 'add_layer' else 'grouplayer')
                require(doc.rootNode().addChildNode(node, None), 'Cannot add layer')
                selected = node.uniqueId().toString()
            elif kind == 'import_layer':
                other = require(app.openDocument(op['path']), 'Cannot open layer image')
                node = doc.createNode(pathlib.Path(op['path']).stem, 'paintlayer')
                doc.rootNode().addChildNode(node,None)
                node.setPixelData(other.pixelData(0,0,other.width(),other.height()),0,0,other.width(),other.height())
                other.setModified(False)
                other.close()
                selected = node.uniqueId().toString()
            elif kind == 'duplicate':
                node = layer.duplicate()
                node.setName(layer.name() + ' copy')
                require(layer.parentNode().addChildNode(node, layer), 'Cannot duplicate layer')
                selected = node.uniqueId().toString()
            elif kind == 'delete':
                require(layer.remove(), 'Cannot remove layer')
                selected = None
            elif kind == 'rename':
                layer.setName(op['name'])
            elif kind == 'visibility':
                layer.setVisible(op['visible'])
            elif kind == 'opacity':
                layer.setOpacity(round(op['value']*255/100))
            elif kind == 'blend':
                layer.setBlendingMode(modes[op['mode']])
            elif kind == 'reorder':
                parent = layer.parentNode()
                siblings = list(reversed(parent.childNodes()))
                index = siblings.index(layer)
                new_index = max(0, min(len(siblings)-1,index + int(op['direction'])))
                siblings.pop(index)
                siblings.insert(new_index, layer)
                parent.setChildNodes(list(reversed(siblings)))
            elif kind == 'move':
                position=layer.position()
                layer.move(position.x()+int(op['dx']), position.y()+int(op['dy']))
            elif kind == 'select':
                w,h = doc.width(),doc.height()
                mask = QImage(w,h,QImage.Format_Grayscale8)
                mask.fill(0)
                painter = QPainter(mask)
                painter.setPen(QColor('white'))
                painter.setBrush(QColor('white'))
                painter.drawPolygon(QPolygonF([QPointF(p['x']*w,p['y']*h) for p in op['points']]))
                painter.end()
                ptr=mask.bits(); ptr.setsize(mask.sizeInBytes())
                raw=bytes(ptr)
                # QImage rows can contain padding; Selection expects packed rows.
                packed=b''.join(raw[y*mask.bytesPerLine():y*mask.bytesPerLine()+w] for y in range(h))
                selection=Selection(); selection.setPixelData(QByteArray(packed),0,0,w,h)
                doc.setSelection(selection)
            elif kind == 'clear_selection':
                doc.setSelection(None)
            elif kind == 'mask':
                mask=doc.createTransparencyMask('Layer mask')
                layer.addChildNode(mask,None)
                w,h=doc.width(),doc.height()
                selection=doc.selection()
                pixels=selection.pixelData(0,0,w,h) if selection else QByteArray(bytes([255])*(w*h))
                mask.setPixelData(pixels,0,0,w,h)
                doc.setSelection(None)
            elif kind == 'remove_mask':
                mask=next((n for n in layer.childNodes() if n.type()=='transparencymask'), None)
                require(mask,'No mask on this layer').remove()
            elif kind in ('stroke','fill'):
                target=next((n for n in layer.childNodes() if n.type()=='transparencymask'), None) if op.get('target')=='mask' else layer
                require(target,'No mask on this layer')
                doc.setActiveNode(target)
                presets=app.resources('preset')
                preset=op.get('preset') or next((k for k in presets if 'Basic-5 Size' in k), next(iter(presets)))
                require(presets.get(preset), 'Unknown brush preset')
                view.setCurrentBrushPreset(presets[preset])
                view.setForeGroundColor(ManagedColor.fromQColor(QColor(op['color']),view.canvas()))
                view.setBrushSize(op.get('size',30))
                view.setPaintingOpacity(op.get('opacity',100)/100)
                view.setEraserMode(op.get('erase',False))
                if not hasattr(target,'paintLine'):
                    raise RuntimeError('This Krita version does not expose native brush strokes')
                if target.paintAbility() != 'PAINT':
                    raise RuntimeError('The selected layer cannot be painted with this brush')
                if kind == 'fill':
                    from PyQt5.QtCore import QRectF
                    target.paintRectangle(QRectF(0,0,doc.width(),doc.height()),'None','ForegroundColor')
                else:
                    points=op['points']
                    if len(points)==1:
                        points=points+[dict(points[0],x=points[0]['x']+0.00001)]
                    for a,b in zip(points,points[1:]):
                        target.paintLine(QPoint(round(a['x']*doc.width()),round(a['y']*doc.height())),QPoint(round(b['x']*doc.width()),round(b['y']*doc.height())),a.get('pressure',1),b.get('pressure',1),'ForegroundColor')
                    doc.waitForDone()
            elif kind in ('invert','desaturate'):
                f=app.filter('invert' if kind=='invert' else 'desaturate')
                require(f,'Filter unavailable').apply(layer,0,0,doc.width(),doc.height())
            elif kind=='crop':
                doc.crop(int(op['x']),int(op['y']),int(op['width']),int(op['height']))
            elif kind=='rotate':
                import math
                doc.rotateImage(math.pi/2)
            else:
                raise ValueError('Unsupported Krita operation: '+kind)
            doc.waitForDone()
        doc.refreshProjection(); doc.waitForDone()
        require(doc.saveAs(job['output']),'Cannot save KRA')
        require(doc.thumbnail(1024,1024).save(job['preview']),'Cannot render preview')
        if job.get('export'):
            require(doc.exportImage(job['export'],InfoObject()),'Cannot export image')
        def info(n, depth=0):
            masks=[c for c in n.childNodes() if c.type()=='transparencymask']
            return [{'id':n.uniqueId().toString(),'name':n.name(),'kind':'group' if n.type()=='grouplayer' else n.type(),'visible':n.visible(),'opacity':n.opacity()*100/255,'mode':n.blendingMode(),'depth':depth,'mask':bool(masks),'locked':n.locked()}]+[a for c in reversed(n.childNodes()) if c not in masks for a in info(c,depth+1)]
        selection_preview = None
        if doc.selection():
            w,h=doc.width(),doc.height()
            raw=doc.selection().pixelData(0,0,w,h)
            mask_image=QImage(bytes(raw),w,h,w,QImage.Format_Grayscale8).copy()
            selection_file=job['preview']+'.selection.png'
            mask_image.scaled(1024,1024,1,1).save(selection_file)
            selection_preview='data:image/png;base64,'+base64.b64encode(open(selection_file,'rb').read()).decode('ascii')
        _cached_path = job['output']
        return {'selection_preview':selection_preview,'width':doc.width(),'height':doc.height(),'layers':[a for n in reversed(doc.topLevelNodes()) for a in info(n)],'selected':selected,'selection':bool(doc.selection()),'engine_version':app.version(),'presets':sorted(app.resources('preset').keys())}
    finally:
        doc.setModified(False)


class WorkshopBridge(Extension):
    def setup(self):
        folder=os.environ.get('WORKSHOP_ENGINE_QUEUE')
        if not folder:
            return
        QApplication.setQuitOnLastWindowClosed(False)
        self.windows = WorkerWindows(self)
        QApplication.instance().installEventFilter(self.windows)
        self.windows.conceal_all()
        self.folder=pathlib.Path(folder)
        self.timer=QTimer()
        self.timer.timeout.connect(self.poll)
        self.timer.start(80)
        (self.folder/'ready').write_text(Krita.instance().version())
    def createActions(self,window):
        if os.environ.get("WORKSHOP_ENGINE_QUEUE"):
            self.windows.conceal(window.qwindow())
    def poll(self):
        self.windows.conceal_all()
        if not Krita.instance().activeWindow():
            return
        if (self.folder/'stop').exists():
            QApplication.quit(); return
        for path in sorted(self.folder.glob('*.request.json')):
            self.timer.stop()
            try:
                job=json.loads(path.read_text())
                try:
                    result={'ok':True,'document':run(job)}
                except Exception as exc:
                    result={'ok':False,'error':str(exc),'trace':traceback.format_exc()}
                target=pathlib.Path(job['response'])
                tmp=target.with_suffix('.tmp')
                tmp.write_text(json.dumps(result)); tmp.replace(target)
                path.unlink()
                if len(_retained_documents) >= 6:
                    os._exit(0)
            finally:
                self.timer.start(80)
            return

Krita.instance().addExtension(WorkshopBridge(Krita.instance()))
