const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const work = path.resolve(__dirname, '../work');
fs.mkdirSync(work, { recursive: true });
const root = fs.mkdtempSync(path.join(work, 'regression-'));
process.chdir(root);
process.env.LR_LOG_DIR=path.join(root,'logs');
const http = require('node:http');
const { Recorder, createFfmpegRunner } = require('../src/core/recorder');
const { Scheduler } = require('../src/core/scheduler');
const { PostProcessor, genAss } = require('../src/core/postprocess');
const { DanmakuCapture, isHumanComment } = require('../src/core/danmaku');
const { pickBestFlv } = require('../src/core/adapter/douyin');
const { parsePacketHashes, overlapCut } = require('../src/core/media');
const { evaluateNow } = require('../src/core/page-eval');
const { inspectFlvTail } = require('../src/core/flv-tail');
const {roomDirectory,locateHistoryFile}=require('../src/core/recording-paths');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ff = createFfmpegRunner();
let source;

test('returning live after a skipped retry schedules exactly one recording restart',async()=>{
 const rec=new Recorder(path.join(root,'returning-live'));let live=false,spawns=0;
 rec.canRestart=()=>live;rec._spawn=()=>{spawns++;rec.proc={};};rec.getUrl=()=> 'https://example.test/new.flv';
 assert.equal(rec.ensureRunning(),false);live=true;assert.equal(rec.ensureRunning(),true);assert.equal(rec.ensureRunning(),false);
 await sleep(3100);assert.equal(spawns,1);assert.equal(rec.url,'https://example.test/new.flv');assert.equal(rec.ensureRunning(),false);
});
test('a stopped recording cannot restart when a delayed recovery fires',async()=>{
 const rec=new Recorder(path.join(root,'cancel-recovery'));rec.canRestart=()=>true;let spawns=0;rec._spawn=()=>spawns++;
 rec.ensureRunning();await rec.stop();await sleep(3100);assert.equal(spawns,0);
});

test('brief false offline response cannot stop a growing recording, stale data closes after confirmation',async()=>{
 const s=scheduler(),t=task();t.state='recording';t.offCount=0;t.rec={lastProgressAt:Date.now()};
 s.sess.getRoomInfo=async()=>({live:false});let stops=0;s._stopJob=async()=>{stops++;t.state='idle';};
 await s._poll(t);await s._poll(t);assert.equal(stops,0);assert.equal(t.offCount,0);
 t.rec.lastProgressAt=Date.now()-11000;await s._poll(t);assert.equal(stops,0);await s._poll(t);assert.equal(stops,1);
});

test('atomic JSON replace failure preserves previous data and cleans its temporary file',()=>{
 const {writeJson}=require('../src/util/atomic-json');const dir=fs.mkdtempSync(path.join(root,'atomic-')),file=path.join(dir,'config.json');
 writeJson(file,{version:1});const original=fs.renameSync;
 fs.renameSync=(a,b)=>{if(b===file)throw Error('simulated replace failure');return original(a,b);};
 try{assert.throws(()=>writeJson(file,{version:2},{backup:true}),/simulated/);}finally{fs.renameSync=original;}
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),{version:1});assert.deepEqual(JSON.parse(fs.readFileSync(file+'.bak')),{version:1});
 assert.equal(fs.readdirSync(dir).filter(x=>x.includes('.tmp-')).length,0);
});

function isolatedStore(name){
 const dir=fs.mkdtempSync(path.join(root,name)),vm=require('node:vm');const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../src/core/store.js'),'utf8'),{require:id=>id==='./companies'?require('../src/core/companies'):id==='./quiet-hours'?require('../src/core/quiet-hours'):id==='../util/atomic-json'?require('../src/util/atomic-json'):require(id),module,exports:module.exports,__dirname:path.join(dir,'src','core'),structuredClone,process,console});
 return {dir,store:module.exports};
}
test('new configuration saves whole sessions and retains short recordings',()=>{
 const {store}=isolatedStore('defaults-');const c=store.load();assert.equal(c.settings.segment,'0');assert.equal(c.settings.minSizeMB,0);
});
test('removed profile window cannot reappear when its delayed page load finishes',async()=>{
 const vm=require('node:vm'),{EventEmitter}=require('node:events');let release,created=0;
 class Win extends EventEmitter{constructor(){super();created++;this.dead=false;this.webContents={setAudioMuted(){}};}loadURL(){return new Promise(r=>release=r);}isDestroyed(){return this.dead;}destroy(){this.dead=true;this.emit('closed');}}
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../src/core/session.js'),'utf8'),{module,exports:module.exports,setTimeout,clearTimeout,console,require:id=>id==='electron'?{BrowserWindow:Win}:id==='../util/log'?{info(){},warn(){},error(){}}:id==='../util/const'?{sleep:async()=>{}}:id==='./page-eval'?{evaluateNow:async()=>'',releaseEvaluation(){}}:require(path.resolve(__dirname,'../src/core',id))});
 const sess=new module.exports.DouyinSession();const first=sess._profileDomScan('profile');assert.equal(sess.profileWins.size,1);
 await sess._profileDomScan('profile');assert.equal(created,1);sess.closeProfileWindow('profile');release();assert.equal(await first,'');assert.equal(sess.profileWins.size,0);
});
test('legacy segments migrate while invalid configuration fields are normalized',()=>{
 const {dir,store}=isolatedStore('legacy-');fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({watchlist:[null,3,{rid:'123456'}],settings:{segmentMin:25,pollIntervalSec:'broken',maxConcurrentRecordings:200,burnDanmaku:'false'}}));
 const c=store.load();assert.equal(c.settings.segment,'25');assert.equal(c.settings.pollIntervalSec,3);assert.equal(c.settings.maxConcurrentRecordings,20);assert.equal(c.settings.burnDanmaku,true);assert.equal(c.watchlist.length,1);
});
test('corrupt configuration restores backup to disk and survives the next load',()=>{
 const {dir,store}=isolatedStore('restore-');const file=path.join(dir,'config.json');fs.writeFileSync(file,'{broken');fs.writeFileSync(file+'.bak',JSON.stringify({watchlist:[{rid:'123456'}],settings:{segment:'0'}}));
 assert.equal(store.load().watchlist[0].rid,'123456');assert.equal(JSON.parse(fs.readFileSync(file)).watchlist[0].rid,'123456');assert.equal(store.load().watchlist.length,1);
});
test('shutdown keeps waiting for a busy comment render until it actually completes',async()=>{
 const s=scheduler();s.post.busy=true;let finished=false;const original=Date.now;let now=original();Date.now=()=>now;
 const pending=s.shutdown().then(()=>finished=true);
 try{await sleep(30);now+=16*60*1000;await sleep(2100);assert.equal(finished,false,'must not abandon a render after 15 minutes');}
 finally{s.post.busy=false;Date.now=original;await pending;}
 assert.equal(finished,true);
});
test('a disk write error in the logger is handled without crashing the application',()=>{
 const vm=require('node:vm'),{EventEmitter}=require('node:events'),stream=new EventEmitter();let output='';
 stream.write=()=>stream.emit('error',Error('simulated log disk failure'));stream.end=()=>{};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../src/util/log.js'),'utf8'),{module,exports:module.exports,require:id=>id==='node:fs'?{mkdirSync(){},createWriteStream(){return stream;}}:require(id),process:{env:{LR_LOG_DIR:path.join(root,'isolated-logs')},stderr:{write:s=>output+=s}},__dirname:path.resolve(__dirname,'../src/util'),console:{log(){}}});
 assert.doesNotThrow(()=>module.exports.info('test'));assert.match(output,/simulated log disk failure/);assert.ok(module.exports.currentLogFile().includes('isolated-logs'));
});
test('failed settings persistence does not partially apply new runtime settings',()=>{
 const s=scheduler(),store=require('../src/core/store');const original=store.save;const settings=s.cfg.settings;
 store.save=()=>{throw Error('simulated full disk');};
 try{assert.throws(()=>s.updateSettings({pollIntervalSec:1,burnDanmaku:false}),/full disk/);}finally{store.save=original;}
 assert.equal(s.cfg.settings,settings);assert.equal(s.post.s,settings);assert.equal(s.cfg.settings.burnDanmaku,undefined);
});

function scheduler() {
  const s = Object.create(Scheduler.prototype);
  s.cfg = { watchlist: [], settings: { outputDir: root, minFreeGB: 0, maxConcurrentRecordings: 2, autoPartMerge: false, minSizeMB: 0 } };
  s.tasks = new Map(); s.timers = new Map(); s.outDir = root;
  s.post = { s: s.cfg.settings, busy: false, queue: [], enqueue() {} };
  s.sess = {}; s._gate = async () => {}; s._appendHistory = () => {};
  return s;
}
function task() { return { rid: '123456', key: '123456', item: {}, state: 'idle', paused: false, recorderStartedAt: Date.now() }; }
async function command(args) {
  const r = await ff(args, 60000);
  assert.equal(r.code, 0, r.stderr);
  return r;
}
async function mediaSource() {
  if (source) return source;
  source = path.join(root, 'source.mp4');
  await command(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '12', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-c:a', 'aac', source]);
  return source;
}
async function clip(rec, part, start, duration, format = 'flv') {
  const file = format === 'flv' ? rec.flvPath(part) : rec.mp4Path(part);
  await command(['-y', '-v', 'error', '-ss', String(start), '-i', await mediaSource(), '-t', String(duration), '-c', 'copy', file]);
  return file;
}

test('one truncated comment line cannot discard the other comments or the subtitle video',async()=>{
 const rec=new Recorder(path.join(root,'partial-jsonl'));rec.part=1;rec.startedAt=1000;rec.partStarts=[0,1000];await clip(rec,1,0,2,'mp4');
 const dm=rec.base+'.danmaku.jsonl';const data=JSON.stringify({t:1200,text:'甲：完整评论'})+'\n{broken';fs.writeFileSync(dm,data);
 const post=new PostProcessor(path.join(root,'dm.ass'),{burnDanmaku:true,keepRaw:true,minSizeMB:0});await post._process({recorder:rec,danmakuFile:dm,nickname:'test',mergeComplete:true});
 assert.ok(fs.existsSync(rec.burnOutPath(1)));assert.ok(rec.notices.some(n=>n.includes('1条损坏')));assert.equal(fs.readFileSync(dm,'utf8'),data);
});
test('failed comment page startup still allows both complete video versions',async()=>{
 const rec=new Recorder(path.join(root,'missing-jsonl'));rec.part=1;rec.startedAt=1000;rec.partStarts=[0,1000];await clip(rec,1,0,2,'mp4');
 const post=new PostProcessor(path.join(root,'dm.ass'),{burnDanmaku:true,keepRaw:true,minSizeMB:0});await post._process({recorder:rec,danmakuFile:rec.base+'.danmaku.jsonl',nickname:'test',mergeComplete:true});
 assert.ok(fs.existsSync(rec.mp4Path(1)));assert.ok(fs.existsSync(rec.burnOutPath(1)));assert.ok(rec.issues.some(n=>n.includes('没有保存到弹幕')));
});

test('original quality is preferred, unknown tiers cannot displace it', () => {
  assert.equal(pickBestFlv({ _origin: 'https://x/original_or.flv', FULL_HD1: 'https://x/hd.flv' }), 'https://x/original_or.flv');
  assert.equal(pickBestFlv({ mystery: 'https://x/unknown_or.flv', FULL_HD1: 'https://x/hd.flv' }), 'https://x/hd.flv');
});
test('system likes and gifts are filtered while actual comments remain', () => {
  for (const s of ['甲：为主播点赞了', '甲:送出了玫瑰×1', '甲：来了', '系统：提醒']) assert.equal(isHumanComment(s), false, s);
  for (const s of ['甲：你好', '乙：主播今天几点下播？', '甲：这个地方很好看', '甲：送给你一首歌', '甲：来了好久才看到']) assert.equal(isHumanComment(s), true, s);
});

test('rendered comments omit usernames and preserve punctuation inside the body', () => {
  const ass = genAss([
    { vt: 0, text: '用户甲：你好，主播' },
    { vt: 1, text: '用户乙: 现在时间：20:30' },
    { vt: 2, text: '没有前缀的评论' },
    { vt: 3, text: '空白用户：   ' },
  ]);
  assert.ok(!ass.includes('用户甲') && !ass.includes('用户乙') && !ass.includes('空白用户'));
  assert.ok(ass.includes('你好，主播') && ass.includes('现在时间：20:30') && ass.includes('没有前缀的评论'));
  assert.equal(ass.split('\n').filter(line => line.startsWith('Dialogue:')).length, 3);
});
test('ambiguous repeated fingerprints do not discard static or looping content', () => {
  const packets = Array.from({ length: 20 }, (_, i) => ({ dts: i / 15, hash: 'repeated' }));
  assert.equal(overlapCut({ packets, start: 0 }, { packets, start: 0 }), null);
});
test('empty stream URL cannot leave a recording task behind', async () => {
  const s = scheduler(), t = task();
  await assert.rejects(s._startJob(t, { nickname: 'test', best: '', flv: {} }));
  assert.equal(t.state, 'idle'); assert.equal(t.rec, undefined);
});
test('I/O failure releases stopping state and reports failure', async () => {
  const s = scheduler(), t = task(); t.state = 'recording';
  t.rec = { stop: async () => {}, totalBytes: () => 0, remuxAll: async () => { throw Error('test I/O failure'); } };
  t.dm = { stop: async () => {} };
  const result = await s._stopJob(t, 'test');
  assert.equal(result.ok, false); assert.equal(t.state, 'idle'); assert.equal(t.stopping, false); assert.equal(t.rec, null);
});
test('shutdown waits for an already running stop operation', async () => {
  const s = scheduler(), t = task(); t.state = 'recording'; s.tasks.set(t.key, t);
  let release; const blocked = new Promise((r) => { release = r; });
  t.rec = { stop: async () => {}, totalBytes: () => 0, remuxAll: async () => { await blocked; return []; } }; t.dm = { stop: async () => {} };
  const stopped = s._stopJob(t, 'test'); let finished = false;
  const shutdown = s.shutdown().then(() => { finished = true; });
  await sleep(10); assert.equal(finished, false); release(); await Promise.all([stopped, shutdown]); assert.equal(finished, true);
});
test('manual stop blocks this live session until confirmed offline', async () => {
  const s = scheduler(), t = task(); t.state = 'recording'; s.tasks.set(t.key, t);
  t.rec = { stop: async () => {}, totalBytes: () => 0, remuxAll: async () => [] }; t.dm = { stop: async () => {} };
  let live = true, starts = 0; s.sess.getRoomInfo = async () => ({ live, nickname: 'test' }); s._startJob = async () => { starts++; };
  await s._stopJob(t, '界面手动停止'); await s._poll(t); assert.equal(starts, 0);
  live = false; await s._poll(t); await s._poll(t); live = true; await s._poll(t); assert.equal(starts, 1);
});
test('shutdown also waits for a removed task that is still sealing files', async () => {
  const s = scheduler(), t = task(); t.state = 'recording';
  let release; const pending = new Promise((r) => { release = r; });
  t.rec = { stop: async () => {}, totalBytes: () => 0, remuxAll: async () => { await pending; return []; } };
  t.dm = { stop: async () => {} };
  const stopped = s._stopJob(t, '从关注列表移除'); let finished = false;
  const shutdown = s.shutdown().then(() => { finished = true; });
  await sleep(10); assert.equal(finished, false); release(); await Promise.all([stopped, shutdown]);
  assert.equal(finished, true); assert.equal(s.pendingStops.size, 0);
});
test('deleted profile cannot return after an asynchronous scan', async () => {
  const s = scheduler(), t = { ...task(), rid: '', secUid: 'profile', key: 'sec:profile' };
  s.tasks.set(t.key, t); let release; s.sess._profileDomScan = () => new Promise((r) => { release = r; });
  const polled = s._poll(t); t.stop = true; s.tasks.delete(t.key); release('123456'); await polled;
  assert.deepEqual(s.cfg.watchlist, []);
});

test('profile promotion preserves the known nickname and a separate user remark', async () => {
  const s=scheduler(),t={...task(),rid:'',key:'sec:profile',secUid:'profile',item:{nickname:'已知昵称',name:'我的备注'}};
  s.cfg.watchlist=[{secUid:'profile',rid:'',nickname:'已知昵称',name:'我的备注'}];s.tasks.set(t.key,t);
  s.sess={_profileDomScan:async()=> '123456',closeProfileWindow(){},getRoomInfo:async()=>{throw Error('should not fetch a known nickname');}};
  s._applyWatchlist=()=>{};
  const store=require('../src/core/store'),save=store.save;store.save=()=>{};
  try{await s._poll(t);}finally{store.save=save;}
  assert.equal(s.cfg.watchlist[0].nickname,'已知昵称');assert.equal(s.cfg.watchlist[0].name,'我的备注');
});

test('a successful room nickname is persisted and offline responses cannot erase it', async () => {
  const s=scheduler(),t=task();s.tasks.set(t.key,t);s.cfg.watchlist=[{rid:t.rid,name:''}];
  let nickname='识别到的昵称',writes=0;s.sess.getRoomInfo=async()=>({live:false,nickname});
  const store=require('../src/core/store'),save=store.save;store.save=()=>{writes++;};
  try{await s._poll(t);nickname='';await s._poll(t);}finally{store.save=save;}
  assert.equal(writes,1);assert.equal(t.item.nickname,'识别到的昵称');assert.equal(s.cfg.watchlist[0].nickname,'识别到的昵称');
});

test('profile promotion saves before switching, preserves all metadata, and restarts in fast mode', async () => {
  const s=scheduler(),secUid='MS4wLjABAAAAabcdefghijklmno';
  const original={rid:'',secUid,name:'备注',nickname:'主播',titleFilter:'游戏',hours:'00:00-23:59',maxSec:60,companyId:'company-a'};
  const t={...task(),rid:'',secUid,key:'sec:'+secUid,item:{...original}};
  s.cfg.watchlist=[original];s.tasks.set(t.key,t);let scans=0,closed=0,saved;
  s.sess={_profileDomScan:async()=>{scans++;return '123456';},closeProfileWindow(){closed++;},getRoomInfo:async()=>({live:false,nickname:'主播'})};
  const store=require('../src/core/store'),save=store.save;
  store.save=cfg=>{assert.equal(s.tasks.get(t.key),t);assert.equal(s.cfg.watchlist[0].rid,'');saved=structuredClone(cfg);};
  try{await s._poll(t);}finally{store.save=save;for(const timer of s.timers.values())clearTimeout(timer);}
  assert.equal(t.stop,true);assert.equal(closed,1);assert.equal(s.tasks.has(t.key),false);
  assert.deepEqual(saved.watchlist,[{...original,rid:'123456'}]);
  const normal=s.tasks.get('123456');assert.ok(normal);await s._poll(normal);assert.equal(scans,1);
  const restarted=scheduler();restarted.cfg=saved;restarted.history=[];restarted._applyWatchlist();
  try{assert.equal(restarted.tasks.size,1);assert.ok(restarted.tasks.has('123456'));assert.equal(restarted.snapshot().tasks[0].secWatch,false);}
  finally{for(const timer of restarted.timers.values())clearTimeout(timer);}
});

test('failed profile promotion save retains the original config and retryable profile task', async () => {
  const s=scheduler(),original={rid:'',secUid:'profile',nickname:'主播'},t={...task(),rid:'',secUid:'profile',key:'sec:profile',item:original};
  s.cfg.watchlist=[original];s.tasks.set(t.key,t);let closes=0;
  s.sess={_profileDomScan:async()=> '123456',closeProfileWindow(){closes++;}};
  const store=require('../src/core/store'),save=store.save;store.save=()=>{throw Error('disk write failed');};
  try{await assert.rejects(s._poll(t),/disk write failed/);}finally{store.save=save;}
  assert.equal(s.cfg.watchlist[0],original);assert.equal(original.rid,'');assert.equal(s.tasks.get(t.key),t);assert.equal(t.stop,undefined);assert.equal(closes,0);
});

test('profile promotion into an existing recording keeps one task without interrupting it', async () => {
  const s=scheduler(),secUid='MS4wLjABAAAAabcdefghijklmno',existing={rid:'123456',name:'原备注'},original={rid:'',secUid,nickname:'主播',companyId:'company-a'};
  const profile={...task(),rid:'',secUid,key:'sec:'+secUid,item:original},recording={...task(),state:'recording',item:{...existing},rec:{}};
  s.cfg.watchlist=[original,existing];s.tasks.set(profile.key,profile);s.tasks.set(recording.key,recording);
  s.sess={_profileDomScan:async()=> '123456',closeProfileWindow(){}};
  const store=require('../src/core/store'),save=store.save;store.save=()=>{};
  try{await s._poll(profile);}finally{store.save=save;}
  assert.equal(s.tasks.size,1);assert.equal(s.tasks.get('123456'),recording);assert.equal(recording.state,'recording');
  assert.equal(s.cfg.watchlist.length,1);assert.equal(s.cfg.watchlist[0].name,'原备注');assert.equal(s.cfg.watchlist[0].secUid,secUid);assert.equal(s.cfg.watchlist[0].companyId,'company-a');
});
test('late danmaku window is destroyed and cannot create a stream', async () => {
  let release, destroyed = false; const pending = new Promise((r) => { release = r; });
  const dm = new DanmakuCapture({ openRoomWindow: () => pending }); const file = path.join(root, 'late');
  const started = dm.start('123456', file); await dm.stop(); release({ destroy() { destroyed = true; } }); await started;
  assert.equal(destroyed, true); assert.equal(fs.existsSync(file + '.danmaku.jsonl'), false);
});

test('page evaluation times out instead of waiting forever for a loading page', async () => {
  const wc={isDestroyed:()=>false,debugger:{isAttached:()=>true,sendCommand:()=>new Promise(()=>{})}};
  await assert.rejects(evaluateNow(wc,'1',10),/超时/);
  let attached=false;
  const owned={isDestroyed:()=>false,debugger:{isAttached:()=>attached,attach:()=>{attached=true;},detach:()=>{attached=false;},sendCommand:()=>new Promise(()=>{})}};
  await assert.rejects(evaluateNow(owned,'1',10),/超时/);
  assert.equal(attached,false);
});

test('danmaku installation recovers after a timed out command and stop cancels recovery', async () => {
  let hangs=true;
  const wc={isDestroyed:()=>false,debugger:{isAttached:()=>true,sendCommand:()=>hangs?new Promise(()=>{}):Promise.resolve({result:{value:'ok:chatroom'}})}};
  const dm=new DanmakuCapture({});dm.rid='123456';dm.win={webContents:wc,destroy(){}};dm.scriptTimeoutMs=10;
  await dm._check();assert.equal(dm.state,'retrying');assert.match(dm.error,/超时/);
  hangs=false;await dm._check();assert.equal(dm.state,'listening');
  await dm.stop();assert.equal(dm.stopped,true);assert.equal(dm.timer._destroyed,true);
});

test('a failed room open is visible and stop cancels its retry', async () => {
  const dm=new DanmakuCapture({openRoomWindow:async()=>{throw Error('测试加载失败');}});
  await dm.start('123456',path.join(root,'failed-open'));
  assert.equal(dm.state,'retrying');assert.match(dm.error,/测试加载失败/);
  await dm.stop();assert.equal(dm.timer._destroyed,true);
});

test('recovery cannot open multiple capture windows concurrently', async () => {
  let calls=0,release,destroyed=false;
  const dm=new DanmakuCapture({openRoomWindow:()=>{calls++;return new Promise(r=>{release=r;});}});
  const a=dm.start('123456',path.join(root,'one-recovery-window')),b=dm._open();
  await dm.stop();release({destroy(){destroyed=true;}});await Promise.all([a,b]);
  assert.equal(calls,1);assert.equal(destroyed,true);
});

test('a connected but silent collector reconnects with backoff instead of staying healthy forever', async () => {
  let reloads=0;
  const wc={isDestroyed:()=>false,debugger:{isAttached:()=>true,sendCommand:async(_method,args)=>{
    if(args.expression==='location.reload()'){reloads++;return {result:{}};}
    return {result:{value:'alive'}};
  }}};
  const dm=new DanmakuCapture({});dm.rid='123456';dm.openedAt=Date.now()-61000;dm.win={webContents:wc,destroy(){}};
  await dm._check();assert.equal(reloads,1);assert.equal(dm.state,'retrying');
  await dm._check();assert.equal(reloads,1);assert.equal(dm.silentRecoveries,1);
  await dm.stop();
});
test('setConfig applies directory and postprocessing settings together', () => {
  const s = scheduler(); s._applyWatchlist = () => {};
  const cfg = { watchlist: [], settings: { outputDir: path.join(root, 'new-output'), burnDanmaku: false, keepRaw: false } };
  s.setConfig(cfg); assert.equal(s.outDir, cfg.settings.outputDir); assert.equal(s.post.s, cfg.settings); assert.equal(fs.existsSync(s.outDir), true);
});

test('recording folders distinguish rooms and survive nickname changes', () => {
  const dir=path.join(root,'room-folders');
  const a=roomDirectory(dir,'123456','同名主播/测试');
  const b=roomDirectory(dir,'234567','同名主播/测试');
  assert.notEqual(a,b);assert.equal(path.dirname(a),dir);
  assert.equal(roomDirectory(dir,'123456','主播改名之后'),a);
  assert.throws(()=>roomDirectory(dir,'../bad','名字'),/房间号/);
});

test('legacy recording history resolves the classified file path', () => {
  const dir=path.join(root,'classified-history'),room=roomDirectory(dir,'123456','主播');
  fs.writeFileSync(path.join(room,'existing.mp4'),'fixture');
  assert.equal(locateHistoryFile(dir,'existing.mp4'),path.relative(dir,path.join(room,'existing.mp4')).replace(/\\/g,'/'));
  assert.equal(locateHistoryFile(dir,'missing.mp4'),'missing.mp4');
});

test('retention includes room folders and protects active, pending and backup files', () => {
  const s=scheduler();s.outDir=path.join(root,'retention');fs.mkdirSync(s.outDir);s.cfg.settings.keepDays=1;
  const room=roomDirectory(s.outDir,'123456','主播'),backup=path.join(room,'损坏原片备份');fs.mkdirSync(backup);
  const old=path.join(room,'old.mp4'),active=path.join(room,'active.danmaku.jsonl'),pending=path.join(room,'encode.pending.mp4'),raw=path.join(room,'raw.flv'),saved=path.join(backup,'saved.mp4');
  for(const file of [old,active,pending,raw,saved]){fs.writeFileSync(file,'fixture');fs.utimesSync(file,new Date(0),new Date(0));}
  s.tasks.set('123456',{rec:{base:path.join(room,'active')}});s._cleanupOld();
  assert.equal(fs.existsSync(old),false);
  for(const file of [active,pending,raw,saved])assert.equal(fs.existsSync(file),true,file);
});

test('classified recording seals raw and subtitle versions in the same room directory', async () => {
  const s=scheduler(),t=task();s.outDir=path.join(root,'classified-session');fs.mkdirSync(s.outDir);
  s.post=new PostProcessor(path.resolve('dm.ass'),{burnDanmaku:true,keepRaw:true,minSizeMB:0});
  s.cfg.settings={...s.cfg.settings,burnDanmaku:true,keepRaw:true,minSizeMB:0};
  const start=Recorder.prototype.start,dmStart=DanmakuCapture.prototype.start;
  Recorder.prototype.start=function(){this.startedAt=Date.now();this.part=1;this.partStarts=[0,this.startedAt];};
  DanmakuCapture.prototype.start=async()=>{};
  let history;s._appendHistory=entry=>{history=entry;};
  try{
    await s._startJob(t,{nickname:'分类测试主播',best:'https://example.test/live.flv',flv:{},title:'测试'});
    const rec=t.rec;await clip(rec,1,0,2);
    fs.writeFileSync(rec.base+'.danmaku.jsonl',JSON.stringify({t:rec.startedAt+100,text:'测试用户：只显示评论内容'})+'\n');
    const stopped=await s._stopJob(t,'测试封存');assert.equal(stopped.ok,true);
    while(s.post.busy)await sleep(10);
    assert.equal(path.basename(path.dirname(rec.base)),'分类测试主播_123456');
    for(const file of [rec.mp4Path(1),rec.burnOutPath(1),rec.base+'.danmaku.jsonl'])assert.equal(fs.existsSync(file),true,file);
    assert.ok(history.files[0].startsWith('分类测试主播_123456/'));
  }finally{Recorder.prototype.start=start;DanmakuCapture.prototype.start=dmStart;}
});

test('sealing and subtitle work share one status item without an idle gap', async () => {
  const pp = new PostProcessor(path.join(root, 'status.ass'), {});
  const rec = {part:1, issues:[]};
  const view = pp.begin(rec, '状态测试');
  assert.equal(pp.status.busy, true);
  rec.onStage('完整性检查'); assert.equal(pp.status.items[0].stage, '完整性检查');
  let release;
  pp._process = async () => { rec.onStage('弹幕烧录'); await new Promise(r => {release=r;}); return {}; };
  pp.enqueue({recorder:rec, nickname:'状态测试', view});
  assert.equal(pp.status.items.length, 1); assert.equal(pp.status.busy, true);
  release(); while (pp.busy) await sleep(1);
  assert.equal(pp.status.busy, false); assert.equal(view.status, 'done');
  assert.equal(rec.onStage, null);
});

test('another sealing task keeps the status busy after one task fails', () => {
  const pp = new PostProcessor(path.join(root, 'concurrent-status.ass'), {});
  const a = {part:1}, b = {part:1};
  const av = pp.begin(a, 'A'), bv = pp.begin(b, 'B');
  pp.finish(av, 'failed', '磁盘写入失败');
  assert.equal(pp.status.busy, true); assert.equal(av.error, '磁盘写入失败');
  b.onStage('转封装'); assert.equal(bv.stage, '转封装');
  pp.finish(bv, 'done'); assert.equal(pp.status.busy, false);
});

test('successful recovery is a notice rather than a failed recording', async () => {
  const s=scheduler(),t=task();t.state='recording';t.lastError='旧的分片未完成';
  let status;
  s.post.begin=()=>({});s.post.finish=(_view,value)=>{status=value;};
  t.rec={stop:async()=>{},totalBytes:()=>0,issues:[],notices:['已修复，原片已备份'],remuxAll:async()=>[]};
  t.dm={stop:async()=>{}};
  const result=await s._stopJob(t,'测试恢复');
  assert.equal(result.ok,true);assert.equal(t.lastError,'');assert.equal(t.lastNotice,'已修复，原片已备份');assert.equal(status,'recovered');
});

test('a removed task stays visible while its source is being sealed', async () => {
  const s = scheduler(), t = task(); t.state='recording'; s.tasks.set(t.key,t);
  s.post = new PostProcessor(path.join(root, 'removed-status.ass'), {});
  let release;
  t.rec={part:1, stop:async()=>{},totalBytes:()=>0,remuxAll:async()=>{
    t.rec.onStage('完整性检查'); await new Promise(r=>{release=r;});return [];
  }}; t.dm={stop:async()=>{}};
  const stopped=s._stopJob(t,'从关注列表移除'); s.tasks.delete(t.key);
  while (!release) await sleep(1);
  assert.equal(s.post.status.busy,true); assert.equal(s.post.status.items[0].stage,'完整性检查');
  release(); await stopped; assert.equal(s.post.status.busy,false);
});

test('panel counts all active stages and keeps active tasks ahead of completed history', () => {
  const vm = require('node:vm');
  const app = fs.readFileSync(path.join(__dirname,'../src/gui/app.js'),'utf8');
  const source=app.slice(app.indexOf('function overallPct('),app.indexOf("$('postBadge').onclick"));
  const element=()=>({textContent:'',hidden:false,style:{},dataset:{},children:[],setAttribute(name,value){this[name]=value;},classList:{add(){},remove(){}},appendChild(n){this.children.push(n);},append(...n){this.children.push(...n);}});
  const elements={}; const ctx={state:{post:{items:[]}},postPanelOpen:true,$:id=>elements[id]||(elements[id]=element()),document:{createElement:element},reconcile:(target,incoming)=>{target.children=incoming.children;}};
  vm.createContext(ctx); vm.runInContext(source,ctx);
  const active={name:'正在检查',status:'processing',stage:'完整性检查',partsTotal:1};
  ctx.state.post.items=[active,...Array.from({length:12},()=>({status:'done',partsTotal:1})),{status:'queued',partsTotal:1}];
  ctx.renderPost();
  assert.match(elements.postBadge.textContent,/完整性检查/); assert.match(elements.postBadge.textContent,/排队1/);
  assert.equal(elements.postItems.children[0].children[1].textContent,'正在检查');
  active.status='done';ctx.state.post.items.pop(); ctx.renderPost();
  assert.match(elements.postBadge.textContent,/后处理空闲/);
});
test('small valid fragments are preserved instead of deleted', async () => {
  const rec = new Recorder(path.join(root, 'small')); rec.part = 2;
  await clip(rec, 1, 0, 2); await clip(rec, 2, 2, 2);
  const files = await rec.remuxAll(20); assert.equal(files.length, 2);
  assert.equal(fs.existsSync(rec.flvPath(1)), true); assert.equal(fs.existsSync(rec.flvPath(2)), true);
});
test('valid remux is decoded before replacing the source', async () => {
  const rec = new Recorder(path.join(root, 'valid')); rec.part = 1; await clip(rec, 1, 0, 3);
  const files = await rec.remuxAll(0); assert.deepEqual(files, [rec.mp4Path(1)]);
  assert.equal(fs.existsSync(rec.flvPath(1)), false); assert.equal((await rec.validateMedia(rec.mp4Path(1))).ok, true);
});
test('corrupt source is retained and never published as a successful MP4', async () => {
  const rec = new Recorder(path.join(root, 'bad')); rec.part = 1; fs.writeFileSync(rec.flvPath(1), 'not valid media');
  const files = await rec.remuxAll(0); assert.deepEqual(files, [rec.flvPath(1)]);
  assert.equal(fs.existsSync(rec.flvPath(1)), true); assert.equal(fs.existsSync(rec.mp4Path(1)), false); assert.equal(rec.issues.length, 1);
});

test('a truncated final video packet is recovered only after validation and its source is archived', async () => {
  const rec=new Recorder(path.join(root,'truncated-tail'));rec.part=1;await clip(rec,1,0,3);
  const original=fs.readFileSync(rec.flvPath(1));let at=original.readUInt32BE(5)+4,last=0;
  while(at+15<=original.length){const n=original.readUIntBE(at+1,3);if(original[at]===9&&original[at+12]===1)last=at;at+=15+n;}
  const damaged=original.subarray(0,last+20);fs.writeFileSync(rec.flvPath(1),damaged);
  assert.equal(inspectFlvTail(rec.flvPath(1)).recoverable,true);
  const files=await rec.remuxAll(0);assert.deepEqual(files,[rec.mp4Path(1)]);
  assert.equal((await rec.validateMedia(files[0])).ok,true);assert.equal(rec.notices.length,1);
  assert.deepEqual(fs.readFileSync(path.join(root,'损坏原片备份',path.basename(rec.flvPath(1)))),damaged);
});

test('corruption followed by valid video is not silently trimmed away', async () => {
  const rec=new Recorder(path.join(root,'interior-damage'));rec.part=1;await clip(rec,1,0,3);
  const data=fs.readFileSync(rec.flvPath(1));let at=data.readUInt32BE(5)+4;
  while(at+20<data.length){const n=data.readUIntBE(at+1,3);if(data[at]===9&&data[at+12]===1){data.writeUInt32BE(0x7fffffff,at+16);break;}at+=15+n;}
  fs.writeFileSync(rec.flvPath(1),data);
  assert.equal(inspectFlvTail(rec.flvPath(1)).recoverable,false);
  await rec.remuxAll(0);assert.equal(rec.issues.length,1);assert.equal(fs.existsSync(rec.mp4Path(1)),false);
  assert.deepEqual(fs.readFileSync(rec.flvPath(1)),data);
});

test('damaged frame payload is rebuilt without discarding the rest of the recording', async () => {
  const rec=new Recorder(path.join(root,'damaged-picture'));rec.part=1;await clip(rec,1,0,8);
  const data=fs.readFileSync(rec.flvPath(1));let at=data.readUInt32BE(5)+4,frame=0,changed=false;
  while(at+20<data.length){const n=data.readUIntBE(at+1,3);if(data[at]===9&&data[at+12]===1){
    if(frame++===32){data.fill(0xff,at+52,Math.min(at+160,at+11+n));changed=true;break;}
  }at+=15+n;}
  assert.equal(changed,true);fs.writeFileSync(rec.flvPath(1),data);
  const files=await rec.remuxAll(0);assert.deepEqual(files,[rec.mp4Path(1)]);
  assert.equal(rec.issues.length,0);assert.ok(rec.notices.some(n=>n.includes('解码错误')));
  assert.equal((await rec.validateMedia(files[0])).ok,true);
  assert.deepEqual(fs.readFileSync(path.join(root,'损坏原片备份',path.basename(rec.flvPath(1)))),data);
});

test('a repair with substantial video loss is rejected', async () => {
  const rec=new Recorder(path.join(root,'lossy-repair'));const pending=rec.mp4Path(1)+'.pending.mp4';
  rec._scanVideo=async file=>({packets:Array(file===pending?50:100),duration:10});
  rec._runFfmpeg=async()=>{fs.writeFileSync(pending,Buffer.alloc(2048));return {code:0};};
  rec.validateMedia=async()=>({ok:true});
  assert.equal(await rec._recoverDecoded('source.flv',pending,'error while decoding'),null);
  assert.equal(fs.existsSync(rec.mp4Path(1)),false);
});

test('unavailable room closes only when both API failures and prolonged recording stall occur', () => {
  const s=scheduler(),t=task();t.state='recording';t.pollFails=2;t.rec={lastProgressAt:Date.now()};
  let stops=0;s._stopJob=async()=>{stops++;};
  s._pollError(t,Error('room gone'));assert.equal(stops,0);
  t.rec.lastProgressAt=Date.now()-91000;s._pollError(t,Error('room gone'));assert.equal(stops,1);
  t.paused=true;s._pollError(t,Error('room gone'));assert.equal(stops,1);
});
test('a failed destination replacement preserves both old destination and raw source', async () => {
  const rec = new Recorder(path.join(root, 'publish-failure')); rec.part = 1; await clip(rec, 1, 0, 2);
  fs.writeFileSync(rec.mp4Path(1), 'existing destination');
  fs.writeFileSync(rec.mp4Path(1) + '.previous', 'unrecovered backup');
  await rec.remuxAll(0);
  assert.equal(fs.existsSync(rec.flvPath(1)), true);
  assert.equal(fs.readFileSync(rec.mp4Path(1), 'utf8'), 'existing destination');
  assert.equal(fs.readFileSync(rec.mp4Path(1) + '.previous', 'utf8'), 'unrecovered backup');
});
test('failed merge preserves source files and the original segment timeline', async () => {
  const rec = new Recorder(path.join(root, 'merge-failure')); rec.part = 2; rec.partStarts = [0, 1000, 4000];
  await clip(rec, 1, 0, 2); fs.writeFileSync(rec.flvPath(2), Buffer.alloc(2048));
  assert.equal(await rec.mergeParts(), false);
  assert.equal(rec.part, 2); assert.deepEqual(rec.partStarts, [0, 1000, 4000]);
  assert.equal(rec.mergedDurations, undefined);
  assert.equal(fs.existsSync(rec.flvPath(1)), true); assert.equal(fs.existsSync(rec.flvPath(2)), true);
});
test('empty reconnect attempts do not block merging or shift subtitle segment starts', async () => {
  const rec = new Recorder(path.join(root, 'empty-reconnect')); rec.part = 4;
  rec.startedAt = 1000; rec.partStarts = [0, 1000, 4000, 5000, 9000];
  await clip(rec, 1, 0, 3); await clip(rec, 3, 3, 3);
  fs.writeFileSync(rec.flvPath(2), '');
  rec._onExit(1, 2); rec._onExit(1, 4);
  assert.equal(await rec.mergeParts(), true); assert.equal(rec.part, 1);
  assert.deepEqual(rec.mergedSegStarts, [1000, 5000]);
  assert.equal((await rec.validateMedia(rec.flvPath(1))).ok, true);
  assert.equal(fs.existsSync(rec.flvPath(3)), false);
});

test('missing untracked content is never silently omitted from a complete merge', async () => {
  const rec = new Recorder(path.join(root, 'missing-part')); rec.part = 3;
  await clip(rec, 1, 0, 2); await clip(rec, 3, 4, 2);
  assert.equal(await rec.mergeParts(), false);
  assert.equal(fs.existsSync(rec.flvPath(1)), true); assert.equal(fs.existsSync(rec.flvPath(3)), true);
});

test('an empty initial attempt publishes the valid recording as part1 and retains its start time', async () => {
  const rec = new Recorder(path.join(root, 'empty-first')); rec.part = 2;
  rec.startedAt = 1000; rec.partStarts = [0, 1000, 5000]; rec._onExit(1, 1);
  await clip(rec, 2, 0, 3);
  assert.equal(await rec.mergeParts(), true); assert.equal(rec.part, 1);
  assert.equal(rec.partStarts[1], 5000);
  assert.equal((await rec.validateMedia(rec.flvPath(1))).ok, true);
  assert.equal(fs.existsSync(rec.flvPath(2)), false);
});

test('overlapping encoded segments merge without duplicated packets', async () => {
  const rec = new Recorder(path.join(root, 'overlap')); rec.part = 2; rec.startedAt = 1000; rec.partStarts = [0, 1000, 9000];
  await clip(rec, 1, 0, 8); await clip(rec, 2, 6, 6);
  const a = await rec._scanVideo(rec.flvPath(1)), b = await rec._scanVideo(rec.flvPath(2));
  assert.notEqual(overlapCut(a, b), null, 'fixture must actually contain identical overlapping packets');
  assert.equal(await rec.mergeParts(), true); assert.equal(rec.part, 1);
  const scan = await rec._scanVideo(rec.flvPath(1));
  assert.ok(scan.duration > 11.5 && scan.duration < 12.6, 'unexpected merged duration ' + scan.duration);
  assert.ok(rec.mergedReplayOffsets[1] > 1.5); assert.equal((await rec.validateMedia(rec.flvPath(1))).ok, true);
});
test('autoPartMerge=false is respected by actual subtitle processing', async () => {
  const rec = new Recorder(path.join(root, 'no-merge')); rec.part = 2; rec.startedAt = 1000; rec.partStarts = [0, 1000, 4000];
  await clip(rec, 1, 0, 2, 'mp4'); await clip(rec, 2, 3, 2, 'mp4');
  const dm = path.join(root, 'comments.jsonl'); fs.writeFileSync(dm, '{"t":1500,"text":"甲：你好"}\n{"t":4500,"text":"乙：你好"}\n');
  // burnPartDanmaku uses the application's fixed dm.ass in cwd.
  const pp = new PostProcessor(path.resolve('dm.ass'), { autoPartMerge: false, burnDanmaku: true, keepRaw: true, minSizeMB: 0 });
  await pp._process({ recorder: rec, danmakuFile: dm, nickname: 'test' });
  assert.equal(rec.part, 2); assert.equal(fs.existsSync(rec.mp4Path(2)), true);
  assert.equal(fs.existsSync(rec.burnOutPath(1)), true); assert.equal(fs.existsSync(rec.burnOutPath(2)), true);
});

test('a session with no comments still produces raw and subtitle versions', async () => {
  const rec = new Recorder(path.join(root, 'no-comments')); rec.part = 1;
  rec.startedAt = 1000; rec.partStarts = [0, 1000];
  await clip(rec, 1, 0, 2, 'mp4');
  const dm = path.join(root, 'empty-comments.jsonl'); fs.writeFileSync(dm, '');
  const pp = new PostProcessor(path.resolve('dm.ass'), { autoPartMerge: true, burnDanmaku: true, keepRaw: true, minSizeMB: 0 });
  const result = await pp._process({ recorder: rec, danmakuFile: dm, nickname: 'test' });
  assert.equal(result.skipped, false);
  assert.equal(fs.existsSync(rec.mp4Path(1)), true);
  assert.equal((await rec.validateMedia(rec.burnOutPath(1))).ok, true);
});
test('overlap trimming preserves a stream containing B frames', async () => {
  const bSource = path.join(root, 'b-frames.mp4');
  await command(['-y', '-v', 'error', '-i', await mediaSource(), '-c:v', 'libx264', '-preset', 'veryfast',
    '-bf', '2', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-c:a', 'copy', bSource]);
  const rec = new Recorder(path.join(root, 'b-overlap')); rec.part = 2; rec.partStarts = [0, 1000, 9000];
  for (const [part, start, length] of [[1, 0, 8], [2, 6, 6]]) {
    await command(['-y', '-v', 'error', '-ss', String(start), '-i', bSource, '-t', String(length), '-c', 'copy', rec.flvPath(part)]);
  }
  assert.equal(await rec.mergeParts(), true);
  assert.equal((await rec.validateMedia(rec.flvPath(1))).ok, true);
  const scan = await rec._scanVideo(rec.flvPath(1));
  assert.ok(scan.duration < 12.9, 'overlap was not removed from B-frame input');
});
test('real stalled FFmpeg is restarted by the no-growth watchdog', async () => {
  const fixture = new Recorder(path.join(root, 'stall-fixture')); await clip(fixture, 1, 0, 2);
  const data = fs.readFileSync(fixture.flvPath(1)); const sockets = new Set();
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'video/x-flv' }); res.write(data); });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const rec = new Recorder(path.join(root, 'stall')); rec.stallTimeoutMs = 2000; rec.canRestart = () => true;
  try {
    rec.start('http://127.0.0.1:' + server.address().port + '/live');
    for (let i = 0; i < 180 && rec.part < 2; i++) await sleep(100);
    assert.ok(rec.part >= 2, 'stalled process did not restart');
  } finally {
    rec.stopped = true; for (const socket of sockets) socket.destroy(); await rec.stop(); await new Promise((r) => server.close(r));
  }
});
