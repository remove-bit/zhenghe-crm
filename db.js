'use strict';
/**
 * zero-crm 数据层
 * 基于 Node.js 22 内置 node:sqlite —— 零外部依赖、零安装
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.CRM_DB || path.join(DATA_DIR, 'crm.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/* ---------------- 密码工具 ---------------- */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    return crypto.timingSafeEqual(
      Buffer.from(crypto.scryptSync(String(password), salt, 64).toString('hex')),
      Buffer.from(hash)
    );
  } catch { return false; }
}

/* ---------------- Schema ---------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'sales' CHECK(role IN ('admin','manager','sales')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  industry TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  level TEXT DEFAULT 'B' CHECK(level IN ('A','B','C')),
  source TEXT,
  tags TEXT DEFAULT '',
  note TEXT,
  owner_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  phone TEXT,
  mobile TEXT,
  email TEXT,
  note TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  email TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','qualified','converted','won','lost')),
  note TEXT,
  owner_id INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  customer_id INTEGER,
  amount REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'lead' CHECK(stage IN ('lead','qualified','proposal','negotiation','won','lost')),
  probability INTEGER NOT NULL DEFAULT 10,
  expected_date TEXT,
  owner_id INTEGER,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'note' CHECK(type IN ('call','visit','email','meeting','note')),
  subject TEXT NOT NULL,
  content TEXT,
  customer_id INTEGER,
  opportunity_id INTEGER,
  activity_date TEXT NOT NULL,
  owner_id INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  FOREIGN KEY(opportunity_id) REFERENCES opportunities(id) ON DELETE SET NULL,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
  customer_id INTEGER,
  owner_id INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customers_owner ON customers(owner_id);
CREATE INDEX IF NOT EXISTS idx_opps_stage ON opportunities(stage);
CREATE INDEX IF NOT EXISTS idx_opps_owner ON opportunities(owner_id);
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(activity_date);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
`;

/* ---------------- 演示数据 ---------------- */
const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
const STAGE_INFO = {
  lead: { label: '初步接洽', prob: 10 },
  qualified: { label: '需求确认', prob: 25 },
  proposal: { label: '方案报价', prob: 50 },
  negotiation: { label: '商务谈判', prob: 75 },
  won: { label: '赢单', prob: 100 },
  lost: { label: '丢单', prob: 0 },
};

function iso(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}
function now() { return new Date().toISOString(); }

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  const mkUser = db.prepare(
    'INSERT INTO users(username,password_hash,salt,display_name,role,active,created_at) VALUES(?,?,?,?,?,1,?)'
  );
  const accounts = [
    ['admin', 'admin123', '系统管理员', 'admin'],
    ['manager', 'manager123', '销售经理', 'manager'],
    ['sales', 'sales123', '销售小王', 'sales'],
    ['lily', 'lily123', '销售小李', 'sales'],
  ];
  for (const [u, p, name, role] of accounts) {
    const { salt, hash } = hashPassword(p);
    mkUser.run(u, hash, salt, name, role, now());
  }
  const uid = (u) => db.prepare('SELECT id FROM users WHERE username=?').get(u).id;
  const adminId = uid('admin'), managerId = uid('manager'), salesId = uid('sales'), lilyId = uid('lily');

  const mkCustomer = db.prepare(`INSERT INTO customers
    (name,company,industry,phone,email,address,level,source,tags,note,owner_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const customers = [
    ['张伟', '华远科技有限公司', '信息技术', '13800138001', 'zhang@huayuan.com', '北京市海淀区', 'A', '官网咨询', '重点,老客户', '年采购预算 50 万，决策链清晰', salesId],
    ['李娜', '恒信医疗器械', '医疗健康', '13800138002', 'lina@hengxin.cn', '上海市浦东新区', 'A', '展会', '医疗,重点', '正在评估三家供应商', managerId],
    ['王强', '金鼎制造集团', '制造业', '13800138003', 'wangqiang@jinding.com', '深圳市南山区', 'B', '转介绍', '制造', '老板亲自拍板', salesId],
    ['陈静', '星辰教育科技', '教育培训', '13800138004', 'chenjing@xingchen.edu', '广州市天河区', 'B', '百度推广', '教育', '预算有限但意向高', lilyId],
    ['刘洋', '中汇物流企业', '物流运输', '13800138005', 'liuyang@zhonghui.com', '杭州市滨江区', 'C', 'cold call', '物流', '需持续跟进', salesId],
    ['赵敏', '鼎泰金融服务', '金融', '13800138006', 'zhaomin@dingtai.com', '成都市高新区', 'A', '老客户转介绍', '金融,重点', '有二次采购意向', managerId],
    ['孙磊', 'green 食品有限公司', '食品饮料', '13800138007', 'sunlei@greenfood.com', '武汉市江汉区', 'B', '官网咨询', '食品', '关注交付周期', lilyId],
    ['周芳', '启明建筑设计', '建筑', '13800138008', 'zhoufang@qiming.cn', '南京市鼓楼区', 'C', '展会', '建筑', '', salesId],
  ];
  const cids = [];
  for (const c of customers) {
    const r = mkCustomer.run(...c, iso(-30), iso(-2));
    cids.push(Number(r.lastInsertRowid));
  }

  const mkContact = db.prepare(`INSERT INTO contacts
    (customer_id,name,title,phone,mobile,email,note,is_primary,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  const contacts = [
    [0, '张伟', '采购总监', '010-88880001', '13800138001', 'zhang@huayuan.com', '决策人', 1],
    [0, '吴丽', '采购经理', '010-88880002', '13800138011', 'wuli@huayuan.com', '执行对接', 0],
    [1, '李娜', '总经理', '021-66660001', '13800138002', 'lina@hengxin.cn', '最终决策', 1],
    [2, '王强', '董事长', '0755-88880003', '13800138003', 'wangqiang@jinding.com', '', 1],
    [3, '陈静', '市场负责人', '020-33330004', '13800138004', 'chenjing@xingchen.edu', '', 1],
    [5, '赵敏', '风控总监', '028-88880006', '13800138006', 'zhaomin@dingtai.com', '', 1],
    [6, '孙磊', '运营经理', '027-66660007', '13800138007', 'sunlei@greenfood.com', '', 1],
  ];
  for (const [i, ...rest] of contacts) mkContact.run(cids[i], ...rest, now());

  const mkLead = db.prepare(`INSERT INTO leads
    (name,company,phone,email,source,status,note,owner_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  const leads = [
    ['钱军', '瑞丰商贸', '13900139001', 'qianjun@ruifeng.com', '展会', 'qualified', '有明确需求', salesId],
    ['冯梅', '尚品家居', '13900139002', 'fengmei@shangpin.com', '官网咨询', 'new', '', lilyId],
    ['郑浩', '远航国际', '13900139003', 'zhenghao@yuanhang.com', '转介绍', 'converted', '已转为客户', managerId],
    ['杨柳', '新锐传媒', '13900139004', 'yangliu@xinrui.com', '百度推广', 'new', '', salesId],
    ['何斌', '联合能源', '13900139005', 'hebin@lianhe.com', 'cold call', 'lost', '预算不足', lilyId],
  ];
  for (const l of leads) mkLead.run(...l, iso(-15));

  const mkOpp = db.prepare(`INSERT INTO opportunities
    (title,customer_id,amount,stage,probability,expected_date,owner_id,note,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  // 数组里的 customer/opp 用索引占位，这里映射成真实数据库 id
  const C = (i) => cids[i] || null;
  const opps = [
    ['华远科技年度软件采购', 0, 500000, 'negotiation', 75, iso(20), salesId, '合同细节确认中'],
    ['恒信医疗信息系统升级', 1, 320000, 'proposal', 50, iso(35), managerId, '已提交方案'],
    ['金鼎制造数字化改造', 2, 800000, 'qualified', 25, iso(60), salesId, '需求调研阶段'],
    ['星辰教育平台建设', 3, 150000, 'lead', 10, iso(45), lilyId, '初步沟通'],
    ['中汇物流仓储系统', 5, 450000, 'won', 100, iso(-5), managerId, '已签约'],
    ['鼎泰金融风控平台', 5, 600000, 'proposal', 50, iso(50), managerId, '方案评审中'],
    ['green食品供应链系统', 6, 200000, 'qualified', 25, iso(55), lilyId, ''],
    ['启明建筑协同办公', 7, 90000, 'lost', 0, iso(-10), salesId, '选择竞品'],
    ['华远科技增值服务', 0, 120000, 'lead', 10, iso(70), salesId, ''],
  ];
  const oppIds = [];
  const tOpp = now();
  for (const [title, cIdx, amount, stage, probability, expected_date, owner_id, note] of opps) {
    const r = mkOpp.run(title, C(cIdx), amount, stage, probability, expected_date, owner_id, note,
      iso(-40), tOpp);
    oppIds.push(Number(r.lastInsertRowid));
  }

  const mkAct = db.prepare(`INSERT INTO activities
    (type,subject,content,customer_id,opportunity_id,activity_date,owner_id,created_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  const acts = [
    ['meeting', '华远科技合同谈判', '与张总确认付款条款，对方要求分两期', 0, 0, iso(-1) + 'T10:00', salesId],
    ['call', '电话跟进恒信医疗', '李总出差，约下周再联系', 1, 1, iso(-2) + 'T14:30', managerId],
    ['visit', '拜访金鼎制造', '现场调研生产流程，IT 主管陪同', 2, 2, iso(-3) + 'T09:00', salesId],
    ['email', '发送星辰教育方案', '已发送初版方案与报价单', 3, 3, iso(-4) + 'T16:00', lilyId],
    ['note', '中汇物流项目复盘', '项目顺利交付，客户满意度高', 5, 4, iso(-5) + 'T11:00', managerId],
    ['call', '鼎泰金融需求确认', '确认风控模块范围', 5, 5, iso(-6) + 'T15:00', managerId],
    ['meeting', 'green食品需求沟通', '讨论交付周期与预算', 6, 6, iso(-7) + 'T10:30', lilyId],
    ['visit', '启明建筑回访', '得知已签约竞品，记录原因', 7, 7, iso(-15) + 'T14:00', salesId],
  ];
  for (const [type, subject, content, cIdx, oIdx, activity_date, owner_id] of acts) {
    mkAct.run(type, subject, content, C(cIdx), oppIds[oIdx], activity_date, owner_id, now());
  }

  const mkTask = db.prepare(`INSERT INTO tasks
    (title,description,due_date,priority,status,customer_id,owner_id,created_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const tasks = [
    ['回访华远科技张总', '确认合同终稿并推动签署', iso(1), 'high', 'pending', 0, salesId, now(), null],
    ['整理恒信医疗投标材料', '准备资质文件与案例', iso(2), 'high', 'pending', 1, managerId, now(), null],
    ['金鼎制造二次上门', '带解决方案工程师做技术交流', iso(3), 'medium', 'pending', 2, salesId, now(), null],
    ['发送星辰教育合同模板', '', iso(-1), 'medium', 'pending', 3, lilyId, now(), null],
    ['鼎泰金融方案修订', '根据评审意见调整报价', iso(5), 'high', 'pending', 5, managerId, now(), null],
    ['green食品报价跟进', '电话确认报价接收情况', iso(-2), 'low', 'pending', 6, lilyId, now(), null],
    ['月度销售总结', '汇总本月漏斗数据', iso(8), 'medium', 'pending', null, adminId, now(), null],
    ['中汇物流项目归档', '整理交付文档', iso(-6), 'low', 'done', 5, managerId, now(), now()],
  ];
  for (const [title, description, due_date, priority, status, cIdx, owner_id, created_at, completed_at] of tasks) {
    mkTask.run(title, description, due_date, priority, status, C(cIdx), owner_id, created_at, completed_at);
  }
}

/* ---------------- 初始化 ---------------- */
function init() {
  db.exec(SCHEMA);
}

/* ---------------- 审计日志 ---------------- */
function audit(user, action, target, detail) {
  try {
    db.prepare(`INSERT INTO audit_logs(user_id,username,action,target,detail,created_at)
                VALUES(?,?,?,?,?,?)`).run(
      user ? user.id : null, user ? user.username : 'system', action, target,
      detail ? String(detail).slice(0, 500) : '', now()
    );
  } catch (e) { console.error('audit failed:', e.message); }
}

init();
seed();

module.exports = { db, hashPassword, verifyPassword, audit, now, iso, STAGES, STAGE_INFO, DB_PATH };
