// 全局常量与工具
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 抖音 enter API（页面同款参数；实际请求由热身页内 fetch 发出，自动带 Cookie/同源）
function douyinEnterUrl(rid) {
  return (
    `https://live.douyin.com/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web` +
    `&language=zh-CN&enter_from=link_share&cookie_enabled=true&screen_width=1380&screen_height=860` +
    `&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=131.0.0.0` +
    `&web_rid=${rid}&room_id_str=&enter_source=&is_need_double_stream=false`
  );
}

// 主页 sec_uid → 直播间信息接口(页面同款; 由热身页内 fetch 发出)
function douyinUserPageUrl(secUid) {
  return (
    `https://live.douyin.com/webcast/user/page/?aid=6383&app_name=douyin_web&device_platform=web` +
    `&language=zh-CN&sec_uid=${encodeURIComponent(secUid)}&web_rid=`
  );
}

// enter API 按 room_id(开播中的真实房间id)查询(页面同款; 由热身页内 fetch 发出)
function douyinEnterUrlByRoomId(roomId) {
  return (
    `https://live.douyin.com/webcast/room/web/enter/?type_id=0&live_id=1&version_code=99.9.9` +
    `&app_name=douyin_web&web_rid=&room_id_str=${roomId}&enter_source=&is_need_double_stream=false`
  );
}

function safeName(s) {
  // 单引号也要滤: ffmpeg concat 列表用单引号包路径, 主播名带 ' 会破坏合并
  return String(s).replace(/[\\/:*?"<>|'\s]+/g, '_').slice(0, 60);
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = { UA, sleep, douyinEnterUrl, douyinEnterUrlByRoomId, douyinUserPageUrl, safeName, ts };
