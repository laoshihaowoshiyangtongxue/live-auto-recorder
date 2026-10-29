const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {writeJson}=require('./atomic-json');
const {networkFingerprint}=require('./network-fingerprint');
function installHealth(electron,log,root){
  const {app,crashReporter}=electron,directory=path.join(root,'logs','lifecycle');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'instance-'+process.pid+'-'+Date.now()+'.json'),state={pid:process.pid,startedAt:Date.now(),expectedExit:false};
  const save=()=>{try{writeJson(file,{...state,heartbeatAt:Date.now(),memory:process.memoryUsage()});}catch(error){log.warn('[health] 状态保存失败:',error.message);}};save();
  try{
    const enabled=JSON.parse(fs.readFileSync(path.join(directory,'guardian-enabled.json'),'utf8'));
    if(process.platform==='win32'&&enabled.taskName==='LiveRecorder-Independent-Guardian'&&path.resolve(enabled.root)===path.resolve(root)){
      writeJson(path.join(directory,'active-guardian.json'),{file,pid:state.pid,startedAt:state.startedAt});
      const task=spawn('schtasks.exe',['/Run','/TN',enabled.taskName],{windowsHide:true,stdio:'ignore'});
      task.on('error',e=>log.warn('[health] 独立守护启动失败:',e.message));task.on('exit',code=>{if(code!==0)log.warn('[health] 独立守护未启动, 退出码:',code);});task.unref();
    }
  }catch(error){if(error.code!=='ENOENT')log.warn('[health] 独立守护配置失败:',error.message);}
  try{const dumps=path.join(root,'logs','crashes');fs.mkdirSync(dumps,{recursive:true});app.setPath('crashDumps',dumps);crashReporter.start({uploadToServer:false});}catch(error){log.warn('[health] 本地崩溃转储初始化失败:',error.message);}
  try{const fallback=JSON.parse(fs.readFileSync(path.join(directory,'gpu-fallback.json'),'utf8'));if(Date.now()-fallback.at<24*3600000){app.disableHardwareAcceleration();log.warn('[health] 启用GPU反复崩溃后的软件渲染回退');}}catch{}
  let watchdog=null,lastStart=0;
  const ensureWatchdog=()=>{
    if(state.expectedExit)return;
    if(watchdog?.pid){try{process.kill(watchdog.pid,0);return;}catch(error){if(error.code!=='ESRCH')return;}}
    if(Date.now()-lastStart<10000)return;lastStart=Date.now();
    try{const child=spawn(process.execPath,[path.join(__dirname,'app-watchdog.cjs'),file,String(process.pid),process.execPath,root],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},detached:true,windowsHide:true,stdio:'ignore'});watchdog=child;
      child.on('error',error=>{if(watchdog===child)watchdog=null;log.error('[health] 守护进程启动失败:',error.message);});
      child.on('exit',(code,signal)=>{if(watchdog===child)watchdog=null;if(!state.expectedExit)log.warn('[health] 守护进程退出，将尝试恢复:',code,signal||'');});
      child.unref();log.info('[health] 守护进程已启动:',child.pid);
    }catch(error){watchdog=null;log.error('[health] 守护进程启动失败:',error.message);}
  };
  ensureWatchdog();
  let gpuFailures=[];
  app.on('child-process-gone',(_event,details)=>{log.error('[health] 子进程退出:',JSON.stringify(details));if(details.type==='GPU'&&['crashed','oom','abnormal-exit'].includes(details.reason)){gpuFailures=gpuFailures.filter(at=>Date.now()-at<60000);gpuFailures.push(Date.now());if(gpuFailures.length>=3)try{fs.writeFileSync(path.join(directory,'gpu-fallback.json'),JSON.stringify({at:Date.now(),reason:details.reason}));}catch{}}});
  app.on('web-contents-created',(_event,wc)=>wc.on('render-process-gone',(_e,details)=>log.error('[health] 页面进程退出:',JSON.stringify({id:wc.id,reason:details.reason,exitCode:details.exitCode,url:wc.isDestroyed()?'closed':wc.getURL().split('?')[0]}))));
  let lastNetwork=null;
  const heartbeat=setInterval(()=>{save();ensureWatchdog();try{const next=networkFingerprint();if(lastNetwork&&next.hash!==lastNetwork.hash)log.info('[health] 网络接口发生变化:',JSON.stringify({before:lastNetwork.count,after:next.count,signature:next.hash}));lastNetwork=next;}catch(error){log.warn('[health] 网络状态检查失败:',error.message);}},10000);heartbeat.unref();
  const metrics=setInterval(()=>{try{const processes=app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,privateKB:p.memory?.privateBytes,workingKB:p.memory?.workingSetSize}));log.info('[health] 资源快照:',JSON.stringify({memory:process.memoryUsage(),processes}));}catch{}},60000);metrics.unref();
  return {expectedExit(reason){state.expectedExit=true;state.exitReason=reason;save();clearInterval(heartbeat);clearInterval(metrics);}};
}
module.exports={installHealth};
