const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Windows 直接交给资源管理器，避免目录默认关联异常时弹出“选择应用”。
// 成功仅表示打开请求已提交，界面同时提供可复制的完整路径。
async function openDirectory(directory, { shell, platform = process.platform, launch = spawn, timeoutMs = 5000 } = {}) {
  const target = path.resolve(directory);
  try {
    if (!(await fs.promises.stat(target)).isDirectory()) throw new Error('目标不是目录');
    if (platform === 'win32') {
      await new Promise((resolve, reject) => {
        const child = launch(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [target], { shell: false, windowsHide: false, stdio: 'ignore' });
        const timer = setTimeout(() => reject(new Error('资源管理器响应超时')), timeoutMs);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('spawn', () => { clearTimeout(timer); child.unref(); resolve(); });
      });
    } else {
      let timer;
      try {
        const error = await Promise.race([shell.openPath(target), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('打开目录超时')), timeoutMs); })]);
        if (error) throw new Error(error);
      } finally { clearTimeout(timer); }
    }
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, path: target, error: `无法打开目录：${error.message}。目录路径：${target}` };
  }
}
module.exports = { openDirectory };
