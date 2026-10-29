// 渲染进程: 仪表盘逻辑(纯原生JS, 无框架)
// 稳定性原则: 所有事件回调/渲染函数经 safe() 包裹 — 单点异常不拖垮整个界面
const $ = (id) => document.getElementById(id);
let state = null;

// ---- 防崩工具 ----
function uiFail(tag, e) {
  console.error('[ui]', tag || '', e && e.message);
  toast('界面处理出错[' + (tag || '?') + ']: ' + (e && e.message));
}
function safe(fn, tag) {
  return (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch((e) => uiFail(tag, e));
      return r;
    } catch (e) {
      uiFail(tag, e);
    }
  };
}
function toast(text) {
  try {
    const m = $('actionStatus');
    m.textContent = text;
    m.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { m.hidden = true; }, 10000);
  } catch {}
}
function checked(result) {
  if (!result || result.ok !== true) throw new Error(result?.error || '操作未完成，请查看日志后重试');
  return result;
}
const pendingActions = new Map();
async function buttonAction(button, key, operation, working = '处理中…', success = '') {
  if (pendingActions.has(key)) { toast('该操作仍在处理中，请稍候'); return; }
  const label = button.textContent;
  pendingActions.set(key, true);
  button.dataset.busy = 'true'; button.disabled = true; button.textContent = working;
  const slow = setTimeout(() => toast('操作仍在进行，请稍候；无需重复点击。'), 15000);
  try {
    const result = checked(await operation());
    if (success) toast(typeof success === 'function' ? success(result) : success);
    return result;
  } finally {
    clearTimeout(slow); pendingActions.delete(key);
    delete button.dataset.busy; button.disabled = false; button.textContent = label;
  }
}
// 保留行和按钮本身，只更新内容。鼠标按下到松开、键盘焦点和等待状态不会被刷新丢弃。
function reconcile(parent, incoming) {
  const old = [...parent.childNodes];
  const keyed = new Map(old.filter(n => n.dataset?.key).map(n => [n.dataset.key, n]));
  const kept = new Set();
  [...incoming.childNodes].forEach((fresh, index) => {
    let current = fresh.dataset?.key ? keyed.get(fresh.dataset.key) : old[index];
    if (!current || kept.has(current) || current.nodeName !== fresh.nodeName ||
        (current.dataset?.key || '') !== (fresh.dataset?.key || '')) current = fresh;
    if (current !== fresh) {
      if (current.nodeType === Node.TEXT_NODE) {
        if (current.textContent !== fresh.textContent) current.textContent = fresh.textContent;
      } else if (!current.dataset.busy) {
        for (const attr of [...current.attributes]) if (!fresh.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        for (const attr of [...fresh.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        current.onclick = fresh.onclick;
        reconcile(current, fresh);
      }
    }
    kept.add(current);
    if (parent.childNodes[index] !== current) parent.insertBefore(current, parent.childNodes[index] || null);
  });
  for (const node of old) if (!kept.has(node) && node.parentNode === parent) node.remove();
}
window.addEventListener('error', (e) => {
  console.error('[ui:global]', e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[ui:unhandled]', (e.reason && e.reason.message) || String(e.reason));
});

function fmtBytes(b) {
  if (!b) return '-';
  if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}
function fmtDur(ms) {
  if (!ms) return '-';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

// ---- 主表渲染 ----
function render() {
  if (!state || !state.tasks) return;
  $('diskInfo').textContent = `磁盘剩余 ${state.diskFreeGB} GB`;

  const tb = document.createElement('tbody');
  $('empty').hidden = state.tasks.length > 0;
  for (const t of state.tasks) {
    const tr = document.createElement('tr');
    tr.dataset.key = String(t.rid);

    const tdName = document.createElement('td');
    // 全部 textContent 构建: 主播昵称/备注是远端可控字符串, innerHTML 拼接可注入标签
    const displayName = t.dispName || (t.secWatch ? '待开播后识别' : '识别中…');
    const nameMain = document.createElement('div');
    nameMain.textContent = displayName;
    addCompanyRowControls(tdName,t);
    tdName.appendChild(nameMain);
    const subs = [];
    if (t.name && t.name !== displayName) subs.push('备注:' + t.name);
    if (t.titleFilter) subs.push('过滤:' + t.titleFilter);
    if (t.hours) subs.push('时段:' + t.hours);
    for (const s of subs) {
      const d = document.createElement('div');
      d.className = 'sub';
      d.textContent = s;
      tdName.appendChild(d);
    }

    const tdRid = document.createElement('td');
    tdRid.className = 'sub';
    tdRid.textContent = t.secWatch ? '主页监控' : t.rid;

    const tdState = document.createElement('td');
    let badge;
    if (t.monitorPaused) {
      badge = '<span class="badge paused">监控已暂停</span>';
    } else if (t.secWatch) {
      badge = '<span class="badge off">👤 主页监控中</span><div class="sub">首次识别房间后自动转秒级</div>';
    } else if (t.state === 'stopping') {
      badge = '<span class="badge">正在封存</span>';
    } else if (t.manualStopped && t.state === 'idle') {
      badge = '<span class="badge paused">本场已停录</span>';
    } else if (t.state === 'recording' && t.paused) {
      badge = '<span class="badge paused">⏸ 已暂停</span>';
    } else if (t.state === 'recording') {
      badge = '<span class="badge rec">● 录制中</span>';
    } else if (t.live) {
      badge = '<span class="badge live">直播中</span>';
    } else {
      badge = '<span class="badge off">离线</span>';
    }
    if (t.pollFails > 5) badge += `<div class="sub">轮询异常${t.pollFails}次</div>`;
    tdState.innerHTML = badge; // badge 全部为本文件内常量字面量, 无远端内容
    if (t.error) {
      const error = document.createElement('div'); error.className = 'sub'; error.textContent = t.error;
      tdState.appendChild(error);
    }
    if(t.notice){const notice=document.createElement('div');notice.className='sub';notice.textContent=t.notice;tdState.appendChild(notice);}

    const tdTitle = document.createElement('td');
    tdTitle.className = 'title-cell';
    tdTitle.textContent = t.title || '-';
    tdTitle.title = t.title || '';

    const tdDur = document.createElement('td');
    tdDur.textContent = t.state === 'recording' ? fmtDur(Date.now() - t.startedAt) : '-';

    const tdSize = document.createElement('td');
    tdSize.textContent = t.state === 'recording' ? fmtBytes(t.bytes) : '-';
    if (t.parts > 1) {
      const pd = document.createElement('div');
      pd.className = 'sub';
      pd.textContent = '分片' + t.parts;
      tdSize.appendChild(pd);
    }

    const tdDm = document.createElement('td');
    tdDm.textContent = t.state === 'recording' ? t.dmCount : '-';
    if (t.state === 'recording') {
      const labels = { starting: '初始化中', retrying: '重试中', failed: '采集失败' };
      if (labels[t.dmState]) tdDm.textContent = `${labels[t.dmState]} · ${t.dmCount || 0}`;
      tdDm.title = t.dmError || (t.dmState === 'listening' ? '弹幕监听正常' : '');
    }

    const tdOps = document.createElement('td');
    tdOps.className = 'ops';
    if (!t.secWatch && t.live) {
      const bw = document.createElement('button');
      bw.className = 'mini'; bw.textContent = '观看';
      bw.dataset.key = 'watch';
      bw.onclick = safe((e) => {
        return buttonAction(e.currentTarget, 'watch:' + t.rid, () => window.api.watch(t.rid), '打开中…', '观看窗口已打开');
      }, 'watch');
      tdOps.appendChild(bw);
    }
    if ((t.state === 'recording' && t.paused) || (t.state === 'idle' && t.manualStopped)) {
      const br = document.createElement('button');
      br.className = 'mini primary'; br.textContent = '⏵ 继续';
      br.dataset.key = 'resume';
      br.onclick = safe((e) => {
        return buttonAction(e.currentTarget, 'record:' + t.rid, () => window.api.resumeRecording(t.rid), '继续中…', '已继续录制');
      }, 'resume');
      tdOps.appendChild(br);
    } else if (t.state === 'recording') {
      const bp = document.createElement('button');
      bp.className = 'mini'; bp.textContent = '⏸ 暂停';
      bp.dataset.key = 'pause';
      bp.onclick = safe((e) => {
        return buttonAction(e.currentTarget, 'record:' + t.rid, () => window.api.pauseRecording(t.rid), '暂停中…', '已暂停录制');
      }, 'pause');
      tdOps.appendChild(bp);
    }
    if (t.state === 'recording') {
      const bs = document.createElement('button');
      bs.className = 'mini danger'; bs.textContent = t.paused ? '结束' : '停录';
      bs.dataset.key = 'stop';
      bs.onclick = safe((e) => {
        return buttonAction(e.currentTarget, 'record:' + t.rid, () => window.api.stopRecording(t.rid), '封存中…', '本场已停录，后续处理请查看任务栏');
      }, 'stop');
      tdOps.appendChild(bs);
    }
    const monitor = document.createElement('button');
    monitor.className = 'mini' + (t.monitorPaused ? ' primary' : '');
    monitor.textContent = t.monitorPaused ? '恢复监控' : '暂停监控';
    monitor.dataset.key = 'monitor';
    monitor.title = t.monitorPaused ? '恢复检测和自动录制' : '停止检测和自动录制，正在录制的本场会结束并保存';
    monitor.onclick = safe(e => {
      const button=e.currentTarget;
      if(!t.monitorPaused && t.state==='recording' && !confirm('暂停监控会结束当前录制并保存已录内容，确定暂停？'))return;
      return buttonAction(button,'monitor:'+t.rid,()=>window.api.setMonitorPaused(t.rid,!t.monitorPaused),t.monitorPaused?'恢复中…':'暂停中…',t.monitorPaused?'监控已恢复':'监控已暂停');
    }, 'monitor');
    tdOps.appendChild(monitor);
    const bd = document.createElement('button');
    bd.className = 'mini danger'; bd.textContent = '删除';
    bd.dataset.key = 'remove';
    bd.onclick = safe(async (e) => {
      const button = e.currentTarget;
      if (!confirm(`删除对「${t.dispName || t.rid}」的监控? (已有录像文件保留)`)) return;
      return buttonAction(button, 'remove:' + t.rid, () => window.api.removeStreamer(t.rid), '删除中…', '已删除监控，录像保留');
    }, 'remove');
    tdOps.appendChild(bd);

    const bc = document.createElement('button');
    bc.className = 'mini'; bc.textContent = '⚙';
    bc.dataset.key = 'config';
    bc.title = '标题过滤 / 值守时段';
    bc.onclick = safe(() => configRoom(t), 'config');
    tdOps.appendChild(bc);

    tr.append(tdName, tdRid, tdState, tdTitle, tdDur, tdSize, tdDm, tdOps);
    tb.appendChild(tr);
  }
  groupCompanyRows(tb);
  reconcile($('tbody'), tb);
  syncCompanyChecks();
}

// ---- 后处理任务面板(可折叠, 逐项进度) ----
let postPanelOpen = false;
function overallPct(v) {
  if (!v) return 0;
  if (['done', 'skipped','recovered'].includes(v.status)) return 100;
  if (['warning','waiting','failed'].includes(v.status)) return 0;
  const total = Math.max(1, v.partsTotal);
  const cur = (v.partsDone || 0) + (v.status === 'burning' ? (v.partPct || 0) / 100 : 0);
  return Math.min(100, Math.round((cur / total) * 100));
}
function renderPost() {
  if($('postUpdated'))$('postUpdated').textContent=state?.post?.updatedAt||state?.time?'状态更新：'+new Date(state.post?.updatedAt||state.time).toLocaleTimeString('zh-CN',{hour12:false}):'正在连接任务状态';
  const items = ((state && state.post && state.post.items) || []).map(v=>v.status==='quiet'&&!state?.post?.quiet?.active?{...v,status:'queued',stage:'排队等待处理'}:v);
  const active = items.filter((v) => ['processing', 'burning'].includes(v.status));
  const queued = items.filter((v) => v.status === 'queued');
  const paused=items.filter(v=>v.status==='paused');
  const quiet = items.filter(v=>v.status==='quiet');
  const attention=items.filter(v=>['waiting','failed','warning'].includes(v.status));
  const pb = $('postBadge');
  if(state?.recoveryError){pb.textContent='任务状态保存异常 ▸';pb.title=state.recoveryError;pb.classList.add('busy');}
  else if (active.length) {
    pb.textContent = `${active[0].stage || '正在处理'} · ${active.length}个任务${queued.length ? ' · 排队' + queued.length : ''} ${postPanelOpen ? '▾' : '▸'}`;
    pb.classList.add('busy');
  } else if(state?.post?.quiet?.active){
    pb.textContent=`后处理静音时段${quiet.length?' · 等待'+quiet.length+'个任务':''} ${postPanelOpen?'▾':'▸'}`;pb.classList.remove('busy');
  } else if (queued.length) {
    pb.textContent = `后处理排队 ${queued.length} ${postPanelOpen ? '▾' : '▸'}`;
    pb.classList.add('busy');
  } else if(attention.length){
    pb.textContent=`后处理待恢复 ${attention.length} ${postPanelOpen?'▾':'▸'}`;pb.classList.add('busy');
  } else if(paused.length){
    pb.textContent=`后处理已暂停 ${paused.length} ${postPanelOpen?'▾':'▸'}`;pb.classList.remove('busy');
  } else {
    pb.textContent = `后处理空闲 ${postPanelOpen ? '▾' : '▸'}`;
    pb.classList.remove('busy');
  }

  const panel = $('postPanel');
  if (!postPanelOpen) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const box = document.createElement('div');
  const pending=[...queued,...paused,...quiet,...attention].sort((a,b)=>(a.queuePosition||1e9)-(b.queuePosition||1e9));
  const recent = [...active, ...pending, ...items.filter(v => !['processing', 'burning', 'queued','paused','quiet','waiting','failed','warning'].includes(v.status)).slice(-8).reverse()];
  $('postEmpty').hidden = recent.length > 0;
  for (const v of recent) {
    const row = document.createElement('div');
    row.dataset.key = String(v.id || v.name + ':' + recent.indexOf(v));
    row.className = 'pi-row';
    const running = ['processing', 'burning'].includes(v.status);
    const progress = v.progress;
    const known = running && Number.isFinite(progress?.percent);
    const pct = running ? (known ? progress.percent : 0) : v.status==='paused'&&Number.isFinite(progress?.percent)?progress.percent:overallPct(v);
    let dotCls = 'q';
    let label = '';
    if (['processing', 'burning'].includes(v.status)) { dotCls = 'b'; label = v.stage || '正在处理'; }
    else if (v.status === 'queued') { label = '排队'; }
    else if (v.status === 'failed') { dotCls = 'f'; label = '失败'; }
    else if(v.status==='waiting'){dotCls='q';label='等待恢复';}
    else if(v.status==='paused'){dotCls='q';label='已暂停';}
    else if(v.status==='quiet'){dotCls='q';label='静音时段等待';}
    else if (v.status === 'skipped') { dotCls = 'd'; label = '原片完成·弹幕跳过'; }
    else if (v.status === 'warning') { dotCls = 'f'; label = '需检查'; }
    else if(v.status==='recovered'){dotCls='d';label='已修复';}
    else { dotCls = 'd'; label = '完成'; }
    // 全 textContent 构建(v.name 来自主播昵称, 远端可控)
    const dot = document.createElement('span'); dot.className = 'pi-dot ' + dotCls;
    const nm = document.createElement('span'); nm.className = 'pi-name'; nm.textContent = (v.queuePosition?'#'+v.queuePosition+' ':'')+(v.name || ''); nm.title = [v.error,v.title,v.startedAt?new Date(v.startedAt).toLocaleString('zh-CN'):null].filter(Boolean).join('\n');
    const lb = document.createElement('span'); lb.className = 'pi-label'; lb.textContent = label;
    const bar = document.createElement('div'); bar.className = 'pi-bar' + (running && !known ? ' indeterminate' : '');
    bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-label', (v.name || '') + ' ' + label);
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
    if (!running || known) bar.setAttribute('aria-valuenow', String(pct));
    const fill = document.createElement('div'); fill.className = 'pi-fill' + (v.status === 'failed' ? ' fail' : '');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    const pc = document.createElement('span'); pc.className = 'pi-pct'; pc.textContent = running ? (known ? pct + '%' : '处理中') : v.status==='quiet'?'已排队':['warning','waiting','failed'].includes(v.status) ? '未完成' : pct + '%';
    row.append(dot, nm, lb, bar, pc);
    const controls=document.createElement('div');controls.className='pi-actions';controls.dataset.key='actions';
    if (running) {
      const eta = document.createElement('span'); eta.className = 'pi-eta';
      const fresh = progress && Date.now() - progress.updatedAt < 10000;
      if (fresh && Number.isFinite(progress.remainingSec)) {
        const remaining = Math.max(1, Math.ceil(progress.remainingSec - (Date.now() - progress.updatedAt) / 1000));
        const finish = new Date(progress.updatedAt + progress.remainingSec * 1000);
        const clock = finish.toLocaleTimeString('zh-CN', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
        eta.textContent = `本阶段约剩${remaining >= 60 ? Math.ceil(remaining / 60) + '分钟' : remaining + '秒'} · 预计 ${clock} 完成`;
      } else eta.textContent = known && pct >= 99 ? '正在收尾，预计时间更新中' : '预计完成时间：正在估算';
      eta.title = '按当前阶段的实际处理速度估算，后续阶段会重新计算；并非整场双版本全部完成时间。';
      row.appendChild(eta);
    } else if(v.status==='quiet') {
      const eta=document.createElement('span');eta.className='pi-eta';
      eta.textContent=state?.post?.quiet?.end?`${state.post.quiet.end} 静音结束后自动处理`:'静音结束后自动处理';row.appendChild(eta);
    }
    if(v.id&&['waiting','failed','warning'].includes(v.status)){
      const retry=document.createElement('button');retry.className='mini';retry.textContent='重试';
      retry.dataset.key='retry';
      retry.onclick=safe(e=>buttonAction(e.currentTarget,'retry:'+v.id,()=>window.api.retryPost(v.id),'恢复中…','恢复请求已提交'),'retryPost');controls.appendChild(retry);
    }
    // 单任务控制: 暂停(运行中/排队) · 继续(已暂停) · 上移/下移(排队)
    if(v.postId&&(v.controls?.pause??['processing','burning','queued','quiet','waiting'].includes(v.status))){
      const pp=document.createElement('button');pp.className='mini';pp.textContent='暂停';pp.title='暂停该任务并保留当前处理进度';
      pp.dataset.key='pp';
      pp.onclick=safe(e=>buttonAction(e.currentTarget,'pp:'+v.postId,()=>window.api.postPause(v.postId),'暂停中…','已暂停'),'postPause');controls.appendChild(pp);
    }
    if(v.postId&&(v.controls?.resume??v.status==='paused')){
      const rs=document.createElement('button');rs.className='mini primary';rs.textContent='继续';rs.title='继续该任务(从已完成处续烧)';
      rs.dataset.key='rs';
      rs.onclick=safe(e=>buttonAction(e.currentTarget,'rs:'+v.postId,()=>window.api.postResume(v.postId),'继续中…','已提交继续请求'),'postResume');controls.appendChild(rs);
    }
    if(v.postId&&(v.controls?.move??['queued','quiet','paused','waiting'].includes(v.status))){
      const top=document.createElement('button');top.className='mini';top.textContent='置顶';top.dataset.key='top';
      top.onclick=safe(e=>buttonAction(e.currentTarget,'move:'+v.postId,()=>window.api.postMove(v.postId,'top'),'移动中…','已置顶'),'postTop');controls.appendChild(top);
      const up=document.createElement('button');up.className='mini';up.textContent='▲';up.title='提前处理';
      up.dataset.key='up';
      up.onclick=safe(e=>buttonAction(e.currentTarget,'move:'+v.postId,()=>window.api.postMove(v.postId,'up'),'移动中…','已上移'),'postUp');controls.appendChild(up);
      const dn=document.createElement('button');dn.className='mini';dn.textContent='▼';dn.title='延后处理';
      dn.dataset.key='dn';
      dn.onclick=safe(e=>buttonAction(e.currentTarget,'move:'+v.postId,()=>window.api.postMove(v.postId,'down'),'移动中…','已下移'),'postDown');controls.appendChild(dn);
    }
    if(v.postId&&v.controls?.runNow){const now=document.createElement('button');now.className='mini primary';now.textContent='立即处理';now.dataset.key='now';now.onclick=safe(e=>buttonAction(e.currentTarget,'now:'+v.postId,()=>window.api.postNow(v.postId),'提交中…','已优先提交处理'),'postNow');controls.appendChild(now);}
    if(v.id && ['processing','burning','queued','paused','quiet','waiting','failed','warning'].includes(v.status)){
      const cancel=document.createElement('button');cancel.className='mini danger';cancel.textContent='删除';cancel.dataset.key='cancel';cancel.title='取消该后处理项目，保留已录制文件';
      cancel.onclick=safe(e=>{const button=e.currentTarget;if(!confirm(`取消「${v.name || '该项目'}」的后处理？已录制文件会保留。`))return;return buttonAction(button,'cancel:'+v.id,()=>window.api.postCancel(v.id),'取消中…','已取消后处理，已录文件保留');},'postCancel');controls.appendChild(cancel);
    }
    if(v.postId&&['done','recovered','skipped'].includes(v.status)){
      const remove=document.createElement('button');remove.className='mini';remove.textContent='删除';remove.title='仅从后处理列表移除记录，不删除录像文件';remove.dataset.key='remove';
      remove.onclick=safe(e=>buttonAction(e.currentTarget,'remove:'+v.postId,()=>window.api.postRemove(v.postId),'删除中…','记录已移除，录像保留'),'postRemove');controls.appendChild(remove);
    }
    row.appendChild(controls);
    box.appendChild(row);
  }
  reconcile($('postItems'), box);
}
$('postBadge').onclick = safe(() => { postPanelOpen = !postPanelOpen; renderPost(); }, 'postToggle');

// ---- 历史录制 ----
function renderHistory() {
  const hist = (state && state.history) || [];
  const hb = $('historyBody');
  hb.innerHTML = '';
  for (const h of hist) {
    const tr = document.createElement('tr');
    const d = new Date(h.at || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    const when = `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    // 全 textContent 构建(标题/昵称为远端可控字符串)
    const td1 = document.createElement('td'); td1.className = 'sub'; td1.textContent = when;
    const td2 = document.createElement('td'); td2.textContent = h.nickname || h.rid || '';
    const td3 = document.createElement('td'); td3.className = 'title-cell'; td3.textContent = h.title || '-'; td3.title = h.title || '';
    const td4 = document.createElement('td'); td4.textContent = fmtDur((h.secs || 0) * 1000);
    const td5 = document.createElement('td'); td5.className = 'sub'; td5.textContent = (h.files || []).length + ' 个';
    if(h.status||h.error){const detail=document.createElement('div');detail.className='sub';detail.textContent=h.error||({processing:'处理中',queued:'排队',quiet:'静音时段，等待自动处理',waiting:'等待恢复',failed:'处理失败',warning:'需检查',done:'完成',recovered:'已修复',skipped:'原片完成',canceled:'已取消'}[h.status]||h.status);detail.title=h.error||h.recoveryNotice||'';td5.appendChild(detail);}
    tr.append(td1, td2, td3, td4, td5);
    hb.appendChild(tr);
  }
  $('historyEmpty').hidden = hist.length > 0;
  $('btnClearHistory').hidden = hist.length === 0;
  const hc = $('historyCount');
  if (hc) hc.textContent = hist.length ? `(${hist.length})` : '';
}
$('btnClearHistory').onclick = safe(async (e) => {
  const button=e.currentTarget;
  if (!confirm('清空历史记录列表？(只清列表显示，不删除录像文件)')) return;
  return buttonAction(button,'history:clear',()=>window.api.clearHistory(),'清空中…','历史列表已清空，录像保留');
}, 'clearHistory');

// ---- 监测模式切换 ----
let addMode = 'fast';
function setAddMode(m) {
  addMode = m;
  $('segFast').classList.toggle('on', m === 'fast');
  $('segProfile').classList.toggle('on', m === 'profile');
  $('inpRid').placeholder = m === 'fast'
    ? '直播间链接 / 房间号（在播秒级触发录制）'
    : '个人主页链接（首次开播识别房间号，以后自动使用秒级监控）';
}
$('segFast').onclick = safe(() => setAddMode('fast'), 'segFast');
$('segProfile').onclick = safe(() => setAddMode('profile'), 'segProfile');

// ---- 添加 ----
$('btnAdd').onclick = safe(async () => {
  const btn = $('btnAdd');
  if (btn.disabled) return;
  const input = $('inpRid').value.trim();
  const name = $('inpName').value.trim();
  const msg = $('addMsg');
  if (!input) { msg.textContent = '请输入链接或房间号'; msg.className = 'msg'; return; }
  btn.disabled = true;
  msg.textContent = '解析中…(正在获取主播信息)'; msg.className = 'msg';
  try {
    const r = await window.api.addStreamer(input, name, addMode);
    if (r && r.ok) {
      const tag = r.mode === 'profile' ? '主页监控' : '秒级监控';
      msg.textContent = `已添加 ✓ ${tag}${r.nickname ? ' · ' + r.nickname : ''}`;
      msg.className = 'msg ok';
      $('inpRid').value = ''; $('inpName').value = '';
      clearTimeout(toast._t);
      toast._t = setTimeout(() => { if (msg.className === 'msg ok') msg.textContent = ''; }, 4000);
    } else {
      msg.textContent = (r && r.error) || '添加失败'; msg.className = 'msg';
    }
  } catch (e) {
    msg.textContent = '添加异常: ' + (e && e.message); msg.className = 'msg';
  } finally {
    btn.disabled = false;
  }
}, 'add');

// ---- 设置抽屉 ----
const drawer = $('settingsPanel');
const backdrop = $('drawerBackdrop');
function openDrawer() {
  closeBatch();
  const s = (state && state.settings) || {};
  $('setPoll').value = s.pollIntervalSec ?? 3;
  $('setMax').value = s.maxConcurrentRecordings ?? 6;
  $('setQuality').value = s.quality || 'highest';
  $('setOutDir').value = s.outputDir || 'recordings';
  $('setDisk').value = s.minFreeGB ?? 5;
  $('setSeg').value = s.segment ?? '0';
  $('setMinSize').value = s.minSizeMB ?? 0;
  $('setPostConc').value = String(Math.max(1, Math.min(4, Number(s.postConcurrency) || 1)));
  $('setKeep').value = s.keepDays ?? 0;
  $('setBurn').checked = !!s.burnDanmaku;
  $('setKeepRaw').checked = !!s.keepRaw;
  $('setMerge').checked = s.autoPartMerge !== false;
  $('setPostQuiet').checked=!!s.postQuietEnabled;
  $('setPostQuietStart').value=s.postQuietStart||'23:00';
  $('setPostQuietEnd').value=s.postQuietEnd||'08:00';
  $('setNoSleep').checked = !!s.preventSleep;
  $('setAutoStart').checked = !!s.autoStart;
  $('setWebhook').value = s.webhookUrl || '';
  backdrop.hidden = false;
  drawer.classList.add('open');
}
function closeDrawer() {
  drawer.classList.remove('open');
  backdrop.hidden = true;
}
$('btnSettings').onclick = safe(() => (drawer.classList.contains('open') ? closeDrawer() : openDrawer()), 'settings');
backdrop.onclick = safe(() => { closeDrawer(); closeBatch(); }, 'backdrop');
$('btnCloseSettings').onclick = safe(closeDrawer, 'closeSettings');
$('btnSaveSettings').onclick = safe(async () => {
  const btn = $('btnSaveSettings');
  if (btn.disabled) return;
  if($('setPostQuiet').checked&&(!$('setPostQuietStart').value||!$('setPostQuietEnd').value||$('setPostQuietStart').value===$('setPostQuietEnd').value)){
    alert('后处理静音时段需填写不同的开始和结束时间');return;
  }
  btn.disabled = true;
  try {
    const r = await window.api.saveSettings({
      pollIntervalSec: +$('setPoll').value,
      maxConcurrentRecordings: +$('setMax').value,
      quality: $('setQuality').value,
      outputDir: $('setOutDir').value,
      minFreeGB: +$('setDisk').value,
      segment: $('setSeg').value.trim(),
      minSizeMB: +$('setMinSize').value,
      postConcurrency: +$('setPostConc').value,
      keepDays: +$('setKeep').value,
      burnDanmaku: $('setBurn').checked,
      keepRaw: $('setKeepRaw').checked,
      autoPartMerge: $('setMerge').checked,
      postQuietEnabled: $('setPostQuiet').checked,
      postQuietStart: $('setPostQuietStart').value,
      postQuietEnd: $('setPostQuietEnd').value,
      preventSleep: $('setNoSleep').checked,
      autoStart: $('setAutoStart').checked,
      webhookUrl: $('setWebhook').value.trim(),
    });
    if (r && r.ok) { closeDrawer(); toast('设置已保存'); }
    else alert((r && r.error) || '保存失败');
  } finally {
    btn.disabled = false;
  }
}, 'saveSettings');

// ---- 批量导入 / 导出 / 登录 ----
const batchModal = $('batchModal');
function closeBatch() { batchModal.classList.remove('open'); batchModal.hidden = true; if (!drawer.classList.contains('open')) backdrop.hidden = true; }
$('btnBatch').onclick = safe(() => { closeDrawer(); batchModal.hidden = false; batchModal.classList.add('open'); backdrop.hidden = false; $('batchText').focus(); }, 'batch');
$('btnBatchClose').onclick = safe(closeBatch, 'batchClose');
window.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); closeBatch(); } });
$('btnBatchGo').onclick = safe(async () => {
  const btn = $('btnBatchGo');
  if (btn.disabled) return;
  if (!$('batchText').value.trim()) { $('batchResult').textContent='请输入至少一个链接或房间号'; return; }
  btn.disabled = true;
  btn.textContent = '导入中…(每个约5-10秒)';
  try {
    const r = checked(await window.api.batchAdd($('batchText').value));
    $('batchResult').textContent =
      `成功 ${(r && r.added) || 0} 个` + (r && r.failed && r.failed.length ? `\n失败 ${r.failed.length} 个:\n` + r.failed.join('\n') : '');
  } catch (e) {
    $('batchResult').textContent = '导入异常: ' + (e && e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始导入';
  }
}, 'batchGo');
$('btnExport').onclick = safe((e) => {
  return buttonAction(e.currentTarget,'export',()=>window.api.exportList(),'导出中…',r=>`已导出 ${r.count} 个监控项到：${r.path}${r.warning ? '；'+r.warning : ''}`);
}, 'export');
$('btnLogin').onclick = safe((e) => {
  return buttonAction(e.currentTarget,'login',()=>window.api.openLogin(),'打开中…','登录窗口已打开，请自行扫码');
}, 'login');

// ---- 日志面板 ----
let logTimer = null;
let directoryView = null;
let directoryLoading = false;
async function browseRecordings(relative, initial = false) {
  if (directoryLoading) return;
  directoryLoading = true;
  $('recordingsStatus').textContent='正在读取录像目录…';
  try {
    const result=checked(await (initial?window.api.openRecordings():window.api.listRecordings(relative)));
    directoryView=result;
    $('recordingsPath').textContent=result.path;
    $('recordingsUp').disabled=!result.relative;
    $('recordingsEntries').replaceChildren();
    for(const entry of result.entries || []) {
      const row=document.createElement('div');row.className='recordings-entry';
      const name=document.createElement('span');name.textContent=(entry.directory?'📁 ':'')+entry.name;row.appendChild(name);
      if(entry.directory||entry.playable){
        const button=document.createElement('button');button.className='mini';button.textContent=entry.directory?'进入':'播放';
        button.onclick=safe(async e=>{
          if(entry.directory)return browseRecordings(entry.relative);
          try{await buttonAction(e.currentTarget,'play:'+entry.relative,()=>window.api.playRecording(entry.relative),'打开中…');$('recordingsStatus').textContent='已请求播放器打开视频';}
          catch(error){$('recordingsStatus').textContent=error.message;}
        },'recordingEntry');row.appendChild(button);
      }
      $('recordingsEntries').appendChild(row);
    }
    $('recordingsStatus').textContent=result.truncated?'文件较多，仅显示前2000项。可用系统文件管理器查看全部。':result.entries?.length?'选择文件夹查看录像，视频可直接播放。':'此目录暂无文件';
  } catch(error){$('recordingsStatus').textContent='读取失败：'+error.message;}
  finally{directoryLoading=false;}
}
$('btnOpenRec').onclick=safe(()=>{
  if(!$('recordingsDialog').open)$('recordingsDialog').showModal();
  return browseRecordings('',true);
},'openRec');
$('recordingsClose').onclick=safe(()=>$('recordingsDialog').close(),'recordingsClose');
$('recordingsRefresh').onclick=safe(()=>browseRecordings(directoryView?.relative||'',!directoryView),'recordingsRefresh');
$('recordingsUp').onclick=safe(()=>browseRecordings(directoryView?.parent||''),'recordingsUp');
for(const [id,method,message] of [['recordingsCopy','copyRecordingsPath','目录路径已复制'],['recordingsSystem','openRecordingsSystem','已请求打开系统文件管理器；若窗口未显示，仍可在此查看录像或复制路径。']]){
  $(id).onclick=safe(async e=>{if(!directoryView){$('recordingsStatus').textContent='请先成功读取录像目录';return;}
    try{await buttonAction(e.currentTarget,id,()=>window.api[method](directoryView.relative),'处理中…');$('recordingsStatus').textContent=message;}
    catch(error){$('recordingsStatus').textContent=error.message;}
  },id);
}
$('btnLog').onclick = safe(() => {
  const p = $('logPanel');
  if (p.hidden) {
    p.hidden = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const r = checked(await window.api.logsTail());
        const box = $('logBox');
        const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
        box.textContent = (r && r.lines || []).join('\n');
        if (stick) box.scrollTop = box.scrollHeight;
      } catch (e) { $('logBox').textContent = '日志读取失败：' + e.message; }
      finally { refreshing = false; }
    };
    refresh();
    logTimer = setInterval(safe(refresh, 'logRefresh'), 3000);
  } else {
    p.hidden = true;
    clearInterval(logTimer);
  }
}, 'logToggle');
$('btnCloseLog').onclick = safe(() => {
  $('logPanel').hidden = true;
  clearInterval(logTimer);
}, 'logClose');

// ---- 单房间配置 ----
let editingRoom = null;
function configRoom(t) {
  editingRoom = t;
  $('roomConfigTitle').textContent = '主播设置：' + (t.dispName || t.rid);
  $('roomFilter').value = t.titleFilter || '';
  $('roomHours').value = t.hours || '';
  $('roomConfigError').textContent = '';
  if (!$('roomConfigDialog').open) $('roomConfigDialog').showModal();
  $('roomFilter').focus();
}
$('roomConfigCancel').onclick = safe(() => $('roomConfigDialog').close(), 'configCancel');
$('roomConfigForm').onsubmit = safe(async (event) => {
  event.preventDefault();
  if ($('roomConfigSave').disabled) return;
  if (!editingRoom) return;
  const room = editingRoom;
  const titleFilter = $('roomFilter').value.trim(), hours = $('roomHours').value.trim();
  try { if (titleFilter) new RegExp(titleFilter); } catch { $('roomConfigError').textContent = '标题过滤正则无效'; return; }
  if (hours && !/^(?:[01]?\d|2[0-3]):[0-5]\d-(?:[01]?\d|2[0-3]):[0-5]\d$/.test(hours)) {
    $('roomConfigError').textContent = '请输入有效时段，例如 19:00-23:00'; return;
  }
  $('roomConfigSave').disabled = true;
  $('roomConfigError').textContent = '';
  try {
    const r = await window.api.streamerConfig(room.rid, { titleFilter, hours });
    if (!r || !r.ok) { $('roomConfigError').textContent = (r && r.error) || '保存失败'; return; }
    $('roomConfigDialog').close(); toast('已保存: ' + (room.dispName || room.rid));
  } catch(error) { $('roomConfigError').textContent=error.message; }
  finally { $('roomConfigSave').disabled = false; }
}, 'configRoom');

// ---- 初始化 ----
initCompanies();
let lastStateAt=0,stateFetching=false;
function acceptState(s){if(!s||s.ok===false)throw Error(s?.error||'状态尚未就绪');lastStateAt=Date.now();state=s;render();renderPost();renderHistory();}
window.api.onState(safe(acceptState, 'onState'));
window.api.getState().then(safe(acceptState,'getState')).catch(e=>uiFail('getState',e));
setInterval(safe(async()=>{
  if(stateFetching||Date.now()-lastStateAt<8000)return;stateFetching=true;let timer;
  try{acceptState(await Promise.race([window.api.getState(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('后台状态暂不可用，正在重连')),5000))]));}
  catch(error){if($('postUpdated'))$('postUpdated').textContent=error.message;}
  finally{clearTimeout(timer);stateFetching=false;}
},'stateReconnect'),5000);
setInterval(safe(() => { render(); renderPost(); }, 'tick'), 1000);
