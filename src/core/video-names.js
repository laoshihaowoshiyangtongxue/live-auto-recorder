const fs=require('node:fs');
const path=require('node:path');

function component(value,fallback){
  const cleaned=String(value||'').normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'_').replace(/\s+/g,' ').trim().replace(/[. ]+$/g,'');
  return cleaned||fallback;
}
function shorten(value,limit){let result='';for(const ch of value){if(result.length+ch.length>limit)break;result+=ch;}return result;}
function identity(file){const s=fs.statSync(file);if(!s.isFile())throw Error('录像路径不是普通文件');return {ino:s.ino,dev:s.dev,size:s.size};}
function matches(file,expected){const actual=identity(file);return ['ino','dev','size'].every(k=>actual[k]===expected[k]);}
function startStamp(rec){
  const match=path.basename(rec.base).match(/_(\d{8})_(\d{6})(?:_\d+)?$/);
  if(match)return {date:match[1].slice(0,4)+'-'+match[1].slice(4,6)+'-'+match[1].slice(6),time:match[2].match(/../g).join('-')};
  const d=new Date(rec.startedAt);if(!Number.isFinite(d.getTime()))throw Error('缺少录像起录时间，原文件保留');
  const p=n=>String(n).padStart(2,'0');return {date:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`,time:`${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`};
}
function stamp(rec,job){
  const start=startStamp(rec),finished=Number(job?.finishedAt);
  const morningStart=Number(start.time.slice(0,2))<6?{...start,date:start.date+'凌晨'}:start;
  if(!Number.isFinite(finished)||finished<=0||!Number.isFinite(new Date(finished).getTime()))return morningStart;
  // Archive an overnight session under the following early morning in the
  // user's local business timezone. Never alter the actual start time/metadata.
  const fields=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(finished)).map(p=>[p.type,p.value]));
  const endDate=`${fields.year}-${fields.month}-${fields.day}`;
  return endDate>start.date&&Number(fields.hour)<9?{...start,date:endDate+'凌晨'}:morningStart;
}
function makePlan(rec,job){
  const directory=path.dirname(rec.base),{date,time}=stamp(rec,job);
  const nickname=shorten(component(job.nickname,'直播间'),48),topic=component(job.title,'未命名主题');
  const sources=[];
  for(let part=1;part<=rec.part;part++)for(const [kind,source] of [['纯享版',rec.mp4Path(part)],['弹幕版',rec.burnOutPath(part)]])if(fs.existsSync(source)){
    const split=rec.uploadParts?.[source];
    if(split){
      const {identity:splitIdentity,LIMIT}=require('./upload-split');
      if(split.sourceIdentity!==splitIdentity(source)||!split.parts?.length)throw Error('超大原录像已改变，无法发布拆分结果');
      for(const [index,piece] of split.parts.entries()){
        if(!piece.file.startsWith(source+'.split-')||path.dirname(piece.file)!==directory||!fs.existsSync(piece.file)||splitIdentity(piece.file)!==piece.identity||fs.statSync(piece.file).size>=LIMIT)throw Error('拆分录像已改变或过大，原文件已保留');
        sources.push({source:piece.file,kind,part,splitIndex:index+1,splitTotal:split.parts.length,identity:identity(piece.file)});
      }
    } else sources.push({source,kind,part,identity:identity(source)});
  }
  if(!sources.length)return [];
  for(let serial=1;serial<10000;serial++){
    const counter=serial===1?'':`_${serial}`;
    const entries=sources.map(entry=>{
      const prefix=`${date}_${nickname}_${time}_`,tail=`${rec.part>1?'_分段'+String(entry.part).padStart(2,'0'):''}${entry.splitTotal?'_上传分段'+String(entry.splitIndex).padStart(3,'0'):''}${counter}_${entry.kind}.mp4`;
      const available=Math.min(100,240-directory.length-1-prefix.length-tail.length);
      if(available<1)throw Error('录像保存路径过长，原文件保留，请缩短保存路径');
      const topicPart=shorten(topic,available).replace(/[. ]+$/g,'')||shorten('主题',available);
      return {...entry,destination:path.join(directory,prefix+topicPart+tail)};
    });
    if(entries.every(entry=>!fs.existsSync(entry.destination)))return entries;
  }
  throw Error('同名录像过多，原文件已保留');
}
function applyPlan(rec,entries,{renameFinal=false}={}){
  try {
  const allowed=new Set();for(let i=1;i<=rec.part;i++){allowed.add(path.resolve(rec.mp4Path(i)));allowed.add(path.resolve(rec.burnOutPath(i)));}
  for(const split of Object.values(rec.uploadParts||{}))for(const piece of split.parts||[])if(typeof piece.file==='string'&&piece.file.startsWith(split.source+'.split-')&&path.dirname(path.resolve(piece.file))===path.dirname(path.resolve(rec.base)))allowed.add(path.resolve(piece.file));
  for(const entry of entries){
    const finalSource=renameFinal&&path.dirname(path.resolve(entry.source))===path.dirname(path.resolve(rec.base))&&isFinalVideoName(path.basename(entry.source));
    if((!allowed.has(path.resolve(entry.source))&&!finalSource)||path.dirname(path.resolve(entry.destination))!==path.dirname(path.resolve(rec.base))||!/_((纯享版)|(弹幕版))\.mp4$/.test(entry.destination))throw Error('录像命名计划路径无效，原文件已保留');
    if(fs.existsSync(entry.destination)){
      if(!matches(entry.destination,entry.identity))throw Error('目标录像已存在，未覆盖任何文件');
      if(fs.existsSync(entry.source)){
        if(!matches(entry.source,entry.identity))throw Error('原录像已变化，保留现有文件');
        fs.unlinkSync(entry.source);
      }
      continue;
    }
    if(!fs.existsSync(entry.source)||!matches(entry.source,entry.identity))throw Error('待命名录像已变化或缺失，保留现有文件');
    // Same-folder hard links create the destination atomically without ever
    // replacing an unrelated file. A crash before unlink is safe to resume.
    fs.linkSync(entry.source,entry.destination);
    fs.unlinkSync(entry.source);
  }
  return entries.map(entry=>entry.destination);
  } catch(error) {
    if(['EPERM','EACCES','EBUSY'].includes(error.code)){
      error.code='LR_SOURCE_BUSY';error.message='录像文件暂被占用，保留现有文件，稍后自动完成命名';
    }
    throw error;
  }
}
function makeArchivePlan(rec){
  const dir=path.join(path.dirname(rec.base),'超大原片备份');const allowed=new Set();
  for(let i=1;i<=rec.part;i++){allowed.add(rec.mp4Path(i));allowed.add(rec.burnOutPath(i));}
  return Object.keys(rec.uploadParts||{}).map(source=>{
    if(!allowed.has(source)||!fs.existsSync(source))throw Error('超大原片不存在，无法安全归档');
    const target=path.join(dir,path.basename(source));
    if(fs.existsSync(target))throw Error('超大原片备份已存在，原文件保留');
    return {source,target,identity:identity(source)};
  });
}
function applyArchivePlan(rec,entries){
  const dir=path.join(path.dirname(rec.base),'超大原片备份');
  if(!entries?.length)return;
  fs.mkdirSync(dir,{recursive:true});const stat=fs.lstatSync(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('超大原片备份目录不安全');
  const allowed=new Set();for(let i=1;i<=rec.part;i++){allowed.add(path.resolve(rec.mp4Path(i)));allowed.add(path.resolve(rec.burnOutPath(i)));}
  for(const e of entries){
    if(!allowed.has(path.resolve(e.source))||path.dirname(path.resolve(e.target))!==path.resolve(dir)||path.basename(e.source)!==path.basename(e.target))throw Error('超大原片归档路径无效');
    if(fs.existsSync(e.target)){
      if(!matches(e.target,e.identity))throw Error('超大原片备份目标已存在，保留原文件');
      if(fs.existsSync(e.source)){if(!matches(e.source,e.identity))throw Error('超大原片已变化，保留原文件');fs.unlinkSync(e.source);}
    }else{
      if(!fs.existsSync(e.source)||!matches(e.source,e.identity))throw Error('超大原片已变化或缺失，保留现有文件');
      fs.linkSync(e.source,e.target);fs.unlinkSync(e.source);
    }
  }
}
function videoFiles(rec,job){
  if(job.publicationPlan?.length)return job.publicationPlan.map(entry=>fs.existsSync(entry.destination)?entry.destination:entry.source).filter(file=>fs.existsSync(file));
  const files=[];for(let i=1;i<=rec.part;i++)for(const file of [rec.mp4Path(i),rec.burnOutPath(i)])if(fs.existsSync(file))files.push(file);
  return files;
}
function isFinalVideoName(name){return /^\d{4}-\d{2}-\d{2}(?:凌晨)?_.+_\d{2}-\d{2}-\d{2}_.+_(纯享版|弹幕版)\.mp4$/.test(name);}
function dateMigration(rec,job){
  if(job.namingMigrationPlan?.length)return job.namingMigrationPlan;
  const date=stamp(rec,job).date;
  const changed=(job.publicationPlan||[]).filter(e=>fs.existsSync(e.destination)&&isFinalVideoName(path.basename(e.destination))).map(e=>({source:e.destination,destination:path.join(path.dirname(e.destination),path.basename(e.destination).replace(/^\d{4}-\d{2}-\d{2}(?:凌晨)?/,date)),identity:identity(e.destination)})).filter(e=>e.source!==e.destination);
  for(const entry of changed)if(fs.existsSync(entry.destination)&&!matches(entry.destination,entry.identity))throw Error('新的凌晨命名已被其他文件占用，保留原文件');
  return changed;
}
module.exports={makePlan,applyPlan,makeArchivePlan,applyArchivePlan,videoFiles,isFinalVideoName,stamp,dateMigration};
