// 許願房寫入的「開閘」單測（2026-10-09，SQLite 退場主線批 D）。
//
// 開閘（PG_NO_SQLITE_OPEN=1、DB_DRIVER=postgres）後，`sqliteHandle()` 回傳帶
// DSH_NO_OPEN_MARKER 的拋錯 proxy；demandAsync.js 的六支寫入必須：
//   ① 開閘時**不執行本機鏡射、不執行同步 fallback**（db.prepare/db.exec 零呼叫），
//      PG 寫入照常發生；
//   ② PG 寫入 reject 時抛**原始錯誤**，不得回退同步 SQLite 版（回退會變成
//      「business SQLite is closed」把原始錯誤蓋掉）；
//   ③ 讀取 fallback（getDemandPostAsync）開閘時同樣不得回退同步版（#678 同形）。
//
// 用子行程（與 pg-no-sqlite-open.test.js 同一個做法）在乾淨 process 各 import 一次，
// 避免 ESM 模組快取互相污染。開閘子行程的 `sqliteHandle()` 是拋錯 proxy，但 pgFixture 仍
// 從**預先建好的磁碟 v3.db**（父行程以未開閘模式 import db.js 產生）鏡射 DDL 到記憶體
// SQLite 當 PG 替身——所以「PG 寫入有發生」與「SQLite 沒被碰到」是分得開的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const v3Dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const demandAsyncUrl = pathToFileURL(join(v3Dir, "src", "demandAsync.js")).href;

// 父行程先以未開閘模式 import db.js，建立磁碟 v3.db（子行程的 pgFixture 要靠它鏡射 DDL）。
const dataDir = mkdtempSync(join(tmpdir(), "v3-demand-gate-"));
process.env.DATA_DIR = dataDir;
const dbMod = await import("../src/db.js");
const { sqliteHandleIsUsable } = await import("../src/sqliteHandle.js");

const PROBE = `
const { writeFileSync } = await import("node:fs");
const { DatabaseSync } = await import("node:sqlite");
const path = await import("node:path");
const demandAsync = await import(process.env.DEMAND_ASYNC_URL);

const dataDir = process.env.DATA_DIR;
const diskPath = path.join(dataDir, "v3.db");
const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-28T00:00:00.000Z";

const TABLES = ["users", "demand_posts", "demand_replies", "demand_reports", "demand_match_districts", "user_listing_flags", "wish_room_example", "wish_offers", "settings", "rental_analytics_daily", "listing_contact_profile"];

// PG 替身：記憶體 SQLite ＋ 從磁碟鏡射 DDL（與 demand-async.test.js 同一個做法）。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath, { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    if (rows.length !== 1) throw new Error("必須抓到 " + t + " 的 DDL");
    mem.exec(rows[0].sql);
  }
  disk.close();
  const base = async (sql, params = []) => {
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
  base.raw = mem;
  return base;
}

function clear(h) {
  h.prepare("DELETE FROM demand_reports").run();
  h.prepare("DELETE FROM demand_replies").run();
  h.prepare("DELETE FROM demand_posts").run();
  h.prepare("DELETE FROM demand_match_districts").run();
  h.prepare("DELETE FROM wish_room_example").run();
  h.prepare("DELETE FROM wish_offers").run();
  h.prepare("DELETE FROM settings").run();
  h.prepare("DELETE FROM rental_analytics_daily").run();
  h.prepare("DELETE FROM listing_contact_profile").run();
  h.prepare("DELETE FROM users WHERE email LIKE 'gate%@example.com'").run();
  h.prepare("UPDATE users SET nickname = '屋主甲', created_at = ? WHERE id = 1").run(OLD);
}

function seedUser(h, id) {
  h.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'free', ?)")
    .run(id, "gate" + id + "@example.com", "會員" + id, OLD);
}

function seedPost(h, id, status = "open", lifecycle = null, closedReason = "") {
  h.prepare(
    "INSERT INTO demand_posts(id, user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, expires_at, public_token, legacy_numeric_share, lifecycle, closed_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, 1, '["1-5"]', 30000, "any", 0, "找房的內容", status, NOW, "2099-01-01T00:00:00.000Z", "tok-" + id, 1, lifecycle, closedReason);
}

function seedReport(h, id, userId) {
  h.prepare("INSERT INTO demand_reports(id, target_type, target_id, user_id, reason, created_at) VALUES (?, 'post', 601, ?, '', ?)")
    .run(id, userId, NOW);
}

function makeExec() {
  const base = pgFixture();
  const writes = [];
  const exec = async (sql, params = []) => {
    const res = await base(sql, params);
    if (/^\\s*(INSERT|UPDATE|DELETE)\\b/i.test(sql)) writes.push(sql.replace(/\\s+/g, " ").trim());
    return res;
  };
  exec.raw = base.raw;
  exec.writes = writes;
  return exec;
}

function reset() {
  const exec = makeExec();
  clear(exec.raw);
  seedUser(exec.raw, 1);
  seedUser(exec.raw, 2);
  return exec;
}

const out = { success: {}, reject: {}, readFallback: {} };
const run = async (label, fn) => {
  try { return { threw: false, value: await fn() }; }
  catch (e) { return { threw: true, message: e.message, code: e.code || "" }; }
};

// ── ① 開閘：六支寫入不碰 SQLite、PG 寫入有發生 ─────────────────────────────
{
  let exec = reset();
  seedPost(exec.raw, 601, "open");
  seedReport(exec.raw, 1, 999); // 檢舉計數要 >= 2 才會觸發隱藏（先塞一筆別人的）
  const r = await run("report", () => demandAsync.reportDemandAsync(1, { targetType: "post", targetId: 601, reason: "x" }, { driver: "postgres", exec, strict: true, now: NOW }));
  out.success.reportDemandAsync = { threw: r.threw, message: r.message, writes: exec.writes.length };
}
{
  let exec = reset();
  seedPost(exec.raw, 601, "open");
  const r = await run("reply", () => demandAsync.addDemandReplyAsync(1, 601, "回覆內容", { driver: "postgres", exec, strict: true, now: NOW }));
  out.success.addDemandReplyAsync = { threw: r.threw, message: r.message, writes: exec.writes.length };
}
{
  let exec = reset();
  seedPost(exec.raw, 601, "open");
  const r = await run("close", () => demandAsync.closeDemandPostAsync(1, 601, {}, { driver: "postgres", exec, strict: true, now: NOW }));
  out.success.closeDemandPostAsync = { threw: r.threw, message: r.message, writes: exec.writes.length };
}
{
  let exec = reset();
  seedPost(exec.raw, 601, "open");
  const r = await run("update", () => demandAsync.updateWishRoomAsync(1, 601, { districts: ["1-5"], body: "更新的內容" }, { driver: "postgres", exec, strict: true, now: NOW }));
  out.success.updateWishRoomAsync = { threw: r.threw, message: r.message, writes: exec.writes.length };
}
{
  let exec = reset();
  seedPost(exec.raw, 601, "draft");
  const r = await run("publish", () => demandAsync.publishWishRoomAsync(1, 601, { districts: ["1-5"], body: "刊登的內容" }, { driver: "postgres", exec, strict: true, now: NOW }));
  out.success.publishWishRoomAsync = { threw: r.threw, message: r.message, writes: exec.writes.length };
}
{
  let exec = reset();
  seedPost(exec.raw, 601, "closed", "paused", "paused");
  const r = await run("reopen", () => demandAsync.reopenWishRoomAsync(1, 601, { driver: "postgres", exec, strict: true, now: NOW }));
  out.success.reopenWishRoomAsync = { threw: r.threw, message: r.message, writes: exec.writes.length };
}

// ── ② 開閘：PG 寫入 reject ⇒ 抛原始錯誤，不回退同步版 ────────────────────────
const FNS = {
  reportDemandAsync: (exec) => demandAsync.reportDemandAsync(1, { targetType: "post", targetId: 601, reason: "x" }, { driver: "postgres", exec, now: NOW }),
  addDemandReplyAsync: (exec) => demandAsync.addDemandReplyAsync(1, 601, "回覆內容", { driver: "postgres", exec, now: NOW }),
  closeDemandPostAsync: (exec) => demandAsync.closeDemandPostAsync(1, 601, {}, { driver: "postgres", exec, now: NOW }),
  updateWishRoomAsync: (exec) => demandAsync.updateWishRoomAsync(1, 601, { districts: ["1-5"], body: "更新的內容" }, { driver: "postgres", exec, now: NOW }),
  publishWishRoomAsync: (exec) => demandAsync.publishWishRoomAsync(1, 601, { districts: ["1-5"], body: "刊登的內容" }, { driver: "postgres", exec, now: NOW }),
  reopenWishRoomAsync: (exec) => demandAsync.reopenWishRoomAsync(1, 601, { driver: "postgres", exec, now: NOW }),
};
for (const [name, call] of Object.entries(FNS)) {
  const exec = reset();
  seedPost(exec.raw, 601, name === "publishWishRoomAsync" ? "draft" : (name === "reopenWishRoomAsync" ? "closed" : "open"));
  if (name === "reopenWishRoomAsync") {
    exec.raw.prepare("UPDATE demand_posts SET lifecycle='paused', closed_reason='paused' WHERE id=601").run();
  }
  if (name === "reportDemandAsync") seedReport(exec.raw, 1, 999);
  // 寫入才 reject：任何 INSERT/UPDATE/DELETE 都丟原始錯誤。
  const base = exec;
  const rejectExec = async (sql, params = []) => {
    if (/^\\s*(INSERT|UPDATE|DELETE)\\b/i.test(sql)) {
      const e = new Error("PG_WRITE_REJECTED");
      e.code = "P0001";
      throw e;
    }
    return base(sql, params);
  };
  const r = await run("reject:" + name, () => call(rejectExec));
  out.reject[name] = { threw: r.threw, message: r.message };
}

// ── ③ 讀取 fallback：開閘 + PG 讀取失敗 ⇒ 抛原始錯誤，不回退同步版 ──────────
{
  const exec = reset();
  const rejectReadExec = async () => { const e = new Error("PG_READ_REJECTED"); throw e; };
  const r = await run("readFallback", () => demandAsync.getDemandPostAsync(601, { viewerId: 1 }, { driver: "postgres", exec: rejectReadExec }));
  out.readFallback.getDemandPostAsync = { threw: r.threw, message: r.message };
}

writeFileSync(process.env.RESULT_FILE, JSON.stringify(out));
`;

function probe() {
  const resultFile = join(dataDir, "result.json");
  const childEnv = {
    ...process.env,
    DEMAND_ASYNC_URL: demandAsyncUrl,
    DATA_DIR: dataDir,
    RESULT_FILE: resultFile,
    DB_DRIVER: "postgres",
    PG_NO_SQLITE_OPEN: "1",
  };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], {
    cwd: v3Dir,
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status !== 0) {
    return { error: `child exited ${r.status}: ${String(r.stderr).slice(0, 1500)}` };
  }
  return JSON.parse(readFileSync(resultFile, "utf8"));
}

let cached;
function result() {
  if (!cached) cached = probe();
  return cached;
}

test("開閘：六支寫入不碰 SQLite（db.prepare/db.exec 零呼叫）、PG 寫入有發生", () => {
  const out = result();
  assert.equal(out.error, undefined, `child 不該失敗：${out.error}`);
  const names = ["reportDemandAsync", "addDemandReplyAsync", "closeDemandPostAsync", "updateWishRoomAsync", "publishWishRoomAsync", "reopenWishRoomAsync"];
  for (const name of names) {
    const s = out.success[name];
    assert.equal(s.threw, false, `${name} 開閘時不得抛錯（若抛 business SQLite is closed 代表碰到 db.prepare/db.exec）：${s.message}`);
    assert.doesNotMatch(s.message || "", /business SQLite is closed/, `${name} 不得碰 SQLite proxy`);
    assert.ok(s.writes > 0, `${name} 的 PG 寫入必須有發生（實際 writes=${s.writes}）`);
  }
});

test("開閘：PG 寫入 reject ⇒ 抛原始錯誤，不回退同步版", () => {
  const out = result();
  assert.equal(out.error, undefined, `child 不該失敗：${out.error}`);
  for (const name of Object.keys(out.reject)) {
    const s = out.reject[name];
    assert.equal(s.threw, true, `${name} 在 PG 寫入 reject 時必須抛錯`);
    assert.equal(s.message, "PG_WRITE_REJECTED", `${name} 必須抛原始 PG 錯誤（不是 business SQLite is closed）`);
    assert.doesNotMatch(s.message, /business SQLite is closed/, `${name} 不得回退同步 SQLite 版`);
  }
});

test("開閘：讀取 fallback（getDemandPostAsync）不回退同步版（#678 同形）", () => {
  const out = result();
  assert.equal(out.error, undefined, `child 不該失敗：${out.error}`);
  const s = out.readFallback.getDemandPostAsync;
  assert.equal(s.threw, true, "PG 讀取失敗時必須抛錯");
  assert.equal(s.message, "PG_READ_REJECTED", "必須抛原始 PG 錯誤，不是 business SQLite is closed");
});

test("未開閘：鏡射照做（回歸）由既有的 demand/wish parity 測試釘住，這裡只驗 sqliteHandleIsUsable 判準一致", () => {
  // 未開閘（本機 SQLite 可用）時 sqliteHandleIsUsable 必須回 true——這是「行為逐字不變」的前提。
  assert.equal(sqliteHandleIsUsable(dbMod.sqliteHandle()), true, "未開閘時本機 SQLite handle 必須可用");
});
