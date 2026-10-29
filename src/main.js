// 直播自动录制 — 主进程入口: 主窗口 + 托盘 + 系统通知 + IPC
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, shell, powerSaveBlocker, dialog, clipboard } = require('electron');

// 锚定进程工作目录到项目根(弹幕烧录的 ass=dm.ass 相对路径依赖此设定)
process.chdir(path.join(__dirname, '..'));

const log = require('./util/log');
const { load, save } = require('./core/store');
const { Scheduler } = require('./core/scheduler');
const { makeTrayIconPng } = require('./util/mkicon');
const { openDirectory } = require('./util/open-directory');
const { recordingPath, listRecordings, openRecording } = require('./util/recording-browser');
const { registerProtocolHandlers, unregisterProtocolHandlers, isProtocolInvocation, ignoreProtocolOpen, installNavigationGuards, installInternalProtocolGuards } = require('./util/protocols');

if (!app.requestSingleInstanceLock()) {
  log.info('已有实例在运行, 退出');
  app.quit();
} else {
  const health=require('./util/app-health').installHealth(require('electron'),log,path.join(__dirname,'..'));
  let mainWin = null;
  let tray = null;
  let sched = null;
  let cfg = null;
  let quitting = false;
  const watchWins = new Set();
  const roomWins = new Map();
  let loginWin = null;
  const RID_RE = /^\d{6,13}$/;

  // ---------- 窗口 ----------
  function createWindow() {
    mainWin = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 940,
      minHeight: 620,
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'gui', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWin.loadFile(path.join(__dirname, 'gui', 'index.html'));
    let failures=[];
    mainWin.webContents.on('render-process-gone',(_e,details)=>{
      log.error('[gui] 主界面渲染器退出，后台任务继续:',details.reason);
      failures=failures.filter(at=>Date.now()-at<60000);failures.push(Date.now());
      if(failures.length>5){notify('界面恢复失败','后台录制继续运行，可从菜单重新加载界面');return;}
      const target=mainWin;setTimeout(()=>{
        if(!quitting&&!target.isDestroyed())target.webContents.reload();
      },Math.min(5000,250*2**(failures.length-1))).unref();
    });
    mainWin.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        mainWin.hide();
      }
    });
    // 真正销毁时清引用(quit流程中允许关闭后窗口销毁): 防止残留的 destroyed 引用
    const winRef = mainWin;
    winRef.on('closed', () => { if (mainWin === winRef) mainWin = null; });
  }

  function pushState() {
    if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isDestroyed() && !mainWin.webContents.isCrashed() && sched) {
      mainWin.webContents.send('state', sched.snapshot());
    }
  }

  function notify(title, body) {
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch {}
  }

  function createTray() {
    const img = nativeImage.createFromBuffer(makeTrayIconPng());
    tray = new Tray(img);
    tray.setToolTip('直播自动录制 (后台运行中)');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主界面', click: () => showWindow() },
        { label: '打开录像目录', click: async () => { const r=await openDirectory(sched.outDir,{shell}); if(!r.ok) notify('录像目录打开失败',r.error); } },
        { type: 'separator' },
        { label: '⏸ 暂停全部录制', click: () => { sched.pauseAll(); pushState(); } },
        { label: '⏵ 继续全部录制', click: () => { sched.resumeAll(); pushState(); } },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            quit('tray');
          },
        },
      ]),
    );
    tray.on('click', () => showWindow());
  }

  function showWindow() {
    // 窗口可能已被销毁而引用仍在(渲染器反复崩溃/异常路径): 此时重建而非抛
    // "Object has been destroyed"(该异常曾让双击快捷方式/托盘点击全部无响应)
    if (!mainWin || mainWin.isDestroyed()) return createWindow();
    mainWin.show();
    mainWin.focus();
  }

  // ---------- Webhook 通知(防SSRF: 仅公网 http/https, 拒绝内网/环回/保留地址) ----------
  function webhookUrlSafe(raw) {
    try {
      const u = new URL(String(raw));
      if (!/^https?:$/.test(u.protocol)) return null;
      const h = u.hostname.toLowerCase();
      const bad =
        h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal') ||
        /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^0\./.test(h);
      return bad ? null : u.href;
    } catch {
      return null;
    }
  }

  let webhookBusy = false;
  function sendWebhook(type, data) {
    const url = webhookUrlSafe(cfg && cfg.settings.webhookUrl);
    if (!url || webhookBusy) return;
    webhookBusy = true;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: '直播自动录制', event: type, at: new Date().toISOString(), ...data }),
      signal: AbortSignal.timeout(10000),
    })
      .catch(() => {})
      .finally(() => (webhookBusy = false));
  }

  // ---------- 开机自启 ----------
  function applyAutoStart() {
    try {
      app.setLoginItemSettings({ openAtLogin: !!(cfg.settings.autoStart) });
    } catch {}
  }

  // ---------- 防休眠(对齐 biliLive-tools preventSystemSleep) ----------
  let sleepBlockerId = null;
  function applySleepBlock() {
    try {
      if (cfg.settings.preventSleep && sleepBlockerId === null) {
        sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        log.info('[app] 已阻止系统休眠(录制期间保持唤醒)');
      } else if (!cfg.settings.preventSleep && sleepBlockerId !== null) {
        powerSaveBlocker.stop(sleepBlockerId);
        sleepBlockerId = null;
        log.info('[app] 已取消阻止休眠');
      }
    } catch {}
  }

  // ---------- IPC ----------
  // 统一包裹: 任何处理器异常都转为 {ok:false,error} 返回, 绝不裸 reject(裸 reject 会让渲染层按钮静默失效)
  const ipcPending = new Map();
  const H = (name, fn) => {
    ipcMain.handle(name, async (...args) => {
      const key = name + ':' + JSON.stringify(args.slice(1));
      if (ipcPending.has(key)) return ipcPending.get(key);
      const operation = Promise.resolve().then(() => fn(...args)).catch(e => {
        log.error(`[ipc:${name}]`,e&&e.message);
        return {ok:false,error:e&&e.message||'操作失败'};
      });
      ipcPending.set(key,operation);
      try {
        return await operation;
      } catch (e) {
        log.error(`[ipc:${name}]`, e && e.message);
        return { ok: false, error: e && e.message };
      } finally { if(ipcPending.get(key)===operation)ipcPending.delete(key); }
    });
  };

  function parseRid(input) {
    if (typeof input !== 'string') return '';
    const m = input.match(/(\d{6,13})/);
    return m ? m[1] : '';
  }

  H('state:get', () => (sched ? sched.snapshot() : null));

  H('company:action', (_e, action, data) => {
    const next=require('./core/companies').updateCompanies(cfg,action,data||{});
    save(next);
    cfg=next;
    sched.setConfig(cfg);
    return {ok:true};
  });

  H('streamer:add', async (_e, input, name, mode) => {
    const wantProfile = String(mode || 'fast') === 'profile';
    try {
      const r = await sched.sess.resolveToRoom(String(input || ''));
      // 主页导入已识别出房间号时直接使用秒级监控，不再丢弃识别结果。
      if (!wantProfile || r.rid) {
        // ⚡秒级模式: 必须解析出房间号
        if (r.rid) {
          if (cfg.watchlist.some((w) => String(w.rid) === r.rid)) {
            return { ok: false, error: `该主播已在监控中 (房间 ${r.rid})` };
          }
          // 自动获取主播真名(enter 接口返回 owner 信息, 离线也可查)
          let nickname = r.nickname || '';
          if (!nickname) {
            try {
              const info = await sched.sess.getRoomInfo(r.rid);
              nickname = (info && info.nickname) || '';
            } catch {}
          }
          if(cfg.watchlist.some(w=>String(w.rid)===r.rid))return {ok:false,error:'该主播已在监控中'};
          const watchlist=[...cfg.watchlist,{ rid: r.rid, name: String(name || '').slice(0, 30), nickname, secUid: r.secUid || '' }];
          save({...cfg,watchlist});cfg.watchlist=watchlist;
          sched.setConfig(cfg);
          log.info(`[gui] 添加监控 ${r.rid} (${nickname || '未命名'}) [秒级]`);
          return { ok: true, rid: r.rid, nickname, mode: 'fast' };
        }
        if (r.offlineWatch) {
          return {
            ok: false,
            error: '该主播当前离线, 秒级模式拿不到房间号。请切换到「👤 主页监控」模式添加',
          };
        }
        return { ok: false, error: '未能解析出直播间' };
      }
      // 👤主页模式: 强制按 sec_uid 挂主页监控
      let secUid = r.secUid || '';
      if (!secUid && r.rid) {
        // 输入是房间: 反查主播 sec_uid
        const info = await sched.sess.getRoomInfo(r.rid);
        secUid = info.secUid || '';
      }
      if (!secUid) return { ok: false, error: '未能取得该主播的主页标识, 请直接粘贴其个人主页链接' };
      if (cfg.watchlist.some((w) => String(w.secUid || '') === secUid)) {
        return { ok: false, error: '该主播已在监控中' };
      }
      // 主页模式取名: 在播走房间信息; 离线直接读主页DOM(立即显示真名, 不等开播)
      let nickname = r.nickname || '';
      if (!nickname && r.rid) {
        try {
          const info = await sched.sess.getRoomInfo(r.rid);
          nickname = (info && info.nickname) || '';
        } catch {}
      }
      if (!nickname) {
        try { nickname = await sched.sess.getProfileNickname(secUid); } catch {}
      }
      if(cfg.watchlist.some(w=>String(w.secUid||'')===secUid))return {ok:false,error:'该主播已在监控中'};
      const watchlist=[...cfg.watchlist,{ rid: '', secUid, name: String(name || '').slice(0, 30), nickname }];
      save({...cfg,watchlist});cfg.watchlist=watchlist;
      sched.setConfig(cfg);
      log.info(`[gui] 添加主页监控 (${nickname || secUid.slice(0, 20)}) [主页模式]`);
      return { ok: true, nickname, mode: 'profile' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  H('streamer:remove', (_e, rid) => {
    const s = String(rid || '');
    const isRid = RID_RE.test(s);
    const isSec = /^MS4wLjABAAAA[A-Za-z0-9_-]{10,120}$/.test(s);
    if (!isRid && !isSec) return { ok: false, error:'监控标识无效，请刷新界面后重试' };
    if (!cfg.watchlist.some(w => String(w.rid || '') === s || String(w.secUid || '') === s)) return {ok:false,error:'该监控项已不存在，请刷新界面'};
    const watchlist = cfg.watchlist.filter((w) => {
      if (isRid && String(w.rid || '') === s) return false;
      if (isSec && String(w.secUid || '') === s) return false;
      return true;
    });
    save({...cfg,watchlist});cfg.watchlist=watchlist;
    sched.setConfig(cfg);
    return { ok: true };
  });

  H('monitor:set-paused', (_e, id, paused) => {
    if(typeof paused!=='boolean')return {ok:false,error:'监控状态无效'};
    const key=String(id||'');const original=cfg.watchlist.find(w=>String(w.rid||w.secUid||'')===key);
    if(!original)return {ok:false,error:'未找到监控项'};
    const task=sched.tasks.get(original.rid?String(original.rid):'sec:'+String(original.secUid));
    const watchlist=cfg.watchlist.map(w=>w===original?{...w,monitorPaused:paused}:w);
    try{save({...cfg,watchlist});}catch(e){return {ok:false,error:'保存监控状态失败：'+e.message};}
    cfg.watchlist=watchlist;sched.setConfig(cfg);
    if(paused&&task?.state==='recording')sched._stopJob(task,'暂停主播监控').catch(e=>log.error('[monitor] 停止录制失败:',e.message));
    pushState();return {ok:true};
  });

  H('record:stop', async (_e, rid) => {
    const t = sched.tasks.get(String(rid));
    if (t && (t.state === 'recording' || t.stopPromise)) return await sched._stopJob(t, '界面手动停止');
    return { ok: false, error: '该直播间当前没有正在录制的任务' };
  });

  H('record:pause', async (_e, rid) => {
    const t = sched.tasks.get(String(rid));
    if (!t || t.state !== 'recording' || t.stopping) return {ok:false,error:'当前任务无法暂停，请等待状态刷新'};
    const result=await sched._pauseJob(t);
    pushState();
    return result;
  });

  H('record:resume', async (_e, rid) => {
    const t = sched.tasks.get(String(rid));
    if (!t || t.stopping || !((t.state === 'recording' && t.paused) || (t.state === 'idle' && t.manualStopped))) return {ok:false,error:'当前任务无法继续，请等待状态刷新'};
    const result=await sched._resumeJob(t);
    pushState();
    return result;
  });
  H('post:retry',(_e,id)=>{
    if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))return {ok:false,error:'任务标识无效'};
    return sched.recovery.requestRetry(id,true);
  });

  // 后处理单任务: 暂停/恢复/调序
  const POST_ID_RE = /^[a-z0-9-]{1,48}$/i;
  H('post:pause', (_e, id) => {
    if (typeof id !== 'string' || !POST_ID_RE.test(id)) return { ok: false, error: '任务标识无效' };
    return sched.recovery.pauseTask(id);
  });
  H('post:resume', (_e, id) => {
    if (typeof id !== 'string' || !POST_ID_RE.test(id)) return { ok: false, error: '任务标识无效' };
    return sched.recovery.requestResume(id);
  });
  H('post:move', (_e, id, dir) => {
    if (typeof id !== 'string' || !POST_ID_RE.test(id)) return { ok: false, error: '任务标识无效' };
    if (!['up','down','top'].includes(dir)) return { ok: false, error: '方向无效' };
    return sched.recovery.moveTask(id, dir);
  });
  H('post:now',(_e,id)=>typeof id==='string'&&POST_ID_RE.test(id)?sched.recovery.runNow(id):{ok:false,error:'任务标识无效'});
  H('post:cancel',(_e,id)=>typeof id==='string'&&POST_ID_RE.test(id)?sched.recovery.cancelTask(id):{ok:false,error:'任务标识无效'});
  H('post:remove',(_e,id)=>typeof id==='string'&&POST_ID_RE.test(id)?sched.recovery.removeCompleted(id):{ok:false,error:'任务标识无效'});

  H('room:watch', async (_e, rid) => {
    if (!RID_RE.test(String(rid || ''))) return { ok: false, error:'直播间房间号无效' };
    try {
      const existing=roomWins.get(String(rid));
      if(existing&&!existing.isDestroyed()){if(existing.isMinimized())existing.restore();existing.show();existing.focus();return {ok:true};}
      const win = await sched.sess.openRoomWindow(String(rid), true);
      win.setTitle('观看中 (关闭不影响录制)');
      watchWins.add(win);
      roomWins.set(String(rid),win);
      if(win.isMinimized())win.restore();win.show();win.focus();
      win.on('closed', () => { watchWins.delete(win); if(roomWins.get(String(rid))===win)roomWins.delete(String(rid)); });
      return { ok: true };
    } catch (e) {
      log.error('[gui] 打开观看窗口失败:', e.message);
      return { ok: false, error: e.message };
    }
  });

  H('recordings:open', async () => {
    log.info('[gui] 请求打开录像目录:', sched.outDir);
    return listRecordings(sched.outDir);
  });
  H('recordings:list',(_e,relative)=>listRecordings(sched.outDir,relative));
  H('recordings:system-open',async(_e,relative)=>openDirectory((await recordingPath(sched.outDir,relative)).target,{shell}));
  H('recordings:copy',async(_e,relative)=>{const {target}=await recordingPath(sched.outDir,relative);clipboard.writeText(target);return {ok:true,path:target};});
  H('recordings:play',(_e,relative)=>openRecording(sched.outDir,relative,shell));

  H('settings:update', (_e, patch) => {
    if (patch && typeof patch.webhookUrl === 'string' && !webhookUrlSafe(patch.webhookUrl) && patch.webhookUrl) {
      return { ok: false, error: 'Webhook 地址无效(仅支持公网 http/https)' };
    }
    sched.updateSettings(patch || {});
    applyAutoStart();
    applySleepBlock();
    pushState();
    return { ok: true };
  });

  // 批量导入: 每行 "链接 [备注]" 顺序解析添加
  H('streamer:batch', async (_e, text) => {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 100);
    const okList = [];
    const failList = [];
    for (const line of lines) {
      const sp = line.split(/\s+/);
      const input = sp[0];
      const name = sp.slice(1).join(' ').slice(0, 30);
      try {
        const r = await sched.sess.resolveToRoom(input);
        const key = r.rid || r.secUid;
        const dup = r.rid
          ? cfg.watchlist.some((w) => String(w.rid) === r.rid)
          : cfg.watchlist.some((w) => String(w.secUid || '') === r.secUid);
        if (dup) {
          failList.push(`${line} -> 已存在`);
          continue;
        }
        cfg.watchlist.push({ rid: r.rid || '', secUid: r.secUid || '', name: name || r.nickname || '' });
        okList.push(key);
      } catch (e) {
        failList.push(`${line} -> ${e.message}`);
      }
    }
    if (okList.length) {
      save(cfg);
      sched.setConfig(cfg);
    }
    return { ok: true, added: okList.length, failed: failList };
  });

  // 导出监控列表到录像目录
  H('streamer:export', async () => {
    const lines = cfg.watchlist.map((w) => {
      const link = w.rid ? `https://live.douyin.com/${w.rid}` : `https://www.douyin.com/user/${w.secUid}`;
      return link + (w.name ? '\t' + w.name : '') + (w.titleFilter ? '\t过滤:' + w.titleFilter : '') + (w.hours ? '\t时段:' + w.hours : '');
    });
    const outPath = path.join(sched.outDir, '监控列表导出.txt');
    await fs.promises.mkdir(sched.outDir,{recursive:true});
    await fs.promises.writeFile(outPath, lines.join('\r\n') + '\r\n', 'utf8');
    const opened=await openDirectory(sched.outDir,{shell});
    return { ok: true, path: outPath, count: lines.length, warning:opened.ok?'':opened.error };
  });

  // 日志尾部(界面日志页): 只读最后256KB(整文件全量读在日志变大后面板会卡)
  H('logs:tail', () => {
    const file = log.currentLogFile();
    try {
      const fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      return { ok: true, lines: buf.toString('utf8').split(/\r?\n/).slice(-200) };
    } catch {
      return { ok: true, lines: ['(暂无日志)'] };
    }
  });

  // 清空历史记录列表(仅列表, 不动录像文件)
  H('history:clear', () => {
    require('./util/atomic-json').writeJson(sched.historyFile,[],{backup:true});
    sched.history = [];
    pushState();
    log.info('[gui] 历史记录已清空');
    return { ok: true };
  });

  // 打开抖音登录页(扫码后可解锁部分主播的原画档)
  H('account:login', async () => {
    try {
      if(loginWin&&!loginWin.isDestroyed()){if(loginWin.isMinimized())loginWin.restore();loginWin.show();loginWin.focus();return {ok:true};}
      const win = await sched.sess.openLoginWindow();
      loginWin=win;win.on('closed',()=>{if(loginWin===win)loginWin=null;});
      if(win.isMinimized())win.restore();win.show();win.focus();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 单房间配置更新(标题过滤/值守时段); rid 归一化: 界面传裸secUid或sec:前缀均可匹配
  H('streamer:config', (_e, rid, patch) => {
    const key = String(rid || '');
    const bareSec = key.startsWith('sec:') ? key.slice(4) : key;
    const original = cfg.watchlist.find((w) => String(w.rid || '') === key || String(w.secUid || '') === bareSec);
    if (!original) return { ok: false, error: '未找到该监控项' };
    const item={...original};
    if (patch && patch.titleFilter) {
      try { new RegExp(String(patch.titleFilter)); } catch { return { ok: false, error: '标题过滤正则无效' }; }
    }
    if (patch && patch.hours && !/^(?:[01]?\d|2[0-3]):[0-5]\d-(?:[01]?\d|2[0-3]):[0-5]\d$/.test(String(patch.hours))) {
      return { ok: false, error: '时段格式应为 HH:MM-HH:MM，小时 00–23，分钟 00–59' };
    }
    if ('titleFilter' in (patch || {})) item.titleFilter = String(patch.titleFilter || '').slice(0, 100);
    if ('hours' in (patch || {})) item.hours = String(patch.hours || '').slice(0, 20);
    if ('name' in (patch || {})) item.name = String(patch.name || '').slice(0, 30);
    const watchlist=cfg.watchlist.map(w=>w===original?item:w);save({...cfg,watchlist});cfg.watchlist=watchlist;
    sched.setConfig(cfg);
    return { ok: true };
  });

  // ---------- 生命周期 ----------
  // 深链唤起(隐藏页触发的 douyin:// 等, 经注册表路由回来)静默吞掉:
  // 此前无条件 showWindow() 造成主窗口每分钟被顶出抢焦点 2-3 次
  app.on('second-instance', (_e, argv) => {
    if (isProtocolInvocation(argv)) {
      log.info('[proto] 拦截协议唤起-second-instance(已忽略)');
      return;
    }
    showWindow();
  });
  app.on('window-all-closed', () => { /* 托盘常驻 */ });

  // 拦截主框架、子框架和重定向的外部协议。
  app.on('web-contents-created', (_e, wc) => installNavigationGuards(wc));

  const quit = async (sig) => {
    if (quitting) return;
    quitting = true;
    health.expectedExit(sig||'quit');
    log.info(`[app] 收到 ${sig}, 优雅停机 ...`);
    notify('正在退出直播自动录制','正在停止录制并保存任务，未完成的后处理将在下次启动后继续。');
    if(tray)tray.setToolTip('正在退出：保存录制和处理任务');
    // 强制出口(按退出工作量自适应): 烧录队列15分钟 + 每GB待转封装30秒 + 1分钟缓冲。
    // 固定16分钟对大文件转封装不够(8GB实测1-2分钟, 多分片叠加可超), 超时强杀会截断mp4
    let capMs = 16 * 60 * 1000;
    try {
      const gb = (sched && sched.shutdownWorkloadBytes ? sched.shutdownWorkloadBytes() : 0) / 1073741824;
      capMs = 15 * 60 * 1000 + Math.ceil(gb * 30) * 1000 + 60 * 1000;
      log.info(`[app] 停机时限: ${(capMs / 60000).toFixed(1)}分钟 (待处理 ${gb.toFixed(1)}GB)`);
    } catch {}
    const forceExit = () => {
      if(sched&&(sched.pendingStops?.size||sched.post.busy||sched.post.hasRunnable||sched.recovery?.running?.size||sched.recovery?.mediaPool?.active?.size)){
        log.warn('[app] 仍有封存或烧录任务，延后退出，避免损坏录像');
        force=setTimeout(forceExit,600000);force.unref();return;
      }
      log.error('[app] 优雅停机超时, 强制退出');
      app.exit(0);
    };
    let force = setTimeout(forceExit, capMs);
    force.unref();
    try {
      if (sched) {
        sched.sess.closeProfileWindows();
        await sched.shutdown({deferProcessing:true});
      }
    } catch (e) {
      log.error('[app] 停机异常', e.message);
    }
    try { unregisterProtocolHandlers(); } catch {}
    clearTimeout(force);
    app.exit(0);
  };
  process.on('SIGINT', () => quit('SIGINT'));
  process.on('SIGTERM', () => quit('SIGTERM'));
  process.on('uncaughtException', (e) => log.error('[app] uncaught:', e.stack || e.message));
  process.on('unhandledRejection', (e) => log.error('[app] unhandled:', (e && e.stack) || e));

  app.whenReady().then(() => {
    // 注册为抖音系协议处理器: Windows 见到 douyin:// 等不再弹"选择应用"窗,
    // 唤起会路由到本应用并由 ignoreProtocolOpen 静默吞掉
    registerProtocolHandlers();
    installInternalProtocolGuards();
    ignoreProtocolOpen();
    cfg = load();
    sched = new Scheduler(cfg);
    // 热重载换新 cfg 对象时同步本引用(GUI 保存/IPC 都用 main 的 cfg, 不同步会回滚外部编辑)
    sched.onConfig = (c) => { cfg = c; applyAutoStart(); applySleepBlock(); };
    sched.onEvent = (type, data) => {
      pushState();
      if (type === 'live') notify(`${data.nickname || '主播'} 开播了`, data.title || '已自动开始录制');
      if (type === 'record-done') {
        const incomplete = data.warnings && data.warnings.length;
        const recovered=data.notices&&data.notices.length;
        notify(`${incomplete ? '录制已结束，部分源文件待处理' : recovered?'录像已修复':'录制完成'}: ${data.nickname || ''}`,
          incomplete ? '源文件已保留，请查看状态和日志。' : recovered?'可播放录像已生成，损坏原件已备份。':`时长 ${data.secs} 秒 · ${data.files.length} 个文件`);
      }
      if (type === 'record-error') notify('录像处理未完成，源文件已保留', data.error || '请查看日志');
      if (type === 'diskfull') notify('磁盘空间不足', '已停止全部录制, 请清理后重试');
      if (type === 'session-bad') notify('会话异常', '检测连续失败, 已自动重建会话; 若持续请检查网络或重新扫码登录');
      sendWebhook(type, data || {});
    };
    sched.start();
    createWindow();
    createTray();
    applyAutoStart();
    applySleepBlock();
    setInterval(pushState, 1000);
    log.info('[app] 桌面应用已启动');

    // 启动补名: 给历史无昵称的主页监控项取真名(逐个错峰, 每个约20秒)
    setTimeout(async () => {
      try {
        const pending = cfg.watchlist.filter((w) => w.secUid && !w.nickname && !w.name);
        for (const w of pending) {
          try {
            const nick = await sched.sess.getProfileNickname(w.secUid);
            const current = cfg.watchlist.find(item => item.secUid === w.secUid && String(item.rid || '') === String(w.rid || ''));
            if (nick && current && !current.nickname) {
              current.nickname = nick;
              save(cfg);
              sched.setConfig(cfg);
              log.info(`[backfill] 补名成功: ${nick}`);
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 3000));
        }
      } catch {}
    }, 15000).unref();

    // 自动化验证钩子(仅显式设置 LR_AUTOTEST 环境变量时生效):
    // 剧本: 等30s暂停 → 45s继续(part2) → 满段自动分段(part3) → 115s结束该场 → 165s烧完后退出
    if (process.env.LR_AUTOTEST) {
      log.info('[autotest] 自动化剧本启动');
      const firstRec = () => [...sched.tasks.values()].find((t) => t.state === 'recording');
      const at = (ms, fn) => setTimeout(fn, ms).unref();
      at(30000, async () => { const t = firstRec(); if (t) { await sched._pauseJob(t); pushState(); } });
      at(45000, async () => { const t = firstRec(); if (t) { await sched._resumeJob(t); pushState(); } });
      at(115000, async () => { const t = firstRec(); if (t) { await sched._stopJob(t, 'autotest结束'); pushState(); } });
      at(165000, () => { log.info('[autotest] 剧本完成, 退出'); quitting = true; health.expectedExit('autotest');app.exit(0); });
    }
  }).catch((e) => {
    // 启动链异常: 可见可退出, 不留"无窗口无托盘却占着单实例锁"的僵尸
    log.error('[app] 启动失败:', e && e.stack || e);
    try { dialog.showErrorBox('直播自动录制: 启动失败', String((e && e.message) || e) + '\n\n详见 logs 目录日志。'); } catch {}
    app.exit(1);
  });

  // 兜底: 任何退出路径(系统关机/任务管理器结束任务树/代码内app.quit)都先停录封存
  // (此前quit()只挂SIGINT, Windows GUI收不到, 托盘退出变成粗暴退出→孤儿flv)
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quit('before-quit');
  });
}

// 启动链任何异常必须可见可退出: 静默中断会变成"无窗口无托盘但占着单实例锁"的僵尸进程
process.on('unhandledRejection', (e) => {
  log.error('[app] unhandled:', e && e.stack || e);
});
