// 抖音会话管理：共享热身页（Cookie/指纹热）+ 页面内 fetch 轮询
// M0 结论: 冷启动直开房间页会被 ERR_FAILED 挡, 一切房间访问必须从热身页页面内跳转
const { app, BrowserWindow, session } = require('electron');
const log = require('../util/log');
const { UA, sleep, douyinEnterUrl, douyinEnterUrlByRoomId } = require('../util/const');
const { normalizeEnter } = require('./adapter/douyin');
const { evaluateNow, releaseEvaluation } = require('./page-eval');
const {guardBackgroundPage}=require('./background-page');

// 带超时的页面加载(loadURL 可能永久挂起, 一律加护栏)
async function loadWithTimeout(win, url, ms = 20000, strict = false) {
  let timer;
  try{return await Promise.race([
    win.loadURL(url).catch(e=>{if(strict)throw e;}),
    new Promise((resolve,reject)=>{timer=setTimeout(()=>strict?reject(new Error('页面加载超时')):resolve(),ms);}),
  ]);}finally{clearTimeout(timer);}
}

// 带超时的页内 JS 执行(渲染器异常时 executeJavaScript 会永久挂起)
function execWithTimeout(wc, code, ms = 15000) {
  return evaluateNow(wc,code,ms).catch(()=>'');
}

class DouyinSession {
  constructor() {
    this.win = null;
    this.warming = null;
    this.profileWins = new Map(); // secUid -> 常驻主页监控窗口
    this.profileReloads = new Map(); // secUid -> 上次刷新时间
    this.identityCache=new Map();this.identityRequests=new Map();
  }

  get ready() {
    return !!(this.win && !this.win.isDestroyed() && !this.win.webContents.isDestroyed() && !this.win.webContents.isCrashed());
  }

  async ensure() {
    if (this.ready) return;
    if (this.warming) return this.warming;
    this.warming = this._warm().finally(() => (this.warming = null));
    return this.warming;
  }

  async _warm() {
    const ses = session.defaultSession;
    ses.setUserAgent(UA);
    const win = new BrowserWindow({
      show: false,
      width: 1380,
      height: 860,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.setAudioMuted(true);
    await guardBackgroundPage(win);
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      log.warn('[session] 热身页窗口关闭');
    });
    win.webContents.on('render-process-gone', (_e, d) => {
      log.error('[session] 热身页渲染进程崩溃, 下次请求重建:', d.reason);
      if (this.win === win) this.win = null;
      try { if (!win.isDestroyed()) win.destroy(); } catch {}
    });

    log.info('[session] 热身页加载直播首页 ...');
    try {
      await loadWithTimeout(win,'https://live.douyin.com/',20000,true);
    } catch (e) {
      log.error('[session] 热身页加载失败:', e.message);
      try { win.destroy(); } catch {}
      throw e;
    }
    await sleep(6000);
    if (win.isDestroyed() || win.webContents.isCrashed()) throw new Error('热身页渲染器已退出');
    this.win = win;
    log.info('[session] 热身完成');
  }

  // 在热身页上下文内 fetch enter API（同源、自动带 Cookie）→ 统一房间信息
  async getRoomInfo(rid) {
    await this.ensure();
    const url = douyinEnterUrl(rid);
    const text = await execWithTimeout(
      this.win.webContents,
      `fetch(${JSON.stringify(url)}, {credentials:'include'})
         .then(r => r.text())
         .catch(e => JSON.stringify({__fetchErr: String(e && e.message || e)}))`,
      12000,
    );
    if (!text) throw new Error('页内fetch超时');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('enter 非JSON: ' + String(text).slice(0, 120));
    }
    if (json.__fetchErr) throw new Error('页内fetch失败: ' + json.__fetchErr);
    if (json.status_code !== 0) throw new Error('enter status_code=' + json.status_code);
    return normalizeEnter(json, rid);
  }

  // 将用户输入解析为房间: 支持 房间号 / 直播间链接 / 个人主页链接(含sec_uid) / v.douyin.com 分享短链
  // 安全约束: 仅 http/s 且域名必须是 douyin.com 子域(拒绝其余主机/内网地址)
  async resolveToRoom(input) {
    await this.ensure();
    const raw = String(input || '').trim();
    if (/^\d{6,13}$/.test(raw)) return { rid: raw, secUid: '', nickname: '' };

    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new Error('无法识别: 请输入房间号或抖音链接');
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error('仅支持 http/https 链接');
    if (!/(^|\.)douyin\.com$/i.test(u.hostname)) throw new Error('仅支持抖音(douyin.com)的链接');

    const secM = raw.match(/MS4wLjABAAAA[A-Za-z0-9_-]+/);
    const ridM = u.pathname.match(/\/(\d{6,13})(?:[/?#]|$)/);
    if (ridM) return { rid: ridM[1], secUid: secM ? secM[0] : '', nickname: '' };

    let secUid = secM ? secM[0] : '';
    if (!secUid) {
      // 短链等: 隐藏窗口跟随跳转拿最终地址
      const finalUrl = await this._followUrl(raw);
      const sec2 = finalUrl.match(/MS4wLjABAAAA[A-Za-z0-9_-]+/);
      const rid2 = finalUrl.match(/douyin\.com\/(\d{6,13})/);
      if (rid2) return { rid: rid2[1], secUid: sec2 ? sec2[0] : '', nickname: '', offlineWatch: false };
      if (!sec2) throw new Error('链接中未找到主播信息');
      secUid = sec2[0];
    }
    // 主页链接: DOM 扫描直播入口(在播则有链接, 离线则进入主页监控模式)
    const rid = await this._profileDomScan(secUid);
    if (rid) return { rid, secUid, nickname: '', offlineWatch: false };
    return { rid: '', secUid, nickname: '', offlineWatch: true };
  }

  // 隐藏窗口打开链接, 返回最终跳转地址(仅用于已通过域名校验的 douyin.com 链接)
  async _followUrl(url) {
    const win = new BrowserWindow({
      show: false, width: 900, height: 700,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await loadWithTimeout(win, url, 15000);
      await sleep(4000);
      return win.webContents.getURL();
    } finally {
      try { win.destroy(); } catch {}
    }
  }

  // 离线也取主播昵称: 打开主页页读 DOM(标题/h1/nickname元素/og:title 四重兜底), 纯字面量脚本零注入
  async getProfileNickname(secUid) {
    await this.ensure();
    if (!/^MS4wLjABAAAA[A-Za-z0-9_-]{10,120}$/.test(String(secUid || ''))) return '';
    const profileUrl = 'https://www.douyin.com/user/' + secUid;
    for (let attempt = 0; attempt < 2; attempt++) {
      const win = new BrowserWindow({
        show: false, width: 1280, height: 860,
        webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
      });
      win.webContents.setAudioMuted(true);
      await guardBackgroundPage(win);
      try {
        await loadWithTimeout(win, profileUrl, 20000);
        await sleep(attempt === 0 ? 8000 : 12000);
        const nick = await execWithTimeout(
          win.webContents,
          `(() => {
            const clean = (s) => {
              s = String(s || '').trim();
              const m = s.match(/^(.{1,30}?)(?:的抖音|的个人主页|的主页|\\s*-\\s*抖音)/);
              const v = (m ? m[1] : s).trim();
              return (v && !/^(抖音|douyin|记录美好生活|个人主页)/i.test(v)) ? v.slice(0, 30) : '';
            };
            const h1 = document.querySelector('h1');
            if (h1 && h1.innerText.trim()) return clean(h1.innerText);
            const meta = document.querySelector('meta[property="og:title"]');
            if (meta && meta.content && clean(meta.content)) return clean(meta.content);
            const nickEl = document.querySelector('[class*="nickname"], [data-e2e*="user-info"] span');
            if (nickEl && nickEl.innerText.trim()) return clean(nickEl.innerText);
            return clean(document.title);
          })()`,
          8000,
        );
        if (nick) return String(nick).slice(0, 30);
      } finally {
        try { win.destroy(); } catch {}
      }
    }
    return '';
  }

  // 主页监控: 常驻隐藏主页页, DOM 扫描直播入口(页面自己轮询自己的API并渲染, 无需我们处理签名)
  // 每 PROFILE_RELOAD_MS 刷新一次页面, 保证状态新鲜(主播开播后最迟一个刷新周期内可发现)
  async _profileDomScan(secUid) {
    let win = this.profileWins.get(secUid);
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        show: false, width: 1280, height: 860,
        webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
      });
      win.webContents.setAudioMuted(true);
      this.profileWins.set(secUid, win);
      win.on('closed', () => {
        if(this.profileWins.get(secUid)===win){this.profileWins.delete(secUid);this.profileReloads.delete(secUid);}
      });
      this.profileReloads.set(secUid, Date.now());
      await guardBackgroundPage(win);
      if(win.isDestroyed()||this.profileWins.get(secUid)!==win)return '';
      await loadWithTimeout(win, 'https://www.douyin.com/user/' + secUid, 20000);
      if(win.isDestroyed()||this.profileWins.get(secUid)!==win)return '';
      await sleep(8000);
    } else {
      // 定期刷新: 页面是SPA, 不刷新可能永远不渲染新开播状态
      const last = this.profileReloads.get(secUid) || 0;
      if (Date.now() - last > 60000) {
        this.profileReloads.set(secUid, Date.now());
        try { win.webContents.reload(); } catch {}
        await sleep(6000);
      }
    }
    // 纯字面量脚本: 扫描指向直播间的链接
    const found = await execWithTimeout(
      win.webContents,
      `(() => {
        const rooms=new Set();
        const links = document.querySelectorAll('a[href*="live.douyin.com/"], [class*="live"] a[href]');
        for (const a of links) {
          const m = (a.href || '').match(/live\\.douyin\\.com\\/(\\d{6,13})/);
          if (m) rooms.add(m[1]);
        }
        return Array.from(rooms).slice(0,8);
      })()`,
      10000,
    );
    if(this.identityCache.size>500)for(const [rid,item] of this.identityCache)if(Date.now()-item.at>30000)this.identityCache.delete(rid);
    for(const rid of Array.isArray(found)?found:found?[found]:[]){
      try{
        let cached=this.identityCache.get(rid);
        if(!cached||Date.now()-cached.at>30000){
          let pending=this.identityRequests.get(rid);
          if(!pending){pending=this.getRoomInfo(rid).then(info=>{const entry={secUid:info.secUid,at:Date.now()};this.identityCache.set(rid,entry);return entry;}).catch(e=>{this.identityCache.set(rid,{secUid:'',at:Date.now()});throw e;}).finally(()=>this.identityRequests.delete(rid));this.identityRequests.set(rid,pending);}
          cached=await pending;
        }
        if(cached.secUid===secUid)return rid;
      }catch(e){log.debug('[session] 主页候选房间暂时无法核验:',rid,e.message);break;}
    }
    return '';
  }

  // 打开可见的抖音登录页(用户扫码); 登录态写入共享会话, 所有隐藏页共享
  async openLoginWindow() {
    await this.ensure();
    const win = new BrowserWindow({
      show: true,
      width: 420,
      height: 680,
      title: '扫码登录抖音 (关闭窗口即完成)',
      webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
    });
    try {
    await loadWithTimeout(win, 'https://live.douyin.com/', 20000, true);
    await sleep(2000);
    // 页面内点开登录弹窗(拟人路径: 顶部登录按钮)
    await execWithTimeout(win.webContents,`(() => {
        const btn = [...document.querySelectorAll('button,div,span')].find(e => (e.innerText||'').trim() === '登录');
        if (btn) { btn.click(); return 'clicked'; }
        return 'nobutton';
      })()`,8000);
    win.on('closed', () => log.info('[session] 登录窗口已关闭(登录态已保留在会话中)'));
    return win;
    } catch (error) {
      try { if (!win.isDestroyed()) win.destroy(); } catch {}
      throw error;
    }
  }

  closeProfileWindows() {
    for (const w of this.profileWins.values()) {
      try { w.destroy(); } catch {}
    }
    this.profileWins.clear();
    this.profileReloads.clear();
  }

  // 销毁单个主页监控窗口(转正/移除监控时调用; 只删 Map 不销毁会泄漏整页 SPA 常驻数百MB)
  closeProfileWindow(secUid) {
    const w = this.profileWins.get(secUid);
    if (w) {
      try { w.destroy(); } catch {}
      this.profileWins.delete(secUid);
      this.profileReloads.delete(secUid);
    }
  }

  // 通过 room_id 查完整房间信息(热身页内 fetch, 同 getRoomInfo 模式)
  async getRoomInfoByRoomId(roomId) {
    await this.ensure();
    if (!/^\d{10,20}$/.test(String(roomId || ''))) throw new Error('非法 room_id');
    const url = douyinEnterUrlByRoomId(String(roomId));
    const text = await execWithTimeout(
      this.win.webContents,
      `fetch(${JSON.stringify(url)}, {credentials:'include'})
         .then(r => r.text())
         .catch(e => JSON.stringify({__fetchErr: String(e && e.message || e)}))`,
      12000,
    );
    if (!text) throw new Error('页内fetch超时');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('enter(byRoomId) 非JSON: ' + String(text).slice(0, 80));
    }
    if (json.__fetchErr) throw new Error('enter(byRoomId) 失败: ' + json.__fetchErr);
    if (json.status_code !== 0) throw new Error('enter(byRoomId) status_code=' + json.status_code);
    const d0 = json?.data?.data?.[0] || {};
    if (!/^\d{6,13}$/.test(String(d0.web_rid || ''))) throw new Error('未能从 room_id 解析 web_rid');
    return { info: normalizeEnter(json, String(d0.web_rid)) };
  }

  // 创建到达指定房间的窗口：先开首页热身，再页面内跳转（M0 验证的唯一可行路径）
  // visible=false: 后台隐藏采集页(静音); visible=true: 用户观看窗口(有声)
  async openRoomWindow(rid, visible = false) {
    await this.ensure();
    const ridDigits = String(rid).replace(/[^0-9]/g, '').slice(0, 13);
    if (!ridDigits) throw new Error('非法房间号');
    const win = new BrowserWindow({
      show: !!visible,
      width: 1380,
      height: 860,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
    });
    const wc = win.webContents;
    if (!visible) { wc.setAudioMuted(true);await guardBackgroundPage(win); }
    try {
      await loadWithTimeout(win,'https://live.douyin.com/',20000,true);
      await sleep(4000);
    // ridDigits 严格为纯数字(上文已剥离), 以数字字面量拼接, 无注入面
      try { await evaluateNow(wc, 'location.href = "/" + ' + ridDigits); }
      finally { releaseEvaluation(wc); }
      return win;
    } catch (e) {
      try { if (!win.isDestroyed()) win.destroy(); } catch {}
      throw e;
    }
  }
}

module.exports = { DouyinSession };
