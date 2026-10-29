const {evaluateNow,attachEvaluation}=require('./page-eval');
const log=require('../util/log');
const SCRIPT=`(()=>{if(window.__lrNoVideo)return;window.__lrNoVideo=true;HTMLMediaElement.prototype.play=function(){this.pause();return Promise.resolve();};document.addEventListener('play',e=>{if(e.target instanceof HTMLMediaElement)e.target.pause();},true);document.querySelectorAll('video,audio').forEach(e=>{e.pause();e.removeAttribute('src');e.srcObject=null;e.load();});})()`;
async function guardBackgroundPage(win){
  const wc=win.webContents;if(!wc?.on||!wc.debugger)return;
  if(!wc.getURL()){let timer;try{await Promise.race([win.loadURL('about:blank'),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('后台空白页初始化超时')),5000))]);}catch(error){log.warn('[background]',error.message);}finally{clearTimeout(timer);}}
  wc.setAudioMuted(true);let installing=false,closed=false,injected=false;
  const command=async(method,params)=>{let timer;try{return await Promise.race([wc.debugger.sendCommand(method,params),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('后台限制安装超时')),3000))]);}finally{clearTimeout(timer);}};
  const apply=async()=>{if(closed||installing||win.isDestroyed())return;installing=true;
    try{attachEvaluation(wc);if(!injected){await command('Page.addScriptToEvaluateOnNewDocument',{source:SCRIPT});injected=true;}await command('Network.enable');await command('Network.setBlockedURLs',{urls:['*://pull-*/*','*.flv*','*.m3u8*','*.m4s*']});if(wc.getURL()&&wc.getURL()!=='about:blank')await evaluateNow(wc,SCRIPT,5000);}
    catch(error){if(!closed&&!win.isDestroyed())log.warn('[background] 媒体限制暂未安装:',error.message);}finally{installing=false;}};
  wc.on('did-finish-load',apply);wc.on('media-started-playing',()=>{if(!closed)evaluateNow(wc,SCRIPT,5000).catch(()=>{});});
  wc.debugger.on?.('detach',()=>{injected=false;if(!closed){const timer=setTimeout(apply,500);timer.unref?.();}});
  win.once('closed',()=>{closed=true;});return apply();
}
module.exports={guardBackgroundPage};
