const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'lr-stability-'));process.chdir(root);process.env.LR_LOG_DIR=path.join(root,'logs');
const {Scheduler}=require('../src/core/scheduler'),{Recorder,createFfmpegRunner}=require('../src/core/recorder'),{PostProcessor}=require('../src/core/postprocess');
const {RecoveryController}=require('../src/core/recovery'),{JobStore,restoreRecorder}=require('../src/core/job-store'),{inspectFlvTailAsync}=require('../src/core/flv-tail-async'),{DanmakuCapture}=require('../src/core/danmaku');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');const sleep=ms=>new Promise(r=>setTimeout(r,ms));const ff=createFfmpegRunner();let source;
async function command(args){const r=await ff(args,30000);assert.equal(r.code,0,r.stderr);}
async function fixture(){if(!source){source=path.join(root,'fixture.flv');await command(['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=15','-f','lavfi','-i','sine=frequency=440','-t','8','-c:v','libx264','-preset','ultrafast','-g','15','-c:a','aac','-f','flv',source]);}return source;}
function scheduler(dir){
 const s=Object.create(Scheduler.prototype);s.cfg={watchlist:[],settings:{outputDir:dir,minFreeGB:0,maxConcurrentRecordings:2,autoPartMerge:true,minSizeMB:0,burnDanmaku:true,keepRaw:true,keepDays:0}};s.outDir=dir;s.tasks=new Map();s.timers=new Map();s.history=[];s.historyFile=path.join(dir,'history.json');s.post=new PostProcessor(path.join(root,'dm.ass'),s.cfg.settings);s.freeBytes=()=>1024**4;s.sess={};s.recovery=new RecoveryController(s,path.join(dir,'jobs.json'));return s;
}
async function job(name,parts=1,register=true){
 const dir=fs.mkdtempSync(path.join(root,name+'-')),s=scheduler(dir),rec=new Recorder(path.join(dir,'主播_123456_20261026_100000'));rec.part=parts;rec.startedAt=Date.now()-20000;rec.partStarts=[0,rec.startedAt,rec.startedAt+12000];rec.settings={...s.cfg.settings};fs.copyFileSync(await fixture(),rec.flvPath(parts));fs.writeFileSync(rec.base+'.danmaku.jsonl',JSON.stringify({t:rec.partStarts[parts]+100,text:'甲：验证评论'})+'\n');
 const task={rid:'123456',key:'123456',item:{},state:'recording',rec,basePath:rec.base,recorderStartedAt:rec.startedAt,dm:{stop:async()=>{}},lastInfo:{nickname:'主播',title:'故障测试',live:false}};s.tasks.set(task.key,task);if(register)s.recovery.begin(rec,task);return {s,task,rec,dir};
}
async function drain(post){for(let i=0;i<300&&post.busy;i++)await sleep(50);assert.equal(post.busy,false,'postprocessor did not drain');}
function assertFinalVideos(s,rec){
 const saved=[...s.recovery.store.jobs.values()].find(j=>j.base===rec.base);
 const files=require('../src/core/video-names').videoFiles(rec,saved);assert.equal(files.length,2);
 assert.ok(files.every(f=>fs.existsSync(f)&&/_(纯享版|弹幕版)\.mp4$/.test(f)));
}

test('existing completed files migrate on startup without new completion notifications or media work',async()=>{
 const {s,rec,dir}=await job('migrate-old-names');await rec.remuxAll(0);fs.copyFileSync(rec.mp4Path(1),rec.burnOutPath(1));
 const old=s.recovery.store.set(rec,{status:'done',phase:'post'});s.recovery.updateHistory(rec,old,'done');
 const fresh=scheduler(dir);fresh.history=JSON.parse(fs.readFileSync(fresh.historyFile));const events=[];fresh.onEvent=type=>events.push(type);
 const run=Recorder.prototype._runFfmpeg;Recorder.prototype._runFfmpeg=()=>{throw Error('naming must not transcode');};
 try{await fresh.recovery.start();fresh.recovery.close();}finally{Recorder.prototype._runFfmpeg=run;}
 assertFinalVideos(fresh,rec);assert.ok(fresh.history[0].files.every(file=>fs.existsSync(path.join(dir,file))));assert.equal(events.includes('record-done'),false);
});
test('new final names containing old-style timestamp text are not mistaken for orphan fragments',async()=>{
 const {s,dir}=await job('scan-new-names');const count=s.recovery.store.jobs.size;
 fs.copyFileSync(await fixture(),path.join(dir,'2026-10-26_主播_10-00-00_主题_123456_20261026_100000_part1_弹幕版.mp4'));
 await s.recovery.scan();assert.equal(s.recovery.store.jobs.size,count);
});
test('completed files are named and indexed before their final completion event',async()=>{
 const {s,task,rec}=await job('final-names');task.lastInfo.title='主题/含:非法字符';s.recovery.store.set(rec,{title:task.lastInfo.title});
 const events=[];s.onEvent=(type,data)=>{if(type==='record-done')events.push(data);};
 await s._stopJob(task,'下播');await drain(s.post);
 const saved=s.recovery.store.get(rec.jobId);assert.equal(saved.status,'done');assert.equal(saved.publicationPlan.length,2);
 assert.ok(s.history[0].files.every(f=>/2026-10-26_主播_10-00-00_主题_含_非法字符_(纯享版|弹幕版)\.mp4$/.test(f)));
 assert.ok(s.history[0].files.every(f=>fs.existsSync(path.join(s.outDir,f))));assert.deepEqual(events[0].files,s.history[0].files);
});
test('a crash during final naming resumes publication without rerunning FFmpeg',async()=>{
 const {s,task,rec,dir}=await job('publish-restart');const unlink=fs.unlinkSync;
 fs.unlinkSync=file=>{if(file===rec.burnOutPath(1))throw Error('simulated naming interruption');return unlink(file);};
 try{await s._stopJob(task,'下播');await drain(s.post);}finally{fs.unlinkSync=unlink;}
 const failed=s.recovery.store.get(rec.jobId);assert.equal(failed.status,'failed');assert.equal(failed.phase,'publish');assert.equal(failed.publicationPlan.length,2);
 const fresh=scheduler(dir);fresh.history=JSON.parse(fs.readFileSync(fresh.historyFile));
 const run=Recorder.prototype._runFfmpeg;Recorder.prototype._runFfmpeg=()=>{throw Error('publication recovery must not transcode again');};
 try{await fresh.recovery.start();fresh.recovery.close();}finally{Recorder.prototype._runFfmpeg=run;}
 assert.equal(fresh.recovery.store.get(rec.jobId).status,'done');assertFinalVideos(fresh,rec);assert.equal(fs.existsSync(rec.burnOutPath(1)),false);
});
test('quiet hours defer sealing without running FFmpeg and resume automatically after restart',async()=>{
 const {s,task,rec,dir}=await job('quiet-seal');
 const settings={postQuietEnabled:true,postQuietStart:'23:00',postQuietEnd:'08:00'};
 Object.assign(s.cfg.settings,settings);s.recovery.now=()=>new Date(2026,9,26,23,30);
 let runs=0;const original=rec._runFfmpeg.bind(rec);rec._runFfmpeg=(...args)=>{runs++;return original(...args);};
 const stopped=await s._stopJob(task,'下播');assert.equal(stopped.quiet,true);assert.equal(runs,0);
 assert.equal(s.post.items[0].status,'quiet');assert.equal(s.history[0].status,'quiet');
 const saved=s.recovery.store.get(rec.jobId);assert.equal(saved.waitReason,'quiet');assert.equal(saved.phase,'seal');assert.ok(fs.existsSync(rec.flvPath(1)));
 const fresh=scheduler(dir);fresh.history=JSON.parse(fs.readFileSync(fresh.historyFile));Object.assign(fresh.cfg.settings,settings);fresh.recovery.now=()=>new Date(2026,9,27,7);
 await fresh.recovery.start();assert.equal(fresh.post.busy,false);assert.equal(fresh.post.items[0].status,'quiet');
 fresh.recovery.now=()=>new Date(2026,9,27,8);await fresh.recovery.tick();for(let i=0;i<1000&&(fresh.recovery.running.size||fresh.post.busy);i++)await sleep(20);await drain(fresh.post);fresh.recovery.close();
 assert.equal(fresh.recovery.store.get(rec.jobId).status,'done');assert.equal(fresh.history[0].files.length,2);
});
test('an admitted task finishes its subtitle stage after quiet hours begin while new tasks wait',async()=>{
 const {s,task,rec}=await job('quiet-active');Object.assign(s.cfg.settings,{postQuietEnabled:true,postQuietStart:'23:00',postQuietEnd:'08:00'});
 let now=new Date(2026,9,26,22,59);s.recovery.now=()=>now;
 const native=rec.remuxAll.bind(rec);rec.remuxAll=async(...args)=>{const files=await native(...args);now=new Date(2026,9,26,23);return files;};
 await s._stopJob(task,'下播');await drain(s.post);
 assert.equal(s.recovery.store.get(rec.jobId).status,'done');assert.equal(s.history[0].files.length,2);
 const next=new Recorder(path.join(path.dirname(rec.base),'新主播_654321_20261026_230100'));next.part=1;next.settings={...s.cfg.settings};next.startedAt=Date.now();next.partStarts=[0,next.startedAt];fs.copyFileSync(await fixture(),next.flvPath(1));
 const nextTask={rid:'654321',item:{},rec:next,basePath:next.base,recorderStartedAt:next.startedAt,lastInfo:{nickname:'新主播'},dm:{stop:async()=>{}}};s.recovery.begin(next,nextTask);
 const result=await s.recovery.processStopped(nextTask,next,s.post.begin(next,'新主播'));assert.equal(result.quiet,true);assert.equal(fs.existsSync(next.mp4Path(1)),false);
});
test('a queued subtitle job survives quiet shutdown and resumes when quiet hours are disabled',async()=>{
 const {s,task,rec,dir}=await job('quiet-post');await rec.remuxAll(0);
 task.state='idle';task.rec=null;Object.assign(s.cfg.settings,{postQuietEnabled:true,postQuietStart:'23:00',postQuietEnd:'08:00'});s.recovery.now=()=>new Date(2026,9,26,23);
 s.recovery.store.set(rec,{status:'queued',phase:'post'});s.post.enqueue({id:rec.jobId,recorder:rec,view:s.recovery.view(rec,s.recovery.store.get(rec.jobId)),danmakuFile:rec.base+'.danmaku.jsonl',settings:rec.settings,mergeComplete:true});
 assert.equal(s.post.queue.length,1);assert.equal(s.post.busy,false);assert.equal(s.post.items[0].status,'quiet');
 const at=Date.now();await s.shutdown();assert.ok(Date.now()-at<1000,'quiet shutdown must not wait until morning');
 const fresh=scheduler(dir);fresh.history=JSON.parse(fs.readFileSync(fresh.historyFile));fresh.recovery.now=()=>new Date(2026,9,26,23);await fresh.recovery.start();await drain(fresh.post);fresh.recovery.close();
 assert.equal(fresh.recovery.store.get(rec.jobId).status,'done');assert.equal(fresh.history[0].files.length,2);
});
test('invalid quiet interval cannot partially apply or save settings',async()=>{
 const {s}=await job('quiet-invalid');const previous=s.cfg.settings;
 assert.throws(()=>s.updateSettings({postQuietEnabled:true,postQuietStart:'23:00',postQuietEnd:'23:00'}),/静音时段/);
 assert.equal(s.cfg.settings,previous);
 assert.throws(()=>s.updateSettings({postQuietEnabled:true,postQuietStart:'25:00',postQuietEnd:'08:00'}),/静音时段/);
});
test('empty reconnect attempts do not prevent MP4 fallback from publishing exactly two complete versions',async()=>{
 const {s,task,rec}=await job('empty-reconnect',2);
 fs.copyFileSync(await fixture(),rec.flvPath(1));rec.part=4;rec.emptyParts=new Set([3,4]);
 rec.partStarts[3]=rec.partStarts[2]+8000;rec.partStarts[4]=rec.partStarts[3]+3000;
 // Reproduce the FLV merge failure that precedes successful individual remuxes.
 rec.mergeParts=async()=>false;rec.checkpoint();
 await s._stopJob(task,'直播间消失');await drain(s.post);
 assert.equal(rec.part,1);assert.equal(s.history[0].files.length,2);assert.equal(rec.issues.length,0);
 assertFinalVideos(s,rec);
 assert.equal(fs.existsSync(rec.mp4Path(2)),false);
});
test('missing untracked fragment is never reported as an entirely completed job',async()=>{
 const {s,task,rec}=await job('missing',2);const result=await s._stopJob(task,'下播');await drain(s.post);
 assert.equal(result.ok,false);assert.ok(rec.issues.some(e=>e.includes('分片1')&&e.includes('缺失')));assert.equal(s.history[0].status,'warning');assert.ok(s.history[0].error);assert.equal(s.post.items[0].status,'warning');
});
test('failed subtitle job persists its error and can retry to completion without a premature done event',async()=>{
 const {s,task,rec}=await job('post-failure');const events=[];s.onEvent=(type,data)=>events.push({type,data});
 rec.burnPartDanmaku=async()=>{await sleep(80);return {ok:false,stderr:'temporary encoder error'};};
 const result=await s._stopJob(task,'下播');assert.equal(result.processing,true);await drain(s.post);
 assert.equal(events.some(e=>e.type==='record-done'),false);assert.ok(events.some(e=>e.type==='record-error'));assert.equal(s.history[0].status,'failed');assert.match(s.history[0].error,/temporary encoder/);assert.match(task.lastError,/temporary encoder/);
 const persisted=new JobStore(s.recovery.store.file).get(rec.jobId);assert.equal(persisted.status,'failed');assert.ok(persisted.nextAttemptAt>Date.now());
 await s.recovery.retry(rec.jobId,true);await drain(s.post);assert.equal(s.recovery.store.get(rec.jobId).status,'done');assert.equal(s.history[0].status,'done');assert.equal(s.history[0].files.length,2);assert.equal(s.history[0].error,'');assert.ok(events.some(e=>e.type==='record-done'));
});
test('zero disk space defers work durably and resumes after space returns',async()=>{
 const {s,task,rec}=await job('disk-wait');s.freeBytes=()=>0;let writes=0;const native=rec._runFfmpeg.bind(rec);rec._runFfmpeg=(...args)=>{writes++;return native(...args);};
 const result=await s._stopJob(task,'磁盘空间不足');assert.equal(result.deferred,true);assert.equal(writes,0);assert.ok(fs.existsSync(rec.flvPath(1)));assert.equal(fs.existsSync(rec.mp4Path(1)),false);assert.equal(s.post.busy,false);assert.equal(s.recovery.store.get(rec.jobId).status,'waiting');
 s.freeBytes=()=>1024**4;await s.recovery.retry(rec.jobId,true);await drain(s.post);assert.equal(s.recovery.store.get(rec.jobId).status,'done');assertFinalVideos(s,rec);
});
test('recording journal restores exact part starts and finishes both versions after restart',async()=>{
 const {s,task,rec,dir}=await job('restart-journal',2);
 await command(['-y','-v','error','-ss','0','-i',await fixture(),'-t','4','-c','copy',rec.flvPath(1)]);
 await command(['-y','-v','error','-ss','4','-i',await fixture(),'-t','4','-c','copy',rec.flvPath(2)]);rec.checkpoint();
 const expected=[rec.partStarts[1],rec.partStarts[2]];const fresh=scheduler(dir);await fresh.recovery.start();await drain(fresh.post);fresh.recovery.close();
 const state=fresh.recovery.store.get(rec.jobId);assert.ok(['done','recovered'].includes(state.status),state.error);assert.deepEqual(state.recorder.mergedSegStarts,expected);assertFinalVideos(fresh,rec);assert.equal(fresh.history[0].files.length,2);
});
test('legacy orphan FLV is found and sealed automatically on startup',async()=>{
 const {s,rec}=await job('legacy-recovery',1,false);await s.recovery.start();await drain(s.post);s.recovery.close();
 const record=[...s.recovery.store.jobs.values()].find(j=>j.base===rec.base);assert.ok(record);assert.ok(['done','recovered'].includes(record.status),record.error);assertFinalVideos(s,rec);
});
test('a failed job remains visible after restart even when automatic retry is exhausted',async()=>{
 const {s,rec}=await job('persistent-failure');s.recovery.store.set(rec,{status:'failed',phase:'post',attempts:3,nextAttemptAt:0,error:'manual intervention needed'});
 const fresh=scheduler(path.dirname(rec.base));await fresh.recovery.start();fresh.recovery.close();assert.equal(fresh.post.items[0].status,'failed');assert.equal(fresh.post.items[0].id,rec.jobId);assert.match(fresh.post.items[0].error,/manual intervention/);
});
test('shutdown does not hang on a job waiting for disk space',async()=>{
 const {s,task,rec}=await job('shutdown-wait');s.freeBytes=()=>0;await s._stopJob(task,'磁盘空间不足');
 await Promise.race([s.shutdown(),sleep(2000).then(()=>{throw Error('shutdown blocked on waiting job');})]);assert.equal(new JobStore(s.recovery.store.file).get(rec.jobId).status,'waiting');
});
test('transient comment-file write failure reconnects the writer without ending the session',async()=>{
 const wc=new EventEmitter();wc.isDestroyed=()=>false;wc.debugger={isAttached:()=>true,sendCommand:async()=>({result:{value:'alive'}})};
 const win=new EventEmitter();win.webContents=wc;win.isDestroyed=()=>false;win.destroy=()=>win.emit('closed');
 const dm=new DanmakuCapture({openRoomWindow:async()=>win});dm.basePath=path.join(root,'comment-write-retry');dm.rid='123456';dm.win=win;dm.retryMs=100000;
 const bad=new PassThrough();bad.resume();const create=fs.createWriteStream;fs.createWriteStream=()=>bad;
 try{dm._ensureFile();bad.emit('error',Error('ENOSPC test'));}finally{fs.createWriteStream=create;}
 assert.equal(dm.stopped,false);assert.equal(dm.state,'retrying');assert.ok(dm.timer);await dm._check();assert.equal(dm.state,'listening');assert.equal(dm.gaps.length,1);assert.ok(dm.gaps[0].end);assert.ok(fs.existsSync(dm.basePath+'.danmaku-status.json'));await dm.stop();
});
test('missing main configuration restores the valid backup rather than clearing watches',()=>{
 const dir=fs.mkdtempSync(path.join(root,'cfg-'));fs.writeFileSync(path.join(dir,'config.json.bak'),JSON.stringify({watchlist:[{rid:'123456'}],settings:{segment:'0'}}));const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../src/core/store.js'),'utf8'),{require:id=>id==='./companies'?require('../src/core/companies'):id==='./quiet-hours'?require('../src/core/quiet-hours'):id==='../util/atomic-json'?require('../src/util/atomic-json'):require(id),module,exports:module.exports,__dirname:path.join(dir,'src/core'),structuredClone,process,console});
 assert.equal(module.exports.load().watchlist[0].rid,'123456');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'config.json'))).watchlist.length,1);
});
test('large-file inspection runs outside the main event loop',async()=>{
 let heartbeat=false;const timer=setTimeout(()=>heartbeat=true,5);const result=await inspectFlvTailAsync(await fixture());clearTimeout(timer);assert.equal(heartbeat,true);assert.equal(result.reason,'no-tail-damage');
});
test('disk space disappearing during encoding stops output and preserves the source',async()=>{
 const {rec}=await job('disk-during-burn');await rec.remuxAll(0);let free=1024**4;rec.availableBytes=()=>free;
 fs.writeFileSync(path.join(root,'dm.ass'),require('../src/core/postprocess').genAss([{vt:0,text:'甲：空间监控'}]));const native=rec._runFfmpeg.bind(rec);rec._runFfmpeg=(args,...rest)=>native(args.includes('ass=dm.ass')?['-re',...args]:args,...rest);
 const timer=setTimeout(()=>free=0,150);try{await assert.rejects(rec.burnPartDanmaku(1),e=>e.code==='LR_DISK_SPACE');}finally{clearTimeout(timer);}
 assert.ok(fs.existsSync(rec.mp4Path(1)));assert.equal(fs.existsSync(rec.burnOutPath(1)),false);assert.equal(fs.existsSync(rec.burnOutPath(1)+'.pending.mp4'),false);
});
test('automatic retry runs after backoff when the failed encoder is available again',async()=>{
 const {s,task,rec}=await job('auto-retry');rec.burnPartDanmaku=async()=>({ok:false,stderr:'temporary encoder failure'});await s._stopJob(task,'下播');await drain(s.post);
 s.recovery.store.set(rec,{nextAttemptAt:Date.now()-1});await s.recovery.tick();await drain(s.post);assert.equal(s.recovery.store.get(rec.jobId).status,'done');
});
test('a corrupt job journal restores its valid backup without overwriting that backup',async()=>{
 const {s,rec}=await job('journal-backup');const file=s.recovery.store.file;fs.copyFileSync(file,file+'.bak');fs.writeFileSync(file,'{interrupted');
 const restored=new JobStore(file);assert.equal(restored.get(rec.jobId).base,rec.base);assert.equal(JSON.parse(fs.readFileSync(file)).jobs[0].id,rec.jobId);assert.equal(JSON.parse(fs.readFileSync(file+'.bak')).jobs[0].id,rec.jobId);
});
test('malformed optional journal fields cannot prevent other jobs from restoring',async()=>{
 const {s,rec}=await job('journal-fields');const saved=s.recovery.store.get(rec.jobId);saved.recorder.emptyParts={bad:true};saved.recorder.mergedInputs={bad:true};saved.recorder.issues=null;
 const restored=restoreRecorder(saved,Recorder);assert.equal(restored.emptyParts.size,0);assert.equal(restored.mergedInputs,undefined);assert.ok(restored.notices.length);
});
test('an unwritable journal defers processing without deleting source files',async()=>{
 const {s,task,rec}=await job('locked-journal');const rename=fs.renameSync;
 fs.renameSync=(a,b)=>{if(b===s.recovery.store.file)throw Error('EACCES journal lock');return rename(a,b);};let result;
 try{result=await s._stopJob(task,'下播');}finally{fs.renameSync=rename;}
 assert.equal(result.deferred,true);assert.ok(fs.existsSync(rec.flvPath(1)));assert.equal(fs.existsSync(rec.mp4Path(1)),false);
 await s.recovery.retry(rec.jobId,true);await drain(s.post);assert.equal(s.recovery.store.get(rec.jobId).status,'done');
});
test('additional fragments missing from the last checkpoint are discovered on recovery',async()=>{
 const {s,rec,dir}=await job('extra-fragment');await command(['-y','-v','error','-ss','0','-i',await fixture(),'-t','4','-c','copy',rec.flvPath(1)]);rec.checkpoint();
 await command(['-y','-v','error','-ss','4','-i',await fixture(),'-t','4','-c','copy',rec.flvPath(2)]);
 const fresh=scheduler(dir);await fresh.recovery.start();await drain(fresh.post);fresh.recovery.close();const state=fresh.recovery.store.get(rec.jobId);assert.equal(state.recorder.mergedFromParts,2);assert.ok(state.recorder.notices.some(n=>n.includes('额外分片')));assert.ok(['done','recovered'].includes(state.status),state.error);
});
test('fragment discovery preserves starts for part2 and part10 regardless of lexical order',async()=>{
 const dir=fs.mkdtempSync(path.join(root,'part-order-')),rec=new Recorder(path.join(dir,'ordered'));rec.part=1;rec.partStarts=[0,1000];
 fs.writeFileSync(rec.flvPath(10),'part10');fs.writeFileSync(rec.flvPath(2),'part2');await rec.reconcileParts();assert.equal(rec.part,10);assert.ok(rec.partStarts[2]>0&&rec.partStarts[10]>0);
});
test('recovery will not delete remaining inputs when a committed merge has become corrupt',async()=>{
 const dir=fs.mkdtempSync(path.join(root,'bad-merged-')),rec=new Recorder(path.join(dir,'merged'));rec.part=1;rec.mergedInputs=[rec.flvPath(2)];fs.writeFileSync(rec.flvPath(1),'damaged output');fs.copyFileSync(await fixture(),rec.flvPath(2));
 await assert.rejects(rec.recoverMergePlan(),/无法验证/);assert.ok(fs.existsSync(rec.flvPath(2)));
});
test('an interrupted file publication restores its previous verified product',async()=>{
 const dir=fs.mkdtempSync(path.join(root,'interrupted-publish-')),rec=new Recorder(path.join(dir,'published'));rec.part=1;
 await command(['-y','-v','error','-i',await fixture(),'-c','copy',rec.mp4Path(1)+'.previous.mp4']);fs.renameSync(rec.mp4Path(1)+'.previous.mp4',rec.mp4Path(1)+'.previous');
 await rec.recoverPublications();assert.ok(fs.existsSync(rec.mp4Path(1)));assert.equal(fs.existsSync(rec.mp4Path(1)+'.previous'),false);assert.ok((await rec.validateMedia(rec.mp4Path(1))).ok);
});
test('committed merge is recovered by file identity without appending its original parts twice',async()=>{
 const {s,rec}=await job('merge-journal',2);await command(['-y','-v','error','-ss','0','-i',await fixture(),'-t','4','-c','copy',rec.flvPath(1)]);await command(['-y','-v','error','-ss','4','-i',await fixture(),'-t','4','-c','copy',rec.flvPath(2)]);
 let plan;const publish=rec._publish.bind(rec);rec._publish=(pending,destination)=>{plan=structuredClone(rec.mergePlan);publish(pending,destination);};assert.equal(await rec.mergeParts(),true);assert.ok(plan);
 // Recreate the exact journal state of a crash after publish and before the commit checkpoint.
 const restored=new Recorder(rec.base);restored.part=2;restored.partStarts=[0,...plan.starts];restored.mergePlan=plan;fs.copyFileSync(await fixture(),restored.flvPath(2));await restored.recoverMergePlan();assert.equal(restored.part,1);assert.equal(restored.mergePlan,null);assert.equal(fs.existsSync(restored.flvPath(2)),false);assert.ok((await restored._probeDuration(restored.flvPath(1)))<9);
});
