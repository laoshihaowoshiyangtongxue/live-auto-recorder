const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lr-electron-media-'));process.env.LR_LOG_DIR=path.join(root,'logs');
const {Recorder,createFfmpegRunner}=require('../../src/core/recorder'),{MediaPool}=require('../../src/core/media-pool'),{PostProcessor}=require('../../src/core/postprocess');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+20000;while(!check()){if(Date.now()>end)throw Error('Timed out');await sleep(25);}}
app.whenReady().then(async()=>{
 const results=[];let server,post,pool;const records=[];
 try{
  const fixture=path.join(root,'source.flv'),ff=createFfmpegRunner();
  const generated=await ff(['-y','-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=20','-t','6','-c:v','libx264','-g','20','-f','flv',fixture],15000);assert.equal(generated.code,0,generated.stderr);
  server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'video/x-flv'});fs.createReadStream(fixture).pipe(res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const captured=new Recorder(path.join(root,'capture'));records.push(captured);let closed=0;captured.onPartClosed=()=>closed++;
  captured.start('http://127.0.0.1:'+server.address().port+'/live');await until(()=>closed===1);await captured.stop();
  assert.ok(fs.statSync(captured.flvPath(1)).size>1024);assert.equal(captured._openParts.size,0);
  const remuxed=await captured.remuxAll();assert.equal(remuxed.length,1);assert.ok(remuxed[0].endsWith('.mp4'));results.push('真实HTTP拉流、文件关闭、无损转封装通过');
  assert.equal((await captured.validateMedia(remuxed[0])).reused,true);results.push('完整校验后同一文件可安全复用结果');
  const pause=new Recorder(path.join(root,'pause'));records.push(pause);let latest;pause.onProgress=p=>latest=p;
  const running=pause._runFfmpeg(['-y','-v','error','-re','-i',remuxed[0],'-c','copy',pause.base+'.mp4'],9000,false,6);
  await until(()=>pause._activeProc&&latest?.processedSec>0);const pid=pause._activeProc.pid;pause.pauseProcessing();const at=latest.processedSec;await sleep(600);assert.equal(latest.processedSec,at);await pause.resumeProcessing();assert.equal(pause._activeProc.pid,pid);assert.equal((await running).code,0);results.push('Electron实际暂停/恢复保持同一FFmpeg进程与进度');
  pool=new MediaPool(()=>2);post=new PostProcessor(path.join(process.cwd(),'dm.ass'),{postConcurrency:2,burnDanmaku:true,keepRaw:true});
  for(let n=0;n<2;n++){
   const rec=new Recorder(path.join(root,'parallel'+n));records.push(rec);rec.part=1;rec.partStarts=[0,0];rec.startedAt=0;rec.mediaPool=pool;
   fs.copyFileSync(remuxed[0],rec.mp4Path(1));const dm=rec.base+'.jsonl';fs.writeFileSync(dm,JSON.stringify({t:1000,body:n?'第二场独立弹幕':'第一场独立弹幕',text:'评论'}));
   post.enqueue({id:'parallel'+n,recorder:rec,danmakuFile:dm,mergeComplete:true});
  }
  await until(()=>!post.running.size&&!post.queue.length);
  assert.equal(post.items.every(v=>v.status==='done'),true,JSON.stringify(post.items));
  for(const rec of records.slice(-2)){assert.equal((await rec.validateMedia(rec.burnOutPath(1))).ok,true);assert.ok(Math.abs(await rec._probeDuration(rec.mp4Path(1))-await rec._probeDuration(rec.burnOutPath(1)))<.1);}
  results.push('两路真实弹幕压制、独立字幕、完整解码和双版本时长核对通过');
  fs.writeFileSync(path.join(__dirname,'media-runtime-results.json'),JSON.stringify({passed:true,results,root},null,2));app.exit(0);
 }catch(e){fs.writeFileSync(path.join(__dirname,'media-runtime-results.json'),JSON.stringify({passed:false,error:e.stack,results,root},null,2));for(const rec of records)rec._abortFfmpeg();app.exit(1);}
 finally{post?.close();pool?.close();server?.close();}
}).catch(e=>{console.error(e);app.exit(1);});
