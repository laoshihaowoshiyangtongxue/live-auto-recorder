// 只保存界面布局，不修改任何录制或后处理状态。
(() => {
  const get=id=>document.getElementById(id),workspace=get('layoutWorkspace'),post=get('postPanel'),history=get('historyPanel'),monitor=document.querySelector('main');
  const key='recorder-layout-v1',defaults={post:240,history:160,monitorCollapsed:false,historyCollapsed:false};
  let layout={...defaults};
  try{const saved=JSON.parse(localStorage.getItem(key));if(saved&&typeof saved==='object')layout={post:Number.isFinite(saved.post)?saved.post:240,history:Number.isFinite(saved.history)?saved.history:160,monitorCollapsed:saved.monitorCollapsed===true,historyCollapsed:saved.historyCollapsed===true};}catch{}
  const save=()=>{try{localStorage.setItem(key,JSON.stringify(layout));}catch{}};
  function apply(){
    monitor.classList.toggle('layout-collapsed',layout.monitorCollapsed);history.classList.toggle('layout-collapsed',layout.historyCollapsed);
    for(const [id,collapsed] of [['monitor',layout.monitorCollapsed],['history',layout.historyCollapsed]]){const button=get(id+'Collapse');button.textContent=collapsed?'展开区域':'收起区域';button.setAttribute('aria-expanded',String(!collapsed));}
    get('postSplit').hidden=post.hidden;
    const addbar=document.querySelector('.addbar').offsetHeight,available=Math.max(0,workspace.clientHeight-addbar-24);
    const monitorMin=layout.monitorCollapsed?54:110,historyMin=layout.historyCollapsed?48:70,postMin=post.hidden?0:70;
    const maxPost=Math.max(postMin,available-monitorMin-historyMin);
    const postHeight=post.hidden?0:Math.min(maxPost,Math.max(postMin,layout.post));
    const maxHistory=Math.max(historyMin,available-monitorMin-postHeight);
    post.style.height=postHeight+'px';history.style.height=(layout.historyCollapsed?48:Math.min(maxHistory,Math.max(historyMin,layout.history)))+'px';
  }
  function resize(id,amount){if(id==='history'&&layout.historyCollapsed||id==='post'&&post.hidden)return;const node=id==='post'?post:history;layout[id]=Math.max(70,node.offsetHeight+amount);apply();layout[id]=node.offsetHeight;save();}
  for(const id of ['post','history']){
    const bar=get(id+'Split');bar.addEventListener('pointerdown',event=>{if(event.button!==0)return;bar.setPointerCapture(event.pointerId);let last=event.clientY;const move=e=>{const delta=e.clientY-last;last=e.clientY;resize(id,id==='post'?delta:-delta);};const end=()=>{bar.removeEventListener('pointermove',move);bar.removeEventListener('pointerup',end);bar.removeEventListener('pointercancel',end);};bar.addEventListener('pointermove',move);bar.addEventListener('pointerup',end);bar.addEventListener('pointercancel',end);});
    bar.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();resize(id,(event.key==='ArrowDown'?1:-1)*(id==='post'?1:-1)*(event.shiftKey?40:10));});
  }
  get('monitorCollapse').onclick=()=>{layout.monitorCollapsed=!layout.monitorCollapsed;apply();save();};
  get('historyCollapse').onclick=()=>{layout.historyCollapsed=!layout.historyCollapsed;apply();save();};
  get('postCollapse').onclick=()=>get('postBadge').click();
  get('layoutReset').onclick=()=>{layout={...defaults};apply();save();};
  new MutationObserver(apply).observe(post,{attributes:true,attributeFilter:['hidden']});
  window.addEventListener('resize',apply);apply();
})();
