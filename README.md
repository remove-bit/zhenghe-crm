# zero-crm

> 中小企业开箱即用的客户关系管理系统 · **零依赖 · 零配置 · 一条命令启动**

一个真正轻量的 CRM：不需要 Docker、不需要 MySQL/PostgreSQL/MongoDB、不需要 `npm install`，只需要 Node.js。数据存在本地 SQLite 文件里，完全属于你自己。

## ✨ 为什么做这个

市面上的开源 CRM（SuiteCRM、EspoCRM、IDURAR、Frappe CRM 等）功能强大，但对中小企业来说太重了——要装 PHP/数据库/缓存，光部署就能劝退一半人。

zero-crm 借鉴了 [IDURAR](https://github.com/idurar/idurar-erp-crm) 的 CRM 领域模型（客户/联系人/商机/报价思路）和 [EspoCRM](https://github.com/espocrm/espocrm) 的模块划分，聚焦中小企业真正每天在用的能力，用 **Node.js 22 内置的 `node:sqlite` + 原生前端**重写，做到极简交付。

## 🚀 快速开始

### 前提
只需 **Node.js ≥ 22.5**（因为用到了内置的 `node:sqlite`）。

### 启动
```bash
git clone https://github.com/<你的用户名>/zero-crm.git
cd zero-crm
node server.js
```

打开浏览器访问 **http://localhost:3000**，就这么简单。

首次启动会：
- 自动创建 `data/crm.db` 数据库和全部表
- 自动初始化演示数据（客户/联系人/线索/商机/跟进/任务）
- 自动创建默认账号

### 默认账号

| 用户名 | 密码 | 角色 | 权限 |
|--------|------|------|------|
| admin | admin123 | 管理员 | 全部功能 + 用户管理 |
| manager | manager123 | 销售经理 | 查看全部业务数据 |
| sales | sales123 | 销售 | 仅自己的数据 |

> ⚠️ 生产环境请务必登录后到「用户管理」修改默认密码，或通过环境变量配置。

## 📦 功能

### 1. 客户与联系人
- 客户档案：姓名/公司/行业/级别/来源/标签/备注
- 联系人管理，支持设为主要联系人
- 全字段搜索、级别/来源筛选
- CSV 批量导入（中文表头）、一键导出
- 客户详情：基本信息 + 联系人 + 商机 + 跟进时间线

### 2. 商机与销售漏斗
- 商机阶段：初步接洽 → 需求确认 → 方案报价 → 商务谈判 → 赢单/丢单
- **看板视图**：拖拽卡片切换阶段，自动更新成功率
- 列表视图、金额与加权预测
- 线索管理，一键转化为客户

### 3. 跟进记录与提醒
- 跟进类型：电话/拜访/邮件/会议/备注
- 时间线展示每一次客户互动
- 待办任务：优先级、截止日期、完成状态
- 逾期提醒、顶部待办角标

### 4. 统计报表与权限
- 数据概览：客户数/商机数/成交额/预测额等 6 大指标
- 销售漏斗图、团队业绩排行、商机趋势图
- 三级角色权限（管理员/销售经理/销售）
- 数据隔离：销售只能看到自己负责的数据
- 操作审计日志

## ⚙️ 配置

通过环境变量（都有默认值，不改也能跑）：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | 3000 |
| `HOST` | 监听地址 | 0.0.0.0 |
| `CRM_DB` | 数据库文件路径 | `data/crm.db` |
| `CRM_SECRET` | 登录签名密钥（生产建议设置） | 自动生成并存 `data/secret` |

示例：
```bash
PORT=8080 CRM_SECRET="my-random-secret" node server.js
```

## 🔒 数据安全与备份

- 所有业务数据都在 `data/crm.db`（SQLite WAL 模式）。**备份时请复制整个 `data/` 目录**（包含 `crm.db`、`crm.db-wal`、`crm.db-shm`），或先正常停止服务（Ctrl+C）后再复制 `crm.db`，这样 WAL 会自动归并到主文件。
- 密码使用 `scrypt` 加盐哈希存储，不明文保存。
- 登录用 HttpOnly Cookie + HMAC 签名，重启服务不掉登录。
- `data/` 已在 `.gitignore` 中排除，不会被提交到仓库。
- 建议：定期备份 `data/` 目录；生产环境务必设置 `CRM_SECRET` 环境变量。

## 🛠 技术栈

- **后端**：Node.js 内置 `http` + `node:sqlite` + `crypto`（零 npm 依赖）
- **前端**：原生 HTML/CSS/JavaScript 单页应用（零构建、零 CDN）
- **数据库**：SQLite（WAL 模式）

整个项目**没有任何 `node_modules`**，无需联网安装依赖，适合内网/离线环境部署。

## 📁 目录结构

```
zero-crm/
├── server.js        # HTTP 服务、路由、鉴权、API、报表、CSV
├── db.js            # 数据库 Schema、初始化、演示数据
├── public/
│   ├── index.html   # 页面骨架
│   ├── style.css    # 样式
│   └── app.js       # 前端单页应用逻辑
├── data/            # 运行时生成（数据库 + 密钥）
├── package.json
├── LICENSE          # MIT
└── README.md
```

## 🗺 路线图

- [ ] 邮件/短信提醒通知
- [ ] 自定义字段与自定义表单
- [ ] 数据看板拖拽布局
- [ ] 移动端适配优化
- [ ] 多语言支持

## 🤝 贡献

欢迎提 Issue 和 PR。保持「零依赖、简单、开箱即用」的核心原则。

## 📄 许可证

[MIT](LICENSE) —— 免费商用，保留版权声明即可。

---

**zero-crm** — 让中小企业也能用上简单好用的客户管理系统。
