const fs=require('node:fs');
const path=require('node:path');
const {JobStore,restoreRecorder,DONE}=require('./job-store');
const {Recorder}=require('./recorder');
const {stopOrphanWriter}=require('./orphan-process');
const {recordingDirs}=require('./recording-paths');
const {writeJson}=require('../util/atomic-json');
const log=require('../util/log');
const {quietHours}=require('./quiet-hours');
const {makePlan,applyPlan,makeArchivePlan,applyArchivePlan,videoFiles,isFinalVideoName,dateMigration}=require('./video-names');
const {MediaPool}=require('./media-pool');

class RecoveryController{
  constructor(scheduler,file){
    this.s=scheduler;this.store=new JobStore(file);this.contexts=new Map();this.running=new Set();this.sealTail=Promise.resolve();this.closing=false;
    this.admitted=new Set();
    this.executions=new Map();this.sealing=new Set();
    this.sealPool=new MediaPool(()=>Math.max(1,Math.min(4,Number(this.s.cfg?.settings?.postConcurrency)||1)));
    this.mediaPool=new MediaPool(()=>{
      const requested=Math.max(1,Math.min(4,Number(this.s.cfg?.settings?.postConcurrency)||1));
      const recording=[...(this.s.tasks?.values()||[])].filter(t=>t.state==='recording'&&!t.paused);
      const stalled=recording.some(t=>t.rec&&Date.now()-(t.rec.lastProgressAt||Date.now())>10000);
      return Math.min(requested,stalled?1:recording.length?2:4);
    });
    scheduler.post.quietInfo=()=>this.quietInfo();
    scheduler.post.canStart=job=>this.admitted.has(job.id)||!this.quietInfo().active;
    scheduler.post.onStart=job=>{this.admitted.add(job.id);this.store.set(job.recorder,{status:'processing',phase:'post',waitReason:'',error:'',userPaused:false,nextAttemptAt:0});};
    scheduler.post.onState=(job,status)=>this.store.set(job.recorder,{status,phase:'post',userPaused:!!job.paused,waitReason:job.paused?'user':'',error:'',nextAttemptAt:0});
    scheduler.post.onDeferred=job=>this.deferQuiet(job.recorder,job.view,'post');
    scheduler.post.onResult=(job,error,result)=>{this.admitted.delete(job.id);this.postResult(job,error,result);};
  }
  quietInfo(){return quietHours(this.s.cfg.settings,this.now?this.now():new Date());}
  orderOf(id){const j=this.store.get(id);return Number(j?.queueOrder??j?.finishedAt??j?.recorder?.startedAt??j?.updatedAt)||0;}
  pendingJobs(){
    return [...this.store.jobs.values()].filter(j=>{
      if(DONE.has(j.status)||j.status==='recording')return false;
      const p=this.s.post._find(j.id),e=this.executions.get(j.id);
      if((p?.view?.stage||e?.view?.stage)==='等待处理资源')return true;
      return !(p&&this.s.post.running.has(p)&&!p.paused)&&!(e?.started&&!e.rec._processingPaused);
    }).sort((a,b)=>this.orderOf(a.id)-this.orderOf(b.id)||a.id.localeCompare(b.id));
  }
  status(){
    const status=this.s.post.status,quiet=this.quietInfo(),pending=this.pendingJobs();
    const items=status.items.filter(v=>!this.store.get(v.id)?.postHidden).map(v=>({...v}));
    for(const j of this.store.jobs.values()){
      if(DONE.has(j.status)||j.status==='recording')continue;
      if(!items.some(v=>v.id===j.id))items.push({id:j.id,name:j.nickname,partsTotal:j.recorder?.part||1,status:j.status,error:j.error});
    }
    for(const v of items){
      const j=this.store.get(v.id);if(!j)continue;
      v.postId=j.id;v.title=j.title||'';v.error=j.error||v.error||'';v.startedAt=j.recorder?.startedAt;v.queuePosition=pending.findIndex(p=>p.id===j.id)+1;
      const p=this.s.post._find(j.id),e=this.executions.get(j.id),waitingResource=(p?.view?.stage||e?.view?.stage)==='等待处理资源',active=!waitingResource&&!!(p&&this.s.post.running.has(p)&&!p.paused||e?.started&&!e.rec._processingPaused);
      const isPaused=!!(j.userPaused||j.status==='paused'||p?.paused||e?.rec._processingPaused);
      if(!DONE.has(j.status)){
        if(isPaused){v.status='paused';v.stage='已暂停';}
        else if(!active&&j.waitReason==='quiet'){v.status=quiet.active?'quiet':'queued';v.stage=quiet.active?'静音时段等待':'排队等待处理';}
        else if(!active&&['recovering','sealing','queued'].includes(j.status)){v.status='queued';v.stage='排队等待处理';}
        if(waitingResource&&!isPaused){v.status='queued';v.stage='等待处理资源';}
        if((p?.resuming&&!p.resumeCanceled)||(e?.resuming&&!e.resumeCanceled)){v.status='queued';v.stage='等待资源继续';}
      }
      const eligible=!DONE.has(j.status)&&j.status!=='recording';
      const resuming=!!(p?.resuming||e?.resuming);v.controls={pause:eligible&&(!isPaused||resuming),resume:eligible&&isPaused&&!resuming,move:eligible&&v.queuePosition>0,runNow:eligible&&!active&&!resuming};
    }
    items.sort((a,b)=>{const rank=v=>['processing','burning'].includes(v.status)?0:!['done','recovered','skipped','canceled'].includes(v.status)?1:2;return rank(a)-rank(b)||(rank(a)===1?(a.queuePosition||1e9)-(b.queuePosition||1e9):0);});
    return {...status,items,quiet,updatedAt:Date.now()};
  }
  removeCompleted(id){
    const job=this.store.get(id);
    if(!job||!['done','recovered','skipped'].includes(job.status))return {ok:false,error:'只能删除已完成的后处理记录'};
    if(this.running.has(id)||this.executions.has(id)||this.s.post._find(id))return {ok:false,error:'任务仍在处理，请稍后重试'};
    const previous=job.postHidden;job.postHidden=true;
    if(!this.store.persist()){if(previous===undefined)delete job.postHidden;else job.postHidden=previous;return {ok:false,error:'记录保存失败，请重试'};}
    this.s.post.onUpdate();return {ok:true};
  }
  cancelTask(id){
    if(this.closing)return {ok:false,error:'程序正在退出'};
    const job=this.store.get(id);
    if(!job||DONE.has(job.status)||job.status==='recording')return {ok:false,error:'任务已结束或不存在'};
    const post=this.s.post._find(id), entry=this.executions.get(id);
    const previous={...job};job.status='canceled';job.postHidden=true;job.error='';job.nextAttemptAt=0;job.userPaused=false;
    if(!this.store.persist()){Object.assign(job,previous);return {ok:false,error:'取消状态保存失败，请重试'};}
    this.admitted.delete(id);
    const rec=post?.recorder||entry?.rec;
    if(rec){rec._canceled=true;rec._userAbort=true;rec._processingPaused=false;rec._abortFfmpeg?.();}
    if(post){post.canceled=true;post.resumeCanceled=true;const i=this.s.post.queue.indexOf(post);if(i>=0)this.s.post.queue.splice(i,1);}
    if(entry){entry.resumeCanceled=true;if(entry.restored)this.executions.delete(id);}
    this.sealPool.drain();this.mediaPool.drain();
    this.s.post.items=this.s.post.items.filter(v=>v.id!==id);
    this.s.post.onUpdate();this.s.post._drain();
    return {ok:true};
  }
  moveTask(id,direction){
    if(this.closing)return {ok:false,error:'程序正在退出'};
    const job=this.s.post._find(id),key=job?.id||id,list=this.pendingJobs(),index=list.findIndex(j=>j.id===key);
    if(index<0)return {ok:false,error:'运行中的任务请先暂停，再调整顺序'};
    const next=direction==='top'?0:index+(direction==='up'?-1:1);
    if(next<0||next>=list.length)return {ok:false,error:'已到队首或队尾'};
    const [selected]=list.splice(index,1);list.splice(next,0,selected);
    const old=list.map(j=>[j,j.queueOrder]);list.forEach((j,i)=>j.queueOrder=i);
    if(!this.store.persist()){for(const [j,value]of old){if(value===undefined)delete j.queueOrder;else j.queueOrder=value;}return {ok:false,error:'队列顺序保存失败，请重试'};}
    this.s.post.queue.sort((a,b)=>this.orderOf(a.id)-this.orderOf(b.id));
    this.s.post.onUpdate();this.s.post._drain();this.sealPool.drain();this.mediaPool.drain();return {ok:true};
  }
  requestRetry(id,manual=false){
    if(this.closing)return {ok:false,error:'程序正在退出'};
    const j=this.store.get(id);if(!j||DONE.has(j.status)||j.status==='recording')return {ok:false,error:'任务已结束或不存在'};
    if(this.running.has(id)||this.s.post._find(id))return {ok:false,error:'任务已在处理队列中'};
    this.retry(id,manual).catch(error=>log.error('[recovery] 调度失败:',error.stack||error.message));return {ok:true,queued:true};
  }
  requestResume(id){
    const j=this.store.get(id);if(!j||DONE.has(j.status))return {ok:false,error:'任务已结束或不存在'};
    const failed=message=>{const view=this.s.post.items.find(v=>v.id===id);if(view){view.error=message;this.s.post.onUpdate();}log.error('[recovery] 继续失败:',message);};
    this.resumeTask(id).then(result=>{if(!result?.ok)failed(result?.error||'继续任务失败');},error=>failed(error.message));return {ok:true,queued:true};
  }
  runNow(id){
    const result=this.moveTask(id,'top');if(!result.ok)return result;
    this.admitted.add(id);const job=this.store.get(id);
    if(job?.userPaused||job?.status==='paused')return this.requestResume(id);
    if(this.s.post._find(id)){this.s.post._drain();return {ok:true};}
    if(this.executions.has(id)){this.sealPool.drain();return {ok:true};}
    return this.requestRetry(id,true);
  }
  trackSeal(promise){this.sealing.add(promise);promise.then(()=>this.sealing.delete(promise),()=>this.sealing.delete(promise));this.sealTail=Promise.allSettled([...this.sealing]);return promise;}
  pauseTask(id){
    if(this.closing)return {ok:false,error:'程序正在退出，任务状态已保留'};
    if(this.s.post._find(id))return this.s.post.pauseTask(id);
    const entry=this.executions.get(id);if(!entry){
      const job=this.store.get(id);if(!job||DONE.has(job.status)||job.status==='recording')return {ok:false,error:'任务已结束或不存在'};
      const rec=restoreRecorder(job,Recorder);this.store.set(rec,{status:'paused',userPaused:true,waitReason:'user',nextAttemptAt:0});
      this.s.post.finish(this.view(rec,job),'paused');return {ok:!this.store.error,error:this.store.error};
    }
    if(entry.rec._processingPaused&&!entry.resuming)return {ok:true};
    if(entry.resuming)entry.resumeCanceled=true;
    try{entry.rec.pauseProcessing();}catch(e){return {ok:false,error:e.message};}
    entry.lease?.release();entry.lease=null;entry.stage=entry.view.stage;
    this.store.set(entry.rec,{status:'paused',phase:'seal',userPaused:true,waitReason:'user',error:'',nextAttemptAt:0});
    entry.view.status='paused';entry.view.stage='已暂停';this.s.post.onUpdate();return {ok:true};
  }
  async resumeTask(id){
    if(this.closing)return {ok:false,error:'程序正在退出，任务状态已保留'};
    if(this.s.post._find(id)){const job=this.s.post._find(id);this.admitted.add(job.id);return this.s.post.resumeTask(id);}
    const entry=this.executions.get(id);if(!entry){
      const job=this.store.get(id);if(!job||DONE.has(job.status))return {ok:false,error:'没有待恢复的暂停任务'};
      const rec=restoreRecorder(job,Recorder);this.store.set(rec,{status:'waiting',userPaused:false,waitReason:'',nextAttemptAt:Date.now()});
      this.admitted.add(id);return this.requestRetry(id,true);
    }
    if(!entry.rec._processingPaused)return {ok:true};
    if(entry.resuming)return {ok:false,error:'正在等待处理资源'};entry.resuming=true;entry.resumeCanceled=false;
    try{
      if(entry.restored){
        entry.rec._processingPaused=false;this.admitted.add(id);this.executions.delete(id);
        this.store.set(entry.rec,{status:'sealing',phase:'seal',userPaused:false,waitReason:'',error:''});entry.view.status='processing';
        this.trackSeal(this.seal(entry.rec,entry.view));return {ok:true};
      }
      if(entry.started&&!entry.lease)entry.lease=await this.sealPool.acquire(()=>true,true);
      if(entry.resumeCanceled){entry.lease?.release();entry.lease=null;return {ok:true,paused:true};}
      if(this.closing){entry.lease?.release();entry.lease=null;return {ok:false,error:'程序正在退出'};}
      const resumed=await entry.rec.resumeProcessing();if(resumed===false||entry.resumeCanceled){entry.lease?.release();entry.lease=null;return {ok:true,paused:true};}this.sealPool.drain();
      if(this.closing){entry.lease?.release();entry.lease=null;return {ok:false,error:'程序正在退出'};}
      this.store.set(entry.rec,{status:'sealing',phase:'seal',userPaused:false,waitReason:'',error:''});
      entry.view.status='processing';entry.view.stage=entry.stage||'恢复录像';this.s.post.onUpdate();return {ok:true};
    }catch(e){entry.lease?.release();entry.lease=null;return {ok:false,error:e.message};}finally{entry.resuming=false;}
  }
  deferQuiet(rec,view,phase){
    const quiet=this.quietInfo();
    const job=this.store.set(rec,{status:'waiting',phase,waitReason:'quiet',error:'',nextAttemptAt:quiet.resumeAt||Date.now()+10000});
    view=view||this.view(rec,job);this.s.post.finish(view,'quiet');view.quietUntil=quiet.resumeAt;
    this.updateHistory(rec,job,'quiet');this.s.post.onUpdate();
    return {ok:true,deferred:true,quiet:true,files:[]};
  }
  bind(rec,task){
    if(!rec.settings||typeof rec.settings!=='object'||Array.isArray(rec.settings)){rec.settings={...this.s.cfg.settings,keepRaw:true};rec.notices.push('恢复记录缺少设置，恢复时保留原片');}
    rec.availableBytes=()=>this.s.freeBytes(path.dirname(rec.base));
    rec.mediaPool=this.mediaPool;
    rec.processingOrder=()=>this.orderOf(rec.jobId);
    rec.onPartClosed=part=>{this.store.set(rec,{lastClosedPart:part.part});};
    rec.onCheckpoint=()=>{this.store.set(rec);return !this.store.error;};
    if(task)this.contexts.set(rec.jobId,task);
    return rec;
  }
  begin(rec,task,patch={}){
    this.store.set(rec,{status:'recording',phase:'seal',outputDir:this.s.outDir,rid:task.rid,nickname:task.lastInfo?.nickname||task.item?.nickname||task.rid,title:task.lastInfo?.title||'',attempts:0,...patch});
    this.bind(rec,task);return rec.jobId;
  }
  bases(){return [...this.store.jobs.values()].filter(j=>!DONE.has(j.status)).map(j=>j.base);}
  view(rec,job){
    let v=this.s.post.items.find(v=>v.id===job.id);
    if(!v)v=this.s.post.begin(rec,job.nickname);
    v.id=job.id;v.postId||=job.id;this.s.post.bindProgress(rec,v);return v;
  }
  updateHistory(rec,job,status,error=''){
    const existing=this.s.history.findIndex(h=>h.jobId===job.id);
    if(existing<0&&job.historyRecorded)return;
    const files=videoFiles(rec,job).map(f=>path.relative(job.outputDir||this.s.outDir,f).replace(/\\/g,'/'));
    const entry={...(existing>=0?this.s.history[existing]:{}),jobId:job.id,at:job.finishedAt||Date.now(),rid:job.rid,nickname:job.nickname,title:job.title||'',secs:job.secs||0,files,error,status,recoveryNotice:(rec.notices||[]).join('; ')};
    const history=[...this.s.history];if(existing>=0)history[existing]=entry;else history.push(entry);
    try{writeJson(this.s.historyFile,history.slice(-300),{backup:true});this.s.history=history.slice(-300);this.store.set(rec,{historyRecorded:true,historyError:''});}
    catch(e){this.store.set(rec,{historyError:e.message});log.error('[history] 状态暂未保存，将重试:',e.message);}
  }
  taskError(rec,error){const task=this.contexts.get(rec.jobId);if(task&&task.basePath===rec.base&&(!task.rec||task.rec===rec))task.lastError=error;}
  failed(rec,error,phase,view){
    if(rec._exitDeferred)return {ok:true,deferred:true,files:[]};
    if(rec._canceled||this.store.get(rec.jobId)?.status==='canceled')return {ok:true,canceled:true,files:[]};
    const previous=this.store.get(rec.jobId)||{};
    if(error.code==='LR_USER_PAUSED'){
      const job=this.store.set(rec,{status:'paused',phase,userPaused:true,waitReason:'user',error:'',nextAttemptAt:0});
      this.s.post.finish(view||this.view(rec,job),'paused');return {ok:true,paused:true};
    }
    const waiting=['LR_DISK_SPACE','LR_SOURCE_BUSY'].includes(error.code)||/ENOSPC|no space left/i.test(error.message);
    const attempts=waiting?(previous.attempts||0):(previous.attempts||0)+1;
    const nextAttemptAt=waiting?Date.now()+30000:attempts<3?Date.now()+30000*2**(attempts-1):0;
    const status=waiting?'waiting':'failed';
    const job=this.store.set(rec,{status,phase,error:error.message,attempts,nextAttemptAt});
    view=view||this.view(rec,job);this.s.post.finish(view,status,error.message);
    this.updateHistory(rec,job,status,error.message);this.taskError(rec,error.message);
    this.s.onEvent&&this.s.onEvent('record-error',{rid:job.rid,error:error.message,jobId:job.id});
    return {ok:false,files:[],error:error.message,deferred:waiting};
  }
  processStopped(task,rec,view){
    if(!rec.jobId)this.begin(rec,task);
    const job=this.store.set(rec,{status:'sealing',phase:'seal',finishedAt:Date.now(),secs:Math.max(0,Math.round((Date.now()-task.recorderStartedAt)/1000))});
    this.contexts.set(rec.jobId,task);view.id=job.id;view.postId=job.id;
    if(this.deferOnExit){this.deferForExit(rec,view,'seal');return Promise.resolve({ok:true,deferred:true,files:[]});}
    return this.trackSeal(this.seal(rec,view));
  }
  async seal(rec,view){
    if(!this.admitted.has(rec.jobId)&&this.quietInfo().active)return this.deferQuiet(rec,view,'seal');
    this.admitted.add(rec.jobId);
    this.running.add(rec.jobId);
    const entry={rec,view,started:false,lease:null};this.executions.set(rec.jobId,entry);
    try{
      view.status=rec._processingPaused?'paused':'queued';view.stage=rec._processingPaused?'已暂停':'排队等待封存';this.s.post.onUpdate();
      entry.lease=await this.sealPool.acquire(()=>rec._canceled||!rec._processingPaused||rec._shutdownPaused,false,()=>this.orderOf(rec.jobId));entry.started=true;
      const checkCanceled=()=>{if(rec._exitDeferred){const e=Error('退出时暂停处理');e.code='LR_EXIT_DEFERRED';throw e;}if(rec._canceled){const e=Error('任务已取消');e.code='LR_CANCELED';throw e;}};checkCanceled();
      view.status='processing';view.stage='恢复录像';this.s.post.onUpdate();
      if(rec._shutdownPaused){const e=Error('暂停任务留待下次启动');e.code='LR_USER_PAUSED';throw e;}
      rec.assertSpace(0,'恢复录像');
      if(!this.store.persist()){const e=new Error('任务记录暂不可写，保留源文件等待恢复');e.code='LR_SOURCE_BUSY';throw e;}
      await rec.recoverPublications();checkCanceled();await rec.recoverMergePlan();checkCanceled();
      await rec.reconcileParts();checkCanceled();
      rec.issues=[];
      if(rec.settings?.autoPartMerge)await rec.mergeParts();checkCanceled();
      if(this.store.error){const e=new Error('任务记录暂不可写，保留源文件等待恢复');e.code='LR_SOURCE_BUSY';throw e;}
      const files=await rec.remuxAll(rec.settings?.minSizeMB||0);checkCanceled();
      // Failed reconnects may contribute confirmed empty parts, so the number
      // of real files need not equal rec.part. The merger checks missing parts.
      if(rec.settings?.autoPartMerge&&rec.part>1&&!rec.issues.length&&files.length&&files.every(f=>f.endsWith('.mp4'))){
        if(await rec.consolidateMp4s())files.splice(0,files.length,rec.mp4Path(1));
        else rec.issues.push('分片合并未完成，全部原片已保留，不能确认整场双版本完整');
      }
      checkCanceled();const previous=this.store.get(rec.jobId);
      if(!previous.secs&&files.length){let seconds=0;for(const f of files)if(f.endsWith('.mp4'))seconds+=await rec._probeDuration(f);this.store.set(rec,{secs:Math.round(seconds)});}
      const error=rec.issues.join('; ');
      if(!files.length){
        this.admitted.delete(rec.jobId);
        const job=this.store.set(rec,{status:'warning',phase:'seal',error:error||'没有有效录像',nextAttemptAt:0});this.s.post.finish(view,'warning',job.error);this.updateHistory(rec,job,'warning',job.error);this.taskError(rec,job.error);
        return {ok:false,files,error:job.error};
      }
      const paused=!!rec._processingPaused;
      const job=this.store.set(rec,{status:paused?'paused':'queued',phase:error?'seal':'post',userPaused:paused,error,nextAttemptAt:0});
      this.updateHistory(rec,job,'processing',error);this.taskError(rec,error);
      this.s.post.enqueue({id:job.id,recorder:rec,danmakuFile:rec.base+'.danmaku.jsonl',nickname:job.nickname,settings:{...rec.settings},mergeComplete:true,view,paused});
      return {ok:!error,files,error,processing:true,enqueued:true};
    }catch(e){this.admitted.delete(rec.jobId);return this.failed(rec,e,'seal',view);}
    finally{entry.lease?.release();if(this.executions.get(rec.jobId)===entry)this.executions.delete(rec.jobId);this.running.delete(rec.jobId);}
  }
  postResult(job,error,result){
    const rec=job.recorder;if(rec._exitDeferred)return;if(rec._canceled||this.store.get(rec.jobId)?.status==='canceled')return;
    if(error){this.failed(rec,error,this.store.get(rec.jobId)?.phase||'post',job.view);return;}
    const warnings=rec.issues||[],notices=rec.notices||[];
    const status=warnings.length?'warning':notices.length?'recovered':result?.skipped?'skipped':'done';
    if(DONE.has(status))return this.publish(rec,status);
    const state=this.store.set(rec,{status,phase:'seal',error:warnings.join('; '),nextAttemptAt:0,attempts:0});
    this.updateHistory(rec,state,status,state.error);this.taskError(rec,state.error);
    this.s.onEvent&&this.s.onEvent('record-done',{rid:state.rid,nickname:state.nickname,secs:state.secs||0,files:this.s.history.find(h=>h.jobId===state.id)?.files||[],warnings,notices,jobId:state.id});
    if(DONE.has(status))this.contexts.delete(state.id);
  }
  publish(rec,status,notify){
    let job=this.store.get(rec.jobId);
    const shouldNotify=notify??job.publicationNotify??true;
    const plan=job.publicationPlan||makePlan(rec,job);
    const archivePlan=job.archivePlan||makeArchivePlan(rec);
    if(plan.length){
      job=this.store.set(rec,{status:'publishing',phase:'publish',publicationPlan:plan,archivePlan,publicationStatus:status,publicationNotify:shouldNotify});
      if(this.store.error)throw Error('命名计划暂未保存，原文件保留');
      applyPlan(rec,plan);
      applyArchivePlan(rec,archivePlan);
    }
    const state=this.store.set(rec,{status,phase:'publish',error:'',nextAttemptAt:0,attempts:0,waitReason:'',namingVersion:2});
    if(this.store.error)throw Error('录像已命名，完成状态暂未保存，下次继续恢复');
    this.updateHistory(rec,state,status);this.taskError(rec,'');
    const view=this.s.post.items.find(v=>v.id===rec.jobId);if(view)this.s.post.finish(view,status,(rec.notices||[]).join('; '));
    if(shouldNotify)this.s.onEvent&&this.s.onEvent('record-done',{rid:state.rid,nickname:state.nickname,secs:state.secs||0,files:this.s.history.find(h=>h.jobId===state.id)?.files||[],warnings:[],notices:rec.notices||[],jobId:state.id});
    this.contexts.delete(state.id);return {ok:true};
  }
  migrateNames(job){
    if(job.namingVersion===2&&!job.namingMigrationPlan?.length)return;
    const rec=this.bind(restoreRecorder(job,Recorder)),plan=dateMigration(rec,job);
    if(plan.length){
      this.store.set(rec,{namingMigrationPlan:plan});if(this.store.error)throw Error('改名计划保存失败，原文件保留');
      applyPlan(rec,plan,{renameFinal:true});
      const publicationPlan=job.publicationPlan.map(entry=>({...entry,destination:plan.find(p=>p.source===entry.destination)?.destination||entry.destination}));
      job=this.store.set(rec,{publicationPlan,namingMigrationPlan:null,namingVersion:2});this.updateHistory(rec,job,job.status,job.error||'');
    }else this.store.set(rec,{namingVersion:2});
  }
  async retry(id,manual=false){
    if(this.closing)return {ok:false,error:'程序正在退出，任务已保留待下次恢复'};
    const job=this.store.get(id);if(!job||this.running.has(id)||this.s.post._find(id))return {ok:false,error:'任务正在处理或不存在'};
    if(DONE.has(job.status)||job.status==='recording')return {ok:false,error:'此任务无需恢复'};
    if(manual)this.admitted.add(id);
    const rec=this.bind(restoreRecorder(job,Recorder));const view=this.view(rec,job);
    if(!job.finishedAt){
      const progress=Number(job.recorder?.lastProgressAt),start=Number(rec.startedAt);
      if(progress>=start&&progress<=Date.now())this.store.set(rec,{finishedAt:progress,finishedAtSource:'last-recorded-progress'});
      else if(job.status==='recording'){
        const times=[];for(let i=1;i<=rec.part;i++)try{times.push(fs.statSync(rec.flvPath(i)).mtimeMs);}catch{}
        if(times.length)this.store.set(rec,{finishedAt:Math.max(...times),finishedAtSource:'last-source-write'});
      }
    }
    if(!this.admitted.has(id)&&this.quietInfo().active)return this.deferQuiet(rec,view,job.phase||'seal');
    this.running.add(id);
    try{
      this.store.set(rec,{status:'recovering',waitReason:'',nextAttemptAt:0,...(manual?{attempts:0}:{})});
      if(job.phase==='publish')return this.publish(rec,job.publicationStatus||'done');
      await stopOrphanWriter(job);
      if(this.closing||this.store.get(id)?.status==='canceled')return {ok:true,canceled:true};
      if(job.phase==='post'&&!rec.issues.length){
        this.store.set(rec,{status:'queued',nextAttemptAt:0});this.s.post.enqueue({id,recorder:rec,danmakuFile:rec.base+'.danmaku.jsonl',nickname:job.nickname,settings:rec.settings,mergeComplete:true,view});return {ok:true};
      }
      if(this.closing)return {ok:false,deferred:true,error:'恢复已保留，下次启动继续'};
      this.s.post.finish(view,'processing');view.stage='恢复录像';
      return await this.trackSeal(this.seal(rec,view));
    }catch(e){return this.failed(rec,e,job.phase||'seal',view);}
    finally{this.running.delete(id);}
  }
  async scan(){
    const dirs=recordingDirs(this.s.outDir);const groups=new Map();
    for(const dir of dirs){
      const names=await fs.promises.readdir(dir);
      for(const file of names){
        if(isFinalVideoName(file))continue;
        const m=file.match(/^(.*_(\d{6,13})_(\d{8})_(\d{6})(?:_\d+)?)_part(\d+)(?:_弹幕版)?\.(?:flv|mp4)(?:\.pending\.mp4)?$/);
        if(!m)continue;
        const base=path.join(dir,m[1]);if([...this.store.jobs.values()].some(j=>j.base===base))continue;
        const n=+m[5];if(n<1||n>100000)continue;
        const group=groups.get(base)||{base,rid:m[2],date:m[3],time:m[4],part:0};group.part=Math.max(n,group.part);groups.set(base,group);
      }
    }
    for(const g of groups.values()){
      const rec=new Recorder(g.base);rec.settings={...this.s.cfg.settings};rec.part=g.part;
      if(Array.from({length:rec.part},(_,i)=>i+1).every(i=>fs.existsSync(rec.burnOutPath(i))&&(!rec.settings.keepRaw||fs.existsSync(rec.mp4Path(i)))))continue;
      if(!rec.settings.burnDanmaku&&Array.from({length:rec.part},(_,i)=>i+1).every(i=>fs.existsSync(rec.mp4Path(i))))continue;
      const d=g.date,t=g.time;rec.startedAt=new Date(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6),+t.slice(0,2),+t.slice(2,4),+t.slice(4)).getTime();
      rec.partStarts=[0];for(let i=1;i<=rec.part;i++){
        let at=rec.startedAt;for(const f of [rec.flvPath(i),rec.mp4Path(i)])try{const s=await fs.promises.stat(f);at=i===1?rec.startedAt:s.birthtimeMs||s.mtimeMs;break;}catch{}
        rec.partStarts[i]=at;
      }
      if(rec.part>1)rec.notices.push('旧录像缺少精确分片记录，弹幕时间轴按文件创建时间推定');
      const nickname=path.basename(rec.base).split('_'+g.rid+'_')[0];
      this.store.set(rec,{status:'recovering',phase:'seal',rid:g.rid,nickname,outputDir:this.s.outDir,secs:0,attempts:0,ownerPid:0,error:'发现待恢复录像'});
    }
  }
  async start({background=false}={}){
    const initial=[];
    try{await this.scan();}catch(e){log.warn('[jobs] 恢复扫描暂未完成:',e.message);}
    for(const job of [...this.store.jobs.values()].sort((a,b)=>this.orderOf(a.id)-this.orderOf(b.id))){
      if(this.closing)break;
      if(job.status==='canceled')continue;
      if(DONE.has(job.status)){
        if(job.publicationPlan?.length)try{this.migrateNames(job);}catch(error){log.error('[names] 历史命名待修复:',job.id,error.message);}
        if(!job.publicationPlan?.length){
          const rec=this.bind(restoreRecorder(job,Recorder));
          if(videoFiles(rec,job).length)try{this.publish(rec,job.status,false);}catch(e){this.failed(rec,e,'publish');}
        }
        continue;
      }
      if(!path.isAbsolute(job.base)||!/_\d{6,13}_\d{8}_\d{6}(?:_\d+)?$/.test(path.basename(job.base)))continue;
      const rec=restoreRecorder(job,Recorder),view=this.view(rec,job);
      if(job.status==='paused'||job.userPaused){
        try{await stopOrphanWriter(job);}catch(e){
          this.store.set(rec,{status:'waiting',waitReason:'user',error:e.message,nextAttemptAt:0});
          this.s.post.finish(view,'waiting',e.message);continue;
        }
        this.bind(rec);rec._processingPaused=true;
        if(job.phase!=='post'){
          view.status='paused';view.stage='已暂停';
          this.executions.set(job.id,{rec,view,restored:true});continue;
        }
        this.s.post.enqueue({id:job.id,recorder:rec,danmakuFile:rec.base+'.danmaku.jsonl',nickname:job.nickname,settings:rec.settings,mergeComplete:true,view,paused:true});
        continue;
      }
      if(job.status==='failed'&&!job.nextAttemptAt||job.status==='warning'){this.s.post.finish(view,job.status,job.error);continue;}
      this.s.post.finish(view,'waiting',job.error||'等待恢复');
      // 旧进程已经退出，原先的录制任务现转为封存恢复。
      if(job.status==='recording')this.store.set(rec,{status:'recovering',phase:'seal',ownerPid:job.ownerPid});
      if(background)this.requestRetry(job.id);else initial.push(this.retry(job.id));
    }
    if(!this.closing){this.timer=setInterval(()=>this.tick(),10000);this.timer.unref();}
    if(!background)await Promise.allSettled(initial);
  }
  async tick(){
    if(this.closing||this.ticking)return;this.ticking=true;
    try{
      if(this.store.error)this.store.persist();
      for(const job of [...this.store.jobs.values()].sort((a,b)=>this.orderOf(a.id)-this.orderOf(b.id))){
        if(this.closing)break;
        if(job.historyError){const rec=restoreRecorder(job,Recorder);this.updateHistory(rec,job,job.status,job.error||'');}
        if(job.waitReason==='quiet'&&job.status==='waiting'){
          if(!this.quietInfo().active&&!job.userPaused)this.requestRetry(job.id);
        }else if(!job.userPaused&&['waiting','failed','recovering'].includes(job.status)&&job.nextAttemptAt&&job.nextAttemptAt<=Date.now())this.requestRetry(job.id);
      }
      this.s.post._drain();
    }finally{this.ticking=false;}
  }
  deferForExit(rec,view,phase){
    const old=this.store.get(rec.jobId);if(!old||DONE.has(old.status))return;
    const paused=!!old.userPaused;
    this.store.set(rec,{status:paused?'paused':'waiting',phase:phase||old.phase||'seal',userPaused:paused,waitReason:paused?'user':'',nextAttemptAt:0,error:''});
    if(this.store.error)throw Error('无法保存待恢复任务：'+this.store.error);
    if(view)this.s.post.finish(view,paused?'paused':'waiting');
  }
  prepareExit(){
    this.deferOnExit=true;this.closing=true;clearInterval(this.timer);
    for(const job of [...this.s.post.queue,...this.s.post.running])this.deferForExit(job.recorder,job.view,'post');
    for(const entry of this.executions.values())this.deferForExit(entry.rec,entry.view,'seal');
    for(const entry of this.executions.values())if(!entry.restored){entry.rec._exitDeferred=true;entry.rec._processingPaused=false;entry.rec._abortFfmpeg();}
    this.sealPool.drain();this.mediaPool.drain();
  }
  close(){this.closing=true;clearInterval(this.timer);this.sealPool.close();for(const entry of this.executions.values())if(entry.rec._processingPaused&&!entry.restored){entry.rec._shutdownPaused=true;entry.rec._userAbort=true;entry.rec._abortFfmpeg();this.sealPool.drain();}}
}
module.exports={RecoveryController};
