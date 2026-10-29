// 弹幕采集：开播期间打开隐藏房间页, MutationObserver 监听 webcast-chatroom
// 弹幕以「收到时刻的墙钟时间」记录 → 与录制的墙钟起点精确对齐, 与页面打开早晚无关
const fs = require('node:fs');
const log = require('../util/log');
const { evaluateNow, releaseEvaluation } = require('./page-eval');
const {writeJson}=require('../util/atomic-json');

const MARK = '\u0001DM\u0001'; // 控制台桥接标记，避免与页面自身日志混淆

function isHumanComment(text) {
  const m = String(text).match(/^([^：:]{1,30})[：:]\s*(.+)$/);
  if (!m || /^(系统|官方|抖音|公告)/.test(m[1])) return false;
  const body = m[2].trim();
  if (/^(?:(?:为|给)主播点赞了|关注了主播|加入了粉丝团|进入(?:了)?直播间|来了)[!！。\s]*$/.test(body)) return false;
  if (/^送出了?\s*.+\s*[×xX]\s*\d+\s*$/.test(body)) return false;
  return true;
}

const OBSERVER_JS = `(() => {
  const sel = ['[class*="webcast-chatroom"]', '[class*="chatroom"]', '[class*="danmu"]', '[id*="chatroom"]'];
  let host = null;
  for (const s of sel) { host = document.querySelector(s); if (host) break; }
  if (!host) return 'nohost'; // 不退回 document.body: 全页文字会被当弹幕混入
  const previous = window.__lrDanmakuObserver;
  if (previous && previous.host === host && host.isConnected && previous.scan) { previous.scan(); return 'alive'; }
  if (previous) previous.observer.disconnect();
  // 时间窗去重: 只抑制DOM重渲染导致的短时重复上报; 超窗放行(真人重复发言不被整场丢弃)
  const seen = previous ? previous.seen : new Map();
  const DEDUP_MS = 3000;
  // 只保留真人发言: 抖音聊天区真人弹幕均为「用户名：内容」结构;
  // 进场(来了)/点赞/送礼/关注等系统消息没有冒号结构, 天然被排除;
  // 另外按常见系统词兜底过滤, 防个别带冒号的公告混入
  const isHuman = ${isHumanComment.toString()};
  const scanned = new WeakMap();
  const emit = (node, backfill = false) => {
    let n = node.nodeType === 1 ? node : node.parentElement;
    if (!n || !host.contains(n)) return;
    const row = n.closest('.webcast-chatroom___item');
    if (row && host.contains(row)) n = row;
    else {
      // Mutation records can contain an entire list wrapper. Visit individual
      // rows; never turn the wrapper's concatenated text into one comment.
      const rows=n.querySelectorAll ? n.querySelectorAll('.webcast-chatroom___item') : [];
      if(rows.length){rows.forEach(item=>emit(item,backfill));return;}
      if(host.querySelector('.webcast-chatroom___item'))return;
    }
    let t = (n.innerText || n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0,80);
    // Recycled rows may change only a nested text node, not the message node.
    for(let i=0;i<4 && !row && !isHuman(t) && n.parentElement && n.parentElement!==host;i++) {
      n=n.parentElement;t=(n.innerText||n.textContent||'').trim().replace(/\\s+/g,' ').slice(0,80);
    }
    if (!t || !isHuman(t) || (backfill && scanned.get(n) === t)) return;
    scanned.set(n,t);
    const now=Date.now(),last=seen.get(t)||0;
    if(now-last<DEDUP_MS)return;
    seen.set(t,now);
    if(seen.size>100000)for(const [k,v] of seen)if(now-v>60000)seen.delete(k);
    console.log('${MARK}'+t);
  };
  const scan = () => {
    const rows=host.querySelectorAll('.webcast-chatroom___item');
    const nodes=rows.length?Array.from(rows):Array.from(host.children);
    nodes.slice(-50).forEach(n=>emit(n,true));
  };
  const observer = new MutationObserver(muts => {
    for (const m of muts) for (const added of (m.type === 'characterData' ? [m.target] : m.addedNodes)) {
      emit(added);
    }
  });
  observer.observe(host, { childList: true, subtree: true, characterData: true });
  window.__lrDanmakuObserver = { host, observer, seen, scan };
  scan();
  return 'ok:' + String(host.className).slice(0, 50);
})()`;

class DanmakuCapture {
  constructor(sess) {
    this.sess = sess;
    this.win = null;
    this.file = null;
    this.count = 0;
    this.stopped = false;
    this.state = 'starting';
    this.error = '';
    this.timer = null;
    this.retryMs = 3000;
    this.scriptTimeoutMs = 5000;
    this.checking = false;
    this.recent = new Map();
    this.silenceTimeoutMs = 60000;
    this.silentRecoveries = 0;
    this.gaps=[];
  }

  _state(state, error = '') {
    if (this.state !== state || this.error !== error) {
      this.state = state; this.error = error;
      if (state === 'listening') log.info(`[dm] 房间 ${this.rid} 弹幕监听正常`);
      else if (state === 'retrying' || state === 'failed') log.warn(`[dm] 房间 ${this.rid} ${state}: ${error}`);
    }
  }

  _schedule(open = false, delay = this.retryMs) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.timer = null; (open ? this._open() : this._check()).catch(e => {
      this._state('retrying', e.message); this._schedule(!this.win);
    }); }, delay);
    this.timer.unref();
  }

  _saveGaps(){try{writeJson(this.basePath+'.danmaku-status.json',{gaps:this.gaps});}catch{}}
  _ensureFile(){
    if(this.stopped)return null;
    if(this.file&&!this.file.destroyed&&!this.file.writableEnded)return this.file;
    let file;
    const failed=e=>{
      if(this.stopped||this.file!==file)return;
      this.file=null;try{file?.destroy();}catch{}
      if(!this.gaps.at(-1)||this.gaps.at(-1).end)this.gaps.push({start:Date.now(),end:null,error:e.message});
      this._saveGaps();this.recent.clear();
      this._state('retrying','弹幕写入失败，正在重试: '+e.message);this._schedule(false);
    };
    try{file=fs.createWriteStream(this.basePath+'.danmaku.jsonl',{flags:'a'});this.file=file;}
    catch(e){this.file=file;failed(e);throw e;}
    file.on('error',failed);
    file.once('open',()=>{
      const gap=this.gaps.at(-1);
      if(gap&&!gap.end){gap.end=Date.now();this._saveGaps();if(this.onGap)this.onGap(gap);}
    });
    return file;
  }

  async _check() {
    if (this.stopped || this.checking || !this.win) return;
    this.checking = true;
    const win = this.win;
    try {
      const file=this._ensureFile();
      if(!file)return;
      if(file.pending)await new Promise((resolve,reject)=>{
        const opened=()=>{file.removeListener('error',errored);resolve();};
        const errored=e=>{file.removeListener('open',opened);reject(e);};
        file.once('open',opened);file.once('error',errored);
      });
      if(this.stopped||this.win!==win||this.file!==file)return;
      const expected = '/' + this.rid;
      const expression = `(() => { if (location.pathname !== ${JSON.stringify(expected)}) return 'waiting:room'; return ${OBSERVER_JS}; })()`;
      const result = await evaluateNow(win.webContents, expression, this.scriptTimeoutMs);
      if (this.stopped || this.win !== win) return;
      if (result === 'alive' || String(result).startsWith('ok:')) {
        const lastActivity=Math.max(this.openedAt||Date.now(),this.lastCommentAt||0,this.lastReconnectAt||0);
        const limit=this.silenceTimeoutMs*Math.min(5,2**this.silentRecoveries);
        if(Date.now()-lastActivity>=limit){
          this.lastReconnectAt=Date.now();this.silentRecoveries++;
          this._state('retrying',`已${Math.round(limit/1000)}秒没有采集到评论，正在重新连接聊天页`);
          await evaluateNow(win.webContents,'location.reload()',this.scriptTimeoutMs);
        } else this._state('listening');
      }
      else this._state('retrying', result === 'nohost' ? '尚未找到聊天区域，正在重试' : '房间页面尚未就绪，正在重试');
    } catch (e) { if (!this.stopped) this._state('retrying', e.message); }
    finally { this.checking = false; if (!this.opening || this.win) this._schedule(!this.win); }
  }

  // basePath: 与录像同名, 输出 basePath.danmaku.jsonl
  async start(rid, basePath) {
    if (this.stopped) return;
    this.rid = String(rid); this.basePath = basePath;
    return this._open();
  }

  async _open() {
    if (this.stopped || this.opening) return;
    this.opening = true;
    try { await this._openWindow(); } finally { this.opening = false; }
  }

  async _openWindow() {
    if (this.stopped) return;
    let win;
    try { win = await this.sess.openRoomWindow(this.rid); }
    catch (e) { if (!this.stopped) { this._state('retrying', e.message); this._schedule(true); } return; }
    if (this.stopped) {
      try { win.destroy(); } catch {}
      return;
    }
    this.win = win;
    this.openedAt = Date.now();
    const wc = this.win.webContents;
    try{this._ensureFile();}catch{}
    win.on('closed', () => {
      releaseEvaluation(wc);
      if (this.win === win) {
        this.win = null;
        if (!this.stopped) { this._state('retrying', '采集窗口已关闭，正在重新打开'); this._schedule(true); }
      }
    });
    wc.on('dom-ready', () => this._schedule(false, 0));
    wc.on('render-process-gone', () => { try { if (!win.isDestroyed()) win.destroy(); } catch {} });
    wc.on('console-message', (event) => {
      const msg = event.message;
      if (this.stopped || !this.file || this.file.destroyed || this.file.writableEnded) return;
      if (!msg || !msg.includes(MARK)) return;
      const text = msg.split(MARK).join('').trim();
      if (!isHumanComment(text)) return;
      const now = Date.now();
      if (this.recent.has(text) && now - this.recent.get(text) < 3000) return;
      this.recent.set(text, now);
      if (this.recent.size > 5000) for (const [key, at] of this.recent) if (now - at > 60000) this.recent.delete(key);
      const body=text.replace(/^[^：:]{1,30}[：:]\s*/, '');
      this.file.write(JSON.stringify({ t: now, text, body }) + '\n',e=>{
        if(e)return;
        this.count += 1;this.lastCommentAt = now; this.silentRecoveries = 0;
      });
    });
    // Install against the current DOM; heartbeat repairs navigation/root changes.
    await this._check();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const gap=this.gaps.at(-1);if(gap&&!gap.end){gap.end=Date.now();this._saveGaps();if(this.onGap)this.onGap(gap);}
    if (this.state !== 'failed') this._state('stopped');
    if (this.win) releaseEvaluation(this.win.webContents);
    try { this.win && this.win.destroy(); } catch {}
    if (this.file && !this.file.destroyed && !this.file.writableEnded) await new Promise((r) => this.file.end(r));
    log.info(`[dm] 采集结束, 共 ${this.count} 条`);
  }
}

module.exports = { DanmakuCapture, isHumanComment, OBSERVER_JS };
