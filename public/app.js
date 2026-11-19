'use strict';
/* 正合CRM 前端单页应用 —— 原生 JS，零依赖 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const dateStr = (s) => s ? String(s).slice(0, 10) : '-';

const STATE = {
  user: null,
  view: 'dashboard',
  data: {},
  customers: [],
  users: [],
  filters: {},
  page: {},
};

const VIEW_TITLES = {
  dashboard: '数据概览', tasks: '待办任务', customers: '客户管理', contacts: '联系人',
  leads: '线索管理', opportunities: '商机管理', funnel: '销售漏斗', activities: '跟进记录',
  reports: '统计报表', users: '用户管理', database: '数据库管理',
};

/* 字典 */
const STAGES = {
  lead: { label: '初步接洽', cls: 'gray', color: '#94a3b8' },
  qualified: { label: '需求确认', cls: 'blue', color: '#3b82f6' },
  proposal: { label: '方案报价', cls: 'cyan', color: '#0891b2' },
  negotiation: { label: '商务谈判', cls: 'orange', color: '#f59e0b' },
  won: { label: '赢单', cls: 'green', color: '#16a34a' },
  lost: { label: '丢单', cls: 'red', color: '#dc2626' },
};
const LEAD_STATUS = {
  new: { label: '新线索', cls: 'blue' }, qualified: { label: '已验证', cls: 'cyan' },
  converted: { label: '已转化', cls: 'green' }, won: { label: '成交', cls: 'green' }, lost: { label: '丢失', cls: 'red' },
};
const ACT_TYPES = {
  call: { label: '电话', cls: 'blue', ico: '☎' }, visit: { label: '拜访', cls: 'purple', ico: '⌂' },
  email: { label: '邮件', cls: 'cyan', ico: '✉' }, meeting: { label: '会议', cls: 'orange', ico: '◉' },
  note: { label: '备注', cls: 'gray', ico: '✎' },
};
const PRIORITY = { high: { label: '高', cls: 'red' }, medium: { label: '中', cls: 'orange' }, low: { label: '低', cls: 'gray' } };

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  let json;
  try { json = await res.json(); } catch { throw new Error('服务返回异常'); }
  if (!res.ok || !json.ok) {
    if (res.status === 401 && STATE.user) { showLogin(); }
    throw new Error(json.error || '请求失败');
  }
  return json.data;
}
const get = (p) => api(p);
const post = (p, b) => api(p, { method: 'POST', body: b });
const put = (p, b) => api(p, { method: 'PUT', body: b });
const del = (p) => api(p, { method: 'DELETE' });

/* ---------------- 提示 & 弹窗 ---------------- */
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span>${type === 'success' ? '✓' : '✕'}</span><span>${esc(msg)}</span>`;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 2600);
}
function modal({ title, body, foot, size = '' }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-overlay"><div class="modal ${size}">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close">&times;</button></div>
    <div class="modal-body">${body}</div>
    ${foot !== null ? `<div class="modal-foot">${foot || '<button class="btn btn-ghost modal-cancel">取消</button>'}</div>` : ''}
  </div></div>`;
  const close = () => { root.innerHTML = ''; };
  $('.modal-close', root).onclick = close;
  const cancel = $('.modal-cancel', root);
  if (cancel) cancel.onclick = close;
  $('.modal-overlay', root).onclick = (e) => { if (e.target === $('.modal-overlay', root)) close(); };
  return { el: root, close };
}
function confirmBox(msg, onOk) {
  const m = modal({
    title: '确认操作',
    body: `<p style="font-size:14px;line-height:1.7">${esc(msg)}</p>`,
    foot: `<button class="btn btn-ghost modal-cancel">取消</button><button class="btn btn-danger" id="confirm-ok">确认</button>`,
  });
  $('#confirm-ok', m.el).onclick = () => { m.close(); onOk(); };
}
function field(label, name, value = '', opts = {}) {
  const { type = 'text', required = false, placeholder = '', options = [], rows = 3, attrs = '' } = opts;
  let input;
  if (type === 'select') {
    input = `<select name="${name}" ${attrs}>${options.map(o => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
    }).join('')}</select>`;
  } else if (type === 'textarea') {
    input = `<textarea name="${name}" rows="${rows}" placeholder="${esc(placeholder)}" ${attrs}>${esc(value)}</textarea>`;
  } else {
    input = `<input type="${type}" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${attrs}>`;
  }
  return `<div class="field"><label>${esc(label)}${required ? ' <span style="color:#dc2626">*</span>' : ''}</label>${input}</div>`;
}

/* ---------------- 登录 ---------------- */
function showLogin(msg) {
  STATE.user = null;
  $('#app').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  if (msg) $('#login-error').textContent = msg;
}
async function initLogin() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn'); btn.disabled = true; btn.textContent = '登录中...';
    $('#login-error').textContent = '';
    try {
      const u = await post('/login', { username: $('#login-user').value, password: $('#login-pass').value });
      STATE.user = u;
      enterApp();
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally { btn.disabled = false; btn.textContent = '登 录'; }
  });
}

/* ---------------- 进入应用 ---------------- */
async function enterApp() {
  $('#login-view').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = STATE.user.display_name;
  $('#user-role').textContent = ({ admin: '管理员', manager: '销售经理', sales: '销售' })[STATE.user.role] || STATE.user.role;
  $('#avatar').textContent = (STATE.user.display_name || 'U').slice(0, 1);
  $$('.admin-only').forEach(el => el.style.display = STATE.user.role === 'admin' ? '' : 'none');
  // 同步导航高亮与标题（支持刷新 / 分享链接直达）
  $$('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.view === STATE.view));
  $('#page-title').textContent = VIEW_TITLES[STATE.view] || STATE.view;
  await loadCustomers();
  await loadUsers();
  render();
}

async function loadCustomers() {
  try { STATE.customers = (await get('/customers?limit=2000')).rows; } catch (e) { console.error(e); }
}
async function loadUsers() {
  if (STATE.user.role !== 'admin') return;
  try { STATE.users = await get('/users'); } catch (e) { console.error(e); }
}
const customerName = (id) => {
  const c = STATE.customers.find(x => x.id === id);
  return c ? (c.company || c.name) : '-';
};
const userName = (id) => {
  const u = STATE.users.find(x => x.id === id);
  return u ? u.display_name : (id ? '#' + id : '-');
};

/* ---------------- 导航 & 渲染 ---------------- */
function setupNav() {
  $$('.nav-item').forEach(item => {
    item.onclick = () => { navigate(item.dataset.view); };
  });
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('collapsed');
  $('#sidebar-toggle').onclick = () => $('#sidebar').classList.toggle('collapsed');
  $('#logout-btn').onclick = async () => { try { await post('/logout'); } catch {} showLogin(); };
  $('#refresh-btn').onclick = () => render();
}
function navigate(view) {
  STATE.view = view;
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  $$('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.view === view));
  $('#page-title').textContent = VIEW_TITLES[view] || view;
  render();
}
async function render() {
  const v = STATE.view;
  const content = $('#content');
  content.innerHTML = '<div class="empty">加载中...</div>';
  try {
    switch (v) {
      case 'dashboard': await renderDashboard(content); break;
      case 'tasks': await renderTasks(content); break;
      case 'customers': await renderCustomers(content); break;
      case 'contacts': await renderContacts(content); break;
      case 'leads': await renderLeads(content); break;
      case 'opportunities': await renderOpportunities(content); break;
      case 'funnel': await renderFunnel(content); break;
      case 'activities': await renderActivities(content); break;
      case 'reports': await renderReports(content); break;
      case 'users': await renderUsers(content); break;
      case 'database': await renderDatabase(content); break;
      default: content.innerHTML = '<div class="empty">页面不存在</div>';
    }
    await updateTaskBadge();
  } catch (err) {
    content.innerHTML = `<div class="empty"><div class="empty-ico">⚠</div><p>${esc(err.message)}</p></div>`;
  }
}
async function updateTaskBadge() {
  try {
    const s = await get('/stats/overview');
    const b = $('#task-badge');
    b.textContent = s.pendingTasks ? s.pendingTasks : '';
    if (s.overdueTasks) b.style.background = 'var(--danger)';
  } catch {}
}

/* ---------------- 数据概览 ---------------- */
async function renderDashboard(el) {
  const s = await get('/stats/overview');
  const funnel = await get('/stats/funnel');
  const acts = (await get('/activities?limit=6')).rows;
  const tasks = (await get('/tasks?status=pending&limit=5')).rows;
  const maxCount = Math.max(1, ...funnel.map(f => f.count));

  el.innerHTML = `
    <div class="page-head"><div><h2>你好，${esc(STATE.user.display_name)} 👋</h2><p>这是你的业务概览 · ${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="quick-opp">+ 新建商机</button><button class="btn btn-ghost" id="quick-cust">+ 新增客户</button></div>
    </div>
    <div class="stats-grid">
      ${statCard('blue', '◧', '客户总数', s.customers, `本月新增 ${s.newCustomers}`)}
      ${statCard('cyan', '◇', '线索数量', s.leads, '待跟进线索')}
      ${statCard('orange', '◈', '进行中商机', s.activeOpps, '未关闭商机')}
      ${statCard('purple', '◷', '预计成交额', money(s.pipeline), `商机总额 ${money(s.pipelineTotal)}`)}
      ${statCard('green', '✓', '已成交金额', money(s.wonAmount), `共 ${s.wonCount} 单`)}
      ${statCard('red', '!', '逾期待办', s.overdueTasks, `待办共 ${s.pendingTasks} 项`)}
    </div>
    <div class="grid-2">
      <div class="card"><div class="card-header"><h3>销售漏斗</h3><a class="link-btn" data-goto="funnel">查看详情 →</a></div>
        <div class="card-body"><div class="funnel">
          ${funnel.filter(f => f.stage !== 'lost').map(f => `
            <div class="funnel-row"><div class="funnel-label">${f.label}</div>
              <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${Math.max(8, f.count / maxCount * 100)}%;background:${STAGES[f.stage].color}">${f.count}</div></div>
              <div class="funnel-num">${money(f.amount)}</div></div>`).join('')}
        </div></div></div>
      <div class="card"><div class="card-header"><h3>最近跟进</h3><a class="link-btn" data-goto="activities">全部 →</a></div>
        <div class="card-body">${acts.length ? acts.map(a => `
          <div style="display:flex;gap:12px;padding:9px 0;border-bottom:1px solid var(--border)">
            <span class="tag ${ACT_TYPES[a.type].cls}">${ACT_TYPES[a.type].ico} ${ACT_TYPES[a.type].label}</span>
            <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">${esc(a.subject)}</div>
              <div style="font-size:11px;color:var(--text-soft)">${esc(customerName(a.customer_id))} · ${dateStr(a.activity_date)}</div></div>
          </div>`).join('') : '<div class="empty">暂无跟进记录</div>'}</div></div>
    </div>
    <div class="card"><div class="card-header"><h3>我的待办</h3><a class="link-btn" data-goto="tasks">全部任务 →</a></div>
      <div class="card-body">${tasks.length ? `<div class="table-wrap"><table><thead><tr><th>任务</th><th>关联客户</th><th>优先级</th><th>截止日期</th><th>状态</th></tr></thead><tbody>
        ${tasks.map(t => `<tr><td class="cell-main">${esc(t.title)}</td><td>${esc(customerName(t.customer_id))}</td>
          <td><span class="tag ${PRIORITY[t.priority].cls}">${PRIORITY[t.priority].label}</span></td>
          <td>${dateStr(t.due_date)} ${t.due_date && t.due_date < new Date().toISOString().slice(0,10) ? '<span class="tag red">逾期</span>' : ''}</td>
          <td><button class="link-btn" data-done-task="${t.id}">✓ 完成</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">🎉 暂无待办任务</div>'}</div></div>
  `;
  $('#quick-opp').onclick = () => openOpportunityForm();
  $('#quick-cust').onclick = () => openCustomerForm();
  $$('[data-goto]', el).forEach(a => a.onclick = () => navigate(a.dataset.goto));
  $$('[data-done-task]', el).forEach(b => b.onclick = async () => {
    await put('/tasks/' + b.dataset.doneTask, { status: 'done', completed_at: new Date().toISOString() });
    toast('任务已完成'); render();
  });
}
function statCard(color, ico, label, value, sub) {
  return `<div class="card stat-card"><div class="stat-icon ${color}">${ico}</div>
    <div><div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div><div class="stat-sub">${esc(sub)}</div></div></div>`;
}

/* ---------------- 客户管理 ---------------- */
async function renderCustomers(el) {
  const q = STATE.filters.customers || {};
  const params = new URLSearchParams({ limit: '1000' });
  if (q.q) params.set('q', q.q);
  const data = await get('/customers?' + params);
  let rows = data.rows;
  if (q.level) rows = rows.filter(r => r.level === q.level);
  if (q.source) rows = rows.filter(r => r.source === q.source);

  el.innerHTML = `
    <div class="page-head"><div><h2>客户管理</h2><p>共 ${data.total} 个客户 · 管理你的客户档案</p></div>
      <div class="head-actions">
        <button class="btn btn-ghost" id="import-cust">⇪ 导入 CSV</button>
        <button class="btn btn-ghost" id="export-cust">⇩ 导出</button>
        <button class="btn btn-primary" id="add-cust">+ 新增客户</button>
      </div></div>
    <div class="card">
      <div class="card-body" style="padding-bottom:0">
        <div class="toolbar">
          <div class="search-box"><input id="cust-search" placeholder="搜索姓名 / 公司 / 电话 / 标签" value="${esc(q.q || '')}"></div>
          <select class="filter" id="cust-level"><option value="">全部级别</option>${['A', 'B', 'C'].map(l => `<option ${q.level === l ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <select class="filter" id="cust-source"><option value="">全部来源</option>${['官网咨询', '展会', '转介绍', '百度推广', 'cold call', '老客户转介绍'].map(l => `<option ${q.source === l ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>客户</th><th>公司</th><th>行业</th><th>电话</th><th>级别</th><th>标签</th><th>负责人</th><th>操作</th></tr></thead><tbody>
        ${rows.length ? rows.map(c => `<tr>
          <td><div class="cell-main">${esc(c.name)}</div><div class="cell-sub">${esc(c.email || '')}</div></td>
          <td>${esc(c.company || '-')}</td><td>${esc(c.industry || '-')}</td><td>${esc(c.phone || '-')}</td>
          <td><span class="tag ${c.level === 'A' ? 'red' : c.level === 'B' ? 'orange' : 'gray'}">${c.level}</span></td>
          <td>${(c.tags || '').split(',').filter(Boolean).map(t => `<span class="tag blue">${esc(t)}</span>`).join('') || '-'}</td>
          <td>${esc(userName(c.owner_id))}</td>
          <td><div class="row-actions"><button class="link-btn" data-view-cust="${c.id}">详情</button>
            <button class="link-btn" data-edit-cust="${c.id}">编辑</button>
            <button class="link-btn danger" data-del-cust="${c.id}">删除</button></div></td></tr>`).join('')
          : `<tr><td colspan="8"><div class="empty"><div class="empty-ico">◧</div><p>暂无客户数据</p></div></td></tr>`}
      </tbody></table></div>
    </div>`;

  const search = $('#cust-search', el);
  let timer;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { STATE.filters.customers = { ...q, q: search.value }; renderCustomers(el); }, 300); };
  search.onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(timer); STATE.filters.customers = { ...q, q: search.value }; renderCustomers(el); } };
  $('#cust-level', el).onchange = (e) => { STATE.filters.customers = { ...q, level: e.target.value }; renderCustomers(el); };
  $('#cust-source', el).onchange = (e) => { STATE.filters.customers = { ...q, source: e.target.value }; renderCustomers(el); };
  $('#add-cust', el).onclick = () => openCustomerForm();
  $('#export-cust', el).onclick = () => { window.location.href = '/api/export/customers'; };
  $('#import-cust', el).onclick = openImportForm;
  $$('[data-view-cust]', el).forEach(b => b.onclick = () => openCustomerDetail(Number(b.dataset.viewCust)));
  $$('[data-edit-cust]', el).forEach(b => b.onclick = () => openCustomerForm(Number(b.dataset.editCust)));
  $$('[data-del-cust]', el).forEach(b => b.onclick = () => confirmBox('确定删除该客户？关联的联系人和跟进记录也会一并删除。', async () => {
    try { await del('/customers/' + b.dataset.delCust); toast('已删除'); await loadCustomers(); render(); } catch (e) { toast(e.message, 'error'); }
  }));
}

function openCustomerForm(id) {
  const c = id ? STATE.customers.find(x => x.id === id) : null;
  const ownerOpts = STATE.user.role === 'admin' || STATE.user.role === 'manager'
    ? STATE.users.map(u => [u.id, u.display_name]) : [[STATE.user.id, STATE.user.display_name]];
  const m = modal({
    title: c ? '编辑客户' : '新增客户',
    body: `<form id="cust-form">
      <div class="form-row">${field('客户姓名', 'name', c?.name || '', { required: true, placeholder: '如：张伟' })}
        ${field('公司名称', 'company', c?.company || '', { placeholder: '如：华远科技' })}</div>
      <div class="form-row">${field('行业', 'industry', c?.industry || '', { placeholder: '如：信息技术' })}
        ${field('客户级别', 'level', c?.level || 'B', { type: 'select', options: [['A', 'A - 重点客户'], ['B', 'B - 普通客户'], ['C', 'C - 潜在客户']] })}</div>
      <div class="form-row">${field('电话', 'phone', c?.phone || '')}${field('邮箱', 'email', c?.email || '')}</div>
      ${field('地址', 'address', c?.address || '')}
      <div class="form-row">${field('客户来源', 'source', c?.source || '', { type: 'select', options: [['', '请选择'], '官网咨询', '展会', '转介绍', '百度推广', 'cold call', '老客户转介绍'] })}
        ${field('负责人', 'owner_id', c?.owner_id || STATE.user.id, { type: 'select', options: ownerOpts })}</div>
      ${field('标签', 'tags', c?.tags || '', { placeholder: '多个标签用逗号分隔，如：重点,老客户' })}
      ${field('备注', 'note', c?.note || '', { type: 'textarea' })}
    </form>`,
    foot: `<button class="btn btn-ghost modal-cancel">取消</button><button class="btn btn-primary" id="save-cust">保存</button>`,
  });
  $('#save-cust', m.el).onclick = async () => {
    const form = $('#cust-form', m.el);
    const d = Object.fromEntries(new FormData(form).entries());
    d.owner_id = Number(d.owner_id);
    try {
      if (c) await put('/customers/' + c.id, d); else await post('/customers', d);
      m.close(); toast(c ? '客户已更新' : '客户已创建'); await loadCustomers(); render();
    } catch (e) { toast(e.message, 'error'); }
  };
}

async function openCustomerDetail(id) {
  const c = STATE.customers.find(x => x.id === id);
  if (!c) return;
  const contacts = (await get('/contacts?customer_id=' + id)).rows;
  const acts = (await get('/activities?customer_id=' + id)).rows;
  const opps = (await get('/opportunities?customer_id=' + id)).rows;
  const m = modal({
    title: '客户详情', size: 'modal-lg',
    body: `<div class="tabs"><div class="tab active" data-tab="info">基本信息</div>
        <div class="tab" data-tab="contact">联系人 (${contacts.length})</div>
        <div class="tab" data-tab="opp">商机 (${opps.length})</div>
        <div class="tab" data-tab="act">跟进记录 (${acts.length})</div></div>
      <div id="tab-info" class="tab-pane"><div class="detail-grid">
        ${detailItem('客户姓名', c.name)}${detailItem('公司', c.company)}
        ${detailItem('行业', c.industry)}${detailItem('级别', c.level + ' 级')}
        ${detailItem('电话', c.phone)}${detailItem('邮箱', c.email)}
        ${detailItem('地址', c.address)}${detailItem('来源', c.source)}
        ${detailItem('标签', (c.tags || '').split(',').filter(Boolean).map(t => `<span class="tag blue">${esc(t)}</span>`).join('') || '-')}
        ${detailItem('负责人', userName(c.owner_id))}${detailItem('创建时间', dateStr(c.created_at))}
      </div>${c.note ? `<div style="margin-top:16px;padding:12px;background:#f8fafc;border-radius:8px"><b>备注：</b>${esc(c.note)}</div>` : ''}</div>
      <div id="tab-contact" class="tab-pane hidden">${contacts.length ? contacts.map(ct => `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <b>${esc(ct.name)}</b> ${ct.is_primary ? '<span class="tag blue">主要联系人</span>' : ''}
        <div style="font-size:12px;color:var(--text-soft);margin-top:3px">${esc(ct.title || '')} ${esc(ct.mobile || ct.phone || '')} ${esc(ct.email || '')}</div></div>`).join('') : '<div class="empty">暂无联系人</div>'}</div>
      <div id="tab-opp" class="tab-pane hidden">${opps.length ? opps.map(o => `<div style="padding:10px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between">
        <div><b>${esc(o.title)}</b><div style="font-size:12px;color:var(--text-soft)">${dateStr(o.expected_date)}</div></div>
        <div style="text-align:right"><b class="money">${money(o.amount)}</b><div><span class="tag ${STAGES[o.stage].cls}">${STAGES[o.stage].label}</span></div></div></div>`).join('') : '<div class="empty">暂无商机</div>'}</div>
      <div id="tab-act" class="tab-pane hidden">${acts.length ? `<div class="timeline">${acts.map(a => `<div class="timeline-item">
        <div class="t-title">${ACT_TYPES[a.type].ico} ${esc(a.subject)}</div>
        <div class="t-meta">${dateStr(a.activity_date)} · ${esc(userName(a.owner_id))}</div>
        ${a.content ? `<div class="t-content">${esc(a.content)}</div>` : ''}</div>`).join('')}</div>` : '<div class="empty">暂无跟进记录</div>'}</div>`,
    foot: `<button class="btn btn-ghost modal-cancel">关闭</button><button class="btn btn-primary" id="detail-add-act">+ 记跟进</button>`,
  });
  $$('.tab', m.el).forEach(t => t.onclick = () => {
    $$('.tab', m.el).forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $$('.tab-pane', m.el).forEach(p => p.classList.add('hidden'));
    $('#tab-' + t.dataset.tab, m.el).classList.remove('hidden');
  });
  $('#detail-add-act', m.el).onclick = () => { m.close(); openActivityForm({ customer_id: id }); };
}
function detailItem(label, value) {
  return `<div class="detail-item"><label>${esc(label)}</label><div>${value || '-'}</div></div>`;
}

function openImportForm() {
  const m = modal({
    title: '导入客户 CSV',
    body: `<p style="color:var(--text-mid);font-size:13px;margin-bottom:12px">支持列名：姓名、公司、行业、电话、邮箱、地址、级别、来源、标签、备注（也可用英文 name/company/...）。第一行为表头。</p>
      <div class="field"><label>选择 CSV 文件</label><input type="file" id="csv-file" accept=".csv,text/csv"></div>
      <div class="field"><label>或直接粘贴 CSV 内容</label><textarea id="csv-text" rows="6" placeholder="姓名,公司,电话,邮箱&#10;张三,某某公司,13800000000,zhang@xx.com"></textarea></div>`,
    foot: `<button class="btn btn-ghost modal-cancel">取消</button><button class="btn btn-primary" id="do-import">导入</button>`,
  });
  $('#csv-file', m.el).onchange = (e) => {
    const f = e.target.files[0];
    if (f) { const r = new FileReader(); r.onload = () => { $('#csv-text', m.el).value = r.result; }; r.readAsText(f, 'UTF-8'); }
  };
  $('#do-import', m.el).onclick = async () => {
    const csv = $('#csv-text', m.el).value.trim();
    if (!csv) return toast('请选择文件或粘贴内容', 'error');
    try {
      const r = await post('/import/customers', { csv });
      m.close(); toast(`成功导入 ${r.added} 个客户`); await loadCustomers(); render();
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 联系人 ---------------- */
async function renderContacts(el) {
  const data = await get('/contacts?limit=1000');
  const rows = data.rows;
  el.innerHTML = `
    <div class="page-head"><div><h2>联系人</h2><p>共 ${data.total} 位联系人</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="add-contact">+ 新增联系人</button></div></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>姓名</th><th>职位</th><th>所属客户</th><th>手机</th><th>电话</th><th>邮箱</th><th>主要</th><th>操作</th></tr></thead><tbody>
      ${rows.length ? rows.map(c => `<tr><td class="cell-main">${esc(c.name)}</td><td>${esc(c.title || '-')}</td>
        <td>${esc(customerName(c.customer_id))}</td><td>${esc(c.mobile || '-')}</td><td>${esc(c.phone || '-')}</td>
        <td>${esc(c.email || '-')}</td><td>${c.is_primary ? '<span class="tag blue">是</span>' : '-'}</td>
        <td><div class="row-actions"><button class="link-btn" data-edit-contact="${c.id}">编辑</button>
          <button class="link-btn danger" data-del-contact="${c.id}">删除</button></div></td></tr>`).join('')
        : `<tr><td colspan="8"><div class="empty"><div class="empty-ico">◎</div><p>暂无联系人</p></div></td></tr>`}
    </tbody></table></div></div>`;
  $('#add-contact', el).onclick = () => openContactForm();
  $$('[data-edit-contact]', el).forEach(b => b.onclick = () => openContactForm(Number(b.dataset.editContact)));
  $$('[data-del-contact]', el).forEach(b => b.onclick = () => confirmBox('确定删除该联系人？', async () => {
    try { await del('/contacts/' + b.dataset.delContact); toast('已删除'); render(); } catch (e) { toast(e.message, 'error'); }
  }));
}
function openContactForm(id) {
  const data = id ? null : {};
  const m = modal({
    title: id ? '编辑联系人' : '新增联系人',
    body: `<form id="contact-form">
      <div class="form-row">${field('姓名', 'name', data.name || '', { required: true })}${field('职位', 'title', data.title || '')}</div>
      ${field('所属客户', 'customer_id', '', { type: 'select', options: [['', '请选择客户'], ...STATE.customers.map(c => [c.id, c.company || c.name])] })}
      <div class="form-row">${field('手机', 'mobile', '')}${field('电话', 'phone', '')}</div>
      ${field('邮箱', 'email', '')}
      <div class="field"><label><input type="checkbox" name="is_primary" value="1" style="width:auto;margin-right:6px">设为主要联系人</label></div>
      ${field('备注', 'note', '', { type: 'textarea' })}
    </form>`,
    foot: `<button class="btn btn-ghost modal-cancel">取消</button><button class="btn btn-primary" id="save-contact">保存</button>`,
  });
  if (id) get('/contacts/' + id).then(c => {
    $$('input,select,textarea', $('#contact-form', m.el)).forEach(el2 => {
      if (el2.name === 'is_primary') el2.checked = !!c.is_primary;
      else el2.value = c[el2.name] == null ? '' : c[el2.name];
    });
  });
  $('#save-contact', m.el).onclick = async () => {
    const form = $('#contact-form', m.el);
    const d = Object.fromEntries(new FormData(form).entries());
    d.customer_id = Number(d.customer_id) || null;
    d.is_primary = d.is_primary ? 1 : 0;
    try {
      if (id) await put('/contacts/' + id, d); else await post('/contacts', d);
      m.close(); toast('已保存'); render();
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 线索 ---------------- */
async function renderLeads(el) {
  const q = STATE.filters.leads || {};
  const params = new URLSearchParams({ limit: '1000' });
  if (q.status) params.set('status', q.status);
  const data = await get('/leads?' + params);
  el.innerHTML = `
    <div class="page-head"><div><h2>线索管理</h2><p>共 ${data.total} 条线索</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="add-lead">+ 新增线索</button></div></div>
    <div class="card"><div class="card-body" style="padding-bottom:0"><div class="toolbar">
      <div class="search-box"><input id="lead-search" placeholder="搜索姓名/公司/电话" value="${esc(q.q || '')}"></div>
      <select class="filter" id="lead-status"><option value="">全部状态</option>${Object.entries(LEAD_STATUS).map(([v, o]) => `<option value="${v}" ${q.status === v ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
    </div></div>
    <div class="table-wrap"><table><thead><tr><th>姓名</th><th>公司</th><th>电话</th><th>来源</th><th>状态</th><th>负责人</th><th>创建日期</th><th>操作</th></tr></thead><tbody>
      ${data.rows.length ? data.rows.map(l => `<tr><td class="cell-main">${esc(l.name)}</td><td>${esc(l.company || '-')}</td>
        <td>${esc(l.phone || '-')}</td><td>${esc(l.source || '-')}</td>
        <td><span class="tag ${LEAD_STATUS[l.status].cls}">${LEAD_STATUS[l.status].label}</span></td>
        <td>${esc(userName(l.owner_id))}</td><td>${dateStr(l.created_at)}</td>
        <td><div class="row-actions"><button class="link-btn" data-convert-lead="${l.id}">转客户</button>
          <button class="link-btn" data-edit-lead="${l.id}">编辑</button>
          <button class="link-btn danger" data-del-lead="${l.id}">删除</button></div></td></tr>`).join('')
        : `<tr><td colspan="8"><div class="empty"><div class="empty-ico">◇</div><p>暂无线索</p></div></td></tr>`}
    </tbody></table></div></div>`;
  let timer;
  $('#lead-search', el).oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { STATE.filters.leads = { ...q, q: e.target.value }; applyLeadFilter(el); }, 300); };
  $('#lead-status', el).onchange = (e) => { STATE.filters.leads = { ...q, status: e.target.value }; renderLeads(el); };
  $('#add-lead', el).onclick = () => openLeadForm();
  $$('[data-edit-lead]', el).forEach(b => b.onclick = () => openLeadForm(Number(b.dataset.editLead)));
  $$('[data-del-lead]', el).forEach(b => b.onclick = () => confirmBox('确定删除该线索？', async () => {
    try { await del('/leads/' + b.dataset.delLead); toast('已删除'); render(); } catch (e) { toast(e.message, 'error'); }
  }));
  $$('[data-convert-lead]', el).forEach(b => b.onclick = () => {
    const l = data.rows.find(x => x.id === Number(b.dataset.convertLead));
    confirmBox(`确定将「${l.name}」转化为客户？`, async () => {
      try {
        await post('/customers', { name: l.name, company: l.company, phone: l.phone, email: l.email, source: l.source, owner_id: l.owner_id || STATE.user.id, tags: '线索转化' });
        await put('/leads/' + l.id, { status: 'converted' });
        toast('已转化为客户'); await loadCustomers(); render();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}
async function applyLeadFilter(el) {
  const all = (await get('/leads?limit=1000')).rows;
  const q = (STATE.filters.leads.q || '').toLowerCase();
  const tbody = $('tbody', el);
  // 简单方式：重新渲染
  renderLeads(el);
}
function openLeadForm(id) {
  let lead = {};
  const m = modal({
    title: id ? '编辑线索' : '新增线索',
    body: `<form id="lead-form">
      <div class="form-row">${field('姓名', 'name', '', { required: true })}${field('公司', 'company', '')}</div>
      <div class="form-row">${field('电话', 'phone', '')}${field('邮箱', 'email', '')}</div>
      <div class="form-row">${field('来源', 'source', '', { type: 'select', options: [['', '请选择'], '展会', '官网咨询', '转介绍', '百度推广', 'cold call', '其他'] })}
        ${field('状态', 'status', 'new', { type: 'select', options: Object.entries(LEAD_STATUS).map(([v, o]) => [v, o.label]) })}</div>
      ${field('备注', 'note', '', { type: 'textarea' })}
    </form>`,
    foot: `<button class="btn btn-ghost modal-cancel">取消</button><button class="btn btn-primary" id="save-lead">保存</button>`,
  });
  if (id) get('/leads/' + id).then(l => { lead = l; $$('input,select,textarea', $('#lead-form', m.el)).forEach(e2 => e2.value = l[e2.name] == null ? '' : l[e2.name]); });
  $('#save-lead', m.el).onclick = async () => {
    const d = Object.fromEntries(new FormData($('#lead-form', m.el)).entries());
    try {
      if (id) await put('/leads/' + id, d); else await post('/leads', d);
      m.close(); toast('已保存'); render();
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 商机 ---------------- */
async function renderOpportunities(el) {
  const q = STATE.filters.opps || {};
  const params = new URLSearchParams({ limit: '1000' });
  if (q.stage) params.set('stage', q.stage);
  const data = await get('/opportunities?' + params);
  const total = data.rows.reduce((s, o) => s + Number(o.amount || 0), 0);
  const weighted = data.rows.filter(o => !['won', 'lost'].includes(o.stage)).reduce((s, o) => s + o.amount * o.probability / 100, 0);
  el.innerHTML = `
    <div class="page-head"><div><h2>商机管理</h2><p>共 ${data.total} 个商机 · 总额 ${money(total)} · 加权预测 ${money(weighted)}</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="add-opp">+ 新建商机</button></div></div>
    <div class="card"><div class="card-body" style="padding-bottom:0"><div class="toolbar">
      <div class="search-box"><input id="opp-search" placeholder="搜索商机名称/客户" value="${esc(q.q || '')}"></div>
      <select class="filter" id="opp-stage"><option value="">全部阶段</option>${Object.entries(STAGES).map(([v, o]) => `<option value="${v}" ${q.stage === v ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
      <button class="btn btn-ghost btn-sm" id="toggle-kanban">${q.kanban ? '≡ 列表视图' : '▤ 看板视图'}</button>
    </div></div>
    <div id="opp-content"></div></div>`;
  renderOppContent(el, data.rows, q.kanban);
  let timer;
  $('#opp-search', el).oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { STATE.filters.opps = { ...q, q: e.target.value }; applyOppFilter(); }, 300); };
  $('#opp-stage', el).onchange = (e) => { STATE.filters.opps = { ...q, stage: e.target.value }; renderOpportunities(el); };
  $('#toggle-kanban', el).onclick = () => { STATE.filters.opps = { ...q, kanban: !q.kanban }; renderOpportunities(el); };
  $('#add-opp', el).onclick = () => openOpportunityForm();
}
async function applyOppFilter() {
  const q = STATE.filters.opps || {};
  const params = new URLSearchParams({ limit: '1000' });
  if (q.stage) params.set('stage', q.stage);
  const data = await get('/opportunities?' + params);
  let rows = data.rows;
  if (q.q) {
    const kw = q.q.toLowerCase();
    rows = rows.filter(o => (o.title || '').toLowerCase().includes(kw) || customerName(o.customer_id).toLowerCase().includes(kw));
  }
  renderOppContent($('#content'), rows, q.kanban);
}
function renderOppContent(el, rows, kanban) {
  const box = $('#opp-content', el);
  if (!box) return;
  if (kanban) {
    box.innerHTML = `<div class="card-body"><div class="kanban">
      ${Object.entries(STAGES).map(([stage, info]) => {
        const list = rows.filter(o => o.stage === stage);
        return `<div class="kanban-col" data-stage="${stage}">
          <div class="kanban-col-head"><span><span class="dot" style="background:${info.color}"></span>${info.label}</span><span class="kanban-count">${list.length}</span></div>
          ${list.map(o => `<div class="kanban-card" draggable="true" data-opp="${o.id}">
            <h4>${esc(o.title)}</h4><div class="amt">${money(o.amount)}</div>
            <div class="meta"><span>${esc(customerName(o.customer_id))}</span><span>${o.probability}%</span></div></div>`).join('')}
        </div>`;
      }).join('')}</div>
      <p style="font-size:11px;color:var(--text-soft);margin-top:8px">💡 拖动商机卡片可切换阶段</p></div>`;
    setupKanban(box);
  } else {
    box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>商机名称</th><th>客户</th><th>金额</th><th>阶段</th><th>成功率</th><th>预计成交</th><th>负责人</th><th>操作</th></tr></thead><tbody>
      ${rows.length ? rows.map(o => `<tr><td class="cell-main">${esc(o.title)}</td><td>${esc(customerName(o.customer_id))}</td>
        <td class="money">${money(o.amount)}</td><td><span class="tag ${STAGES[o.stage].cls}">${STAGES[o.stage].label}</span></td>
        <td>${o.probability}%</td><td>${dateStr(o.expected_date)}</td><td>${esc(userName(o.owner_id))}</td>
        <td><div class="row-actions"><button class="link-btn" data-edit-opp="${o.id}">编辑</button>
          <button class="link-btn" data-act-opp="${o.id}">记跟进</button>
          <button class="link-btn danger" data-del-opp="${o.id}">删除</button></div></td></tr>`).join('')
        : `<tr><td colspan="8"><div class="empty"><div class="empty-ico">◈</div><p>暂无商机</p></div></td></tr>`}
    </tbody></table></div>`;
    $$('[data-edit-opp]', box).forEach(b => b.onclick = () => openOpportunityForm(Number(b.dataset.editOpp)));
    $$('[data-act-opp]', box).forEach(b => b.onclick = () => openActivityForm({ opportunity_id: Number(b.dataset.actOpp) }));
    $$('[data-del-opp]', box).forEach(b => b.onclick = () => confirmBox('确定删除该商机？', async () => {
      try { await del('/opportunities/' + b.dataset.delOpp); toast('已删除'); render(); } catch (e) { toast(e.message, 'error'); }
    }));
  }
}
function setupKanban(box) {
  let dragging = null;
  $$('.kanban-card', box).forEach(card => {
    card.ondragstart = (e) => { dragging = Number(card.dataset.opp); e.dataTransfer.effectAllowed = 'move'; };
    card.onclick = () => openOpportunityForm(Number(card.dataset.opp));
  });
  $$('.kanban-col', box).forEach(col => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('drag-over'); };
    col.ondragleave = () => col.classList.remove('drag-over');
    col.ondrop = async (e) => {
      e.preventDefault(); col.classList.remove('drag-over');
      if (!dragging) return;
      const stage = col.dataset.stage;
      const info = STAGES[stage];
      try {
        await put('/opportunities/' + dragging, { stage, probability: info.cls === 'green' ? 100 : ({ lead: 10, qualified: 25, proposal: 50, negotiation: 75 })[stage] ?? 10 });
        toast('阶段已更新为「' + info.label + '」'); render();
      } catch (err) { toast(err.message, 'error'); }
      dragging = null;
    };
  });
}
function openOpportunityForm(id) {
  let opp = {};
  const ownerOpts = STATE.user.role === 'admin' || STATE.user.role === 'manager'
    ? STATE.users.map(u => [u.id, u.display_name]) : [[STATE.user.id, STATE.user.display_name]];
  const m = modal({
    title: id ? '编辑商机' : '新建商机',
    body: `<form id="opp-form">
      ${field('商机名称', 'title', '', { required: true, placeholder: '如：XX公司年度采购' })}
      <div class="form-row">${field('关联客户', 'customer_id', '', { type: 'select', options: [['', '无'], ...STATE.customers.map(c => [c.id, c.company || c.name])] })}
        ${field('金额 (元)', 'amount', '0', { type: 'number', attrs: 'min="0" step="1000"' })}</div>
      <div class="form-row">${field('阶段', 'stage', 'lead', { type: 'select', options: Object.entries(STAGES).map(([v, o]) => [v, o.label]) })}
        ${field('成功率 (%)', 'probability', '10', { type: 'number', attrs: 'min="0" max="100"' })}</div>
      <div class="form-row">${field('预计成交日期', 'expected_date', '', { type: 'date' })}
        ${field('负责人', 'owner_id', STATE.user.id, { type: 'select', options: ownerOpts })}</div>
      ${field('备注', 'note', '', { type: 'textarea' })}
    </form>`,
    foot: `<button class="btn btn-ghost modal-cancel">取消</button><button class="btn btn-primary" id="save-opp">保存</button>`,
  });
  if (id) get('/opportunities/' + id).then(o => {
    opp = o;
    $$('input,select,textarea', $('#opp-form', m.el)).forEach(e2 => e2.value = o[e2.name] == null ? '' : o[e2.name]);
  });
  $('#save-opp', m.el).onclick = async () => {
    const d = Object.fromEntries(new FormData($('#opp-form', m.el)).entries());
    d.amount = Number(d.amount) || 0; d.probability = Number(d.probability) || 0;
    d.customer_id = Number(d.customer_id) || null; d.owner_id = Number(d.owner_id);
    if (!d.expected_date) delete d.expected_date;
    try {
      if (id) await put('/opportunities/' + id, d); else await post('/opportunities', d);
      m.close(); toast('已保存'); render();
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 销售漏斗 ---------------- */
async function renderFunnel(el) {
  const funnel = await get('/stats/funnel');
  const max = Math.max(1, ...funnel.map(f => f.count));
  el.innerHTML = `
    <div class="page-head"><div><h2>销售漏斗</h2><p>商机在各阶段的分布与转化情况</p></div></div>
    <div class="grid-2">
      <div class="card"><div class="card-header"><h3>商机阶段分布</h3></div><div class="card-body">
        <div class="funnel">${funnel.map(f => `<div class="funnel-row">
          <div class="funnel-label">${f.label}</div>
          <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${Math.max(6, f.count / max * 100)}%;background:${STAGES[f.stage].color}">${f.count} 个</div></div>
          <div class="funnel-num">${money(f.amount)}</div></div>`).join('')}</div>
      </div></div>
      <div class="card"><div class="card-header"><h3>阶段汇总</h3></div><div class="card-body">
        <div class="table-wrap"><table><thead><tr><th>阶段</th><th>数量</th><th>金额</th><th>占比</th></tr></thead><tbody>
          ${funnel.map(f => `<tr><td><span class="tag ${STAGES[f.stage].cls}">${f.label}</span></td><td>${f.count}</td>
            <td class="money">${money(f.amount)}</td><td>${f.count ? Math.round(f.count / funnel.reduce((s, x) => s + x.count, 0) * 100) : 0}%</td></tr>`).join('')}
        </tbody></table></div>
      </div></div>
    </div>`;
}

/* ---------------- 跟进记录 ---------------- */
async function renderActivities(el) {
  const q = STATE.filters.activities || {};
  const params = new URLSearchParams({ limit: '1000' });
  if (q.type) params.set('type', q.type);
  const data = await get('/activities?' + params);
  el.innerHTML = `
    <div class="page-head"><div><h2>跟进记录</h2><p>共 ${data.total} 条记录 · 每一次客户互动都有迹可循</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="add-act">+ 记一笔跟进</button></div></div>
    <div class="card"><div class="card-body" style="padding-bottom:0"><div class="toolbar">
      <select class="filter" id="act-type"><option value="">全部类型</option>${Object.entries(ACT_TYPES).map(([v, o]) => `<option value="${v}" ${q.type === v ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
    </div></div>
    <div class="card-body">${data.rows.length ? `<div class="timeline">${data.rows.map(a => `<div class="timeline-item">
      <div class="t-title"><span class="tag ${ACT_TYPES[a.type].cls}">${ACT_TYPES[a.type].ico} ${ACT_TYPES[a.type].label}</span> ${esc(a.subject)}</div>
      <div class="t-meta">${esc(customerName(a.customer_id))} · ${dateStr(a.activity_date)} · ${esc(userName(a.owner_id))}
        <button class="link-btn danger" data-del-act="${a.id}" style="float:right">删除</button></div>
      ${a.content ? `<div class="t-content">${esc(a.content)}</div>` : ''}
    </div>`).join('')}</div>` : '<div class="empty"><div class="empty-ico">◷</div><p>暂无跟进记录</p></div>'}</div></div>`;
  $('#add-act', el).onclick = () => openActivityForm();
  $('#act-type', el).onchange = (e) => { STATE.filters.activities = { type: e.target.value }; renderActivities(el); };
  $$('[data-del-act]', el).forEach(b => b.onclick = () => confirmBox('确定删除该跟进记录？', async () => {
    try { await del('/activities/' + b.dataset.delAct); toast('已删除'); render(); } catch (e) { toast(e.message, 'error'); }
  }));
}
function openActivityForm(preset = {}) {
  const m = modal({
    title: '记录跟进',
    body: `<form id="act-form">
      <div class="form-row">${field('类型', 'type', 'call', { type: 'select', options: Object.entries(ACT_TYPES).map(([v, o]) => [v, o.label]) })}
        ${field('日期时间', 'activity_date', new Date().toISOString().slice(0, 16), { type: 'datetime-local' })}</div>
      ${field('主题', 'subject', '', { required: true, placeholder: '如：电话回访确认需求' })}
      ${field('关联客户', 'customer_id', preset.customer_id || '', { type: 'select', options: [['', '无'], ...STATE.customers.map(c => [c.id, c.company || c.name])] })}
      ${field('备注内容', 'content', '', { type: 'textarea', placeholder: '记录沟通要点、客户反馈、下一步计划...' })}
    </form>`,
    foot: `<button class="btn btn-ghost modal-cancel">取消</button><button class="btn btn-primary" id="save-act">保存</button>`,
  });
  $('#save-act', m.el).onclick = async () => {
    const d = Object.fromEntries(new FormData($('#act-form', m.el)).entries());
    d.customer_id = Number(d.customer_id) || null;
    if (preset.opportunity_id) d.opportunity_id = preset.opportunity_id;
    if (d.activity_date) d.activity_date = d.activity_date.replace('T', ' ');
    try { await post('/activities', d); m.close(); toast('跟进已记录'); render(); } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 待办任务 ---------------- */
async function renderTasks(el) {
  const q = STATE.filters.tasks || {};
  const params = new URLSearchParams({ limit: '1000' });
  if (q.status) params.set('status', q.status);
  if (q.due) params.set('due', q.due);
  const data = await get('/tasks?' + params);
  el.innerHTML = `
    <div class="page-head"><div><h2>待办任务</h2><p>共 ${data.total} 项任务</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="add-task">+ 新建任务</button></div></div>
    <div class="card"><div class="card-body" style="padding-bottom:0"><div class="toolbar">
      <select class="filter" id="task-status"><option value="">全部状态</option><option value="pending" ${q.status === 'pending' ? 'selected' : ''}>待办</option><option value="done" ${q.status === 'done' ? 'selected' : ''}>已完成</option></select>
      <select class="filter" id="task-due"><option value="">全部时间</option><option value="today" ${q.due === 'today' ? 'selected' : ''}>今天到期</option><option value="overdue" ${q.due === 'overdue' ? 'selected' : ''}>已逾期</option></select>
    </div></div>
    <div class="table-wrap"><table><thead><tr><th style="width:40px"></th><th>任务</th><th>关联客户</th><th>优先级</th><th>截止日期</th><th>负责人</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${data.rows.length ? data.rows.map(t => `<tr>
        <td><input type="checkbox" data-check-task="${t.id}" ${t.status === 'done' ? 'checked' : ''} style="width:auto"></td>
        <td><div class="cell-main" style="${t.status === 'done' ? 'text-decoration:line-through;color:var(--text-soft)' : ''}">${esc(t.title)}</div>
          ${t.description ? `<div class="cell-sub">${esc(t.description)}</div>` : ''}</td>
        <td>${esc(customerName(t.customer_id))}</td>
        <td><span class="tag ${PRIORITY[t.priority].cls}">${PRIORITY[t.priority].label}</span></td>
        <td>${dateStr(t.due_date)} ${t.status === 'pending' && t.due_date && t.due_date < new Date().toISOString().slice(0,10) ? '<span class="tag red">逾期</span>' : ''}</td>
        <td>${esc(userName(t.owner_id))}</td>
        <td><span class="tag ${t.status === 'done' ? 'green' : 'orange'}">${t.status === 'done' ? '已完成' : '待办'}</span></td>
        <td><button class="link-btn danger" data-del-task="${t.id}">删除</button></td></tr>`).join('')
        : `<tr><td colspan="8"><div class="empty"><div class="empty-ico">✓</div><p>暂无任务</p></div></td></tr>`}
    </tbody></table></div></div>`;
  $('#add-task', el).onclick = () => openTaskForm();
  $('#task-status', el).onchange = (e) => { STATE.filters.tasks = { ...q, status: e.target.value }; renderTasks(el); };
  $('#task-due', el).onchange = (e) => { STATE.filters.tasks = { ...q, due: e.target.value }; renderTasks(el); };
  $$('[data-check-task]', el).forEach(c => c.onchange = async () => {
    const done = c.checked;
    await put('/tasks/' + c.dataset.checkTask, { status: done ? 'done' : 'pending', completed_at: done ? new Date().toISOString() : null });
    toast(done ? '任务已完成' : '任务已恢复'); render();
  });
  $$('[data-del-task]', el).forEach(b => b.onclick = () => confirmBox('确定删除该任务？', async () => {
    try { await del('/tasks/' + b.dataset.delTask); toast('已删除'); render(); } catch (e) { toast(e.message, 'error'); }
  }));
}
function openTaskForm() {
  const ownerOpts = STATE.user.role === 'admin' || STATE.user.role === 'manager'
    ? STATE.users.map(u => [u.id, u.display_name]) : [[STATE.user.id, STATE.user.display_name]];
  const m = modal({
    title: '新建任务',
    body: `<form id="task-form">
      ${field('任务标题', 'title', '', { required: true, placeholder: '如：明天回访张总' })}
      ${field('描述', 'description', '', { type: 'textarea', rows: 2 })}
      <div class="form-row">${field('截止日期', 'due_date', new Date().toISOString().slice(0, 10), { type: 'date' })}
        ${field('优先级', 'priority', 'medium', { type: 'select', options: [['high', '高'], ['medium', '中'], ['low', '低']] })}</div>
      <div class="form-row">${field('关联客户', 'customer_id', '', { type: 'select', options: [['', '无'], ...STATE.customers.map(c => [c.id, c.company || c.name])] })}
        ${field('负责人', 'owner_id', STATE.user.id, { type: 'select', options: ownerOpts })}</div>
    </form>`,
    foot: `<button class="btn btn-ghost modal-cancel">取消</button><button class="btn btn-primary" id="save-task">保存</button>`,
  });
  $('#save-task', m.el).onclick = async () => {
    const d = Object.fromEntries(new FormData($('#task-form', m.el)).entries());
    d.customer_id = Number(d.customer_id) || null; d.owner_id = Number(d.owner_id);
    try { await post('/tasks', d); m.close(); toast('任务已创建'); render(); } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 统计报表 ---------------- */
async function renderReports(el) {
  const [overview, sales, trend, funnel] = await Promise.all([
    get('/stats/overview'), get('/stats/sales'), get('/stats/trend'), get('/stats/funnel'),
  ]);
  const maxSale = Math.max(1, ...sales.map(s => s.won_amount));
  const maxTrend = Math.max(1, ...trend.map(t => t.cnt));
  el.innerHTML = `
    <div class="page-head"><div><h2>统计报表</h2><p>销售业绩、漏斗转化与团队表现</p></div>
      <button class="btn btn-ghost" id="print-report">🖨 打印报表</button></div>
    <div class="stats-grid">
      ${statCard('blue', '◧', '客户总数', overview.customers, `本月新增 ${overview.newCustomers}`)}
      ${statCard('green', '✓', '成交金额', money(overview.wonAmount), `${overview.wonCount} 单成交`)}
      ${statCard('purple', '◷', '预计成交', money(overview.pipeline), `${overview.activeOpps} 个进行中`)}
      ${statCard('cyan', '◉', '跟进次数', overview.monthActivities, '本月')}
    </div>
    <div class="grid-2">
      <div class="card"><div class="card-header"><h3>团队销售业绩</h3></div><div class="card-body">
        ${sales.length ? sales.map(s => `<div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
            <span><b>${esc(s.display_name)}</b> <span class="tag gray">${esc(s.role)}</span></span>
            <span class="money">${money(s.won_amount)}</span></div>
          <div style="background:#f1f5f9;height:10px;border-radius:6px;overflow:hidden">
            <div style="height:100%;width:${s.won_amount / maxSale * 100}%;background:linear-gradient(90deg,#3b82f6,#2563eb);border-radius:6px"></div></div>
          <div style="font-size:11px;color:var(--text-soft);margin-top:4px">成交 ${s.won_count} 单 · 商机 ${s.opp_count} 个 · 进行中预测 ${money(s.pipeline)}</div>
        </div>`).join('') : '<div class="empty">暂无数据</div>'}
      </div></div>
      <div class="card"><div class="card-header"><h3>商机新增趋势（近 6 月）</h3></div><div class="card-body">
        ${trend.length ? `<div class="bar-chart">${trend.map(t => `<div class="bar-col">
          <div class="bar-value">${t.cnt}</div><div class="bar" style="height:${t.cnt / maxTrend * 100}%"></div><div class="bar-label">${t.ym}</div></div>`).join('')}</div>`
          : '<div class="empty">暂无数据</div>'}
        <div class="legend"><span><i style="background:#2563eb"></i>新增商机数</span></div>
      </div></div>
    </div>
    <div class="card"><div class="card-header"><h3>漏斗转化</h3></div><div class="card-body">
      <div class="funnel">${funnel.map(f => `<div class="funnel-row"><div class="funnel-label">${f.label}</div>
        <div class="funnel-bar-wrap"><div class="funnel-bar" style="width:${Math.max(5, f.count / Math.max(1, ...funnel.map(x => x.count)) * 100)}%;background:${STAGES[f.stage].color}">${f.count}</div></div>
        <div class="funnel-num">${money(f.amount)}</div></div>`).join('')}</div>
    </div></div>`;
  $('#print-report', el).onclick = () => window.print();
}

/* ---------------- 用户管理 ---------------- */
async function renderUsers(el) {
  const users = await get('/users');
  el.innerHTML = `
    <div class="page-head"><div><h2>用户管理</h2><p>共 ${users.length} 个账号 · 管理团队成员与权限</p></div>
      <div class="head-actions"><button class="btn btn-primary" id="add-user">+ 新增用户</button></div></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>用户名</th><th>显示名称</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
      ${users.map(u => `<tr><td class="cell-main">${esc(u.username)}</td><td>${esc(u.display_name)}</td>
        <td><span class="tag ${u.role === 'admin' ? 'purple' : u.role === 'manager' ? 'blue' : 'gray'}">${({ admin: '管理员', manager: '销售经理', sales: '销售' })[u.role]}</span></td>
        <td><span class="tag ${u.active ? 'green' : 'red'}">${u.active ? '启用' : '停用'}</span></td>
        <td>${dateStr(u.created_at)}</td>
        <td><div class="row-actions"><button class="link-btn" data-edit-user="${u.id}">编辑</button>
          ${u.id !== STATE.user.id ? `<button class="link-btn danger" data-del-user="${u.id}">删除</button>` : ''}</div></td></tr>`).join('')}
    </tbody></table></div></div>
    <div style="margin-top:16px;padding:14px 18px;background:#fff;border-radius:10px;border:1px solid var(--border);font-size:12px;color:var(--text-mid)">
      <b>权限说明：</b> 管理员可管理所有功能与用户；销售经理可查看全部业务数据；销售只能查看和操作自己负责的客户、商机与跟进记录。
    </div>`;
  $('#add-user', el).onclick = () => openUserForm();
  $$('[data-edit-user]', el).forEach(b => b.onclick = () => openUserForm(Number(b.dataset.editUser)));
  $$('[data-del-user]', el).forEach(b => b.onclick = () => confirmBox('确定删除该用户？', async () => {
    try { await del('/users/' + b.dataset.delUser); toast('已删除'); await loadUsers(); render(); } catch (e) { toast(e.message, 'error'); }
  }));
}
function openUserForm(id) {
  const users = STATE.users;
  const u = id ? users.find(x => x.id === id) : null;
  const m = modal({
    title: u ? '编辑用户' : '新增用户',
    body: `<form id="user-form">
      <div class="form-row">${field('用户名', 'username', u?.username || '', { required: true, attrs: u ? 'disabled' : '' })}
        ${field('显示名称', 'display_name', u?.display_name || '', { required: true })}</div>
      ${field('密码', 'password', '', { type: 'password', placeholder: u ? '留空表示不修改' : '请输入密码', required: !u })}
      <div class="form-row">${field('角色', 'role', u?.role || 'sales', { type: 'select', options: [['sales', '销售'], ['manager', '销售经理'], ['admin', '管理员']] })}
        ${field('状态', 'active', u ? String(u.active) : '1', { type: 'select', options: [['1', '启用'], ['0', '停用']] })}</div>
    </form>`,
    foot: `<button class="btn btn-ghost modal-cancel">取消</button><button class="btn btn-primary" id="save-user">保存</button>`,
  });
  $('#save-user', m.el).onclick = async () => {
    const d = Object.fromEntries(new FormData($('#user-form', m.el)).entries());
    d.active = d.active === '1';
    try {
      if (u) await put('/users/' + u.id, d); else await post('/users', d);
      m.close(); toast('已保存'); await loadUsers(); render();
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 数据库管理（仅管理员） ---------------- */
const TABLE_LABELS = {
  users: '用户账号', customers: '客户', contacts: '联系人', leads: '线索',
  opportunities: '商机', activities: '跟进记录', tasks: '待办任务', audit_logs: '操作日志',
};
async function renderDatabase(el) {
  if (STATE.user.role !== 'admin') { el.innerHTML = '<div class="empty">无权访问</div>'; return; }
  const tables = await get('/db/tables');
  const active = STATE.filters.dbTable || 'customers';
  const view = await get(`/db/table/${active}?limit=100`);

  el.innerHTML = `
    <div class="page-head"><div><h2>数据库管理</h2><p>直接查看底层数据、执行只读查询、导出与备份 · 仅管理员可用</p></div>
      <div class="head-actions">
        <button class="btn btn-ghost" id="db-export">⇩ 导出整库</button>
        <button class="btn btn-primary" id="db-backup">▣ 一键备份</button>
      </div></div>
    <div style="display:grid;grid-template-columns:220px 1fr;gap:20px;align-items:start">
      <div class="card"><div class="card-header"><h3>数据表</h3><span style="font-size:11px;color:var(--text-soft)">${tables.length} 张</span></div>
        <div class="card-body" style="padding:8px">
          ${tables.map(t => `<div class="db-table-item ${t.name === active ? 'active' : ''}" data-table="${esc(t.name)}">
            <span>${esc(TABLE_LABELS[t.name] || t.name)}</span><span class="db-table-count">${t.rows}</span></div>`).join('')}
        </div></div>
      <div>
        <div class="card" style="margin-bottom:18px"><div class="card-header"><h3>只读 SQL 查询</h3>
          <span style="font-size:11px;color:var(--text-soft)">仅允许 SELECT / WITH / PRAGMA table_info</span></div>
          <div class="card-body">
            <div style="display:flex;gap:8px"><textarea id="sql-input" rows="2" placeholder="SELECT * FROM customers WHERE level='A'" style="flex:1;font-family:monospace">SELECT * FROM ${esc(active)} LIMIT 20</textarea>
              <button class="btn btn-primary" id="run-sql" style="align-self:stretch">执行</button></div>
            <div id="sql-result"></div>
          </div></div>
        <div class="card"><div class="card-header"><h3>${esc(TABLE_LABELS[active] || active)} · 数据浏览</h3>
          <span style="font-size:12px;color:var(--text-soft)">共 ${view.total} 行</span></div>
          <div class="table-wrap"><table><thead><tr>${view.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
            ${view.rows.length ? view.rows.map(r => `<tr>${view.columns.map(c => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')
              : `<tr><td colspan="${view.columns.length || 1}"><div class="empty">暂无数据</div></td></tr>`}
          </tbody></table></div>
          ${view.total > view.limit ? `<div style="padding:12px 20px;font-size:12px;color:var(--text-soft)">仅显示前 ${view.limit} 行，完整数据请用 SQL 查询或导出整库</div>` : ''}
        </div>
      </div>
    </div>`;

  $$('.db-table-item', el).forEach(item => item.onclick = () => {
    STATE.filters.dbTable = item.dataset.table;
    renderDatabase(el);
  });
  $('#run-sql', el).onclick = async () => {
    const sql = $('#sql-input', el).value.trim();
    const box = $('#sql-result', el);
    box.innerHTML = '<div style="padding:12px;color:var(--text-soft);font-size:12px">执行中...</div>';
    try {
      const r = await post('/db/query', { sql });
      box.innerHTML = `<div style="margin-top:12px;padding:10px 12px;background:var(--success-light);border-radius:6px;font-size:12px;color:var(--success)">✓ 返回 ${r.rows.length} 行${r.truncated ? '（已截断至 1000 行）' : ''} · 耗时 ${r.elapsed}ms</div>
        ${r.rows.length ? `<div class="table-wrap" style="margin-top:10px;max-height:320px;overflow:auto"><table><thead><tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
          ${r.rows.map(row => `<tr>${r.columns.map(c => `<td>${esc(row[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}`;
    } catch (e) {
      box.innerHTML = `<div style="margin-top:12px;padding:10px 12px;background:var(--danger-light);border-radius:6px;font-size:12px;color:var(--danger)">✕ ${esc(e.message)}</div>`;
    }
  };
  $('#db-export', el).onclick = () => { window.location.href = '/api/db/export'; toast('整库导出已开始'); };
  $('#db-backup', el).onclick = async () => {
    try {
      const r = await post('/db/backup', {});
      toast('备份成功：' + r.file + '（' + (r.bytes / 1024).toFixed(0) + ' KB）');
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  setupNav();
  await initLogin();
  try {
    const me = await get('/me');
    STATE.user = me;
    const hash = (location.hash || '').replace('#', '');
    if (hash && VIEW_TITLES[hash]) STATE.view = hash;
    enterApp();
  } catch { showLogin(); }
})();
