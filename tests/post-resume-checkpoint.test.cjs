const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-checkpoint-'));process.chdir(dir);process.env.LR_LOG_DIR=path.join(dir,'logs');
const {Recorder,createFfmpegRunner}=require('../src/core/recorder'),{PostProcessor,genAss}=require('../src/core/postprocess'),{JobStore,restoreRecorder}=require('../src/core/job-store');
async function fixture(name){const d=fs.mkdtempSync(path.join(dir,name)),rec=new Recorder(path.join(d,'recording')),store=new JobStore(path.join(d,'jobs.json'));rec.part=1;rec.partStarts=[0,Date.now()];rec.startedAt=rec.partStarts[1];rec.settings={burnDanmaku:true,keepRaw:true};rec.assertSpace=()=>{};store.set(rec,{status:'processing',phase:'post'});rec.onCheckpoint=()=>{store.set(rec);return !store.error;};const ff=createFfmpegRunner(),made=await ff(['-y','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=12','-t','3','-c:v','libx264',rec.mp4Path(1)],30000);assert.equal(made.code,0,made.stderr);const ass=path.basename(d)+'.ass';fs.writeFileSync(ass,genAss([{vt:0,text:'测试'}]));return {rec,store,ass};}
test('real burn succeeds while a second reader repeatedly reads the source',async()=>{const {rec,ass}=await fixture('read-'),run=rec._runFfmpeg.bind(rec);let reads=0;rec._runFfmpeg=async(args,...rest)=>{if(!args.includes('-vf'))return run(args,...rest);const timer=setInterval(()=>{fs.readFileSync(rec.mp4Path(1));reads++;},5);try{return await run(args,...rest);}finally{clearInterval(timer);}};const result=await rec.burnPartDanmaku(1,ass);assert.equal(result.ok,true,result.stderr);assert.ok(reads>0);assert.equal((await rec.validateMedia(rec.burnOutPath(1))).ok,true);});
test('a verified burn survives restart without a second decode, but changes invalidate the proof',async()=>{
 const {rec,store}=await fixture('burn-proof-'),dm=rec.base+'.danmaku.jsonl';fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'测试'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};
 try{
  await post._process(job);assert.ok(store.get(rec.jobId).recorder.burnProofs?.[1]);
  const retry=restoreRecorder(new JobStore(store.file).get(rec.jobId),Recorder);retry.assertSpace=()=>{};let validates=0;const validate=retry.validateMedia.bind(retry);retry.validateMedia=async(...args)=>{validates++;return validate(...args);};
  await post._process({...job,recorder:retry});assert.equal(validates,0);
  fs.appendFileSync(retry.burnOutPath(1),'changed');await post._process({...job,recorder:retry});assert.ok(validates>0);
 }finally{post.close();}
});
test('after real encoding succeeds, a validation error resumes without encoding again, including after reload',async()=>{const {rec,store,ass}=await fixture('resume-');let attempts=0;const run=rec._runFfmpeg.bind(rec);rec._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf'))attempts++;return run(args,...rest)};rec.validateMedia=async()=>{throw Error('模拟检查中断')};await assert.rejects(rec.burnPartDanmaku(1,ass),/模拟检查中断/);const saved=store.get(rec.jobId);assert.ok(saved.recorder.burnCheckpoint);assert.ok(fs.existsSync(rec.burnOutPath(1)+'.pending.mp4'));const reloaded=new JobStore(store.file),retry=restoreRecorder(reloaded.get(rec.jobId),Recorder);retry.assertSpace=()=>{};retry.onCheckpoint=()=>{reloaded.set(retry);return !reloaded.error;};const run2=retry._runFfmpeg.bind(retry);let secondEncoding=0;retry._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf'))secondEncoding++;return run2(args,...rest)};const result=await retry.burnPartDanmaku(1,ass);assert.equal(result.ok,true);assert.equal(result.resumed,true);assert.equal(secondEncoding,0);assert.ok(attempts>0);assert.equal((await retry.validateMedia(retry.burnOutPath(1))).ok,true);assert.equal(reloaded.get(rec.jobId).recorder.burnCheckpoint,null);});
test('changed subtitle invalidates the checkpoint and re-encodes rather than reusing stale output',async()=>{const {rec,store,ass}=await fixture('changed-');rec.validateMedia=async()=>{throw Error('validation stopped')};await assert.rejects(rec.burnPartDanmaku(1,ass),/validation stopped/);fs.writeFileSync(ass,genAss([{vt:0,text:'修改后的弹幕'}]));const retry=restoreRecorder(new JobStore(store.file).get(rec.jobId),Recorder);retry.assertSpace=()=>{};let encodes=0;const run=retry._runFfmpeg.bind(retry);retry._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf'))encodes++;return run(args,...rest)};const result=await retry.burnPartDanmaku(1,ass);assert.equal(result.ok,true);assert.ok(encodes>0);assert.ok(fs.readdirSync(path.dirname(rec.base)).some(x=>x.includes('.interrupted-')));});
test('retry skips a verified completed part and retries only the failed part',async()=>{const d=fs.mkdtempSync(path.join(dir,'parts-')),rec=new Recorder(path.join(d,'clip'));rec.part=2;rec.partStarts=[0,1000,2000];rec.startedAt=1000;rec.assertSpace=()=>{};for(let n=1;n<=2;n++)fs.writeFileSync(rec.mp4Path(n),'raw'+n);rec.validateMedia=async()=>({ok:true});rec._probeDuration=async()=>10;const calls=[];let fail=true;rec.burnPartDanmaku=async n=>{calls.push(n);if(n===2&&fail)return {ok:false,stderr:'测试失败'};fs.writeFileSync(rec.burnOutPath(n),'finished'+n);return {ok:true};};const dm=rec.base+'.jsonl';fs.writeFileSync(dm,JSON.stringify({t:1100,text:'用户：测试'}));const post=new PostProcessor(path.join(d,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,nickname:'test',settings:{burnDanmaku:true,keepRaw:true},mergeComplete:true};try{await assert.rejects(post._process(job),/分片2烧录失败/);fail=false;await post._process(job);assert.deepEqual(calls,[1,2,2]);}finally{post.close();}});

test('an incomplete encode cannot be mistaken for a resumable finished output',async()=>{const {rec,store,ass}=await fixture('partial-');const run=rec._runFfmpeg.bind(rec);rec._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf')){fs.writeFileSync(rec.burnOutPath(1)+'.pending.mp4','partial');return {code:1,stderr:'编码中断'};}return run(args,...rest)};const first=await rec.burnPartDanmaku(1,ass);assert.equal(first.ok,false);assert.ok(!store.get(rec.jobId).recorder.burnCheckpoint);const retry=restoreRecorder(new JobStore(store.file).get(rec.jobId),Recorder);retry.assertSpace=()=>{};let count=0;const run2=retry._runFfmpeg.bind(retry);retry._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf'))count++;return run2(args,...rest)};const result=await retry.burnPartDanmaku(1,ass);assert.equal(result.ok,true);assert.ok(count>0);assert.equal(result.resumed,undefined);});

test('temporary metadata changes during validation preserve the finished encode for retry',async()=>{
 const {rec,store,ass}=await fixture('metadata-wait-'),pending=rec.burnOutPath(1)+'.pending.mp4',stat=fs.statSync,run=rec._runFfmpeg.bind(rec);let changed=false,encodes=0;
 fs.statSync=function(file,options){const s=stat.apply(this,arguments);if(file===pending&&options?.bigint&&changed){const copy=Object.create(s);Object.defineProperty(copy,'ctimeNs',{value:s.ctimeNs+1n});return copy;}return s;};
 rec._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf')&&!args.includes('null'))encodes++;const result=await run(args,...rest);if(args.includes('null'))changed=true;return result;};
 try{
  await assert.rejects(rec.burnPartDanmaku(1,ass),e=>e.code==='LR_SOURCE_BUSY');
  assert.ok(fs.existsSync(pending));assert.ok(store.get(rec.jobId).recorder.burnCheckpoint);assert.ok(encodes>0);
  const reloaded=new JobStore(store.file),retry=restoreRecorder(reloaded.get(rec.jobId),Recorder);retry.assertSpace=()=>{};retry.onCheckpoint=()=>{reloaded.set(retry);return !reloaded.error;};
  let retriedEncoding=0;const run2=retry._runFfmpeg.bind(retry);retry._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf')&&!args.includes('null'))retriedEncoding++;return run2(args,...rest);};
  const result=await retry.burnPartDanmaku(1,ass);assert.equal(result.ok,true);assert.equal(result.resumed,true);assert.equal(retriedEncoding,0);
 }finally{fs.statSync=stat;}
});

test('a validation timeout keeps the completed encode and retries validation only',async()=>{
 const {rec,store,ass}=await fixture('timeout-wait-');let checks=0;const validate=rec.validateMedia.bind(rec);
 rec.validateMedia=async(file,...args)=>{if(++checks===1)return {ok:false,retryable:true,stderr:'媒体处理超时'};return validate(file,...args);};
 await assert.rejects(rec.burnPartDanmaku(1,ass),e=>e.code==='LR_SOURCE_BUSY');
 assert.ok(store.get(rec.jobId).recorder.burnCheckpoint);assert.ok(fs.existsSync(rec.burnOutPath(1)+'.pending.mp4'));
 let encodes=0;const run=rec._runFfmpeg.bind(rec);rec._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf')&&!args.includes('null'))encodes++;return run(args,...rest);};
 const result=await rec.burnPartDanmaku(1,ass);assert.equal(result.resumed,true);assert.equal(encodes,0);
});

test('changed comments or timeline never reuse a previously verified burn',async()=>{
 const {rec,ass}=await fixture('changed-proof-'),dm=rec.base+'.danmaku.jsonl';fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'原有弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};
 try{
  await post._process(job);assert.ok(rec.burnProofs?.[1]);let burns=0;const burn=rec.burnPartDanmaku.bind(rec);rec.burnPartDanmaku=async(...args)=>{burns++;return burn(...args);};
  const old=new Date(Date.now()-10000);fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'更改弹幕'})+'\n');fs.utimesSync(dm,old,old);
  await post._process(job);assert.equal(burns,1,'a different comment hash invalidates the old output even if its mtime is older');
  rec.partStarts[1]-=100;await post._process(job);assert.equal(burns,2,'timeline changes also require new output');
 }finally{post.close();}
});

test('changed raw video does not reuse an older verified burn',async()=>{
 const {rec}=await fixture('changed-input-'),dm=rec.base+'.danmaku.jsonl';fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};
 try{
  await post._process(job);let burns=0;const burn=rec.burnPartDanmaku.bind(rec);rec.burnPartDanmaku=async(...args)=>{burns++;return burn(...args);};
  const run=createFfmpegRunner(),other=rec.mp4Path(1)+'.new.mp4';const made=await run(['-y','-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=12','-t','3','-c:v','libx264',other],30000);assert.equal(made.code,0,made.stderr);
  fs.renameSync(other,rec.mp4Path(1));await post._process(job);assert.equal(burns,1);
 }finally{post.close();}
});

test('missing comments never cause a verified existing burn to be overwritten',async()=>{
 const {rec}=await fixture('missing-comment-proof-'),dm=rec.base+'.danmaku.jsonl';fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};
 try{
  await post._process(job);const before=fs.readFileSync(rec.burnOutPath(1));fs.unlinkSync(dm);rec.partStarts[1]-=100;
  await assert.rejects(post._process(job),/弹幕数据缺失/);assert.deepEqual(fs.readFileSync(rec.burnOutPath(1)),before);
 }finally{post.close();}
});

test('an unchanged comment file can be touched without repeating completed processing',async()=>{
 const {rec}=await fixture('touch-comment-'),dm=rec.base+'.danmaku.jsonl';fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};
 try{
  await post._process(job);const validate=rec.validateMedia.bind(rec),burn=rec.burnPartDanmaku.bind(rec);let checks=0,burns=0;
  rec.validateMedia=async(...args)=>{checks++;return validate(...args);};rec.burnPartDanmaku=async(...args)=>{burns++;return burn(...args);};
  const later=new Date(Date.now()+5000);fs.utimesSync(dm,later,later);await post._process(job);
  assert.equal(checks,0);assert.equal(burns,0);
 }finally{post.close();}
});

test('metadata-only changes to a completed burn are decoded once and proof is refreshed',async()=>{
 const {rec}=await fixture('refresh-proof-'),dm=rec.base+'.danmaku.jsonl',out=rec.burnOutPath(1),stat=fs.statSync;fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};let changed=false;
 try{
  await post._process(job);let checks=0,burns=0;const validate=rec.validateMedia.bind(rec),burn=rec.burnPartDanmaku.bind(rec);
  rec.validateMedia=async(...args)=>{checks++;return validate(...args);};rec.burnPartDanmaku=async(...args)=>{burns++;return burn(...args);};
  fs.statSync=function(file,options){const s=stat.apply(this,arguments);if(file===out&&options?.bigint&&changed){const copy=Object.create(s);Object.defineProperty(copy,'ctimeNs',{value:s.ctimeNs+1n});return copy;}return s;};
  changed=true;await post._process(job);await post._process(job);assert.equal(checks,1);assert.equal(burns,0);
 }finally{fs.statSync=stat;post.close();}
});

test('comments changing while read defer the job instead of burning an inconsistent snapshot',async()=>{
 const {rec}=await fixture('reading-comments-'),dm=rec.base+'.danmaku.jsonl',stat=fs.statSync;fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};let reads=0;
 fs.statSync=function(file,options){const s=stat.apply(this,arguments);if(file===dm&&options?.bigint&&++reads>1){const copy=Object.create(s);Object.defineProperty(copy,'ctimeNs',{value:s.ctimeNs+1n});return copy;}return s;};
 try{await assert.rejects(post._process(job),e=>e.code==='LR_SOURCE_BUSY');assert.equal(fs.existsSync(rec.burnOutPath(1)),false);}
 finally{fs.statSync=stat;post.close();}
});

test('media identity and timeout errors are distinguished from damaged video',async()=>{
 const {rec}=await fixture('validation-errors-'),file=rec.mp4Path(1),stat=fs.statSync;let calls=0;
 rec._probeDuration=async()=>3;rec._runFfmpeg=async()=>{calls++;return {code:-1,stderr:'超时',timedOut:true};};
 const timeout=await rec.validateMedia(file);assert.equal(timeout.ok,false);assert.equal(timeout.retryable,true);assert.equal(calls,1);
 fs.statSync=function(name,options){if(name===file&&options?.bigint)throw Object.assign(Error('access'),{code:'EACCES'});return stat.apply(this,arguments);};
 try{const unavailable=await rec.validateMedia(file);assert.equal(unavailable.ok,false);assert.equal(unavailable.retryable,true);assert.equal(calls,1);}
 finally{fs.statSync=stat;}
});

test('comments changed during encoding leave a durable dirty marker and are reprocessed after restart',async()=>{
 const {rec,store}=await fixture('changed-during-encode-'),dm=rec.base+'.danmaku.jsonl';fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'旧弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};
 try{
  const burn=rec.burnPartDanmaku.bind(rec);rec.burnPartDanmaku=async(...args)=>{const result=await burn(...args);fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'新弹幕'})+'\n');return result;};
  await assert.rejects(post._process(job),e=>e.code==='LR_SOURCE_BUSY');
  assert.equal(store.get(rec.jobId).recorder.burnDirtyParts[1],true);assert.ok(fs.existsSync(rec.burnOutPath(1)));assert.ok(fs.existsSync(rec.mp4Path(1)));
  const reloaded=new JobStore(store.file),retry=restoreRecorder(reloaded.get(rec.jobId),Recorder);retry.assertSpace=()=>{};retry.onCheckpoint=()=>{reloaded.set(retry);return !reloaded.error;};
  let reburns=0;const next=retry.burnPartDanmaku.bind(retry);retry.burnPartDanmaku=async(...args)=>{reburns++;return next(...args);};
  await post._process({...job,recorder:retry});assert.equal(reburns,1);assert.equal(reloaded.get(rec.jobId).recorder.burnDirtyParts[1],undefined);assert.ok(retry.burnProofs[1]);
 }finally{post.close();}
});

test('a crash after publishing the burn cannot reuse an unverified output on restart',async()=>{
 const {rec,store}=await fixture('interrupt-after-publish-'),dm=rec.base+'.danmaku.jsonl';fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};
 try{
  const burn=rec.burnPartDanmaku.bind(rec);rec.burnPartDanmaku=async(...args)=>{await burn(...args);throw Error('模拟发布后中断');};
  await assert.rejects(post._process(job),/发布后中断/);assert.equal(store.get(rec.jobId).recorder.burnDirtyParts[1],true);
  const retry=restoreRecorder(new JobStore(store.file).get(rec.jobId),Recorder);retry.assertSpace=()=>{};let burns=0;const next=retry.burnPartDanmaku.bind(retry);retry.burnPartDanmaku=async(...args)=>{burns++;return next(...args);};
  await post._process({...job,recorder:retry});assert.equal(burns,1);assert.equal(retry.burnDirtyParts[1],undefined);
 }finally{post.close();}
});

test('a crash immediately after the pending file is published resumes without re-encoding',async()=>{
 const {rec,store,ass}=await fixture('recover-published-'),publish=rec._publish.bind(rec);
 rec._publish=(...args)=>{publish(...args);throw Error('模拟文件发布后中断');};
 await assert.rejects(rec.burnPartDanmaku(1,ass),/文件发布后中断/);assert.ok(fs.existsSync(rec.burnOutPath(1)));assert.ok(store.get(rec.jobId).recorder.burnCheckpoint);
 const reloaded=new JobStore(store.file),retry=restoreRecorder(reloaded.get(rec.jobId),Recorder);retry.assertSpace=()=>{};retry.onCheckpoint=()=>{reloaded.set(retry);return !reloaded.error;};
 let encodes=0;const run=retry._runFfmpeg.bind(retry);retry._runFfmpeg=async(args,...rest)=>{if(args.includes('-vf')&&!args.includes('null'))encodes++;return run(args,...rest);};
 const result=await retry.burnPartDanmaku(1,ass);assert.equal(result.ok,true);assert.equal(result.resumed,true);assert.equal(encodes,0);assert.equal(reloaded.get(rec.jobId).recorder.burnCheckpoint,null);
});

test('when pure video is not kept, save verified burn state before removing the source',async()=>{
 const {rec,store}=await fixture('save-before-delete-'),dm=rec.base+'.danmaku.jsonl';rec.settings.keepRaw=false;fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};let failed=false;
 rec.onCheckpoint=()=>{if(rec.burnProofs?.[1]&&!rec.burnDirtyParts?.[1]&&!failed){failed=true;return false;}store.set(rec);return !store.error;};
 try{
  await assert.rejects(post._process(job),e=>e.code==='LR_SOURCE_BUSY');assert.equal(failed,true);assert.ok(fs.existsSync(rec.mp4Path(1)));assert.ok(fs.existsSync(rec.burnOutPath(1)));assert.equal(rec.burnDirtyParts[1],true);
 }finally{post.close();}
});

test('an intentionally removed pure video does not force reburning a verified output',async()=>{
 const {rec}=await fixture('no-raw-retry-'),dm=rec.base+'.danmaku.jsonl';rec.settings.keepRaw=false;fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};
 try{
  await post._process(job);assert.equal(fs.existsSync(rec.mp4Path(1)),false);let burns=0;const burn=rec.burnPartDanmaku.bind(rec);rec.burnPartDanmaku=async(...args)=>{burns++;return burn(...args);};
  await post._process(job);assert.equal(burns,0);assert.equal(rec.issues.length,0);
 }finally{post.close();}
});

test('an unavailable duration never triggers a new encode or discards a completed burn',async()=>{
 const {rec,ass}=await fixture('duration-wait-'),dm=rec.base+'.danmaku.jsonl';fs.writeFileSync(dm,JSON.stringify({t:rec.startedAt+100,text:'弹幕'})+'\n');
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),job={recorder:rec,danmakuFile:dm,settings:rec.settings,mergeComplete:true};
 try{
  const probe=rec._probeDuration.bind(rec);rec._probeDuration=async()=>0;let runs=0;const run=rec._runFfmpeg.bind(rec);rec._runFfmpeg=async(...args)=>{runs++;return run(...args);};
  await assert.rejects(rec.burnPartDanmaku(1,ass),e=>e.code==='LR_SOURCE_BUSY');assert.equal(runs,0);
  rec._probeDuration=probe;await post._process(job);const before=fs.readFileSync(rec.burnOutPath(1));rec._probeDuration=async()=>0;
  await assert.rejects(post._process(job),e=>e.code==='LR_SOURCE_BUSY');assert.deepEqual(fs.readFileSync(rec.burnOutPath(1)),before);
 }finally{post.close();}
});
