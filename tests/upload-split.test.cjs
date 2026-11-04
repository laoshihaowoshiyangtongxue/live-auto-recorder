const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'lr-upload-'));process.env.LR_LOG_DIR=path.join(root,'logs');const {Recorder,createFfmpegRunner}=require('../src/core/recorder'),{splitFile,splitRecorder,fingerprint,packetDigest,checkSplitPart}=require('../src/core/upload-split'),{makePlan,applyPlan}=require('../src/core/video-names'),{JobStore,restoreRecorder}=require('../src/core/job-store');
test('the upload limit is 16 decimal GB, with published parts strictly below it',()=>{assert.equal(require('../src/core/upload-split').LIMIT,16000000000);});
test('variable bitrate moves cuts by observed bytes instead of doubling the number of pieces',()=>{
 const {balancedCuts}=require('../src/core/upload-split');const dir=fs.mkdtempSync(path.join(root,'balance-'));
 try{const files=[10,10,16].map((size,i)=>{const f=path.join(dir,String(i));fs.writeFileSync(f,Buffer.alloc(size));return f;});
  assert.deepEqual(balancedCuts(files,[{start:0,end:10},{start:10,end:20},{start:20,end:30}],3,30),[12,22.5]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
async function sample(name){const rec=new Recorder(path.join(root,name+'_123456_20261029_110000'));rec.part=1;rec.partStarts=[0,Date.now()];rec.startedAt=rec.partStarts[1];rec.settings={};rec.assertSpace=()=>{};const ff=createFfmpegRunner(),r=await ff(['-y','-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=20','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','8','-c:v','libx264','-g','20','-c:a','aac',rec.mp4Path(1)],30000);assert.equal(r.code,0,r.stderr);return rec;}
test('real variable-bitrate video is redistributed into three safe parts',async()=>{
 const rec=new Recorder(path.join(root,'variable_123456_20261029_110000'));rec.part=1;rec.partStarts=[0,Date.now()];rec.startedAt=rec.partStarts[1];rec.settings={};rec.assertSpace=()=>{};
 const ff=createFfmpegRunner(),src=rec.mp4Path(1),r=await ff(['-y','-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=20','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','12','-vf',"noise=alls=50:allf=t:enable='gte(t,8)'",'-c:v','libx264','-g','10','-c:a','aac',src],30000);
 assert.equal(r.code,0,r.stderr);const size=fs.statSync(src).size,cap=Math.ceil(size/3*1.23),run=rec._runFfmpeg.bind(rec);let attempts=0;
 rec._runFfmpeg=async(args,...rest)=>{if(args.includes('segment'))attempts++;return run(args,...rest)};
 const result=await splitFile(rec,src,cap);assert.equal(result.parts.length,3);assert.ok(attempts>1,'uneven source must exercise adaptive cuts');assert.ok(result.parts.every(p=>fs.statSync(p.file).size<cap));
});
test('actual media splits below cap without losing video or audio packets and publishes ordered files',async()=>{const rec=await sample('stream'),src=rec.mp4Path(1),before=await fingerprint(rec,[src]),store=new JobStore(path.join(root,'jobs.json'));store.set(rec,{status:'processing',phase:'post',nickname:'测试',finishedAt:Date.now()});rec.onCheckpoint=()=>{store.set(rec);return !store.error};await splitRecorder(rec,100000);const info=rec.uploadParts[src];assert.ok(info.parts.length>1);assert.ok(info.parts.every(p=>fs.statSync(p.file).size<100000));assert.deepEqual(await fingerprint(rec,info.parts.map(p=>p.file)),before);assert.ok(fs.existsSync(src));const reloaded=restoreRecorder(new JobStore(store.file).get(rec.jobId),Recorder);const plan=makePlan(reloaded,{nickname:'测试',title:'样本'});assert.equal(plan.length,info.parts.length);assert.match(plan[0].destination,info.parts.length<=3?/_上_纯享版/:/_第一部分_纯享版/);applyPlan(rec,plan);assert.ok(plan.every(p=>fs.existsSync(p.destination)));assert.ok(fs.existsSync(src));assert.deepEqual(await fingerprint(rec,plan.map(x=>x.destination)),before);});
test('a size that cannot fit even one GOP fails safely and keeps the source',async()=>{const rec=await sample('oversizedgop'),src=rec.mp4Path(1);await assert.rejects(splitFile(rec,src,100),/关键帧间隔过大/);assert.ok(fs.existsSync(src));assert.equal(fs.readdirSync(root).filter(n=>n.startsWith(path.basename(src)+'.split-')).length,0);});
test('small completed videos stay untouched',async()=>{const rec=await sample('small'),src=rec.mp4Path(1);assert.equal(await splitFile(rec,src,10000000),null);assert.ok(fs.existsSync(src));});
test('metadata-only changes during split validation trigger a fresh packet comparison',async()=>{
 const rec=await sample('metadata'),src=rec.mp4Path(1),stat=fs.statSync,run=rec._runFfmpeg.bind(rec);let changed=false,scans=0;
 fs.statSync=function(file,options){const s=stat.apply(this,arguments);if(changed&&options?.bigint&&typeof file==='string'&&file.startsWith(src)){const copy=Object.create(s);Object.defineProperty(copy,'ctimeNs',{value:s.ctimeNs+1n});return copy;}return s;};
 rec._runFfmpeg=async(args,...rest)=>{if(args.includes('framehash'))scans++;if(args.includes('null'))changed=true;return run(args,...rest);};
 try{const result=await splitFile(rec,src,100000);assert.ok(result.parts.length>1);assert.ok(scans>=2*(result.parts.length+1));assert.ok(fs.existsSync(src));}finally{fs.statSync=stat;}
});
test('actual changes to a split during validation still fail safely',async()=>{
 const rec=await sample('modified'),src=rec.mp4Path(1),run=rec._runFfmpeg.bind(rec);let modified=false;
 rec._runFfmpeg=async(args,...rest)=>{const result=await run(args,...rest);if(args.includes('null')&&!modified){fs.appendFileSync(args[args.indexOf('-i')+1],'changed');modified=true;}return result;};
 await assert.rejects(splitFile(rec,src,100000),/录像发生变化/);assert.ok(fs.existsSync(src));
 assert.ok(rec.uploadSplitWork[src].parts.every(p=>fs.existsSync(p.file)),'saved temporary parts remain available for diagnosis');
});

test('retry after interruption reuses the split and already decoded parts',async()=>{
 const rec=await sample('resume'),src=rec.mp4Path(1),store=new JobStore(path.join(root,'resume-jobs.json'));
 store.set(rec,{status:'processing',phase:'post'});rec.onCheckpoint=()=>{store.set(rec);return !store.error};
 const run=rec._runFfmpeg.bind(rec);let decoded=0;
 rec._runFfmpeg=async(args,...rest)=>{if(args.includes('null')&&++decoded===2)throw Error('模拟中断');return run(args,...rest);};
 await assert.rejects(splitRecorder(rec,100000),/模拟中断/);
 const saved=store.get(rec.jobId).recorder.uploadSplitWork[src];assert.ok(saved.parts.length>1);
 assert.ok(saved.parts[0].verifiedIdentity);assert.ok(saved.parts.every(p=>fs.existsSync(p.file)));
 const restored=restoreRecorder(new JobStore(store.file).get(rec.jobId),Recorder);restored.assertSpace=()=>{};restored.onCheckpoint=()=>{store.set(restored);return !store.error};
 const resumedRun=restored._runFfmpeg.bind(restored);let splits=0,decodeCalls=0;
 restored._runFfmpeg=async(args,...rest)=>{if(args.includes('segment'))splits++;if(args.includes('null'))decodeCalls++;return resumedRun(args,...rest);};
 await splitRecorder(restored,100000);
 assert.equal(splits,0,'previously written files are not recreated');assert.equal(decodeCalls,saved.parts.length-1,'only unchecked parts are decoded');
 assert.deepEqual(await fingerprint(restored,restored.uploadParts[src].parts.map(p=>p.file)),await fingerprint(restored,[src]));
 assert.equal(restored.uploadSplitWork[src],undefined);
});

test('unstable metadata keeps checked parts and can resume once stable',async()=>{
 const rec=await sample('changing-metadata'),src=rec.mp4Path(1),stat=fs.statSync,run=rec._runFfmpeg.bind(rec);let changed=false,tick=0n;
 fs.statSync=function(file,options){const s=stat.apply(this,arguments);if(changed&&options?.bigint&&typeof file==='string'&&file.startsWith(src)){const copy=Object.create(s);Object.defineProperty(copy,'ctimeNs',{value:s.ctimeNs+(++tick)});return copy;}return s;};
 rec._runFfmpeg=async(args,...rest)=>{if(args.includes('null'))changed=true;return run(args,...rest);};
 try{await assert.rejects(splitFile(rec,src,100000),/属性持续变化/);assert.ok(rec.uploadSplitWork[src].parts.every(p=>fs.existsSync(p.file)));}
 finally{fs.statSync=stat;}
 const files=rec.uploadSplitWork[src].parts.map(p=>p.file);let splits=0;rec._runFfmpeg=async(args,...rest)=>{if(args.includes('segment'))splits++;return run(args,...rest);};
 const result=await splitFile(rec,src,100000);assert.equal(splits,0);assert.deepEqual(result.parts.map(p=>p.file),files);
});

test('a corrupt split is retained but marked for a fresh split on retry',async()=>{
 const rec=await sample('corrupt-retry'),src=rec.mp4Path(1),run=rec._runFfmpeg.bind(rec);let failed=false;
 rec._runFfmpeg=async(args,...rest)=>{if(args.includes('null')&&!failed){failed=true;return {code:0,stderr:'[h264 @ abc] corrupt decoded frame'};}return run(args,...rest);};
 await assert.rejects(splitFile(rec,src,100000),/无法完整解码/);
 const old=rec.uploadSplitWork[src];assert.equal(old.invalid,true);assert.ok(old.parts.every(p=>fs.existsSync(p.file)));
 const result=await splitFile(rec,src,100000);assert.notEqual(result.parts[0].file,old.parts[0].file);assert.ok(fs.existsSync(src));
});

test('combined validation rejects genuinely damaged encoded video',async()=>{
 const rec=await sample('real-corruption'),src=rec.mp4Path(1),bytes=fs.readFileSync(src),at=bytes.indexOf(Buffer.from('mdat'));
 assert.ok(at>0&&bytes.length>at+60000);bytes.fill(255,at+5000,at+50000);fs.writeFileSync(src,bytes);
 await assert.rejects(checkSplitPart(rec,src,packetDigest(),true,0,1),/无法完整解码/);
});

test('packet mismatch invalidates the split rather than publishing it',async()=>{
 const rec=await sample('packet-mismatch'),src=rec.mp4Path(1),run=rec._runFfmpeg.bind(rec);
 rec._runFfmpeg=async(args,...rest)=>{const result=await run(args,...rest);if(args.includes('segment'))rest[1](Buffer.from('0,0,0,0,1,'+'a'.repeat(64)+'\n'));return result;};
 await assert.rejects(splitRecorder(rec,100000),/音视频数据不一致/);
 assert.equal(rec.uploadParts[src],undefined);assert.equal(rec.uploadSplitWork[src].invalid,true);assert.ok(fs.existsSync(src));
});

test('published split moves the original safely to a backup and can recover a half-finished archive',async()=>{const {makeArchivePlan,applyArchivePlan}=require('../src/core/video-names'),rec=await sample('archive'),source=rec.mp4Path(1);await splitRecorder(rec,100000);const split=rec.uploadParts[source],original=fs.statSync(source),plan=makePlan(rec,{nickname:'测试',title:'归档'}),archive=makeArchivePlan(rec);applyPlan(rec,plan);fs.mkdirSync(path.dirname(archive[0].target),{recursive:true});fs.linkSync(source,archive[0].target);applyArchivePlan(rec,archive);assert.equal(fs.existsSync(source),false);assert.equal(fs.statSync(archive[0].target).size,original.size);assert.ok(plan.every(p=>fs.existsSync(p.destination)));applyArchivePlan(rec,archive);assert.ok(fs.existsSync(archive[0].target));});
