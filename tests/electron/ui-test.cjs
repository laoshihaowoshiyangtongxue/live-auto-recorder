const {app,BrowserWindow,ipcMain}=require('electron');
ipcMain.handle('audit-company',(_e,cfg,action,data)=>require('../../src/core/companies').updateCompanies(cfg,action,data));
const fs=require('node:fs'),path=require('node:path');
const results=[];let w;
const evaluate=code=>w.webContents.executeJavaScript(code);
const check=async(name,code)=>{try{const result=await evaluate(`(async()=>{${code}})()`);if(result!==true)throw Error(JSON.stringify(result));results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.message});}};
app.whenReady().then(async()=>{
 w=new BrowserWindow({show:false,width:1180,height:780,webPreferences:{contextIsolation:false,backgroundThrottling:false,preload:path.join(__dirname,'ui-preload.cjs')}});
 await w.loadFile(path.join(__dirname,'../../src/gui/index.html'));
 await check('batch panel is onscreen, closes by backdrop and Escape',`
  document.getElementById('btnBatch').click();await new Promise(r=>setTimeout(r,400));
  const b=document.getElementById('batchModal'),rect=b.getBoundingClientRect();
  if(b.hidden||rect.left>=innerWidth||getComputedStyle(b).visibility!=='visible')return {hidden:b.hidden,left:rect.left,width:innerWidth};
  document.getElementById('drawerBackdrop').click();if(!b.hidden)return false;
  document.getElementById('btnBatch').click();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return b.hidden&&document.getElementById('drawerBackdrop').hidden;
 `);
 await check('settings opens synchronously and switches correctly with batch',`
  document.getElementById('btnSettings').click();if(!document.getElementById('settingsPanel').classList.contains('open'))return false;
  document.getElementById('btnBatch').click();if(document.getElementById('settingsPanel').classList.contains('open'))return false;
  document.getElementById('btnSettings').click();if(!document.getElementById('batchModal').hidden)return false;
  document.getElementById('btnCloseSettings').click();return document.getElementById('drawerBackdrop').hidden;
 `);
 await check('recording browser shows errors and can recover without system Explorer',`
  for(const mode of ['fail','throw']){window.auditMode=mode;document.getElementById('btnOpenRec').click();await new Promise(r=>setTimeout(r,30));if(!document.getElementById('recordingsStatus').textContent.includes('失败'))return false;}
  window.auditMode='ok';document.getElementById('recordingsRefresh').click();await new Promise(r=>setTimeout(r,30));
  if(!document.getElementById('recordingsPath').textContent.includes('E:/test'))return false;
  document.querySelector('#recordingsEntries button').click();await new Promise(r=>setTimeout(r,30));
  if(document.querySelector('#recordingsEntries button').textContent!=='播放')return false;
  window.auditMode='fail';document.querySelector('#recordingsEntries button').click();await new Promise(r=>setTimeout(r,30));if(!document.getElementById('recordingsStatus').textContent.includes('注入后台失败'))return false;
  window.auditMode='ok';document.getElementById('recordingsUp').click();await new Promise(r=>setTimeout(r,30));
  for(const id of ['recordingsCopy','recordingsSystem']){window.auditMode='fail';document.getElementById(id).click();await new Promise(r=>setTimeout(r,30));if(!document.getElementById('recordingsStatus').textContent.includes('注入后台失败'))return false;}
  document.getElementById('recordingsClose').click();return !document.getElementById('recordingsDialog').open;
 `);
 for(const mode of ['fail','throw'])for(const [selector,name] of [['#btnExport','export'],['#btnLogin','login'],['[data-key="watch"]','watch'],['[data-key="pause"]','pause'],['[data-key="stop"]','stop'],['[data-key="remove"]','remove']]){
  await check(`${name} shows ${mode} and recovers button`, `
    window.auditMode='${mode}';const button=document.querySelector('${selector}');button.click();await new Promise(r=>setTimeout(r,40));
    const m=document.getElementById('actionStatus');return !button.disabled&&!m.hidden&&m.textContent.includes('${mode==='fail'?'注入后台失败':'注入通信失败'}');
  `);
 }
 await check('row and button identities survive pushed state and timer ticks',`
  window.auditMode='ok';const row=document.querySelector('#tbody tr[data-key="123456"]'),button=row.querySelector('[data-key="pause"]');button.focus();
  for(let i=0;i<5;i++){window.auditState.tasks[0].bytes++;window.auditEmit();}
  await new Promise(r=>setTimeout(r,1200));return row===document.querySelector('#tbody tr[data-key="123456"]')&&button===row.querySelector('[data-key="pause"]')&&document.activeElement===button;
 `);
 await check('pending action remains disabled across refresh and duplicates are blocked',`
  window.auditMode='defer';window.auditCalls=[];const button=document.querySelector('[data-key="watch"]');button.click();
  window.auditState.tasks[0].bytes++;window.auditEmit();button.click();await new Promise(r=>setTimeout(r,30));
  if(!button.disabled||window.auditCalls.length!==1)return {disabled:button.disabled,calls:window.auditCalls};
  window.auditResolve({ok:true});await new Promise(r=>setTimeout(r,30));return !button.disabled&&button.textContent==='观看';
 `);
 await check('retry button persists across updates and displays failures',`
  window.auditMode='fail';document.getElementById('postBadge').click();const b=document.querySelector('#postItems button');b.focus();window.auditEmit();
  if(b!==document.querySelector('#postItems button')||document.activeElement!==b)return false;
  b.click();await new Promise(r=>setTimeout(r,30));return !b.disabled&&document.getElementById('actionStatus').textContent.includes('注入后台失败');
 `);
 await check('resume failures are visible and release pending state',`
  window.auditState.tasks[0].paused=true;window.auditEmit();window.auditMode='fail';const b=document.querySelector('[data-key="resume"]');b.click();await new Promise(r=>setTimeout(r,30));
  return !b.disabled&&document.getElementById('actionStatus').textContent.includes('注入后台失败');
 `);
 await check('batch import validates empty input and shows backend error',`
  document.getElementById('btnBatch').click();document.getElementById('btnBatchGo').click();if(!document.getElementById('batchResult').textContent.includes('请输入'))return false;
  document.getElementById('batchText').value='123456';window.auditMode='fail';document.getElementById('btnBatchGo').click();await new Promise(r=>setTimeout(r,30));
  return !document.getElementById('btnBatchGo').disabled&&document.getElementById('batchResult').textContent.includes('注入后台失败');
 `);
 await check('save settings keeps drawer open after failure and can retry successfully',`
  document.getElementById('btnSettings').click();window.auditMode='fail';document.getElementById('btnSaveSettings').click();await new Promise(r=>setTimeout(r,30));
  if(!document.getElementById('settingsPanel').classList.contains('open')||document.getElementById('btnSaveSettings').disabled)return false;
  window.auditMode='ok';document.getElementById('btnSaveSettings').click();await new Promise(r=>setTimeout(r,30));return !document.getElementById('settingsPanel').classList.contains('open');
 `);
 await check('paused media retains its percentage and hides the running ETA',`
  window.auditState.post.items=[{id:'pause-progress',postId:'pause-progress',name:'测试任务',status:'paused',progress:{percent:63,remainingSec:120,updatedAt:Date.now()}}];
  window.auditEmit();if(document.getElementById('postPanel').hidden)document.getElementById('postBadge').click();
  return document.querySelector('.pi-pct').textContent==='63%'&&!document.querySelector('.pi-eta')&&document.querySelector('.pi-label').textContent==='已暂停'&&document.getElementById('postBadge').textContent.includes('已暂停');
 `);
 await check('postprocessing shows real percentage, stage ETA, unknown animation and clears stale estimates',`
  window.auditState.post.items=[{id:'progress-test',name:'示例主播',status:'processing',stage:'恢复损坏画面',progress:{percent:42,remainingSec:120,updatedAt:Date.now()}}];
  window.auditEmit();if(document.getElementById('postPanel').hidden)document.getElementById('postBadge').click();
  if(document.querySelector('.pi-pct').textContent!=='42%'||!document.querySelector('.pi-eta').textContent.includes('预计'))return false;
  if(document.querySelector('.pi-bar').getAttribute('aria-valuenow')!=='42')return false;
  window.auditState.post.items[0].progress=null;window.auditEmit();
  if(!document.querySelector('.pi-bar').classList.contains('indeterminate')||!document.querySelector('.pi-eta').textContent.includes('正在估算'))return false;
  window.auditState.post.items[0].progress={percent:80,remainingSec:20,updatedAt:Date.now()-30000};window.auditEmit();
  if(!document.querySelector('.pi-eta').textContent.includes('正在估算'))return false;
  window.auditState.post.items[0].status='warning';window.auditEmit();
  if(document.querySelector('.pi-pct').textContent!=='未完成'||document.querySelector('.pi-bar').getAttribute('aria-valuenow')!=='0')return false;
  window.auditState.post.items[0].status='done';window.auditEmit();return !document.querySelector('.pi-eta')&&document.querySelector('.pi-pct').textContent==='100%';
 `);
 await check('quiet settings validate and save the user-entered overnight interval',`
  window.auditMode='ok';document.getElementById('btnSettings').click();
  document.getElementById('setPostQuiet').checked=true;document.getElementById('setPostQuietStart').value='22:45';document.getElementById('setPostQuietEnd').value='22:45';
  const calls=window.auditCalls.length;document.getElementById('btnSaveSettings').click();await new Promise(r=>setTimeout(r,20));
  if(window.auditCalls.length!==calls||!window.auditAlert.includes('静音时段'))return false;
  document.getElementById('setPostQuietEnd').value='07:15';document.getElementById('btnSaveSettings').click();await new Promise(r=>setTimeout(r,30));
  const saved=window.auditCalls.filter(c=>c.name==='saveSettings').at(-1)?.args[0];
  return saved.postQuietEnabled===true&&saved.postQuietStart==='22:45'&&saved.postQuietEnd==='07:15'&&!document.getElementById('settingsPanel').classList.contains('open');
 `);
 await check('quiet waiting is shown as queued with automatic resume instead of failure or completion',`
  window.auditState.post={quiet:{active:true,start:'23:00',end:'08:00'},items:[{id:'quiet-test',name:'测试主播',status:'quiet',partsTotal:1}]};window.auditEmit();
  await new Promise(r=>setTimeout(r,300));if(document.getElementById('postPanel').hidden)document.getElementById('postBadge').click();
  return document.getElementById('postBadge').textContent.includes('静音时段')&&document.querySelector('.pi-pct').textContent==='已排队'&&document.querySelector('.pi-eta').textContent.includes('08:00')&&!!document.querySelector('#postItems [data-key="cancel"]');
 `);
 await check('logs open, report failure, and close without hidden overlay',`
  window.auditMode='fail';document.getElementById('btnLog').click();await new Promise(r=>setTimeout(r,30));if(!document.getElementById('logBox').textContent.includes('注入后台失败'))return false;
  document.getElementById('btnCloseLog').click();return getComputedStyle(document.getElementById('logPanel')).display==='none';
 `);
 await check('company grouping saves, moves a recording, folds, searches and survives fresh snapshots',`
  window.auditMode='ok';document.getElementById('companyCreate').click();document.getElementById('companyName').value='测试传媒';document.getElementById('companyForm').requestSubmit();await new Promise(r=>setTimeout(r,60));
  const company=window.auditState.companies[0];if(!company||document.getElementById('companyDialog').open)return false;
  document.querySelector('[data-key="company-move"]').click();document.getElementById('companyTarget').value=company.id;document.getElementById('companyForm').requestSubmit();await new Promise(r=>setTimeout(r,60));
  const row=document.querySelector('tr[data-key="123456"]');if(window.auditState.tasks[0].companyId!==company.id||window.auditState.tasks[0].state!=='recording')return false;
  document.querySelector('tr[data-key="company:'+company.id+'"] [data-key="toggle"]').click();await new Promise(r=>setTimeout(r,60));window.auditEmit();if(!row.hidden)return false;
  document.getElementById('companySearch').value='测试主播';document.getElementById('companySearch').dispatchEvent(new Event('input'));if(row.hidden)return false;
  document.getElementById('companySearch').value='';document.getElementById('companySearch').dispatchEvent(new Event('input'));if(!row.hidden)return false;
  return document.querySelector('tr[data-key="company:'+company.id+'"] [aria-expanded="false"]')!==null;
 `);
 await check('company batch move and delete preserve recording buttons and surface failed saves',`
  window.auditMode='ok';document.getElementById('companyExpand').click();await new Promise(r=>setTimeout(r,60));document.querySelector('.company-check').click();document.getElementById('companyMoveSelected').click();document.getElementById('companyTarget').value='none';
  window.auditMode='fail';document.getElementById('companyForm').requestSubmit();await new Promise(r=>setTimeout(r,60));if(!document.getElementById('companyDialog').open||!document.getElementById('companyDialogError').textContent.includes('注入后台失败'))return false;
  window.auditMode='ok';document.getElementById('companyForm').requestSubmit();await new Promise(r=>setTimeout(r,60));if(window.auditState.tasks[0].companyId)return false;
  document.querySelector('.company-group [data-key="delete"]').click();document.getElementById('companyForm').requestSubmit();await new Promise(r=>setTimeout(r,60));
  return window.auditState.companies.length===0&&window.auditState.tasks.length===1&&!!document.querySelector('[data-key="pause"],[data-key="resume"]');
 `);
 w.setSize(940,620);w.webContents.setZoomFactor(1.5);
 await check('quiet settings remain scrollable and Save stays visible on a small zoomed window',`
  document.getElementById('btnSettings').click();await new Promise(r=>setTimeout(r,300));
  const body=document.querySelector('.settings-body');body.scrollTop=body.scrollHeight;
  const button=document.getElementById('btnSaveSettings').getBoundingClientRect();
  return body.scrollHeight>body.clientHeight&&button.top>=0&&button.bottom<=innerHeight&&document.getElementById('setPostQuietStart').labels.length===1&&document.getElementById('setPostQuietEnd').labels.length===1;
 `);
 await check('all quiet and queued phases expose pause, top, up, down and run-now controls',`
  document.getElementById('btnCloseSettings').click();if(document.getElementById('postPanel').hidden)document.getElementById('postBadge').click();
  window.auditState.post={quiet:{active:true,end:'09:00'},updatedAt:Date.now(),items:[{id:'22222222-2222-2222-2222-222222222222',postId:'22222222-2222-2222-2222-222222222222',name:'静音任务',status:'quiet',queuePosition:1,controls:{pause:true,resume:false,move:true,runNow:true}}]};window.auditEmit();
  const row=document.querySelector('#postItems .pi-row'),keys=[...row.querySelectorAll('button')].map(b=>b.dataset.key);
  if(!['pp','top','up','dn','now'].every(k=>keys.includes(k)))return keys;
  if(!row.textContent.includes('09:00'))return false;
  window.auditState.post.quiet.active=false;window.auditState.post.updatedAt=Date.now();window.auditEmit();
  return !document.getElementById('postItems').textContent.includes('静音结束')&&document.getElementById('postItems').textContent.includes('排队')&&document.getElementById('postUpdated').textContent.includes('状态更新');
 `);
 await check('post controls call the canonical task and retain error feedback across refresh',`
  window.auditMode='fail';window.auditCalls=[];const button=document.querySelector('#postItems [data-key="pp"]');button.click();await new Promise(r=>setTimeout(r,30));
  if(!document.getElementById('actionStatus').textContent.includes('注入后台失败')||button.disabled)return false;
  const call=window.auditCalls.at(-1);if(call.name!=='postPause'||call.args[0]!=='22222222-2222-2222-2222-222222222222')return call;
  window.auditMode='ok';document.querySelector('#postItems [data-key="top"]').click();await new Promise(r=>setTimeout(r,30));return window.auditCalls.at(-1).name==='postMove'&&window.auditCalls.at(-1).args[1]==='top';
 `);
 await check('a paused non-burning task has independent resume and reorder buttons',`
  const item=window.auditState.post.items[0];item.status='paused';item.controls={pause:false,resume:true,move:true,runNow:true};window.auditEmit();
  const keys=[...document.querySelectorAll('#postItems button')].map(b=>b.dataset.key);return ['rs','top','up','dn','now'].every(k=>keys.includes(k))&&!keys.includes('pp');
 `);
 await check('completed rows provide a remove-record button while queued tasks do not',`
  window.auditMode='ok';window.auditCalls=[];window.auditState.post.items=[{id:'done-test',postId:'done-test',name:'已完成',status:'done'},{id:'queue-test',postId:'queue-test',name:'排队',status:'queued',controls:{pause:true}}];window.auditEmit();
  const done=document.querySelector('#postItems [data-key="done-test"] [data-key="remove"]'),queued=document.querySelector('#postItems [data-key="queue-test"] [data-key="remove"]');if(!done||queued||!done.title.includes('不删除录像'))return false;done.click();await new Promise(r=>setTimeout(r,30));const call=window.auditCalls.at(-1);return call.name==='postRemove'&&call.args[0]==='done-test';
 `);
 await check('monitor and post cancellation buttons send the selected item',`
  window.auditMode='ok';window.auditCalls=[];
  window.auditState.tasks[0].monitorPaused=false;window.auditEmit();
  let monitor=document.querySelector('#tbody [data-key="monitor"]');if(!monitor||monitor.textContent!=='暂停监控')return false;
  monitor.click();await new Promise(r=>setTimeout(r,40));let call=window.auditCalls.at(-1);if(call.name!=='setMonitorPaused'||call.args[0]!=='123456'||call.args[1]!==true)return call;
  window.auditState.tasks[0].monitorPaused=true;window.auditEmit();monitor=document.querySelector('#tbody [data-key="monitor"]');if(monitor.textContent!=='恢复监控')return false;
  monitor.click();await new Promise(r=>setTimeout(r,40));call=window.auditCalls.at(-1);if(call.name!=='setMonitorPaused'||call.args[1]!==false)return call;
  const cancel=document.querySelector('#postItems [data-key="queue-test"] [data-key="cancel"]');if(!cancel)return false;cancel.click();await new Promise(r=>setTimeout(r,40));call=window.auditCalls.at(-1);return call.name==='postCancel'&&call.args[0]==='queue-test';
 `);
 w.setSize(1400,900);w.webContents.setZoomFactor(1);
 await check('panel resizing, collapse and saved dimensions preserve the monitoring space',`
  if(document.getElementById('postPanel').hidden)document.getElementById('postBadge').click();
  const post=document.getElementById('postPanel'),monitor=document.querySelector('main'),split=document.getElementById('postSplit');document.getElementById('layoutReset').click();
  const before=post.offsetHeight;split.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));const after=post.offsetHeight;
  if(after>=before||monitor.offsetHeight<100||JSON.parse(localStorage.getItem('recorder-layout-v1')).post!==after)return {before,after,monitor:monitor.offsetHeight};
  document.getElementById('historyCollapse').click();if(!document.getElementById('historyPanel').classList.contains('layout-collapsed'))return false;
  document.getElementById('monitorCollapse').click();if(!monitor.classList.contains('layout-collapsed'))return false;
  document.getElementById('layoutReset').click();return !monitor.classList.contains('layout-collapsed')&&!document.getElementById('historyPanel').classList.contains('layout-collapsed')&&monitor.offsetHeight>=100;
 `);
 fs.writeFileSync(process.env.LR_UI_RESULTS || path.join(__dirname,'ui-results.json'),JSON.stringify(results,null,2));app.exit(results.every(r=>r.pass)?0:1);
}).catch(e=>{fs.writeFileSync(path.join(__dirname,'ui-error.txt'),e.stack);app.exit(1);});
