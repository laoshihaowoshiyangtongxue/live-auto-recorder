const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {makePlan,applyPlan,videoFiles,isFinalVideoName,splitLabel}=require('../src/core/video-names');
const {identity:splitIdentity}=require('../src/core/upload-split');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-video-names-'));
 const base=path.join(dir,'主播_123456_20261026_132913');
 const rec={base,part:1,mp4Path:i=>base+'_part'+i+'.mp4',burnOutPath:i=>base+'_part'+i+'_弹幕版.mp4'};
 fs.writeFileSync(rec.mp4Path(1),'raw-video');fs.writeFileSync(rec.burnOutPath(1),'caption-video');
 fs.mkdirSync(path.join(dir,'2026-10-26'));
 return {dir,rec,job:{nickname:'测试主播',title:'直播内容'}};
}
test('split labels use 上中下 or numbered Chinese parts without ambiguity',()=>{
 assert.deepEqual([1,2].map(i=>splitLabel(i,2)),['上','下']);
 assert.deepEqual([1,2,3].map(i=>splitLabel(i,3)),['上','中','下']);
 assert.deepEqual([1,2,3,4].map(i=>splitLabel(i,4)),['第一部分','第二部分','第三部分','第四部分']);
 for(const [i,expected] of [[10,'第十部分'],[11,'第十一部分'],[20,'第二十部分'],[101,'第一百零一部分'],[10010,'第一万零一十部分'],[100000,'第十万部分']])assert.equal(splitLabel(i,100000),expected);
 assert.equal(splitLabel(1,1),'');assert.throws(()=>splitLabel(0,2));assert.throws(()=>splitLabel(3,2));
});
test('two and three piece plans apply the same ordered labels to both versions',()=>{
 for(const [count,labels] of [[2,['上','下']],[3,['上','中','下']]]){
  const {dir,rec,job}=fixture();try{
   rec.uploadParts={};for(const source of [rec.mp4Path(1),rec.burnOutPath(1)]){
    const parts=Array.from({length:count},(_,i)=>{const file=source+'.split-test-'+String(i).padStart(5,'0')+'.mp4';fs.writeFileSync(file,'part'+i);return {file,identity:splitIdentity(file)};});rec.uploadParts[source]={source,sourceIdentity:splitIdentity(source),parts};
   }
   const plan=makePlan(rec,job);for(const kind of ['纯享版','弹幕版'])assert.deepEqual(plan.filter(p=>p.kind===kind).map(p=>path.basename(p.destination)),labels.map(label=>`2026-10-26_测试主播_13-29-13_直播内容_${label}_${kind}.mp4`));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
});
test('new split plans keep versions, recording segments and collision handling distinct',()=>{
 const {dir,rec,job}=fixture();try{
  const source=rec.mp4Path(1),pieces=Array.from({length:4},(_,i)=>{const file=source+'.split-test-'+String(i).padStart(5,'0')+'.mp4';fs.writeFileSync(file,'piece'+i);return {file,identity:splitIdentity(file)};});
  rec.uploadParts={[source]:{source,sourceIdentity:splitIdentity(source),parts:pieces}};let plan=makePlan(rec,job);
  assert.deepEqual(plan.slice(0,4).map(p=>path.basename(p.destination)),['2026-10-26_测试主播_13-29-13_直播内容_第一部分_纯享版.mp4','2026-10-26_测试主播_13-29-13_直播内容_第二部分_纯享版.mp4','2026-10-26_测试主播_13-29-13_直播内容_第三部分_纯享版.mp4','2026-10-26_测试主播_13-29-13_直播内容_第四部分_纯享版.mp4']);
  assert.ok(plan.every(p=>isFinalVideoName(path.basename(p.destination))));fs.writeFileSync(plan[0].destination,'existing');const revised=makePlan(rec,job);assert.ok(revised.every(p=>/_2_(纯享版|弹幕版)\.mp4$/.test(p.destination)));applyPlan(rec,revised);assert.equal(fs.readFileSync(plan[0].destination,'utf8'),'existing');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a previously saved numbered publication plan remains recoverable',()=>{
 const {dir,rec,job}=fixture();try{const old=makePlan(rec,job).map(p=>({...p,destination:path.join(dir,path.basename(p.destination).replace(/_(纯享版|弹幕版)\.mp4$/,'_上传分段001_$1.mp4'))}));fs.linkSync(old[0].source,old[0].destination);assert.deepEqual(applyPlan(rec,old),old.map(p=>p.destination));assert.deepEqual(applyPlan(rec,old),old.map(p=>p.destination));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('date directories match the final names and cannot redirect publication',()=>{
 const {dir,rec,job}=fixture();try{
  const plan=makePlan(rec,job);assert.ok(plan.every(p=>path.dirname(p.destination)===path.join(dir,'2026-10-26')));
  const wrong=plan.map(p=>({...p,destination:path.join(dir,'2026-10-26凌晨',path.basename(p.destination))}));
  assert.throws(()=>applyPlan(rec,wrong),/路径无效/);assert.ok(fs.existsSync(rec.mp4Path(1)));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a linked date folder is rejected and leaves the original recordings intact',()=>{
 const {dir,rec,job}=fixture(),external=fs.mkdtempSync(path.join(os.tmpdir(),'lr-date-link-'));
 try{
  const target=path.join(dir,'2026-10-26');fs.rmdirSync(target);fs.symlinkSync(external,target,process.platform==='win32'?'junction':'dir');
  const plan=makePlan(rec,job);assert.throws(()=>applyPlan(rec,plan),/日期目录不安全/);
  assert.equal(fs.readFileSync(rec.mp4Path(1),'utf8'),'raw-video');assert.deepEqual(fs.readdirSync(external),[]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(external,{recursive:true,force:true});}
});
test('a date correction moves a dated recording to the matching new folder',()=>{
 const {dir,rec,job}=fixture();try{
  const {dateMigration}=require('../src/core/video-names');const plan=makePlan(rec,job);applyPlan(rec,plan);
  rec.base=path.join(dir,'主播_123456_20261026_235630');job.finishedAt=Date.parse('2026-10-27T02:00:00+08:00');job.publicationPlan=plan;
  const corrected=dateMigration(rec,job);assert.equal(corrected.length,2);applyPlan(rec,corrected,{renameFinal:true});
  assert.ok(corrected.every(p=>path.basename(path.dirname(p.destination))==='2026-10-27凌晨'&&fs.existsSync(p.destination)));
  fs.rmdirSync(path.join(dir,'2026-10-26'));assert.deepEqual(applyPlan(rec,corrected,{renameFinal:true}),corrected.map(p=>p.destination));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('final names contain date, streamer, recording start, topic and both version labels',()=>{
 const {dir,rec,job}=fixture();try{
  const plan=makePlan(rec,job);assert.deepEqual(plan.map(x=>path.basename(x.destination)),['2026-10-26_测试主播_13-29-13_直播内容_纯享版.mp4','2026-10-26_测试主播_13-29-13_直播内容_弹幕版.mp4']);
  const files=applyPlan(rec,plan);assert.equal(fs.readFileSync(files[0],'utf8'),'raw-video');assert.equal(fs.readFileSync(files[1],'utf8'),'caption-video');
  assert.equal(fs.existsSync(rec.mp4Path(1)),false);assert.deepEqual(videoFiles(rec,{publicationPlan:plan}),files);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('illegal characters, empty topics, long names and same-name sessions are safe',()=>{
 const {dir,rec,job}=fixture();try{
  job.nickname='主/播:*?';job.title='topic'.repeat(100);let plan=makePlan(rec,job);
  assert.ok(plan.every(x=>x.destination.length<=240));assert.ok(plan.every(x=>!/[<>:"/\\|?*]/.test(path.basename(x.destination))));
  fs.writeFileSync(plan[0].destination,'existing');const next=makePlan(rec,job);assert.ok(next.every(x=>/_2_(纯享版|弹幕版)\.mp4$/.test(x.destination)));
  applyPlan(rec,next);assert.equal(fs.readFileSync(plan[0].destination,'utf8'),'existing');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a crash after creating the destination link is idempotently recovered',()=>{
 const {dir,rec,job}=fixture();try{
  const plan=makePlan(rec,job);fs.linkSync(plan[0].source,plan[0].destination);
  assert.deepEqual(applyPlan(rec,plan),plan.map(x=>x.destination));assert.deepEqual(applyPlan(rec,plan),plan.map(x=>x.destination));
  assert.equal(fs.readdirSync(path.dirname(plan[0].destination)).length,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a destination appearing after plan creation is never overwritten',()=>{
 const {dir,rec,job}=fixture();try{
  const plan=makePlan(rec,job);fs.writeFileSync(plan[0].destination,'other-video');assert.throws(()=>applyPlan(rec,plan),/未覆盖/);
  assert.equal(fs.readFileSync(plan[0].source,'utf8'),'raw-video');assert.equal(fs.readFileSync(plan[0].destination,'utf8'),'other-video');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('an open file postpones naming without losing either version',()=>{
 const {dir,rec,job}=fixture();const unlink=fs.unlinkSync;
 try{
  const plan=makePlan(rec,job);fs.unlinkSync=file=>{if(file===rec.mp4Path(1)){const error=Error('busy');error.code='EBUSY';throw error;}return unlink(file);};
  assert.throws(()=>applyPlan(rec,plan),error=>error.code==='LR_SOURCE_BUSY');assert.equal(fs.readFileSync(rec.mp4Path(1),'utf8'),'raw-video');
  fs.unlinkSync=unlink;applyPlan(rec,plan);assert.equal(fs.readdirSync(path.dirname(plan[0].destination)).length,2);
 }finally{fs.unlinkSync=unlink;fs.rmSync(dir,{recursive:true,force:true});}
});

test('overnight recordings ending before 09:00 use the following early-morning archive date',()=>{
 const {dir,rec,job}=fixture();rec.base=path.join(dir,'主播_123456_20261026_235630');
 try{
  job.finishedAt=Date.parse('2026-10-27T04:39:22+08:00');const plan=makePlan(rec,job);
  assert.ok(plan.every(p=>path.basename(p.destination).startsWith('2026-10-27凌晨_测试主播_23-56-30_')));
  assert.ok(plan.every(p=>isFinalVideoName(path.basename(p.destination))));
  const completed=applyPlan(rec,plan);assert.equal(completed.length,2);assert.ok(completed.every(f=>fs.existsSync(f)));
  assert.ok(completed.every(f=>path.basename(path.dirname(f))==='2026-10-27凌晨'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('early-morning boundary uses Shanghai time, keeps other sessions unchanged, and handles year changes',()=>{
 const {dir,rec,job}=fixture();rec.base=path.join(dir,'主播_123456_20261026_235630');
 try{
  const dateAt=t=>{job.finishedAt=Date.parse(t);return path.basename(makePlan(rec,job)[0].destination);};
  assert.match(dateAt('2026-10-26T16:00:00Z'),/^2026-10-27凌晨_/);
  assert.match(dateAt('2026-10-27T05:59:59+08:00'),/^2026-10-27凌晨_/);
  assert.match(dateAt('2026-10-27T08:59:59+08:00'),/^2026-10-27凌晨_/);
  assert.match(dateAt('2026-10-27T09:00:00+08:00'),/^2026-10-26_/);
  assert.match(dateAt('2026-10-26T23:59:59+08:00'),/^2026-10-26_/);
  job.finishedAt=undefined;assert.match(path.basename(makePlan(rec,job)[0].destination),/^2026-10-26_/);
  rec.base=path.join(dir,'主播_123456_20261231_235630');assert.match(dateAt('2027-01-01T02:00:00+08:00'),/^2027-01-01凌晨_/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
