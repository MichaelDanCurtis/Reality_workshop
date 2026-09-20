"""Exercise real engine files in artifacts/spatial-check, never user documents."""
from pathlib import Path
import json, os, subprocess, math
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts/spatial-check';OUT.mkdir(parents=True,exist_ok=True)

def job(engine,label,source=None,ops=None,export=None,render=False):
    ext='FCStd' if engine=='FreeCAD' else 'blend'
    stem=OUT/f'{engine.lower()}-{label}'
    payload={'input':str(source) if source else None,'output':str(stem.with_suffix('.'+ext)),'response':str(stem.with_suffix('.json')),'operations':ops or [],'export':str(export) if export else None,'render':str(stem.with_suffix('.png')) if render else None}
    request=stem.with_suffix('.request.json');request.write_text(json.dumps(payload))
    response=Path(payload['response']);response.unlink(missing_ok=True)
    script=ROOT/'src-tauri/workers/engines'/('freecad_worker.py' if engine=='FreeCAD' else 'blender_worker.py')
    cmd=['/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd',str(script)] if engine=='FreeCAD' else ['/Applications/Blender.app/Contents/MacOS/Blender','--background','--disable-autoexec','--python',str(script)]
    p=subprocess.run(cmd,env={**os.environ,'WORKSHOP_SPATIAL_JOB':str(request)},capture_output=True,timeout=180)
    stem.with_suffix('.log').write_bytes(p.stdout+p.stderr)
    assert response.exists(),p.stderr.decode(errors='replace')[-1000:]
    result=json.loads(response.read_text());assert result['ok'],result
    meta=result['document']
    assert all(len(o['vertices'])%3==0 and len(o['triangles'])%3==0 for o in meta['objects'])
    assert all(i<len(o['vertices'])/3 for o in meta['objects'] for i in o['triangles'])
    print(engine,label,'PASS',flush=True)
    return Path(payload['output']),meta

if __name__=='__main__':
    cad,m=job('FreeCAD','box',ops=[{'kind':'add','shape':'box'}]);box=m['objects'][0]['id'];assert abs(m['objects'][0]['volume']-24000)<.01
    cad,m=job('FreeCAD','dimensions',cad,[{'kind':'dimensions','object':box,'values':{'Length':60}}]);assert abs(m['objects'][0]['volume']-36000)<.01
    cad,m=job('FreeCAD','cylinder',cad,[{'kind':'add','shape':'cylinder'}]);cylinder=m['selected']
    cad,m=job('FreeCAD','position',cad,[{'kind':'transform','object':cylinder,'position':[20,15,-10],'rotation':[0,0,0]}])
    cad,m=job('FreeCAD','cut',cad,[{'kind':'cut','object':box,'other':cylinder}]);cut=next(o for o in m['objects'] if o['id']==m['selected']);assert abs(cut['volume']-(36000-2000*math.pi))<.1 and cut['valid']
    cad,m=job('FreeCAD','reopen',cad,export=OUT/'part.step');assert len(m['objects'])==3
    _,m=job('FreeCAD','step-roundtrip',OUT/'part.step');assert abs(sum(o['volume'] for o in m['objects'])-cut['volume'])<.1
    job('FreeCAD','stl',cad,export=OUT/'part.stl')
    scene,m=job('Blender','box',ops=[{'kind':'add','shape':'box'}]);cube=m['objects'][0]['id']
    scene,m=job('Blender','properties',scene,[{'kind':'dimensions','object':cube,'values':{'Width':4,'Height':3}},{'kind':'transform','object':cube,'position':[1,2,3],'rotation':[0,0,25]},{'kind':'color','object':cube,'color':'#b84f28'}]);assert abs(m['objects'][0]['dimensions']['Width']-4)<.001
    scene,m=job('Blender','reopen',scene,export=OUT/'scene.glb');assert m['objects'][0]['position']==[1,2,3]
    job('Blender','glb-roundtrip',OUT/'scene.glb')
    job('Blender','cad-import',OUT/'part.stl')
    _,converted=job('Blender','cad-millimetres-to-metres',OUT/'part.stl',[{'kind':'units_mm_to_m'}],render=True)
    dims=converted['objects'][0]['dimensions']
    assert abs(dims['Width']-.060)<.00001 and abs(dims['Depth']-.030)<.00001 and abs(dims['Height']-.020)<.00001,dims
    job('Blender','render',scene,render=True)
    from PIL import Image
    assert Image.open(OUT/'blender-render.png').size==(1200,900)
    print('Spatial native files, B-rep volume, mesh exports, and Blender render PASS',flush=True)
