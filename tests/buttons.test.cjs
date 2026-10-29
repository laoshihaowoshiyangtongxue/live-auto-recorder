const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {openDirectory}=require('../src/util/open-directory');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-directory-'));
process.env.LR_LOG_DIR=path.join(dir,'logs');
test('directory opener passes the whole path as one argument without a shell',async()=>{
 const nested=path.join(dir,'中文 folder & literal');fs.mkdirSync(nested);
 let request;
 const r=await openDirectory(nested,{platform:'win32',launch:(exe,args,opts)=>{request={exe,args,opts};const p=new EventEmitter();p.unref=()=>{};queueMicrotask(()=>p.emit('spawn'));return p;}});
 assert.equal(r.ok,true);assert.deepEqual(request.args,[nested]);assert.equal(request.opts.shell,false);assert.match(request.exe,/explorer\.exe$/);assert.equal(r.path,nested);
});
test('directory opener reports missing directories, files, spawn errors and stalled launches',async()=>{
 assert.equal((await openDirectory(path.join(dir,'missing'))).ok,false);
 const file=path.join(dir,'file');fs.writeFileSync(file,'test');assert.match((await openDirectory(file)).error,/不是目录/);
 const failed=await openDirectory(dir,{platform:'win32',launch:()=>{const p=new EventEmitter();queueMicrotask(()=>p.emit('error',Error('denied')));return p;}});assert.equal(failed.ok,false);assert.match(failed.error,/denied/);
 const stalled=await openDirectory(dir,{platform:'win32',launch:()=>new EventEmitter(),timeoutMs:20});assert.match(stalled.error,/超时/);
});
test('non-Windows directory errors and timeouts return explicit failures',async()=>{
 assert.match((await openDirectory(dir,{platform:'linux',shell:{openPath:async()=> 'permission denied'}})).error,/permission denied/);
 assert.match((await openDirectory(dir,{platform:'linux',shell:{openPath:()=>new Promise(()=>{})},timeoutMs:20})).error,/超时/);
});
test('pause and resume propagate actual recorder errors rather than returning apparent success',async()=>{
 const {Scheduler}=require('../src/core/scheduler');
 const s=Object.create(Scheduler.prototype);s.cfg={settings:{quality:'highest'}};s.sess={getRoomInfo:async()=>{throw Error('offline test');}};
 const task={rid:'123456',state:'recording',paused:false,rec:{pause:async()=>{throw Error('pause test');}},lastInfo:{}};
 assert.match((await s._pauseJob(task)).error,/pause test/);assert.equal(task.paused,false);
 task.paused=true;assert.match((await s._resumeJob(task)).error,/offline test/);assert.equal(task.paused,true);
 s.sess.getRoomInfo=async()=>({live:false});assert.match((await s._resumeJob(task)).error,/已下播/);
});
test('recording browser lists rooms, labels playable media, and blocks escapes or executable files',async()=>{
 const {listRecordings,recordingPath,openRecording}=require('../src/util/recording-browser');
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'lr-browser-'));fs.mkdirSync(path.join(base,'主播'));fs.writeFileSync(path.join(base,'主播','录像.mp4'),'media');fs.writeFileSync(path.join(base,'run.exe'),'executable');
 const root=await listRecordings(base);assert.equal(root.entries[0].directory,true);assert.equal(root.entries.find(e=>e.name==='run.exe').playable,false);
 const room=await listRecordings(base,'主播');assert.equal(room.entries[0].playable,true);assert.equal(room.relative,'主播');
 await assert.rejects(recordingPath(base,'..'),/只能浏览/);
 await assert.rejects(openRecording(base,'run.exe',{}),/视频文件/);
 assert.equal((await openRecording(base,'主播/录像.mp4',{openPath:async()=>''})).ok,true);
 await assert.rejects(openRecording(base,'主播/录像.mp4',{openPath:async()=>'no player'}),/no player/);
 await assert.rejects(openRecording(base,'主播/录像.mp4',{openPath:()=>new Promise(()=>{})},20),/超时/);
});
test('failed login-page load closes its window and returns the actual error',async()=>{
 const vm=require('node:vm');let destroyed=false;
 class Window {loadURL(){return Promise.reject(Error('login network failure'));}isDestroyed(){return destroyed;}destroy(){destroyed=true;}}
 const m={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/core/session.js'),'utf8'),{module:m,exports:m.exports,setTimeout,clearTimeout,require:id=>{
   if(id==='electron')return {BrowserWindow:Window};
   if(id==='../util/log')return {info(){},warn(){},error(){}};
   if(id==='../util/const')return {sleep:async()=>{}};
   if(id==='./adapter/douyin'||id==='./page-eval')return {};
   if(id==='./background-page')return {guardBackgroundPage(){}};
   throw Error(id);
 }});
 const session=new m.exports.DouyinSession();session.ensure=async()=>{};
 await assert.rejects(session.openLoginWindow(),/login network failure/);assert.equal(destroyed,true);
});
