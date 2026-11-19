'use strict';
/**
 * 正合CRM 产品打包脚本（零 npm 依赖）
 *
 *   node build.js          生成 Windows 绿色便携包 zip
 *
 * 产物：
 *   dist/正合CRM-便携版-v1.0.0.zip
 *     ├── 启动CRM.vbs      ← 用户双击这个
 *     ├── node.exe          ← 自带 Node 运行时
 *     ├── app\              ← 应用代码
 *     └── 使用说明.txt
 *
 * 首次运行会从 nodejs.org 下载官方 node.exe（约 33MB），之后复用缓存。
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
const BUILD_DIR = path.join(ROOT, 'build');
const DIST_DIR = path.join(ROOT, 'dist');
const NODE_CACHE = path.join(BUILD_DIR, 'node.exe');
const NODE_VERSION = 'v22.14.0';
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;
const VERSION = require(path.join(ROOT, 'package.json')).version;
const OUT_ZIP = path.join(DIST_DIR, `正合CRM-便携版-v${VERSION}.zip`);

/* ---------- ZIP（复用 backup.js 的 writer，这里内联一份避免耦合） ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    chunks.push(local, data);
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

/* ---------- 下载官方 node.exe（复用已下载 zip 若存在） ---------- */
async function ensureNode() {
  if (fs.existsSync(NODE_CACHE)) {
    console.log('  ✓ 复用缓存的 node.exe');
    return fs.readFileSync(NODE_CACHE);
  }
  // 优先用 .build 里已下载的 zip
  const existingZip = path.join(ROOT, '.build', 'node-official.zip');
  if (fs.existsSync(existingZip)) {
    console.log('  · 从已下载的 zip 提取 node.exe');
    return extractNodeFromZip(fs.readFileSync(existingZip));
  }
  console.log('  · 从 nodejs.org 下载 Node ' + NODE_VERSION + '（约 33MB，首次需要）...');
  const buf = await download(NODE_URL);
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(path.join(BUILD_DIR, 'node-official.zip'), buf);
  return extractNodeFromZip(buf);
}
function download(url, redirects = 0) {
  if (redirects > 5) throw new Error('重定向过多');
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'zhenghe-crm-build' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        chunks.push(c); size += c.length;
        process.stdout.write(`\r    ${(size / 1048576).toFixed(1)} MB`);
      });
      res.on('end', () => { process.stdout.write('\n'); resolve(Buffer.concat(chunks)); });
    }).on('error', reject);
  });
}
function extractNodeFromZip(zipBuf) {
  // 解析 ZIP central directory 找到 node.exe
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无效的 zip');
  const count = zipBuf.readUInt16LE(eocd + 10);
  let pos = zipBuf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(pos + 10);
    const compSize = zipBuf.readUInt32LE(pos + 20);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localOff = zipBuf.readUInt32LE(pos + 42);
    const name = zipBuf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    if (name.endsWith('/node.exe')) {
      const lNameLen = zipBuf.readUInt16LE(localOff + 26);
      const lExtraLen = zipBuf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = zipBuf.slice(dataStart, dataStart + compSize);
      const nodeExe = method === 0 ? comp : zlib.inflateRawSync(comp);
      fs.mkdirSync(BUILD_DIR, { recursive: true });
      fs.writeFileSync(NODE_CACHE, nodeExe);
      console.log('  ✓ 提取 node.exe（' + (nodeExe.length / 1048576).toFixed(1) + ' MB）');
      return nodeExe;
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('zip 中未找到 node.exe');
}

/* ---------- 主流程 ---------- */
async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  正合CRM 便携版打包工具              ║');
  console.log('╚══════════════════════════════════════╝\n');
  fs.mkdirSync(DIST_DIR, { recursive: true });

  console.log('[1/4] 准备 Node 运行时');
  const nodeExe = await ensureNode();

  console.log('[2/4] 收集应用文件');
  const files = [];
  const add = (diskPath, zipName) => {
    files.push({ name: zipName, data: fs.readFileSync(diskPath) });
    console.log('  + ' + zipName);
  };
  add(path.join(BUILD_DIR, '启动CRM.vbs'), '启动CRM.vbs');
  // node.exe 单独在此加入
  files.push({ name: 'node.exe', data: nodeExe });
  console.log('  + node.exe');
  add(path.join(ROOT, 'server.js'), 'app/server.js');
  add(path.join(ROOT, 'db.js'), 'app/db.js');
  // 自动收集 public/ 下全部静态资源（含 logo、favicon 等，避免新增文件遗漏）
  const publicDir = path.join(ROOT, 'public');
  for (const name of fs.readdirSync(publicDir)) {
    const disk = path.join(publicDir, name);
    if (fs.statSync(disk).isFile()) add(disk, 'app/public/' + name);
  }

  const readme = `正合CRM 便携版 v${VERSION}
===============================

【使用方法】
1. 把本压缩包解压到任意文件夹（建议不要放在 C:\Program Files）
2. 双击「启动CRM.vbs」
3. 浏览器会自动打开 http://localhost:3000
4. 默认账号 admin / 密码 admin123

【完全退出】
按 Ctrl+Alt+Delete 打开任务管理器，结束「Windows Script Host」和「Node.js」进程；
或重启电脑。数据库保存在 app\\data 文件夹，删除它即可重置系统。

【数据备份】
直接复制 app\\data 整个文件夹即可备份。

【注意事项】
· 首次启动会自动创建数据库并填入演示数据
· 首次运行时 Windows 防火墙可能弹出提示，请选择「允许访问」
· 本软件自带 Node.js 运行时，无需在电脑上安装任何东西
· 端口默认是 3000，如被占用请编辑启动CRM.vbs 中的 port 变量

【正合产品系列】
正合CRM —— 客户关系管理（当前产品）
正合SRM —— 供应商管理（规划中）
正合OA  —— 协同办公（规划中）
理念：不多不少，正合所需

【开源协议】MIT —— 自由使用
项目地址：https://github.com/remove-bit/zhenghe-crm
`;
  files.push({ name: '使用说明.txt', data: Buffer.from(readme, 'utf8') });
  console.log('  + 使用说明.txt');

  console.log('[3/4] 打包 zip');
  const zip = makeZip(files);
  fs.writeFileSync(OUT_ZIP, zip);

  console.log('[4/4] 完成');
  console.log('  产物: ' + OUT_ZIP);
  console.log('  大小: ' + (zip.length / 1048576).toFixed(1) + ' MB');
  console.log('  共 ' + files.length + ' 个文件\n');
}

main().catch(e => { console.error('打包失败:', e); process.exitCode = 1; });
