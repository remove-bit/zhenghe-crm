'use strict';
/**
 * 正合品牌 Logo 素材生成器（纯 Node，零依赖）
 *
 *   node assets/build-logos.js
 *
 * 从 AI 生成的白底「榫卯」图提取透明底素材：
 *   assets/logo.png            透明底 512×512（源文件）
 *   assets/logo-{256,128,64}.png
 *   assets/favicon.ico         多尺寸图标
 *   public/logo.png            供界面引用
 *   public/favicon.ico
 *   public/apple-touch-icon.png
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = __dirname;
const WEB = path.join(ASSETS, '..', 'public');
const SRC = path.join(ASSETS, 'logo-concepts', 'Professional_abstract_logo_mar_2026-11-19T08-49-20.png');

/* ---------------- PNG 基础 ---------------- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function readPNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('不是 PNG 文件: ' + file);
  let off = 8, idat = [], ihdr = null;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = {
      w: data.readUInt32BE(0), h: data.readUInt32BE(4),
      bit: data[8], color: data[9], interlace: data[12],
    };
    if (type === 'IDAT') idat.push(Buffer.from(data));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr || ihdr.bit !== 8 || ihdr.color !== 2 || ihdr.interlace !== 0) {
    throw new Error('仅支持 8 位 RGB 非交错 PNG');
  }
  const bpp = 3, stride = ihdr.w * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  if (inflated.length !== ihdr.h * (stride + 1)) throw new Error('IDAT 长度异常');
  const pixels = Buffer.alloc(ihdr.h * stride);
  let pos = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const filter = inflated[pos++];
    const scan = inflated.subarray(pos, pos + stride); pos += stride;
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = scan[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) throw new Error('未知 PNG filter: ' + filter);
      out[x] = v & 255;
    }
  }
  return { w: ihdr.w, h: ihdr.h, pixels };
}
function pngBuffer(img) {
  const { w, h, pixels } = img;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA8
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function writePNG(img, file) {
  const buf = pngBuffer(img);
  fs.writeFileSync(file, buf);
  return buf.length;
}

/* ---------------- 图像处理 ---------------- */
const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);

/** 白底 → 透明：以「饱和度」区分蓝色图形与白色背景，反预乘恢复纯前景色 */
function toTransparent(img) {
  const { w, h, pixels } = img;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    const r = pixels[j], g = pixels[j + 1], b = pixels[j + 2];
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    // 图形主体 sat≈165，背景 sat≈0；12→0 / 155→1，边缘抗锯齿平滑过渡
    let a = (sat - 12) / 143;
    a = Math.max(0, Math.min(1, a));
    const o = i * 4;
    if (a < 0.04) continue; // 透明像素保持全 0
    const inv = 1 - a;
    rgba[o] = clamp255((r - 255 * inv) / a);
    rgba[o + 1] = clamp255((g - 255 * inv) / a);
    rgba[o + 2] = clamp255((b - 255 * inv) / a);
    rgba[o + 3] = Math.round(a * 255);
  }
  return { w, h, pixels: rgba };
}

/** 裁掉透明留白，按 padding 比例补回，输出正方形 */
function cropToSquare(img, padRatio = 0.14) {
  const { w, h, pixels } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (pixels[(y * w + x) * 4 + 3] > 8) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const side = Math.ceil(Math.max(cw, ch) * (1 + padRatio * 2));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const out = Buffer.alloc(side * side * 4);
  const ox = Math.round(cx - side / 2), oy = Math.round(cy - side / 2);
  for (let y = 0; y < h; y++) {
    const dy = y - oy;
    if (dy < 0 || dy >= side) continue;
    for (let x = 0; x < w; x++) {
      const dx = x - ox;
      if (dx < 0 || dx >= side) continue;
      const si = (y * w + x) * 4, di = (dy * side + dx) * 4;
      pixels.copy(out, di, si, si + 4);
    }
  }
  console.log(`  内容边界 (${minX},${minY})-(${maxX},${maxY}) = ${cw}×${ch} → 正方形 ${side}×${side}`);
  return { w: side, h: side, pixels: out, bbox: { minX, minY, maxX, maxY } };
}

/** 双线性缩放 */
function resize(img, nw, nh) {
  const { w, h, pixels } = img;
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx = (x + 0.5) * w / nw - 0.5, sy = (y + 0.5) * h / nh - 0.5;
    const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = Math.max(0, sx - x0), fy = Math.max(0, sy - y0);
    const di = (y * nw + x) * 4;
    for (let c = 0; c < 4; c++) {
      const v00 = pixels[(y0 * w + x0) * 4 + c], v10 = pixels[(y0 * w + x1) * 4 + c];
      const v01 = pixels[(y1 * w + x0) * 4 + c], v11 = pixels[(y1 * w + x1) * 4 + c];
      out[di + c] = Math.round((v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy);
    }
  }
  return { w: nw, h: nh, pixels: out };
}

/** 写 ICO（内嵌 PNG，现代浏览器/系统通用） */
function writeICO(entries, file) {
  const dir = Buffer.alloc(6 + 16 * entries.length);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const off = 6 + 16 * i;
    const dim = e.size >= 256 ? 0 : e.size;
    dir[off] = dim; dir[off + 1] = dim;
    dir.writeUInt16LE(1, off + 4); dir.writeUInt16LE(32, off + 6);
    dir.writeUInt32LE(e.buf.length, off + 8); dir.writeUInt32LE(offset, off + 12);
    offset += e.buf.length;
  });
  fs.writeFileSync(file, Buffer.concat([dir, ...entries.map(e => e.buf)]));
}

/* ---------------- 主流程 ---------------- */
console.log('╔════════════════════════════════════════╗');
console.log('║   正合品牌 Logo 素材生成器             ║');
console.log('╚════════════════════════════════════════╝\n');

const raw = readPNG(SRC);
console.log(`源图：${raw.w}×${raw.h} RGB8`);
let logo = toTransparent(raw);
logo = cropToSquare(logo, 0.14);

console.log('\n生成素材：');
const sizes = [
  ['logo.png', 512], ['logo-256.png', 256], ['logo-128.png', 128], ['logo-64.png', 64],
];
for (const [name, size] of sizes) {
  const im = resize(logo, size, size);
  const len = writePNG(im, path.join(ASSETS, name));
  console.log(`  assets/${name}  ${size}×${size}  ${(len / 1024).toFixed(1)} KB`);
}
// 界面用主图
fs.copyFileSync(path.join(ASSETS, 'logo.png'), path.join(WEB, 'logo.png'));
console.log(`  public/logo.png  (复制自主图)`);

// favicon 多尺寸
const icoEntries = [16, 32, 48, 64].map(size => ({ size, buf: pngBuffer(resize(logo, size, size)) }));
writeICO(icoEntries, path.join(ASSETS, 'favicon.ico'));
fs.copyFileSync(path.join(ASSETS, 'favicon.ico'), path.join(WEB, 'favicon.ico'));
console.log(`  assets/favicon.ico + public/favicon.ico  16/32/48/64`);

// Apple 触摸图标
const apple = resize(logo, 180, 180);
writePNG(apple, path.join(WEB, 'apple-touch-icon.png'));
console.log(`  public/apple-touch-icon.png  180×180`);

console.log('\n✅ 全部素材生成完成');
