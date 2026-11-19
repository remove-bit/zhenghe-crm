'use strict';
/**
 * zero-crm 零依赖备份脚本
 *
 * 用法：
 *   node backup.js                 备份到 data/backups/，并打包成 zip
 *   node backup.js --dir D:\bak    指定输出目录
 *   node backup.js --keep 5        只保留最近 5 份备份（默认 10，0=不清理）
 *   node backup.js --no-zip        只复制数据库文件，不打包
 *
 * 做了什么：
 *   1. 对数据库执行 WAL checkpoint(TRUNCATE)，把 WAL 归并进主文件
 *   2. 复制 crm.db（含一份校验信息）到备份目录
 *   3. 打包成 zip（内含 crm.db + secret + 备份说明），自实现 ZIP，零依赖
 *   4. 按 --keep 清理旧备份
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = process.env.CRM_DB || path.join(DATA_DIR, 'crm.db');
const SECRET_PATH = path.join(DATA_DIR, 'secret');

/* ---------------- 参数解析 ---------------- */
function parseArgs(argv) {
  const out = { dir: path.join(DATA_DIR, 'backups'), keep: 10, zip: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir' && argv[i + 1]) out.dir = path.resolve(argv[++i]);
    else if (a === '--keep' && argv[i + 1]) out.keep = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--no-zip') out.zip = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/* ---------------- CRC32（ZIP 需要） ---------------- */
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

/* ---------------- 最小 ZIP writer（store 模式，零依赖） ---------------- */
function makeZip(files) {
  // files: [{ name, data: Buffer }]
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
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
    cd.writeUInt16LE(0x0800, 8); // UTF-8 文件名标志
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

/* ---------------- 备份主流程 ---------------- */
function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backup() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
zero-crm 备份工具（零依赖）

  node backup.js                 备份到 data/backups/ 并打包 zip
  node backup.js --dir D:\\bak    指定输出目录
  node backup.js --keep 5        保留最近 5 份（默认 10，0=不清理）
  node backup.js --no-zip        只复制数据库文件
`);
    return;
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error('✕ 数据库不存在：' + DB_PATH + '\n  请先运行 node server.js 启动一次系统。');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(args.dir, { recursive: true });
  const ts = stamp();
  console.log('▶ 开始备份 ' + ts);

  // 1. WAL checkpoint —— 把 WAL 归并进主 db，保证单文件完整
  try {
    const db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('  ✓ WAL 已归并');
  } catch (e) {
    console.log('  ! WAL 归并跳过（数据库可能正被占用）: ' + e.message);
  }

  // 2. 读取数据库与密钥
  const dbBuf = fs.readFileSync(DB_PATH);
  const files = [{ name: 'crm.db', data: dbBuf }];
  if (fs.existsSync(SECRET_PATH)) files.push({ name: 'secret', data: fs.readFileSync(SECRET_PATH) });

  // 3. 写出备份
  const note = [
    'zero-crm 数据库备份',
    '备份时间: ' + new Date().toLocaleString('zh-CN'),
    '包含文件: ' + files.map(f => f.name).join(', '),
    '',
    '恢复方法:',
    '1. 停止 CRM 服务',
    '2. 将 crm.db（及 secret）复制到项目的 data/ 目录',
    '3. 重新启动 node server.js',
  ].join('\n');
  files.push({ name: '备份说明.txt', data: Buffer.from(note, 'utf8') });

  const outFile = path.join(args.dir, `zero-crm-${ts}${args.zip ? '.zip' : '.db'}`);
  if (args.zip) {
    fs.writeFileSync(outFile, makeZip(files));
  } else {
    fs.copyFileSync(DB_PATH, outFile);
  }
  console.log('  ✓ 已生成 ' + outFile + '（' + (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB）');

  // 4. 清理旧备份
  if (args.keep > 0) {
    const all = fs.readdirSync(args.dir)
      .filter(n => /^zero-crm-.*\.(zip|db)$/.test(n))
      .map(n => ({ n, t: fs.statSync(path.join(args.dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of all.slice(args.keep)) {
      fs.unlinkSync(path.join(args.dir, old.n));
      console.log('  · 清理旧备份 ' + old.n);
    }
  }
  console.log('✓ 备份完成\n');
  return outFile;
}

if (require.main === module) backup();
module.exports = { backup, makeZip, crc32 };
