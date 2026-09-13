/* 墨锭试磨室 · 配方任务中心 —— 端到端验证
 * 覆盖：状态机流转、角色/前置条件/样本校验、复评人≠试磨人、退回/取消、
 *       幂等重放、并发只生效一次、重启持久化、逾期提醒、时间线可追溯。
 * 运行：node verify.mjs
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const PORT = 3137;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_FILE = `/tmp/ink-verify-${process.pid}.json`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? " —— " + extra : ""}`);
  }
}

async function req(method, path, { user, body, idem } = {}) {
  const headers = {};
  if (user) headers["X-User-Id"] = user;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/api/users");
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("服务器启动超时");
}

function startServer() {
  const child = spawn("node", ["server.js"], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE, SEED: "empty" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  return child;
}
async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  await new Promise((r) => { child.once("exit", r); setTimeout(r, 2000); });
}

// 快捷推进：建任务 → 加组(带样本编号) → 配样完成 → 开始试磨
async function makeQueuedTask(code, user = "op-li") {
  const c = await req("POST", "/api/tasks", { user, body: { code, smokeSource: "松烟", glueRatio: "7%", dueDate: "2099-01-01" } });
  const id = c.data.task.id;
  await req("POST", `/api/tasks/${id}/groups`, { user, body: { sampleNo: `${code}-A` } });
  await req("POST", `/api/tasks/${id}/transition`, { user, body: { action: "sample_ready" } });
  return id;
}
async function completeGroups(id, user = "op-li") {
  const d = await req("GET", `/api/tasks/${id}`, { user });
  for (const g of d.data.groups) {
    await req("PATCH", `/api/tasks/${id}/groups/${g.id}`, {
      user,
      body: { formula: "松烟+7%胶", paper: "净皮宣", temperature: 22, humidity: 55, note: "出墨顺畅" },
    });
  }
}

let server = null;
try {
  await rm(DATA_FILE, { force: true });
  server = startServer();
  await waitUp();
  console.log("\n■ 基础与身份校验");
  {
    const r = await req("GET", "/api/users");
    check("服务启动，用户列表可读取", r.status === 200 && r.data.length === 4);
    const noAuth = await req("POST", "/api/tasks", { body: { code: "X-1" } });
    check("未选择身份的变更被拒绝(401)", noAuth.status === 401);
  }

  console.log("\n■ 创建任务与幂等");
  let taskId;
  {
    const key = "create-" + Date.now();
    const a = await req("POST", "/api/tasks", { user: "op-li", body: { code: "V-001", smokeSource: "黄山松烟", glueRatio: "7.5%", dueDate: "2099-12-31" }, idem: key });
    check("试验员可创建任务(201)，初始状态待配样", a.status === 201 && a.data.task.status === "待配样");
    taskId = a.data.task.id;
    const b = await req("POST", "/api/tasks", { user: "op-li", body: { code: "V-001", smokeSource: "黄山松烟" }, idem: key });
    check("相同幂等键重放返回同一任务，不产生重复", b.status === 201 && b.data.task.id === taskId && b.data.idempotentReplay === true);
    const list = await req("GET", "/api/tasks?q=V-001");
    check("列表中 V-001 只有一条", list.data.filter((t) => t.code === "V-001").length === 1);
    const dup = await req("POST", "/api/tasks", { user: "op-li", body: { code: "V-001" } });
    check("无幂等键的重复编号被拒绝(409)", dup.status === 409);
    const denied = await req("POST", "/api/tasks", { user: "rev-zhao", body: { code: "V-002" } });
    check("复评员创建任务被越权拒绝(403)", denied.status === 403 && /无权/.test(denied.data.message));
  }

  console.log("\n■ 前置条件：缺样本 / 跳步 / 越权");
  {
    const r1 = await req("POST", `/api/tasks/${taskId}/transition`, { user: "op-li", body: { action: "sample_ready" } });
    check("无试磨组时配样完成被拒(409)，提示缺少样本", r1.status === 409 && /缺少样本/.test(r1.data.message));
    const r2 = await req("POST", `/api/tasks/${taskId}/transition`, { user: "op-li", body: { action: "submit_review" } });
    check("待配样直接提交复评被跳步拒绝(409)", r2.status === 409 && /待配样/.test(r2.data.message));
    const g = await req("POST", `/api/tasks/${taskId}/groups`, { user: "op-li", body: {} });
    check("可新增试磨组", g.status === 201);
    const r3 = await req("POST", `/api/tasks/${taskId}/transition`, { user: "op-li", body: { action: "sample_ready" } });
    check("试磨组缺样本编号时配样完成被拒(409)", r3.status === 409 && /样本编号/.test(r3.data.message));
    const gid = g.data.group.id;
    const patch = await req("PATCH", `/api/tasks/${taskId}/groups/${gid}`, { user: "op-li", body: { sampleNo: "S-V001-A" } });
    check("填写样本编号成功", patch.status === 200);
    const r4 = await req("POST", `/api/tasks/${taskId}/transition`, { user: "rev-zhao", body: { action: "sample_ready" } });
    check("复评员执行配样完成被越权拒绝(403)", r4.status === 403);
    const r5 = await req("POST", `/api/tasks/${taskId}/transition`, { user: "op-li", body: { action: "sample_ready" } });
    check("样本齐全后配样完成 → 排队试磨", r5.status === 200 && r5.data.task.status === "排队试磨");
  }

  console.log("\n■ 完整流转：排队 → 试磨 → 提交复评 → 归档（复评人≠试磨人）");
  {
    const s1 = await req("POST", `/api/tasks/${taskId}/transition`, { user: "op-li", body: { action: "start_grinding" } });
    check("试验员开始试磨并成为试磨人", s1.status === 200 && s1.data.task.status === "试磨中" && s1.data.task.grinderId === "op-li");
    const other = await req("POST", `/api/tasks/${taskId}/transition`, { user: "op-chen", body: { action: "submit_review" } });
    check("非试磨人提交复评被拒(403)", other.status === 403 && /试磨人/.test(other.data.message));
    const incomplete = await req("POST", `/api/tasks/${taskId}/transition`, { user: "op-li", body: { action: "submit_review" } });
    check("记录不完整时提交复评被拒(409)，列出缺项", incomplete.status === 409 && /缺/.test(incomplete.data.message));
    await completeGroups(taskId);
    const s2 = await req("POST", `/api/tasks/${taskId}/transition`, { user: "op-li", body: { action: "submit_review" } });
    check("记录补齐后提交复评 → 待复评", s2.status === 200 && s2.data.task.status === "待复评");
    const selfReview = await req("POST", `/api/tasks/${taskId}/transition`, { user: "op-li", body: { action: "approve" } });
    check("试磨人（试验员）复评被拒(403)", selfReview.status === 403);
    const opApprove = await req("POST", `/api/tasks/${taskId}/transition`, { user: "op-chen", body: { action: "approve" } });
    check("试验员复评被越权拒绝(403)", opApprove.status === 403);
    const ok = await req("POST", `/api/tasks/${taskId}/transition`, { user: "rev-zhao", body: { action: "approve", comment: "数据一致，同意归档" } });
    check("复评员复评通过 → 已归档", ok.status === 200 && ok.data.task.status === "已归档" && ok.data.task.reviewerId === "rev-zhao");
    const after = await req("POST", `/api/tasks/${taskId}/transition`, { user: "admin", body: { action: "cancel", reason: "x" } });
    check("已归档任务不可再操作(409)", after.status === 409);
  }

  console.log("\n■ 复评人不能是试磨人（主任兼试磨场景）");
  {
    const id = await makeQueuedTask("V-040", "admin");
    const s = await req("POST", `/api/tasks/${id}/transition`, { user: "admin", body: { action: "start_grinding", grinderId: "admin" } });
    check("主任可指定自己为试磨人", s.status === 200 && s.data.task.grinderId === "admin");
    await completeGroups(id, "admin");
    await req("POST", `/api/tasks/${id}/transition`, { user: "admin", body: { action: "submit_review" } });
    const selfApprove = await req("POST", `/api/tasks/${id}/transition`, { user: "admin", body: { action: "approve" } });
    check("主任磨的任务由主任复评被拒(403)，提示复评人不能是试磨人", selfApprove.status === 403 && /复评人不能是试磨人/.test(selfApprove.data.message));
    const cross = await req("POST", `/api/tasks/${id}/transition`, { user: "rev-zhao", body: { action: "approve" } });
    check("改由复评员复评 → 已归档", cross.status === 200 && cross.data.task.status === "已归档");
  }

  console.log("\n■ 退回与取消");
  {
    const id = await makeQueuedTask("V-010", "op-chen");
    await req("POST", `/api/tasks/${id}/transition`, { user: "op-chen", body: { action: "start_grinding" } });
    await completeGroups(id, "op-chen");
    await req("POST", `/api/tasks/${id}/transition`, { user: "op-chen", body: { action: "submit_review" } });
    const noReason = await req("POST", `/api/tasks/${id}/transition`, { user: "rev-zhao", body: { action: "return" } });
    check("退回必须填原因(400)", noReason.status === 400);
    const back = await req("POST", `/api/tasks/${id}/transition`, { user: "rev-zhao", body: { action: "return", reason: "A组沉淀异常，重新试磨" } });
    check("复评员退回待复评 → 试磨中", back.status === 200 && back.data.task.status === "试磨中");
    const back2 = await req("POST", `/api/tasks/${id}/transition`, { user: "admin", body: { action: "return", reason: "环境记录缺失" } });
    check("管理员退回试磨中 → 排队试磨，试磨人释放", back2.status === 200 && back2.data.task.status === "排队试磨" && back2.data.task.grinderId === null);
    const wrongRole = await req("POST", `/api/tasks/${id}/transition`, { user: "op-li", body: { action: "return", reason: "r" } });
    check("试验员退回被越权拒绝(403)", wrongRole.status === 403);
    const cancelNoReason = await req("POST", `/api/tasks/${id}/transition`, { user: "admin", body: { action: "cancel" } });
    check("取消必须填原因(400)", cancelNoReason.status === 400);
    const cancelWrong = await req("POST", `/api/tasks/${id}/transition`, { user: "op-li", body: { action: "cancel", reason: "r" } });
    check("非创建人非管理员取消被拒(403)", cancelWrong.status === 403);
    const cancel = await req("POST", `/api/tasks/${id}/transition`, { user: "admin", body: { action: "cancel", reason: "样本损毁" } });
    check("管理员取消 → 已取消", cancel.status === 200 && cancel.data.task.status === "已取消");
  }

  console.log("\n■ 并发与重复请求只生效一次");
  {
    const id = await makeQueuedTask("V-020");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => req("POST", `/api/tasks/${id}/transition`, { user: "op-li", body: { action: "start_grinding" } }))
    );
    const okCount = results.filter((r) => r.status === 200).length;
    check("5 个并发开始试磨只有 1 个生效", okCount === 1, `实际成功 ${okCount} 个`);
    const d = await req("GET", `/api/tasks/${id}`);
    const okEvents = d.data.timeline.filter((e) => e.action === "开始试磨" && e.result === "ok");
    check("时间线中只有一条「开始试磨」成功记录", okEvents.length === 1);
    const key = "burst-" + Date.now();
    const burst = await Promise.all(
      Array.from({ length: 4 }, () => req("POST", "/api/tasks", { user: "op-li", body: { code: "V-021" }, idem: key }))
    );
    const ids = new Set(burst.map((r) => r.data.task && r.data.task.id));
    const list = await req("GET", "/api/tasks?q=V-021");
    check("同幂等键并发创建只生成一个任务", ids.size === 1 && list.data.filter((t) => t.code === "V-021").length === 1);
  }

  console.log("\n■ 逾期提醒与统计");
  {
    const y = new Date(Date.now() - 86400000 * 2);
    const past = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
    const c = await req("POST", "/api/tasks", { user: "op-li", body: { code: "V-030", dueDate: past } });
    const alerts = await req("GET", "/api/alerts");
    check("逾期任务出现在异常提醒中", alerts.data.overdue.some((t) => t.code === "V-030"));
    const stats = await req("GET", "/api/stats");
    check("统计包含各状态数量与逾期数", typeof stats.data.byStatus["待配样"] === "number" && stats.data.overdue >= 1);
    const filtered = await req("GET", "/api/tasks?overdue=1");
    check("逾期筛选生效", filtered.data.length >= 1 && filtered.data.every((t) => t.overdue));
    void c;
  }

  console.log("\n■ 时间线可追溯（含被拒记录）");
  {
    const d = await req("GET", `/api/tasks/${taskId}`);
    const actions = d.data.timeline.map((e) => `${e.action}:${e.result}`);
    const need = ["创建任务:ok", "配样完成:ok", "开始试磨:ok", "提交复评:ok", "复评通过:ok"];
    check("完整流转的每一步都在时间线中", need.every((n) => actions.includes(n)), actions.join(","));
    check("被拒绝的越权/跳步尝试也留痕", d.data.timeline.some((e) => e.result === "rejected"));
    check("每条记录含操作人与时间", d.data.timeline.every((e) => e.actorName && e.at));
  }

  console.log("\n■ 重启持久化");
  {
    const beforeCount = (await req("GET", "/api/tasks")).data.length;
    await stopServer(server);
    server = startServer();
    await waitUp();
    const d = await req("GET", `/api/tasks/${taskId}`);
    check("重启后任务状态保持（已归档）", d.status === 200 && d.data.status === "已归档");
    check("重启后时间线完整保留", d.data.timeline.length >= 8);
    const stats = await req("GET", "/api/stats");
    check("重启后统计正确", stats.data.byStatus["已归档"] >= 1 && stats.data.byStatus["已取消"] >= 1);
    const replay = await req("GET", "/api/tasks");
    check("重启后任务总数不丢", replay.data.length === beforeCount, `重启前 ${beforeCount}，重启后 ${replay.data.length}`);
  }

  console.log("\n■ 演示种子数据启动");
  {
    await stopServer(server);
    await rm(DATA_FILE, { force: true });
    const seeded = spawn("node", ["server.js"], {
      env: { ...process.env, PORT: String(PORT), DATA_FILE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server = seeded;
    seeded.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
    await waitUp();
    const list = await req("GET", "/api/tasks");
    check("空库启动生成演示任务（含各状态）", list.data.length === 5 && new Set(list.data.map((t) => t.status)).size >= 4);
    const alerts = await req("GET", "/api/alerts");
    check("种子数据自带逾期与数据不完整提醒", alerts.data.overdue.length >= 1 && alerts.data.incomplete.length >= 1);
  }
} catch (err) {
  failed++;
  failures.push("运行异常: " + err.message);
  console.error("\n运行异常：", err);
} finally {
  await stopServer(server);
  await rm(DATA_FILE, { force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failures.length) {
  console.log("失败项：\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log("全部验证通过 ✓");
