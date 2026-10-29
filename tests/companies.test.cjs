const test=require('node:test'),assert=require('node:assert/strict');
const {updateCompanies,normalizeCompanies}=require('../src/core/companies');
const cfg=()=>({companies:[{id:'a',name:'传媒 A',collapsed:false}],settings:{pollIntervalSec:3},watchlist:[{rid:'123456',secUid:'profile',name:'主播',titleFilter:'游戏',companyId:'a'},{rid:'',secUid:'offline',name:'待开播'}]});
test('company create rename move delete and collapse preserve recording settings and identities',()=>{
  const original=cfg(),created=updateCompanies(original,'create',{name:'传媒 B'}),id=created.companies[1].id;
  const moved=updateCompanies(created,'move',{id,keys:['profile','offline']});assert.ok(moved.watchlist.every(w=>w.companyId===id));
  assert.equal(moved.watchlist[0].titleFilter,'游戏');assert.equal(original.watchlist[0].companyId,'a');
  const renamed=updateCompanies(moved,'rename',{id,name:'新名称'});assert.equal(renamed.companies[1].name,'新名称');
  const folded=updateCompanies(renamed,'collapseAll',{collapsed:true});assert.ok(folded.companies.every(c=>c.collapsed));assert.equal(folded.ungroupedCollapsed,true);
  const deleted=updateCompanies(folded,'delete',{id});assert.equal(deleted.watchlist.length,2);assert.ok(deleted.watchlist.every(w=>!w.companyId));assert.deepEqual(deleted.settings,original.settings);
});
test('company updates reject stale destinations, empty selections, and duplicate names without mutating config',()=>{
  const original=cfg(),before=structuredClone(original);
  for(const [action,data] of [['move',{id:'missing',keys:['123456']}],['move',{id:'a',keys:[]}],['move',{id:'a',keys:['gone']}],['create',{name:'传媒 A'}],['rename',{id:'a',name:' '}],['collapse',{id:'a',collapsed:'false'}],['unknown',{}]])assert.throws(()=>updateCompanies(original,action,data));
  assert.deepEqual(original,before);
});
test('legacy and damaged company lists normalize without fabricating streamer affiliations',()=>{
  assert.deepEqual(normalizeCompanies(undefined),[]);
  assert.deepEqual(normalizeCompanies([null,{id:'none',name:'保留名称'},{id:'a',name:' A '},{id:'a',name:'重复'},{id:'bad'}]),[{id:'a',name:'A',collapsed:true}]);
  assert.equal(updateCompanies(cfg(),'collapse',{id:'none',collapsed:true}).ungroupedCollapsed,true);
});
