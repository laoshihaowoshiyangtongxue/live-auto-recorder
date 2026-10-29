const path=require('node:path');
const {Worker}=require('node:worker_threads');
function inspectFlvTailAsync(file,timeoutMs=120000){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(path.join(__dirname,'flv-tail-worker.js'),{workerData:{file}});let finished=false;
    const end=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);worker.terminate().catch(()=>{});error?reject(error):resolve(result);};
    const timer=setTimeout(()=>end(new Error('尾部检查超时，源文件已保留')),timeoutMs);
    worker.once('message',m=>end(m.error?new Error(m.error):null,m.result));
    worker.once('error',e=>end(e));worker.once('exit',code=>{if(!finished)end(new Error('尾部检查进程退出: '+code));});
  });
}
module.exports={inspectFlvTailAsync};
