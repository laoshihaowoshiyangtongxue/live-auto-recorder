const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {writeJson}=require('../util/atomic-json');
const log=require('../util/log');
const DONE=new Set(['done','recovered','skipped','canceled']);
function snapshot(rec){
  const data={};
  for(const key of ['base','part','partStarts','startedAt','lastProgressAt','settings','mergedDurations','mergedSegStarts','mergedReplayOffsets','mergedFromParts','mergedInputs','mergeDestination','mergePlan','burnCheckpoint','uploadParts','processId','processingProcessId']){
    if(rec[key]!==undefined)data[key]=structuredClone(rec[key]);
  }
  data.emptyParts=[...(rec.emptyParts||[])];data.issues=[...(rec.issues||[])];data.notices=[...(rec.notices||[])];
  return data;
}
class JobStore{
  constructor(file){
    this.file=file;this.jobs=new Map();this.error='';
    let data,recovered=false;
    for(const candidate of [file,file+'.bak']){
      try{const parsed=JSON.parse(fs.readFileSync(candidate,'utf8'));if(!Array.isArray(parsed.jobs))throw Error('任务记录结构无效');data=parsed;recovered=candidate!==file;break;}
      catch(e){if(e.code!=='ENOENT'){log.warn('[jobs] 读取失败:',path.basename(candidate),e.message);if(candidate===file)try{fs.renameSync(file,file+'.corrupt-'+Date.now());}catch{}}}
    }
    for(const job of data?.jobs||[]){
      if(typeof job.id==='string'&&typeof job.base==='string'&&path.isAbsolute(job.base)&&job.recorder&&Array.isArray(job.recorder.partStarts)&&Number.isInteger(job.recorder.part)&&job.recorder.part>=0&&job.recorder.part<=100000)this.jobs.set(job.id,job);
    }
    if(recovered)try{writeJson(file,{version:1,jobs:[...this.jobs.values()]});}catch(e){this.error=e.message;}
  }
  persist(){
    // Canceled jobs are tombstones: removing them would let scan() rediscover
    // their retained source files and start the canceled work again.
    const completed=[...this.jobs.values()].filter(j=>DONE.has(j.status)&&j.status!=='canceled').sort((a,b)=>b.updatedAt-a.updatedAt);
    for(const job of completed.slice(300))this.jobs.delete(job.id);
    try{writeJson(this.file,{version:1,jobs:[...this.jobs.values()]},{backup:true});this.error='';return true;}
    catch(e){this.error=e.message;log.error('[jobs] 任务状态暂未保存，将重试:',e.message);return false;}
  }
  set(rec,patch={}){
    if(!rec.jobId){const known=[...this.jobs.values()].find(j=>j.base===rec.base);rec.jobId=known?.id||randomUUID();}
    const previous=this.jobs.get(rec.jobId)||{};
    if(previous.status==='canceled')return previous;
    const job={...previous,id:rec.jobId,base:rec.base,ownerPid:process.pid,updatedAt:Date.now(),...patch,recorder:snapshot(rec)};
    this.jobs.set(job.id,job);this.persist();return job;
  }
  get(id){return this.jobs.get(id);}
}
function restoreRecorder(job,Recorder){
  const rec=new Recorder(job.base);const state=job.recorder||{};
  for(const key of ['part','partStarts','startedAt','lastProgressAt','settings','mergedDurations','mergedSegStarts','mergedReplayOffsets','mergedFromParts','mergedInputs','mergeDestination','mergePlan','burnCheckpoint','uploadParts','processId'])if(state[key]!==undefined)rec[key]=structuredClone(state[key]);
  rec.emptyParts=new Set((Array.isArray(state.emptyParts)?state.emptyParts:[]).filter(i=>Number.isInteger(i)&&i>0&&i<=rec.part));
  rec.issues=Array.isArray(state.issues)?state.issues.filter(e=>typeof e==='string'):[];rec.notices=Array.isArray(state.notices)?state.notices.filter(e=>typeof e==='string'):[];
  for(const key of ['mergedDurations','mergedSegStarts','mergedReplayOffsets','mergedInputs'])if(rec[key]!==undefined&&!Array.isArray(rec[key])){delete rec[key];rec.notices.push('部分恢复记录损坏，原始文件已保留，请检查恢复结果');}
  rec.jobId=job.id;rec.stopped=true;
  return rec;
}
module.exports={JobStore,restoreRecorder,snapshot,DONE};
