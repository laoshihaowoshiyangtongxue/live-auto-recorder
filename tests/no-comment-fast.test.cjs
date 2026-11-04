const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lr-empty-comments-'));process.chdir(root);process.env.LR_LOG_DIR=path.join(root,'logs');
const {Recorder,createFfmpegRunner}=require('../src/core/recorder');
const {PostProcessor,genAss}=require('../src/core/postprocess');
const split=require('../src/core/upload-split');
async function fixture(name){
 const dir=fs.mkdtempSync(path.join(root,name)),rec=new Recorder(path.join(dir,'recording'));rec.part=1;rec.startedAt=Date.now();rec.partStarts=[0,rec.startedAt];rec.settings={burnDanmaku:true,keepRaw:true};rec.assertSpace=()=>{};
 const ff=createFfmpegRunner(),r=await ff(['-y','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=20','-f','lavfi','-i','sine=frequency=400','-f','lavfi','-i','sine=frequency=700','-t','4','-map','0:v:0','-map','1:a:0','-map','2:a:0','-c:v','libx264','-c:a','aac',rec.mp4Path(1)],30000);assert.equal(r.code,0,r.stderr);return rec;
}
test('a part without comments is copied without re-encoding and preserves both audio streams',async()=>{
 const rec=await fixture('empty-'),dm=rec.base+'.danmaku.jsonl',post=new PostProcessor(path.join(root,'dm.ass'),{});fs.writeFileSync(dm,'');
 let encodes=0,result;const run=rec._runFfmpeg.bind(rec),burn=rec.burnPartDanmaku.bind(rec);rec._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf'))encodes++;return run(args,...rest)};rec.burnPartDanmaku=async(...args)=>result=await burn(...args);
 try{const before=await split.fingerprint(rec,[rec.mp4Path(1)]);await post._process({recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true});assert.equal(result.vcodec,'copy');assert.equal(encodes,0);const out=rec.burnOutPath(1);assert.deepEqual(await split.fingerprint(rec,[out]),before);assert.ok(before['1']&&before['2']);assert.equal(await split.compareTimelines(rec,rec.mp4Path(1),out,{comparePackets:true,maxTimeDelta:0.001}),true);assert.equal((await rec.validateMedia(out)).ok,true);}finally{post.close();}
});
test('actual dialogue cannot be skipped even if the caller marks the part empty',async()=>{
 const rec=await fixture('dialogue-'),ass='dialogue.ass';fs.writeFileSync(ass,genAss([{vt:0,text:'测试弹幕'}]));let encodes=0;const run=rec._runFfmpeg.bind(rec);rec._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf'))encodes++;return run(args,...rest)};
 const result=await rec.burnPartDanmaku(1,ass,{noComments:true});assert.equal(result.ok,true,result.stderr);assert.notEqual(result.vcodec,'copy');assert.ok(encodes>0);
});
test('variable-frame-rate input retains its exact packets and timing',async()=>{
 const rec=await fixture('vfr-'),run=createFfmpegRunner(),base=rec.mp4Path(1),temp=base+'.vfr.mp4';
 const made=await run(['-y','-v','error','-i',base,'-vf',"select='not(eq(mod(n,5),0))'",'-fps_mode','vfr','-c:v','libx264','-c:a','copy',temp],30000);assert.equal(made.code,0,made.stderr);fs.renameSync(temp,base);
 const ass='vfr-empty.ass';fs.writeFileSync(ass,genAss([]));const result=await rec.burnPartDanmaku(1,ass,{noComments:true});assert.equal(result.ok,true,result.stderr);assert.equal(result.vcodec,'copy');assert.equal(await split.compareTimelines(rec,base,rec.burnOutPath(1),{comparePackets:true,maxTimeDelta:0.001}),true);
});
test('a rejected copy falls back to the original encoding and preserves the source',async()=>{
 const rec=await fixture('fallback-'),ass='empty.ass';fs.writeFileSync(ass,genAss([]));const original=split.compareTimelines;let checks=0,encodes=0;const run=rec._runFfmpeg.bind(rec);rec._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf'))encodes++;return run(args,...rest)};split.compareTimelines=async()=>{checks++;throw Error('simulated mismatch');};
 try{const result=await rec.burnPartDanmaku(1,ass,{noComments:true});assert.equal(result.ok,true,result.stderr);assert.ok(checks>0);assert.ok(encodes>0);assert.ok(fs.existsSync(rec.mp4Path(1)));assert.equal((await rec.validateMedia(rec.burnOutPath(1))).ok,true);}finally{split.compareTimelines=original;}
});
