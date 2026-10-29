// Split completed MP4 files on keyframes without re-encoding. Never remove the
// source: only publish pieces after full video/audio packet verification.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const LIMIT=15500000000; // decimal bytes, comfortably below 16 GB and 16 GiB
function identity(file){const s=fs.statSync(file,{bigint:true});if(!s.isFile())throw Error('录像不是普通文件');return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}
function packetDigest(){let buffer='';const streams=new Map();function line(text){if(!/^\s*\d+\s*,/.test(text))return;const cols=text.split(',').map(x=>x.trim());if(cols.length<6||!/^\d+$/.test(cols[0])||!/^\d+$/.test(cols[4])||!/^[a-f0-9]{64}$/i.test(cols[5]))throw Error('无法核验拆分媒体数据包');let s=streams.get(cols[0]);if(!s){s={hash:crypto.createHash('sha256'),count:0};streams.set(cols[0],s);}s.hash.update(cols[4]+':'+cols[5]+'\n');s.count++;}return {write(chunk){buffer+=chunk.toString();let i;while((i=buffer.indexOf('\n'))>=0){line(buffer.slice(0,i));buffer=buffer.slice(i+1);}if(buffer.length>131072)throw Error('媒体校验输出行过长');},finish(){if(buffer)line(buffer);return Object.fromEntries([...streams].map(([k,v])=>[k,{hash:v.hash.digest('hex'),count:v.count}]));}};}
async function fingerprint(rec,files){const p=packetDigest();for(const file of files){const r=await rec._runFfmpeg(['-v','error','-i',file,'-map','0:v:0','-map','0:a?','-c','copy','-f','framehash','-hash','sha256','-'],rec._processingTimeout([file]),chunk=>p.write(chunk));if(r.code!==0)throw Error('拆分完整性校验失败: '+String(r.stderr).slice(0,160));}const data=p.finish();if(!data['0']?.count)throw Error('视频没有可核验的数据');return data;}
async function splitFile(rec,source,maxBytes=LIMIT){
 if(fs.statSync(source).size<maxBytes)return null;
 const before=identity(source),size=fs.statSync(source).size,duration=await rec._probeDuration(source);
 if(!Number.isFinite(duration)||duration<=0)throw Error('无法确定超大录像时长，已保留原文件');
 const stamp=crypto.randomUUID(),prefix=source+'.split-'+stamp+'-',pattern=prefix+'%05d.mp4';
 let segment=Math.max(0.1,duration*(maxBytes/size)*0.8),files=[];
 const list=()=>fs.readdirSync(path.dirname(source)).filter(n=>n.startsWith(path.basename(prefix))&&/\d{5}\.mp4$/.test(n)).sort().map(n=>path.join(path.dirname(source),n));
 rec.assertSpace(Math.ceil(size*1.15),'拆分超大录像');
 try{
  for(let n=0;n<8;n++){
   for(const f of files)fs.unlinkSync(f);files=[];rec.onStage?.('拆分超大录像');
   const r=await rec._runFfmpeg(['-y','-v','error','-i',source,'-map','0:v:0','-map','0:a?','-c','copy','-f','segment','-segment_time',String(segment),'-reset_timestamps','1','-segment_format','mp4','-segment_format_options','movflags=+faststart',pattern],Math.max(rec._processingTimeout([source]),Math.ceil(duration*1000)),false,duration);
   files=list();if(r.code!==0||!files.length)throw Error('录像拆分失败: '+String(r.stderr).slice(0,160));
   if(files.every(f=>fs.statSync(f).size<maxBytes))break;
   segment/=2;if(n===7)throw Error('录像关键帧间隔过大，无法在不丢画面的情况下拆至16 GB以下');
  }
  if(identity(source)!==before)throw Error('拆分期间原录像发生变化');
  const ids=files.map(identity);rec.onStage?.('核对拆分完整性');const a=await fingerprint(rec,[source]),b=await fingerprint(rec,files);
  if(JSON.stringify(a)!==JSON.stringify(b)||identity(source)!==before||files.some((f,i)=>identity(f)!==ids[i]))throw Error('拆分前后音视频数据不一致，已保留原文件');
  for(const file of files){const checked=await rec.validateMedia(file);if(!checked.ok)throw Error('拆分录像无法完整解码，原文件已保留: '+String(checked.stderr).slice(0,120));}
  if(identity(source)!==before||files.some((f,i)=>identity(f)!==ids[i]))throw Error('校验期间录像发生变化，已保留原文件');
  // Paths remain unique; each is recorded before publication and validated again
  // by its identity so a restart cannot publish modified pieces.
  return {source,sourceIdentity:before,parts:files.map(file=>({file,identity:identity(file)}))};
 }catch(e){for(const f of list())try{fs.unlinkSync(f)}catch{}throw e;}
}
async function splitRecorder(rec,maxBytes=LIMIT){
 rec.uploadParts ||= {};
 for(let part=1;part<=rec.part;part++)for(const source of [rec.mp4Path(part),rec.burnOutPath(part)]){
  if(!fs.existsSync(source)||fs.statSync(source).size<maxBytes)continue;
  const existing=rec.uploadParts[source];
  if(existing&&existing.sourceIdentity===identity(source)&&existing.parts.every(p=>fs.existsSync(p.file)&&identity(p.file)===p.identity&&fs.statSync(p.file).size<maxBytes))continue;
  const result=await splitFile(rec,source,maxBytes);if(result){rec.uploadParts[source]=result;if(rec.checkpoint()===false)throw Error('拆分状态无法保存，原录像与分段均已保留');}
 }
}
module.exports={LIMIT,splitFile,splitRecorder,fingerprint,identity};
