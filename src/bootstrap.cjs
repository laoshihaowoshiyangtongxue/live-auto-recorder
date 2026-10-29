const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
// Capture native/V8 stderr at process creation; JavaScript error handlers cannot
// intercept a fatal heap failure. The short-lived launcher exits after spawn.
function launchLogged(root,executable,argv=[],launch=spawn){
  const directory=path.join(root,'logs','startup');fs.mkdirSync(directory,{recursive:true});
  const logFile=path.join(directory,'main-'+Date.now()+'-'+process.pid+'.log'),fd=fs.openSync(logFile,'a');
  let child;
  try{child=launch(executable,[root,...argv],{cwd:root,env:{...process.env,LR_STDIO_CHILD:'1'},detached:true,windowsHide:false,stdio:['ignore',fd,fd]});}
  catch(error){fs.closeSync(fd);throw error;}
  child.once('spawn',()=>{try{fs.writeSync(fd,new Date().toISOString()+' main pid='+child.pid+'\n');}finally{fs.closeSync(fd);}});
  child.once('error',()=>{try{fs.closeSync(fd);}catch{}});child.unref();return {child,logFile};
}
function launchScheduled(root,launch=spawn){
  const marker=JSON.parse(fs.readFileSync(path.join(root,'logs','lifecycle','independent-start.json'),'utf8'));
  if(marker.taskName!=='LiveRecorder-Independent-Start'||path.resolve(marker.root)!==path.resolve(root))throw Error('独立启动配置无效');
  const child=launch('schtasks.exe',['/Run','/TN',marker.taskName],{cwd:root,windowsHide:true,stdio:'ignore'});
  return {child};
}
// Electron's application loader keeps require.main pointing at its own loader.
if(require.main===module||(process.versions.electron&&process.type==='browser'&&require('electron').app.getAppPath()===path.resolve(__dirname,'..'))){
  if(process.env.LR_STDIO_CHILD==='1')require('./main.js');
  else{
    const {app,dialog}=require('electron');
    app.whenReady().then(()=>{try{const root=path.join(__dirname,'..'),argv=process.argv.slice(2),protocolCall=argv.some(a=>/^[a-z][a-z0-9+.-]*:\/\//i.test(String(a))&&!/^file:/i.test(String(a))),independent=process.platform==='win32'&&!protocolCall&&fs.existsSync(path.join(root,'logs','lifecycle','independent-start.json'));if(independent&&!app.requestSingleInstanceLock()){app.exit(0);return;}if(independent)app.releaseSingleInstanceLock();const {child}=independent?launchScheduled(root):launchLogged(root,process.execPath,argv);if(independent)child.once('exit',code=>{if(code===0)app.exit(0);else{dialog.showErrorBox('直播自动录制启动失败','独立启动任务未能运行，请检查任务计划程序。');app.exit(1);}});else child.once('spawn',()=>app.exit(0));child.once('error',error=>{dialog.showErrorBox('直播自动录制启动失败',error.message);app.exit(1);});}catch(error){dialog.showErrorBox('直播自动录制启动失败',error.message);app.exit(1);}});
  }
}
module.exports={launchLogged,launchScheduled};
