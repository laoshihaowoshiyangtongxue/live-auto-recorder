const test=require('node:test'),assert=require('node:assert/strict');
const {Scheduler,nextPollDelay}=require('../src/core/scheduler');
const {normalizeEnter}=require('../src/core/adapter/douyin');
test('time spent waiting for the gate and request is included in the polling interval',()=>{
 assert.equal(nextPollDelay({baseMs:2000,elapsedMs:0,wobble:20,failures:0}),2000);
 assert.equal(nextPollDelay({baseMs:2000,elapsedMs:1200,wobble:20,failures:0}),800);
 assert.equal(nextPollDelay({baseMs:2000,elapsedMs:5000,wobble:20,failures:0}),250);
 assert.equal(nextPollDelay({baseMs:2000,elapsedMs:5000,wobble:20,failures:3}),6250);
 assert.equal(nextPollDelay({baseMs:2000,elapsedMs:100,wobble:20,failures:0,confirmOffline:true}),1000);
 assert.equal(nextPollDelay({baseMs:2000,elapsedMs:100,wobble:20,failures:1,confirmOffline:true}),3900);
});
test('adding a room does not wait for the size of the existing watchlist',()=>{
 const s=Object.create(Scheduler.prototype);s.cfg={watchlist:[]};s.tasks=new Map();s.timers=new Map();s.sess={};s.stopped=false;
 for(let i=0;i<10;i++){const rid=String(100000+i),item={rid};s.cfg.watchlist.push(item);s.tasks.set(rid,{rid,key:rid,item:{},monitorPaused:false});}
 s.cfg.watchlist.push({rid:'200001'},{rid:'200002'});const scheduled=[],native=global.setTimeout;
 global.setTimeout=(fn,ms)=>{const t={fn,ms,unref(){}};scheduled.push(t);return t;};
 try{s._applyWatchlist();assert.deepEqual(scheduled.map(t=>t.ms),[0,400]);}finally{global.setTimeout=native;}
});
test('invalid room status never turns into a false offline response',()=>{
 for(const json of [{},{data:{}},{data:{data:[{}]}},{data:{data:[{status:null}]}},{data:{data:[{status:0}]}}])assert.throws(()=>normalizeEnter(json,'123456'),/状态缺失或无效/);
 assert.equal(normalizeEnter({data:{data:[{status:2}]}},'123456').live,true);assert.equal(normalizeEnter({data:{data:[{status:4}]}},'123456').live,false);
});
test('a network failure clears the offline confirmation and does not stop a growing recording',()=>{
 const s=Object.create(Scheduler.prototype);s.stopped=false;s.networkBackoff=null;s._stopJob=()=>{throw Error('must not stop');};
 const task={rid:'123456',state:'recording',paused:false,pollFails:0,offCount:1,rec:{lastProgressAt:Date.now()}};s._pollError(task,Error('network down'));assert.equal(task.offCount,0);assert.equal(task.pollFails,1);
});
test('a new recording packet between offline responses cancels the stop',async()=>{
 const s=Object.create(Scheduler.prototype);s.stopped=false;s.cfg={settings:{}};s._gate=async()=>{};s.sess={getRoomInfo:async()=>({live:false})};let stops=0;s._stopJob=async()=>{stops++;};
 const task={rid:'123456',item:{},state:'recording',paused:false,offCount:0,rec:{lastProgressAt:Date.now()-11000}};
 await s._poll(task);assert.equal(task.offCount,1);task.rec.lastProgressAt=Date.now();await s._poll(task);assert.equal(task.offCount,0);assert.equal(stops,0);
});
test('offline recheck uses the existing loop and a removed task cannot schedule another poll',async()=>{
 const s=Object.create(Scheduler.prototype),task={rid:'123456',key:'123456',state:'recording',paused:false,offCount:1,pollFails:0};s.stopped=false;s.cfg={settings:{pollIntervalSec:2}};s.tasks=new Map([[task.key,task]]);s.timers=new Map();let resolve,calls=0;
 s._poll=()=>{calls++;return new Promise(r=>resolve=r);};const scheduled=[],native=global.setTimeout;global.setTimeout=(fn,ms)=>{const t={fn,ms,unref(){}};scheduled.push(t);return t;};
 try{s._loop(task);assert.equal(calls,1);resolve();await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(scheduled[0].ms,1000);
  scheduled.length=0;s._loop(task);assert.equal(calls,2);s.tasks.delete(task.key);resolve();await new Promise(r=>setImmediate(r));assert.equal(scheduled.length,0);
 }finally{global.setTimeout=native;}
});
