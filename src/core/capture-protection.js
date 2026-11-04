// Protect closed capture files while post-processing is pending. Hard links
// are created on the same volume and removed only after successful publication.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function directory(base){return path.join(path.dirname(base),'待处理原片保护');}
function backupPath(rec,part){return path.join(directory(rec.base),path.basename(rec.flvPath(part)));}
function protectPart(rec,part){
 const source=rec.flvPath(part);let s;try{s=fs.lstatSync(source,{bigint:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
 if(!s.isFile()||s.isSymbolicLink()||s.size===0n)return;if(s.ino===0n)throw Error('无法确认原片身份');
 const dir=directory(rec.base);fs.mkdirSync(dir,{recursive:true});const ds=fs.lstatSync(dir);if(!ds.isDirectory()||ds.isSymbolicLink())throw Error('原片保护目录不安全');
 const target=backupPath(rec,part);try{fs.linkSync(source,target);}catch(e){if(e.code!=='EEXIST')throw e;}
 const b=fs.lstatSync(target,{bigint:true});if(!b.isFile()||b.isSymbolicLink()||b.dev!==s.dev||b.ino!==s.ino||b.size!==s.size)throw Error('原片保护目标不匹配');
 rec.captureBackups ||= {};rec.captureBackups[part]={dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtimeNs:String(s.mtimeNs)};
}
function restoreParts(rec){
 // A committed multi-part merge represents more media than any one original
 // link. Never restore its first segment as if it were the complete merge.
 if(Number(rec.mergedFromParts)>1)return;
 for(const [key,identity] of Object.entries(rec.captureBackups||{})){
  const part=Number(key);if(!Number.isInteger(part)||part<1||part>rec.part)continue;
  const source=rec.flvPath(part);if(fs.existsSync(source)||fs.existsSync(rec.mp4Path(part))||(rec.settings?.keepRaw===false&&fs.existsSync(rec.burnOutPath(part))))continue;
  const target=backupPath(rec,part);let s;try{s=fs.lstatSync(target,{bigint:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!s.isFile()||s.isSymbolicLink()||String(s.dev)!==identity.dev||String(s.ino)!==identity.ino||String(s.size)!==identity.size||String(s.mtimeNs)!==identity.mtimeNs)throw Error('原片保护文件已变化，保留现有文件');
  try{fs.linkSync(target,source);}catch(e){if(e.code!=='EEXIST')throw e;}
  rec.notices ||= [];const notice=`分片${part}已从待处理保护文件恢复`;if(!rec.notices.includes(notice))rec.notices.push(notice);
 }
}
function cleanupParts(rec){
 for(const [key,identity] of Object.entries(rec.captureBackups||{})){
  const part=Number(key);if(!Number.isInteger(part)||part<1)continue;const target=backupPath(rec,part);
  try{const s=fs.lstatSync(target,{bigint:true});if(s.isFile()&&!s.isSymbolicLink()&&String(s.dev)===identity.dev&&String(s.ino)===identity.ino&&String(s.size)===identity.size&&String(s.mtimeNs)===identity.mtimeNs)fs.unlinkSync(target);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 rec.captureBackups={};
}
function commentPath(base){return path.join(path.dirname(base),'弹幕备份',path.basename(base)+'.danmaku.jsonl');}
async function digest(file){const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function backupComments(base){
 const source=base+'.danmaku.jsonl';if(!fs.existsSync(source))return false;const dir=path.dirname(commentPath(base));fs.mkdirSync(dir,{recursive:true});const ds=fs.lstatSync(dir);if(!ds.isDirectory()||ds.isSymbolicLink())throw Error('弹幕备份目录不安全');
 const target=commentPath(base),temp=target+'.'+crypto.randomUUID()+'.tmp';
 try{const before=await fs.promises.stat(source,{bigint:true});await fs.promises.copyFile(source,temp,fs.constants.COPYFILE_EXCL);const [a,b]=await Promise.all([digest(source),digest(temp)]),after=await fs.promises.stat(source,{bigint:true});if(a!==b||['dev','ino','size','mtimeNs','ctimeNs'].some(k=>before[k]!==after[k]))throw Error('弹幕备份核对失败');try{await fs.promises.link(temp,target);}catch(e){if(e.code!=='EEXIST')throw e;if(await digest(target)!==a)throw Error('弹幕备份已存在且内容不同');}try{await fs.promises.writeFile(target+'.sha256',a,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||(await fs.promises.readFile(target+'.sha256','utf8')).trim()!==a)throw e;}return true;}finally{try{await fs.promises.unlink(temp);}catch{}}
}
async function findCommentBackup(base){const file=commentPath(base);try{const s=await fs.promises.lstat(file);if(!s.isFile()||s.isSymbolicLink())return null;const expected=(await fs.promises.readFile(file+'.sha256','utf8')).trim();return /^[a-f0-9]{64}$/.test(expected)&&await digest(file)===expected?file:null;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
module.exports={protectPart,restoreParts,cleanupParts,backupComments,findCommentBackup};
