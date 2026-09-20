"""Typed native document jobs. Runs inside GIMP's Python batch interpreter."""
import base64, json, os, traceback
from gi.repository import Gimp, Gio, Gegl


def require(value, message):
    if value is False or value is None:
        raise RuntimeError(message)
    return value


def walk(items):
    for item in items:
        yield item
        if item.is_group():
            yield from walk(item.get_children())


def procedure(name, values):
    proc = require(Gimp.get_pdb().lookup_procedure(name), 'Unavailable procedure: ' + name)
    config = proc.create_config()
    for key, value in values.items():
        config.set_property(key, value)
    result = proc.run(config)
    if result.index(0) != Gimp.PDBStatusType.SUCCESS:
        raise RuntimeError(name + ' failed: ' + str(result.index(1)))


def run(job):
    src = job.get('input')
    image = require(Gimp.file_load(Gimp.RunMode.NONINTERACTIVE, Gio.File.new_for_path(src)), 'Cannot open document') if src else Gimp.Image.new(job.get('width', 1600), job.get('height', 1000), Gimp.ImageBaseType.RGB)
    active = None
    if not image.get_layers():
        layer = Gimp.Layer.new(image, 'Background', image.get_width(), image.get_height(), Gimp.ImageType.RGBA_IMAGE, 100, Gimp.LayerMode.NORMAL)
        require(image.insert_layer(layer, None, 0), 'Cannot create background')
        layer.fill(Gimp.FillType.WHITE)
    modes = {'normal': Gimp.LayerMode.NORMAL, 'multiply': Gimp.LayerMode.MULTIPLY, 'screen': Gimp.LayerMode.SCREEN, 'overlay': Gimp.LayerMode.OVERLAY}
    for op in job.get('operations', []):
        kind = op['kind']
        layers = list(walk(image.get_layers()))
        layer = next((l for l in layers if str(l.get_tattoo()) == op.get('layer')), None)
        if kind not in ('add_layer', 'add_group', 'select', 'clear_selection', 'crop', 'rotate', 'import_layer') and layer is None:
            raise ValueError('The selected layer no longer exists')
        if layer:
            active = str(layer.get_tattoo())
        if kind in ('add_layer', 'add_group'):
            if kind == 'add_group':
                new = Gimp.GroupLayer.new(image, op.get('name', 'Group'))
            else:
                new = Gimp.Layer.new(image, op.get('name', 'Paint layer'), image.get_width(), image.get_height(), Gimp.ImageType.RGBA_IMAGE, 100, Gimp.LayerMode.NORMAL)
            require(image.insert_layer(new, None, 0), 'Cannot add layer')
            active = str(new.get_tattoo())
        elif kind == 'import_layer':
            new = require(Gimp.file_load_layer(Gimp.RunMode.NONINTERACTIVE, image, Gio.File.new_for_path(op['path'])), 'Cannot load layer')
            image.insert_layer(new, None, 0)
            active = str(new.get_tattoo())
        elif kind == 'duplicate':
            new = layer.copy()
            new.set_name(layer.get_name() + ' copy')
            image.insert_layer(new, layer.get_parent(), image.get_item_position(layer))
            active = str(new.get_tattoo())
        elif kind == 'delete':
            require(image.remove_layer(layer), 'Cannot delete layer')
            active = None
        elif kind == 'rename':
            require(layer.set_name(op['name']), 'Cannot rename layer')
        elif kind == 'visibility':
            require(layer.set_visible(op['visible']), 'Cannot change visibility')
        elif kind == 'opacity':
            require(layer.set_opacity(op['value']), 'Cannot change opacity')
        elif kind == 'blend':
            require(layer.set_mode(modes[op['mode']]), 'Cannot change blend mode')
        elif kind == 'reorder':
            parent = layer.get_parent()
            siblings = parent.get_children() if parent else image.get_layers()
            pos = max(0, min(len(siblings)-1, image.get_item_position(layer) + int(op['direction'])))
            require(image.reorder_item(layer, parent, pos), 'Cannot reorder layer')
        elif kind == 'move':
            _, x, y = layer.get_offsets()
            require(layer.set_offsets(x + int(op['dx']), y + int(op['dy'])), 'Cannot move layer')
        elif kind == 'select':
            points = [v for p in op['points'] for v in (p['x']*image.get_width(), p['y']*image.get_height())]
            require(image.select_polygon(Gimp.ChannelOps.REPLACE, points), 'Cannot select region')
        elif kind == 'clear_selection':
            Gimp.Selection.none(image)
        elif kind == 'mask':
            if layer.get_mask():
                raise ValueError('This layer already has a mask')
            mask = layer.create_mask(Gimp.AddMaskType.SELECTION if not Gimp.Selection.is_empty(image) else Gimp.AddMaskType.WHITE)
            require(layer.add_mask(mask), 'Cannot add mask')
            Gimp.Selection.none(image)
        elif kind == 'remove_mask':
            require(layer.remove_mask(Gimp.MaskApplyMode.DISCARD), 'Cannot remove mask')
        elif kind == 'stroke':
            target = layer.get_mask() if op.get('target') == 'mask' else layer
            require(target, 'This layer has no mask')
            Gimp.context_push()
            try:
                Gimp.context_set_foreground(Gegl.Color.new(op['color']))
                Gimp.context_set_opacity(op.get('opacity', 100))
                Gimp.context_set_brush(Gimp.Brush.get_by_name(op.get('preset') or '2. Hardness 100'))
                Gimp.context_enable_dynamics(False)
                Gimp.context_set_brush_size(op['size'])
                coords = [v for p in op['points'] for v in (p['x']*image.get_width(), p['y']*image.get_height())]
                if len(coords) == 2:
                    coords += [coords[0]+0.01, coords[1]+0.01]
                if op.get('erase'):
                    require(Gimp.eraser_default(target, coords), 'Eraser failed')
                else:
                    require(Gimp.paintbrush_default(target, coords), 'Brush failed')
            finally:
                Gimp.context_pop()
        elif kind == 'fill':
            Gimp.context_set_foreground(Gegl.Color.new(op['color']))
            require(layer.edit_fill(Gimp.FillType.FOREGROUND), 'Fill failed')
        elif kind == 'invert':
            require(layer.invert(False), 'Invert failed')
        elif kind == 'desaturate':
            require(layer.desaturate(Gimp.DesaturateMode.LUMINANCE), 'Desaturate failed')
        elif kind == 'brightness_contrast':
            require(layer.brightness_contrast(op['brightness'], op['contrast']), 'Adjustment failed')
        elif kind == 'crop':
            require(image.crop(int(op['width']), int(op['height']), int(op['x']), int(op['y'])), 'Crop failed')
        elif kind == 'rotate':
            require(image.rotate(Gimp.RotationType.DEGREES90), 'Rotate failed')
        else:
            raise ValueError('Unsupported GIMP operation: ' + kind)
    image.get_thumbnail(1024, 1024, Gimp.PixbufTransparency.KEEP_ALPHA).savev(job['preview'], 'png', [], [])
    require(Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, image, Gio.File.new_for_path(job['output'])), 'Cannot save XCF')
    if job.get('export'):
        target = job['export']
        procedure('file-openraster-export' if target.lower().endswith('.ora') else 'file-png-export', {'run-mode': Gimp.RunMode.NONINTERACTIVE, 'image': image, 'file': Gio.File.new_for_path(target)})
    def info(l, depth=0):
        entry = {'id': str(l.get_tattoo()), 'name': l.get_name(), 'kind': 'group' if l.is_group() else 'paint', 'visible': l.get_visible(), 'opacity': l.get_opacity(), 'mode': next((k for k,v in modes.items() if v == l.get_mode()), 'other'), 'depth': depth, 'mask': bool(l.get_mask()), 'locked': l.get_lock_content()}
        return [entry] + [a for child in (l.get_children() if l.is_group() else []) for a in info(child, depth+1)]
    selection_preview = None
    if not Gimp.Selection.is_empty(image):
        selection_file = job['preview'] + '.selection.png'
        image.get_selection().get_thumbnail(1024, 1024, Gimp.PixbufTransparency.KEEP_ALPHA).savev(selection_file, 'png', [], [])
        selection_preview = 'data:image/png;base64,' + base64.b64encode(open(selection_file, 'rb').read()).decode('ascii')
    result = {'selection_preview': selection_preview, 'width': image.get_width(), 'height': image.get_height(), 'layers': [a for l in image.get_layers() for a in info(l)], 'selected': active, 'selection': not Gimp.Selection.is_empty(image), 'engine_version': Gimp.version(), 'presets': [b.get_name() for b in Gimp.brushes_get_list('')][:500]}
    image.delete()
    return result


def process_request(request):
    job = json.load(open(request))
    try:
        result = {'ok': True, 'document': run(job)}
    except Exception as exc:
        result = {'ok': False, 'error': str(exc), 'trace': traceback.format_exc()}
    finally:
        for remaining in Gimp.get_images():
            remaining.delete()
    with open(job['response'] + '.tmp', 'w') as f:
        json.dump(result, f)
    os.replace(job['response'] + '.tmp', job['response'])


if __name__ == '__main__':
    queue = os.environ.get('WORKSHOP_ENGINE_QUEUE')
    if queue:
        import pathlib, time
        folder = pathlib.Path(queue)
        (folder/'ready').write_text(Gimp.version())
        while not (folder/'stop').exists():
            requests = sorted(folder.glob('*.request.json'))
            for request in requests:
                process_request(request)
                request.unlink()
            time.sleep(.025)
    else:
        process_request(os.environ['WORKSHOP_ENGINE_REQUEST'])
