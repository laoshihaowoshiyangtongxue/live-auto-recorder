const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{EventEmitter}=require('node:events'),{createRequire}=require('node:module');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lr-speed-'));process.env.LR_LOG_DIR=path.join(root,'logs');
const {createPacketHashParser,parsePacketHashes}=require('../src/core/media'),{Recorder}=require('../src/core/recorder');
const packetText='#tb 0: 1/1000\n0, 0, 20, 40, 123, abc\r\n0, 40, 60, 40, 123, def\n';
test('streamed packet parsing retains exact timestamps, hashes and chunk boundaries',()=>{
 const expected=parsePacketHashes(packetText);
 for(const step of [1,2,7,41]){const parser=createPacketHashParser();for(let at=0;at<packetText.length;at+=step)parser.write(Buffer.from(packetText.slice(at,at+step)));assert.deepEqual(parser.finish(),expected);}
 assert.equal(expected.duration,.1);assert.equal(expected.packets.length,2);
 assert.throws(()=>createPacketHashParser().finish(),/时间基/);
 const parser=createPacketHashParser();assert.throws(()=>parser.write('x'.repeat(131073)),/过长/);
});
test('streamed scans can exceed 64 MiB without retaining the raw output or killing FFmpeg',async()=>{
 let kills=0,total=0;
 function fakeSpawn(){const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>kills++;
  queueMicrotask(()=>{const chunk=Buffer.alloc(1024*1024,35);for(let i=0;i<66;i++)child.stdout.emit('data',chunk);child.emit('close',0,null);});return child;
 }
 const file=path.resolve(__dirname,'../src/core/media-execution.js'),localRequire=createRequire(file),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:id=>id==='node:child_process'?{spawn:fakeSpawn}:localRequire(id),module,exports:module.exports,process,console,Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
 const rec=new Recorder(path.join(root,'streamed'));
 const execute=(args,timeout,capture)=>new module.exports.MediaExecution(rec,args,timeout,capture,0,'fake').run();
 const result=await execute(['-i','fixture','-f','framehash','-'],5000,chunk=>{total+=chunk.length;});
 assert.equal(total,66*1024*1024);assert.equal(kills,0);assert.equal(result.code,0);assert.equal(result.stdout,'');
 assert.equal(rec._activeProc,null,'completed processes release their reference');
 rec._userAbort=true;
 const aborted=await rec._runFfmpeg(['-i','fixture','-f','null','-'],5000);
 assert.equal(aborted.aborted,true);assert.equal(kills,0);
 rec._userAbort=false;
 const error=await execute(['-i','fixture','-f','framehash','-'],5000,()=>{throw Error('parse test');});
 assert.equal(error.code,-1);assert.match(error.stderr,/parse test/);
});

