const fs=require('node:fs');
const path=require('node:path');
const MEDIA=/\.(mp4|mkv|flv|mov|webm|avi|ts)$/i;
async function recordingPath(root,relative='') {
  if(typeof relative!=='string')throw Error('录像路径无效');
  const base=await fs.promises.realpath(root);
  const target=await fs.promises.realpath(path.resolve(base,relative));
  const rel=path.relative(base,target);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('只能浏览录像目录内的文件');
  return {target,relative:rel};
}
async function listRecordings(root,relative='') {
  const resolved=await recordingPath(root,relative);
  const entries=(await fs.promises.readdir(resolved.target,{withFileTypes:true}))
    .filter(e=>!e.isSymbolicLink()&&(e.isDirectory()||e.isFile()))
    .map(e=>({name:e.name,directory:e.isDirectory(),relative:path.join(resolved.relative,e.name),playable:e.isFile()&&MEDIA.test(e.name)}))
    .sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  return {ok:true,path:resolved.target,relative:resolved.relative,parent:resolved.relative?path.dirname(resolved.relative):'',entries:entries.slice(0,2000),truncated:entries.length>2000};
}
async function openRecording(root,relative,shell,timeoutMs=8000) {
  const {target}=await recordingPath(root,relative);
  if(!MEDIA.test(target)||!(await fs.promises.stat(target)).isFile())throw Error('请选择视频文件');
  let timer;
  try {
    const error=await Promise.race([shell.openPath(target),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('播放器响应超时，可复制目录路径后手动打开')),timeoutMs);})]);
    if(error)throw Error(error);
    return {ok:true,path:target};
  } finally {clearTimeout(timer);}
}
module.exports={recordingPath,listRecordings,openRecording};
