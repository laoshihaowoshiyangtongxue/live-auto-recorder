// 调度器: 每主播一个轮询循环 + 状态机
//   idle --(轮询到 live)--> recording --(连续2次 not live / maxSec)--> idle
// 录制期间 ffmpeg 挂掉由 Recorder 自身换片续录; 调度器只负责启停与降级
const fs = require('node:fs');
const path = require('node:path');
const log = require('../util/log');
const { safeName, ts, sleep } = require('../util/const');
const { ROOT } = require('./store');
const { DouyinSession } = require('./session');
const { Recorder } = require('./recorder');
const { DanmakuCapture } = require('./danmaku');
const { PostProcessor } = require('./postprocess');
const { pickFlv } = require('./adapter/douyin');
const {roomDirectory,recordingDirs,locateHistoryFile}=require('./recording-paths');
const {writeJson}=require('../util/atomic-json');
const {RecoveryController}=require('./recovery');
const {NetworkBackoff}=require('./network-backoff');

// 分段参数解析(对齐 biliLive-tools): "90"=90分钟, "500MB"=按500MB大小分段, "0"=不分段
function parseSegment(v) {
  const s = String(v ?? '').trim();
  if (!s || s === '0') return { minSec: 0, sizeMB: 0 };
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
  if (!m) return { minSec: 0, sizeMB: 0 };
  const n = +m[1];
  if (!m[2]) return { minSec: Math.min(n, 7 * 24 * 60) * 60, sizeMB: 0 };
  const mult = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 }[m[2].toUpperCase()];
  return { minSec: 0, sizeMB: Math.max(1, n * mult) };
}

class Scheduler {
  constructor(cfg) {
    this.cfg = cfg;
    this.sess = new DouyinSession();
    this.tasks = new Map(); // rid -> task
    this.timers = new Map();
    this.stopped = false;
    this.outDir = this._resolveOutDir(cfg.settings.outputDir);
    fs.mkdirSync(this.outDir, { recursive: true });
    this.post = new PostProcessor(path.join(ROOT, 'dm.ass'), cfg.settings);
    this.post.onUpdate = () => this.onEvent && this.onEvent('post', this.post.status);
    this.onEvent = null; // 由 main 注入: (type, data) => void
    // 全局请求闸门: 所有轮询请求串行 + 最小间隔(防大量房间时聚合请求过猛触发风控)
    this._gateLast = 0;
    this.networkBackoff = new NetworkBackoff();
    // 历史记录(持久化)
    this.historyFile = path.join(ROOT, 'history.json');
    try {
      this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      if (!Array.isArray(this.history)) throw new Error('历史记录结构无效');
    } catch {
      try{this.history=JSON.parse(fs.readFileSync(this.historyFile+'.bak','utf8'));if(!Array.isArray(this.history))this.history=[];}catch{this.history=[];}
    }
    this.history=this.history.filter(entry=>entry&&typeof entry==='object');
    let relocated=false;
    for(const entry of this.history)if(Array.isArray(entry.files))entry.files=entry.files.map(file=>{
      try{const resolved=locateHistoryFile(this.outDir,file);if(resolved!==file)relocated=true;return resolved;}
      catch(e){log.warn('[history] 分类文件定位失败，保留原索引:',e.message);return file;}
    });
    if(relocated){try{writeJson(this.historyFile,this.history,{backup:true});}catch(e){log.warn('[history] 分类索引保存失败:',e.message);}}
    this.recovery=new RecoveryController(this,path.join(ROOT,'recording-jobs.json'));
  }

  // 全局限速(自适应): 目标让全部房间一轮耗时 ≈ pollIntervalSec。
  // 少房间 → 快闸门(≥300ms, 8房间3s设置时一轮≈9s); 多房间 → 自动放宽(≤1600ms, 21房间约0.9req/s,
  // 仍远低于实测触发风控的7req/s)。此前固定1600ms导致8房间实际19s/轮, 3s设置形同虚设。
  async _gate() {
    const n = Math.max(1, [...this.tasks.values()].filter((t) => t.rid).length);
    const target = ((this.cfg.settings.pollIntervalSec || 3) * 1000) / n;
    const minGapMs = Math.min(1600, Math.max(300, Math.round(target)));
    const now = Date.now();
    const wait = Math.max(0, this._gateLast + minGapMs - now);
    this._gateLast = Date.now() + wait;
    if (wait > 0) await sleep(wait);
  }

  _appendHistory(entry) {
    this.history.push(entry);
    if (this.history.length > 300) this.history = this.history.slice(-300);
    try { writeJson(this.historyFile,this.history,{backup:true}); } catch(e) {log.error('[history] 保存失败，原历史仍保留:',e.message);}
  }

  // 录像保留策略: 删除超过 keepDays 天的产物(0=永久保留); 只动 .mp4/.jsonl, 不碰录制中的 .flv
  _cleanupOld() {
    const days = +(this.cfg.settings.keepDays) || 0;
    if (days <= 0) return;
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    const protectedBases=[...this.tasks.values()].map(t=>t.rec?.base).filter(Boolean);
    if(this.recovery)protectedBases.push(...this.recovery.bases());
    if(this.post.current?.recorder?.base)protectedBases.push(this.post.current.recorder.base);
    for(const job of this.post.queue||[])if(job.recorder?.base)protectedBases.push(job.recorder.base);
    try {
      for (const dir of recordingDirs(this.outDir)) for (const f of fs.readdirSync(dir)) {
        if (!/\.mp4$|\.jsonl$/.test(f)) continue;
        const p = path.join(dir, f);
        if(protectedBases.some(base=>p.startsWith(base)))continue;
        try {
          const st = fs.lstatSync(p);
          if (st.isFile() && !st.isSymbolicLink() && !f.includes('.pending.') && st.mtimeMs < cutoff) { fs.unlinkSync(p); removed += 1; }
        } catch {}
      }
      if (removed) log.info(`[cleanup] 按保留${days}天策略清理了 ${removed} 个文件`);
    } catch (e) {
      log.warn('[cleanup] 清理失败:', e.message);
    }
  }

  // 磁盘剩余字节数(outDir 所在盘)
  freeBytes(dir = this.outDir) {
    try {
      const st = fs.statfsSync(dir);
      return st.bsize * st.bavail;
    } catch {
      return 0;
    }
  }

  get recordingCount() {
    return [...this.tasks.values()].filter((t) => t.state === 'recording').length;
  }

  start() {
    log.info('[sched] 启动, 关注列表:', this.cfg.watchlist.map((w) => w.rid).join(', ') || '(空)');
    this._applyWatchlist();
    if(this.recovery)this.recoveryPromise=this.recovery.start({background:true}).catch(e=>log.error('[jobs] 恢复暂未完成:',e.message));
    // 磁盘水位巡检(60s): 录制中且剩余低于阈值 → 停止全部录制并告警
    this.diskTimer = setInterval(() => this._checkDisk(), 60000);
    this.diskTimer.unref();
    // 录像保留清理: 启动一次 + 每 6 小时
    setTimeout(() => this._cleanupOld(), 30000).unref();
    this.cleanupTimer = setInterval(() => this._cleanupOld(), 6 * 3600 * 1000);
    this.cleanupTimer.unref();
    // 配置热重载
    let lastMtime = this._cfgMtime();
    this.reloadTimer = setInterval(async () => {
      const m = this._cfgMtime();
      if (m !== lastMtime) {
        lastMtime = m;
        const { load } = require('./store');
        try {
          this.setConfig(load());
          if (this.onConfig) this.onConfig(this.cfg);
          log.info('[sched] 配置已重载');
        } catch (e) {
          log.error('[sched] 配置未应用, 继续使用上一份:', e.message);
        }
      }
    }, 10000);
    this.reloadTimer.unref();
  }

  _cfgMtime() {
    try { return fs.statSync(require('./store').CONFIG_PATH).mtimeMs; } catch { return 0; }
  }

  // 录像输出目录解析: 绝对路径直接用, 相对路径锚定应用根
  // 绝对路径直接使用，相对路径以应用根目录为基准。
  _resolveOutDir(dir) {
    const d = String(dir || 'recordings');
    return path.isAbsolute(d) ? d : path.join(ROOT, d);
  }

  _applyWatchlist() {
    const RID_RE = /^\d{6,13}$/; // 抖音房间号白名单: 纯数字6-13位
    const SEC_RE = /^MS4wLjABAAAA[A-Za-z0-9_-]{10,120}$/; // sec_uid 白名单
    const wanted = new Set(
      this.cfg.watchlist
        .map((w) => ({ rid: String(w.rid || ''), secUid: String(w.secUid || '') }))
        .filter(({ rid, secUid }) => {
          if (RID_RE.test(rid)) return true;
          if (!rid && SEC_RE.test(secUid)) return true; // 主页监控模式
          log.error(`[sched] 非法监控项已忽略: rid=${JSON.stringify(rid)} secUid=${secUid ? '(有)' : '(无)'}`);
          return false;
        })
        .map(({ rid, secUid }) => (rid ? rid : 'sec:' + secUid)),
    );
    // 统一建任务: rid 任务键=rid; 主页监控任务键='sec:'+secUid
    for (const w of this.cfg.watchlist) {
      const rid = String(w.rid || '');
      const secUid = String(w.secUid || '');
      let key = '';
      if (RID_RE.test(rid)) key = rid;
      else if (!rid && SEC_RE.test(secUid)) key = 'sec:' + secUid;
      if (!key) continue;
      if (this.tasks.has(key)) {
        // 已有任务: 同步界面刚改的过滤/时段/备注/限额, 下一轮轮询立即生效
        const t = this.tasks.get(key);
        t.item.name = w.name || '';
        t.item.nickname = w.nickname || '';
        t.item.companyId = w.companyId || '';
        t.item.titleFilter = String(w.titleFilter || '');
        t.item.hours = String(w.hours || '');
        t.item.maxSec = +w.maxSec || 0;
        if(t.monitorPaused!==!!w.monitorPaused){t.monitorPaused=!!w.monitorPaused;t.monitorVersion=(t.monitorVersion||0)+1;}
        continue;
      }
      const item = { rid, secUid, companyId: w.companyId || '', name: w.name || '', nickname: w.nickname || '', titleFilter: String(w.titleFilter || ''), hours: String(w.hours || ''), maxSec: +w.maxSec || 0 };
      const task = { rid, secUid, key, item, monitorPaused:!!w.monitorPaused, monitorVersion:0, state: 'idle', offCount: 0, paused: false, rec: null, dm: null, lastInfo: null, lastPollAt: 0, pollFails: 0, firstLiveAt: 0, stop: false };
      this.tasks.set(key, task);
      const delay = this.tasks.size * 400; // 错峰
      this.timers.set(key, setTimeout(() => this._loop(task), delay));
      log.info(`[sched] 开始监控 ${key} (${item.name || '未命名'}${rid ? '' : ' 主页模式'})`);
    }
    for (const [key, t] of this.tasks) {
      if (!wanted.has(key)) {
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
        this.tasks.delete(key);
        if (t.state === 'recording') this._stopJob(t, '从关注列表移除');
        if (t.secUid) { try { this.sess.closeProfileWindow(t.secUid); } catch {} }
        t.stop = true;
        log.info(`[sched] 停止监控 ${key}`);
      }
    }
  }

  // 循环调度: 间隔 = 基准抖动 + 失败退避(失败越多等越久, 最长5分钟), 防雪上加霜
  _loop(task) {
    if (task.stop || this.stopped) return;
    this._poll(task)
      .catch((e) => this._pollError(task, e))
      .finally(() => {
        if (task.stop || this.stopped) return;
        // 双保险: 任务已被替换/移除(表里不是本实例)则绝不再续链(防幽灵循环)
        if (this.tasks.get(task.key) !== task) return;
        const base = (this.cfg.settings.pollIntervalSec || 3) * 1000;
        const wobble = ((Date.now() >> 7) + task.rid.length) % 41; // 0..40 稳定变化
        const backoff = Math.min((task.pollFails || 0) * 2000, 300000);
        const t = setTimeout(() => this._loop(task), Math.round(base * (0.8 + wobble / 100)) + backoff);
        t.unref();
        this.timers.set(task.key, t);
      });
  }

  // 值守时段检查: "HH:MM-HH:MM", 支持跨零点(如 20:00-02:00); 空串=全天
  _inHours(hours) {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.test(String(hours || '').trim()) &&
      String(hours || '').trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) return true;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const a = (+m[1]) * 60 + (+m[2]);
    const b = (+m[3]) * 60 + (+m[4]);
    return a <= b ? cur >= a && cur < b : cur >= a || cur < b; // 跨零点
  }

  // 外部(界面)更新配置后立即应用
  setConfig(cfg) {
    const outDir = this._resolveOutDir(cfg.settings.outputDir);
    fs.mkdirSync(outDir, { recursive: true });
    this.cfg = cfg;
    this.outDir = outDir;
    this.post.s = cfg.settings;
    this.recovery?.tick().catch(e=>log.warn('[quiet] 恢复队列检查失败:',e.message));
    this._applyWatchlist();
  }

  _checkDisk() {
    const min = (this.cfg.settings.minFreeGB || 0) * 1024 ** 3;
    const recording = [...this.tasks.values()].filter((t) => t.state === 'recording' &&
      this.freeBytes(t.rec ? path.dirname(t.rec.base) : this.outDir) < min);
    if (!recording.length) return;
    const free = Math.min(...recording.map((t) => this.freeBytes(t.rec ? path.dirname(t.rec.base) : this.outDir)));
    log.error(`[disk] 剩余空间不足(${(free / 1024 ** 3).toFixed(1)}GB < ${this.cfg.settings.minFreeGB}GB), 停止全部录制`);
    this.onEvent && this.onEvent('diskfull', { freeGB: +(free / 1024 ** 3).toFixed(1) });
    for (const t of recording) this._stopJob(t, '磁盘空间不足').catch((e) => log.error('[disk] stop错误', e.message));
  }

  _pollError(task, e) {
    if(task.monitorPaused||task.stop||this.stopped)return;
    this.networkBackoff?.failure(e);
    task.pollFails += 1;
    log.warn(`[poll] ${task.rid || task.key} 第${task.pollFails}次失败: ${e.message}`);
    if (task.state === 'recording' && !task.paused && task.pollFails >= 3 &&
        task.rec?.lastProgressAt && Date.now() - task.rec.lastProgressAt >= 90000) {
      log.warn(`[poll] ${task.rid} 直播间持续不可访问且90秒无录像数据，保存本场录像`);
      this._stopJob(task, '直播间不可访问且持续无数据（可能下播或被封禁）').catch(err=>log.error('[sched] 异常下播收尾失败:',err.message));
    }
    if (task.pollFails % 20 === 0) log.error(`[poll] ${task.rid || task.key} 连续失败 ${task.pollFails} 次，考虑检查网络/风控`);
    // 连续失败 30 次（约90秒）→ 重建会话 + 会话告警
    if (task.pollFails === 30) {
      log.warn('[poll] 连续失败过多, 重建热身页会话');
      this.onEvent && this.onEvent('session-bad', { rid: task.rid, msg: e.message });
      try { this.sess.win && this.sess.win.destroy(); } catch {}
    }
  }

  async _poll(task) {
    if (task.stop || this.stopped || task.monitorPaused) return;
    if(task.state!=='recording' && this.networkBackoff?.shouldWait())return;
    const monitorVersion=task.monitorVersion;
    const inactive=()=>task.stop||this.stopped||task.monitorPaused||task.monitorVersion!==monitorVersion;

    // ---- 主页监控模式(离线添加的主播): DOM扫描主页找直播入口 ----
    if (!task.rid && task.secUid) {
      if (task.state === 'recording') return; // 已转正常任务由原 rid 轮询接管? 不会发生: 转换时换新任务
      let foundRid = '';
      try {
        foundRid = await this.sess._profileDomScan(task.secUid);
        if (inactive()) return;
        task.pollFails = 0;
      } catch (e) {
        this.networkBackoff?.failure(e);task.pollFails += 1;
        if (task.pollFails % 20 === 0) log.warn(`[poll] 主页监控 ${task.item.name || task.secUid.slice(0, 20)} 连续失败 ${task.pollFails}: ${e.message}`);
        return;
      }
      foundRid = String(foundRid || '');
      if (/^\d{6,13}$/.test(foundRid)) {
        // 回填主播真名(若之前未知)
        let nickname = task.item.nickname || '';
        if (!nickname) {
          try {
            const info = await this.sess.getRoomInfo(foundRid);
            nickname = (info && info.nickname) || '';
          } catch {}
        }
        if (inactive()) return;
        // 写回配置(持久化为 rid 任务); 已有同rid条目则只补名, 防重复(幽灵任务曾多次把配置刷到数千条)
        const original = this.cfg.watchlist.find(w => String(w.secUid || '') === task.secUid && !w.rid);
        if (!original) return; // 配置已删除该主播，不能重新创建。
        const promoted = { ...original, rid: foundRid, nickname: nickname || original.nickname || '' };
        const existsRid = this.cfg.watchlist.find(w => String(w.rid || '') === foundRid);
        let replacement = promoted;
        if (existsRid) {
          // 同房间已有录制时保留其设置及任务，仅补齐缺失字段。
          replacement = { ...promoted, ...existsRid };
          for (const field of Object.keys(promoted)) {
            if (replacement[field] === undefined || replacement[field] === '' || replacement[field] === 0)
              replacement[field] = promoted[field];
          }
        }
        const watchlist = this.cfg.watchlist.flatMap(w => {
          if (w === existsRid) return [replacement];
          if (String(w.secUid || '') === task.secUid && !w.rid) return existsRid ? [] : [replacement];
          return [w];
        });
        const { save } = require('./store');
        // 先持久化，成功后再切换任务。写入失败保留主页任务，下轮自动重试。
        save({ ...this.cfg, watchlist });
        this.cfg.watchlist = watchlist;
        // 停旧任务(必须置stop终结_loop自续链, 否则幽灵循环复活反复转换), _applyWatchlist 建新 rid 任务
        task.stop = true;
        try { this.sess.closeProfileWindow(task.secUid); } catch {} // 转正后主页窗口即销毁(不泄漏)
        clearInterval(this.timers.get(task.key));
        this.timers.delete(task.key);
        this.tasks.delete(task.key);
        this._applyWatchlist();
        if (this.onConfig) this.onConfig(this.cfg);
        log.info(`[sched] ${task.item.name || foundRid} 已保存房间 ${foundRid}，以后使用秒级监控`);
        this.onEvent && this.onEvent('live', { rid: foundRid, nickname: task.item.name || '', title: '主页监控发现开播' });
      }
      return;
    }

    await this._gate(); // 全局限速
    if(inactive()||(task.state!=='recording'&&this.networkBackoff?.shouldWait()))return;
    const info = await this.sess.getRoomInfo(task.rid);
    // 等待限速/网络期间任务可能已被删除或应用停机: 复查防止幽灵开播
    if (inactive()) return;
    this.networkBackoff?.success();
    task.pollFails = 0;
    task.lastInfo = info;
    // Keep a successful identification across offline responses and restarts.
    if (info.nickname && info.nickname !== task.item.nickname) {
      task.item.nickname = info.nickname;
      const saved = this.cfg.watchlist.find(w => String(w.rid || '') === task.rid);
      if (saved && saved.nickname !== info.nickname) {
        saved.nickname = info.nickname;
        require('./store').save(this.cfg);
      }
    }
    task.lastPollAt = Date.now();
    const tag = `[${info.nickname || task.rid}]`;

    if (task.manualStopped) {
      task.manualOffCount = info.live ? 0 : (task.manualOffCount || 0) + 1;
      if (task.manualOffCount >= 2) { task.manualStopped = false; task.manualOffCount = 0; }
      else return;
    }

    if (task.state === 'idle') {
      if (info.live) {
        // 值守时段: 时段外不录(仅展示直播中)
        if (task.item.hours && !this._inHours(task.item.hours)) {
          if (!task.hoursSkipLogged || Date.now() - task.hoursSkipLogged > 600000) {
            log.info(`${tag} 开播但当前不在值守时段 ${task.item.hours}, 不录制`);
            task.hoursSkipLogged = Date.now();
          }
          return;
        }
        // 标题关键词过滤(正则): 只录标题匹配的场次
        if (task.item.titleFilter) {
          try {
            if (!new RegExp(task.item.titleFilter).test(info.title || '')) {
              if (!task.filterSkipLogged || Date.now() - task.filterSkipLogged > 600000) {
                log.info(`${tag} 开播但标题不匹配过滤 "${task.item.titleFilter}" 《${info.title}》, 不录制`);
                task.filterSkipLogged = Date.now();
              }
              return;
            }
          } catch {
            log.warn(`${tag} 标题过滤正则无效: ${task.item.titleFilter}`);
          }
        }
        if (this.recordingCount >= this.cfg.settings.maxConcurrentRecordings) {
          log.warn(`${tag} 开播了但并发已满(${this.recordingCount}), 排队等待`);
          return;
        }
        task.firstLiveAt = Date.now();
        const latency = task.firstLiveAt - (task.lastPollAt || task.firstLiveAt);
        log.info(`${tag} >>> 开播! 《${info.title}》 开始录制 (检测延迟≈${Math.max(0, latency)}ms+轮询间隔)`);
        await this._startJob(task, info);
      }
    } else if (task.state === 'recording') {
      if (info.live) {
        task.offCount = 0;
        if(!task.paused&&typeof task.rec?.ensureRunning==='function')task.rec.ensureRunning();
        // 定时分段(成品标配): 满段换新分片, 防单文件过大
        // 定时分段(成品标配): 支持时间(分钟)与大小("500MB")双模式, 满段换新分片防单文件过大
        const seg = parseSegment(this.cfg.settings.segment);
        const curStart = task.rec && task.rec.partStarts[task.rec.part];
        if (!task.paused && seg.minSec > 0 && curStart && Date.now() - curStart >= seg.minSec * 1000) {
          log.info(`[${info.nickname || task.rid}] 满${seg.minSec}秒自动分段`);
          task.rec.rotate().catch((e) => log.warn('[rec] 分段异常', e.message));
        } else if (!task.paused && seg.sizeMB > 0 && task.rec) {
          const flv = task.rec.flvPath(task.rec.part);
          let mb = 0;
          try { mb = fs.statSync(flv).size / 1048576; } catch {}
          if (mb >= seg.sizeMB) {
            log.info(`[${info.nickname || task.rid}] 满${mb.toFixed(0)}MB自动分段`);
            task.rec.rotate().catch((e) => log.warn('[rec] 分段异常', e.message));
          }
        }
      } else {
        if(!task.paused&&task.rec?.lastProgressAt&&Date.now()-task.rec.lastProgressAt<10000){
          task.offCount=0;
          if(!task.falseOfflineAt||Date.now()-task.falseOfflineAt>30000){task.falseOfflineAt=Date.now();log.warn(`${tag} 接口暂报下播但录像仍有进度，继续录制并复核`);}
          return;
        }
        task.offCount += 1;
        log.info(`${tag} 轮询显示已下播 (${task.offCount}/2)`);
        if (task.offCount >= 2) await this._stopJob(task, '下播');
      }
    }
  }

  // ---- 暂停 / 继续 ----
  async _pauseJob(task) {
    if (task.state !== 'recording') return {ok:false,error:'当前任务没有正在录制'};
    if (task.paused) return {ok:true};
    task.paused = true;
    log.info(`[${task.lastInfo?.nickname || task.rid}] ⏸ 暂停录制(任务保留, 可继续)`);
    this.onEvent && this.onEvent('paused', { rid: task.rid });
    try { await task.rec.pause(); return {ok:true}; } catch (e) { task.paused=false;log.error('[rec] pause异常', e.message);return {ok:false,error:'暂停失败：'+e.message}; }
  }

  async _resumeJob(task) {
    if (task.stop || this.stopped || task.stopping) return {ok:false,error:'任务正在停止，暂时不能继续'};
    if (task.state === 'idle' && task.manualStopped) {
      task.manualStopped = false;
      task.manualOffCount = 0;
      await this._poll(task);
      return task.state==='recording'?{ok:true}:{ok:false,error:task.lastError||'主播尚未开播，监控将继续等待开播'};
    }
    if (task.state !== 'recording' || !task.paused) return {ok:false,error:'当前任务没有暂停中的录制'};
    try {
      const info = await this.sess.getRoomInfo(task.rid); // 取最新状态+流地址
      if (task.stop || this.stopped || task.stopping || task.state !== 'recording' || !task.rec) return {ok:false,error:'任务状态已变化，请刷新后重试'};
      task.lastInfo = info;
      if (!info.live) {
        log.warn(`[${task.lastInfo?.nickname || task.rid}] 恢复时发现已下播, 等待轮询收尾`);
        return {ok:false,error:'主播已下播，无法继续录制；正在等待本场收尾'};
      }
      const resumed = task.rec.resume(pickFlv(info.flv, this.cfg.settings.quality) || info.best);
      if (!resumed) throw new Error('录制器尚未能恢复');
      task.paused = false;
      log.info(`[${info.nickname || task.rid}] ⏵ 继续录制(新分片)`);
      this.onEvent && this.onEvent('resumed', { rid: task.rid });
      return {ok:true};
    } catch (e) {
      log.error('[rec] resume异常', e.message);
      return {ok:false,error:'继续录制失败：'+e.message};
    }
  }

  pauseAll() {
    for (const t of this.tasks.values()) if (t.state === 'recording' && !t.paused) this._pauseJob(t);
  }

  resumeAll() {
    for (const t of this.tasks.values()) if (t.state === 'recording' && t.paused) this._resumeJob(t);
  }

  async _startJob(task, info) {
    if (task.stop || this.stopped) return; // 删除竞态兜底: 等待期间被删除的任务不再开播
    // 磁盘水位闸门
    const minBytes = (this.cfg.settings.minFreeGB || 0) * 1024 ** 3;
    if (this.freeBytes() < minBytes) {
      log.error(`[${info.nickname || task.rid}] 开播但磁盘空间不足, 放弃本次录制`);
      this.onEvent && this.onEvent('diskfull', null);
      return;
    }
    const url = pickFlv(info.flv, this.cfg.settings.quality) || info.best;
    if (typeof url !== 'string' || !/^https?:\/\/\S+$/i.test(url)) throw new Error('当前直播没有可用的拉流地址, 稍后重试');
    const name = safeName(info.nickname || task.item.nickname || task.item.name || task.rid);
    const dir=roomDirectory(this.outDir,task.rid,name);
    const prefix=`${name}_${task.rid}_${ts()}`;let base=path.join(dir,prefix),serial=0;
    while(fs.readdirSync(dir).some(f=>f.startsWith(path.basename(base)+'_part')||f===path.basename(base)+'.danmaku.jsonl')||[...(this.recovery?.store.jobs.values()||[])].some(j=>j.base===base))base=path.join(dir,prefix+'_'+(++serial));
    task.state = 'recording';
    task.offCount = 0;
    task.paused = false; // 清上一场遗留的暂停态(否则界面显示已暂停/续录与分段被抑制)
    task.recorderStartedAt = Date.now();
    task.basePath = base;
    this.onEvent && this.onEvent('live', { rid: task.rid, nickname: info.nickname, title: info.title });

    const rec = new Recorder(base);
    rec.settings = { ...this.cfg.settings };
    if(this.recovery)this.recovery.begin(rec,task);
    rec.canRestart = () => {
      const t = this.tasks.get(task.rid);
      return !!(t && t.state === 'recording' && !t.paused && !t.stopping && t.lastInfo && t.lastInfo.live);
    };
    // 断流重启时刷新流地址(每次轮询 enter 都带回新签名的地址; 按画质偏好重选档位)
    rec.getUrl = () => {
      const t = this.tasks.get(task.rid);
      if (!t || !t.lastInfo) return '';
      return pickFlv(t.lastInfo.flv, this.cfg.settings.quality) || t.lastInfo.best || '';
    };
    try {
      rec.start(url);
      task.rec = rec;
      task.lastError = '';
      task.lastNotice = '';
    } catch (e) {
      await rec.stop().catch(() => {});
      if(this.recovery&&rec.jobId){const view=this.recovery.view(rec,this.recovery.store.get(rec.jobId));this.recovery.failed(rec,e,'seal',view);}
      task.state = 'idle'; task.rec = null;
      task.lastError = e.message;
      throw e;
    }

    task.dm = new DanmakuCapture(this.sess);
    task.dm.onGap=gap=>{
      const note=`弹幕写入故障期间约${Math.ceil((gap.end-gap.start)/1000)}秒未能保证采集，已保留故障记录`;
      if(!rec.notices.includes(note))rec.notices.push(note);rec.checkpoint();
    };
    task.dm.start(task.rid, base).catch((e) => log.warn(`[dm] 启动失败(录制不受影响): ${e.message}`));

    // 测试/限额: item.maxSec 秒后自动停
    if (task.item.maxSec) {
      task.maxTimer = setTimeout(() => {
        log.info(`${info.nickname} 达到 maxSec=${task.item.maxSec}s, 停止录制`);
        this._stopJob(task, 'maxSec').catch((e) => log.error('[sched] stop错误', e.message));
      }, task.item.maxSec * 1000);
      task.maxTimer.unref();
    }
  }

  _stopJob(task, reason) {
    if (String(reason).startsWith('界面手动停止') || reason === 'maxSec') {
      task.manualStopped = true;
      task.manualOffCount = 0;
    }
    if (task.stopPromise) return task.stopPromise;
    if (!task.rec) { task.state = 'idle'; task.stopping = false; return Promise.resolve({ ok: true, files: [] }); }
    if (!this.pendingStops) this.pendingStops = new Set();
    const promise = this._finishJob(task, reason).finally(() => {
      this.pendingStops.delete(promise);
      task.stopPromise = null;
    });
    task.stopPromise = promise;
    this.pendingStops.add(promise);
    return task.stopPromise;
  }

  async _finishJob(task, reason) {
    task.stopping = true;
    task.state = 'stopping';
    const tag = `[${task.lastInfo?.nickname || task.rid}]`;
    log.info(`${tag} <<< 停止录制 (${reason})`);
    if (task.maxTimer) clearTimeout(task.maxTimer);
    const rec = task.rec;
    const settings = rec.settings || { ...this.cfg.settings };
    const view = this.post.begin && this.post.begin(rec, task.item?.nickname || task.lastInfo?.nickname || task.rid);
    let enqueued = false;
    let files = [];
    try {
      try { await rec.stop(); } catch (e) { log.error('[rec] stop异常', e.message); }
      try { await task.dm.stop(); } catch (e) { log.error('[dm] stop异常', e.message); }
      if(this.recovery){const result=await this.recovery.processStopped(task,rec,view);enqueued=!!result.enqueued;return result;}
      // 相邻分片自动合并(对齐 biliLive-tools autoPartMerge): 断流重连的分片无缝并回一个文件
      if (settings.autoPartMerge) {
        try { await rec.mergeParts(); } catch (e) { log.warn('[rec] 分片合并异常(按原分片处理)', e.message); }
      }
      const secs = ((Date.now() - task.recorderStartedAt) / 1000).toFixed(0);
      const totalMB = (rec.totalBytes() / 1048576).toFixed(1); // remux 会删 FLV, 字节数必须先抓
      files = await rec.remuxAll(settings.minSizeMB);
      if (settings.autoPartMerge && rec.part > 1 && !(rec.issues && rec.issues.length) &&
          files.length && files.every((f) => f.endsWith('.mp4'))) {
        if (await rec.consolidateMp4s()) files = [rec.mp4Path(1)];
        else rec.issues.push('分片合并未完成，全部原片已保留，不能确认整场双版本完整');
      }
      log.info(`${tag} 录制完成: ${secs}s, ${totalMB}MB, 文件:`, files.map((f) => path.basename(f)));
      // 弹幕版烧录入队(录制链路已结束, 后处理串行执行)
      if (files.length) {
        this.post.enqueue({
          recorder: rec,
          danmakuFile: task.basePath + '.danmaku.jsonl',
          nickname: task.lastInfo?.nickname || task.rid,
          settings: { ...settings },
          mergeComplete: true,
          view,
        });
        enqueued = true;
      }
      const warnings = rec.issues || [], notices=rec.notices||[];
      if (!enqueued && this.post.finish) this.post.finish(view, warnings.length ? 'warning' : notices.length?'recovered':'done', warnings.join('; ')||notices.join('; '));
      task.lastError = warnings.join('; ');
      task.lastNotice=notices.join('; ');
      this.onEvent && this.onEvent('record-done', { rid: task.rid, nickname: task.lastInfo?.nickname, secs, files: files.map((f) => path.basename(f)), warnings,notices });
      this._appendHistory({
        at: Date.now(),
        rid: task.rid,
        nickname: task.lastInfo?.nickname || task.item.name || task.rid,
        title: task.lastInfo?.title || '',
        secs: +secs,
        files: files.map((f) => path.relative(this.outDir,f).replace(/\\/g,'/')),
        error: task.lastError,
        recoveryNotice:task.lastNotice,
      });
      return { ok: warnings.length === 0, files, error: task.lastError };
    } catch (e) {
      task.lastError = e.message;
      if (!enqueued && this.post.finish) this.post.finish(view, 'failed', e.message);
      log.error('[sched] 停录处理失败, 保留源文件:', e.message);
      this.onEvent && this.onEvent('record-error', { rid: task.rid, error: e.message });
      return { ok: false, files, error: e.message };
    } finally {
      if (!enqueued) rec.onStage = null;
      task.state = 'idle';
      task.stopping = false;
      task.rec = null;
      task.dm = null;
    }
  }

  // GUI 状态快照
  snapshot() {
    const post=(this.recovery?.status?this.recovery.status():this.post.status)||{items:[]};
    const byId=new Map((post.items||[]).map(v=>[v.id,v]));
    const history=this.history.slice(-30).reverse().map(h=>{const view=byId.get(h.jobId);return view?{...h,status:view.status,error:h.status==='quiet'&&view.status!=='quiet'?'':h.error}:h;});
    return {
      time: Date.now(),
      tasks: [...this.tasks.values()].map((t) => ({
        rid: t.rid || t.secUid,
        secWatch: !t.rid,
        identity: t.secUid || t.rid,
        companyId: t.item.companyId || '',
        name: t.item.name || '',
        dispName: (t.lastInfo && t.lastInfo.nickname) || t.item.nickname || t.item.name || '',
        titleFilter: t.item.titleFilter || '',
        hours: t.item.hours || '',
        nickname: t.lastInfo?.nickname || t.item.nickname || '',
        title: t.lastInfo?.title || '',
        state: t.state,
        live: !!(t.lastInfo && t.lastInfo.live),
        paused: !!t.paused,
        monitorPaused: !!t.monitorPaused,
        manualStopped: !!t.manualStopped,
        error: t.lastError || '',
        notice:t.lastNotice||'',
        startedAt: t.recorderStartedAt || 0,
        dmCount: t.dm ? t.dm.count : 0,
        dmState: t.dm ? t.dm.state : '',
        dmError: t.dm ? t.dm.error : '',
        bytes: t.rec ? t.rec.totalBytes() : 0,
        parts: t.rec ? t.rec.part : 0,
        pollFails: t.pollFails || 0,
      })),
      history,
      post,
      diskFreeGB: +(this.freeBytes() / 1024 ** 3).toFixed(1),
      settings: this.cfg.settings,
      companies: this.cfg.companies || [],
      ungroupedCollapsed: !!this.cfg.ungroupedCollapsed,
      recoveryError:this.recovery?.store.error||'',
    };
  }

  // GUI 设置更新(白名单字段)
  updateSettings(patch) {
    const s = {...this.cfg.settings};
    const {validClock}=require('./quiet-hours');
    if(typeof patch.postQuietEnabled==='boolean')s.postQuietEnabled=patch.postQuietEnabled;
    for(const key of ['postQuietStart','postQuietEnd'])if(typeof patch[key]==='string')s[key]=patch[key];
    if(s.postQuietEnabled&&(!validClock(s.postQuietStart)||!validClock(s.postQuietEnd)||s.postQuietStart===s.postQuietEnd))throw new Error('后处理静音时段需填写不同的开始和结束时间（HH:MM）');
    if(!validClock(s.postQuietStart))s.postQuietStart='23:00';
    if(!validClock(s.postQuietEnd))s.postQuietEnd='08:00';
    let nextOutDir=this.outDir;
    if (Number.isFinite(+patch.pollIntervalSec)) s.pollIntervalSec = Math.min(10, Math.max(1, +patch.pollIntervalSec));
    if (Number.isFinite(+patch.maxConcurrentRecordings)) s.maxConcurrentRecordings = Math.min(20, Math.max(1, +patch.maxConcurrentRecordings));
    if (Number.isFinite(+patch.minFreeGB)) s.minFreeGB = Math.min(500, Math.max(0, +patch.minFreeGB));
    if (typeof patch.segment === 'string' && /^(0|[1-9]\d{0,4})(\.\d+)?\s*(B|KB|MB|GB)?$/i.test(patch.segment.trim())) {
      s.segment = patch.segment.trim();
    }
    if (Number.isFinite(+patch.segmentMin)) s.segmentMin = Math.min(720, Math.max(0, +patch.segmentMin));
    if (typeof patch.quality === 'string' && ['highest', 'FULL_HD1', 'HD1', 'SD1', 'SD2'].includes(patch.quality)) s.quality = patch.quality;
    if (Number.isFinite(+patch.minSizeMB)) s.minSizeMB = Math.min(100000, Math.max(0, +patch.minSizeMB));
    if (typeof patch.autoPartMerge === 'boolean') s.autoPartMerge = patch.autoPartMerge;
    if (typeof patch.preventSleep === 'boolean') s.preventSleep = patch.preventSleep;
    if (Number.isFinite(+patch.postConcurrency)) s.postConcurrency = Math.min(4, Math.max(1, Math.round(+patch.postConcurrency)));
    if (typeof patch.outputDir === 'string') {
      const od = patch.outputDir.trim().slice(0, 200).replace(/^[-\s]+/, '');
      if (od && !od.includes('..') && !/[\x00"<>|?*]/.test(od)) {
        s.outputDir = od;
        nextOutDir = this._resolveOutDir(od);
        fs.mkdirSync(nextOutDir, { recursive: true });
      }
    }
    if (Number.isFinite(+patch.keepDays)) s.keepDays = Math.min(3650, Math.max(0, +patch.keepDays));
    if (typeof patch.burnDanmaku === 'boolean') s.burnDanmaku = patch.burnDanmaku;
    if (typeof patch.keepRaw === 'boolean') s.keepRaw = patch.keepRaw;
    if (typeof patch.autoStart === 'boolean') s.autoStart = patch.autoStart;
    if (typeof patch.webhookUrl === 'string') s.webhookUrl = patch.webhookUrl.slice(0, 500);
    const { save } = require('./store');
    save({...this.cfg,settings:s});
    this.cfg.settings=s;
    this.outDir=nextOutDir;
    this.post.s = s;
    this.recovery?.tick().catch(e=>log.warn('[quiet] 恢复队列检查失败:',e.message));
    // 轮询间隔变更: _loop 每轮实时读 pollIntervalSec, 下一轮自然生效(无需动定时器;
    // 旧实现用setInterval重建会叠加慢请求+以空rid做键互相覆盖泄漏定时器)
    // 处于退避中的任务清零退避, 立即按新间隔恢复
    for (const t of this.tasks.values()) t.pollFails = 0;
    log.info('[sched] 设置已更新并保存');
  }

  // 退出工作量估算: 待转封装的 FLV 总字节(供 main 按量自适应放缩强制退出时限)
  shutdownWorkloadBytes() {
    let b = 0;
    for (const t of this.tasks.values()) {
      if (t.state === 'recording' && t.rec) {
        for (let i = 1; i <= t.rec.part; i++) {
          try { b += fs.statSync(t.rec.flvPath(i)).size; } catch {}
        }
      }
    }
    return b;
  }

  async shutdown(options={}) {
    this.stopped = true;
    if(options.deferProcessing&&this.recovery){this.recovery.prepareExit();this.post.prepareExit();}
    else{this.post.prepareShutdown?.();if(this.recovery)this.recovery.close();}
    for (const t of this.timers.values()) clearInterval(t);
    if (this.diskTimer) clearInterval(this.diskTimer);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    const jobs = [...this.tasks.values()].filter((t) => t.state === 'recording' || t.stopPromise);
    const stopping = jobs.map((t) => this._stopJob(t, '应用退出'));
    await Promise.allSettled([...stopping, ...(this.pendingStops || []),...(this.recoveryPromise?[this.recoveryPromise]:[]),...(this.recovery?[this.recovery.sealTail]:[])]);
    if(options.deferProcessing&&this.recovery){while(this.post.running.size)await new Promise(r=>setTimeout(r,100));this.recovery.close();this.post.close?.();this.recovery.mediaPool.close();return;}
    // 等待弹幕烧录队列排空再退出；长场次不能按固定15分钟截断
    const pending=()=>this.post.busy||(this.post.queue.length&&this.post.hasRunnable!==false);
    if (pending()) {
      log.info(`[sched] 退出前等待弹幕烧录完成 (待处理 ${this.post.queue.length} 场)...`);
      const t0 = Date.now();
      let warned=false;
      while (pending()) {
        await new Promise((r) => setTimeout(r, 2000));
        if(!warned&&Date.now()-t0>=15*60*1000){warned=true;log.warn('[sched] 处理超过15分钟，继续等待以保留弹幕版');}
      }
      log.info('[sched] 全部烧录完成, 可以安全退出');
    }
    this.post.close?.();this.recovery?.mediaPool?.close();
  }
}

module.exports = { Scheduler, parseSegment };
