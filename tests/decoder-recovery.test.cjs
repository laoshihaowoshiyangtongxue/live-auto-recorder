const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lr-decoder-'));
process.env.LR_LOG_DIR=path.join(root,'logs');
const {Recorder}=require('../src/core/recorder');
test('mmco and decoder submission errors enter repair and preserve loss checks',async()=>{
 for(const message of ['r submitting packet to decoder: Invalid data found when processing input','[h264] mmco: unref short failure']){
  const rec=new Recorder(path.join(root,'repair'));const pending=rec.mp4Path(1)+'.pending.mp4';let scans=0;
  rec._scanVideo=async file=>{scans++;return {packets:Array(file===pending?99:100),duration:10};};
  rec._runFfmpeg=async()=>{fs.writeFileSync(pending,Buffer.alloc(2048));return {code:0,stderr:''};};
  rec.validateMedia=async()=>({ok:true});
  const result=await rec._recoverDecoded('source.flv',pending,message);
  assert.equal(result.kind,'decode');assert.equal(scans,2);assert.equal(result.missingFrames,1);
  rec._scanVideo=async file=>({packets:Array(file===pending?50:100),duration:10});
  assert.equal(await rec._recoverDecoded('source.flv',pending,message),null);
  assert.equal(fs.existsSync(rec.mp4Path(1)),false);
 }
});
test('unrelated failures never invoke decoder repair',async()=>{
 const rec=new Recorder(path.join(root,'unrelated'));rec._scanVideo=async()=>{throw Error('must not run');};
 for(const error of ['媒体处理超时','ENOSPC','Permission denied'])assert.equal(await rec._recoverDecoded('source','pending',error),null);
});
