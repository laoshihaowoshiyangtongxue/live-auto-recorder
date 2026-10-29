// 后处理队列: 弹幕 jsonl → 每任务独立 ASS → 调用 Recorder 烧录弹幕版
// 本模块只做队列编排与文件读写, 所有 ffmpeg 执行都经由 Recorder 内部的白名单封装
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID}=require('node:crypto');
const log = require('../util/log');
const {isHumanComment}=require('./danmaku');
const {splitRecorder}=require('./upload-split');

// ASS 坐标系固定 1088x1920, libass 会自动缩放到实际视频尺寸
const PLAY_W = 1088;
const PLAY_H = 1920;

function fmtAssTime(sec) {
  sec = Math.max(0, sec);
  const cs = Math.floor((sec % 1) * 100);
  const p = (n) => String(n).padStart(2, '0');
  return `${Math.floor(sec / 3600)}:${p(Math.floor(sec / 60) % 60)}:${p(Math.floor(sec) % 60)}.${p(cs)}`;
}

function textWidth(text, fsz) {
  let w = 0;
  for (const ch of text) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? fsz : fsz * 0.56;
  return w;
}

function commentText(entry) {
  const original=String(entry.text||'');
  if(/^[^：:]{1,30}[：:]/.test(original)&&!isHumanComment(original))return '';
  const body=typeof entry.body==='string'?entry.body:original.replace(/^[^：:]{1,30}[：:]\s*/, '');
  // Older captures may contain several anonymized usernames in one truncated
  // list snapshot. Their message boundaries cannot be recovered reliably.
  if(/[^\s：:]{0,30}\*{3,}[^\s：:]{0,15}[：:]/.test(body))return '';
  return body;
}

function genAss(entries) {
  const fsz = Math.max(24, Math.round(PLAY_H * 0.03));
  const lineH = Math.round(fsz * 1.4);
  const lanes = Math.max(4, Math.floor((PLAY_H * 0.6) / lineH));
  const laneFree = new Array(lanes).fill(0);
  const DUR = 9;
  const head =
    '[Script Info]\nScriptType: v4.00+\nPlayResX: ' + PLAY_W + '\nPlayResY: ' + PLAY_H +
    '\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\n' +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    'Style: Danmaku,Microsoft YaHei,' + fsz + ',&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n' +
    '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  const lines = [];
  for (const e of entries) {
    // Capture keeps "username: comment" for deduplication and attribution;
    // the video displays only the comment, including any colons inside it.
    const text = commentText(e)
      .replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
    if (!text) continue;
    const start = Math.max(0, e.vt);
    const wpx = textWidth(text, fsz);
    let lane = -1;
    for (let i = 0; i < lanes; i++) if (laneFree[i] <= start) { lane = i; break; }
    if (lane < 0) {
      lane = 0;
      for (let i = 1; i < lanes; i++) if (laneFree[i] < laneFree[lane]) lane = i;
    }
    laneFree[lane] = Math.max(laneFree[lane], start) + DUR; // 释放间隔=显示时长(3.6会导致同泳道重叠5.4s)
    const y = 30 + lane * lineH;
    const x1 = Math.round(PLAY_W + 20);
    const x2 = Math.round(-wpx - 20);
    lines.push('Dialogue: 0,' + fmtAssTime(start) + ',' + fmtAssTime(start + DUR) +
      ',Danmaku,,0,0,0,,{\\move(' + x1 + ',' + y + ',' + x2 + ',' + y + ')}' + text);
  }
  return head + lines.join('\n') + '\n';
}

// 退出时取消尚未完成的阶段；正常暂停通过挂起进程保留进度。
class PauseSignal extends Error {
  constructor() { super('用户暂停'); this.name = 'PauseSignal'; }
}

class PostProcessor {
  constructor(assFilePath, settings) {
    this.assFile = path.resolve(assFilePath); // 独立字幕文件使用此目录
    this.s = settings; // {burnDanmaku, keepRaw, postConcurrency}
    this.queue = [];
    this.running = new Set(); // 并发车道上的任务
    this._seq = 0;
    this.current = null; // 兼容引用(最近启动的任务)
    this.onUpdate = () => {};
    this.history = [];
    this.items = []; // 可视化任务项(含已完成, 上限30)
    this.watchdog=setInterval(()=>this._drain(),5000);this.watchdog.unref?.();
  }

  // 并发车道数(设置实时生效): 1=与旧版串行行为一致
  concurrencyTarget() {
    return Math.max(1, Math.min(4, Number(this.s && this.s.postConcurrency) || 1));
  }

  get activeCount(){return [...this.running].filter(job=>!job.paused).length;}
  get busy() { return this.activeCount > 0; }

  get status() {
    const active = this.items.filter(v => ['processing', 'burning', 'queued'].includes(v.status));
    const pausedCount = this.items.filter(v => v.status === 'paused').length;
    return {
      busy: this.busy || active.length > 0,
      current: active.length ? { name: active[0].name, stage: active[0].stage } : null,
      pending: this.queue.length,
      concurrency: this.concurrencyTarget(),
      running: this.activeCount,
      pausedCount,
      quiet: this.quietInfo ? this.quietInfo() : {active:false},
      items: this.items.map((v) => ({ ...v })),
    };
  }

  get hasRunnable() { return this.queue.some(job=>!job.paused&&(!this.canStart||this.canStart(job))); }

  begin(recorder, nickname) {
    const view = { name: nickname || '', partsTotal: recorder.part || 1,
      partsDone: 0, partIdx: 0, partPct: 0, status: 'processing',
      stage: '正在收尾', error: '', at: Date.now() };
    this.items.push(view);
    const completed = this.items.filter(v => ['done','recovered','skipped'].includes(v.status));
    for (const old of completed.slice(0, Math.max(0, this.items.length - 30))) this.items.splice(this.items.indexOf(old), 1);
    this.bindProgress(recorder, view);
    this.onUpdate();
    return view;
  }

  bindProgress(recorder, view) {
    recorder.onStage = stage => { recorder.processingStage=stage;if(view.status!=='paused'){view.stage = stage; view.progress = null;this.onUpdate();} };
    recorder.onProgress = progress => { if(view.status!=='paused'){view.progress = progress; this.onUpdate();} };
    recorder.onResourceWait=()=>{if(view.status!=='paused'){view.stage='等待处理资源';this.onUpdate();}};
    recorder.onResourceReady=()=>{if(view.status!=='paused'){view.stage=recorder.processingStage||'正在处理';this.onUpdate();}};
  }

  finish(view, status, error = '') {
    if (!view) return;
    view.status = status; view.error = error; view.stage = ''; view.progress = null;
    this.onUpdate();
  }

  enqueue(job) {
    const duplicate=[...this.queue,...this.running].find(j=>j.id&&j.id===job.id);
    if(duplicate)return duplicate;
    // job: {recorder, danmakuFile, nickname}
    if (!job.postId) job.postId = 'q' + (++this._seq) + '-' + Date.now().toString(36);
    // 可视化任务项: 队列/进度/完成状态
    job.view = job.view || this.begin(job.recorder, job.nickname);
    job.view.postId = job.postId;
    Object.assign(job.view, {
      name: job.view.name || job.nickname || '',
      partsTotal: job.recorder.part || 1,
      partsDone: 0,
      partIdx: 0,
      partPct: 0,
      status: job.paused ? 'paused' : 'queued', // queued | burning | paused | done | failed
      progress: null,
      stage: job.paused ? '已暂停' : '等待弹幕烧录',
      error: '',
      at: Date.now(),
    });
    this.queue.push(job);
    this.onUpdate();
    this._drain();
    return job;
  }

  // 单任务暂停：挂起媒体进程，保留当前输出，释放执行名额。
  pauseTask(id) {
    if(this.shuttingDown)return {ok:false,error:'程序正在退出，任务状态已保留'};
    const job = this._find(id);
    if (!job) return { ok: false, error: '未找到该任务' };
    if (job.paused&&!job.resuming) return { ok: true };
    if(job.resuming)job.resumeCanceled=true;
    try{job.recorder.pauseProcessing?.();}catch(e){return {ok:false,error:e.message};}
    job.paused = true;
    job.pausedStage=job.view?.stage;
    if (job.view) { job.view.status = 'paused'; job.view.stage = '已暂停'; }
    this.onState?.(job,'paused');
    this.onUpdate();
    this._drain();
    return { ok: true };
  }

  // 单任务恢复：获得资源后恢复同一媒体进程。
  async resumeTask(id) {
    if(this.shuttingDown)return {ok:false,error:'程序正在退出，任务状态已保留'};
    const job = this._find(id);
    if (!job) return { ok: false, error: '未找到该任务' };
    if (!job.paused) return { ok: true };
    if(job.resuming)return {ok:false,error:'任务正在等待恢复资源'};
    job.resuming=true;job.resumeCanceled=false;let resumed;
    try{resumed=await job.recorder.resumeProcessing?.();}catch(e){return {ok:false,error:e.message};}finally{job.resuming=false;}
    if(job.resumeCanceled||resumed===false)return {ok:true,paused:true};
    if(this.shuttingDown)return {ok:false,error:'程序正在退出，任务状态已保留'};
    job.paused = false;
    if (job.view) { job.view.status = this.running.has(job)?'burning':'queued'; job.view.stage = this.running.has(job)?job.pausedStage||'正在处理':'排队等待'; }
    this.onState?.(job,this.running.has(job)?'processing':'queued');
    this.onUpdate();
    this._drain();
    return { ok: true };
  }

  // 调整排队顺序(仅队列中的任务可移动)
  moveTask(id, dir) {
    const i = this.queue.findIndex(j => j.postId === id);
    if (i < 0) return { ok: false, error: '仅排队中的任务可调整顺序' };
    const t = i + (dir === 'up' ? -1 : 1);
    if (t < 0 || t >= this.queue.length) return { ok: false, error: '已到队首/队尾' };
    [this.queue[i], this.queue[t]] = [this.queue[t], this.queue[i]];
    this.onUpdate();
    return { ok: true };
  }

  _find(id) {
    return this.queue.find(j => j.postId === id||j.id===id) || [...this.running].find(j => j.postId === id||j.id===id);
  }

  // 并发车道池: 每车道串行处理一个任务; 车道数=设置 postConcurrency(1=旧版串行行为)
  _drain() {
    if(this.deferOnExit)return;
    const max = this.concurrencyTarget();
    while (this.activeCount < max) {
      const index = this.queue.findIndex(job => !job.paused && (!this.canStart || this.canStart(job)));
      if (index < 0) {
        if (this.running.size === 0) {
          for (const pending of this.queue) if (pending.view?.status !== 'quiet' && !pending.paused) this.onDeferred?.(pending);
        }
        break;
      }
      const [job] = this.queue.splice(index, 1);
      this.running.add(job);
      this.onStart?.(job);
      this.current = job;
      if (job.view) { job.view.status = 'burning'; job.view.stage = '准备弹幕'; }
      this.onUpdate();
      this._runLane(job);
    }
    this.onUpdate();
  }

  async _runLane(job, lane) {
    try {
      const result = await this._process(job, lane);
      if(job.canceled||job.exitDeferred)throw new Error('任务已停止');
      const warnings=job.recorder.issues||[],notices=job.recorder.notices||[];
      this.finish(job.view, warnings.length ? 'warning' : notices.length?'recovered':result && result.skipped ? 'skipped' : 'done', warnings.join('; ')||notices.join('; '));
      if(this.onResult)this.onResult(job,null,result);
    } catch (e) {
      if(job.canceled||job.exitDeferred){} else if (e instanceof PauseSignal) {
        // 回队首: 恢复时优先续烧(已烧分片自动跳过)
        this.finish(job.view, 'paused', '已暂停');
        this.queue.unshift(job);
      } else {
        this.finish(job.view, 'failed', String(e.message).slice(0, 180));
        log.error('[post] 任务失败:', e.message);
        try{if(this.onResult)this.onResult(job,e);}catch(error){log.error('[post] 失败状态保存异常:',error.message);}
      }
    }
    job.recorder.onStage = null;
    job.recorder.onProgress = null;
    job.recorder.onResourceWait=null;job.recorder.onResourceReady=null;
    this.running.delete(job);
    if (this.current === job) this.current = null;
    this.onUpdate();
    this._drain();
  }
  prepareExit(){this.shuttingDown=true;this.deferOnExit=true;for(const job of this.running){job.exitDeferred=true;job.recorder._exitDeferred=true;job.recorder._processingPaused=false;job.recorder._abortFfmpeg?.();}this.queue.length=0;}
  prepareShutdown(){this.shuttingDown=true;for(const job of this.running)if(job.paused){job.recorder._userAbort=true;job.recorder._abortFfmpeg?.();}}
  close(){clearInterval(this.watchdog);}

  async _process(job, lane) {
    const { recorder, danmakuFile, nickname } = job;
    const settings = job.settings || this.s;
    if (!settings.burnDanmaku) {if(typeof recorder.mp4Path==='function')await splitRecorder(recorder);return { skipped: true };}
    if (job.paused) throw new PauseSignal();
    await recorder.recoverPublications?.();
    if (job.paused) throw new PauseSignal();
    let entries = [];
    try {
      let invalid=0,filtered=0;
      for(const line of fs.readFileSync(danmakuFile,'utf8').split('\n').filter(l=>l.trim())){
        try{const e=JSON.parse(line);if(!e||!Number.isFinite(Number(e.t))||typeof e.text!=='string')throw Error('invalid comment');if(!commentText(e).trim()){filtered++;continue;}entries.push({...e,t:Number(e.t)});}
        catch{invalid++;}
      }
      if(invalid){const notice=`已跳过${invalid}条损坏弹幕记录，其余弹幕继续处理，原数据已保留`;recorder.notices=recorder.notices||[];if(!recorder.notices.includes(notice))recorder.notices.push(notice);log.warn('[post]',notice);}
      if(filtered){const notice=`已过滤${filtered}条系统通知或多消息混合记录，原始弹幕文件已保留`;recorder.notices=recorder.notices||[];if(!recorder.notices.includes(notice))recorder.notices.push(notice);log.warn('[post]',notice);}
    } catch(e) {
      if(e.code!=='ENOENT')throw new Error('弹幕文件读取失败，原录像已保留: '+e.message);
      const notice='本场没有保存到弹幕数据，弹幕版保留完整画面';recorder.issues=recorder.issues||[];if(!recorder.issues.includes(notice))recorder.issues.push(notice);log.warn('[post]',notice);
    }
    log.info(`[post] ${nickname} 烧录弹幕版: ${recorder.part}个分片, ${entries.length}条弹幕`);
    // 单文件强保证: FLV层拼接若失败, 此处在MP4层再拼一次(多段→单文件后才烧录)
    if (!job.mergeComplete && settings.autoPartMerge && recorder.part > 1 && !(recorder.issues && recorder.issues.length)) {
      try { await recorder.consolidateMp4s(); } catch (e) { log.warn('[post] MP4兜底合并异常(按原分片处理)', e && e.message); }
    }
    let burned = 0;
    // 使用任务唯一字幕路径；完成顺序变化、暂停或调整并发数都不会覆盖其他任务。
    const laneAss = 'dm_task_'+randomUUID()+'.ass';
    const laneAssPath = path.join(path.dirname(this.assFile), laneAss);
    try {
    for (let part = 1; part <= recorder.part; part++) {
      if(job.canceled||job.exitDeferred)throw new Error('任务已停止');
      if (job.paused) throw new PauseSignal(); // 分片边界暂停点(运行中暂停经 ffmpeg 中止也会落到这里)
      const mp4 = recorder.mp4Path(part);
      const burnt=recorder.burnOutPath(part);
      let dataTime=0;try{dataTime=fs.statSync(danmakuFile).mtimeMs;}catch{}
      if(fs.existsSync(burnt)&&fs.statSync(burnt).mtimeMs>=dataTime){
        const checked=await recorder.validateMedia(burnt);
        const duration=fs.existsSync(mp4)?await recorder._probeDuration(mp4):0;
        const outDuration=checked.ok?await recorder._probeDuration(burnt):0;
        if(checked.ok&&outDuration>0&&(!duration||Math.abs(duration-outDuration)<=1)){
          burned++;if(job.view){job.view.partsDone=part;job.view.partPct=100;}
          if(!settings.keepRaw&&fs.existsSync(mp4))fs.unlinkSync(mp4);
          recorder.checkpoint?.();continue;
        }
      }
      if (!fs.existsSync(mp4)) {
        if(!recorder.emptyParts?.has(part)){
          const issue=`分片${part}原片缺失，不能确认双版本完整`;recorder.issues=recorder.issues||[];
          if(!recorder.issues.some(s=>s.includes(`分片${part}`)))recorder.issues.push(issue);
        }
        continue;
      }
      const minMB = +settings.minSizeMB || 0;
      if (minMB > 0 && fs.statSync(mp4).size < minMB * 1048576) {
        log.warn(`[post] 分片${part}小于最小处理文件${minMB}MB, 跳过烧录`);
        continue;
      }
      const partT0 = recorder.partStarts[part] || recorder.startedAt;
      const partT1 = part < recorder.part ? (recorder.partStarts[part + 1] || Infinity) : Infinity;
      // 合并后的时间轴重定位: 拼接剔除了墙钟间隙(暂停/断流), 弹幕须换算到拼接后视频坐标:
      //   找到该条弹幕所属段(墙钟起点数组) → 新位置 = Σ之前各段视频时长 + (t − 段墙钟起点)
      // 例: 录1分钟→暂停2分钟→恢复, 恢复后的弹幕落在视频 1:00 而非 3:00
      const segDurs = recorder.mergedDurations || null;
      const segStarts = recorder.mergedSegStarts || null;
      const merged = recorder.part === 1 && segDurs && segStarts && segDurs.length > 1;
      const remap = (tMs) => {
        if (!merged) return (tMs - partT0) / 1000;
        let seg = segStarts.length - 1;
        for (let i = 0; i < segStarts.length; i++) { if (tMs < segStarts[i]) { seg = i - 1; break; } }
        if (seg < 0) seg = 0;
        let before = 0;
        for (let i = 0; i < seg; i++) before += segDurs[i] || 0;
        // 段内位置封顶到该段视频时长: 暂停/断流间隙收到的弹幕归到前段末尾, 不越界
        const replayOffset = (recorder.mergedReplayOffsets && recorder.mergedReplayOffsets[seg]) || 0;
        const within = Math.min((tMs - segStarts[seg]) / 1000 + replayOffset, segDurs[seg] || Infinity);
        return before + Math.max(0, within);
      };
      const partEntries = entries
        .filter((e) => e.t >= partT0 && e.t < partT1)
        .map((e) => ({ ...e, vt: remap(e.t) }));
      if (!partEntries.length) {
        log.info(`[post] 分片${part}无弹幕, 仍生成完整弹幕版文件`);
      }
      const resuming=recorder.burnCheckpoint?.part===part&&fs.existsSync(burnt+'.pending.mp4');
      recorder.assertSpace?.(resuming?0:Math.max(64*1024**2,fs.statSync(mp4).size*4),resuming?'恢复弹幕检查':'准备弹幕烧录');
      fs.writeFileSync(laneAssPath, genAss(partEntries), 'utf8');
      // Progress comes from the encoder's media clock, never file size.
      if (job.view) {
        job.view.partIdx = part;
        job.view.partPct = 0;
      }
      const r = await recorder.burnPartDanmaku(part, laneAss);
      if(job.canceled||job.exitDeferred)throw new Error('任务已停止');
      if (job.view) {
        job.view.partsDone = part;
        job.view.partPct = 100;
        this.onUpdate();
      }
      if (r.ok) {
        const out = recorder.burnOutPath(part);
        log.info(`[post] 弹幕版 OK (${r.vcodec}) ${(fs.statSync(out).size / 1048576).toFixed(1)}MB ${path.basename(out)}`);
        this.history.push({ name: nickname, file: path.basename(out), vcodec: r.vcodec, at: Date.now() });
        burned++;
        if (!settings.keepRaw) {
          try { fs.unlinkSync(mp4); } catch {}
        }
        recorder.checkpoint?.();
      } else if (r.aborted) {
        throw new PauseSignal();
      } else {
        // 抛给车道标记 failed: 只写日志会让界面显示"完成"而弹幕版根本没生成
        throw new Error(`分片${part}烧录失败: ${String(r.stderr).slice(0, 120)}`);
      }
    }
    try { fs.unlinkSync(laneAssPath); } catch {}
    if(typeof recorder.mp4Path==='function')await splitRecorder(recorder);
    return { skipped: burned === 0 };
    } finally {
      try { fs.unlinkSync(laneAssPath); } catch {} // 暂停中止/异常路径也清车道字幕
    }
  }
}

module.exports = { PostProcessor, genAss, PauseSignal };
