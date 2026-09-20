"""Real darktable color/RAW/export checks; creates only synthetic test artifacts."""
from pathlib import Path
import hashlib, os, struct, subprocess
from PIL import Image, ImageStat, TiffImagePlugin
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts/darktable-check';OUT.mkdir(parents=True,exist_ok=True)
CLI=os.environ.get('REALITY_WORKSHOP_DARKTABLE_CLI',str(Path.home()/'Library/Application Support/studio.realityworkshop.desktop/engines/darktable/bin/darktable-cli'))

def recipe(path,exposure=0,saturation=0):
    params=struct.pack('<5fi5f',0,exposure,0,0,0,1,18.42,0,saturation,0,0).hex()
    path.write_text(f'''<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:darktable="http://darktable.sf.net/" darktable:xmp_version="4" darktable:auto_presets_applied="0" darktable:history_end="1" darktable:iop_order_version="2"><darktable:history><rdf:Seq><rdf:li darktable:num="0" darktable:operation="basicadj" darktable:enabled="1" darktable:modversion="2" darktable:params="{params}" darktable:multi_name="Workshop" darktable:multi_priority="0" darktable:blendop_version="13"/></rdf:Seq></darktable:history></rdf:Description></rdf:RDF></x:xmpmeta>''')

def run(name,source,exposure=0,saturation=0):
    folder=OUT/name;folder.mkdir(exist_ok=True);xmp=folder/'recipe.xmp';recipe(xmp,exposure,saturation)
    output=folder/'result.png';output.unlink(missing_ok=True)
    original=hashlib.sha256(source.read_bytes()).digest()
    result=subprocess.run([CLI,str(source),str(xmp),str(output),'--apply-custom-presets','false','--core','--configdir',str(folder/'config'),'--cachedir',str(folder/'cache'),'--conf','write_sidecar_files=never','--conf','plugins/imageio/format/png/bpp=8'],capture_output=True,timeout=180)
    (folder/'engine.log').write_bytes(result.stdout+result.stderr)
    assert result.returncode==0 and output.exists(),(result.stdout+result.stderr).decode(errors='replace')[-1500:]
    assert hashlib.sha256(source.read_bytes()).digest()==original
    im=Image.open(output).convert('RGB');print(name,'PASS',im.size,flush=True);return im

if __name__=='__main__':
    w,h=160,120
    rgb=Image.new('RGB',(w,h));rgb.putdata([(30+x,25+y,40+(x+y)//3) for y in range(h) for x in range(w)]);source=OUT/'synthetic-source.png';rgb.save(source)
    baseline=run('neutral',source);brighter=run('exposure',source,1);gray=run('desaturated',source,saturation=-1)
    assert sum(ImageStat.Stat(brighter).mean)>sum(ImageStat.Stat(baseline).mean)
    assert max(max(p)-min(p) for p in gray.getdata())<=3
    assert baseline.size==(w,h)
    tags=TiffImagePlugin.ImageFileDirectory_v2()
    def tag(n,t,value):tags.tagtype[n]=t;tags[n]=value
    tag(262,3,32803);tag(277,3,1);tag(33421,3,(2,2));tag(33422,1,bytes([0,1,1,2]));tag(50706,1,bytes([1,4,0,0]));tag(50707,1,bytes([1,1,0,0]));tag(50708,2,'Workshop synthetic CFA');tag(50710,1,bytes([0,1,2]));tag(50711,3,1);tag(50713,3,(1,1));tag(50714,5,TiffImagePlugin.IFDRational(64,1));tag(50717,4,4095)
    tag(50721,10,tuple(TiffImagePlugin.IFDRational(1 if i in (0,4,8) else 0,1) for i in range(9)));tag(50728,5,tuple(TiffImagePlugin.IFDRational(1,1) for _ in range(3)));tag(50778,3,21)
    raw=Image.frombytes('I;16',(w,h),b''.join(struct.pack('<H',500+x*9+y*4) for y in range(h) for x in range(w)))
    dng=OUT/'synthetic-camera.dng';raw.save(dng,format='TIFF',tiffinfo=tags)
    image=run('raw-dng',dng);assert min(image.size)>0
    print('Native color recipes, full dimensions, unchanged sources, and synthetic DNG decoding PASS',flush=True)
