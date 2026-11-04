const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Recorder}=require('../src/core/recorder'),{JobStore,restoreRecorder}=require('../src/core/job-store');
const {protectPart,restoreParts,cleanupParts,backupComments,findCommentBackup}=require('../src/core/capture-protection');
const {PostProcessor}=require('../src/core/postprocess');
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-protected-')),rec=new Recorder(path.join(dir,'capture'));rec.part=1;rec.partStarts=[0,Date.now()];rec.startedAt=rec.partStarts[1];return {dir,rec};}
test('closed recording is protected through restart and restored if its path disappears',()=>{
 const {dir,rec}=fixture();try{const source=rec.flvPath(1),bytes=Buffer.from('original recording');fs.writeFileSync(source,bytes);protectPart(rec,1);const store=new JobStore(path.join(dir,'jobs.json'));store.set(rec,{status:'waiting'});fs.unlinkSync(source);const restored=restoreRecorder(store.get(rec.jobId),Recorder);restoreParts(restored);assert.deepEqual(fs.readFileSync(source),bytes);assert.ok(restored.notices.some(x=>x.includes('保护文件恢复')));cleanupParts(restored);assert.deepEqual(fs.readFileSync(source),bytes);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('changed protected recording is never silently restored',()=>{
 const {dir,rec}=fixture();try{const source=rec.flvPath(1);fs.writeFileSync(source,'original');protectPart(rec,1);fs.appendFileSync(source,'changed');fs.unlinkSync(source);assert.throws(()=>restoreParts(rec),/已变化/);assert.equal(fs.existsSync(source),false);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('an old first segment is never restored as a complete multi-part merge',()=>{
 const {dir,rec}=fixture();try{const source=rec.flvPath(1);fs.writeFileSync(source,'first segment');protectPart(rec,1);fs.unlinkSync(source);rec.mergedFromParts=2;restoreParts(rec);assert.equal(fs.existsSync(source),false);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('saved comments can be recovered and a changed backup is rejected',async()=>{
 const {dir,rec}=fixture();try{const source=rec.base+'.danmaku.jsonl',data='{"t":1000,"text":"测试"}\n';fs.writeFileSync(source,data);assert.equal(await backupComments(rec.base),true);fs.unlinkSync(source);const backup=await findCommentBackup(rec.base);assert.equal(fs.readFileSync(backup,'utf8'),data);fs.appendFileSync(backup,'broken');assert.equal(await findCommentBackup(rec.base),null);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('post-processing uses verified comment backup after the original disappears',async()=>{
 const {dir,rec}=fixture(),post=new PostProcessor(path.join(dir,'dm.ass'),{});try{
  const dm=rec.base+'.danmaku.jsonl';fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'甲：备份弹幕'})+'\n');await backupComments(rec.base);fs.unlinkSync(dm);fs.writeFileSync(rec.mp4Path(1),'source');rec.assertSpace=()=>{};
  let subtitle='';rec.validateMedia=async()=>({ok:true});rec.burnPartDanmaku=async(_part,ass)=>{subtitle=fs.readFileSync(path.join(dir,ass),'utf8');fs.writeFileSync(rec.burnOutPath(1),'output');return {ok:true};};
  await post._process({recorder:rec,danmakuFile:dm,nickname:'测试',settings:{burnDanmaku:true,keepRaw:true},mergeComplete:true});assert.match(subtitle,/备份弹幕/);assert.ok(rec.notices.some(x=>x.includes('弹幕备份')));assert.equal(rec.issues.length,0);
 }finally{post.close();fs.rmSync(dir,{recursive:true,force:true});}
});
