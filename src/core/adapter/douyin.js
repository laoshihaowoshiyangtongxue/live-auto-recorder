// 抖音平台适配层：enter API 响应 → 统一房间信息
const TIER_RANK = ['_origin', 'FULL_HD1', 'FULL_HD', 'BD', 'UHD', 'HD1', 'SD1', 'SD2'];

function tierScore(key, url) {
  let s = TIER_RANK.indexOf(key);
  if (s < 0) return 99;
  if (/_or/.test(url)) s -= 1; // 原画流优先
  return s;
}

function pickBestFlv(flv) {
  const keys = Object.keys(flv || {});
  if (!keys.length) return '';
  keys.sort((a, b) => tierScore(a, flv[a]) - tierScore(b, flv[b]));
  return flv[keys[0]] || '';
}

// 画质偏好选择(对齐 biliLive-tools quality: "highest"): prefer 档不存在时自动向下回落
const PREFER_RANK = ['FULL_HD1', 'HD1', 'SD1', 'SD2'];
function pickFlv(flv, prefer) {
  const keys = Object.keys(flv || {});
  if (!keys.length) return '';
  if (prefer && prefer !== 'highest') {
    let i = PREFER_RANK.indexOf(prefer);
    for (; i >= 0 && i < PREFER_RANK.length; i++) {
      if (keys.includes(PREFER_RANK[i])) return flv[PREFER_RANK[i]];
    }
  }
  return pickBestFlv(flv);
}

// 统一房间信息: { platform, rid, live, status, title, nickname, flv{档位:url}, hls, best }
function normalizeEnter(json, rid) {
  const d0 = json?.data?.data?.[0] || {};
  const su = d0.stream_url || {};
  const flv = { ...(su.flv_pull_url || {}) };
  return {
    platform: 'douyin',
    rid,
    live: d0.status === 2,
    status: d0.status,
    title: d0.title || '',
    nickname: d0?.owner?.nickname || '',
    secUid: d0?.owner?.sec_uid || json?.data?.user?.sec_uid || '',
    flv,
    hls: su.hls_pull_url || '',
    best: pickBestFlv(flv),
  };
}

module.exports = { normalizeEnter, pickBestFlv, pickFlv };
