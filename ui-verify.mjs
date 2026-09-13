/* 墨锭试磨室 · 配方任务中心 —— 浏览器端验证（桌面 + 手机）
 * 重点覆盖：先试磨组填字段再添加阶段意见不丢数据、未保存修改被明确阻止、
 *           失败操作不清空表单、时间线展示被拒记录、手机端完整操作流。
 * 运行：node ui-verify.mjs（需要 playwright 与 chromium）
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { chromium } from "playwright";

const PORT = 3337;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_FILE = `/tmp/ink-ui-verify-${process.pid}.json`;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${extra ? " —— " + extra : ""}`); }
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}
// 等待「匹配预期文本」的 toast 出现——上一条 toast 会残留数秒，只看可见性会读到旧消息
async function waitToast(page, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  await page.waitForFunction((src) => {
    const t = document.querySelector("#toast");
    return t && !t.classList.contains("hidden") && new RegExp(src).test(t.textContent);
  }, re.source, { timeout: 8000 });
  return true;
}

let server = null;
let browser = null;
try {
  await rm(DATA_FILE, { force: true });
  server = spawn("node", ["server.js"], {
    env: { ...process.env, PORT: String(PORT), DATA_FILE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/users`); if (r.ok) break; } catch { /* 等待 */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  browser = await chromium.launch();

  /* ================= 桌面流程 ================= */
  console.log("\n■ 桌面端（1280×800）");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { failed++; failures.push("页面 JS 异常: " + e.message); console.log("  ✗ 页面 JS 异常:", e.message); });
  await page.goto(BASE, { waitUntil: "networkidle" });

  check("页面标题与统计芯片加载", (await page.title()).includes("配方任务中心") && (await page.locator("#statsRow .stat").count()) === 8);
  check("异常提醒条展示逾期任务", /IS-002/.test(await page.locator("#alertBar").textContent()));

  await page.selectOption("#userSelect", "op-li");

  // —— 新建任务弹窗 ——
  await page.click("#newTaskBtn");
  await page.fill('#createForm input[name="code"]', "IS-900");
  await page.fill('#createForm input[name="smokeSource"]', "测试松烟");
  await page.click('#createForm button[type="submit"]');
  check("新建任务成功", await waitToast(page, /任务已创建/));
  check("创建后抽屉自动打开新任务", /IS-900/.test(await page.locator("#drawer h2").textContent()));
  await page.click("#drawer [data-close]");

  // —— 核心场景：先填试磨组字段，再添加阶段意见，已填内容不丢失 ——
  await page.click('.card:has-text("IS-002")');
  await page.waitForSelector("#drawer:not(.hidden)");
  const groupA = page.locator("#drawer .group", { hasText: "A组" });
  await groupA.locator('input[name="formula"]').fill("松烟+8%胶（浏览器填写）");
  await groupA.locator('input[name="temperature"]').fill("23");
  await groupA.locator("[data-note-input]").fill("出墨顺畅，层次清楚");
  await groupA.locator("[data-add-note]").click();
  check("添加阶段意见成功", await waitToast(page, /阶段意见已添加/));
  const formulaAfter = await groupA.locator('input[name="formula"]').inputValue();
  check("添加阶段意见后已填配方不丢失", formulaAfter === "松烟+8%胶（浏览器填写）", `实际：${formulaAfter}`);
  const is002 = (await api("/api/tasks?q=IS-002"))[0];
  const detail = await api(`/api/tasks/${is002.id}`);
  const gA = detail.groups.find((g) => g.name === "A组");
  check("服务端已持久化配方与阶段意见", gA.formula.includes("浏览器填写") && gA.notes.some((n) => n.text.includes("出墨顺畅")));

  // —— 未保存修改：操作前明确阻止 ——
  const groupB = page.locator("#drawer .group", { hasText: "B组" });
  await groupB.locator('input[name="sampleNo"]').fill("S-002-B-改");
  const groupsBefore = await page.locator("#drawer .group").count();
  await page.click("#drawer [data-add-group]");
  check("有未保存修改时新增试磨组被阻止并提示", await waitToast(page, /未保存的修改/));
  check("阻止时未发出请求（组数不变）", (await page.locator("#drawer .group").count()) === groupsBefore);
  await groupB.locator("[data-save-group]").click();
  check("保存本组记录成功", await waitToast(page, /试磨记录已保存/));
  await page.click("#drawer [data-add-group]");
  check("保存后新增试磨组放行", await waitToast(page, /已新增试磨组/));
  check("新组已出现", (await page.locator("#drawer .group").count()) === groupsBefore + 1);

  // —— 失败操作：抽屉保持，不被清空 ——
  await page.click('#drawer [data-action="submit_review"]');
  await page.click('#modal button[type="submit"]');
  check("记录不完整时提交复评被拒并给出原因", await waitToast(page, /不完整|缺/));
  check("失败后抽屉保持打开", await page.locator("#drawer:not(.hidden)").isVisible());
  await page.click("#drawer [data-close]");
  await page.click('.card:has-text("IS-002")');
  await page.waitForSelector("#drawer:not(.hidden)");
  check("时间线展示被拒绝的记录", (await page.locator("#drawer .timeline li.rejected").count()) >= 1);
  await page.click("#drawer [data-close]");
  await ctx.close();

  /* ================= 手机流程 ================= */
  console.log("\n■ 手机端（390×844，触屏）");
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const mp = await mctx.newPage();
  mp.on("pageerror", (e) => { failed++; failures.push("手机端 JS 异常: " + e.message); console.log("  ✗ 手机端 JS 异常:", e.message); });
  await mp.goto(BASE, { waitUntil: "networkidle" });

  check("手机端统计芯片与异常条可见", (await mp.locator("#statsRow .stat").count()) === 8 && (await mp.locator("#alertBar:not(.hidden)").isVisible()));
  // 点统计芯片筛选
  await mp.locator('#statsRow .stat:has-text("试磨中")').click();
  const pills = await mp.locator("#taskList .card .pill").allTextContents();
  check("点统计芯片筛选任务列表", pills.length >= 1 && pills.every((p) => p.includes("试磨中")), pills.join(","));
  await mp.locator('#statsRow .stat:has-text("全部")').click();

  // 复评员身份：无权新建任务
  await mp.selectOption("#userSelect", "rev-zhao");
  await mp.click("#newTaskBtn");
  check("复评员新建任务被阻止", await waitToast(mp, /无权创建任务/));

  // 手机端完成一次复评归档
  await mp.click('.card:has-text("IS-003")');
  await mp.waitForSelector("#drawer:not(.hidden)");
  const drawerW = await mp.locator("#drawer").evaluate((el) => el.getBoundingClientRect().width);
  check("手机端抽屉全宽可操作", Math.abs(drawerW - 390) <= 2, `宽 ${drawerW}`);
  await mp.click('#drawer [data-action="approve"]');
  await mp.fill('#modal textarea[name="comment"]', "手机端复评：同意归档");
  await mp.click('#modal button[type="submit"]');
  check("手机端复评通过成功", await waitToast(mp, /复评通过成功/));
  const is003 = (await api("/api/tasks?q=IS-003"))[0];
  check("服务端状态已归档", is003.status === "已归档");
  check("手机端时间线可见复评记录", (await mp.locator('#drawer .timeline li:has-text("复评通过")').count()) >= 1);
  await mctx.close();
} catch (err) {
  failed++;
  failures.push("运行异常: " + err.message);
  console.error("\n运行异常：", err);
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
  await rm(DATA_FILE, { force: true });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failures.length) {
  console.log("失败项：\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log("浏览器验证全部通过 ✓");
