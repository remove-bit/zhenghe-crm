'use strict';
/**
 * zero-crm —— 中小企业开箱即用 CRM
 * 零依赖：仅使用 Node.js 22 内置模块（http / crypto / fs / path / node:sqlite）
 *
 * 启动：node server.js      然后访问 http://localhost:3000
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hashPassword, verifyPassword, audit, now, iso, STAGE_INFO } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

/* session 密钥：持久化到 data/secret，重启不掉登录 */
const SECRET_PATH = path.join(__dirname, 'data', 'secret');
let SECRET;
if (process.env.CRM_SECRET) {
  SECRET = process.env.CRM_SECRET;
} else if (fs.existsSync(SECRET_PATH)) {
  SECRET = fs.readFileSync(SECRET_PATH, 'utf8');
} else {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, SECRET, { mode: 0o600 });
}

/* ---------------- 工具函数 ---------------- */
function send(res, code, data, type = 'application/json; charset=utf-8') {
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}
function ok(res, data) { send(res, 200, { ok: true, data }); }
function fail(res, code, msg) { send(res, code, { ok: false, error: msg }); }
function body(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 5e6) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function signToken(userId) {
  const payload = Buffer.from(String(userId)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    return Number(Buffer.from(payload, 'base64url').toString());
  } catch { return null; }
}
function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const id = verifyToken(cookies.crm_token);
  if (!id) return null;
  const user = db.prepare('SELECT id,username,display_name,role,active FROM users WHERE id=?').get(id);
  return user && user.active ? user : null;
}
function isManager(u) { return u && (u.role === 'admin' || u.role === 'manager'); }

/* 数据范围过滤：sales 只看自己负责的；manager/admin 看全部 */
function scopeClause(user, alias = '') {
  const p = alias ? alias + '.' : '';
  if (isManager(user)) return { sql: '', args: [] };
  return { sql: ` AND ${p}owner_id=?`, args: [user.id] };
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, '禁止访问');
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return fail(res, 404, '页面不存在');
        send(res, 200, html, MIME['.html']);
      });
      return;
    }
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

/* ---------------- 通用 CRUD 工厂 ---------------- */
const TABLES = {
  customers: {
    fields: ['name', 'company', 'industry', 'phone', 'email', 'address', 'level', 'source', 'tags', 'note', 'owner_id'],
    required: ['name'],
    searchable: ['name', 'company', 'contact', 'phone', 'email', 'tags'],
    defaultOwner: true,
  },
  contacts: { fields: ['customer_id', 'name', 'title', 'phone', 'mobile', 'email', 'note', 'is_primary'] },
  leads: { fields: ['name', 'company', 'phone', 'email', 'source', 'status', 'note', 'owner_id'], defaultOwner: true },
  opportunities: {
    fields: ['title', 'customer_id', 'amount', 'stage', 'probability', 'expected_date', 'owner_id', 'note'],
    searchable: ['title', 'company'], defaultOwner: true,
  },
  activities: { fields: ['type', 'subject', 'content', 'customer_id', 'opportunity_id', 'activity_date', 'owner_id'] },
  tasks: { fields: ['title', 'description', 'due_date', 'priority', 'status', 'customer_id', 'owner_id'] },
};

function listRecords(res, user, table, query) {
  const cfg = TABLES[table];
  const where = [];
  const args = [];
  const sc = scopeClause(user, '');
  if (sc.sql) { where.push(sc.sql.replace(/^ AND /, '')); args.push(...sc.args); }

  if (query.q && cfg.searchable) {
    const like = `%${query.q}%`;
    const parts = [];
    for (const f of cfg.searchable) {
      if (f === 'contact') {
        parts.push('id IN (SELECT customer_id FROM contacts WHERE name LIKE ?)');
        args.push(like);
      } else if (f === 'company' && table === 'opportunities') {
        parts.push('customer_id IN (SELECT id FROM customers WHERE company LIKE ?)');
        args.push(like);
      } else {
        parts.push(`(${f} LIKE ?)`);
        args.push(like);
      }
    }
    where.push('(' + parts.join(' OR ') + ')');
  }
  if (query.stage) { where.push('stage=?'); args.push(query.stage); }
  if (query.status) { where.push('status=?'); args.push(query.status); }
  if (query.customer_id) { where.push('customer_id=?'); args.push(query.customer_id); }
  if (query.owner_id && isManager(user)) { where.push('owner_id=?'); args.push(query.owner_id); }
  if (query.due === 'today') { where.push('date(due_date)=date("now")'); }
  if (query.due === 'overdue') { where.push('due_date < date("now") AND status="pending"'); }
  if (query.type) { where.push('type=?'); args.push(query.type); }

  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const sortMap = {
    customers: 'updated_at DESC', contacts: 'created_at DESC', leads: 'created_at DESC',
    opportunities: 'updated_at DESC', activities: 'activity_date DESC', tasks: 'due_date ASC',
  };
  let order = 'id DESC';
  if (sortMap[table]) order = sortMap[table];
  if (query.sort && /^[a-z_]+ (asc|desc)$/i.test(query.sort)) order = query.sort;

  const limit = Math.min(Number(query.limit || 500), 2000);
  const offset = Math.max(Number(query.offset || 0), 0);
  const rows = db.prepare(`SELECT * FROM ${table}${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${w}`).get(...args).n;
  ok(res, { rows, total, limit, offset });
}

function getRecord(res, user, table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (!row) return fail(res, 404, '记录不存在');
  if (!isManager(user) && row.owner_id && row.owner_id !== user.id) return fail(res, 403, '无权访问该记录');
  ok(res, row);
}

function createRecord(res, user, table, data) {
  const cfg = TABLES[table];
  for (const f of cfg.required || []) {
    if (!data[f] || !String(data[f]).trim()) return fail(res, 400, `${f} 不能为空`);
  }
  const fields = [...cfg.fields];
  if (cfg.defaultOwner && !data.owner_id) {
    data.owner_id = user.id;
    if (!fields.includes('owner_id')) fields.push('owner_id');
  }
  // 只允许本人或经理指定负责人
  if (data.owner_id && !isManager(user) && Number(data.owner_id) !== user.id) {
    return fail(res, 403, '无权为他人创建记录');
  }
  const values = [];
  const nowStr = now();
  for (const f of fields) {
    let v = data[f];
    if (table === 'activities' && f === 'activity_date' && (v === undefined || v === '')) v = nowStr;
    if (v === undefined || v === '') v = (f === 'amount' || f === 'probability') ? 0 : (f === 'is_primary' ? 0 : null);
    if ((f === 'amount' || f === 'probability') && v !== null) v = Number(v);
    values.push(v);
  }
  let sql;
  if (table === 'customers' || table === 'opportunities') {
    fields.push('created_at', 'updated_at');
    values.push(nowStr, nowStr);
  } else if (table === 'activities') {
    fields.push('created_at');
    values.push(nowStr);
  } else {
    fields.push('created_at');
    values.push(nowStr);
  }
  const placeholders = fields.map(() => '?').join(',');
  const r = db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${placeholders})`).run(...values);
  audit(user, 'create', table, `新建 ${data.name || data.title || data.subject || ('#' + r.lastInsertRowid)}`);
  ok(res, { id: Number(r.lastInsertRowid) });
}

function updateRecord(res, user, table, id, data) {
  const cfg = TABLES[table];
  const existing = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (!existing) return fail(res, 404, '记录不存在');
  if (!isManager(user) && existing.owner_id && existing.owner_id !== user.id) return fail(res, 403, '无权修改该记录');
  if (data.owner_id && !isManager(user) && Number(data.owner_id) !== user.id) return fail(res, 403, '无权变更负责人');
  const sets = [];
  const args = [];
  for (const f of cfg.fields) {
    if (!(f in data)) continue;
    let v = data[f];
    if (v === '') v = (f === 'amount' || f === 'probability') ? 0 : null;
    if ((f === 'amount' || f === 'probability') && v !== null) v = Number(v);
    sets.push(`${f}=?`);
    args.push(v);
  }
  if (table === 'customers' || table === 'opportunities') { sets.push('updated_at=?'); args.push(now()); }
  if (!sets.length) return ok(res, { changes: 0 });
  args.push(id);
  const r = db.prepare(`UPDATE ${table} SET ${sets.join(',')} WHERE id=?`).run(...args);
  audit(user, 'update', table, `更新 ${existing.name || existing.title || existing.subject || ('#' + id)}`);
  ok(res, { changes: r.changes });
}

function deleteRecord(res, user, table, id) {
  const existing = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (!existing) return fail(res, 404, '记录不存在');
  if (!isManager(user) && existing.owner_id && existing.owner_id !== user.id) return fail(res, 403, '无权删除该记录');
  db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  audit(user, 'delete', table, `删除 #${id}`);
  ok(res, { changes: 1 });
}

/* ---------------- 统计报表 ---------------- */
function statsOverview(user) {
  const sc = scopeClause(user, '');
  const ownerFilter = (alias) => isManager(user) ? '' : ` WHERE ${alias}owner_id=${user.id}`;
  const cWhere = isManager(user) ? '' : ' WHERE owner_id=' + user.id;
  const oWhere = isManager(user) ? '' : ' WHERE owner_id=' + user.id;

  const customers = db.prepare(`SELECT COUNT(*) n FROM customers${cWhere}`).get().n;
  const newCustomers = db.prepare(`SELECT COUNT(*) n FROM customers${cWhere ? cWhere + ' AND' : ' WHERE'} created_at >= date('now','start of month')`).get().n;
  const leads = db.prepare(`SELECT COUNT(*) n FROM leads${isManager(user) ? '' : ' WHERE owner_id=' + user.id}`).get().n;
  const activeOpps = db.prepare(`SELECT COUNT(*) n FROM opportunities${oWhere ? oWhere + ' AND' : ' WHERE'} stage NOT IN ('won','lost')`).get().n;
  const wonOpps = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM opportunities${oWhere ? oWhere + ' AND' : ' WHERE'} stage='won'`).get();
  const pipeline = db.prepare(`SELECT COALESCE(SUM(amount*probability/100.0),0) amt, COALESCE(SUM(amount),0) total FROM opportunities${oWhere ? oWhere + ' AND' : ' WHERE'} stage NOT IN ('won','lost')`).get();
  const activities = db.prepare(`SELECT COUNT(*) n FROM activities${isManager(user) ? '' : ' WHERE owner_id=' + user.id}`).get().n;
  const monthActivities = db.prepare(`SELECT COUNT(*) n FROM activities${isManager(user) ? ' WHERE' : ' WHERE owner_id=' + user.id + ' AND'} activity_date >= date('now','start of month')`).get().n;
  const pendingTasks = db.prepare(`SELECT COUNT(*) n FROM tasks${isManager(user) ? ' WHERE' : ' WHERE owner_id=' + user.id + ' AND'} status='pending'`).get().n;
  const overdueTasks = db.prepare(`SELECT COUNT(*) n FROM tasks${isManager(user) ? ' WHERE' : ' WHERE owner_id=' + user.id + ' AND'} status='pending' AND due_date < date('now')`).get().n;

  return {
    customers, newCustomers, leads, activeOpps,
    wonCount: wonOpps.n, wonAmount: wonOpps.amt,
    pipeline: Math.round(pipeline.amt), pipelineTotal: pipeline.total,
    activities, monthActivities, pendingTasks, overdueTasks,
  };
}

function statsFunnel(user) {
  const where = isManager(user) ? '' : ' WHERE owner_id=' + user.id;
  const rows = db.prepare(`SELECT stage, COUNT(*) cnt, COALESCE(SUM(amount),0) amt FROM opportunities${where} GROUP BY stage`).all();
  const map = Object.fromEntries(rows.map(r => [r.stage, r]));
  return ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'].map(s => ({
    stage: s, label: STAGE_INFO[s].label,
    count: map[s] ? map[s].cnt : 0,
    amount: map[s] ? map[s].amt : 0,
  }));
}

function statsSales(user) {
  const rows = db.prepare(`
    SELECT u.id, u.display_name, u.role,
      COUNT(o.id) opp_count,
      SUM(CASE WHEN o.stage='won' THEN 1 ELSE 0 END) won_count,
      COALESCE(SUM(CASE WHEN o.stage='won' THEN o.amount ELSE 0 END),0) won_amount,
      COALESCE(SUM(CASE WHEN o.stage NOT IN ('won','lost') THEN o.amount*o.probability/100.0 ELSE 0 END),0) pipeline
    FROM users u LEFT JOIN opportunities o ON o.owner_id=u.id
    WHERE u.active=1
    GROUP BY u.id ORDER BY won_amount DESC
  `).all();
  return isManager(user) ? rows : rows.filter(r => r.id === user.id);
}

function statsTrend(user) {
  const where = isManager(user) ? '' : ' WHERE owner_id=' + user.id;
  const rows = db.prepare(`
    SELECT substr(created_at,1,7) ym, COUNT(*) cnt,
      SUM(CASE WHEN stage='won' THEN amount ELSE 0 END) amt
    FROM opportunities${where}
    GROUP BY ym ORDER BY ym DESC LIMIT 6
  `).all().reverse();
  return rows;
}

/* ---------------- CSV 工具 ---------------- */
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else {
      if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field || row.length) { row.push(field.trim()); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}

/* ---------------- 路由 ---------------- */
async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;
  const query = Object.fromEntries(url.searchParams);

  // 登录
  if (pathname === '/api/login' && method === 'POST') {
    const { username, password } = await body(req);
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim());
    if (!user || !user.active || !verifyPassword(password || '', user.salt, user.password_hash)) {
      audit(null, 'login_fail', 'auth', username);
      return fail(res, 401, '用户名或密码错误');
    }
    const token = signToken(user.id);
    res.setHeader('Set-Cookie', `crm_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    audit(user, 'login', 'auth', '登录成功');
    return ok(res, { id: user.id, username: user.username, display_name: user.display_name, role: user.role });
  }

  // 以下均需登录
  const user = currentUser(req);
  if (!user) return fail(res, 401, '请先登录');

  if (pathname === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', 'crm_token=; Path=/; HttpOnly; Max-Age=0');
    return ok(res, {});
  }
  if (pathname === '/api/me') return ok(res, user);

  /* 用户管理（仅 admin） */
  if (pathname.startsWith('/api/users')) {
    if (!isManager(user) || user.role !== 'admin') return fail(res, 403, '仅管理员可管理用户');
    if (pathname === '/api/users' && method === 'GET') {
      return ok(res, db.prepare('SELECT id,username,display_name,role,active,created_at FROM users ORDER BY id').all());
    }
    if (pathname === '/api/users' && method === 'POST') {
      const d = await body(req);
      if (!d.username || !d.password) return fail(res, 400, '用户名和密码必填');
      if (db.prepare('SELECT id FROM users WHERE username=?').get(d.username)) return fail(res, 400, '用户名已存在');
      const role = ['admin', 'manager', 'sales'].includes(d.role) ? d.role : 'sales';
      const { salt, hash } = hashPassword(d.password);
      const r = db.prepare(`INSERT INTO users(username,password_hash,salt,display_name,role,active,created_at)
                            VALUES(?,?,?,?,?,1,?)`).run(d.username, hash, salt, d.display_name || d.username, role, now());
      audit(user, 'create', 'users', '新建用户 ' + d.username);
      return ok(res, { id: Number(r.lastInsertRowid) });
    }
    const m = pathname.match(/^\/api\/users\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === 'PUT') {
        const d = await body(req);
        const sets = [], args = [];
        for (const f of ['display_name', 'role', 'active']) {
          if (f in d) { sets.push(`${f}=?`); args.push(f === 'active' ? (d[f] ? 1 : 0) : d[f]); }
        }
        if (d.password) {
          const { salt, hash } = hashPassword(d.password);
          sets.push('password_hash=?', 'salt=?'); args.push(hash, salt);
        }
        if (sets.length) { args.push(id); db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...args); }
        audit(user, 'update', 'users', '更新用户 #' + id);
        return ok(res, {});
      }
      if (method === 'DELETE') {
        if (id === user.id) return fail(res, 400, '不能删除自己');
        db.prepare('DELETE FROM users WHERE id=?').run(id);
        audit(user, 'delete', 'users', '删除用户 #' + id);
        return ok(res, {});
      }
    }
  }

  /* 统计 */
  if (pathname === '/api/stats/overview') return ok(res, statsOverview(user));
  if (pathname === '/api/stats/funnel') return ok(res, statsFunnel(user));
  if (pathname === '/api/stats/sales') return ok(res, statsSales(user));
  if (pathname === '/api/stats/trend') return ok(res, statsTrend(user));

  /* ---------- 数据库管理（仅管理员）---------- */
  if (pathname.startsWith('/api/db/')) {
    if (user.role !== 'admin') return fail(res, 403, '仅管理员可访问数据库管理');

    // 表清单
    if (pathname === '/api/db/tables' && method === 'GET') {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const list = tables.map(t => ({
        name: t.name,
        rows: db.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get().n,
      }));
      return ok(res, list);
    }

    // 浏览表数据
    const tm = pathname.match(/^\/api\/db\/table\/(\w+)$/);
    if (tm && method === 'GET') {
      const table = tm[1];
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        return fail(res, 404, '表不存在');
      }
      const limit = Math.min(Number(query.limit || 100), 1000);
      const offset = Math.max(Number(query.offset || 0), 0);
      const rows = db.prepare(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`).all(limit, offset);
      const total = db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n;
      const clean = rows.map(r => {
        const o = { ...r };
        if (table === 'users') { delete o.password_hash; delete o.salt; }
        return o;
      });
      const columns = clean.length ? Object.keys(clean[0])
        : db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name).filter(c => !(table === 'users' && ['password_hash', 'salt'].includes(c)));
      return ok(res, { columns, rows: clean, total, limit, offset });
    }

    // 只读 SQL 查询
    if (pathname === '/api/db/query' && method === 'POST') {
      const d = await body(req);
      const sql = String(d.sql || '').trim().replace(/;+\s*$/, '');
      if (!/^(select|with)\b/i.test(sql) && !/^pragma\s+table_info\b/i.test(sql)) {
        return fail(res, 400, '仅支持 SELECT / WITH / PRAGMA table_info 只读查询');
      }
      if (/\b(insert|update|delete|drop|alter|create|attach|detach|replace|vacuum|reindex|writable_schema)\b/i.test(sql)) {
        return fail(res, 400, '检测到写操作，已拒绝执行');
      }
      try {
        const t0 = Date.now();
        const rows = db.prepare(sql).all().slice(0, 1000);
        const columns = rows.length ? Object.keys(rows[0]) : [];
        audit(user, 'sql_query', 'db', sql.slice(0, 200));
        return ok(res, { columns, rows, elapsed: Date.now() - t0, truncated: rows.length >= 1000 });
      } catch (e) {
        return fail(res, 400, 'SQL 执行失败: ' + e.message);
      }
    }

    // 导出整库（先归并 WAL 再下载）
    if (pathname === '/api/db/export' && method === 'GET') {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const buf = fs.readFileSync(path.join(__dirname, 'data', 'crm.db'));
      audit(user, 'export_db', 'db', '导出整库');
      const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      res.setHeader('Content-Disposition', `attachment; filename="zero-crm-${ts}.db"`);
      return send(res, 200, buf, 'application/octet-stream');
    }

    // 服务端一键备份
    if (pathname === '/api/db/backup' && method === 'POST') {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const dir = path.join(__dirname, 'data', 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const file = `zero-crm-${ts}.db`;
      fs.copyFileSync(path.join(__dirname, 'data', 'crm.db'), path.join(dir, file));
      audit(user, 'backup', 'db', '备份 ' + file);
      return ok(res, { file, bytes: fs.statSync(path.join(dir, file)).size });
    }
  }

  /* 审计日志 */
  if (pathname === '/api/audit' && isManager(user)) {
    return ok(res, db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200').all());
  }

  /* CSV 导出 */
  const exp = pathname.match(/^\/api\/export\/(\w+)$/);
  if (exp && method === 'GET') {
    const table = exp[1];
    if (!TABLES[table]) return fail(res, 404, '不支持导出');
    const sc = scopeClause(user, '');
    const rows = db.prepare(`SELECT * FROM ${table}${sc.sql ? ' WHERE 1=1' + sc.sql : ''} ORDER BY id DESC`).all(...sc.args);
    if (!rows.length) return fail(res, 404, '暂无数据');
    const headers = Object.keys(rows[0]);
    const csv = '\uFEFF' + headers.join(',') + '\n' + rows.map(r => headers.map(h => csvEscape(r[h])).join(',')).join('\n');
    res.setHeader('Content-Disposition', `attachment; filename="${table}-${iso()}.csv"`);
    return send(res, 200, csv, 'text/csv; charset=utf-8');
  }

  /* CSV 导入客户 */
  if (pathname === '/api/import/customers' && method === 'POST') {
    const d = await body(req);
    if (!d.csv) return fail(res, 400, '缺少 CSV 内容');
    const rows = parseCSV(d.csv);
    if (rows.length < 2) return fail(res, 400, 'CSV 至少需要表头和一行数据');
    const head = rows[0].map(h => h.trim().toLowerCase());
    const map = { '姓名': 'name', 'name': 'name', '公司': 'company', 'company': 'company',
      '行业': 'industry', 'industry': 'industry', '电话': 'phone', 'phone': 'phone',
      '邮箱': 'email', 'email': 'email', '地址': 'address', 'address': 'address',
      '级别': 'level', 'level': 'level', '来源': 'source', 'source': 'source',
      '标签': 'tags', 'tags': 'tags', '备注': 'note', 'note': 'note' };
    const idx = head.map(h => map[h]).filter(Boolean);
    if (!idx.includes('name') && !head.includes('姓名')) {
      // 尝试按列顺序：姓名,公司,行业,电话,邮箱
    }
    const fields = head.map(h => map[h]);
    let added = 0;
    const stmt = db.prepare(`INSERT INTO customers(name,company,industry,phone,email,address,level,source,tags,note,owner_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of rows.slice(1)) {
      const obj = {};
      fields.forEach((f, i) => { if (f) obj[f] = r[i] || ''; });
      if (!obj.name) continue;
      obj.level = ['A', 'B', 'C'].includes(String(obj.level || '').toUpperCase()) ? obj.level.toUpperCase() : 'B';
      obj.owner_id = obj.owner_id || user.id;
      const t = now();
      stmt.run(obj.name, obj.company || '', obj.industry || '', obj.phone || '', obj.email || '',
        obj.address || '', obj.level, obj.source || '', obj.tags || '', obj.note || '',
        obj.owner_id, t, t);
      added++;
    }
    audit(user, 'import', 'customers', `导入 ${added} 条客户`);
    return ok(res, { added });
  }

  /* 通用 CRUD */
  const m = pathname.match(/^\/api\/(\w+)(?:\/(\d+))?$/);
  if (m && TABLES[m[1]]) {
    const table = m[1];
    const id = m[2] ? Number(m[2]) : null;
    if (method === 'GET') return id ? getRecord(res, user, table, id) : listRecords(res, user, table, query);
    if (method === 'POST' && !id) return createRecord(res, user, table, await body(req));
    if (method === 'PUT' && id) return updateRecord(res, user, table, id, await body(req));
    if (method === 'DELETE' && id) return deleteRecord(res, user, table, id);
  }

  fail(res, 404, '接口不存在');
}

/* ---------------- 服务器 ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, '不支持的方法');
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[ERROR]', e);
    if (!res.headersSent) fail(res, 500, '服务器内部错误: ' + e.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log('\n  ╔═══════════════════════════════════════════╗');
  console.log('  ║        zero-crm  中小企业 CRM 系统        ║');
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log(`  ✦ 访问地址:  http://localhost:${PORT}`);
  console.log('  ✦ 默认账号:  admin / admin123');
  console.log('  ✦ 其他账号:  manager / manager123 , sales / sales123');
  console.log('  ✦ 数据库:    ' + path.join(__dirname, 'data', 'crm.db'));
  console.log('  ✦ 按 Ctrl+C 停止\n');
});

module.exports = { server };
