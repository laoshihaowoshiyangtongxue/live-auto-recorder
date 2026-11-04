// Split completed MP4 files on keyframes without re-encoding. Never remove the
// source: only publish pieces after full video/audio packet verification.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {hasMediaErrors}=require('./media');
const log=require('../util/log');
const LIMIT=16000000000; // decimal bytes; every published part must be strictly smaller
function identity(file){const s=fs.statSync(file,{bigint:true});if(!s.isFile())throw Error('录像不是普通文件');return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}
function sameContentIdentity(a,b){return typeof a==='string'&&typeof b==='string'&&a.split(':').slice(0,4).join(':')===b.split(':').slice(0,4).join(':');}
function packetDigest(){let buffer='';const streams=new Map();function line(text){if(!/^\s*\d+\s*,/.test(text))return;const cols=text.split(',').map(x=>x.trim());if(cols.length<6||!/^\d+$/.test(cols[0])||!/^\d+$/.test(cols[4])||!/^[a-f0-9]{64}$/i.test(cols[5]))throw Error('无法核验拆分媒体数据包');let s=streams.get(cols[0]);if(!s){s={hash:crypto.createHash('sha256'),count:0};streams.set(cols[0],s);}s.hash.update(cols[4]+':'+cols[5]+'\n');s.count++;}return {write(chunk){buffer+=chunk.toString();let i;while((i=buffer.indexOf('\n'))>=0){line(buffer.slice(0,i));buffer=buffer.slice(i+1);}if(buffer.length>131072)throw Error('媒体校验输出行过长');},finish(){if(buffer)line(buffer);return Object.fromEntries([...streams].map(([k,v])=>[k,{hash:v.hash.digest('hex'),count:v.count}]));}};}
async function fingerprint(rec,files){const p=packetDigest();for(const file of files){const r=await rec._runFfmpeg(['-v','error','-i',file,'-map','0:v:0','-map','0:a?','-c','copy','-f','framehash','-hash','sha256','-'],rec._processingTimeout([file]),chunk=>p.write(chunk));if(r.code!==0)throw Error('拆分完整性校验失败: '+String(r.stderr).slice(0,160));}const data=p.finish();if(!data['0']?.count)throw Error('视频没有可核验的数据');return data;}
// Keep timing evidence on disk so even very long recordings use bounded RAM.
// Compare each presentation time to the same first-packet origin, preserving
// the video/audio relationship as well as the sequence within each stream.
async function compareTimelines(rec,source,output,{comparePackets=false,maxTimeDelta=0.05}={}){
 if(!Number.isFinite(maxTimeDelta)||maxTimeDelta<0)throw Error('媒体时间偏差限制无效');
 const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'lr-packet-time-')),streams=new Map();
 function flush(s){let n=0;while(n<s.offset){const wrote=fs.writeSync(s.fd,s.buffer,n,s.offset-n);if(wrote<=0)throw Error('媒体时间戳暂存失败');n+=wrote;}}
 async function scan(file,writing){
  let text='',origin=null;const bases=new Map(),seen=new Set();
  function line(value){
   const tb=/^#tb\s+(\d+):\s*(\d+)\/(\d+)/.exec(value);if(tb){if(!Number(tb[3]))throw Error('媒体时间基无效');bases.set(tb[1],Number(tb[2])/Number(tb[3]));return;}
   if(!/^\s*\d+\s*,/.test(value))return;const c=value.split(',').map(v=>v.trim()),scale=bases.get(c[0]);
   if(!scale||!/^[-+]?\d+$/.test(c[2]))throw Error('媒体时间戳无法核对');const pts=Number(c[2])*scale;
   if(!Number.isFinite(pts))throw Error('媒体时间戳无效');if(origin===null)origin=pts;seen.add(c[0]);
   let s=streams.get(c[0]);if(!s&&writing){s={file:path.join(dir,c[0]+'.bin'),buffer:Buffer.allocUnsafe(65536),offset:0,count:0};if(comparePackets)s.packetHash=crypto.createHash('sha256');s.fd=fs.openSync(s.file,'wx');streams.set(c[0],s);}
   if(!s)throw Error('媒体流数量不一致');
   if(comparePackets){
    if(c.length<6||!/^\d+$/.test(c[4])||!/^[a-f0-9]{64}$/i.test(c[5]))throw Error('无法核验媒体数据包');
    s.packetHash.update(c[4]+':'+c[5]+'\n');
   }
   if(writing){s.buffer.writeDoubleLE(pts-origin,s.offset);s.offset+=8;s.count++;if(s.offset===s.buffer.length){flush(s);s.offset=0;}}
   else{if(s.offset===s.length){s.length=fs.readSync(s.fd,s.buffer,0,s.buffer.length,null);s.offset=0;}if(s.length-s.offset<8)throw Error('媒体包数量不一致');const expected=s.buffer.readDoubleLE(s.offset);s.offset+=8;s.read++;if(Math.abs((pts-origin)-expected)>maxTimeDelta)throw Error('媒体播放时间发生明显变化');}
  }
  const r=await rec._runFfmpeg(['-v','error','-copyts','-i',file,'-map','0:v:0','-map','0:a?','-c','copy','-f','framehash','-hash','sha256','-'],rec._processingTimeout([file]),chunk=>{text+=chunk.toString();let i;while((i=text.indexOf('\n'))>=0){line(text.slice(0,i));text=text.slice(i+1);}if(text.length>131072)throw Error('媒体时间戳输出行过长');});
  if(r.code!==0)throw Error('媒体时间戳核对失败');if(text)line(text);
  if(!seen.has('0')||(!writing&&(seen.size!==streams.size||[...streams.values()].some(s=>s.read!==s.count))))throw Error('媒体包数量不一致');
 }
 try{
  await scan(source,true);
  for(const s of streams.values()){
   if(comparePackets){s.expectedPacketHash=s.packetHash.digest('hex');s.packetHash=crypto.createHash('sha256');}
   if(s.offset)flush(s);fs.closeSync(s.fd);s.fd=null;s.fd=fs.openSync(s.file,'r');s.offset=0;s.length=0;s.read=0;
  }
  await scan(output,false);
  if(comparePackets&&[...streams.values()].some(s=>s.packetHash.digest('hex')!==s.expectedPacketHash))throw Error('媒体数据包不一致');
  return true;
 }finally{for(const s of streams.values())if(s.fd!==null)try{fs.closeSync(s.fd);}catch{}fs.rmSync(dir,{recursive:true,force:true});}
}
// A saved split is reusable only when it names exactly our own ordered temporary
// files and their identity, size and modification time still match the snapshot.
function reusableSplit(work,source,maxBytes){
 try{
  if(work?.version!==1||work.invalid||!sameContentIdentity(identity(source),work.sourceIdentity)||!work.sourcePackets?.['0']?.count||!Array.isArray(work.parts)||!work.parts.length)return false;
  let stamp='';
  for(let i=0;i<work.parts.length;i++){
   const part=work.parts[i];if(typeof part?.file!=='string'||!part.file.startsWith(source+'.split-'))return false;
   const match=/^\.split-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})-(\d{5})\.mp4$/i.exec(part.file.slice(source.length));
   if(!match||Number(match[2])!==i||(stamp&&stamp!==match[1]))return false;stamp=match[1];
   if(!sameContentIdentity(identity(part.file),part.identity)||fs.statSync(part.file).size>=maxBytes)return false;
  }
  return true;
 }catch{return false;}
}

// Read each part once: hash its original encoded packets and, in the same
// FFmpeg process, fully decode audio/video to a discard-only output. Synthetic
// video timestamps affect only that output and avoid repeating a whole decode
// when the null muxer rejects duplicate timestamps. The MP4 is never changed.
async function checkSplitPart(rec,file,digest,decode,index,total){
 rec.onStage?.(`${decode?'校验分段':'复核分段'} ${index+1}/${total}`);
 const before=identity(file),duration=await rec._probeDuration(file);
 const args=['-v','error','-err_detect','explode','-i',file,
  '-map','0:v:0','-map','0:a?','-c','copy','-f','framehash','-hash','sha256','pipe:1'];
 if(decode)args.push('-map','0:v:0','-map','0:a?','-vf','settb=1/1000000,setpts=N*1000',
  '-fps_mode','passthrough','-enc_time_base:v','1:1000000','-f','null','-');
 const r=await rec._runFfmpeg(args,Math.max(rec._processingTimeout([file]),Math.ceil(duration*1000)),chunk=>digest.write(chunk),duration);
 if(r.code!==0||hasMediaErrors(r.stderr)){
  const error=Error('拆分录像无法完整解码或核验，原文件已保留: '+String(r.stderr).slice(0,120));
  if(!r.aborted&&!r.timedOut&&!r.spaceError)error.code='LR_SPLIT_BAD_MEDIA';
  throw error;
 }
 const after=identity(file);
 if(!sameContentIdentity(after,before))throw Error('校验期间录像发生变化，已保留原文件');
 if(!decode&&after!==before)throw Error('已检查的分段属性发生变化，已保留分段等待重新检查');
 return {before,after,metadataChanged:after!==before};
}

// Redistribute cuts by measured bytes, not by average bitrate.  The segment
// muxer still moves each cut to a keyframe; the final size check is decisive.
function balancedCuts(files,rows,count,duration){
 if(files.length!==rows.length||count<2)return null;
 const sizes=files.map(f=>fs.statSync(f).size),total=sizes.reduce((a,b)=>a+b,0);
 if(!total||rows.some((r,i)=>!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.end<=r.start||(i&&r.start<rows[i-1].start)))return null;
 const origin=rows[0].start,cuts=[];let sum=0,j=0;
 for(let i=1;i<count;i++){
  const goal=total*i/count;
  while(j<sizes.length-1&&sum+sizes[j]<goal)sum+=sizes[j++];
  const row=rows[j],fraction=Math.max(0,Math.min(1,(goal-sum)/sizes[j]));
  const time=row.start-origin+(row.end-row.start)*fraction;
  if(!Number.isFinite(time)||time<=0||time>=duration||(cuts.length&&time<=cuts[cuts.length-1]))return null;
  cuts.push(time);
 }
 return cuts;
}
function readSegmentRows(file){
 try{return fs.readFileSync(file,'utf8').trim().split(/\r?\n/).map(line=>{
  const match=/,\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line);
  return match?{start:Number(match[1]),end:Number(match[2])}:{start:NaN,end:NaN};
 });}catch{return [];}
}
function refineCuts(files,rows,count,duration,requested,observations){
 if(files.length!==rows.length||!rows.length)return null;
 const sizes=files.map(f=>fs.statSync(f).size),total=sizes.reduce((a,b)=>a+b,0),origin=rows[0].start;
 if(!total||!Number.isFinite(origin)||rows.some(r=>!Number.isFinite(r.end)))return null;
 let sum=0,delay=0;
 for(let i=0;i<files.length-1;i++){
  sum+=sizes[i];const time=rows[i].end-origin;
  if(time>0&&time<duration){observations.push({time,fraction:sum/total});if(Number.isFinite(requested[i]))delay=Math.max(delay,time-requested[i]);}
 }
 const points=[{time:0,fraction:0},...observations,{time:duration,fraction:1}].sort((a,b)=>a.fraction-b.fraction);
 const cuts=[];
 for(let i=1;i<count;i++){
  const goal=i/count,j=points.findIndex(p=>p.fraction>=goal);if(j<1)return null;
  const a=points[j-1],b=points[j],width=b.fraction-a.fraction;
  const time=a.time+(b.time-a.time)*(width>0?(goal-a.fraction)/width:0)-Math.max(0,delay);
  if(!Number.isFinite(time)||time<=0||time>=duration||(cuts.length&&time<=cuts[cuts.length-1]))return null;
  cuts.push(time);
 }
 return cuts;
}

async function splitFile(rec,source,maxBytes=LIMIT){
 if(fs.statSync(source).size<maxBytes)return null;
 const before=identity(source),size=fs.statSync(source).size,duration=await rec._probeDuration(source);
 if(!Number.isFinite(duration)||duration<=0)throw Error('无法确定超大录像时长，已保留原文件');
 const stamp=crypto.randomUUID(),prefix=source+'.split-'+stamp+'-',pattern=prefix+'%05d.mp4';
 const initialCount=Math.ceil(size/(maxBytes-1));
 if(!Number.isSafeInteger(initialCount)||initialCount>1000)throw Error('录像关键帧间隔过大或分段数量过多，原文件已保留');
 let count=Math.max(2,initialCount),cuts=Array.from({length:count-1},(_,i)=>duration*(i+1)/count),files=[],sourcePackets,work,retain=false,metadataChanged=false;
 const observations=[];
 const segmentList=prefix+'segments.csv';
 const list=()=>fs.readdirSync(path.dirname(source)).filter(n=>n.startsWith(path.basename(prefix))&&/\d{5}\.mp4$/.test(n)).sort().map(n=>path.join(path.dirname(source),n));
 const save=()=>{if(rec.checkpoint?.()===false)throw Error('拆分进度暂未保存，原录像与分段均已保留');};
 try{
  const saved=rec.uploadSplitWork?.[source];
  if(reusableSplit(saved,source,maxBytes)){
   work=saved;files=work.parts.map(p=>p.file);sourcePackets=work.sourcePackets;retain=true;
   log.info(`[split] 继续检查已拆分的${files.length}段录像`);
   if(before!==work.sourceIdentity){
    rec.onStage?.('复核原录像');
    const current=await fingerprint(rec,[source]);
    if(JSON.stringify(current)!==JSON.stringify(sourcePackets)||!sameContentIdentity(identity(source),before))throw Error('原录像复核失败，已保留原文件和分段');
    metadataChanged=true;
   }
  }else{
   rec.assertSpace(Math.ceil(size*1.15),'拆分超大录像');
   for(let n=0;n<8;n++){
    for(const f of files)fs.unlinkSync(f);files=[];rec.onStage?.('拆分超大录像');
    const digest=packetDigest();
    const r=await rec._runFfmpeg(['-y','-v','error','-i',source,
     '-map','0:v:0','-map','0:a?','-c','copy','-f','framehash','-hash','sha256','pipe:1',
     '-map','0:v:0','-map','0:a?','-c','copy','-f','segment','-segment_times',cuts.map(t=>t.toFixed(6)).join(','),'-segment_list',segmentList,'-segment_list_type','csv','-reset_timestamps','1','-segment_format','mp4','-segment_format_options','movflags=+faststart',pattern],Math.max(rec._processingTimeout([source]),Math.ceil(duration*1000)),chunk=>digest.write(chunk),duration);
    files=list();if(r.code!==0||!files.length)throw Error('录像拆分失败: '+String(r.stderr).slice(0,160));
    sourcePackets=digest.finish();if(!sourcePackets['0']?.count)throw Error('视频没有可核验的数据');
    if(files.every(f=>fs.statSync(f).size<maxBytes))break;
    if(n===7)throw Error('录像关键帧间隔过大，无法在不丢画面的情况下拆至16 GB以下');
    // First try the minimum possible number of parts with byte-balanced cuts.
    // If keyframes/overhead still make that impractical, add parts gradually.
    if(n>=3)count++;
    const rows=readSegmentRows(segmentList);
    cuts=refineCuts(files,rows,count,duration,cuts,observations)||balancedCuts(files,rows,count,duration)||Array.from({length:count-1},(_,i)=>duration*(i+1)/count);
   }
   if(!sameContentIdentity(identity(source),before))throw Error('拆分期间原录像发生变化');
   work={version:1,sourceIdentity:before,sourcePackets,parts:files.map(file=>({file,identity:identity(file)}))};
   rec.uploadSplitWork ||= {};rec.uploadSplitWork[source]=work;retain=true;save();
   log.info(`[split] 已拆分${files.length}段，开始逐段核验`);
  }
  const ids=files.map(identity),digest=packetDigest();
  metadataChanged ||= before!==work.sourceIdentity||ids.some((id,i)=>id!==work.parts[i].identity);
  for(let i=0;i<files.length;i++){
   const current=identity(files[i]),decode=work.parts[i].verifiedIdentity!==current;
   const checked=await checkSplitPart(rec,files[i],digest,decode,i,files.length);
   metadataChanged ||= checked.metadataChanged;
   if(decode&&checked.before===checked.after){work.parts[i].verifiedIdentity=checked.after;save();}
   log.info(`[split] 第${i+1}/${files.length}段${decode?'已完整解码':'复用解码结果'}`);
  }
  const a=sourcePackets,b=digest.finish();
  if(JSON.stringify(a)!==JSON.stringify(b)){
   const error=Error('拆分前后音视频数据不一致，已保留原文件和分段');error.code='LR_SPLIT_BAD_MEDIA';throw error;
  }
  if(!sameContentIdentity(identity(source),before)||files.some((f,i)=>!sameContentIdentity(identity(f),ids[i])))throw Error('校验期间录像发生变化，已保留原文件和分段');
  let afterSource=identity(source),afterIds=files.map(identity);
  if(!sameContentIdentity(afterSource,before)||afterIds.some((id,i)=>!sameContentIdentity(id,ids[i])))throw Error('校验期间录像发生变化，已保留原文件和分段');
  // Metadata changes do not prove media bytes stayed intact. Re-read all
  // packets, and retry a changing metadata snapshot a few times without
  // throwing away the already-created split and per-part decode checkpoints.
  if(metadataChanged||afterSource!==before||afterIds.some((id,i)=>id!==ids[i])){
   log.warn('[split] 录像属性发生变化，正在重新核对音视频数据');
   let stable=false;
   for(let attempt=0;attempt<3&&!stable;attempt++){
    rec.onStage?.('复核录像属性变化');
    const startSource=identity(source),startIds=files.map(identity);
    if(!sameContentIdentity(startSource,before)||startIds.some((id,i)=>!sameContentIdentity(id,ids[i])))throw Error('复核期间录像发生变化，已保留原文件和分段');
    const finalSource=await fingerprint(rec,[source]),finalParts=await fingerprint(rec,files);
    afterSource=identity(source);afterIds=files.map(identity);
    if(JSON.stringify(finalSource)!==JSON.stringify(a)||JSON.stringify(finalParts)!==JSON.stringify(b)||!sameContentIdentity(afterSource,before)||afterIds.some((id,i)=>!sameContentIdentity(id,ids[i])))throw Error('录像数据复核失败，已保留原文件和分段');
    stable=afterSource===startSource&&afterIds.every((id,i)=>id===startIds[i]);
   }
   if(!stable)throw Error('录像属性持续变化，已保留原文件和已检查分段，稍后可继续');
  }
  return {source,sourceIdentity:afterSource,parts:files.map((file,i)=>({file,identity:afterIds[i]}))};
 }catch(e){
  if(e.code==='LR_SPLIT_BAD_MEDIA'&&work){work.invalid=true;try{save();}catch{}log.warn('[split] 分段校验失败，下次重试将重新拆分');}
  if(!retain)for(const f of list())try{fs.unlinkSync(f)}catch{}
  throw e;
 }finally{try{fs.unlinkSync(segmentList)}catch{}}
}
async function splitRecorder(rec,maxBytes=LIMIT){
 rec.uploadParts ||= {};
 for(let part=1;part<=rec.part;part++)for(const source of [rec.mp4Path(part),rec.burnOutPath(part)]){
  if(!fs.existsSync(source)||fs.statSync(source).size<maxBytes)continue;
  const existing=rec.uploadParts[source];
  if(existing&&existing.sourceIdentity===identity(source)&&existing.parts.every(p=>fs.existsSync(p.file)&&identity(p.file)===p.identity&&fs.statSync(p.file).size<maxBytes))continue;
  const result=await splitFile(rec,source,maxBytes);if(result){rec.uploadParts[source]=result;if(rec.uploadSplitWork)delete rec.uploadSplitWork[source];if(rec.checkpoint()===false)throw Error('拆分状态无法保存，原录像与分段均已保留');}
 }
}
module.exports={LIMIT,splitFile,splitRecorder,fingerprint,compareTimelines,identity,packetDigest,checkSplitPart,balancedCuts};
