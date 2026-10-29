window.auditCalls=[];
window.auditMode='ok';
window.auditListeners=[];
window.auditState={tasks:[{rid:'123456',dispName:'测试主播',state:'recording',live:true,paused:false,startedAt:Date.now(),bytes:1,dmCount:2}],history:[],post:{items:[{id:'11111111-1111-1111-1111-111111111111',name:'测试任务',status:'failed',partsTotal:1}]},settings:{},diskFreeGB:100};
window.auditEmit=()=>window.auditListeners.forEach(cb=>cb(window.auditState));
window.confirm=()=>true;
window.alert=text=>{window.auditAlert=text;};
window.api=new Proxy({}, {get:(_,name)=>{
 if(name==='onState')return cb=>window.auditListeners.push(cb);
 if(name==='getState')return async()=>window.auditState;
 return async(...args)=>{
   window.auditCalls.push({name,args});
   if(window.auditMode==='throw')throw Error('注入通信失败');
   if(window.auditMode==='defer')return new Promise(resolve=>{window.auditResolve=resolve;});
   if(window.auditMode==='fail')return {ok:false,error:'注入后台失败'};
   if(name==='companyAction') {
     try {
       const cfg={companies:window.auditState.companies||[],ungroupedCollapsed:window.auditState.ungroupedCollapsed,watchlist:window.auditState.tasks.map(t=>({rid:t.secWatch?'':t.rid,secUid:t.identity||'',companyId:t.companyId}))};
       const next=await require('electron').ipcRenderer.invoke('audit-company',cfg,args[0],args[1]);window.auditState.companies=next.companies;window.auditState.ungroupedCollapsed=next.ungroupedCollapsed;
       window.auditState.tasks.forEach((t,i)=>t.companyId=next.watchlist[i].companyId);return {ok:true};
     } catch(e){return {ok:false,error:e.message};}
   }
   const nested=name==='listRecordings'&&args[0]&&args[0]!=='.';
   return {ok:true,path:nested?'E:/test/主播':'E:/test',relative:nested?'主播':'',parent:'',entries:nested?[{name:'录像.mp4',relative:'主播/录像.mp4',playable:true}]:[{name:'主播',relative:'主播',directory:true}],count:2,added:2,failed:[],lines:['测试日志']};
 };
}});
