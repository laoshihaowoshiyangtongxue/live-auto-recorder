const {execFile}=require('node:child_process');
const path=require('node:path');
const {ffmpegPath}=require('./recorder');
function busy(message){const e=new Error(message);e.code='LR_SOURCE_BUSY';return e;}
// 只处理本应用旧进程留在已知任务输出上的 FFmpeg；不按进程名批量结束。
async function stopOrphanWriter(job){
  if(process.platform!=='win32'||job.ownerPid===process.pid)return;
  const rows=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process -Filter \"name='ffmpeg.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"],{windowsHide:true,timeout:15000,maxBuffer:1024*1024},(e,out)=>{
    if(e)return reject(busy('无法核对旧录像进程，暂缓恢复'));
    try{const parsed=out.trim()?JSON.parse(out):[];resolve(Array.isArray(parsed)?parsed:[parsed]);}catch{reject(busy('旧录像进程查询结果无效，暂缓恢复'));}
  }));
  const normalize=p=>path.resolve(p).toLowerCase();
  for(const row of rows){
    if(row.ProcessId===job.recorder?.processId&&(!row.ExecutablePath||!row.CommandLine))throw busy('无法核验旧录像进程的身份，暂缓恢复');
    if(!row.ExecutablePath||normalize(row.ExecutablePath)!==normalize(ffmpegPath))continue;
    const last=String(row.CommandLine||'').match(/(?:"([^"\r\n]+)"|([^\s"]+))\s*$/);if(!last)continue;
    const output=last[1]||last[2];const base=normalize(job.base);
    const isCapture=normalize(output).startsWith(base+'_part')&&/^_part\d+\.flv$/i.test(normalize(output).slice(base.length));
    const args=[...String(row.CommandLine||'').matchAll(/"([^"\r\n]*)"|([^\s"]+)/g)].map(m=>m[1]??m[2]);
    const knownInput=args.some(arg=>{try{const p=normalize(arg);return p.startsWith(base+'_part')&&/^_part\d+(?:_弹幕版)?\.(flv|mp4)(?:\.pending\.mp4)?$/i.test(p.slice(base.length));}catch{return false;}});
    const isMedia=row.ProcessId===job.recorder?.processingProcessId&&row.ParentProcessId===job.ownerPid&&knownInput;
    if(!isCapture&&!isMedia)continue;
    if(!job.ownerPid||(row.ParentProcessId!==job.ownerPid&&row.ProcessId!==job.recorder?.processId)){
      throw busy('源文件仍由其他进程写入，等待该进程结束后恢复');
    }
    try{process.kill(row.ProcessId,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw new Error('旧录像进程尚未结束，暂缓处理源文件');}
    for(let i=0;i<50;i++){
      try{process.kill(row.ProcessId,0);}catch(e){if(e.code==='ESRCH')break;throw e;}
      if(i===49)throw new Error('旧录像进程仍在退出，暂缓处理源文件');
      await new Promise(r=>setTimeout(r,100));
    }
  }
}
module.exports={stopOrphanWriter};
