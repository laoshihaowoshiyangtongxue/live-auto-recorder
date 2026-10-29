const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lr-four-'));process.env.LR_LOG_DIR=path.join(root,'logs');
const {RecoveryController}=require('../src/core/recovery'),{PostProcessor}=require('../src/core/postprocess'),{Recorder}=require('../src/core/recorder'),{JobStore}=require('../src/core/job-store'),{MediaPool}=require('../src/core/media-pool');
function fixture(){const dir=fs.mkdtempSync(path.join(root,'case-')),post=new PostProcessor(path.join(dir,'dm.ass'),{}),s={post,cfg:{settings:{postQuietEnabled:true,postQuietStart:'23:45',postQuietEnd:'09:00'}},tasks:new Map(),outDir:dir,history:[],historyFile:path.join(dir,'history.json'),freeBytes:()=>1024**4};const r=new RecoveryController(s,path.join(dir,'jobs.json'));r.now=()=>new Date(2026,9,28,11);return {s,r,dir,add(n){const rec=new Recorder(path.join(dir,'主播_123456_20261027_23'+String(n).padStart(2,'0')+'00'));rec.part=1;rec.partStarts=[0,Date.parse('2026-10-27T23:00:00+08:00')];rec.startedAt=rec.partStarts[1];rec.settings={};const j=r.store.set(rec,{nickname:'任务'+n,status:'waiting',phase:'seal',waitReason:'quiet',finishedAt:rec.startedAt+n*1000});r.view(rec,j);return {rec,j};},close(){r.close();r.mediaPool.close();post.close();}};}
test('removing a completed row persists without touching videos or active jobs',()=>{
 const f=fixture();try{const done=f.add(1),waiting=f.add(2),video=path.join(f.dir,'finished.mp4');fs.writeFileSync(video,'video content');f.r.store.set(done.rec,{status:'done'});done.j=f.r.store.get(done.j.id);f.s.post.finish(f.r.view(done.rec,done.j),'done');
 assert.equal(f.r.removeCompleted(waiting.j.id).ok,false);assert.equal(f.r.removeCompleted(done.j.id).ok,true);assert.equal(fs.readFileSync(video,'utf8'),'video content');assert.ok(!f.r.status().items.some(v=>v.id===done.j.id));assert.ok(f.r.status().items.some(v=>v.id===waiting.j.id));
 const restored=new JobStore(f.r.store.file);assert.equal(restored.get(done.j.id).postHidden,true);assert.equal(restored.get(done.j.id).status,'done');
 }finally{f.close();}
});
test('a failed save keeps the completed row visible',()=>{const f=fixture();try{const done=f.add(1);f.r.store.set(done.rec,{status:'recovered'});f.s.post.finish(f.r.view(done.rec,f.r.store.get(done.j.id)),'recovered');f.r.store.persist=()=>false;assert.equal(f.r.removeCompleted(done.j.id).ok,false);assert.ok(f.r.status().items.some(v=>v.id===done.j.id));}finally{f.close();}});
test('quiet expiry updates every pending view and exposes per-task controls at 11:00',()=>{
 const f=fixture();try{const a=f.add(1),b=f.add(2);f.s.post.items.forEach(v=>v.status='quiet');const p=f.r.status();assert.equal(p.quiet.active,false);assert.equal(p.items.length,2);for(const v of p.items){assert.equal(v.status,'queued');assert.equal(v.controls.pause,true);assert.equal(v.controls.move,true);assert.equal(v.controls.runNow,true);assert.ok(v.postId);}}finally{f.close();}
});
test('a long recovery never blocks dispatch of the following quiet-expired tasks',async()=>{
 const f=fixture();let release;try{f.add(1);f.add(2);const calls=[];f.r.retry=async id=>{calls.push(id);await new Promise(r=>release=r);};await f.r.tick();assert.equal(calls.length,2);assert.equal(f.r.ticking,false);}finally{release?.();f.close();}
});
test('recording history uses the same current status as the post panel after quiet expiry',()=>{
 const f=fixture();try{const {j}=f.add(1);f.s.recovery=f.r;f.s.history=[{jobId:j.id,status:'quiet',error:''}];const snapshot=require('../src/core/scheduler').Scheduler.prototype.snapshot.call(f.s);assert.equal(snapshot.post.items[0].status,'queued');assert.equal(snapshot.history[0].status,'queued');assert.equal(f.s.history[0].status,'quiet');}finally{f.close();}
});
test('waiting tasks pause independently, persist order, and keep the same priority after reload',async()=>{
 const f=fixture();try{const a=f.add(1),b=f.add(2),c=f.add(3);assert.equal(f.r.pauseTask(b.j.id).ok,true);assert.equal(f.r.store.get(b.j.id).userPaused,true);assert.equal(f.r.store.get(a.j.id).status,'waiting');assert.equal(f.r.moveTask(c.j.id,'top').ok,true);assert.deepEqual(f.r.pendingJobs().map(j=>j.id),[c.j.id,a.j.id,b.j.id]);const saved=new JobStore(f.r.store.file);assert.equal(saved.get(c.j.id).queueOrder,0);assert.equal(saved.get(b.j.id).userPaused,true);f.r.requestRetry=()=>({ok:true});await f.r.resumeTask(b.j.id);assert.equal(f.r.store.get(b.j.id).userPaused,false);}finally{f.close();}
});
test('queue-order persistence failure rolls back the visible and in-memory priority',()=>{
 const f=fixture();try{f.add(1);const b=f.add(2);f.r.store.persist=()=>false;assert.equal(f.r.moveTask(b.j.id,'top').ok,false);assert.equal(f.r.store.get(b.j.id).queueOrder,undefined);}finally{f.close();}
});
test('a resource-waiting running lane remains reorderable until media work actually starts',()=>{
 const f=fixture();try{const {rec,j}=f.add(1);const view=f.s.post.items[0];view.stage='等待处理资源';view.status='burning';f.r.store.set(rec,{status:'processing',waitReason:''});const job={id:j.id,recorder:rec,view};f.s.post.running.add(job);const v=f.r.status().items.find(v=>v.id===j.id);assert.equal(v.status,'queued');assert.equal(v.controls.move,true);view.stage='弹幕烧录';assert.equal(f.r.status().items.find(v=>v.id===j.id).controls.move,false);}finally{f.close();}
});
test('resource waiters honour a changed order without preempting a running process',async()=>{
 const p=new MediaPool(()=>1);try{const first=await p.acquire();let a=1,b=2;const order=[];const one=p.acquire(()=>true,false,()=>a).then(l=>{order.push('a');l.release();});const two=p.acquire(()=>true,false,()=>b).then(l=>{order.push('b');l.release();});b=0;first.release();await Promise.all([one,two]);assert.deepEqual(order,['b','a']);}finally{p.close();}
});
test('early-start names and overnight 09:00 boundary are timezone-independent',()=>{
 const {stamp}=require('../src/core/video-names');const rec={base:path.join(root,'主播_123456_20261028_025532')};assert.equal(stamp(rec,{}).date,'2026-10-28凌晨');rec.base=path.join(root,'主播_123456_20261027_230000');assert.equal(stamp(rec,{finishedAt:Date.parse('2026-10-28T08:59:59+08:00')}).date,'2026-10-28凌晨');assert.equal(stamp(rec,{finishedAt:Date.parse('2026-10-28T09:00:00+08:00')}).date,'2026-10-27');
});
test('existing two-version names migrate safely and recover a mid-rename interruption',()=>{
 const {makePlan,applyPlan,dateMigration}=require('../src/core/video-names');const dir=fs.mkdtempSync(path.join(root,'names-')),base=path.join(dir,'主播_123456_20261028_025532'),rec={base,part:1,mp4Path:n=>base+'_part'+n+'.mp4',burnOutPath:n=>base+'_part'+n+'_弹幕版.mp4'};fs.writeFileSync(rec.mp4Path(1),'raw');fs.writeFileSync(rec.burnOutPath(1),'caption');const j={nickname:'主播',title:'主题'};let old=makePlan(rec,j);old=old.map(e=>({...e,destination:e.destination.replace('2026-10-28凌晨','2026-10-28')}));applyPlan(rec,old);j.publicationPlan=old;const plan=dateMigration(rec,j);assert.equal(plan.length,2);fs.linkSync(plan[0].source,plan[0].destination);applyPlan(rec,plan,{renameFinal:true});applyPlan(rec,plan,{renameFinal:true});assert.equal(fs.readdirSync(dir).length,2);assert.ok(plan.every(e=>fs.existsSync(e.destination)));
});
test('watchdog restarts only unexpected exits and stops crash loops',()=>{
 const {restartAllowed}=require('../src/util/app-watchdog.cjs');assert.equal(restartAllowed({expectedExit:true},[]),false);assert.equal(restartAllowed({expectedExit:false},[]),true);assert.equal(restartAllowed({},[Date.now(),Date.now(),Date.now()]),false);assert.equal(restartAllowed({},[Date.now()-3600000]),true);
});
test('pausing a resource-waiting resume request cancels it without waking the process later',async()=>{
 const {MediaExecution}=require('../src/core/media-execution');const pool=new MediaPool(()=>1),lease=await pool.acquire();
 const execution=new MediaExecution({mediaPool:pool},[],10000,false,0,'unused');execution.paused=true;execution.child={pid:0,exitCode:null};
 try{const resumed=execution.resume();execution.pause();lease.release();assert.equal(await resumed,false);assert.equal(execution.paused,true);assert.equal(pool.active.size,0);}finally{pool.close();}
});
test('a paused post job can cancel a pending resume without losing its paused status',async()=>{
 const post=new PostProcessor(path.join(root,'cancel-resume.ass'),{});let release;
 const recorder={pauseProcessing(){},resumeProcessing:()=>new Promise(r=>release=r)},job={id:'cancel',postId:'cancel',paused:true,recorder,view:{status:'paused'}};post.queue.push(job);post._drain=()=>{};
 try{const resumed=post.resumeTask('cancel');assert.ok(job.resuming);assert.equal(post.pauseTask('cancel').ok,true);release(true);assert.equal((await resumed).paused,true);assert.equal(job.paused,true);assert.equal(job.view.status,'paused');}finally{post.close();}
});
