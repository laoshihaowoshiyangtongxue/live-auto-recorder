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
