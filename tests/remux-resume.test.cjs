const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lr-remux-resume-'));process.env.LR_LOG_DIR=path.join(root,'logs');
const {Recorder,createFfmpegRunner}=require('../src/core/recorder'),{JobStore,restoreRecorder}=require('../src/core/job-store');
const ff=createFfmpegRunner();
async function make(name,parts=1,format='flv'){
 const dir=fs.mkdtempSync(path.join(root,name+'-')),rec=new Recorder(path.join(dir,'capture')),store=new JobStore(path.join(dir,'jobs.json'));
 rec.part=parts;rec.startedAt=Date.now();rec.partStarts=[0,rec.startedAt,rec.startedAt+4000];rec.settings={keepRaw:true,minFreeGB:0};rec.assertSpace=()=>{};
 for(let i=1;i<=parts;i++){
  const file=format==='flv'?rec.flvPath(i):rec.mp4Path(i),args=['-y','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=15','-f','lavfi','-i',`sine=frequency=${400+i*40}`,'-t','4'];
  if(i===2)args.push('-vf','negate');args.push('-c:v','libx264','-c:a','aac');if(format==='flv')args.push('-f','flv');args.push(file);
  const result=await ff(args,30000);assert.equal(result.code,0,result.stderr);
 }
 store.set(rec,{status:'sealing',phase:'seal'});rec.onCheckpoint=()=>{store.set(rec);return !store.error;};return {dir,rec,store};
}
function reload(store,rec){const fresh=new JobStore(store.file),retry=restoreRecorder(fresh.get(rec.jobId),Recorder);retry.assertSpace=()=>{};retry.onCheckpoint=()=>{fresh.set(retry);return !fresh.error;};return {fresh,retry};}

test('temporary remux validation failure keeps the completed copy and resumes after restart',async()=>{
 const {rec,store}=await make('remux-wait'),pending=rec.mp4Path(1)+'.pending.mp4',validate=rec.validateMedia.bind(rec);let injected=false;
 rec.validateMedia=async(file,...args)=>{if(file===pending&&!injected){injected=true;return {ok:false,retryable:true,stderr:'模拟暂时占用'};}return validate(file,...args);};
 await assert.rejects(rec.remuxAll(),e=>e.code==='LR_SOURCE_BUSY');assert.ok(fs.existsSync(rec.flvPath(1)));assert.ok(fs.existsSync(pending));assert.ok(store.get(rec.jobId).recorder.remuxCheckpoints[1]);
 const {retry,fresh}=reload(store,rec);let copies=0;const run=retry._runFfmpeg.bind(retry);retry._runFfmpeg=async(args,...rest)=>{if(args.at(-1)===pending&&args.includes('copy'))copies++;return run(args,...rest);};
 assert.deepEqual(await retry.remuxAll(),[retry.mp4Path(1)]);assert.equal(copies,0);assert.equal((await retry.validateMedia(retry.mp4Path(1))).ok,true);assert.equal(fs.existsSync(retry.flvPath(1)),false);assert.equal(fresh.get(rec.jobId).recorder.remuxCheckpoints[1],undefined);
});

test('remux output published just before interruption is recovered without copying again',async()=>{
 const {rec,store}=await make('remux-published'),publish=rec._publish.bind(rec);rec._publish=(...args)=>{publish(...args);throw Error('模拟发布后中断');};
 await assert.rejects(rec.remuxAll(),e=>e.code==='LR_SOURCE_BUSY');assert.ok(fs.existsSync(rec.mp4Path(1)));assert.ok(fs.existsSync(rec.flvPath(1)));assert.ok(store.get(rec.jobId).recorder.remuxCheckpoints[1]);
 const {retry}=reload(store,rec);retry.issues=[];let copies=0;const run=retry._runFfmpeg.bind(retry);retry._runFfmpeg=async(args,...rest)=>{if(args.at(-1)===retry.mp4Path(1)+'.pending.mp4'&&args.includes('copy'))copies++;return run(args,...rest);};
 assert.deepEqual(await retry.remuxAll(),[retry.mp4Path(1)]);assert.equal(copies,0);assert.equal((await retry.validateMedia(retry.mp4Path(1))).ok,true);
});

test('a changed remux source invalidates the saved output while retaining both files',async()=>{
 const {rec,store}=await make('remux-source'),source=rec.flvPath(1),pending=rec.mp4Path(1)+'.pending.mp4',original=fs.readFileSync(source),validate=rec.validateMedia.bind(rec);
 rec.validateMedia=async(file,...args)=>{if(file===pending){fs.appendFileSync(source,'changed');return {ok:false,retryable:true,stderr:'模拟源文件变化'};}return validate(file,...args);};
 await assert.rejects(rec.remuxAll(),e=>e.code==='LR_SOURCE_BUSY');assert.ok(fs.existsSync(source));assert.ok(fs.existsSync(pending));
 fs.writeFileSync(source,original);const {retry}=reload(store,rec);assert.deepEqual(await retry.remuxAll(),[retry.mp4Path(1)]);
 assert.ok(fs.readdirSync(path.dirname(source)).some(name=>name.includes('.pending.mp4.interrupted-')));
});

test('a missing source with an unrelated valid MP4 is not reported as complete',async()=>{
 const {rec}=await make('remux-missing-source'),pending=rec.mp4Path(1)+'.pending.mp4',validate=rec.validateMedia.bind(rec);
 rec.validateMedia=async(file,...args)=>file===pending?{ok:false,retryable:true,stderr:'模拟暂时占用'}:validate(file,...args);
 await assert.rejects(rec.remuxAll(),e=>e.code==='LR_SOURCE_BUSY');fs.copyFileSync(pending,rec.mp4Path(1));fs.unlinkSync(rec.flvPath(1));
 assert.deepEqual(await rec.remuxAll(),[]);assert.ok(rec.issues.some(issue=>issue.includes('与转封装记录不符')));assert.ok(fs.existsSync(pending));assert.ok(fs.existsSync(rec.mp4Path(1)));
});

test('temporary merge validation failure resumes the verified output without remerging',async()=>{
 const {rec,store}=await make('merge-wait',2,'mp4'),pending=rec.mp4Path(1)+'.pending.mp4',validate=rec.validateMedia.bind(rec);let injected=false;
 rec.validateMedia=async(file,...args)=>{if(file===pending&&!injected){injected=true;return {ok:false,retryable:true,stderr:'模拟暂时占用'};}return validate(file,...args);};
 await assert.rejects(rec.consolidateMp4s(),e=>e.code==='LR_SOURCE_BUSY');assert.ok(fs.existsSync(pending));assert.ok(store.get(rec.jobId).recorder.mergePlan);assert.ok(fs.existsSync(rec.mp4Path(2)));
 const {retry}=reload(store,rec);let merges=0;const run=retry._runFfmpeg.bind(retry);retry._runFfmpeg=async(args,...rest)=>{if(args.includes('concat'))merges++;return run(args,...rest);};
 await retry.recoverMergePlan();assert.equal(merges,0);assert.equal(retry.part,1);assert.equal((await retry.validateMedia(retry.mp4Path(1))).ok,true);
});

test('an invalid interrupted FLV merge is preserved and the original parts can be remuxed and merged',async()=>{
 const {rec,store}=await make('bad-flv-merge',2,'flv'),pending=rec.flvPath(1)+'.pending.flv',originals=[1,2].map(i=>fs.readFileSync(rec.flvPath(i)));
 rec.validateMedia=async(file)=>file===pending?{ok:false,retryable:true,stderr:'模拟校验中断'}:{ok:true};
 await assert.rejects(rec.mergeParts(),e=>e.code==='LR_SOURCE_BUSY');assert.ok(fs.existsSync(pending));
 let {retry}=reload(store,rec);retry.validateMedia=async()=>({ok:false,stderr:'模拟合并后数据损坏'});await retry.recoverMergePlan();
 assert.equal(retry.mergePlan,null);assert.equal(retry.mergeFallbackExtension,'mp4');
 const saved=fs.readdirSync(path.dirname(retry.base)).find(name=>name.includes('.pending.flv.invalid-'));assert.ok(saved);
 for(let i=1;i<=2;i++)assert.deepEqual(fs.readFileSync(retry.flvPath(i)),originals[i-1]);
 ({retry}=reload(store,rec));assert.equal(retry.mergeFallbackExtension,'mp4');assert.deepEqual(await retry.remuxAll(),[retry.mp4Path(1),retry.mp4Path(2)]);
 assert.equal(await retry.consolidateMp4s(),true);assert.equal(retry.part,1);assert.equal(retry.mergeFallbackExtension,null);assert.equal((await retry.validateMedia(retry.mp4Path(1))).ok,true);
});

test('temporary failure when recovering an interrupted FLV merge keeps its journal and output',async()=>{
 const {rec,store}=await make('merge-still-busy',2,'flv'),pending=rec.flvPath(1)+'.pending.flv';
 rec.validateMedia=async()=>({ok:false,retryable:true,stderr:'模拟文件占用'});await assert.rejects(rec.mergeParts(),e=>e.code==='LR_SOURCE_BUSY');
 const {retry}=reload(store,rec);retry.validateMedia=rec.validateMedia;await assert.rejects(retry.recoverMergePlan(),e=>e.code==='LR_SOURCE_BUSY');
 assert.ok(retry.mergePlan);assert.ok(fs.existsSync(pending));assert.equal(retry.mergeFallbackExtension,undefined);
});

test('recovery keeps every file if the fallback journal cannot be saved',async()=>{
 const {rec,store}=await make('fallback-journal-error',2,'flv'),pending=rec.flvPath(1)+'.pending.flv';
 rec.validateMedia=async()=>({ok:false,retryable:true,stderr:'模拟文件占用'});await assert.rejects(rec.mergeParts(),e=>e.code==='LR_SOURCE_BUSY');
 const {retry}=reload(store,rec);retry.validateMedia=async()=>({ok:false,stderr:'模拟数据损坏'});retry.onCheckpoint=()=>false;
 await assert.rejects(retry.recoverMergePlan(),e=>e.code==='LR_SOURCE_BUSY');assert.ok(fs.existsSync(pending));assert.ok(fs.existsSync(retry.flvPath(1)));assert.ok(fs.existsSync(retry.flvPath(2)));assert.ok(store.get(rec.jobId).recorder.mergePlan);
});

test('an interrupted merge is not archived when a source changes during its failed validation',async()=>{
 const {rec,store}=await make('fallback-source-change',2,'flv'),pending=rec.flvPath(1)+'.pending.flv';
 rec.validateMedia=async()=>({ok:false,retryable:true,stderr:'模拟文件占用'});await assert.rejects(rec.mergeParts(),e=>e.code==='LR_SOURCE_BUSY');
 const {retry}=reload(store,rec);retry.validateMedia=async()=>{fs.appendFileSync(retry.flvPath(2),'changed');return {ok:false,stderr:'模拟数据损坏'};};
 await assert.rejects(retry.recoverMergePlan(),e=>e.code==='LR_SOURCE_BUSY');assert.ok(retry.mergePlan);assert.ok(fs.existsSync(pending));assert.ok(fs.existsSync(retry.flvPath(1)));assert.ok(fs.existsSync(retry.flvPath(2)));assert.equal(retry.mergeFallbackExtension,undefined);
});

test('merge recovery keeps the old output and all sources if a source changes',async()=>{
 const {rec,store}=await make('merge-changed',2,'mp4'),pending=rec.mp4Path(1)+'.pending.mp4';
 rec.validateMedia=async(file)=>file===pending?{ok:false,retryable:true,stderr:'模拟占用'}:{ok:true};
 await assert.rejects(rec.consolidateMp4s(),e=>e.code==='LR_SOURCE_BUSY');fs.appendFileSync(rec.mp4Path(2),'changed');
 const {retry}=reload(store,rec);await retry.recoverMergePlan();assert.equal(retry.mergePlan,null);assert.ok(fs.existsSync(retry.mp4Path(1)));assert.ok(fs.existsSync(retry.mp4Path(2)));
 assert.ok(fs.readdirSync(path.dirname(retry.base)).some(name=>name.includes('.pending.mp4.interrupted-')));
});

test('a remux output changed just after validation is not published',async()=>{
 const {rec}=await make('remux-output-change'),pending=rec.mp4Path(1)+'.pending.mp4',validate=rec.validateMedia.bind(rec);let injected=false;
 rec.validateMedia=async(file,...args)=>{const result=await validate(file,...args);if(file===pending&&!injected){injected=true;fs.appendFileSync(file,'changed');}return result;};
 await assert.rejects(rec.remuxAll(),e=>e.code==='LR_SOURCE_BUSY');assert.ok(fs.existsSync(rec.flvPath(1)));assert.ok(fs.existsSync(pending));assert.equal(fs.existsSync(rec.mp4Path(1)),false);
});

test('a merged output changed just after validation is not committed',async()=>{
 const {rec}=await make('merge-output-change',2,'mp4'),pending=rec.mp4Path(1)+'.pending.mp4',validate=rec.validateMedia.bind(rec);let injected=false;
 rec.validateMedia=async(file,...args)=>{const result=await validate(file,...args);if(file===pending&&!injected){injected=true;fs.appendFileSync(file,'changed');}return result;};
 await assert.rejects(rec.consolidateMp4s(),e=>e.code==='LR_SOURCE_BUSY');assert.equal(rec.part,2);assert.ok(fs.existsSync(rec.mp4Path(1)));assert.ok(fs.existsSync(rec.mp4Path(2)));assert.ok(fs.existsSync(pending));
});

test('a changed remaining source is never deleted when recovering a published merge',async()=>{
 const {rec,store}=await make('merge-published-change',2,'mp4'),publish=rec._publish.bind(rec);
 rec._publish=(...args)=>{publish(...args);throw Error('模拟发布后中断');};await assert.rejects(rec.consolidateMp4s(),e=>e.code==='LR_SOURCE_BUSY');
 assert.ok(store.get(rec.jobId).recorder.mergePlan);fs.appendFileSync(rec.mp4Path(2),'changed');
 const {retry}=reload(store,rec);await assert.rejects(retry.recoverMergePlan(),e=>e.code==='LR_SOURCE_BUSY');assert.ok(fs.existsSync(retry.mp4Path(1)));assert.ok(fs.existsSync(retry.mp4Path(2)));
});

test('post-commit cleanup never deletes a replaced source after a restart',async()=>{
 const {rec,store}=await make('cleanup-replaced',2,'mp4'),{identity}=require('../src/core/upload-split'),source=rec.mp4Path(2);
 rec.mergedInputs=[source];rec.mergedInputIdentities={[source]:identity(source).split(':').slice(0,4).join(':')};rec.part=1;rec.checkpoint();
 fs.unlinkSync(source);fs.writeFileSync(source,'a different user file');
 const {retry}=reload(store,rec);await retry.recoverMergePlan();assert.equal(fs.readFileSync(source,'utf8'),'a different user file');assert.deepEqual(retry.mergedInputs,[source]);
});

test('legacy cleanup without source identities keeps the originals',async()=>{
 const {rec}=await make('legacy-cleanup',2,'mp4'),source=rec.mp4Path(2);rec.part=1;rec.mergedInputs=[source];
 await rec.recoverMergePlan();assert.ok(fs.existsSync(source));assert.deepEqual(rec.mergedInputs,[source]);
});

test('temporary publication validation failure never replaces the current file with its backup',async()=>{
 const {rec}=await make('publication-wait',1,'mp4'),current=rec.mp4Path(1),backup=current+'.previous';fs.copyFileSync(current,backup);const before=fs.readFileSync(current),prior=fs.readFileSync(backup);
 rec.validateMedia=async(file)=>file===current?{ok:false,retryable:true,stderr:'模拟暂时占用'}:{ok:true};
 await assert.rejects(rec.recoverPublications(),e=>e.code==='LR_SOURCE_BUSY');assert.deepEqual(fs.readFileSync(current),before);assert.deepEqual(fs.readFileSync(backup),prior);
});
