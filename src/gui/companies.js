const companySelection=new Set();
let companyDialogAction=null;
function companyElement(tag,text,className='') {const node=document.createElement(tag);node.textContent=text;node.className=className;return node;}
function companyButton(text,key,fn) {const node=companyElement('button',text,'mini');node.dataset.key=key;node.type='button';node.onclick=safe(fn,'company');return node;}
async function changeCompany(action,data) {
  checked(await window.api.companyAction(action,data));
  state=await window.api.getState();render();
}
function companyGroups(){return [...(state?.companies||[]),{id:'none',name:'未分组',collapsed:!!state?.ungroupedCollapsed}];}
function taskCompany(t){return (state.companies||[]).some(c=>c.id===t.companyId)?t.companyId:'none';}
function taskIdentity(t){return String(t.identity||t.rid);}
function taskNeedsAttention(t){return !!(t.error||t.pollFails>5||['retrying','failed'].includes(t.dmState));}
function companyMatches(t,company) {
  const query=$('companySearch').value.trim().toLocaleLowerCase(),status=$('companyStatus').value;
  const matches=!query||[t.dispName,t.name,t.rid,t.title,company.name].some(v=>String(v||'').toLocaleLowerCase().includes(query));
  return matches&&(status==='all'||status==='recording'&&t.state==='recording'||status==='profile'&&t.secWatch||status==='warning'&&taskNeedsAttention(t)||status==='offline'&&!t.secWatch&&!t.live&&t.state==='idle');
}
function addCompanyRowControls(cell,t) {
  const key=taskIdentity(t),box=document.createElement('input');box.type='checkbox';box.className='company-check';box.dataset.identity=key;box.checked=companySelection.has(key);
  box.setAttribute('aria-label','选择主播'+(t.dispName||t.rid));box.onclick=safe(e=>{e.currentTarget.checked?companySelection.add(key):companySelection.delete(key);render();},'company-select');cell.appendChild(box);
  const move=companyButton('调整公司','company-move',()=>openCompanyDialog('move',{keys:[key],id:taskCompany(t)}));move.classList.add('company-row-move');move.setAttribute('aria-label','调整'+(t.dispName||t.rid)+'的所属公司');cell.appendChild(move);
}
function syncCompanyChecks(){for(const box of document.querySelectorAll('.company-check'))box.checked=companySelection.has(box.dataset.identity);}
function groupCompanyRows(body) {
  const rows=[...body.children],groups=companyGroups(),filtering=!!$('companySearch').value.trim()||$('companyStatus').value!=='all';
  for(const key of companySelection)if(!state.tasks.some(t=>taskIdentity(t)===key))companySelection.delete(key);
  $('companyTotals').textContent=`${state.tasks.length} 位主播 · ${state.tasks.filter(t=>t.state==='recording').length} 位录制中 · ${(state.companies||[]).length} 家公司`;
  $('companyBulk').hidden=!companySelection.size;$('companySelected').textContent=`已选择 ${companySelection.size} 位主播（含当前筛选之外的选择）`;
  let visible=0;
  for(const company of groups) {
    const all=state.tasks.filter(t=>taskCompany(t)===company.id),matches=all.filter(t=>companyMatches(t,company));
    if(filtering&&!matches.length)continue;
    const header=document.createElement('tr');header.dataset.key='company:'+company.id;header.className='company-group';
    const cell=document.createElement('td');cell.colSpan=8;const line=companyElement('div','','company-group-line');
    const open=filtering||!company.collapsed;
    const toggle=companyButton((open?'▾ ':'▸ ')+company.name,'toggle',e=>buttonAction(e.currentTarget,'company-fold:'+company.id,()=>changeCompany('collapse',{id:company.id,collapsed:open}).then(()=>({ok:true})), '保存中…'));
    toggle.classList.add('company-toggle');toggle.setAttribute('aria-expanded',String(open));line.append(toggle,companyElement('span',`${all.length} 位主播${filtering?' · 匹配 '+matches.length+' 位':''}`,'sub'));
    const recording=all.filter(t=>t.state==='recording'&&!t.paused).length,paused=all.filter(t=>t.paused).length,warning=all.filter(taskNeedsAttention).length,profiles=all.filter(t=>t.secWatch).length;
    if(recording)line.appendChild(companyElement('span','录制中 '+recording,'badge rec'));
    if(paused)line.appendChild(companyElement('span','已暂停 '+paused,'badge paused'));
    if(warning)line.appendChild(companyElement('span','需留意 '+warning,'badge paused'));
    if(profiles)line.appendChild(companyElement('span','主页监控 '+profiles,'badge off'));
    if(company.id!=='none') {
      const actions=companyElement('div','','company-group-actions');
      actions.append(companyButton('改名','rename',()=>openCompanyDialog('rename',company)),companyButton('移除分组','delete',()=>openCompanyDialog('delete',company)));line.appendChild(actions);
    }
    cell.appendChild(line);header.appendChild(cell);body.appendChild(header);visible+=matches.length;
    for(const t of all) {const row=rows.find(r=>r.dataset.key===String(t.rid));row.hidden=!open||!matches.includes(t);body.appendChild(row);}
    if(open&&!all.length){const empty=document.createElement('tr');empty.dataset.key='empty:'+company.id;const td=companyElement('td','暂无主播。可通过“调整公司”或勾选后批量移入。','sub');td.colSpan=8;empty.appendChild(td);body.appendChild(empty);}
  }
  // 原始行必须移除，避免被过滤掉的公司仍显示在前面。
  for(const row of rows)if(!groups.some(c=>(!filtering||state.tasks.some(t=>taskCompany(t)===c.id&&companyMatches(t,c)))&&state.tasks.some(t=>String(t.rid)===row.dataset.key&&taskCompany(t)===c.id)))row.remove();
  if(filtering&&!visible){const empty=document.createElement('tr');empty.dataset.key='no-matches';const td=companyElement('td','没有匹配的主播，请清除搜索或状态筛选。','sub');td.colSpan=8;empty.appendChild(td);body.appendChild(empty);}
}
function openCompanyDialog(action,data={}) {
  companyDialogAction={action,data};$('companyDialogTitle').textContent={create:'新建传媒公司',rename:'修改公司名称',move:'调整主播所属公司',delete:'移除公司分组'}[action];
  $('companyNameLabel').hidden=!['create','rename'].includes(action);$('companyTargetLabel').hidden=action!=='move';
  $('companyName').value=action==='rename'?data.name:'';$('companyName').required=['create','rename'].includes(action);
  $('companyTarget').replaceChildren(...companyGroups().map(c=>{const option=companyElement('option',c.name);option.value=c.id;return option;}));$('companyTarget').value=data.id||'none';
  $('companyDialogHint').textContent=action==='delete'?'主播将移到未分组，监控、录制及已有录像不受影响。':action==='move'?`将 ${data.keys.length} 位主播移入选定公司，录制继续运行。`:'公司名称与归属会保存，重启后保留。';
  $('companyDialogError').textContent='';$('companySave').textContent=action==='delete'?'移除分组':'保存';$('companyDialog').showModal();
  (action==='move'?$('companyTarget'):action==='delete'?$('companyCancel'):$('companyName')).focus();
}
function initCompanies() {
  $('companyCreate').onclick=safe(()=>openCompanyDialog('create'),'company-create');
  $('companySearch').oninput=safe(render,'company-search');$('companyStatus').onchange=safe(render,'company-filter');
  for(const [id,collapsed] of [['companyCollapse',true],['companyExpand',false]])$(id).onclick=safe(e=>buttonAction(e.currentTarget,'company-all',()=>changeCompany('collapseAll',{collapsed}).then(()=>({ok:true}))),'company-fold');
  $('companyMoveSelected').onclick=safe(()=>openCompanyDialog('move',{keys:[...companySelection]}),'company-move');
  $('companyClearSelected').onclick=()=>{companySelection.clear();render();};
  $('companyCancel').onclick=()=>{if(!$('companySave').disabled)$('companyDialog').close();};
  $('companyDialog').oncancel=e=>{if($('companySave').disabled)e.preventDefault();};
  $('companyForm').onsubmit=safe(async e=>{
    e.preventDefault();const {action,data}=companyDialogAction;
    try {await buttonAction($('companySave'),'company-save',async()=>{await changeCompany(action,{...data,name:$('companyName').value,...(action==='move'?{id:$('companyTarget').value}:{})});return {ok:true};});
      if(action==='move')companySelection.clear();$('companyDialog').close();render();toast('公司分组已保存');
    } catch(error){$('companyDialogError').textContent=error.message;}
  },'company-save');
}
