const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{EventEmitter}=require('node:events');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lr-memory-'));process.env.LR_LOG_DIR=path.join(root,'logs');
const {createPacketHashParser,overlapCut}=require('../src/core/media');
function scan(offset,count,step=40){const p=createPacketHashParser();p.write('#tb 0: 1/1000\n');for(let i=0;i<count;i++)p.write(`0, ${i*step}, ${i*step}, ${step}, 10, hash${i+offset}\n`);return p.finish();}
test('long scans keep exact totals while retaining only bounded overlap evidence',()=>{
 const s=scan(0,100000);assert.equal(s.packetCount,100000);assert.equal(s.duration,4000);assert.ok(s.packets.length<=1502);assert.equal(s.headPackets[0].hash,'hash0');assert.equal(s.tailPackets.at(-1).hash,'hash99999');
});
test('bounded scans preserve a real overlap and decline ambiguous or truncated evidence',()=>{
 const a=scan(0,5000),b=scan(4500,700);assert.equal(overlapCut(a,b),180);
 const p=createPacketHashParser({maxEdgePackets:100});p.write('#tb 0: 1/1000\n');for(let i=0;i<10000;i++)p.write(`0, 0, 0, 40, 10, ${i}\n`);const dense=p.finish();assert.equal(dense.packetCount,10000);assert.ok(dense.packets.length<=200);assert.equal(overlapCut(dense,b),null);assert.equal(overlapCut(a,dense),null);
});
test('decoder recovery still rejects lost frames when retained evidence has the same small length',async()=>{
 const {Recorder}=require('../src/core/recorder');const rec=new Recorder(path.join(root,'counted')),source=rec.base+'.flv',output=rec.base+'.mp4';
 rec._scanVideo=async file=>({packetCount:file===source?100000:90000,packets:[{},{}],duration:4000});rec._runFfmpeg=async()=>({code:0,stderr:''});rec.validateMedia=async()=>({ok:true});rec._sizeOf=()=>100000;rec.availableBytes=()=>1024**4;
 assert.equal(await rec._recoverDecoded(source,output,'Error while decoding'),null);
});
test('startup launches a child with captured stderr and forwards protocol arguments literally',async()=>{
 const {launchLogged}=require('../src/bootstrap.cjs');let request;const p=new EventEmitter();p.pid=123;p.unref=()=>{};
 const result=launchLogged(root,'electron.exe',['douyin://test'],(exe,args,options)=>{request={exe,args,options};return p;});
 assert.deepEqual(request.args,[root,'douyin://test']);assert.equal(request.options.env.LR_STDIO_CHILD,'1');assert.equal(request.options.stdio[1],request.options.stdio[2]);assert.equal(request.options.detached,true);p.emit('spawn');assert.match(fs.readFileSync(result.logFile,'utf8'),/main pid=123/);
});
