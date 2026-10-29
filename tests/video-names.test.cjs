const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {makePlan,applyPlan,videoFiles,isFinalVideoName}=require('../src/core/video-names');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-video-names-'));
 const base=path.join(dir,'主播_123456_20261026_132913');
 const rec={base,part:1,mp4Path:i=>base+'_part'+i+'.mp4',burnOutPath:i=>base+'_part'+i+'_弹幕版.mp4'};
 fs.writeFileSync(rec.mp4Path(1),'raw-video');fs.writeFileSync(rec.burnOutPath(1),'caption-video');
 return {dir,rec,job:{nickname:'测试主播',title:'直播内容'}};
}
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
  assert.equal(fs.readdirSync(dir).length,2);
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
  fs.unlinkSync=unlink;applyPlan(rec,plan);assert.equal(fs.readdirSync(dir).length,2);
 }finally{fs.unlinkSync=unlink;fs.rmSync(dir,{recursive:true,force:true});}
});

test('overnight recordings ending before 09:00 use the following early-morning archive date',()=>{
 const {dir,rec,job}=fixture();rec.base=path.join(dir,'主播_123456_20261026_235630');
 try{
  job.finishedAt=Date.parse('2026-10-27T04:39:22+08:00');const plan=makePlan(rec,job);
  assert.ok(plan.every(p=>path.basename(p.destination).startsWith('2026-10-27凌晨_测试主播_23-56-30_')));
  assert.ok(plan.every(p=>isFinalVideoName(path.basename(p.destination))));
  const completed=applyPlan(rec,plan);assert.equal(completed.length,2);assert.ok(completed.every(f=>fs.existsSync(f)));
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
