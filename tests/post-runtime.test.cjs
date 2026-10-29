const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lr-runtime-'));process.env.LR_LOG_DIR=path.join(root,'logs');
const {Recorder}=require('../src/core/recorder'),{MediaPool}=require('../src/core/media-pool'),{PostProcessor}=require('../src/core/postprocess');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,timeout=15000){const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw Error('condition timed out');await sleep(20);}}
function recoveryFixture(name){
 const {RecoveryController}=require('../src/core/recovery');const directory=fs.mkdtempSync(path.join(root,name));
 const post=new PostProcessor(path.join(directory,'dm.ass'),{}),s={cfg:{settings:{}},tasks:new Map(),post,outDir:directory,history:[],historyFile:path.join(directory,'history.json'),freeBytes:()=>1024**4};
 s.recovery=new RecoveryController(s,path.join(directory,'jobs.json'));return {s,directory,close(){s.recovery.close();s.recovery.mediaPool.close();post.close();}};
}
test('real FFmpeg pause preserves its PID and output, frees the shared budget, and excludes paused time from timeout',async()=>{
 const pool=new MediaPool(()=>1),rec=new Recorder(path.join(root,'native'));rec.mediaPool=pool;let latest;
 rec.onProgress=p=>latest=p;
 const file=rec.base+'.mp4';const run=rec._runFfmpeg(['-y','-v','error','-re','-f','lavfi','-i','testsrc2=s=160x90:r=10','-t','4','-c:v','libx264',file],6500,false,4);
 try{
  await until(()=>rec._activeProc&&latest?.processedSec>0);const pid=rec._activeProc.pid;
  rec.pauseProcessing();assert.equal(rec._activeProc.pid,pid);assert.equal(pool.active.size,0);
  const lease=await pool.acquire();assert.equal(pool.active.size,1);lease.release();
  const before=latest?.processedSec;await sleep(3200);assert.equal(latest?.processedSec,before);
  await rec.resumeProcessing();assert.equal(rec._activeProc.pid,pid);
  const result=await run;assert.equal(result.code,0,result.stderr);assert.equal(result.timedOut,false);
  assert.equal((await rec.validateMedia(file)).ok,true);assert.equal(pool.active.size,0);
 }finally{rec._abortFfmpeg();pool.close();}
});
test('pausing one job starts the next without cancelling the first and resume continues the same work',async()=>{
 const post=new PostProcessor(path.join(root,'queue.ass'),{postConcurrency:1});const started=[];let releaseA;
 const rec=()=>({part:1,issues:[],notices:[],pauseProcessing(){},async resumeProcessing(){}});
 const a={id:'a',recorder:rec()},b={id:'b',recorder:rec()};
 post._process=async job=>{started.push(job.id);if(job===a)await new Promise(r=>releaseA=r);return {};};
 try{post.enqueue(a);post.enqueue(b);await until(()=>started.length===1);
  assert.equal(post.pauseTask(a.postId).ok,true);await until(()=>started.includes('b'));
  assert.equal(post.running.has(a),true);await post.resumeTask(a.postId);releaseA();await until(()=>!post.running.size);
  assert.deepEqual(started,['a','b']);assert.equal(a.view.status,'done');
 }finally{post.close();releaseA?.();}
});
test('pause failures leave a running job active and duplicate submissions never start it twice',async()=>{
 const post=new PostProcessor(path.join(root,'errors.ass'),{});let release,count=0;
 post._process=async()=>{count++;await new Promise(r=>release=r);return {};};
 const job={id:'only',recorder:{part:1,pauseProcessing(){throw Error('native denied');}}};
 try{post.enqueue(job);post.enqueue({...job});assert.equal(count,1);assert.equal(post.pauseTask(job.postId).ok,false);assert.equal(job.paused,undefined);assert.equal(post.busy,true);release();await until(()=>!post.running.size);}finally{post.close();}
});
test('media budget serializes different phases and allows a configured second worker',async()=>{
 let limit=1;const pool=new MediaPool(()=>limit);const first=await pool.acquire();let admitted=false;
 const waiting=pool.acquire().then(lease=>{admitted=true;return lease;});await sleep(20);assert.equal(admitted,false);
 limit=2;pool.drain();const second=await waiting;assert.equal(pool.active.size,2);first.release();second.release();pool.close();
});
test('unchanged full validation is reused, replacements and modified files are validated again',async()=>{
 const rec=new Recorder(path.join(root,'proof')),file=rec.base+'.mp4';fs.writeFileSync(file,'fixture');let calls=0;
 rec._probeDuration=async()=>1;rec._runFfmpeg=async()=>{calls++;return {code:0,stderr:''};};
 assert.equal((await rec.validateMedia(file)).ok,true);assert.equal((await rec.validateMedia(file)).reused,true);assert.equal(calls,1);
 fs.appendFileSync(file,'changed');await rec.validateMedia(file);assert.equal(calls,2);
 const pending=rec.base+'.pending.mp4';fs.renameSync(file,pending);await rec.validateMedia(pending);rec._publish(pending,file);
 assert.equal((await rec.validateMedia(file)).reused,true);
 fs.renameSync(file,file+'.old');fs.copyFileSync(file+'.old',file);assert.equal((await rec.validateMedia(file)).reused,undefined);
 rec._runFfmpeg=async()=>{fs.appendFileSync(file,'during');return {code:0,stderr:''};};
 fs.appendFileSync(file,'before');assert.equal((await rec.validateMedia(file)).ok,false);
});
test('files with an active capture writer never enter remuxing',async()=>{
 const rec=new Recorder(path.join(root,'open'));rec._openParts.add(1);let ran=false;rec._runFfmpeg=async()=>{ran=true;};
 await assert.rejects(rec.remuxAll(),e=>e.code==='LR_SOURCE_BUSY');assert.equal(ran,false);
  await assert.rejects(rec.mergeParts(),e=>e.code==='LR_SOURCE_BUSY');assert.equal(ran,false);
});
test('orphan cleanup stops only a recorded media child with matching owner and input',async()=>{
 const vm=require('node:vm'),module={exports:{}},file=path.resolve(__dirname,'../src/core/orphan-process.js');
 const base=path.join(root,'owner'),exe=path.join(root,'ffmpeg.exe'),killed=[];
 const rows=[{ProcessId:321,ParentProcessId:777,ExecutablePath:exe,CommandLine:'"'+exe+'" -i "'+base+'_part1.mp4" -f null -'},
 {ProcessId:654,ParentProcessId:777,ExecutablePath:exe,CommandLine:'"'+exe+'" -i "'+base+'_part1.mp4" -f null -'}];
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,setTimeout,process:{platform:'win32',pid:999,kill:(pid,signal)=>{if(signal)killed.push(pid);else {const e=Error();e.code='ESRCH';throw e;}}},require:id=>id==='node:child_process'?{execFile:(exe,args,opts,cb)=>cb(null,JSON.stringify(rows))}:id==='./recorder'?{ffmpegPath:exe}:require(id)});
 await module.exports.stopOrphanWriter({base,ownerPid:777,recorder:{processingProcessId:321}});assert.deepEqual(killed,[321]);
});
test('paused jobs survive restart without starting FFmpeg or losing their queue entry',async()=>{
 const {RecoveryController}=require('../src/core/recovery');const directory=fs.mkdtempSync(path.join(root,'restart-'));
 const rec=new Recorder(path.join(directory,'主播_123456_20261027_120000'));rec.part=1;rec.partStarts=[0,Date.now()];rec.settings={burnDanmaku:true,keepRaw:true};
 const make=()=>{const post=new PostProcessor(path.join(directory,'dm.ass'),{});const s={cfg:{settings:{}},tasks:new Map(),post,outDir:directory,history:[],historyFile:path.join(directory,'history.json'),freeBytes:()=>1024**4};s.recovery=new RecoveryController(s,path.join(directory,'jobs.json'));return s;};
 const first=make();first.recovery.store.set(rec,{status:'paused',phase:'post',userPaused:true,nickname:'主播'});first.post.close();first.recovery.mediaPool.close();
 const restored=make();let ran=false;restored.post._process=async()=>{ran=true;return {};};
 try{await restored.recovery.start();assert.equal(restored.post.queue.length,1);assert.equal(restored.post.queue[0].paused,true);assert.equal(ran,false);assert.equal(restored.post.hasRunnable,false);
  await restored.post.resumeTask(restored.post.queue[0].postId);await until(()=>!restored.post.running.size);assert.equal(ran,true);
 }finally{restored.recovery.close();restored.post.close();restored.recovery.mediaPool.close();}
});
test('a failed media spawn releases its budget and the next job proceeds',async()=>{
 const {MediaExecution}=require('../src/core/media-execution'),pool=new MediaPool(()=>1),rec=new Recorder(path.join(root,'spawn-fail'));rec.mediaPool=pool;
 try{const result=await new MediaExecution(rec,['-i','missing'],1000,false,0,path.join(root,'missing.exe')).run();assert.equal(result.code,-1);assert.equal(pool.active.size,0);const lease=await pool.acquire();lease.release();}finally{pool.close();}
});
test('different jobs always have different subtitle paths even after another lane finishes',async()=>{
 const paths=[];const post=new PostProcessor(path.join(root,'dm.ass'),{});
 function job(id){const rec=new Recorder(path.join(root,id));rec.part=1;rec.partStarts=[0,0];rec.startedAt=0;fs.writeFileSync(rec.mp4Path(1),'fixture');const dm=rec.base+'.jsonl';fs.writeFileSync(dm,JSON.stringify({t:1000,text:id}));
  rec._probeDuration=async()=>2;rec.burnPartDanmaku=async(part,ass)=>{paths.push(ass);fs.writeFileSync(rec.burnOutPath(1),'fixture');return {ok:true};};
  return {id,recorder:rec,settings:{burnDanmaku:true,keepRaw:true},danmakuFile:dm,mergeComplete:true};}
 try{await post._process(job('first'));await post._process(job('second'));assert.equal(new Set(paths).size,2);}finally{post.close();}
});
test('caption encoding preserves variable frame intervals without inventing duplicate frames',async()=>{
 const {createFfmpegRunner}=require('../src/core/recorder'),{genAss}=require('../src/core/postprocess');
 const rec=new Recorder(path.join(root,'vfr'));rec.part=1;
 const ff=createFfmpegRunner(),made=await ff(['-y','-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=20','-t','3','-vf','select=not(between(n\\,15\\,30))','-fps_mode','passthrough','-c:v','libx264',rec.mp4Path(1)],15000);
 assert.equal(made.code,0,made.stderr);const before=await rec._scanVideo(rec.mp4Path(1));
 const ass='vfr-test-'+Date.now()+'.ass';fs.writeFileSync(ass,genAss([{vt:0,text:'不补帧'}]));
 try{const result=await rec.burnPartDanmaku(1,ass);assert.equal(result.ok,true,result.stderr);const after=await rec._scanVideo(rec.burnOutPath(1));assert.equal(after.packets.length,before.packets.length);assert.ok(Math.abs(after.duration-before.duration)<.1);}finally{fs.unlinkSync(ass);}
});
test('paused sealing releases its admission slot and another recording proceeds',async()=>{
 const fixture=recoveryFixture('seal-queue-'),r=fixture.s.recovery;let releaseA,startedA=false,startedB=false;
 function rec(name){const rec=new Recorder(path.join(fixture.directory,name));rec.settings={};rec.assertSpace=()=>{};for(const k of ['recoverPublications','recoverMergePlan','reconcileParts'])rec[k]=async()=>{};r.store.set(rec,{status:'sealing',phase:'seal'});r.bind(rec);return rec;}
 const a=rec('a'),b=rec('b');a.remuxAll=async()=>{startedA=true;await new Promise(resolve=>releaseA=resolve);return [];};b.remuxAll=async()=>{startedB=true;return [];};
 a.pauseProcessing=()=>{a._processingPaused=true;};a.resumeProcessing=async()=>{a._processingPaused=false;releaseA();};
 try{
  const p=r.trackSeal(r.seal(a,r.view(a,r.store.get(a.jobId))));await until(()=>startedA);
  const q=r.trackSeal(r.seal(b,r.view(b,r.store.get(b.jobId))));await sleep(20);assert.equal(startedB,false);
  assert.equal(r.pauseTask(a.jobId).ok,true);await until(()=>startedB);await q;
  assert.equal(r.store.get(a.jobId).status,'paused');assert.equal((await r.resumeTask(a.jobId)).ok,true);await p;
  assert.equal(r.executions.size,0);assert.equal(r.sealPool.active.size,0);
 }finally{releaseA?.();fixture.close();}
});
test('shutdown of a genuinely paused sealing process preserves a paused seal journal',async()=>{
 const fixture=recoveryFixture('paused-seal-exit-'),r=fixture.s.recovery,rec=new Recorder(path.join(fixture.directory,'paused'));
 rec.settings={};rec.assertSpace=()=>{};for(const k of ['recoverPublications','recoverMergePlan','reconcileParts'])rec[k]=async()=>{};
 r.store.set(rec,{status:'sealing',phase:'seal'});r.bind(rec);
 rec.remuxAll=async()=>{await rec._runFfmpeg(['-v','error','-re','-f','lavfi','-i','testsrc2=s=160x90:r=10','-t','10','-f','null','-'],15000);return [];};
 try{const work=r.trackSeal(r.seal(rec,r.view(rec,r.store.get(rec.jobId))));await until(()=>rec._activeProc?.pid);assert.equal(r.pauseTask(rec.jobId).ok,true);r.close();await work;
  assert.equal(r.store.get(rec.jobId).status,'paused');assert.equal(r.store.get(rec.jobId).phase,'seal');assert.equal(rec._activeProc,null);
 }finally{rec._abortFfmpeg();fixture.close();}
});
test('a paused sealing journal restores a controllable entry and starts only after resume',async()=>{
 const original=recoveryFixture('restore-seal-'),r=original.s.recovery,rec=new Recorder(path.join(original.directory,'主播_123456_20261027_120000'));
 rec.settings={};r.store.set(rec,{status:'paused',phase:'seal',userPaused:true});
 const {RecoveryController}=require('../src/core/recovery'),post=new PostProcessor(path.join(original.directory,'dm.ass'),{}),s={...original.s,post};
 s.recovery=new RecoveryController(s,r.store.file);let started=false;
 try{await s.recovery.start();const entry=s.recovery.executions.get(rec.jobId);assert.equal(entry.restored,true);assert.equal(entry.view.status,'paused');
  for(const k of ['recoverPublications','recoverMergePlan','reconcileParts'])entry.rec[k]=async()=>{};entry.rec.remuxAll=async()=>{started=true;return [];};
  assert.equal(started,false);assert.equal((await s.recovery.resumeTask(rec.jobId)).ok,true);await s.recovery.sealTail;assert.equal(started,true);assert.equal(s.recovery.executions.size,0);
 }finally{s.recovery.close();s.recovery.mediaPool.close();post.close();original.close();}
});
test('shutdown wins over a resume request waiting for resources',async()=>{
 const {PauseSignal}=require('../src/core/postprocess'),post=new PostProcessor(path.join(root,'resume-race.ass'),{});let releaseWork,releaseResume;
 const rec={part:1,pauseProcessing(){},resumeProcessing:()=>new Promise(r=>releaseResume=r),_abortFfmpeg(){releaseWork?.();}};
 const job={id:'resume-race',recorder:rec};post._process=async()=>{await new Promise(r=>releaseWork=r);if(rec._userAbort)throw new PauseSignal();return {};};
 try{post.enqueue(job);await until(()=>releaseWork);post.pauseTask(job.postId);const pending=post.resumeTask(job.postId);await until(()=>releaseResume);post.prepareShutdown();releaseResume();assert.equal((await pending).ok,false);await until(()=>!post.running.size);assert.equal(job.paused,true);assert.equal(job.view.status,'paused');assert.equal(post.hasRunnable,false);}finally{post.close();releaseWork?.();releaseResume?.();}
});
test('concurrent requests for one unchanged file share one complete decode check',async()=>{
 const rec=new Recorder(path.join(root,'shared-check')),file=rec.base+'.mp4';fs.writeFileSync(file,'fixture');let checks=0;
 rec._probeDuration=async()=>1;rec._runFfmpeg=async()=>{checks++;await sleep(30);return {code:0,stderr:''};};
 const results=await Promise.all([rec.validateMedia(file),rec.validateMedia(file),rec.validateMedia(file)]);
 assert.equal(checks,1);assert.ok(results.every(r=>r.ok));assert.equal(rec._validationInFlight.size,0);
});
test('unchanged duration probes are reused but changed inputs must be probed again',async()=>{
 const rec=new Recorder(path.join(root,'duration-cache')),file=rec.base+'.mp4';fs.writeFileSync(file,'fixture');let checks=0;
 rec._runFfmpeg=async()=>{checks++;return {code:1,stderr:'Duration: 00:01:30.25'};};
 assert.equal(await rec._probeDuration(file),90.25);assert.equal(await rec._probeDuration(file),90.25);assert.equal(checks,1);
 fs.appendFileSync(file,'changed');await rec._probeDuration(file);assert.equal(checks,2);
});
test('canceled jobs remain canceled after restart and retained files are not rediscovered',async()=>{
 const fixture=recoveryFixture('cancel-restart-'),r=fixture.s.recovery;
 const rec=new Recorder(path.join(fixture.directory,'主播_123456_20261027_120000'));rec.part=1;rec.partStarts=[null,Date.now()];rec.settings={burnDanmaku:true,keepRaw:true};
 fs.writeFileSync(rec.mp4Path(1),'retained source');r.store.set(rec,{status:'canceled',phase:'seal',error:'用户取消后处理'});
 const {RecoveryController}=require('../src/core/recovery'),post=new PostProcessor(path.join(fixture.directory,'new.ass'),{}),s={...fixture.s,post};s.recovery=new RecoveryController(s,r.store.file);let started=false;post._process=async()=>{started=true;return {};};
 try{await s.recovery.start();assert.equal(s.recovery.store.get(rec.jobId).status,'canceled');assert.equal(s.recovery.store.jobs.size,1);assert.equal(post.queue.length,0);assert.equal(started,false);assert.equal(fs.readFileSync(rec.mp4Path(1),'utf8'),'retained source');}
 finally{s.recovery.close();s.recovery.mediaPool.close();post.close();fixture.close();}
});
