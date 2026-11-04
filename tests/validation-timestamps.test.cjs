const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Recorder,createFfmpegRunner}=require('../src/core/recorder');
const {packetDigest,checkSplitPart,fingerprint}=require('../src/core/upload-split');
test('full decode succeeds when only the null output has duplicate video timestamps',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-null-timestamps-')),file=path.join(dir,'video.mkv'),run=createFfmpegRunner();
 try{
  const made=await run(['-y','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=20','-t','3','-vf','setpts=floor(N/2)/(20*TB)','-fps_mode','passthrough','-c:v','libx264',file],30000);
  assert.equal(made.code,0,made.stderr);
  const original=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const baseline=await run(['-v','error','-err_detect','explode','-i',file,'-map','0:v:0','-map','0:a?','-fps_mode','passthrough','-enc_time_base:v','1:1000000','-f','null','-'],30000);
  assert.match(baseline.stderr,/non monotonically increasing dts to muxer/);
  const rec=new Recorder(file);const result=await rec.validateMedia(file,{allowDiscardTimestampRetry:true});assert.equal(result.ok,true,result.stderr);
  assert.equal((await rec.validateMedia(file)).ok,false);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),original);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('decoder errors are never suppressed by the timestamp retry',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-null-error-')),file=path.join(dir,'video');fs.writeFileSync(file,'fixture');
 try{const rec=new Recorder(file);rec._probeDuration=async()=>1;let calls=0;rec._runFfmpeg=async()=>{calls++;return {code:0,stderr:'[null @ abc] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 2 >= 2\n[h264 @ abc] corrupt decoded frame\n'};};const result=await rec.validateMedia(file,{allowDiscardTimestampRetry:true});assert.equal(result.ok,false);assert.equal(calls,1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('split validation checks packets and decodes duplicate timestamps in one pass',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-split-null-')),file=path.join(dir,'video.mkv'),run=createFfmpegRunner();
 try{
  const made=await run(['-y','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=20','-t','3','-vf','setpts=floor(N/2)/(20*TB)','-fps_mode','passthrough','-c:v','libx264',file],30000);
  assert.equal(made.code,0,made.stderr);
  const rec=new Recorder(file),baseline=await fingerprint(rec,[file]),original=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const progress=[];rec.onProgress=value=>progress.push(value);
  const wrapped=rec._runFfmpeg.bind(rec);let scans=0;rec._runFfmpeg=async(args,...rest)=>{if(args.includes('framehash')){scans++;assert.ok(args.includes('null'));}return wrapped(args,...rest);};
  const digest=packetDigest();await checkSplitPart(rec,file,digest,true,0,1);
  assert.equal(scans,1);assert.deepEqual(digest.finish(),baseline);assert.ok(progress.some(value=>value.percent>=90),JSON.stringify(progress));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),original);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
