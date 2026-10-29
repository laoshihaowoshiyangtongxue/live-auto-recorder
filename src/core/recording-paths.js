const fs=require('node:fs');
const path=require('node:path');
const {safeName}=require('../util/const');

function recordingDirs(root) {
  return [root,...fs.readdirSync(root,{withFileTypes:true})
    .filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&/_\d{6,13}$/.test(e.name))
    .map(e=>path.join(root,e.name))];
}

function roomDirectory(root,rid,nickname) {
  rid=String(rid);
  if(!/^\d{6,13}$/.test(rid))throw new Error('录像分类房间号无效');
  fs.mkdirSync(root,{recursive:true});
  const existing=recordingDirs(root).slice(1).filter(dir=>path.basename(dir).endsWith('_'+rid)).sort();
  if(existing.length)return existing[0]; // reuse the room even if its nickname changes
  const name=safeName(nickname||'直播间').replace(/[. ]+$/g,'')||'直播间';
  const dir=path.join(root,`${name}_${rid}`);
  if(fs.existsSync(dir))throw new Error('录像分类目录存在异常文件或链接');
  fs.mkdirSync(dir);
  return dir;
}

function locateHistoryFile(root,file) {
  if(typeof file!=='string')return file;
  if(fs.existsSync(path.join(root,file))||path.basename(file)!==file)return file;
  const matches=recordingDirs(root).slice(1).filter(dir=>fs.existsSync(path.join(dir,file)));
  return matches.length===1?path.relative(root,path.join(matches[0],file)).replace(/\\/g,'/'):file;
}
module.exports={roomDirectory,recordingDirs,locateHistoryFile};
