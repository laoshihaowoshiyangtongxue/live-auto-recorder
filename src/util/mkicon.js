// 运行时生成托盘图标(16x16 蓝色圆点 PNG), 免随包带图标文件
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function makeTrayIconPng() {
  const W = 16, H = 16;
  // 红色「录制中」圆点(经典REC样式), 加白色描边在深浅任务栏上都清晰
  const raw = Buffer.alloc(H * (1 + W * 4));
  const cx = 7.5, cy = 7.5, r = 5.2, ring = 6.8;
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let R = 255, G = 68, B = 68, A = 0; // 默认红 #FF4444
      if (d <= r - 1) A = 255;
      else if (d <= r + 0.5) A = Math.round((r + 0.5 - d) * 255);
      else if (d > ring - 1 && d <= ring) { R = 255; G = 255; B = 255; A = 255; } // 白描边
      else if (d > ring && d <= ring + 0.5) { R = 255; G = 255; B = 255; A = Math.round((ring + 0.5 - d) * 255); }
      const o = y * (1 + W * 4) + 1 + x * 4;
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = A;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { makeTrayIconPng };
