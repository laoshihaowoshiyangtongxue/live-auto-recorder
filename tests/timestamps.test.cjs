const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Recorder,createFfmpegRunner}=require('../src/core/recorder');
test('backward video presentation timestamps are repaired with all frames and source retained',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-timestamps-'));
  try {
    const rec=new Recorder(path.join(dir,'capture'));rec.part=1;rec.settings={minFreeGB:0};
    const run=createFfmpegRunner();let r=await run(['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=30','-f','lavfi','-i','sine=frequency=440','-t','8','-c:v','libx264','-preset','veryfast','-c:a','aac','-f','flv',rec.flvPath(1)],15000);
    assert.equal(r.code,0,r.stderr);
    const bytes=fs.readFileSync(rec.flvPath(1));let at=bytes.readUInt32BE(5)+4,frame=0;
    while(at+20<bytes.length){const n=bytes.readUIntBE(at+1,3);
      if(bytes[at]===9&&bytes[at+12]===1&&frame++>=90){
        const stamp=bytes.readUIntBE(at+4,3)+bytes[at+7]*16777216;
        const changed=Math.max(0,stamp-500);bytes.writeUIntBE(changed%16777216,at+4,3);bytes[at+7]=Math.floor(changed/16777216);
      }
      at+=15+n;
    }
    fs.writeFileSync(rec.flvPath(1),bytes);
    const before=await rec.validateMedia(rec.flvPath(1));assert.equal(before.ok,false);assert.match(before.stderr,/non.monoton/i);
    const count=(await rec._scanVideo(rec.flvPath(1))).packets.length;
    const files=await rec.remuxAll(0);assert.deepEqual(files,[rec.mp4Path(1)],rec.issues.join(';'));
    assert.equal((await rec.validateMedia(files[0])).ok,true);
    assert.equal((await rec._scanVideo(files[0])).packets.length,count);
    assert.deepEqual(fs.readFileSync(path.join(dir,'损坏原片备份','capture_part1.flv')),bytes);
    assert.equal(rec.issues.length,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
