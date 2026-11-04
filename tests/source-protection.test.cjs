const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Recorder}=require('../src/core/recorder');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-source-protection-'));
 const rec=new Recorder(path.join(dir,'recording'));rec.assertSpace=()=>{};
 const source=rec.mp4Path(1),out=rec.burnOutPath(1),pending=out+'.pending.mp4';
 fs.writeFileSync(source,Buffer.alloc(2048,1));rec._probeDuration=async()=>10;
 return {dir,rec,source,out,pending};
}
test('source removed during failed encode stops fallback codecs',async()=>{
 const x=fixture();let calls=0;
 x.rec._runFfmpeg=async()=>{calls++;fs.unlinkSync(x.source);return {code:1,stderr:'input missing'};};
 await assert.rejects(x.rec.burnPartDanmaku(1),/原片已移动或改变/);assert.equal(calls,1);
});
test('source removed during validation preserves verified output and refuses to publish it',async()=>{
 const x=fixture();let calls=0;
 x.rec._runFfmpeg=async()=>{calls++;fs.writeFileSync(x.pending,Buffer.alloc(2048,2));return {code:0,stderr:''};};
 x.rec.validateMedia=async()=>{fs.unlinkSync(x.source);return {ok:true};};
 await assert.rejects(x.rec.burnPartDanmaku(1),/已校验的弹幕临时文件保留/);
 assert.equal(calls,1);assert.equal(fs.existsSync(x.out),false);
 const saved=fs.readdirSync(x.dir).filter(f=>f.includes('.verified-recovery-'));assert.equal(saved.length,1);assert.equal(fs.statSync(path.join(x.dir,saved[0])).size,2048);
});
test('preexisting interrupted output is preserved before retry',async()=>{
 const x=fixture();fs.writeFileSync(x.pending,'prior partial');
 x.rec._runFfmpeg=async()=>({code:1,stderr:'failed'});
 await x.rec.burnPartDanmaku(1);
 const saved=fs.readdirSync(x.dir).find(f=>f.includes('.interrupted-'));assert.ok(saved);assert.equal(fs.readFileSync(path.join(x.dir,saved),'utf8'),'prior partial');
});
test('reading the source and changing metadata alone does not interrupt burning',async()=>{
 const x=fixture(),stat=fs.statSync;let metadataChanged=false;
 fs.statSync=function(file,options){const s=stat.apply(this,arguments);if(file===x.source&&options?.bigint&&metadataChanged){const copy=Object.create(s);Object.defineProperty(copy,'ctimeNs',{value:s.ctimeNs+1n});return copy;}return s;};
 try{
  x.rec._runFfmpeg=async()=>{assert.equal(fs.readFileSync(x.source).length,2048);metadataChanged=true;fs.writeFileSync(x.pending,Buffer.alloc(2048,2));return {code:0,stderr:''};};
  x.rec.validateMedia=async()=>({ok:true});
  assert.equal((await x.rec.burnPartDanmaku(1)).ok,true);assert.ok(fs.existsSync(x.out));assert.ok(fs.existsSync(x.source));
 }finally{fs.statSync=stat;}
});
test('changing source bytes during burning still stops publication',async()=>{
 const x=fixture();
 x.rec._runFfmpeg=async()=>{fs.appendFileSync(x.source,'changed');fs.writeFileSync(x.pending,Buffer.alloc(2048,2));return {code:0,stderr:''};};
 await assert.rejects(x.rec.burnPartDanmaku(1),/原片已移动或改变/);assert.equal(fs.existsSync(x.out),false);assert.equal(fs.existsSync(x.source),true);
});
test('source removed during the comment-free copy never publishes output or falls back to encoding',async()=>{
 const x=fixture();const ass=path.join(x.dir,'empty.ass');fs.writeFileSync(ass,'[Events]\n');let calls=0;
 x.rec._runFfmpeg=async()=>{calls++;fs.unlinkSync(x.source);fs.writeFileSync(x.pending,Buffer.alloc(2048,2));return {code:0,stderr:''};};
 await assert.rejects(x.rec.burnPartDanmaku(1,ass,{noComments:true}),/原片已移动或改变/);assert.equal(calls,1);assert.equal(fs.existsSync(x.out),false);
});
