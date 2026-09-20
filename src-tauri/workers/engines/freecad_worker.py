"""Headless FreeCAD adapter. Native FCStd remains the authoritative document."""
import json, os, pathlib, traceback
import FreeCAD as App
import Part, Mesh


def run(job):
    source = job.get('input')
    if source and pathlib.Path(source).suffix.lower() == '.fcstd':
        doc = App.openDocument(source)
    else:
        doc = App.newDocument('Workshop')
        if source:
            Part.insert(source, doc.Name)
    def object_for(identity):
        obj = doc.getObject(identity)
        if obj is None or not hasattr(obj, 'Shape'):
            raise ValueError('Choose an existing solid')
        return obj
    def visible(obj):
        return obj.WorkshopVisible if 'WorkshopVisible' in obj.PropertiesList else not bool(obj.InList)
    def set_visible(obj, value):
        if 'WorkshopVisible' not in obj.PropertiesList:
            obj.addProperty('App::PropertyBool', 'WorkshopVisible', 'Workshop')
        obj.WorkshopVisible = value
    selected = None
    for op in job.get('operations', []):
        kind = op['kind']
        if kind == 'add':
            shape = op['shape']
            obj = doc.addObject({'box':'Part::Box', 'cylinder':'Part::Cylinder', 'sphere':'Part::Sphere'}[shape], shape.title())
            if shape == 'box':
                obj.Length, obj.Width, obj.Height = 40, 30, 20
            elif shape == 'cylinder':
                obj.Radius, obj.Height = 10, 40
            else:
                obj.Radius = 15
            set_visible(obj, True)
        else:
            obj = object_for(op['object'])
            if kind == 'dimensions':
                allowed = {'Part::Box': {'Length','Width','Height'}, 'Part::Cylinder': {'Radius','Height'}, 'Part::Sphere': {'Radius'}}.get(obj.TypeId, set())
                for name,value in op['values'].items():
                    if name not in allowed:
                        raise ValueError('This solid does not expose that dimension')
                    setattr(obj, name, value)
            elif kind == 'transform':
                pos,rot = op['position'],op['rotation']
                obj.Placement = App.Placement(App.Vector(*pos), App.Rotation(rot[2],rot[1],rot[0]))
            elif kind == 'rename':
                obj.Label = op['name']
            elif kind == 'visibility':
                set_visible(obj, op['visible'])
            elif kind == 'delete':
                if obj.InList:
                    raise ValueError('This solid is used by another feature. Remove that feature first.')
                doc.removeObject(obj.Name)
                obj = None
            elif kind in ('union','cut'):
                other = object_for(op['other'])
                result = doc.addObject('Part::Fuse' if kind == 'union' else 'Part::Cut', 'Union' if kind == 'union' else 'Cut')
                result.Base, result.Tool = obj,other
                doc.recompute()
                if result.Shape.isNull() or not result.Shape.isValid():
                    raise ValueError('The operation did not produce a valid solid')
                set_visible(obj, False); set_visible(other, False); set_visible(result, True)
                obj = result
            else:
                raise ValueError('Unsupported CAD operation')
        doc.recompute()
        selected = obj.Name if obj else None
    doc.recompute()
    objects = []
    for obj in doc.Objects:
        if not hasattr(obj,'Shape') or obj.Shape.isNull():
            continue
        shape = obj.Shape
        vertices,faces = shape.tessellate(max(.08,shape.BoundBox.DiagonalLength/600))
        if len(faces)>120000:
            raise ValueError('This model exceeds the current preview triangle limit')
        props = {'Part::Box':['Length','Width','Height'],'Part::Cylinder':['Radius','Height'],'Part::Sphere':['Radius']}.get(obj.TypeId,[])
        yaw,pitch,roll = obj.Placement.Rotation.toEuler()
        objects.append({'id':obj.Name,'name':obj.Label,'kind':obj.TypeId,'visible':visible(obj),
            'position':list(obj.Placement.Base),'rotation':[roll,pitch,yaw],
            'dimensions':{p:float(getattr(obj,p)) for p in props},'color':'#64b8b0',
            'volume':shape.Volume,'valid':shape.isValid(),
            'vertices':[float(c) for v in vertices for c in v],
            'triangles':[i for face in faces for i in face]})
    doc.saveAs(job['output'])
    if job.get('export'):
        chosen = [doc.getObject(o['id']) for o in objects if o['visible']]
        if not chosen:
            raise ValueError('Show at least one solid to export')
        if pathlib.Path(job['export']).suffix.lower() == '.stl':
            Mesh.export(chosen,job['export'])
        else:
            Part.export(chosen,job['export'])
    App.closeDocument(doc.Name)
    return {'objects':objects,'selected':selected,'engine_version':'.'.join(App.Version()[:3]),'unit':'mm'}


job=json.loads(pathlib.Path(os.environ['WORKSHOP_SPATIAL_JOB']).read_text())
try:
    result={'ok':True,'document':run(job)}
except Exception as exc:
    result={'ok':False,'error':str(exc),'trace':traceback.format_exc()}
pathlib.Path(job['response']).write_text(json.dumps(result))
