"""Live engine regression checks. Requires GIMP and a Workshop Krita worker queue.
Run from the repository: python3 scripts/check-native-engines.py <queue directory>
Only writes to artifacts/engine-check; never edits source or user documents.
"""
import json, os, pathlib, subprocess, sys, time, zipfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts/engine-check';OUT.mkdir(exist_ok=True,parents=True)
QUEUE=pathlib.Path(sys.argv[1]).resolve() if len(sys.argv)>1 else OUT/'krita-queue'

def job(engine,label,source=None,ops=None,export=None):
    suffix='xcf' if engine=='GIMP' else 'kra'
    stem=f'{engine.lower()}-{label}'
    response=OUT/f'{stem}.json';response.unlink(missing_ok=True)
    payload={'width':640,'height':400,'input':str(source) if source else None,'output':str(OUT/f'{stem}.{suffix}'),'preview':str(OUT/f'{stem}.png'),'response':str(response),'operations':ops or [],'export':str(export) if export else None}
    if engine=='GIMP':
        request=OUT/f'{stem}.request.json';request.write_text(json.dumps(payload))
        env={**os.environ,'WORKSHOP_ENGINE_REQUEST':str(request),'WORKSHOP_ENGINE_SCRIPT':str(ROOT/'src-tauri/workers/engines/gimp_worker.py')}
        result=subprocess.run(['/Applications/GIMP.app/Contents/MacOS/gimp','-n','-i','-s','--console-messages','--batch-interpreter=python-fu-eval','-b',"import os; exec(compile(open(os.environ['WORKSHOP_ENGINE_SCRIPT']).read(), 'worker', 'exec'))",'--quit'],env=env,capture_output=True,timeout=90)
        (OUT/f'{stem}.log').write_bytes(result.stdout+result.stderr)
    else:
        request=QUEUE/f'{stem}.request.json';temporary=request.with_suffix('.tmp');temporary.write_text(json.dumps(payload));temporary.replace(request)
        deadline=time.monotonic()+90
        while not response.exists() and time.monotonic()<deadline:time.sleep(.1)
    result=json.loads(response.read_text())
    assert result['ok'],result
    print(engine,label,'PASS',flush=True)
    return pathlib.Path(payload['output']),result['document']

def checks(engine):
    native,meta=job(engine,'layers',ops=[{'kind':'add_layer','name':'Drawing'}])
    layer=meta['layers'][0]['id'];assert len(meta['layers'])==2
    native,meta=job(engine,'brush-proof',native,[{'kind':'stroke','layer':layer,'color':'#19a5a2','size':70,'opacity':100,'preset':'2. Hardness 100' if engine=='GIMP' else 'b) Basic-5 Size','points':[{'x':.15,'y':.4,'pressure':.2},{'x':.5,'y':.7,'pressure':1},{'x':.85,'y':.4,'pressure':.4}]},{'kind':'opacity','layer':layer,'value':75},{'kind':'rename','layer':layer,'name':'Real engine marks'},{'kind':'blend','layer':layer,'mode':'multiply'}])
    assert meta['layers'][0]['name']=='Real engine marks' and abs(meta['layers'][0]['opacity']-75)<.3
    points=[{'x':x,'y':y,'pressure':1} for x,y in [(0,0),(.5,0),(.5,1),(0,1)]]
    native,meta=job(engine,'selection',native,[{'kind':'select','points':points}]);assert meta['selection'] and meta.get('selection_preview')
    native,meta=job(engine,'masked',native,[{'kind':'mask','layer':layer}]);assert meta['layers'][0]['mask'] and not meta['selection']
    native,meta=job(engine,'mask-brush',native,[{'kind':'stroke','layer':layer,'target':'mask','color':'#000000','size':35,'opacity':100,'preset':'2. Hardness 100' if engine=='GIMP' else 'b) Basic-5 Size','points':[{'x':.2,'y':.3,'pressure':1},{'x':.35,'y':.7,'pressure':1}]}])
    native,meta=job(engine,'reordered',native,[{'kind':'duplicate','layer':layer},{'kind':'reorder','layer':layer,'direction':-1},{'kind':'add_group','name':'Concept group'}]);assert len(meta['layers'])==4
    native,meta=job(engine,'native-reopen',native,export=OUT/f'{engine.lower()}-exchange.ora');assert len(meta['layers'])==4
    with zipfile.ZipFile(OUT/f'{engine.lower()}-exchange.ora') as z:assert 'stack.xml' in z.namelist()
    job(engine,'final-png',native,export=OUT/f'{engine.lower()}-full-export.png')
    job(engine,'adjustments',native,[{'kind':'remove_mask','layer':layer},{'kind':'move','layer':layer,'dx':10,'dy':5},{'kind':'move','layer':layer,'dx':-10,'dy':-5},{'kind':'desaturate','layer':layer},{'kind':'invert','layer':layer},{'kind':'visibility','layer':layer,'visible':False}])
    _,transformed=job(engine,'composition',native,[{'kind':'crop','x':20,'y':20,'width':400,'height':300},{'kind':'rotate'}]);assert (transformed['width'],transformed['height'])==(300,400)
    return native

if __name__=='__main__':
    checks('GIMP');checks('Krita')
    _,m=job('Krita','from-gimp',OUT/'gimp-exchange.ora');assert len(m['layers'])>=3
    _,m=job('GIMP','from-krita',OUT/'krita-exchange.ora');assert len(m['layers'])>=3
    print('Native save/reopen, mask painting, layer order, PNG and layered transfer passed.',flush=True)
