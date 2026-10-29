// Run against the current DOM, even while a remote page is still loading.
// Electron executeJavaScript may wait indefinitely for did-finish-load.
const owned = new WeakSet();
function attachEvaluation(wc){if(!wc.debugger.isAttached()){wc.debugger.attach('1.3');owned.add(wc);}}
async function evaluateNow(wc, expression, timeoutMs = 5000) {
  if (wc.isDestroyed()) throw new Error('采集页面已关闭');
  attachEvaluation(wc);
  let timer;
  try {
    const result = await Promise.race([
      wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('采集页面脚本执行超时')), timeoutMs); }),
    ]);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '采集脚本执行失败');
    return result.result?.value;
  } catch (e) {
    // Cancel our outstanding protocol request before a later retry.
    if (e.message === '采集页面脚本执行超时') releaseEvaluation(wc);
    throw e;
  } finally { clearTimeout(timer); }
}
function releaseEvaluation(wc) {
  if (!owned.has(wc)) return;
  owned.delete(wc);
  try { if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
}
module.exports = { evaluateNow, releaseEvaluation, attachEvaluation };
