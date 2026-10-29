const {spawn}=require('node:child_process');
const {ProcessingProgress}=require('./processing-progress');
const {control,lowerPriority}=require('./process-control');
class MediaExecution {
  constructor(rec,args,timeout,capture,duration,executable){Object.assign(this,{rec,args,timeout,capture,duration,executable});this.paused=!!rec._processingPaused;this.left=timeout;this.child=null;this.lease=null;this.done=false;}
  pause(){
    if(this.done)return;
    this.resumeToken=(this.resumeToken||0)+1;
    if(this.child&&!this.paused){control(this.child,'suspend');this.freezeClock();this.progress?.pause();}
    this.paused=true;this.lease?.release();this.lease=null;
  }
  async resume(){
    if(this.done)return;
    if(!this.paused)return;
    const token=this.resumeToken=(this.resumeToken||0)+1;
    if(this.child&&this.rec.mediaPool){this.rec.onResourceWait?.();this.lease=await this.rec.mediaPool.acquire(()=>true,true,()=>this.rec.processingOrder?.()||0);}
    if(this.done){this.lease?.release();this.lease=null;return;}
    if(token!==this.resumeToken){this.lease?.release();this.lease=null;return false;}
    try{if(this.child){control(this.child,'resume');this.progress?.resume();this.startClock();}this.paused=false;this.gate?.();this.gate=null;this.rec.mediaPool?.drain();}
    catch(e){this.lease?.release();this.lease=null;throw e;}
  }
  abort(){this.aborted=true;if(this.paused&&this.child)try{control(this.child,'resume');}catch{}this.paused=false;this.gate?.();this.rec.mediaPool?.drain();try{this.child?.kill('SIGKILL');}catch{}}
  freezeClock(){if(this.clock){clearTimeout(this.clock);this.clock=null;this.left=Math.max(1,this.left-(Date.now()-this.clockAt));}}
  startClock(){this.clockAt=Date.now();this.clock=setTimeout(()=>{this.timedOut=true;try{this.child?.kill('SIGKILL');}catch{}},this.left);}
  async run(){
    if(this.rec.mediaPool){this.rec.onResourceWait?.();this.lease=await this.rec.mediaPool.acquire(()=>!this.paused||this.aborted,false,()=>this.rec.processingOrder?.()||0);}
    if(this.paused&&!this.aborted)await new Promise(resolve=>this.gate=resolve);
    if(this.aborted||this.rec._userAbort){this.done=true;this.lease?.release();return {code:-1,stderr:'用户暂停',stdout:'',aborted:true};}
    this.rec.onResourceReady?.();
    try{return await new Promise(resolve=>{
      let stderr='',stdout='',bytes=0,streamError=null,spaceError=null,stateError=null,settled=false;
      const args=this.args,report=!this.capture&&!!this.rec.onProgress&&args.indexOf('-i')>=0&&args.indexOf('-i')<args.length-2;
      this.progress=report?new ProcessingProgress(this.duration,value=>this.rec.onProgress?.(value)):null;
      const child=spawn(this.executable,report?['-progress','pipe:1','-stats_period','0.5','-nostats',...args]:args,{windowsHide:true,stdio:['ignore',this.capture||report?'pipe':'ignore','pipe']});
      this.child=child;this.rec._activeProc=child;lowerPriority(child);
      this.rec.processingProcessId=child.pid;
      const finish=(code,signal)=>{if(settled)return;settled=true;this.done=true;this.freezeClock();clearInterval(diskTimer);this.lease?.release();this.lease=null;
        if(this.rec._activeProc===child)this.rec._activeProc=null;
        if(this.rec.processingProcessId===child.pid){this.rec.processingProcessId=null;try{this.rec.checkpoint?.();}catch{}}
        if(!stderr&&code!==0)stderr=this.timedOut?'媒体处理超时':`媒体进程退出 code=${code} signal=${signal||'无'}`;
        resolve({code:streamError||spaceError||stateError||this.timedOut||this.aborted?-1:code,stderr:spaceError?.message||stateError?.message||streamError?.message||stderr,stdout,sourceBusy:!!stateError,spaceError:!!spaceError,timedOut:!!this.timedOut,aborted:!!this.aborted});};
      const output=args.at(-1),input=args[args.indexOf('-i')+1];
      const writes=typeof output==='string'&&require('node:path').isAbsolute(output)&&output.startsWith(this.rec.base)&&output!==input;
      const diskTimer=writes?setInterval(()=>{try{this.rec.assertSpace(0,'正在处理');}catch(e){spaceError=e;this.abort();}},1000):null;
      child.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-131072));
      if(report)child.stdout.on('data',chunk=>this.progress.write(chunk));
      if(this.capture)child.stdout.on('data',chunk=>{if(streamError)return;try{
        if(typeof this.capture==='function')this.capture(chunk);
        else{bytes+=chunk.length;if(bytes>64*1024*1024)throw Error('媒体检测输出超过缓冲上限');stdout+=chunk.toString();}
      }catch(e){streamError=e;this.abort();}});
      child.once('error',e=>{stderr=e.message;finish(-1);});child.once('close',finish);this.startClock();
      try{if(this.rec.checkpoint?.()===false){stateError=Error('任务记录暂不可写，保留原文件等待恢复');this.abort();}}catch(e){stateError=e;this.abort();}
    });}finally{this.lease?.release();this.lease=null;}
  }
}
module.exports={MediaExecution};
