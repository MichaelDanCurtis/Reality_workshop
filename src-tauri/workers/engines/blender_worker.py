"""Editable Blender scenes exposed through Workshop's shared 3D workbench."""
import bpy, json, os, pathlib, math, traceback
from mathutils import Vector, Matrix


def run(job):
    source=job.get('input')
    if source and pathlib.Path(source).suffix.lower()=='.blend':
        bpy.ops.wm.open_mainfile(filepath=source,load_ui=False,use_scripts=False)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        if source:
            if pathlib.Path(source).suffix.lower()=='.stl':
                bpy.ops.wm.stl_import(filepath=source)
            else:
                bpy.ops.import_scene.gltf(filepath=source)
    selected=None
    def object_for(identity):
        obj=bpy.data.objects.get(identity)
        if not obj or obj.type!='MESH':
            raise ValueError('Choose an existing mesh')
        return obj
    for op in job.get('operations',[]):
        kind=op['kind']
        if kind=='study_lighting':
            # Workshop's real-time light intensities need native render units.
            scene=bpy.context.scene
            for light in list(scene.objects):
                if light.type=='LIGHT':bpy.data.objects.remove(light,do_unlink=True)
            sun=bpy.data.lights.new('Study sunlight','SUN');sun.energy=3;sun.angle=math.radians(8)
            light=bpy.data.objects.new('Study sunlight',sun);scene.collection.objects.link(light)
            angle=math.radians(op['sun_angle'])
            direction=Vector((math.cos(angle)*25,-math.sin(angle)*25,28))
            light.rotation_euler=(-direction).to_track_quat('-Z','Y').to_euler()
            if not scene.world:scene.world=bpy.data.worlds.new('Study sky')
            scene.world.use_nodes=True
            background=scene.world.node_tree.nodes.get('Background')
            background.inputs[0].default_value=(.48,.65,.8,1);background.inputs[1].default_value=.45
            scene.camera=next((o for o in scene.objects if o.type=='CAMERA'),None)
            continue
        if kind=='units_mm_to_m':
            # Internal CAD handoff: STL has no unit metadata. FreeCAD exports mm.
            for mesh in bpy.data.meshes:
                mesh.transform(Matrix.Scale(.001,4))
            for obj in bpy.context.scene.objects:
                if obj.type=='MESH':obj['workshop_label']=op.get('name','CAD solid')
            bpy.context.view_layer.update()
            continue
        if kind=='add':
            if op['shape']=='box': bpy.ops.mesh.primitive_cube_add(size=2)
            elif op['shape']=='cylinder': bpy.ops.mesh.primitive_cylinder_add(vertices=48,radius=1,depth=2)
            else: bpy.ops.mesh.primitive_uv_sphere_add(segments=32,ring_count=16,radius=1)
            obj=bpy.context.object
        else:
            obj=object_for(op['object'])
            if kind=='dimensions':
                size=list(obj.dimensions)
                for key,value in op['values'].items(): size[{'Width':0,'Depth':1,'Height':2}[key]]=value
                obj.dimensions=size
            elif kind=='transform':
                obj.location=op['position']; obj.rotation_mode='XYZ'
                obj.rotation_euler=[math.radians(a) for a in op['rotation']]
            elif kind=='rename':
                # Keep the Blender datablock name as the stable identity.
                obj['workshop_label']=op['name']
            elif kind=='visibility':
                obj.hide_render=not op['visible'];obj.hide_set(not op['visible'])
            elif kind=='delete':
                bpy.data.objects.remove(obj,do_unlink=True);obj=None
            elif kind=='color':
                color=tuple(int(op['color'][i:i+2],16)/255 for i in (1,3,5))+(1,)
                material=bpy.data.materials.new('Workshop material');material.diffuse_color=color
                material.use_nodes=True;material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=color
                obj.data.materials.clear();obj.data.materials.append(material)
            elif kind in ('union','cut'):
                other=object_for(op['other'])
                bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
                modifier=obj.modifiers.new('Workshop boolean','BOOLEAN');modifier.operation='UNION' if kind=='union' else 'DIFFERENCE';modifier.object=other
                bpy.ops.object.modifier_apply(modifier=modifier.name)
                other.hide_render=True;other.hide_set(True)
            else: raise ValueError('Unsupported scene operation')
        bpy.context.view_layer.update()
        selected=obj.name if obj else None
    objects=[]
    depsgraph=bpy.context.evaluated_depsgraph_get()
    for obj in bpy.context.scene.objects:
        if obj.type!='MESH':continue
        evaluated=obj.evaluated_get(depsgraph);mesh=evaluated.to_mesh();mesh.calc_loop_triangles()
        if len(mesh.loop_triangles)>120000:
            evaluated.to_mesh_clear();raise ValueError('This mesh exceeds the current preview triangle limit')
        color=obj.active_material.diffuse_color if obj.active_material else (.39,.72,.69,1)
        objects.append({'id':obj.name,'name':obj.get('workshop_label',obj.name),'kind':'Mesh','visible':not obj.hide_render,
            'position':list(obj.location),'rotation':[math.degrees(a) for a in obj.rotation_euler],
            'dimensions':dict(zip(['Width','Depth','Height'],obj.dimensions)),
            'color':'#'+''.join(f'{max(0,min(255,round(c*255))):02x}' for c in color[:3]),
            'volume':None,'valid':True,
            'vertices':[float(c) for v in mesh.vertices for c in (obj.matrix_world @ v.co)],
            'triangles':[i for t in mesh.loop_triangles for i in t.vertices]})
        evaluated.to_mesh_clear()
    bpy.ops.wm.save_as_mainfile(filepath=job['output'])
    if job.get('export'):
        bpy.ops.object.select_all(action='DESELECT')
        for obj in bpy.context.scene.objects:
            if obj.type=='MESH' and not obj.hide_render:obj.select_set(True)
        if pathlib.Path(job['export']).suffix.lower()=='.stl':
            bpy.ops.wm.stl_export(filepath=job['export'],export_selected_objects=True)
        else:
            bpy.ops.export_scene.gltf(filepath=job['export'],export_format='GLB',use_selection=True)
    if job.get('render'):
        scene=bpy.context.scene
        if not scene.camera:
            scene.camera=next((o for o in scene.objects if o.type=='CAMERA'),None)
        if not scene.camera:
            points=[Vector(v) for o in scene.objects if o.type=='MESH' and not o.hide_render for v in [o.matrix_world @ Vector(c) for c in o.bound_box]]
            low=Vector([min((v[i] for v in points),default=-1) for i in range(3)])
            high=Vector([max((v[i] for v in points),default=1) for i in range(3)])
            center=(low+high)/2;size=max((high-low).length,.0001)
            bpy.ops.object.camera_add(location=center+Vector((1.3,-1.8,1.2))*size)
            scene.camera=bpy.context.object;scene.camera.rotation_euler=(center-scene.camera.location).to_track_quat('-Z','Y').to_euler()
            scene.camera.data.type='ORTHO';scene.camera.data.ortho_scale=size*1.5
            scene.camera.data.clip_start=max(size/10000,.000001)
            scene.camera.data.clip_end=max(size*100,1)
        if not any(o.type=='LIGHT' for o in scene.objects):
            bpy.ops.object.light_add(type='SUN',rotation=(.5,-.5,-.3));bpy.context.object.data.energy=3
        if not scene.world:scene.world=bpy.data.worlds.new('Workshop world')
        scene.world.color=(.18,.18,.18)
        scene.render.engine='BLENDER_EEVEE';scene.render.resolution_x=1200;scene.render.resolution_y=900;scene.render.resolution_percentage=100
        scene.render.image_settings.file_format='PNG';scene.render.filepath=job['render'];bpy.ops.render.render(write_still=True)
    return {'objects':objects,'selected':selected,'engine_version':bpy.app.version_string,'unit':'m'}


job=json.loads(pathlib.Path(os.environ['WORKSHOP_SPATIAL_JOB']).read_text())
try:result={'ok':True,'document':run(job)}
except Exception as exc:result={'ok':False,'error':str(exc),'trace':traceback.format_exc()}
pathlib.Path(job['response']).write_text(json.dumps(result))
