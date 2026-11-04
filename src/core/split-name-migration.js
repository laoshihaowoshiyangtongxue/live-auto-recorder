// One-time, explicitly requested correction of already published split names.
// The request file contains only job IDs and stays in the local work directory.
const fs=require('node:fs'),path=require('node:path');
const {splitLabel,isFinalVideoName}=require('./video-names');
const {writeJson}=require('../util/atomic-json');

function matches(file,expected){
 try{const s=fs.statSync(file);return s.isFile()&&expected&&['dev','ino','size'].every(k=>s[k]===expected[k]);}catch{return false;}
}
function splitNamePlan(rec,job){
 if(Array.isArray(job.splitNamingMigrationPlan)&&job.splitNamingMigrationPlan.length)return job.splitNamingMigrationPlan;
 if(!Array.isArray(job.publicationPlan))return [];
 const dir=path.resolve(path.dirname(rec.base)),plan=[];
 for(const entry of job.publicationPlan){
  if(!Number.isInteger(entry.splitIndex)||!Number.isInteger(entry.splitTotal)||entry.splitTotal<2)continue;
  const source=entry.destination;if(typeof source!=='string'||path.dirname(path.resolve(source))!==dir||!isFinalVideoName(path.basename(source)))throw Error('已发布录像的命名记录无效，文件已保留');
  const name=path.basename(source),match=/_上传分段(\d+)(?=(?:_\d+)?_(纯享版|弹幕版)\.mp4$)/.exec(name);
  if(!match)continue;
  if(Number(match[1])!==entry.splitIndex||match[2]!==entry.kind)throw Error('录像分段序号与记录不一致，文件已保留');
  const label=splitLabel(entry.splitIndex,entry.splitTotal),destination=path.join(dir,name.replace(match[0],'_'+label));
  if(destination.length>240)throw Error('新录像名称过长，文件已保留');
  const exists=fs.existsSync(source),target=fs.existsSync(destination);
  if((exists&&!matches(source,entry.identity))||(target&&!matches(destination,entry.identity))||(!exists&&!target))throw Error('录像文件缺失、改变或新名称已被占用，文件已保留');
  plan.push({source,destination,identity:entry.identity});
 }
 if(new Set(plan.map(p=>p.destination.toLowerCase())).size!==plan.length)throw Error('录像新名称重复，文件已保留');
 return plan;
}
// Create an additional name for the same NTFS file. Keep the old name while
// the running application or an uploader may still refer to it.
function createAliases(plan){
 for(const item of plan){
  if(fs.existsSync(item.destination)){if(!matches(item.destination,item.identity))throw Error('录像新名称已被其他文件占用');continue;}
  if(!matches(item.source,item.identity))throw Error('原录像已变化或暂不可用');
  fs.linkSync(item.source,item.destination);
  if(!matches(item.destination,item.identity))throw Error('新名称无法确认文件身份');
 }
}
function requestPath(storeFile){return path.join(path.dirname(storeFile),'work','pending-split-names.json');}
function readRequestState(storeFile){
 const file=requestPath(storeFile);if(!fs.existsSync(file))return {jobs:[],since:null};
 const data=JSON.parse(fs.readFileSync(file,'utf8'));
 if(![1,2].includes(data.version)||!Array.isArray(data.jobs)||data.jobs.some(id=>typeof id!=='string'||!id||id.length>128)||(data.since!=null&&(!Number.isFinite(data.since)||data.since<0)))throw Error('录像命名请求记录无效');
 return {jobs:[...new Set(data.jobs)],since:data.since??null};
}
function readRequests(storeFile){return readRequestState(storeFile).jobs;}
function saveRequests(storeFile,jobs,{since=null}={}){const file=requestPath(storeFile);fs.mkdirSync(path.dirname(file),{recursive:true});writeJson(file,{version:2,jobs:[...new Set(jobs)],since},{backup:true});}
function queueRequests(storeFile,ids,{since=null}={}){
 const state=readRequestState(storeFile);if(since!==null&&(!Number.isFinite(since)||since<0))throw Error('录像命名请求时间无效');
 const start=state.since===null?since:since===null?state.since:Math.min(state.since,since);
 saveRequests(storeFile,[...state.jobs,...ids],{since:start});
}
module.exports={splitNamePlan,createAliases,readRequestState,readRequests,saveRequests,queueRequests};
