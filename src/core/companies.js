const {randomUUID}=require('node:crypto');

function normalizeCompanies(list) {
  const ids=new Set();
  return (Array.isArray(list)?list:[]).filter(c=>c&&typeof c.id==='string'&&c.id&&c.id!=='none'&&typeof c.name==='string'&&c.name.trim()&&!ids.has(c.id)&&ids.add(c.id))
    .map(c=>({id:c.id,name:c.name.trim().slice(0,60),collapsed:c.collapsed!==false}));
}

// Pure update: callers persist successfully before replacing the active configuration.
function updateCompanies(cfg,action,data={}) {
  let companies=normalizeCompanies(cfg.companies),watchlist=cfg.watchlist.map(w=>({...w}));
  const find=()=>{const company=companies.find(c=>c.id===data.id);if(!company)throw Error('该公司分组已不存在');return company;};
  const name=()=>{const value=String(data.name||'').trim();if(!value||value.length>60)throw Error('公司名称需为1至60个字符');if(companies.some(c=>c.id!==data.id&&c.name===value))throw Error('该公司名称已存在');return value;};
  if(action==='create')companies.push({id:randomUUID(),name:name(),collapsed:false});
  else if(action==='rename')find().name=name();
  else if(action==='delete') {find();companies=companies.filter(c=>c.id!==data.id);for(const w of watchlist)if(w.companyId===data.id)delete w.companyId;}
  else if(action==='collapse') {if(typeof data.collapsed!=='boolean')throw Error('折叠状态无效');if(data.id==='none')return {...cfg,companies,watchlist,ungroupedCollapsed:data.collapsed};find().collapsed=data.collapsed;}
  else if(action==='collapseAll') {if(typeof data.collapsed!=='boolean')throw Error('折叠状态无效');companies.forEach(c=>c.collapsed=data.collapsed);return {...cfg,companies,watchlist,ungroupedCollapsed:data.collapsed};}
  else if(action==='move') {
    if(data.id!=='none')find();
    if(!Array.isArray(data.keys)||!data.keys.length||data.keys.length>1000)throw Error('请选择需要移动的主播');
    const keys=new Set(data.keys.map(String));let moved=0;
    for(const w of watchlist)if(keys.has(String(w.rid||w.secUid))||(w.secUid&&keys.has(String(w.secUid)))){moved++;if(data.id==='none')delete w.companyId;else w.companyId=data.id;}
    if(!moved)throw Error('所选主播已不存在，请刷新后重试');
  } else throw Error('不支持的公司操作');
  return {...cfg,companies,watchlist};
}
module.exports={normalizeCompanies,updateCompanies};
