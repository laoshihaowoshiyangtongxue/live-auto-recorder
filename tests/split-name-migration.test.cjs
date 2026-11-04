const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Recorder}=require('../src/core/recorder'),{PostProcessor}=require('../src/core/postprocess');
const {RecoveryController}=require('../src/core/recovery');
const {splitNamePlan,createAliases,queueRequests,readRequests,readRequestState}=require('../src/core/split-name-migration');

function fixture(count=2){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-split-migration-')),base=path.join(dir,'主播_123456_20261031_120000');
 const rec=new Recorder(base);rec.part=1;rec.startedAt=Date.now();rec.partStarts=[0,rec.startedAt];rec.settings={keepRaw:true};
 const entries=[];for(let i=1;i<=count;i++){
  const destination=path.join(dir,`2026-10-31_测试主播_12-00-00_测试直播_上传分段${String(i).padStart(3,'0')}_弹幕版.mp4`);
  fs.writeFileSync(destination,'video '+i);const s=fs.statSync(destination);
  entries.push({kind:'弹幕版',part:1,splitIndex:i,splitTotal:count,destination,identity:{dev:s.dev,ino:s.ino,size:s.size}});
 }
 const post=new PostProcessor(path.join(dir,'dm.ass'),{}),s={cfg:{settings:{}},post,tasks:new Map(),outDir:dir,history:[],historyFile:path.join(dir,'history.json'),freeBytes:()=>1024**4};
 const recovery=new RecoveryController(s,path.join(dir,'jobs.json'));s.recovery=recovery;
 const job=recovery.store.set(rec,{status:'done',phase:'publish',nickname:'测试主播',publicationPlan:entries});
 return {dir,rec,job,s,recovery,post,close(){recovery.close();post.close();recovery.mediaPool.close();}};
}
function extraJob(f,name,startedAt,status){
 const rec=new Recorder(path.join(f.dir,name+'_654321_20261031_110000'));rec.part=1;rec.startedAt=startedAt;rec.partStarts=[0,startedAt];rec.settings={keepRaw:true};
 const entries=[];for(let i=1;i<=2;i++){
  const destination=path.join(f.dir,`2026-10-31_${name}_11-00-00_测试直播_上传分段${String(i).padStart(3,'0')}_弹幕版.mp4`);fs.writeFileSync(destination,name+i);
  const s=fs.statSync(destination);entries.push({kind:'弹幕版',part:1,splitIndex:i,splitTotal:2,destination,identity:{dev:s.dev,ino:s.ino,size:s.size}});
 }
 return {rec,job:f.recovery.store.set(rec,{status,phase:'publish',nickname:name,publicationPlan:entries})};
}

test('two, three and four split aliases use the selected labels and retain original paths',()=>{
 for(const [count,labels] of [[2,['上','下']],[3,['上','中','下']],[4,['第一部分','第二部分','第三部分','第四部分']]]){
  const f=fixture(count);try{
   const plan=splitNamePlan(f.rec,f.job);assert.equal(plan.length,count);createAliases(plan);
   for(let i=0;i<count;i++){assert.match(path.basename(plan[i].destination),new RegExp('_'+labels[i]+'_弹幕版\\.mp4$'));assert.ok(fs.existsSync(plan[i].source));assert.equal(fs.statSync(plan[i].source).ino,fs.statSync(plan[i].destination).ino);assert.equal(fs.readFileSync(plan[i].destination,'utf8'),'video '+(i+1));}
  }finally{f.close();}
 }
});

test('a queued migration updates the job and history without changing recording contents',()=>{
 const f=fixture(2);try{
  const plan=splitNamePlan(f.rec,f.job);createAliases(plan);queueRequests(f.recovery.store.file,[f.job.id]);
  f.recovery.processPendingSplitNames();const saved=f.recovery.store.get(f.job.id);
  assert.deepEqual(readRequests(f.recovery.store.file),[]);assert.equal(saved.splitNamingMigrationPlan,null);
  assert.deepEqual(saved.publicationPlan.map(e=>e.destination),plan.map(e=>e.destination));assert.ok(plan.every(p=>!fs.existsSync(p.source)&&fs.existsSync(p.destination)));
  assert.deepEqual(f.s.history[0].files,plan.map(p=>path.basename(p.destination)));
  assert.equal(fs.readFileSync(plan[0].destination,'utf8'),'video 1');
 }finally{f.close();}
});

test('partial migration resumes safely after an occupied file is released',()=>{
 const f=fixture(3),unlink=fs.unlinkSync;try{
  const plan=splitNamePlan(f.rec,f.job);createAliases(plan);queueRequests(f.recovery.store.file,[f.job.id]);
  fs.unlinkSync=file=>{if(file===plan[1].source){const e=Error('busy');e.code='EBUSY';throw e;}return unlink(file);};
  try{f.recovery.processPendingSplitNames();}finally{fs.unlinkSync=unlink;}
  assert.ok(f.recovery.store.get(f.job.id).splitNamingMigrationPlan.length);assert.deepEqual(readRequests(f.recovery.store.file),[f.job.id]);
  assert.ok(plan.every(p=>fs.existsSync(p.source)||fs.existsSync(p.destination)));
  f.recovery.processPendingSplitNames();assert.deepEqual(readRequests(f.recovery.store.file),[]);assert.ok(plan.every(p=>!fs.existsSync(p.source)&&fs.existsSync(p.destination)));
 }finally{fs.unlinkSync=unlink;f.close();}
});

test('a conflicting new filename is never overwritten and originals are untouched',()=>{
 const f=fixture(2);try{
  const plan=splitNamePlan(f.rec,f.job);fs.writeFileSync(plan[0].destination,'other file');
  assert.throws(()=>splitNamePlan(f.rec,f.job),/被占用/);assert.equal(fs.readFileSync(plan[0].destination,'utf8'),'other file');assert.ok(plan.every(p=>fs.existsSync(p.source)));
 }finally{f.close();}
});

test('old recordings are unchanged unless specifically queued',()=>{
 const f=fixture(2);try{const plan=splitNamePlan(f.rec,f.job);f.recovery.processPendingSplitNames();assert.ok(plan.every(p=>fs.existsSync(p.source)&&!fs.existsSync(p.destination)));}finally{f.close();}
});

test('migration accepts an existing alias if the old path was already removed',()=>{
 const f=fixture(2);try{const plan=splitNamePlan(f.rec,f.job);createAliases(plan);fs.unlinkSync(plan[0].source);queueRequests(f.recovery.store.file,[f.job.id]);f.recovery.processPendingSplitNames();assert.ok(plan.every(p=>fs.existsSync(p.destination)));assert.deepEqual(readRequests(f.recovery.store.file),[]);}finally{f.close();}
});

test('startup consumes only the queued jobs and updates history',async()=>{
 const f=fixture(2);let restarted;try{
  const plan=splitNamePlan(f.rec,f.job);createAliases(plan);queueRequests(f.recovery.store.file,[f.job.id]);
  restarted=new RecoveryController(f.s,f.recovery.store.file);restarted.scan=async()=>{};
  await restarted.start();assert.deepEqual(readRequests(restarted.store.file),[]);assert.ok(plan.every(p=>!fs.existsSync(p.source)&&fs.existsSync(p.destination)));
  assert.deepEqual(restarted.store.get(f.job.id).publicationPlan.map(e=>e.destination),plan.map(p=>p.destination));assert.deepEqual(f.s.history[0].files,plan.map(p=>path.basename(p.destination)));
 }finally{restarted?.close();restarted?.mediaPool.close();f.close();}
});

test('restart finishes a migration interrupted after filesystem changes',async()=>{
 const f=fixture(2);let restarted;try{
  const plan=splitNamePlan(f.rec,f.job);createAliases(plan);queueRequests(f.recovery.store.file,[f.job.id]);
  const set=f.recovery.store.set.bind(f.recovery.store);let failed=false;
  f.recovery.store.set=(rec,patch={})=>{if(!failed&&patch.splitNamingMigrationPlan===null){failed=true;throw Error('模拟记录保存中断');}return set(rec,patch);};
  f.recovery.processPendingSplitNames();assert.equal(failed,true);assert.ok(plan.every(p=>!fs.existsSync(p.source)&&fs.existsSync(p.destination)));
  restarted=new RecoveryController(f.s,f.recovery.store.file);restarted.scan=async()=>{};await restarted.start();
  assert.deepEqual(readRequests(restarted.store.file),[]);assert.deepEqual(restarted.store.get(f.job.id).publicationPlan.map(e=>e.destination),plan.map(p=>p.destination));
 }finally{restarted?.close();restarted?.mediaPool.close();f.close();}
});

test('the one-time window includes newer old-version jobs but leaves earlier recordings unchanged',()=>{
 const f=fixture(2);try{
  const cutoff=Date.now()-10000,older=extraJob(f,'较早主播',cutoff-1000,'done'),inflight=extraJob(f,'仍在发布',cutoff+1000,'publishing');
  const recentPlan=splitNamePlan(f.rec,f.job),oldPlan=splitNamePlan(older.rec,older.job),inflightPlan=splitNamePlan(inflight.rec,inflight.job);
  queueRequests(f.recovery.store.file,[],{since:cutoff});f.recovery.processPendingSplitNames();
  assert.ok(recentPlan.every(p=>fs.existsSync(p.destination)));assert.ok(oldPlan.every(p=>fs.existsSync(p.source)&&!fs.existsSync(p.destination)));
  assert.deepEqual(readRequests(f.recovery.store.file),[inflight.job.id]);assert.equal(readRequestState(f.recovery.store.file).since,null);
  f.recovery.store.set(inflight.rec,{status:'done'});f.recovery.processPendingSplitNames();
  assert.ok(inflightPlan.every(p=>fs.existsSync(p.destination)));assert.deepEqual(readRequests(f.recovery.store.file),[]);
 }finally{f.close();}
});
