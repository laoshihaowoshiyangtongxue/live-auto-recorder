const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
function writeJson(file,value,{backup=false,space=0}={}){
  const tmp=file+'.tmp-'+process.pid+'-'+randomUUID();
  try{
    fs.writeFileSync(tmp,JSON.stringify(value,null,space));
    if(backup&&fs.existsSync(file))fs.copyFileSync(file,file+'.bak');
    fs.renameSync(tmp,file);
  }finally{try{fs.unlinkSync(tmp);}catch{}}
}
module.exports={writeJson};
