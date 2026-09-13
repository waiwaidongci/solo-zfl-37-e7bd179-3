import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATA_FILE || join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);
const publicDir = join(__dirname, "public");

/* ---------------- 领域常量 ---------------- */

const STATUS = {
  SAMPLE: "待配样",
  QUEUED: "排队试磨",
  GRINDING: "试磨中",
  REVIEW: "待复评",
  ARCHIVED: "已归档",
  CANCELLED: "已取消",
};
const STATUS_ORDER = [STATUS.SAMPLE, STATUS.QUEUED, STATUS.GRINDING, STATUS.REVIEW, STATUS.ARCHIVED, STATUS.CANCELLED];
const TERMINAL = [STATUS.ARCHIVED, STATUS.CANCELLED];
const ROLE_LABEL = { admin: "管理员", operator: "试验员", reviewer: "复评员" };
// 每组试磨必须独立记录的字段
const GROUP_FIELDS = [
  ["formula", "配方"],
  ["paper", "纸样"],
  ["temperature", "温度"],
  ["humidity", "湿度"],
  ["sampleNo", "样本编号"],
];
const GROUP_EDIT_STATES = [STATUS.SAMPLE, STATUS.QUEUED, STATUS.GRINDING];

// 状态机：每个动作的来源状态、目标状态、允许角色
const ACTIONS = {
  sample_ready:   { label: "配样完成", from: [STATUS.SAMPLE],   to: STATUS.QUEUED,    roles: ["operator", "admin"] },
  start_grinding: { label: "开始试磨", from: [STATUS.QUEUED],   to: STATUS.GRINDING,  roles: ["operator", "admin"] },
  submit_review:  { label: "提交复评", from: [STATUS.GRINDING], to: STATUS.REVIEW,    roles: ["operator", "admin"] },
  approve:        { label: "复评通过", from: [STATUS.REVIEW],   to: STATUS.ARCHIVED,  roles: ["reviewer", "admin"] },
  return:         { label: "退回",     from: [STATUS.QUEUED, STATUS.GRINDING, STATUS.REVIEW], to: null, roles: ["reviewer", "admin"] },
  cancel:         { label: "取消任务", from: [STATUS.SAMPLE, STATUS.QUEUED, STATUS.GRINDING, STATUS.REVIEW], to: STATUS.CANCELLED, roles: ["admin", "operator"] },
};

const USERS = [
  { id: "admin",    name: "王守墨", role: "admin",    title: "试磨室主任" },
  { id: "op-li",    name: "李研",   role: "operator", title: "试验员" },
  { id: "op-chen",  name: "陈砚",   role: "operator", title: "试验员" },
  { id: "rev-zhao", name: "赵鉴",   role: "reviewer", title: "复评员" },
];

/* ---------------- 小工具 ---------------- */

function now() { return new Date().toISOString(); }
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function httpError(status, message, code = "error") {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
function isOverdue(task, todayStr = today()) {
  return Boolean(task.dueDate) && !TERMINAL.includes(task.status) && task.dueDate < todayStr;
}
function isDueSoon(task, todayStr = today()) {
  if (!task.dueDate || TERMINAL.includes(task.status) || task.dueDate <= todayStr) return false;
  return (Date.parse(task.dueDate) - Date.parse(todayStr)) / 86400000 <= 3;
}
function missingGroupFields(g) {
  const missing = GROUP_FIELDS
    .filter(([k]) => g[k] === undefined || g[k] === null || String(g[k]).trim() === "")
    .map(([, label]) => label);
  if (!g.notes || g.notes.length === 0) missing.push("阶段意见");
  return missing;
}

/* ---------------- 数据库（JSON 文件 + 原子写） ---------------- */

let db = null;
let saveChain = Promise.resolve();

async function saveDb() {
  // 串行化写盘，先写临时文件再改名，避免半截文件
  saveChain = saveChain.then(async () => {
    const tmp = dbPath + ".tmp";
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, dbPath);
  });
  return saveChain;
}

function emptyDb() {
  return { version: 2, users: USERS, tasks: [], idempotency: {}, counters: { task: 0, group: 0 } };
}

function nextId(kind) {
  db.counters[kind] = (db.counters[kind] || 0) + 1;
  return kind === "task" ? `T-${String(db.counters.task).padStart(4, "0")}` : `G-${db.counters.group}`;
}

function logEvent(task, actor, action, detail, result = "ok", from = null, to = null) {
  task.timeline.push({
    at: now(),
    actorId: actor ? actor.id : "system",
    actorName: actor ? actor.name : "系统",
    role: actor ? actor.role : "system",
    action,
    from,
    to,
    result, // ok | rejected
    detail: detail || "",
  });
}

function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }
function dateOffset(n) {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function seedDb() {
  if (process.env.SEED === "empty") return;
  const mk = (over) => {
    const t = {
      id: nextId("task"),
      code: "",
      smokeSource: "",
      glueRatio: "",
      ageYears: null,
      storage: "",
      status: STATUS.SAMPLE,
      createdBy: "op-li",
      createdAt: now(),
      updatedAt: now(),
      dueDate: null,
      grinderId: null,
      reviewerId: null,
      archivedAt: null,
      cancelReason: null,
      groups: [],
      timeline: [],
      ...over,
    };
    db.tasks.push(t);
    return t;
  };
  const mkGroup = (t, over) => {
    const g = {
      id: nextId("group"),
      name: `${String.fromCharCode(65 + t.groups.length)}组`,
      formula: "", paper: "", temperature: null, humidity: null, sampleNo: "", score: null,
      notes: [], createdAt: now(), updatedAt: now(), ...over,
    };
    t.groups.push(g);
    return g;
  };
  const ev = (t, actorId, action, from, to, detail, at) => {
    const u = USERS.find((x) => x.id === actorId);
    t.timeline.push({ at, actorId, actorName: u ? u.name : "系统", role: u ? u.role : "system", action, from, to, result: "ok", detail });
  };

  // 1. 待配样
  const t1 = mk({ code: "IS-001", smokeSource: "黄山松烟", glueRatio: "7.5%", ageYears: 8, storage: "恒湿柜B", dueDate: dateOffset(10), createdAt: daysAgo(1) });
  ev(t1, "op-li", "创建任务", null, STATUS.SAMPLE, "墨锭建档，等待配样", daysAgo(1));

  // 2. 试磨中（已逾期，且 A 组数据不完整 → 触发异常提示）
  const t2 = mk({ code: "IS-002", smokeSource: "桐油烟", glueRatio: "8%", ageYears: 3, storage: "试样盒C", status: STATUS.GRINDING, dueDate: dateOffset(-2), grinderId: "op-li", createdAt: daysAgo(9) });
  mkGroup(t2, { sampleNo: "S-002-A", paper: "净皮宣", notes: [{ at: daysAgo(2), by: "op-li", byName: "李研", stage: STATUS.GRINDING, text: "下墨尚可，待补配方与温湿度记录" }] });
  mkGroup(t2, { sampleNo: "S-002-B" });
  ev(t2, "op-chen", "创建任务", null, STATUS.SAMPLE, "墨锭建档", daysAgo(9));
  ev(t2, "op-chen", "配样完成", STATUS.SAMPLE, STATUS.QUEUED, "配样完成，共 2 组试磨样本", daysAgo(7));
  ev(t2, "op-li", "开始试磨", STATUS.QUEUED, STATUS.GRINDING, "试磨人：李研", daysAgo(5));

  // 3. 待复评（临期）
  const t3 = mk({ code: "IS-003", smokeSource: "漆烟", glueRatio: "6.5%", ageYears: 5, storage: "恒湿柜A", status: STATUS.REVIEW, dueDate: dateOffset(2), grinderId: "op-chen", createdBy: "op-chen", createdAt: daysAgo(12) });
  mkGroup(t3, { formula: "漆烟+6.5%胶，减水慢研", paper: "净皮宣", temperature: 22, humidity: 55, sampleNo: "S-003-A", score: 88,
    notes: [{ at: daysAgo(3), by: "op-chen", byName: "陈砚", stage: STATUS.GRINDING, text: "出墨快，墨色层次清楚，沉淀少" }] });
  ev(t3, "op-chen", "创建任务", null, STATUS.SAMPLE, "墨锭建档", daysAgo(12));
  ev(t3, "op-chen", "配样完成", STATUS.SAMPLE, STATUS.QUEUED, "配样完成，共 1 组试磨样本", daysAgo(10));
  ev(t3, "op-chen", "开始试磨", STATUS.QUEUED, STATUS.GRINDING, "试磨人：陈砚", daysAgo(8));
  ev(t3, "op-chen", "提交复评", STATUS.GRINDING, STATUS.REVIEW, "提交 1 组试磨结果，等待复评", daysAgo(3));

  // 4. 已归档
  const t4 = mk({ code: "IS-004", smokeSource: "黄山松烟", glueRatio: "7%", ageYears: 10, storage: "锦盒D", status: STATUS.ARCHIVED, dueDate: dateOffset(-6), grinderId: "op-li", reviewerId: "rev-zhao", archivedAt: daysAgo(4), createdAt: daysAgo(20) });
  mkGroup(t4, { formula: "松烟+7%胶", paper: "棉料宣", temperature: 21, humidity: 58, sampleNo: "S-004-A", score: 90,
    notes: [{ at: daysAgo(6), by: "op-li", byName: "李研", stage: STATUS.GRINDING, text: "磨感细腻，墨色乌亮" }] });
  ev(t4, "op-li", "创建任务", null, STATUS.SAMPLE, "墨锭建档", daysAgo(20));
  ev(t4, "op-li", "配样完成", STATUS.SAMPLE, STATUS.QUEUED, "配样完成，共 1 组试磨样本", daysAgo(15));
  ev(t4, "op-li", "开始试磨", STATUS.QUEUED, STATUS.GRINDING, "试磨人：李研", daysAgo(10));
  ev(t4, "op-li", "提交复评", STATUS.GRINDING, STATUS.REVIEW, "提交 1 组试磨结果，等待复评", daysAgo(6));
  ev(t4, "rev-zhao", "复评通过", STATUS.REVIEW, STATUS.ARCHIVED, "复评通过，任务归档", daysAgo(4));

  // 5. 排队试磨
  const t5 = mk({ code: "IS-005", smokeSource: "油烟", glueRatio: "8.5%", ageYears: 2, storage: "试样盒C", status: STATUS.QUEUED, dueDate: dateOffset(5), createdBy: "op-chen", createdAt: daysAgo(3) });
  mkGroup(t5, { sampleNo: "S-005-A" });
  ev(t5, "op-chen", "创建任务", null, STATUS.SAMPLE, "墨锭建档", daysAgo(3));
  ev(t5, "op-chen", "配样完成", STATUS.SAMPLE, STATUS.QUEUED, "配样完成，共 1 组试磨样本", daysAgo(2));
}

// 旧版数据（items 数组）迁移为任务中心结构
function migrate(raw) {
  const statusMap = { 待试磨: STATUS.QUEUED, 已试磨: STATUS.ARCHIVED, 重点观察: STATUS.GRINDING };
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    const t = {
      id: nextId("task"),
      code: item.code || item.id || "IS-?",
      smokeSource: item.smokeSource || "",
      glueRatio: item.glueRatio || "",
      ageYears: item.ageYears ?? null,
      storage: item.storage || "",
      status: statusMap[item.status] || STATUS.SAMPLE,
      createdBy: "admin",
      createdAt: now(),
      updatedAt: now(),
      dueDate: null,
      grinderId: null,
      reviewerId: null,
      archivedAt: null,
      cancelReason: null,
      groups: [],
      timeline: [],
    };
    logEvent(t, null, "数据迁移", `由旧版档案迁移（原状态：${item.status || "未知"}）`, "ok", null, t.status);
    for (const log of item.logs || []) {
      t.timeline.push({ at: log.at || now(), actorId: "system", actorName: "系统", role: "system", action: log.step || "记录", from: null, to: null, result: "ok", detail: log.note || "" });
    }
    for (const test of item.tests || []) {
      const g = {
        id: nextId("group"),
        name: `${String.fromCharCode(65 + t.groups.length)}组`,
        formula: "", paper: test.paper || "", temperature: null, humidity: null,
        sampleNo: "", score: test.score ?? null,
        notes: [{ at: test.at || now(), by: "system", byName: "系统", stage: t.status, text: `旧档试磨：加水${test.water || "-"}，出墨${test.speed || "-"}，层次${test.colorLayer || "-"}，沉淀${test.sediment || "-"}` }],
        createdAt: test.at || now(), updatedAt: test.at || now(),
      };
      t.groups.push(g);
    }
    db.tasks.push(t);
  }
}

async function loadDb() {
  await mkdir(dirname(dbPath), { recursive: true });
  if (!existsSync(dbPath)) {
    db = emptyDb();
    seedDb();
    await saveDb();
    return;
  }
  const raw = JSON.parse(await readFile(dbPath, "utf8"));
  if (raw.version === 2) {
    db = raw;
  } else {
    db = emptyDb();
    migrate(raw);
    await saveDb();
  }
}

/* ---------------- 领域逻辑 ---------------- */

function userById(id) { return db.users.find((u) => u.id === id); }
function nameOf(id) { const u = userById(id); return u ? u.name : ""; }
function findTask(id) { return db.tasks.find((t) => t.id === id || t.code === id); }

// 拒绝：记入时间线后抛错（可追溯越权/跳步/缺样本的尝试）
function reject(task, actor, actionLabel, message, status) {
  logEvent(task, actor, actionLabel, `已拒绝：${message}`, "rejected", task.status, task.status);
  throw httpError(status, message, "rejected");
}

function applyTransition(task, action, actor, input = {}) {
  const def = ACTIONS[action];
  if (!def) throw httpError(400, `未知操作「${action}」`, "bad_action");
  const label = def.label;
  if (!def.from.includes(task.status)) {
    reject(task, actor, label, `当前状态为「${task.status}」，不能执行「${label}」（需要状态：${def.from.join(" / ")}）`, 409);
  }
  if (!def.roles.includes(actor.role)) {
    reject(task, actor, label, `${ROLE_LABEL[actor.role]}无权执行「${label}」`, 403);
  }

  const from = task.status;
  let to = def.to;
  let detail = "";

  switch (action) {
    case "sample_ready": {
      if (!task.groups.length) reject(task, actor, label, "缺少样本：尚未建立任何试磨组，无法标记配样完成", 409);
      const noSample = task.groups.filter((g) => !String(g.sampleNo || "").trim()).map((g) => g.name);
      if (noSample.length) reject(task, actor, label, `缺少样本编号：${noSample.join("、")} 尚未填写样本编号`, 409);
      detail = `配样完成，共 ${task.groups.length} 组试磨样本`;
      break;
    }
    case "start_grinding": {
      let grinderId = actor.id;
      if (actor.role === "admin") {
        grinderId = String(input.grinderId || "");
        const grinder = userById(grinderId);
        // 试磨人须为试验员；主任（管理员）也可亲自下场试磨
        if (!grinder || !["operator", "admin"].includes(grinder.role)) {
          reject(task, actor, label, "管理员开始试磨时必须指定一名试验员（或主任本人）作为试磨人", 400);
        }
      }
      task.grinderId = grinderId;
      detail = `试磨人：${nameOf(grinderId)}`;
      break;
    }
    case "submit_review": {
      if (actor.role !== "admin" && actor.id !== task.grinderId) {
        reject(task, actor, label, `只有本任务的试磨人（${nameOf(task.grinderId) || "未指定"}）才能提交复评`, 403);
      }
      const incomplete = task.groups.map((g) => [g.name, missingGroupFields(g)]).filter(([, m]) => m.length);
      if (incomplete.length) {
        reject(task, actor, label, "试磨记录不完整：" + incomplete.map(([n, m]) => `${n} 缺 ${m.join("、")}`).join("；"), 409);
      }
      detail = `提交 ${task.groups.length} 组试磨结果，等待复评`;
      break;
    }
    case "approve": {
      if (actor.id === task.grinderId) reject(task, actor, label, "复评人不能是试磨人，请更换复评人", 403);
      task.reviewerId = actor.id;
      task.archivedAt = now();
      detail = input.comment ? `复评通过：${String(input.comment).slice(0, 200)}` : "复评通过，任务归档";
      break;
    }
    case "return": {
      const reason = String(input.reason || "").trim();
      if (!reason) reject(task, actor, label, "退回必须填写原因", 400);
      if (actor.role === "reviewer" && task.status !== STATUS.REVIEW) {
        reject(task, actor, label, "复评员只能退回「待复评」状态的任务", 403);
      }
      const backMap = { [STATUS.REVIEW]: STATUS.GRINDING, [STATUS.GRINDING]: STATUS.QUEUED, [STATUS.QUEUED]: STATUS.SAMPLE };
      to = backMap[task.status];
      if (to === STATUS.QUEUED) task.grinderId = null; // 退回排队，释放试磨人
      detail = `退回至「${to}」：${reason}`;
      break;
    }
    case "cancel": {
      const reason = String(input.reason || "").trim();
      if (!reason) reject(task, actor, label, "取消必须填写原因", 400);
      if (actor.role !== "admin" && actor.id !== task.createdBy) {
        reject(task, actor, label, "只有管理员或任务创建人才能取消任务", 403);
      }
      task.cancelReason = reason;
      task.cancelledAt = now();
      detail = `任务取消：${reason}`;
      break;
    }
  }

  task.status = to;
  task.updatedAt = now();
  logEvent(task, actor, label, detail, "ok", from, to);
  return task;
}

function availableActions(task, actor) {
  if (!actor) return [];
  const out = [];
  for (const [key, def] of Object.entries(ACTIONS)) {
    if (!def.from.includes(task.status)) continue;
    if (!def.roles.includes(actor.role)) continue;
    if (key === "submit_review" && actor.role !== "admin" && actor.id !== task.grinderId) continue;
    if (key === "approve" && actor.id === task.grinderId) continue;
    if (key === "cancel" && actor.role !== "admin" && actor.id !== task.createdBy) continue;
    if (key === "return" && actor.role === "reviewer" && task.status !== STATUS.REVIEW) continue;
    out.push(key);
  }
  return out;
}

function summarize(t) {
  return {
    id: t.id, code: t.code, smokeSource: t.smokeSource, glueRatio: t.glueRatio, ageYears: t.ageYears,
    storage: t.storage, status: t.status, dueDate: t.dueDate,
    overdue: isOverdue(t), dueSoon: isDueSoon(t),
    grinderId: t.grinderId, grinderName: nameOf(t.grinderId), reviewerName: nameOf(t.reviewerId),
    createdBy: t.createdBy, creatorName: nameOf(t.createdBy),
    groupCount: t.groups.length,
    incompleteGroups: t.groups.filter((g) => missingGroupFields(g).length).length,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

function detail(t, actor) {
  return {
    ...t,
    overdue: isOverdue(t),
    dueSoon: isDueSoon(t),
    grinderName: nameOf(t.grinderId),
    reviewerName: nameOf(t.reviewerId),
    creatorName: nameOf(t.createdBy),
    groups: t.groups.map((g) => ({ ...g, missing: missingGroupFields(g) })),
    availableActions: availableActions(t, actor),
  };
}

/* ---------------- HTTP 层 ---------------- */

let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw httpError(413, "请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "请求体不是合法 JSON", "bad_json");
  }
}

function getActor(req) {
  const id = req.headers["x-user-id"];
  return id ? userById(id) || null : null;
}

function rememberIdempotency(key, status, body) {
  db.idempotency[key] = { at: now(), status, body };
  const keys = Object.keys(db.idempotency);
  if (keys.length > 500) {
    keys.sort((a, b) => (db.idempotency[a].at < db.idempotency[b].at ? -1 : 1));
    for (const k of keys.slice(0, keys.length - 500)) delete db.idempotency[k];
  }
}

// 变更请求统一入口：身份校验 → 幂等短路 → 互斥锁内执行 → 落盘
function handleMutation(handler) {
  return async (req, res, url) => {
    try {
      const actor = getActor(req);
      if (!actor) return send(res, 401, { error: "unauthorized", message: "请先在页面右上角选择有效的操作身份" });
      const idemKey = req.headers["idempotency-key"];
      if (idemKey && db.idempotency[idemKey]) {
        const hit = db.idempotency[idemKey];
        return send(res, hit.status, { ...hit.body, idempotentReplay: true });
      }
      const result = await withLock(async () => {
        if (idemKey && db.idempotency[idemKey]) {
          const hit = db.idempotency[idemKey];
          return { status: hit.status, body: { ...hit.body, idempotentReplay: true } };
        }
        try {
          const out = await handler(req, actor, url);
          if (idemKey) rememberIdempotency(idemKey, out.status, out.body);
          await saveDb();
          return out;
        } catch (err) {
          await saveDb(); // 拒绝也要落盘：时间线里留下被拒记录
          throw err;
        }
      });
      send(res, result.status, result.body);
    } catch (err) {
      send(res, err.status || 500, { error: err.code || "error", message: err.message });
    }
  };
}

function coerceGroupField(key, value) {
  if (key === "temperature" || key === "humidity") {
    if (value === "" || value === null || value === undefined) return null;
    const n = Number(value);
    if (Number.isNaN(n)) throw httpError(400, `${key === "temperature" ? "温度" : "湿度"}必须是数字`, "bad_field");
    return n;
  }
  return String(value).trim();
}

const routes = {
  // 创建任务
  "POST /api/tasks": handleMutation(async (req, actor) => {
    if (!["operator", "admin"].includes(actor.role)) {
      throw httpError(403, `${ROLE_LABEL[actor.role]}无权创建任务`, "forbidden");
    }
    const input = await readBody(req);
    const code = String(input.code || "").trim();
    if (!code) throw httpError(400, "墨锭编号不能为空", "bad_field");
    if (db.tasks.some((t) => t.code === code)) throw httpError(409, `墨锭编号 ${code} 已存在，请勿重复建档`, "duplicate");
    if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) throw httpError(400, "截止日期格式应为 YYYY-MM-DD", "bad_field");
    const task = {
      id: nextId("task"),
      code,
      smokeSource: String(input.smokeSource || "").trim(),
      glueRatio: String(input.glueRatio || "").trim(),
      ageYears: input.ageYears === "" || input.ageYears == null ? null : Number(input.ageYears),
      storage: String(input.storage || "").trim(),
      status: STATUS.SAMPLE,
      createdBy: actor.id,
      createdAt: now(),
      updatedAt: now(),
      dueDate: input.dueDate || null,
      grinderId: null,
      reviewerId: null,
      archivedAt: null,
      cancelReason: null,
      groups: [],
      timeline: [],
    };
    logEvent(task, actor, "创建任务", input.note ? `墨锭建档：${String(input.note).slice(0, 200)}` : "墨锭建档，等待配样", "ok", null, STATUS.SAMPLE);
    db.tasks.unshift(task);
    return { status: 201, body: { task: detail(task, actor) } };
  }),

  // 新增试磨组
  "POST /api/tasks/:id/groups": handleMutation(async (req, actor, url) => {
    const task = findTask(url.pathname.split("/")[3]);
    if (!task) throw httpError(404, "任务不存在", "not_found");
    if (!["operator", "admin"].includes(actor.role)) throw httpError(403, `${ROLE_LABEL[actor.role]}无权新增试磨组`, "forbidden");
    if (!GROUP_EDIT_STATES.includes(task.status)) throw httpError(409, `当前状态为「${task.status}」，不能新增试磨组`, "bad_state");
    const input = await readBody(req);
    const i = task.groups.length;
    const g = {
      id: nextId("group"),
      name: String(input.name || "").trim() || (i < 26 ? `${String.fromCharCode(65 + i)}组` : `第${i + 1}组`),
      formula: "", paper: "", temperature: null, humidity: null, sampleNo: "", score: null,
      notes: [], createdAt: now(), updatedAt: now(),
    };
    for (const [k] of GROUP_FIELDS) if (input[k] !== undefined && input[k] !== "") g[k] = coerceGroupField(k, input[k]);
    if (input.score !== undefined && input.score !== "") g.score = Number(input.score);
    task.groups.push(g);
    task.updatedAt = now();
    logEvent(task, actor, "新增试磨组", `${g.name}（样本编号：${g.sampleNo || "未填"}）`);
    return { status: 201, body: { task: detail(task, actor), group: g } };
  }),

  // 修改试磨组 / 追加阶段意见
  "PATCH /api/tasks/:id/groups/:gid": handleMutation(async (req, actor, url) => {
    const parts = url.pathname.split("/");
    const task = findTask(parts[3]);
    if (!task) throw httpError(404, "任务不存在", "not_found");
    const g = task.groups.find((x) => x.id === parts[5]);
    if (!g) throw httpError(404, "试磨组不存在", "not_found");
    if (!["operator", "admin"].includes(actor.role)) throw httpError(403, `${ROLE_LABEL[actor.role]}无权修改试磨记录`, "forbidden");
    if (!GROUP_EDIT_STATES.includes(task.status)) throw httpError(409, `当前状态为「${task.status}」，试磨组已锁定`, "bad_state");
    const input = await readBody(req);
    const changed = [];
    for (const [k, label] of GROUP_FIELDS) {
      if (k in input) { g[k] = coerceGroupField(k, input[k]); changed.push(label); }
    }
    if ("score" in input) {
      const v = input.score === "" || input.score == null ? null : Number(input.score);
      if (v !== null && Number.isNaN(v)) throw httpError(400, "评分必须是数字", "bad_field");
      g.score = v;
      changed.push("评分");
    }
    if (input.note && String(input.note).trim()) {
      g.notes.push({ at: now(), by: actor.id, byName: actor.name, stage: task.status, text: String(input.note).trim().slice(0, 500) });
      changed.push("阶段意见");
    }
    if (!changed.length) throw httpError(400, "没有需要保存的修改", "bad_field");
    g.updatedAt = now();
    task.updatedAt = now();
    logEvent(task, actor, "更新试磨记录", `${g.name}：${changed.join("、")}`);
    return { status: 200, body: { task: detail(task, actor) } };
  }),

  // 状态流转
  "POST /api/tasks/:id/transition": handleMutation(async (req, actor, url) => {
    const task = findTask(url.pathname.split("/")[3]);
    if (!task) throw httpError(404, "任务不存在", "not_found");
    const input = await readBody(req);
    applyTransition(task, String(input.action || ""), actor, input);
    return { status: 200, body: { task: detail(task, actor) } };
  }),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(res, pathName) {
  const rel = pathName === "/" ? "index.html" : pathName.slice(1);
  const file = normalize(join(publicDir, rel));
  if (file !== join(publicDir, "index.html") && !file.startsWith(publicDir + sep)) {
    return send(res, 403, { error: "forbidden" });
  }
  if (!existsSync(file)) return send(res, 404, { error: "not_found" });
  const data = await readFile(file);
  res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;

    // 变更路由（带 :id 参数）
    for (const [key, handler] of Object.entries(routes)) {
      const [m, pattern] = key.split(" ");
      if (m !== method) continue;
      const pp = pattern.split("/").filter(Boolean);
      const ap = path.split("/").filter(Boolean);
      if (pp.length !== ap.length) continue;
      if (pp.every((seg, i) => seg.startsWith(":") || seg === ap[i])) return handler(req, res, url);
    }

    if (method === "GET" && (path === "/" || extname(path))) return serveStatic(res, path);

    if (method === "GET" && path === "/api/users") {
      return send(res, 200, db.users.map((u) => ({ ...u, roleLabel: ROLE_LABEL[u.role] })));
    }

    if (method === "GET" && path === "/api/tasks") {
      const status = url.searchParams.get("status") || "";
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const overdueOnly = url.searchParams.get("overdue") === "1";
      const actor = getActor(req);
      const mine = url.searchParams.get("mine") === "1" && actor;
      let list = db.tasks;
      if (status) list = list.filter((t) => t.status === status);
      if (overdueOnly) list = list.filter((t) => isOverdue(t));
      if (mine) list = list.filter((t) => [t.createdBy, t.grinderId, t.reviewerId].includes(actor.id));
      if (q) {
        list = list.filter((t) =>
          [t.code, t.smokeSource, t.glueRatio, t.storage, nameOf(t.grinderId), nameOf(t.createdBy)]
            .some((v) => String(v || "").toLowerCase().includes(q))
        );
      }
      return send(res, 200, list.map(summarize));
    }

    if (method === "GET" && path.startsWith("/api/tasks/")) {
      const task = findTask(path.split("/")[3]);
      if (!task) return send(res, 404, { error: "not_found", message: "任务不存在" });
      return send(res, 200, detail(task, getActor(req)));
    }

    if (method === "GET" && path === "/api/stats") {
      const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
      for (const t of db.tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      return send(res, 200, {
        byStatus,
        total: db.tasks.length,
        overdue: db.tasks.filter((t) => isOverdue(t)).length,
        dueSoon: db.tasks.filter((t) => isDueSoon(t)).length,
      });
    }

    if (method === "GET" && path === "/api/alerts") {
      const line = (t) => ({ id: t.id, code: t.code, status: t.status, dueDate: t.dueDate, grinderName: nameOf(t.grinderId) });
      return send(res, 200, {
        overdue: db.tasks.filter((t) => isOverdue(t)).map((t) => ({ ...line(t), days: Math.floor((Date.parse(today()) - Date.parse(t.dueDate)) / 86400000) })),
        dueSoon: db.tasks.filter((t) => isDueSoon(t)).map(line),
        incomplete: db.tasks
          .filter((t) => t.status === STATUS.GRINDING && t.groups.some((g) => missingGroupFields(g).length))
          .map((t) => ({ ...line(t), groups: t.groups.filter((g) => missingGroupFields(g).length).map((g) => g.name) })),
      });
    }

    send(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    send(res, error.status || 500, { error: error.code || "error", message: error.message });
  }
});

await loadDb();
server.listen(port, () => console.log(`墨锭试磨室 · 配方任务中心 listening on http://localhost:${port}（数据文件：${dbPath}）`));
