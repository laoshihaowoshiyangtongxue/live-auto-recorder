// 配置与持久化
const fs = require('node:fs');
const path = require('node:path');
const {writeJson}=require('../util/atomic-json');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULT = {
  watchlist: [], // [{ rid, secUid?, name?, maxSec?, titleFilter?, hours? }]
  companies: [],
  ungroupedCollapsed: false,
  settings: {
    pollIntervalSec: 3,
    outputDir: 'recordings',
    minFreeGB: 5,
    maxConcurrentRecordings: 6,
    burnDanmaku: true, // 录完自动烧录弹幕版
    keepRaw: true,     // 保留无弹幕版(关闭则烧录成功后删除, 仅存弹幕版)
    segment: '0',      // 默认整场保存, 0=不分段
    quality: 'highest', // 画质偏好: highest=最高(原画), 可降选 FULL_HD1/HD1/SD1/SD2, 无该档自动回落
    minSizeMB: 0,      // 默认保留并处理短场内容
    autoPartMerge: true, // 相邻分片自动合并(断流重连/轮换的分片无缝并回一个文件, 对齐 biliLive-tools)
    preventSleep: false, // 录制期间阻止系统休眠
    postConcurrency: 2, // 媒体处理共享上限；录制时至多2路，拉流停滞时降至1路
    segmentMin: 30,    // 旧字段, 仅向后兼容(读取时迁移到 segment)
    keepDays: 0,       // 录像保留天数(0=永久)
    webhookUrl: '',    // 事件通知(开播/录完/磁盘), POST JSON
    autoStart: false,  // 开机自启
    postQuietEnabled: false,
    postQuietStart: '23:00',
    postQuietEnd: '08:00',
  },
};

function load() {
  let c = null;
  let recovered=false;
  try {
    c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if(!c||typeof c!=='object'||Array.isArray(c))throw new Error('配置结构无效');
  } catch (e) {
    // 配置损坏: 绝不抛出(主进程一旦中断会变无窗口无托盘的僵尸), 留证后回退 .bak → 默认
    if(e.code!=='ENOENT')try { fs.renameSync(CONFIG_PATH, CONFIG_PATH + '.corrupt-' + Date.now()); } catch {}
    try { c = JSON.parse(fs.readFileSync(CONFIG_PATH + '.bak', 'utf8')); } catch { c = null; }
    if(!c||typeof c!=='object'||Array.isArray(c))c=null;
    if (!c) { save(structuredClone(DEFAULT)); return structuredClone(DEFAULT); }
    recovered=true;
  }
  const merged = {
    ...structuredClone(DEFAULT),
    ...c,
    settings: { ...DEFAULT.settings, ...(c.settings || {}) },
  };
  if(!Array.isArray(merged.watchlist))merged.watchlist=[];
  merged.watchlist=merged.watchlist.filter(w=>w&&typeof w==='object'&&!Array.isArray(w));
  merged.companies=require('./companies').normalizeCompanies(merged.companies);
  const ranges={pollIntervalSec:[1,10],minFreeGB:[0,500],maxConcurrentRecordings:[1,20],minSizeMB:[0,100000],keepDays:[0,3650]};
  for(const [key,[min,max]] of Object.entries(ranges)){
    const n=Number(merged.settings[key]);merged.settings[key]=Number.isFinite(n)?Math.max(min,Math.min(max,n)):DEFAULT.settings[key];
  }
  for(const key of ['burnDanmaku','keepRaw','autoPartMerge','preventSleep','autoStart','postQuietEnabled'])if(typeof merged.settings[key]!=='boolean')merged.settings[key]=DEFAULT.settings[key];
  const {validClock}=require('./quiet-hours');
  for(const key of ['postQuietStart','postQuietEnd'])if(!validClock(merged.settings[key]))merged.settings[key]=DEFAULT.settings[key];
  if(merged.settings.postQuietStart===merged.settings.postQuietEnd)merged.settings.postQuietEnabled=false;
  if(typeof merged.settings.outputDir!=='string'||!merged.settings.outputDir.trim()||merged.settings.outputDir.includes('\0'))merged.settings.outputDir=DEFAULT.settings.outputDir;
  // 旧配置迁移: segmentMin(数字分钟) → segment(字符串, 双模式)
  if ((c?.settings?.segment === undefined && c?.settings?.segmentMin !== undefined) || merged.settings.segment === '') {
    merged.settings.segment = String(merged.settings.segmentMin ?? DEFAULT.settings.segment);
  }
  if(!/^(0|[1-9]\d{0,4})(\.\d+)?\s*(B|KB|MB|GB)?$/i.test(String(merged.settings.segment)))merged.settings.segment=DEFAULT.settings.segment;
  // watchlist 去重收敛(历史bug曾把同一房间重复写入数千条): 按rid(或纯secUid)归一
  const before = Array.isArray(merged.watchlist) ? merged.watchlist.length : 0;
  if (before > 1) {
    const best = new Map();
    for (const w of merged.watchlist) {
      const k = String(w.rid || '') || 'sec:' + String(w.secUid || '');
      if (!k || k === 'sec:') continue;
      const cur = best.get(k);
      if (!cur) { best.set(k, w); continue; }
      // 字段级合并: 逐字段非空优先(整体 spread 会让空串覆盖有效值)
      const item = { ...cur };
      for (const f of ['rid', 'secUid', 'name', 'nickname', 'titleFilter', 'hours', 'maxSec', 'companyId']) {
        const v = item[f];
        if (v === undefined || v === '' || v === 0) {
          const nv = w[f];
          if (nv !== undefined && nv !== '' && nv !== 0) item[f] = nv;
        }
      }
      best.set(k, item);
    }
    merged.watchlist = [...best.values()];
    // 仅当去重真正减少条数时才写回: 无条件save会改mtime→热重载循环触发(读一次写一次)
    if (merged.watchlist.length !== before) {
      try { save(merged); } catch {}
    }
  }
  if(recovered){try{writeJson(CONFIG_PATH,merged,{space:2});}catch{}}
  return merged;
}

// 原子写: 先写临时文件再 rename 替换(直接 writeFileSync 崩溃/断电会留截断 JSON → 下次启动僵尸)
function save(cfg) {
  writeJson(CONFIG_PATH,cfg,{backup:true,space:2});
}

module.exports = { ROOT, CONFIG_PATH, load, save };
