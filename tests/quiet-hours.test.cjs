const {test}=require('node:test'),assert=require('node:assert/strict');
const {quietHours,validClock}=require('../src/core/quiet-hours');
const at=(h,m=0)=>new Date(2026,9,26,h,m);
test('overnight quiet interval includes its start and excludes its end',()=>{
 const settings={postQuietEnabled:true,postQuietStart:'23:00',postQuietEnd:'08:00'};
 for(const [h,m,expected] of [[22,59,false],[23,0,true],[0,0,true],[7,59,true],[8,0,false],[12,0,false]])assert.equal(quietHours(settings,at(h,m)).active,expected);
 assert.equal(quietHours(settings,at(23)).resumeAt,new Date(2026,9,27,8).getTime());
 assert.equal(quietHours(settings,at(7)).resumeAt,at(8).getTime());
});
test('same-day, disabled and invalid intervals behave consistently',()=>{
 const s={postQuietEnabled:true,postQuietStart:'12:00',postQuietEnd:'14:00'};
 assert.equal(quietHours(s,at(13)).active,true);assert.equal(quietHours(s,at(14)).active,false);
 assert.equal(quietHours({...s,postQuietEnabled:false},at(13)).active,false);
 assert.equal(quietHours({...s,postQuietEnd:'12:00'},at(13)).active,false);
 for(const text of ['24:00','09:60','7:00','garbage',''])assert.equal(validClock(text),false);
});
test('quiet queued work does not block an already-started task from finishing',async()=>{
 const {PostProcessor}=require('../src/core/postprocess');
 const post=new PostProcessor(require('node:path').join(require('node:os').tmpdir(),'quiet-queue.ass'),{}),processed=[];
 let quiet=true;post.canStart=job=>job.admitted||!quiet;
 post.onDeferred=job=>{job.view.status='quiet';};post._process=async job=>{processed.push(job.id);return {};};
 const recorder=()=>({part:1,issues:[],notices:[]});
 post.enqueue({id:'waiting',recorder:recorder()});post.enqueue({id:'started',admitted:true,recorder:recorder()});
 await new Promise(r=>setTimeout(r,10));assert.deepEqual(processed,['started']);assert.equal(post.busy,false);assert.equal(post.queue.length,1);
 quiet=false;await post._drain();assert.deepEqual(processed,['started','waiting']);assert.equal(post.queue.length,0);
});
