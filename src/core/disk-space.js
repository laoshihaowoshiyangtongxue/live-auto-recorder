const fs=require('node:fs');
class DiskSpaceError extends Error{
  constructor(message){super(message);this.code='LR_DISK_SPACE';}
}
function freeBytes(dir){try{const s=fs.statfsSync(dir);return Number(s.bsize)*Number(s.bavail);}catch{return 0;}}
function assertSpace(dir,reserve,extra=0,phase='处理',available){
  const free=available?available():freeBytes(dir);
  const needed=Math.max(16*1024**2,Number(reserve)||0)+Math.max(0,Number(extra)||0);
  if(free<needed)throw new DiskSpaceError(`${phase}等待磁盘空间：可用${(free/1024**3).toFixed(2)}GB，需要约${(needed/1024**3).toFixed(2)}GB；源文件已保留`);
}
module.exports={DiskSpaceError,assertSpace,freeBytes};
