/* 墨锭试磨室 · 配方任务中心 —— 前端逻辑 */
"use strict";

const STATUS_ORDER = ["待配样", "排队试磨", "试磨中", "待复评", "已归档", "已取消"];
const ACTION_META = {
  sample_ready:   { label: "配样完成", cls: "primary" },
  start_grinding: { label: "开始试磨", cls: "primary" },
  submit_review:  { label: "提交复评", cls: "primary" },
  approve:        { label: "复评通过", cls: "primary" },
  return:         { label: "退回",     cls: "warn" },
  cancel:         { label: "取消任务", cls: "danger" },
};
const GROUP_FIELDS = [
  ["formula", "配方", "text", "如：松烟+7.5%胶"],
  ["paper", "纸样", "text", "如：净皮宣"],
  ["temperature", "温度(℃)", "number", "如：22"],
  ["humidity", "湿度(%)", "number", "如：55"],
  ["sampleNo", "样本编号", "text", "如：S-001-A"],
  ["score", "评分", "number", "0-100，可后补"],
];

const state = {
  users: [],
  me: localStorage.getItem("ink-room-user") || "",
  tasks: [],
  stats: null,
  alerts: null,
  detail: null,
  filters: { status: "", q: "", overdue: false, mine: false },
  pending: false,
};

/* ---------- 基础 ---------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const me = () => state.users.find((u) => u.id === state.me) || null;

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

let toastTimer = null;
function toast(msg, type = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3600);
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (state.me) headers["X-User-Id"] = state.me;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["Idempotency-Key"] = uuid(); // 每次提交一个幂等键，网络重试/双击不会重复生效
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `请求失败（${res.status}）`);
  return data;
}

/* ---------- 数据加载 ---------- */
async function loadAll() {
  const params = new URLSearchParams();
  if (state.filters.status) params.set("status", state.filters.status);
  if (state.filters.q) params.set("q", state.filters.q);
  if (state.filters.overdue) params.set("overdue", "1");
  if (state.filters.mine) params.set("mine", "1");
  const [tasks, stats, alerts] = await Promise.all([
    api(`/api/tasks?${params}`),
    api("/api/stats"),
    api("/api/alerts"),
  ]);
  state.tasks = tasks;
  state.stats = stats;
  state.alerts = alerts;
  renderStats();
  renderAlerts();
  renderTasks();
}

/* ---------- 渲染：统计 / 异常 / 列表 ---------- */
function renderStats() {
  const { byStatus, overdue, total } = state.stats;
  const cur = state.filters.status;
  const chip = (key, label, n, cls) => {
    const active = key === "__overdue__" ? state.filters.overdue : cur === key;
    return `<button class="stat ${cls} ${active ? "active" : ""}" data-stat="${esc(key)}">
       <span class="n">${n}</span><span class="l">${esc(label)}</span>
     </button>`;
  };
  $("#statsRow").innerHTML =
    chip("", "全部", total, "") +
    STATUS_ORDER.map((s) => chip(s, s, byStatus[s] || 0, `s-${s}`)).join("") +
    chip("__overdue__", "逾期", overdue, "s-逾期");
  document.querySelectorAll("[data-stat]").forEach((el) => {
    el.onclick = () => {
      const v = el.dataset.stat;
      if (v === "__overdue__") {
        state.filters.overdue = !state.filters.overdue;
        $("#overdueOnly").checked = state.filters.overdue;
      } else {
        state.filters.status = state.filters.status === v ? "" : v;
        $("#statusFilter").value = state.filters.status;
      }
      loadAll().catch((e) => toast(e.message, "err"));
    };
  });
}

function renderAlerts() {
  const { overdue, dueSoon, incomplete } = state.alerts;
  const bar = $("#alertBar");
  if (!overdue.length && !dueSoon.length && !incomplete.length) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  const rows = [];
  if (overdue.length) {
    rows.push(`<div class="row"><span class="ico">⚠️</span>
      <span class="txt"><b>${overdue.length} 个任务已逾期</b>：${overdue.map((t) => `${esc(t.code)}（逾期 ${t.days} 天 · ${esc(t.status)}）`).join("、")}</span>
      <button class="link" data-alert="overdue">查看逾期</button></div>`);
  }
  if (dueSoon.length) {
    rows.push(`<div class="row amber"><span class="ico">⏰</span>
      <span class="txt"><b>${dueSoon.length} 个任务临近截止</b>：${dueSoon.map((t) => `${esc(t.code)}（${esc(t.dueDate)} 截止）`).join("、")}</span></div>`);
  }
  if (incomplete.length) {
    rows.push(`<div class="row amber"><span class="ico">🧪</span>
      <span class="txt"><b>${incomplete.length} 个任务试磨数据不完整</b>：${incomplete.map((t) => `${esc(t.code)}（${t.groups.map(esc).join("、")}）`).join("；")}</span>
      <button class="link" data-alert="incomplete">查看试磨中</button></div>`);
  }
  bar.innerHTML = rows.join("");
  bar.classList.remove("hidden");
  bar.querySelectorAll("[data-alert]").forEach((el) => {
    el.onclick = () => {
      if (el.dataset.alert === "overdue") {
        state.filters.overdue = true;
        $("#overdueOnly").checked = true;
      } else {
        state.filters.status = "试磨中";
        $("#statusFilter").value = "试磨中";
      }
      loadAll().catch((e) => toast(e.message, "err"));
    };
  });
}

function dueHtml(t) {
  if (!t.dueDate) return `<span class="due">未设截止日期</span>`;
  if (t.overdue) return `<span class="due over">已逾期 · ${esc(t.dueDate)} 截止</span>`;
  if (t.dueSoon) return `<span class="due soon">临近截止 · ${esc(t.dueDate)}</span>`;
  return `<span class="due">${esc(t.dueDate)} 截止</span>`;
}

function renderTasks() {
  const list = $("#taskList");
  if (!state.tasks.length) {
    list.innerHTML = `<div class="empty">没有符合条件的任务。调整筛选，或点击右上角「＋ 新建任务」。</div>`;
    return;
  }
  list.innerHTML = state.tasks.map((t) => `
    <article class="card ${t.overdue ? "overdue" : ""}" data-open="${esc(t.id)}" tabindex="0" role="button" aria-label="查看 ${esc(t.code)}">
      <div class="head">
        <span class="code">${esc(t.code)}</span>
        <span class="pill ${esc(t.status)}">${esc(t.status)}</span>
      </div>
      <div class="meta">
        <span>烟料 <b>${esc(t.smokeSource || "—")}</b></span>
        <span>胶料 <b>${esc(t.glueRatio || "—")}</b></span>
        <span>年限 <b>${t.ageYears ?? "—"}</b></span>
        <span>存放 <b>${esc(t.storage || "—")}</b></span>
      </div>
      <div class="meta">
        <span>试磨组 <b>${t.groupCount}</b>${t.incompleteGroups ? ` <span class="tag red">${t.incompleteGroups} 组待补</span>` : ""}</span>
        <span>试磨人 <b>${esc(t.grinderName || "—")}</b></span>
        ${t.reviewerName ? `<span>复评人 <b>${esc(t.reviewerName)}</b></span>` : ""}
      </div>
      <div class="foot">
        ${dueHtml(t)}
        <span class="sub">更新于 ${fmtTime(t.updatedAt)}</span>
      </div>
    </article>`).join("");
  list.querySelectorAll("[data-open]").forEach((el) => {
    el.onclick = () => openTask(el.dataset.open);
    el.onkeydown = (e) => { if (e.key === "Enter") openTask(el.dataset.open); };
  });
}

/* ---------- 任务详情抽屉 ---------- */
async function openTask(id) {
  try {
    state.detail = await api(`/api/tasks/${encodeURIComponent(id)}`);
    renderDrawer();
  } catch (e) {
    toast(e.message, "err");
  }
}
function closeDrawer() {
  state.detail = null;
  $("#drawer").classList.add("hidden");
  $("#drawerMask").classList.add("hidden");
}

function groupReadonlyRow(g) {
  const v = (x) => (x === null || x === undefined || x === "" ? "—" : esc(x));
  return `<div class="kv">
    <div><span class="k">配方</span>${v(g.formula)}</div>
    <div><span class="k">纸样</span>${v(g.paper)}</div>
    <div><span class="k">温度(℃)</span>${v(g.temperature)}</div>
    <div><span class="k">湿度(%)</span>${v(g.humidity)}</div>
    <div><span class="k">样本编号</span>${v(g.sampleNo)}</div>
    <div><span class="k">评分</span>${v(g.score)}</div>
  </div>`;
}

function groupForm(g) {
  return `<div class="gform" data-gform="${esc(g.id)}">
    ${GROUP_FIELDS.map(([k, label, type, ph]) => `
      <label class="${k === "formula" ? "full" : ""}">${label}
        <input name="${k}" type="${type}" ${type === "number" ? 'step="any"' : ""} placeholder="${ph}"
               value="${g[k] === null || g[k] === undefined ? "" : esc(g[k])}">
      </label>`).join("")}
    <label class="full">&nbsp;<button class="btn small primary block" data-save-group="${esc(g.id)}">保存本组记录</button></label>
  </div>`;
}

function groupHtml(t, g, editable) {
  const miss = g.missing || [];
  return `<div class="group" data-group="${esc(g.id)}">
    <div class="ghead">
      <span class="gname">${esc(g.name)}</span>
      ${miss.length ? `<span class="tag red">缺 ${miss.map(esc).join("、")}</span>` : `<span class="tag">记录完整</span>`}
    </div>
    ${editable ? groupForm(g) : groupReadonlyRow(g)}
    <div class="notes">
      ${(g.notes || []).map((n) => `
        <div class="n">${esc(n.text)}<div class="who-n">${esc(n.byName)} · ${esc(n.stage)} · ${fmtTime(n.at)}</div></div>`).join("") || '<div class="n who-n">暂无阶段意见</div>'}
      ${editable ? `<div class="note-input">
        <input placeholder="追加阶段意见（如：出墨快、沉淀少）" data-note-input="${esc(g.id)}">
        <button class="btn small" data-add-note="${esc(g.id)}">添加</button>
      </div>` : ""}
    </div>
  </div>`;
}

function timelineHtml(t) {
  const items = [...t.timeline].reverse();
  return `<ul class="timeline">
    ${items.map((e) => `
      <li class="${e.result === "rejected" ? "rejected" : ""}">
        <div class="t-top">
          <span class="t-action">${e.result === "rejected" ? "✕ " : ""}${esc(e.action)}</span>
          ${e.from && e.to && e.from !== e.to ? `<span class="t-flow">${esc(e.from)} → ${esc(e.to)}</span>` : ""}
        </div>
        ${e.detail ? `<div class="t-detail">${esc(e.detail)}</div>` : ""}
        <div class="t-meta">${esc(e.actorName)} · ${fmtTime(e.at)}</div>
      </li>`).join("")}
  </ul>`;
}

function renderDrawer() {
  const t = state.detail;
  if (!t) return;
  const actor = me();
  const canEditGroups = actor && ["operator", "admin"].includes(actor.role) && ["待配样", "排队试磨", "试磨中"].includes(t.status);
  const drawer = $("#drawer");
  drawer.innerHTML = `
    <div class="dhead">
      <div>
        <h2>${esc(t.code)}</h2>
        <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="pill ${esc(t.status)}">${esc(t.status)}</span>
          ${t.overdue ? '<span class="tag red">已逾期</span>' : ""}
          ${t.dueSoon ? '<span class="tag amber">临近截止</span>' : ""}
        </div>
      </div>
      <button class="close" data-close aria-label="关闭">✕</button>
    </div>

    <div class="section">
      <h3>任务信息</h3>
      <div class="kv">
        <div><span class="k">烟料来源</span>${esc(t.smokeSource || "—")}</div>
        <div><span class="k">胶料比例</span>${esc(t.glueRatio || "—")}</div>
        <div><span class="k">存放年限</span>${t.ageYears ?? "—"}</div>
        <div><span class="k">存放位置</span>${esc(t.storage || "—")}</div>
        <div><span class="k">截止日期</span>${t.dueDate ? esc(t.dueDate) : "未设置"}</div>
        <div><span class="k">创建</span>${esc(t.creatorName)} · ${fmtTime(t.createdAt)}</div>
        <div><span class="k">试磨人</span>${esc(t.grinderName || "—")}</div>
        <div><span class="k">复评人</span>${esc(t.reviewerName || "—")}</div>
        ${t.cancelReason ? `<div><span class="k">取消原因</span>${esc(t.cancelReason)}</div>` : ""}
      </div>
    </div>

    ${t.availableActions.length ? `<div class="action-bar">
      ${t.availableActions.map((a) => `<button class="btn ${ACTION_META[a].cls}" data-action="${a}">${ACTION_META[a].label}</button>`).join("")}
    </div>` : ""}

    <div class="section">
      <h3>试磨组 <span class="cnt">${t.groups.length} 组 · 每组独立记录配方 / 纸样 / 温湿度 / 样本编号 / 阶段意见</span></h3>
      ${t.groups.map((g) => groupHtml(t, g, canEditGroups)).join("") || '<div class="sub">尚未建立试磨组</div>'}
      ${canEditGroups ? '<button class="btn ghost block" data-add-group>＋ 新增试磨组</button>' : ""}
    </div>

    <div class="section">
      <h3>时间线 <span class="cnt">${t.timeline.length} 条 · 含被拒绝的操作</span></h3>
      ${timelineHtml(t)}
    </div>`;
  drawer.classList.remove("hidden");
  $("#drawerMask").classList.remove("hidden");

  drawer.querySelector("[data-close]").onclick = closeDrawer;
  drawer.querySelectorAll("[data-action]").forEach((el) => (el.onclick = () => openActionModal(t, el.dataset.action)));
  const addGroup = drawer.querySelector("[data-add-group]");
  if (addGroup) addGroup.onclick = () => mutate(async () => api(`/api/tasks/${t.id}/groups`, { method: "POST", body: {} }), "已新增试磨组");
  drawer.querySelectorAll("[data-save-group]").forEach((el) => {
    el.onclick = () => {
      const form = drawer.querySelector(`[data-gform="${el.dataset.saveGroup}"]`);
      const body = {};
      form.querySelectorAll("input").forEach((inp) => { body[inp.name] = inp.value; });
      mutate(async () => api(`/api/tasks/${t.id}/groups/${el.dataset.saveGroup}`, { method: "PATCH", body }), "试磨记录已保存");
    };
  });
  drawer.querySelectorAll("[data-add-note]").forEach((el) => {
    el.onclick = () => {
      const input = drawer.querySelector(`[data-note-input="${el.dataset.addNote}"]`);
      const note = input.value.trim();
      if (!note) return toast("请先填写阶段意见", "err");
      mutate(async () => api(`/api/tasks/${t.id}/groups/${el.dataset.addNote}`, { method: "PATCH", body: { note } }), "阶段意见已添加");
    };
  });
}

// 变更后刷新详情与列表；幂等重放会提示
async function mutate(fn, okMsg) {
  if (state.pending) return;
  state.pending = true;
  try {
    const data = await fn();
    if (data.task) state.detail = data.task;
    if (data.idempotentReplay) toast("重复请求已被忽略（幂等）", "ok");
    else if (okMsg) toast(okMsg, "ok");
    renderDrawer();
    await loadAll();
  } catch (e) {
    toast(e.message, "err");
    // 被拒后刷新详情，时间线里能看到被拒记录
    if (state.detail) {
      try { state.detail = await api(`/api/tasks/${state.detail.id}`); renderDrawer(); } catch { /* 忽略 */ }
    }
  } finally {
    state.pending = false;
  }
}

/* ---------- 操作弹窗（退回原因 / 取消原因 / 指定试磨人 / 复评意见） ---------- */
function openActionModal(task, action) {
  const meta = ACTION_META[action];
  const actor = me();
  const operators = state.users.filter((u) => u.role === "operator");
  let inner = "";
  if (action === "return") inner = `<div class="frow"><label>退回原因（必填）</label><textarea name="reason" placeholder="如：A组沉淀异常，需重新试磨"></textarea></div>`;
  if (action === "cancel") inner = `<div class="frow"><label>取消原因（必填）</label><textarea name="reason" placeholder="如：墨锭样本损毁，任务终止"></textarea></div>`;
  if (action === "approve") inner = `<div class="frow"><label>复评意见（选填）</label><textarea name="comment" placeholder="如：两组数据一致，同意归档"></textarea></div>`;
  if (action === "start_grinding" && actor && actor.role === "admin") {
    inner = `<div class="frow"><label>指定试磨人</label><select name="grinderId">
      ${operators.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}（${esc(o.title)}）</option>`).join("")}
    </select></div>`;
  }
  const modal = $("#modal");
  modal.innerHTML = `
    <h3>${meta.label} · ${esc(task.code)}</h3>
    <form id="actionForm">
      ${inner}
      <div class="hint">当前状态「${esc(task.status)}」，操作将写入时间线，重复提交只会生效一次。</div>
      <div class="mfoot">
        <button type="button" class="btn ghost" data-mclose>取消</button>
        <button type="submit" class="btn ${meta.cls}">确认${meta.label}</button>
      </div>
    </form>`;
  modal.classList.remove("hidden");
  $("#modalMask").classList.remove("hidden");
  modal.querySelector("[data-mclose]").onclick = closeModal;
  modal.querySelector("#actionForm").onsubmit = (e) => {
    e.preventDefault();
    const body = { action, ...Object.fromEntries(new FormData(e.target).entries()) };
    closeModal();
    mutate(async () => api(`/api/tasks/${task.id}/transition`, { method: "POST", body }), `${meta.label}成功`);
  };
}
function closeModal() {
  $("#modal").classList.add("hidden");
  $("#modalMask").classList.add("hidden");
}

/* ---------- 新建任务弹窗 ---------- */
function openCreateModal() {
  const actor = me();
  if (!actor) return toast("请先在右上角选择操作身份", "err");
  if (!["operator", "admin"].includes(actor.role)) return toast(`${actor.roleLabel}无权创建任务`, "err");
  const modal = $("#modal");
  modal.innerHTML = `
    <h3>新建试磨任务</h3>
    <form id="createForm">
      <div class="fgrid">
        <div class="frow"><label>墨锭编号 *</label><input name="code" required placeholder="如：IS-006"></div>
        <div class="frow"><label>烟料来源</label><input name="smokeSource" placeholder="如：黄山松烟"></div>
        <div class="frow"><label>胶料比例</label><input name="glueRatio" placeholder="如：7.5%"></div>
        <div class="frow"><label>存放年限</label><input name="ageYears" type="number" min="0" step="1" placeholder="如：5"></div>
        <div class="frow"><label>存放位置</label><input name="storage" placeholder="如：恒湿柜B"></div>
        <div class="frow"><label>截止日期</label><input name="dueDate" type="date"></div>
      </div>
      <div class="frow"><label>备注</label><textarea name="note" placeholder="选填"></textarea></div>
      <div class="hint">创建后进入「待配样」，需添加试磨组并填写样本编号后才能进入排队。</div>
      <div class="mfoot">
        <button type="button" class="btn ghost" data-mclose>取消</button>
        <button type="submit" class="btn primary">创建任务</button>
      </div>
    </form>`;
  modal.classList.remove("hidden");
  $("#modalMask").classList.remove("hidden");
  modal.querySelector("[data-mclose]").onclick = closeModal;
  modal.querySelector("#createForm").onsubmit = (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    closeModal();
    mutate(async () => {
      const data = await api("/api/tasks", { method: "POST", body });
      state.detail = data.task;
      return data;
    }, "任务已创建");
  };
}

/* ---------- 初始化 ---------- */
async function init() {
  try {
    state.users = await api("/api/users");
  } catch (e) {
    return toast("无法连接服务器：" + e.message, "err");
  }
  const sel = $("#userSelect");
  sel.innerHTML =
    `<option value="">— 选择身份 —</option>` +
    state.users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)} · ${esc(u.roleLabel)}</option>`).join("");
  if (!state.users.some((u) => u.id === state.me)) state.me = "";
  sel.value = state.me;
  sel.onchange = () => {
    state.me = sel.value;
    localStorage.setItem("ink-room-user", state.me);
    if (state.detail) openTask(state.detail.id);
  };

  const statusSel = $("#statusFilter");
  statusSel.innerHTML = `<option value="">全部状态</option>` + STATUS_ORDER.map((s) => `<option>${s}</option>`).join("");
  statusSel.onchange = () => { state.filters.status = statusSel.value; loadAll().catch((e) => toast(e.message, "err")); };

  let qTimer = null;
  $("#searchInput").oninput = (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.filters.q = e.target.value.trim(); loadAll().catch((err) => toast(err.message, "err")); }, 250);
  };
  $("#overdueOnly").onchange = (e) => { state.filters.overdue = e.target.checked; loadAll().catch((err) => toast(err.message, "err")); };
  $("#mineOnly").onchange = (e) => {
    if (e.target.checked && !state.me) { e.target.checked = false; return toast("请先选择操作身份", "err"); }
    state.filters.mine = e.target.checked;
    loadAll().catch((err) => toast(err.message, "err"));
  };
  $("#refreshBtn").onclick = () => loadAll().then(() => toast("已刷新", "ok")).catch((e) => toast(e.message, "err"));
  $("#newTaskBtn").onclick = openCreateModal;
  $("#drawerMask").onclick = closeDrawer;
  $("#modalMask").onclick = closeModal;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); closeDrawer(); } });

  await loadAll();
  setInterval(() => loadAll().catch(() => {}), 30000); // 每 30 秒静默刷新，逾期提醒保持准确
}

init();
