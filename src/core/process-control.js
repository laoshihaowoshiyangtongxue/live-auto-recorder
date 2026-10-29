const os=require('node:os');
function control(child,action){
  if(!child||!Number.isInteger(child.pid)||child.exitCode!==null||child.signalCode)return false;
  if(process.platform==='win32'){
    const native=require('ntsuspend');
    if(native[action](child.pid)!==true)throw Error(action==='suspend'?'无法暂停媒体进程':'无法恢复媒体进程');
  }else if(!child.kill(action==='suspend'?'SIGSTOP':'SIGCONT'))throw Error('无法控制媒体进程');
  return true;
}
function lowerPriority(child){try{os.setPriority(child.pid,os.constants.priority.PRIORITY_BELOW_NORMAL);}catch{}}
module.exports={control,lowerPriority};
