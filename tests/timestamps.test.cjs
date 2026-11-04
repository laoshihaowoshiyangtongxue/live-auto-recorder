const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Recorder,createFfmpegRunner}=require('../src/core/recorder');
const {fingerprint,compareTimelines}=require('../src/core/upload-split');
test('timestamp-only repair copies all audio and video packets without re-encoding',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-timestamp-copy-'));try{
  const rec=new Recorder(path.join(dir,'capture'));rec.settings={minFreeGB:0};const src=rec.flvPath(1),pending=rec.mp4Path(1)+'.pending.mp4',run=createFfmpegRunner();
  const made=await run(['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=20','-f','lavfi','-i','sine=frequency=440','-t','4','-c:v','libx264','-c:a','aac','-f','flv',src],30000);assert.equal(made.code,0,made.stderr);
  const input=await fingerprint(rec,[src]);fs.writeFileSync(pending,'old pending');let scans=0;const runMedia=rec._runFfmpeg.bind(rec);rec._runFfmpeg=async(args,...rest)=>{if(args.includes('framehash'))scans++;return runMedia(args,...rest);};
  const result=await rec._recoverTimestamps(src,pending,'[null @ abc] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 2 >= 2');
  assert.equal(result?.kind,'timestamps');assert.equal(scans,2,'packet and timing checks each read the source and output once');assert.deepEqual(await fingerprint(rec,[pending]),input);assert.equal((await rec.validateMedia(pending)).ok,true);assert.ok(fs.existsSync(src));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('combined packet and timeline check rejects changed video even with identical timestamps',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-packet-check-'));try{
  const rec=new Recorder(path.join(dir,'clip')),src=rec.mp4Path(1),out=path.join(dir,'different.mp4'),run=createFfmpegRunner();
  for(const [file,filter] of [[src,'null'],[out,'negate']]){const r=await run(['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=20','-t','4','-vf',filter,'-c:v','libx264','-bf','0',file],30000);assert.equal(r.code,0,r.stderr);}
  assert.equal(await compareTimelines(rec,src,out),true);await assert.rejects(compareTimelines(rec,src,out,{comparePackets:true}),/数据包不一致/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('timestamp repair refuses to conceal decoder errors',async()=>{
 const rec=new Recorder(path.join(os.tmpdir(),'lr-no-copy-repair'));rec._runFfmpeg=async()=>{throw Error('must not run');};
 assert.equal(await rec._recoverTimestamps('source','pending','[null @ abc] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 2 >= 2\n[h264 @ abc] corrupt decoded frame'),null);
});
test('packet-copy checks reject a shifted audio timeline even when media bytes match',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-sync-check-'));try{
  const rec=new Recorder(path.join(dir,'clip')),src=rec.mp4Path(1),out=path.join(dir,'shifted.mp4'),run=createFfmpegRunner();
  let r=await run(['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=20','-f','lavfi','-i','sine=frequency=440','-t','4','-c:v','libx264','-c:a','aac',src],30000);assert.equal(r.code,0,r.stderr);
  r=await run(['-y','-v','error','-i',src,'-itsoffset','0.3','-i',src,'-map','0:v:0','-map','1:a:0','-c','copy',out],30000);assert.equal(r.code,0,r.stderr);
  assert.deepEqual(await fingerprint(rec,[src]),await fingerprint(rec,[out]));await assert.rejects(compareTimelines(rec,src,out),/时间戳核对失败|播放时间/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('the comment-free path rejects even small audio timing shifts',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-small-sync-'));try{
  const rec=new Recorder(path.join(dir,'clip')),src=rec.mp4Path(1),out=path.join(dir,'shifted.mp4'),run=createFfmpegRunner();
  let r=await run(['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=20','-f','lavfi','-i','sine=frequency=440','-t','4','-c:v','libx264','-c:a','aac',src],30000);assert.equal(r.code,0,r.stderr);
  r=await run(['-y','-v','error','-i',src,'-itsoffset','0.01','-i',src,'-map','0:v:0','-map','1:a:0','-c','copy',out],30000);assert.equal(r.code,0,r.stderr);
  assert.equal(await compareTimelines(rec,src,out,{comparePackets:true}),true);
  await assert.rejects(compareTimelines(rec,src,out,{comparePackets:true,maxTimeDelta:0.001}),/时间戳核对失败|播放时间/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('merge can repair a timestamp-only validation failure without dropping packets',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-merge-times-'));try{
  const rec=new Recorder(path.join(dir,'capture')),run=createFfmpegRunner();rec.part=2;rec.startedAt=Date.now();rec.partStarts=[0,rec.startedAt,rec.startedAt+4000];rec.settings={minFreeGB:0};
  for(let i=1;i<=2;i++){const made=await run(['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=20','-f','lavfi','-i',`sine=frequency=${400+i*100}`,'-t','4','-vf',i===1?'null':'negate','-c:v','libx264','-c:a','aac',rec.mp4Path(i)],30000);assert.equal(made.code,0,made.stderr);}
  const expected=await fingerprint(rec,[rec.mp4Path(1),rec.mp4Path(2)]),validate=rec.validateMedia.bind(rec);let simulated=false;
  rec.validateMedia=async(file,...args)=>{if(file.endsWith('.pending.mp4')&&!simulated){simulated=true;return {ok:false,stderr:'[null @ abc] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 2 >= 2'};}return validate(file,...args);};
  assert.equal(await rec.consolidateMp4s(),true);assert.ok(simulated);const actual=await fingerprint(rec,[rec.mp4Path(1)]);assert.equal(actual['0'].count,expected['0'].count);assert.deepEqual(actual['1'],expected['1']);assert.ok(rec.notices.some(x=>x.includes('无损修复时间戳')));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a rejected timestamp repair leaves every original segment untouched',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-merge-refuse-'));try{
  const rec=new Recorder(path.join(dir,'capture')),run=createFfmpegRunner();rec.part=2;rec.startedAt=Date.now();rec.partStarts=[0,rec.startedAt,rec.startedAt+2000];rec.settings={minFreeGB:0};
  for(let i=1;i<=2;i++){const made=await run(['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=20','-t','2','-vf',i===1?'null':'negate','-c:v','libx264',rec.mp4Path(i)],30000);assert.equal(made.code,0,made.stderr);}
  const before=[1,2].map(i=>fs.readFileSync(rec.mp4Path(i)));rec.validateMedia=async()=>({ok:false,stderr:'[null @ abc] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 2 >= 2'});rec._recoverTimestamps=async()=>null;
  assert.equal(await rec.consolidateMp4s(),false);assert.equal(rec.part,2);for(let i=1;i<=2;i++)assert.deepEqual(fs.readFileSync(rec.mp4Path(i)),before[i-1]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
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
    assert.ok(fs.statSync(files[0]).size<bytes.length*1.8,'controlled-bitrate repair should not greatly inflate this fixture');
    assert.equal((await rec._scanVideo(files[0])).packets.length,count);
    assert.deepEqual(fs.readFileSync(path.join(dir,'损坏原片备份','capture_part1.flv')),bytes);
    assert.equal(rec.issues.length,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
