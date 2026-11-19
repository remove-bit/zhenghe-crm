'use strict';
/**
 * 从透明底 logo.png 生成精确矢量 SVG（纯 Node，零依赖）
 *
 *   node assets/build-svg.js
 *
 * 图形全由直角矩形构成 —— 用二维游程矩形分解把它还原成一组 <rect>，
 * 得到真正可无限缩放、可任意改色的矢量源文件。输出到 assets/logo.svg
 * 和 public/logo.svg。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = __dirname;
const WEB = path.join(ASSETS, '..', 'public');
const SRC = path.join(ASSETS, 'logo.png');

function readRGBA(file) {
  const buf = fs.readFileSync(file);
  let off = 8, idat = [], w = 0, h = 0;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(off + 8); h = buf.readUInt32BE(off + 12); }
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = (y > 0 && x >= 4) ? px[(y - 1) * stride + x - 4] : 0;
      let v = raw[pos + x];
      if (f === 1) v += a; else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      px[y * stride + x] = v & 255;
    }
    pos += stride;
  }
  return { w, h, px };
}

const { w, h, px } = readRGBA(SRC);
const at = (x, y) => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };

// 1) 聚类出两种主色（k=2，按 G 通道近似分深浅）
let deepSum = [0, 0, 0], deepN = 0, lightSum = [0, 0, 0], lightN = 0;
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const [r, g, b, a] = at(x, y);
  if (a < 200) continue;
  if (g < 90) { deepSum[0] += r; deepSum[1] += g; deepSum[2] += b; deepN++; }
  else { lightSum[0] += r; lightSum[1] += g; lightSum[2] += b; lightN++; }
}
const hex = (arr, n) => '#' + arr.map(v => Math.round(v / n).toString(16).padStart(2, '0')).join('');
const deepColor = hex(deepSum, deepN);
const lightColor = hex(lightSum, lightN);
console.log(`主色：深蓝 ${deepColor} / 亮蓝 ${lightColor}  (${deepN} / ${lightN} 像素)`);

// 2) 生成每个颜色的 mask（1=深蓝 2=亮蓝 0=透明）
const mask = new Uint8Array(w * h);
const dist2 = (r, g, b, c) => {
  const cr = parseInt(c.slice(1, 3), 16), cg = parseInt(c.slice(3, 5), 16), cb = parseInt(c.slice(5, 7), 16);
  return (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
};
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const [r, g, b, a] = at(x, y);
  if (a < 200) continue;
  mask[y * w + x] = dist2(r, g, b, deepColor) <= dist2(r, g, b, lightColor) ? 1 : 2;
}

// 3) 二维矩形贪心分解：按颜色层分别提取矩形
function decompose(target) {
  const covered = new Uint8Array(w * h);
  const rects = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (covered[idx] || mask[idx] !== target) continue;
      // 向右扩展到最长连续同色段
      let x2 = x;
      while (x2 + 1 < w && mask[y * w + (x2 + 1)] === target && !covered[y * w + (x2 + 1)]) x2++;
      // 向下扩展：整段都同色且未覆盖
      let y2 = y;
      outer: while (y2 + 1 < h) {
        for (let xx = x; xx <= x2; xx++) {
          const ni = (y2 + 1) * w + xx;
          if (mask[ni] !== target || covered[ni]) break outer;
        }
        y2++;
      }
      for (let yy = y; yy <= y2; yy++) for (let xx = x; xx <= x2; xx++) covered[yy * w + xx] = 1;
      const rw = x2 - x + 1, rh = y2 - y + 1;
      // 保留全部矩形：细长条是咬合结构的一部分，丢掉会产生 1px 裂缝
      rects.push([x, y, rw, rh]);
    }
  }
  return rects;
}
const deepRects = decompose(1);
const lightRects = decompose(2);
console.log(`矢量分解：深蓝 ${deepRects.length} 个矩形 / 亮蓝 ${lightRects.length} 个矩形`);

// 4) 输出 SVG（viewBox 用原图像素尺寸，天然等比）
const rectTags = (rects, color) => rects
  .map(([x, y, rw, rh]) => `  <rect x="${x}" y="${y}" width="${rw}" height="${rh}"/>`)
  .join('\n');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="正合 Logo">
  <title>正合 ZhengHe</title>
  <g fill="${deepColor}">
${rectTags(deepRects, deepColor)}
  </g>
  <g fill="${lightColor}">
${rectTags(lightRects, lightColor)}
  </g>
</svg>
`;
fs.writeFileSync(path.join(ASSETS, 'logo.svg'), svg);
fs.writeFileSync(path.join(WEB, 'logo.svg'), svg);
console.log(`生成 assets/logo.svg + public/logo.svg  (${(svg.length / 1024).toFixed(1)} KB)`);
console.log('\n✅ 矢量 SVG 生成完成');
