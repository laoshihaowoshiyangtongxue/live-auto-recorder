const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ProcessingProgress}=require('../src/core/processing-progress');
const {Recorder}=require('../src/core/recorder');
const {PostProcessor}=require('../src/core/postprocess');
test('split progress chunks produce media-time ETA without premature completion',()=>{
  let at=1000;const values=[];
  const parser=new ProcessingProgress(100,v=>values.push(v),()=>at);
  at=11000;parser.write('out_time_u');parser.write('s=25000000\nprogress=continue\n');
  assert.equal(values.at(-1).percent,25);assert.equal(values.at(-1).remainingSec,30);
  at=12000;parser.write('out_time_us=120000000\nprogress=end\n');
  assert.equal(values.at(-1).percent,99);assert.equal(values.at(-1).remainingSec,null);
});
test('unknown duration does not invent a percentage or ETA',()=>{
  const values=[];const parser=new ProcessingProgress(0,v=>values.push(v));
  parser.write('out_time_us=1000000\nprogress=continue\n');
  assert.equal(values.at(-1).percent,null);assert.equal(values.at(-1).remainingSec,null);
});
test('stage transitions and completion clear stale estimates',()=>{
  const rec={},post=new PostProcessor(path.join(os.tmpdir(),'dm.ass'),{}),view=post.begin(rec,'测试');
  rec.onProgress({percent:90,remainingSec:1});assert.equal(view.progress.percent,90);
  rec.onStage('完整性检查');assert.equal(view.progress,null);
  rec.onProgress({percent:50});post.finish(view,'failed','error');assert.equal(view.progress,null);
});
test('real FFmpeg emits progress without contaminating framehash or probes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-progress-'));
  try {
    const rec=new Recorder(path.join(dir,'test')),values=[];rec.onProgress=v=>values.push(v);
    const file=path.join(dir,'fixture.mp4');
    let result=await rec._runFfmpeg(['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10','-t','2','-c:v','libx264','-preset','ultrafast',file],15000,false,2);
    assert.equal(result.code,0,result.stderr);assert.ok(values.some(v=>v.percent>0));
    assert.ok(await rec._probeDuration(file)>1.5);
    result=await rec._runFfmpeg(['-v','error','-i',file,'-map','0:v:0','-c','copy','-f','framehash','-'],15000,true);
    assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/#format: frame checksums/);assert.doesNotMatch(result.stdout,/progress=/);
    const checked=await rec.validateMedia(file);assert.equal(checked.ok,true,checked.stderr);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
