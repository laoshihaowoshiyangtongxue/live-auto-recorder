// 录制引擎：ffmpeg 子进程封装
// - 流直拷(-c copy) 零转码
// - 异常退出自动换新分片重启（由调度器的 canRestart 决定是否继续）
// - 优雅停止: stdin 'q' → 8秒强杀兜底
// - 停止后异步无损转封装 FLV→MP4
const { spawn: spawnRaw } = require('node:child_process');
// spawn 包装: 一律注入 windowsHide, 防止 ffmpeg 控制台黑窗弹出
const spawn = (cmd, argv, opts) => spawnRaw(cmd, argv, Object.assign({}, opts, { windowsHide: true }));
const fs = require('node:fs');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');
const log = require('../util/log');
const { UA } = require('../util/const');
const { parsePacketHashes, createPacketHashParser, overlapCut, hasMediaErrors } = require('./media');
const { inspectFlvTailAsync } = require('./flv-tail-async');
const { pipeline } = require('node:stream/promises');
const {assertSpace,DiskSpaceError}=require('./disk-space');
const {MediaExecution}=require('./media-execution');

function mediaIdentity(file){
  try{const s=fs.statSync(file,{bigint:true});if(!s.isFile()||s.ino===0n)return null;
    const content=[s.dev,s.ino,s.size,s.mtimeNs].join(':');
    return {content,full:content+':'+s.ctimeNs};
  }catch{return null;}
}

// 安全校验: 只接受 http(s) 直链, 拒绝以 '-' 开头(防 ffmpeg 参数注入)
function assertSafeUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url) || url.startsWith('-')) {
    throw new Error('流地址校验失败(仅允许http/https直链): ' + String(url).slice(0, 80));
  }
}

// 安全校验: 本地路径必须绝对路径、不以 '-' 开头、必须落在本次录制的输出前缀下
function assertSafePath(p, basePrefix) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.startsWith('-') || !p.startsWith(basePrefix)) {
    throw new Error('路径校验失败: ' + String(p).slice(0, 120));
  }
}

// 固定请求头(纯字面量常量)
const FFMPEG_HEADERS = 'Referer: https://live.douyin.com/\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\n';

class Recorder {
  constructor(basePath) {
    this.base = basePath; // 不含扩展名
    this.part = 0;
    this.partStarts = []; // partStarts[n] = 第n分片起录墙钟时间(供弹幕对齐)
    this.proc = null;
    this.stopped = false;
    this.paused = false;
    this.rotating = false;
    this.startedAt = 0;
    this.canRestart = () => false;
    this.bytes = 0;
    this.restarts = [];   // 重启时间点(重启风暴检测)
    this.cooldownUntil = 0;
    this.restartTimer = null;
    this.watchdog = null;
    this.issues = [];
    this.notices = [];
    this.emptyParts = new Set(); // confirmed failed attempts with no recorded bytes
    this._openParts=new Set();this._closedParts=new Set();
    this.stallTimeoutMs = 15000;
  }

  flvPath(part) { return `${this.base}_part${part}.flv`; }
  mp4Path(part) { return `${this.base}_part${part}.mp4`; }
  checkpoint(){if(this.onCheckpoint)return this.onCheckpoint();}
  assertSpace(extra=0,phase='处理'){
    assertSpace(path.dirname(this.base),(+this.settings?.minFreeGB||0)*1024**3,extra,phase,this.availableBytes);
  }

  start(url) {
    assertSafeUrl(url);
    this.url = url;
    this.startedAt = Date.now();
    this.lastProgressAt = this.startedAt;
    this._spawn();
  }

  _spawn() {
    if (this.stopped || this.paused || (this.proc && this.proc.exitCode === null && !this.proc.signalCode)) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    clearInterval(this.watchdog);
    this.part += 1;
    this.partStarts[this.part] = Date.now();
    this.checkpoint();
    const out = this.flvPath(this.part);
    assertSafePath(out, this.base);
    let input;
    try {
      assertSafeUrl(this.url);
      input = this.url;
    } catch (e) {
      log.error('[rec] 拒绝启动, ', e.message);
      this.stopped = true;
      return;
    }
    log.info(`[rec] ffmpeg 启动 part${this.part}: ${path.basename(out)}`);
    const args = [
      '-y',
      '-rw_timeout', '15000000',
      '-headers', FFMPEG_HEADERS,
      '-i', input,
      '-c', 'copy',
      '-flvflags', 'no_duration_filesize',
      '-progress', 'pipe:1', '-stats_period', '1', '-nostats',
      '-loglevel', 'warning',
      out,
    ];
    this.proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.processId=this.proc.pid;this.checkpoint();
    const child = this.proc;
    const part = this.part;
    this._openParts.add(part);
    let handled = false;
    const ended = (code) => {
      if (handled) return;
      handled = true;
      this._openParts.delete(part);this._closedParts.add(part);
      try{this.onPartClosed?.({part,file:this.flvPath(part)});}catch(e){log.warn('[rec] 文件关闭状态暂未保存:',e.message);}
      if (this.proc === child) this.proc = null;
      clearInterval(this.watchdog);
      this._onExit(code, part);
    };
    child.once('error', (e) => { log.error('[rec] 启动进程失败:', e.message); ended(-1); });
    child.once('close', ended);
    child.stdin.on('error', () => {});
    let bytes = 0, lastGrowth = Date.now(), lastMediaTime = -1, progressBuffer = '';
    child.stdout.on('data', (data) => {
      progressBuffer += data.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match && +match[1] > lastMediaTime) {
          lastMediaTime = +match[1]; lastGrowth = Date.now();
          if (lastMediaTime > 0) this.lastProgressAt = lastGrowth;
        }
      }
    });
    this.watchdog = setInterval(() => {
      if (this.stopped || this.paused || this.rotating || this.proc !== child) return;
      const size = this._sizeOf(out);
      if (size > bytes) { bytes = size; lastGrowth = Date.now(); if(size>1024)this.lastProgressAt=lastGrowth; }
      else if (Date.now() - lastGrowth >= this.stallTimeoutMs) {
        log.warn('[rec] 拉流停止增长, 结束卡住的进程以便续录');
        clearInterval(this.watchdog);
        // Give FFmpeg a chance to finish the current container packet first.
        this._gracefulKill().catch(() => { try { child.kill('SIGKILL'); } catch {} });
      }
      if(this.onCheckpoint&&Date.now()-(this._lastProgressCheckpoint||0)>=10000){this._lastProgressCheckpoint=Date.now();try{this.checkpoint();}catch(e){log.warn('[rec] 录制进度检查点保存失败:',e.message);}}
    }, 1000);
    this.watchdog.unref();
  }

  _onExit(code, part = this.part) {
    const size = this._sizeOf(this.flvPath(part));
    if (size === 0) this.emptyParts.add(part);
    this.checkpoint();
    log.info(`[rec] ffmpeg 退出 code=${code} part${this.part} ${(size / 1048576).toFixed(1)}MB`);
    if (this.stopped) return;
    if (this.paused) return;   // 主动暂停的退出, 不续录
    if (this.rotating) return; // 分段轮换的退出, rotate() 自己负责开新片, 不走自动重启
    // 异常退出：调度器仍认为在播 → 换新分片续录（带重启风暴保护）
    if (this.canRestart()) {
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 5 * 60 * 1000);
      this.restarts.push(now);
      if (this.restarts.length > 4) {
        this.cooldownUntil = now + 60 * 1000;
        log.error(`[rec] 5分钟内重启${this.restarts.length}次, 触发风暴保护, 冷却60秒`);
        this.restarts = [];
      }
      const delay = this.cooldownUntil > now ? this.cooldownUntil - now : 3000;
      log.warn(`[rec] ${Math.round(delay / 1000)}秒后重启新分片续录 ...`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.stopped) return;
        // 重启前刷新流地址(签名可能过期/换线路)
        try {
          if (typeof this.getUrl === 'function') {
            const fresh = this.getUrl();
            if (fresh) this.url = fresh;
          }
        } catch {}
        if (this.canRestart() && !this.paused && !this.rotating && Date.now() >= this.cooldownUntil) this._spawn();
        else if (!this.stopped && Date.now() < this.cooldownUntil) {
          // 冷却未过, 到点再试一次
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.stopped && this.canRestart()) this._spawn();
          }, this.cooldownUntil - Date.now() + 100).unref();
        }
      }, delay).unref();
    }
  }

  _sizeOf(p) {
    try { return fs.statSync(p).size; } catch { return 0; }
  }

  // 接口短暂误报下播时重试可能被跳过；恢复在播后补回唯一续录任务。
  ensureRunning() {
    if(this.stopped||this.paused||this.rotating||this.proc||this.restartTimer||!this.canRestart())return false;
    const delay=Math.max(3000,this.cooldownUntil-Date.now());
    this.restartTimer=setTimeout(()=>{
      this.restartTimer=null;
      if(this.stopped||this.paused||this.rotating||this.proc||!this.canRestart())return;
      try{const fresh=typeof this.getUrl==='function'&&this.getUrl();if(fresh)this.url=fresh;this._spawn();}
      catch(e){log.warn('[rec] 恢复续录失败:',e.message);}
    },delay).unref();
    return true;
  }

  totalBytes() {
    let s = 0;
    for (let i = 1; i <= this.part; i++) s += this._sizeOf(this.flvPath(i));
    return s;
  }

  // 优雅停止单个 ffmpeg 进程(q → 8秒强杀兜底)
  _gracefulKill() {
    return new Promise((resolve) => {
      const p = this.proc;
      if (!p || p.exitCode !== null) return resolve();
      const killer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch {}
      }, 8000);
      p.once('close', () => { clearTimeout(killer); resolve(); });
      try { p.stdin.write('q\n'); } catch { try { p.kill(); } catch {} }
    });
  }

  // 结束整场录制(不可再续)
  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.watchdog);
    return this._gracefulKill();
  }

  // 暂停录制(本场任务保留, 可 resume 续录新分片)
  pause() {
    this.paused = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.watchdog);
    log.info('[rec] 暂停录制');
    return this._gracefulKill();
  }

  // 继续录制: 换新分片续录(url 可为刷新后的流地址)
  resume(url) {
    if (this.stopped || !this.paused) return false;
    if (url) assertSafeUrl(url);
    this.paused = false;
    if (typeof url === 'string' && url) this.url = url;
    if (this.proc && this.proc.exitCode === null) return true; // 已在运行
    this._spawn();
    return true;
  }

  // 定时分段: 优雅结束当前分片并立即开新分片(不影响任务连续性)
  async rotate() {
    if (this.stopped || this.paused || this.rotating) return false;
    this.rotating = true;
    log.info('[rec] 定时分段, 换新分片');
    await this._gracefulKill();
    this.rotating = false;
    if (!this.stopped && !this.paused) {
      const fresh = typeof this.getUrl === 'function' && this.getUrl();
      if (fresh) this.url = fresh;
      this._spawn();
    }
    return true;
  }

  // 取媒体时长(秒, 失败返回0) — 供合并后弹幕时间轴重对齐
  // ffmpeg-static 不带 ffprobe: 复用 _runFfmpeg(数组参数)跑 ffmpeg -i, 从 Duration 行解析
  // 调用方仅有 mergeParts/consolidateMp4s, 传入路径均产自 flvPath/mp4Path(已过校验的前缀)
  async _probeDuration(file) {
    const before=mediaIdentity(file);this._durations ||= new Map();
    const known=this._durations.get(file);if(before&&known?.identity===before.full)return known.duration;
    const r = await this._runFfmpeg(['-i', file], 15000);
    const m = String(r.stderr).match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    const duration=m?+m[1]*3600+ +m[2]*60+ +m[3]:0;
    if(duration>0&&before&&mediaIdentity(file)?.full===before.full){this._durations.set(file,{identity:before.full,duration});if(this._durations.size>32)this._durations.delete(this._durations.keys().next().value);}
    return duration;
  }

  // 执行 ffmpeg(参数数组, 不经 shell), 超时强杀, 返回 {code, stderr}
  async _runFfmpeg(args, timeoutMs, captureStdout = false, duration = 0) {
    const work=async()=>{
      if(this._exitDeferred){const e=Error('退出时暂停处理');e.code='LR_EXIT_DEFERRED';throw e;}
      if(this._canceled){const e=Error('任务已取消');e.code='LR_CANCELED';throw e;}
      if(this._shutdownPaused){const e=Error('暂停任务留待下次启动');e.code='LR_USER_PAUSED';throw e;}
      if(this._userAbort)return {code:-1,stderr:'用户暂停',stdout:'',aborted:true};
      const execution=new MediaExecution(this,args,timeoutMs,captureStdout,duration,ffmpegPath);
      this._execution=execution;
      try{const result=await execution.run();if(this._exitDeferred){const e=Error('退出时暂停处理');e.code='LR_EXIT_DEFERRED';throw e;}if(this._canceled){const e=Error('任务已取消');e.code='LR_CANCELED';throw e;}if(this._shutdownPaused){const e=Error('暂停任务留待下次启动');e.code='LR_USER_PAUSED';throw e;}if(result.sourceBusy){const e=Error(result.stderr);e.code='LR_SOURCE_BUSY';throw e;}return result;}finally{if(this._execution===execution)this._execution=null;}
    };
    const result=(this._mediaTail||Promise.resolve()).then(work,work);
    this._mediaTail=result.catch(()=>{});return result;
  }
  pauseProcessing(){this._execution?.pause();this._processingPaused=true;return true;}
  async resumeProcessing(){const resumed=await this._execution?.resume();if(resumed===false)return false;this._processingPaused=false;this.mediaPool?.drain();return true;}

  // 弹幕版输出路径(与分片同名)
  burnOutPath(part) { return `${this.base}_part${part}_弹幕版.mp4`; }

  // 立即中止当前正在执行的后处理 ffmpeg(单任务暂停用; 终止而非优雅退出, pending 产物随后被清理)
  _abortFfmpeg() {
    if(this._execution){this._execution.abort();return;}
    const p = this._activeProc;
    if (p && p.exitCode === null) {
      try { p.kill(); } catch {}
      const k = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 5000);
      k.unref?.();
    }
  }

  // 烧录弹幕字幕到指定分片
  // assRelName: 项目根下的字幕文件相对名(默认 dm.ass); 并发车道各自独立文件防互相覆盖
  // 硬编优先(NVENC p5), 失败逐级回退到 NVENC 默认、x264 软编
  async burnPartDanmaku(part, assRelName) {
    this._userAbort = false; // 重置上一次暂停标记(恢复续烧用)
    const assRef = assRelName || 'dm.ass';
    const mp4 = this.mp4Path(part);
    const out = this.burnOutPath(part);
    const pending = out + '.pending.mp4';
    assertSafePath(mp4, this.base);
    assertSafePath(out, this.base);
    const sourceIdentity = mediaIdentity(mp4);
    if (!sourceIdentity) throw new Error('弹幕烧录原片缺失或无法确认身份: '+mp4);
    const sourceDuration = await this._probeDuration(mp4);
    const sourceChanged = () => mediaIdentity(mp4)?.full !== sourceIdentity.full;
    let assHash=null;
    try{assHash=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(assRef))).digest('hex');}catch{}
    const matchesCheckpoint=()=>{const c=this.burnCheckpoint;return !!(assHash&&c&&c.version===1&&c.part===part&&c.source===sourceIdentity.full&&c.assHash===assHash&&c.pending===mediaIdentity(pending)?.full);};
    const clearCheckpoint=()=>{this.burnCheckpoint=null;this.checkpoint();};
    const archivePending=()=>{
      if(!fs.existsSync(pending))return;
      const saved=out+'.interrupted-'+require('node:crypto').randomUUID()+'.mp4';
      try{fs.renameSync(pending,saved);}catch(e){throw new Error('未处理的弹幕临时文件无法保存，已停止以免覆盖: '+pending+'；'+e.message);}
      log.warn('[rec] 已保留上次中断的弹幕临时文件:',saved);
    };
    if (sourceChanged()) throw new Error('弹幕烧录原片已移动或改变，停止处理: '+mp4);
    log.info(`[rec] 烧录弹幕版 part${part}: ${path.basename(out)}`);
    // 硬编 NVENC 高质量档
    let error = '';
    const codecs = [
      ['h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '20', '-b:v', '0'],
      ['h264_nvenc'],
      ['libx264', '-preset', 'veryfast', '-crf', '20'],
    ];
    let preservePending = false;
    const preserveVerified = () => {
      preservePending = true;
      const saved = out + '.verified-recovery-' + require('node:crypto').randomUUID() + '.mp4';
      try { fs.renameSync(pending, saved); } catch (e) { throw new Error('原片已移动或改变，已校验的弹幕临时文件保留在 '+pending+'；保存备用文件失败: '+e.message); }
      throw new Error('原片已移动或改变，已校验的弹幕临时文件保留在 '+saved);
    };
    try {
      // A successful encoder exit is a durable boundary. Recheck both input
      // identities and decode the pending output before publishing it.
      if(matchesCheckpoint()){
        this.assertSpace(0,'恢复弹幕完整性检查');
        preservePending=true;this.onStage?.('恢复弹幕版完整性检查');
        const checked=await this.validateMedia(pending);
        if(sourceChanged())preserveVerified();
        const outputDuration=checked.ok?await this._probeDuration(pending):0;
        if(sourceChanged())preserveVerified();
        if(checked.ok&&sourceDuration>0&&Math.abs(sourceDuration-outputDuration)<=1){
          this._publish(pending,out);preservePending=false;const codec=this.burnCheckpoint.codec;clearCheckpoint();
          log.info('[rec] 复用上次烧录完成的弹幕临时文件:',path.basename(out));return {ok:true,vcodec:codec,resumed:true};
        }
        archivePending();preservePending=false;clearCheckpoint();
      } else if(fs.existsSync(pending)) { archivePending();clearCheckpoint(); }
      else if(this.burnCheckpoint)clearCheckpoint();
      this.assertSpace(Math.max(64*1024**2,this._sizeOf(mp4)*4),'弹幕烧录');
      for (const codec of codecs) {
        if (sourceChanged()) throw new Error('弹幕烧录原片已移动或改变，停止重试: '+mp4);
        this.onStage?.('弹幕烧录');
        const r = await this._runFfmpeg(['-y', '-i', mp4, '-vf', 'ass=' + assRef, '-c:v', ...codec,
          '-fps_mode','passthrough','-enc_time_base:v','1:1000000',
          '-c:a', 'copy', '-loglevel', 'error', pending], 86400000, false, sourceDuration);
        error = r.stderr;
        if (this._userAbort) return { ok: false, stderr: '用户暂停', aborted: true };
        if(r.spaceError||/no space left|ENOSPC/i.test(error))throw new DiskSpaceError(error);
        if (sourceChanged() && (r.code !== 0 || hasMediaErrors(r.stderr) || this._sizeOf(pending) <= 1024)) throw new Error('弹幕烧录原片已移动或改变，停止重试: '+mp4);
        if (r.code !== 0 || hasMediaErrors(r.stderr) || this._sizeOf(pending) <= 1024) continue;
        if(sourceChanged())throw new Error('弹幕烧录原片已移动或改变，停止处理: '+mp4);
        const pendingIdentity=mediaIdentity(pending);
        if(assHash&&pendingIdentity){
          this.burnCheckpoint={version:1,part,source:sourceIdentity.full,pending:pendingIdentity.full,assHash,codec:codec[0]};
          preservePending=true;
          if(this.checkpoint()===false){const e=Error('弹幕烧录进度暂未保存，临时文件已保留');e.code='LR_SOURCE_BUSY';throw e;}
        }
        const checked = await this.validateMedia(pending);
        if (!checked.ok) { error = checked.stderr; preservePending=false;clearCheckpoint();continue; }
        if (sourceChanged()) preserveVerified();
        const originalDuration=await this._probeDuration(mp4),outputDuration=await this._probeDuration(pending);
        if (sourceChanged()) preserveVerified();
        if(originalDuration<=0||Math.abs(originalDuration-outputDuration)>1){error='弹幕版时长与原片不一致，源文件已保留';preservePending=false;clearCheckpoint();continue;}
        this._publish(pending, out);preservePending=false;clearCheckpoint();
        return { ok: true, vcodec: codec[0] };
      }
      return { ok: false, stderr: error };
    } finally {
      if (!preservePending) try { fs.unlinkSync(pending); } catch {}
    }
  }

  // 相邻分片无缝合并(对齐 biliLive-tools autoPartMerge):
  // 断流重连/轮换产生的多个FLV分片 concat 直拷合并回 part1, 弹幕时间轴随 partStarts[1] 保持连续
  _processingTimeout(files) {
    const bytes = files.reduce((n, p) => n + this._sizeOf(p), 0);
    return Math.max(120000, Math.ceil(bytes / 1073741824) * 120000);
  }

  async validateMedia(file) {
    const identity=mediaIdentity(file);this._validationInFlight ||= new Map();
    const active=this._validationInFlight.get(file);if(identity&&active?.identity===identity.full)return active.promise;
    const promise=this._validateMedia(file),entry={identity:identity?.full,promise};this._validationInFlight.set(file,entry);
    try{return await promise;}finally{if(this._validationInFlight.get(file)===entry)this._validationInFlight.delete(file);}
  }
  async _validateMedia(file) {
    this.onStage?.('完整性检查');
    const before=mediaIdentity(file);
    this._validatedFiles ||= new Map();
    if(before&&this._validatedFiles.get(file)===before.full)return {ok:true,stderr:'',reused:true};
    const duration=await this._probeDuration(file);
    const r = await this._runFfmpeg(['-v', 'error', '-err_detect', 'explode', '-i', file,
      '-map', '0:v:0', '-map', '0:a?', '-fps_mode', 'passthrough', '-enc_time_base:v', '1:1000000', '-f', 'null', '-'], Math.max(this._processingTimeout([file]),Math.ceil(duration*1000)), false, duration);
    const result={ok:r.code===0&&!hasMediaErrors(r.stderr),stderr:r.stderr};
    const after=mediaIdentity(file);
    if(result.ok&&before&&after?.full!==before.full)return {ok:false,stderr:'完整性检查期间文件发生变化，保留原文件等待重新检查'};
    if(result.ok&&before&&after?.full===before.full){
      this._validatedFiles.set(file,after.full);
      if(this._validatedFiles.size>32)this._validatedFiles.delete(this._validatedFiles.keys().next().value);
    }
    return result;
  }

  async _scanVideo(file) {
    this.onStage?.('分片内容检查');
    // Parse stdout incrementally: long recordings legitimately exceed the old
    // 64 MiB text buffer. Never truncate packet evidence or kill a healthy scan.
    const parser=createPacketHashParser({edgesOnly:true});
    const r = await this._runFfmpeg(['-v', 'error', '-copyts', '-i', file, '-map', '0:v:0',
      '-c:v', 'copy', '-f', 'framehash', '-hash', 'md5', '-'], this._processingTimeout([file]), chunk=>parser.write(chunk));
    if (r.code !== 0 || hasMediaErrors(r.stderr)) throw new Error('数据包检查失败: ' + r.stderr.slice(0, 180));
    return parser.finish();
  }

  _publish(pending, destination) {
    const source=mediaIdentity(pending),verified=source&&this._validatedFiles?.get(pending)===source.full;
    const backup = destination + '.previous';
    if (fs.existsSync(backup)) throw new Error('发现尚未恢复的备份: ' + path.basename(backup));
    const existed = fs.existsSync(destination);
    if (existed) fs.renameSync(destination, backup);
    try {
      fs.renameSync(pending, destination);
    } catch (e) {
      if (existed && !fs.existsSync(destination)) fs.renameSync(backup, destination);
      throw e;
    }
    if (existed) { try { fs.unlinkSync(backup); } catch {} }
    // A rename keeps the bytes/inode, but changes ctime. Transfer only a proof
    // obtained for this exact stable file; changed/replaced files decode again.
    this._validatedFiles?.delete(pending);this._validatedFiles?.delete(destination);
    const published=mediaIdentity(destination);
    if(verified&&published?.content===source.content)this._validatedFiles.set(destination,published.full);
  }

  _commitMerge(plan){
    this.mergedDurations=plan.durations;this.mergedSegStarts=plan.starts;this.mergedReplayOffsets=plan.offsets;
    this.mergedFromParts=plan.originalParts;this.mergedInputs=plan.files.filter(f=>f!==plan.destination);this.mergeDestination=plan.destination;
    for(const part of plan.emptyParts||[])for(const file of [this.flvPath(part),this.mp4Path(part)])if(file!==plan.destination&&fs.existsSync(file)&&this._sizeOf(file)===0)this.mergedInputs.push(file);
    this.partStarts[1]=plan.starts[0];this.part=1;this.partStarts.length=2;this.emptyParts.clear();this.mergePlan=null;
    if(this.checkpoint()===false)return;
    this._cleanupMergedInputs();
  }
  _cleanupMergedInputs(){
    this.mergedInputs=(this.mergedInputs||[]).filter(file=>{
      try{assertSafePath(file,this.base);if(!new RegExp('^_part\\d+\\.(flv|mp4)$').test(file.slice(this.base.length)))return true;fs.unlinkSync(file);return false;}
      catch(e){if(e.code==='ENOENT')return false;log.warn('[rec] 合并源文件暂保留:',e.message);return true;}
    });this.checkpoint();
  }
  async recoverMergePlan(){
    const plan=this.mergePlan;
    if(!plan){
      if(this.mergedInputs?.length){
        let verified=false;for(const file of [this.flvPath(1),this.mp4Path(1),this.burnOutPath(1)])if(fs.existsSync(file)&&(await this.validateMedia(file)).ok){verified=true;break;}
        if(!verified)throw new Error('合并产物无法验证，保留全部剩余源分片');
        this._cleanupMergedInputs();
      }return;
    }
    if(![this.flvPath(1),this.mp4Path(1)].includes(plan.destination)||!Array.isArray(plan.files)||plan.files.some(f=>!f.startsWith(this.base)||!/^_part\d+\.(flv|mp4)$/.test(f.slice(this.base.length))))throw new Error('合并恢复记录无效，源文件已保留');
    const matches=file=>{try{const s=fs.statSync(file);return s.ino===plan.identity.ino&&s.dev===plan.identity.dev&&s.size===plan.identity.size;}catch{return false;}};
    const source=matches(plan.destination)?plan.destination:matches(plan.output)?plan.output:null;
    if(!source){
      if(!fs.existsSync(plan.destination)&&fs.existsSync(plan.destination+'.previous'))fs.renameSync(plan.destination+'.previous',plan.destination);
      this.mergePlan=null;this.checkpoint();return;
    }
    const checked=await this.validateMedia(source);if(!checked.ok)throw new Error('中断合并产物验证失败，全部文件已保留');
    if(source!==plan.destination){
      if(!fs.existsSync(plan.destination)&&fs.existsSync(plan.destination+'.previous'))fs.renameSync(plan.destination+'.previous',plan.destination);
      this._publish(source,plan.destination);
    }
    if(fs.existsSync(plan.destination+'.previous')){
      const dir=path.join(path.dirname(this.base),'恢复备份');fs.mkdirSync(dir,{recursive:true});
      fs.renameSync(plan.destination+'.previous',path.join(dir,path.basename(plan.destination)+'.'+Date.now()+'.previous'));
    }
    this._commitMerge(plan);
  }
  async recoverPublications(){
    const archive=file=>{const dir=path.join(path.dirname(this.base),'恢复备份');fs.mkdirSync(dir,{recursive:true});const target=path.join(dir,path.basename(file)+'.'+Date.now());if(fs.existsSync(target))throw new Error('恢复备份目标已存在，原文件保留');fs.renameSync(file,target);};
    for(let part=1;part<=this.part;part++)for(const target of [this.mp4Path(part),this.burnOutPath(part)]){
      const backup=target+'.previous';if(!fs.existsSync(backup))continue;
      if(!fs.existsSync(target))fs.renameSync(backup,target);
      else if((await this.validateMedia(target)).ok)archive(backup);
      else if((await this.validateMedia(backup)).ok){archive(target);fs.renameSync(backup,target);}
      else throw new Error('中断发布的两份文件均未通过验证，原文件已保留');
      const notice='已恢复中断的文件发布，原有产物受到保护';if(!this.notices.includes(notice))this.notices.push(notice);this.checkpoint();
    }
  }

  async reconcileParts(){
    if(this.mergedFromParts)return;
    const prefix=path.basename(this.base)+'_part',names=await fs.promises.readdir(path.dirname(this.base)),known=this.part,parts=new Map();let extra=false;
    for(const file of names){
      if(!file.startsWith(prefix))continue;const m=file.slice(prefix.length).match(/^(\d+)\.(flv|mp4)$/);if(!m)continue;
      const part=+m[1];if(part<1||part>100000||part<=known)continue;
      if(!parts.has(part)||m[2]==='flv')parts.set(part,file);
    }
    for(const [part,file] of [...parts].sort((a,b)=>a[0]-b[0])){const stat=await fs.promises.stat(path.join(path.dirname(this.base),file));this.part=Math.max(this.part,part);if(!this.partStarts[part])this.partStarts[part]=stat.birthtimeMs||stat.mtimeMs;extra=true;}
    if(extra){const note='恢复了任务记录之外的额外分片，其弹幕起点按文件创建时间推定';if(!this.notices.includes(note))this.notices.push(note);this.checkpoint();}
  }

  async _mergeFiles(extension) {
    if(this._openParts.size){const e=Error('录像文件仍在写入，关闭后自动处理');e.code='LR_SOURCE_BUSY';throw e;}
    this.onStage?.('合并分片');
    if (this.part < 2) return false;
    const files = [];
    const indices = [];
    for (let i = 1; i <= this.part; i++) {
      const file = extension === 'flv' ? this.flvPath(i) : this.mp4Path(i);
      // Only skip attempts observed to have recorded zero bytes. Missing or
      // damaged content from any other part must still block publication.
      if (this.emptyParts.has(i) && this._sizeOf(this.flvPath(i)) === 0 && this._sizeOf(this.mp4Path(i)) === 0) continue;
      // A missing/failed part must never silently disappear into a partial "complete" merge.
      if (!fs.existsSync(file) || this._sizeOf(file) <= 1024) return false;
      files.push(file);
      indices.push(i);
    }
    if (!files.length) return false;
    if (files.length === 1 && indices[0] === 1) {
      // Only empty failed retries remain: there is nothing to concatenate.
      this.part = 1;
      this.partStarts.length = 2;
      this.emptyParts.clear();
      return true;
    }
    const listPath = this.base + '_concat.txt';
    const destination = extension === 'flv' ? this.flvPath(1) : this.mp4Path(1);
    const output = destination + '.pending.' + extension;
    let scans;
    try {
      scans = [];
      for (const file of files) scans.push(await this._scanVideo(file));
      const durations = scans.map((s) => s.duration);
      const cuts = scans.map(() => null);
      for (let i = 0; i < scans.length - 1; i++) {
        const cut = overlapCut(scans[i], scans[i + 1]);
        if (cut !== null) {
          cuts[i] = cut;
          durations[i] = Math.max(0, cut - scans[i].start);
          log.info('[rec] 去除已确认的重放区: ' + (scans[i].duration - durations[i]).toFixed(3) + '秒');
        }
      }
      const lines = [];
      for (let i = 0; i < files.length; i++) {
        if (durations[i] <= 0.001) continue; // fully duplicated by the following part
        lines.push("file '" + files[i].replace(/\\/g, '/').replace(/'/g, "'\\''") + "'");
        if (cuts[i] !== null) lines.push('outpoint ' + cuts[i].toFixed(6));
        lines.push('duration ' + durations[i].toFixed(6));
      }
      if (!lines.length) return false;
      this.assertSpace(files.reduce((n,f)=>n+this._sizeOf(f),0),'合并分片');
      fs.writeFileSync(listPath, lines.join('\n'), 'utf8');
      const args = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy'];
      if (extension === 'mp4') args.push('-movflags', '+faststart');
      args.push(output);
      this.onStage?.('合并分片');
      const r = await this._runFfmpeg(args, this._processingTimeout(files), false, durations.reduce((a,b)=>a+b,0));
      if(r.spaceError||/no space left|ENOSPC/i.test(r.stderr))throw new DiskSpaceError(r.stderr);
      if (r.code !== 0 || hasMediaErrors(r.stderr) || this._sizeOf(output) <= 1024) throw new Error('拼接输出异常: ' + r.stderr.slice(0, 180));
      const validation = await this.validateMedia(output);
      if (!validation.ok) throw new Error('拼接完整性检查失败: ' + validation.stderr.slice(0, 180));
      const identity=fs.statSync(output);
      const plan={files,output,destination,identity:{ino:identity.ino,dev:identity.dev,size:identity.size},originalParts:this.part,emptyParts:[...this.emptyParts],durations,starts:indices.map(i=>this.partStarts[i]||this.startedAt),offsets:scans.map((_s,i)=>i>0&&cuts[i-1]!==null?scans[i-1].duration-durations[i-1]:0)};
      this.mergePlan=plan;if(this.checkpoint()===false)throw new Error('任务记录暂不可写，原分片保留');
      // Only commit timeline metadata after the replacement has actually succeeded.
      this._publish(output, destination);
      this._commitMerge(plan);
      log.info('[rec] 已验证并合并' + files.length + '个分片');
      return true;
    } catch (e) {
      if(['LR_DISK_SPACE','LR_SOURCE_BUSY','LR_USER_PAUSED'].includes(e.code))throw e;
      log.warn('[rec] 合并未完成, 原分片全部保留:', e.message);
      return false;
    } finally {
      try { fs.unlinkSync(listPath); } catch {}
      try { fs.unlinkSync(output); } catch {}
    }
  }

  mergeParts() { return this._mergeFiles('flv'); }

  async _recoverTail(flv, pending) {
    const inspection = await inspectFlvTailAsync(flv);
    if (!inspection.recoverable) return null;
    this.onStage?.('恢复截断尾部');
    const prefix = pending + '.tail-source.flv';
    assertSafePath(prefix, this.base);
    if (fs.existsSync(prefix)) throw new Error('尾部恢复临时文件已存在，未覆盖');
    this.assertSpace(inspection.cut+this._sizeOf(flv),'恢复截断尾部');
    const fd=fs.openSync(prefix,'wx');
    try {
      await pipeline(fs.createReadStream(flv, {end:inspection.cut-1}), fs.createWriteStream(prefix, {fd,autoClose:true}));
      const r = await this._runFfmpeg(['-y','-v','error','-i',prefix,'-c','copy','-movflags','+faststart',pending],this._processingTimeout([flv]));
      if(r.spaceError||/no space left|ENOSPC/i.test(r.stderr))throw new DiskSpaceError(r.stderr);
      if(r.code!==0 || hasMediaErrors(r.stderr) || this._sizeOf(pending)<=1024) throw new Error('尾部恢复失败: '+r.stderr.slice(0,180));
      return inspection;
    } finally { try { fs.unlinkSync(prefix); } catch {} }
  }

  async _recoverDecoded(flv,pending,error) {
    if(!/error while decoding|top block unavailable|corrupt decoded frame|Invalid NAL|missing picture|non.monoton|submitting packet to decoder|mmco:|invalid data found when processing input/i.test(error))return null;
    this.onStage?.('检查损坏画面');
    let source;
    try{source=await this._scanVideo(flv);}catch(e){if(['LR_DISK_SPACE','LR_SOURCE_BUSY','LR_USER_PAUSED'].includes(e.code))throw e;return null;}
    const sourceFrames=source.packetCount??source.packets.length;
    if(sourceFrames<30)return null;
    for(const codec of [['h264_nvenc','-preset','p5','-rc','vbr','-cq','20','-b:v','0'],['libx264','-preset','veryfast','-crf','20']]){
      this.assertSpace(Math.max(64*1024**2,this._sizeOf(flv)*4),'恢复损坏画面');
      this.onStage?.('恢复损坏画面');
      const r=await this._runFfmpeg(['-y','-v','warning','-fflags','+discardcorrupt','-err_detect','ignore_err','-i',flv,
        '-map','0:v:0','-map','0:a?',
        // Preserve forward timestamps and every decodable frame, correcting only
        // backward/duplicate presentation times. Fixed FPS would drop VFR frames.
        '-vf',"setpts='if(eq(N,0),PTS,max(PTS,PREV_OUTPTS+1))'",
        '-fps_mode','passthrough','-enc_time_base:v','1:1000000','-c:v',...codec,'-c:a','copy',
        '-bsf:a',"setts=pts='if(eq(N,0),PTS,max(PTS,PREV_OUTPTS+1))':dts='if(eq(N,0),DTS,max(DTS,PREV_OUTDTS+1))'",
        '-movflags','+faststart',pending],86400000,false,source.duration);
      if(r.spaceError||/no space left|ENOSPC/i.test(r.stderr))throw new DiskSpaceError(r.stderr);
      if(r.code!==0||this._sizeOf(pending)<=1024)continue;
      // Source decoder warnings are expected; the rebuilt output must decode cleanly.
      const checked=await this.validateMedia(pending);if(!checked.ok)continue;
      let output;try{output=await this._scanVideo(pending);}catch(e){if(['LR_DISK_SPACE','LR_SOURCE_BUSY','LR_USER_PAUSED'].includes(e.code))throw e;continue;}
      const outputFrames=output.packetCount??output.packets.length;
      const missing=Math.max(0,sourceFrames-outputFrames);
      const limit=Math.max(2,Math.ceil(sourceFrames*0.0001));
      if(missing>limit||outputFrames>sourceFrames+2||Math.abs(output.duration-source.duration)>2)continue;
      return {kind:'decode',sourceFrames,outputFrames,missingFrames:missing,vcodec:codec[0]};
    }
    return null;
  }

  async remuxAll(minSizeMB = 0) {
    if(this._openParts.size){const e=Error('录像文件仍在写入，关闭后自动处理');e.code='LR_SOURCE_BUSY';throw e;}
    const files = [];
    for (let i = 1; i <= this.part; i++) {
      const flv = this.flvPath(i), mp4 = this.mp4Path(i);
      if (!fs.existsSync(flv)) {
        if(fs.existsSync(mp4)){
          const checked=await this.validateMedia(mp4);if(checked.ok)files.push(mp4);else this.issues.push(`分片${i}已有MP4损坏，需检查：${checked.stderr.slice(0,100)}`);
        }else if(!(this.emptyParts.has(i))&&!(this.settings?.keepRaw===false&&fs.existsSync(this.burnOutPath(i))))this.issues.push(`分片${i}文件缺失，不能确认整场完整`);
        continue;
      }
      if(this.emptyParts.has(i)&&this._sizeOf(flv)===0)continue;
      if (minSizeMB > 0 && this.part > 1 && this._sizeOf(flv) < minSizeMB * 1048576) {
        log.info('[rec] 小分片跳过处理, 保留原文件: ' + path.basename(flv));
        files.push(flv);
        continue;
      }
      const pending = mp4 + '.pending.mp4';
      assertSafePath(pending, this.base);
      let recovered = null;
      try {
        this.assertSpace(Math.max(16*1024**2,this._sizeOf(flv)*1.1),'转封装');
        this.onStage?.('转封装');
        const r = await this._runFfmpeg(['-y', '-v', 'error', '-i', flv, '-c', 'copy', '-movflags', '+faststart', pending], this._processingTimeout([flv]));
        if(r.spaceError||/no space left|ENOSPC/i.test(r.stderr))throw new DiskSpaceError(r.stderr);
        if (r.code !== 0 || hasMediaErrors(r.stderr) || this._sizeOf(pending) <= 1024) {
          recovered = await this._recoverTail(flv, pending);
          if (!recovered) throw new Error('转封装异常: ' + r.stderr.slice(0, 180));
        }
        const checked = await this.validateMedia(pending);
        if (!checked.ok) {
          const decoded=await this._recoverDecoded(flv,pending,checked.stderr);
          if(!decoded)throw new Error('完整性检查失败: '+checked.stderr.slice(0,180));
          recovered=decoded;
        }
        this._publish(pending, mp4);
        files.push(mp4);
        if (recovered) {
          let backup = flv;
          try {
            const dir=path.join(path.dirname(flv),'损坏原片备份');fs.mkdirSync(dir,{recursive:true});
            backup=path.join(dir,path.basename(flv));
            if(fs.existsSync(backup)) throw new Error('备份目标已存在');
            fs.renameSync(flv,backup);
          } catch(e) {backup=flv;log.warn('[rec] 损坏原片仍保留在原位置:',e.message);}
          const notice=recovered.kind==='decode'
            ?`分片${i}已修复解码错误或异常时间戳并重新编码，画面包${recovered.outputFrames}/${recovered.sourceFrames}，损坏画面可能有容错痕迹，原始录像已备份`
            :`分片${i}已恢复：舍弃末尾不完整数据${recovered.droppedBytes}字节（视频包时间差${recovered.lostMs}毫秒），损坏原片已保留`;
          this.notices.push(notice);log.warn('[rec]',notice,backup);
        } else {
          try { fs.unlinkSync(flv); } catch (e) { log.warn('[rec] 已生成MP4, 原片仍保留:', e.message); }
        }
        log.info('[rec] 转封装及完整性检查通过: ' + path.basename(mp4));
      } catch (e) {
        if(['LR_DISK_SPACE','LR_SOURCE_BUSY','LR_USER_PAUSED'].includes(e.code))throw e;
        const issue = '分片' + i + '未完成, 源文件已保留: ' + e.message;
        this.issues.push(issue);
        log.error('[rec]', issue);
        files.push(flv);
      } finally {
        try { fs.unlinkSync(pending); } catch {}
      }
    }
    if(!files.length&&!this.issues.length)this.issues.push('本场没有有效录像文件，不能报告录制完成');
    this.checkpoint();return files;
  }

  consolidateMp4s() { return this._mergeFiles('mp4'); }

}

// 供后处理等模块复用的 ffmpeg 执行器(参数数组、不经 shell; 调用方负责白名单校验)
function createFfmpegRunner() {
  const stub = new Recorder(path.join(require('node:os').tmpdir(), 'lr_runner_stub'));
  return (args, timeoutMs) => stub._runFfmpeg(args, timeoutMs);
}

module.exports = { Recorder, ffmpegPath, createFfmpegRunner };


