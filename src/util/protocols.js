// 协议处理: 注册为抖音系自定义协议的处理器(注册表 HKCU, 无需管理员)
// 目的: 隐藏监控页会触发 douyin:// 等深链, 系统无处理器时会弹"选择应用"窗;
// 注册到本应用后由单实例转发 + second-instance 静默吞掉, 不弹窗不抢焦点。
// 注意: 运行期间占用注册, 应用退出时注销(unregisterProtocolHandlers), 不永久抢占系统协议关联。
const { app, protocol } = require('electron');
const log = require('../util/log');


// Pages can trigger external schemes in subframes and server redirects.
// Keep the block inside this app; do not claim the user's Windows association.
function isAllowedNavigation(url){
  try{return ['http:','https:','file:','about:'].includes(new URL(String(url)).protocol);}
  catch{return false;}
}
function installNavigationGuards(wc){
  if(wc.__lrNavigationGuards)return;wc.__lrNavigationGuards=true;
  const guard=(event,url)=>{if(!isAllowedNavigation(event?.url||url))event.preventDefault();};
  wc.on('will-frame-navigate',guard);
  wc.on('will-redirect',guard);
  wc.setWindowOpenHandler(details=>({action:isAllowedNavigation(details.url)&&/^https?:/i.test(details.url)?'allow':'deny'}));
}
function installInternalProtocolGuards(){
  try{
    if(!protocol.isProtocolHandled('bytedance'))protocol.handle('bytedance',()=>new Response(null,{status:204}));
  }catch(e){log.error('[proto] bytedance 应用内拦截失败:',e.message);}
}

// 声明由本应用处理的抖音系自定义协议(渲染进程内注册 + 注册表双保险)
const PROTOCOLS = ['douyin', 'snssdk1128', 'snssdk1233', 'aweme', 'bitbrowser', 'livepartner'];

function registerProtocolHandlers() {
  for (const p of PROTOCOLS) {
    try {
      // 显式指定可执行文件+应用路径, 保证唤起路由到本应用(单实例锁会转发到运行中的实例)
      app.setAsDefaultProtocolClient(p, process.execPath, [app.getAppPath()]);
    } catch (e) {
      log.warn(`[proto] 注册 ${p}:// 失败:`, e.message);
    }
  }
  log.info('[proto] 已注册抖音系协议处理器:', PROTOCOLS.join(', '));
}

// 退出时注销: 恢复系统原有协议关联(不残留 HKCU 抢占, 否则官方抖音客户端永远收不到唤起)
function unregisterProtocolHandlers() {
  for (const p of PROTOCOLS) {
    try {
      app.removeAsDefaultProtocolClient(p, process.execPath, [app.getAppPath()]);
    } catch {}
  }
  log.info('[proto] 已注销协议处理器(系统协议关联已还原)');
}

// second-instance 参数是否为深链唤起(而非用户正常双击快捷方式)
function isProtocolInvocation(argv) {
  return (argv || []).some((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(String(a)) && !/^file:/i.test(String(a)));
}

// 收到协议唤起时: 记日志并静默忽略(不开任何窗口)
function ignoreProtocolOpen() {
  app.on('open-url', (e) => {
    e.preventDefault();
    log.info('[proto] 拦截协议唤起(已忽略)');
  });
}

module.exports = { registerProtocolHandlers, unregisterProtocolHandlers, isProtocolInvocation, ignoreProtocolOpen, installNavigationGuards, installInternalProtocolGuards, isAllowedNavigation };
