const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('closing the launch console does not crash the process or lose disk logs',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-log-pipe-'));
 try{
  const logger=path.resolve(__dirname,'../src/util/log.js');
  const child=spawn(process.execPath,['-e',`const log=require(${JSON.stringify(logger)});let n=0;const timer=setInterval(()=>{log.info('survived',++n);if(n===12){clearInterval(timer);setTimeout(()=>process.exit(0),50);}},10);`],{env:{...process.env,LR_LOG_DIR:dir},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',c=>errors+=c);
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  child.stdout.once('data',()=>child.stdout.destroy());
  const result=await closed;assert.equal(result.code,0,errors);
  const text=fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0]),'utf8');assert.match(text,/survived 12/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
