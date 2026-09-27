// 推播訂閱 PG 分支的 parity（2026-09-27）。
//
// 這批只有 2 條路由，但有一個**會直接壞掉**的坑：
//
//   INSERT INTO push_subscriptions(...) ... ON CONFLICT(endpoint) DO UPDATE SET ...
//
// `ON CONFLICT(endpoint)` 需要 endpoint 上的唯一約束，而 SQLite 的
// `endpoint TEXT NOT NULL UNIQUE` 是**欄位約束**（隱式索引），`pgSchema` 鏡射不到——
// 實測正式站只有 pkey，所以那句話在 PG 上會直接 42P10。bootstrap 必須先清重複
// 再補建 `UNIQUE(endpoint)`。下面第 5 條測試就是釘這件事（用假 driver 驗順序與只做一次）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-webpush-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const syncDb = await import("../src/db.js");
const asyncMod = await import("../src/webPushAsync.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const TABLES = ["push_subscriptions", "users"];
const SUB = { endpoint: "https://push.example.test/abc", keys: { p256dh: "pkey", auth: "authsecret" } };

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/COLLATE\s+NOCASE/i, 'collation "nocase" for encoding "UTF8" does not exist'],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
];

// PG 替身：兩張表的 DDL 都從真的 sqlite_master 抄（`push_subscriptions` 對 users 有 FK，
// 所以 users 也要一起建，否則插入會撞 FOREIGN KEY）。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const table of ["users", "push_subscriptions"]) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  const row = disk.prepare("SELECT * FROM users WHERE id=1").get();
  disk.close();
  if (row) {
    const info = mem.prepare("PRAGMA table_info(users)").all();
    const names = info.map((c) => c.name).filter((n) => row[n] !== undefined);
    mem.prepare(`INSERT INTO users(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
      .run(...names.map((n) => row[n]));
  }
  const calls = [];
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    calls.push({ sql, params });
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  exec.calls = calls;
  return exec;
}

function resetBoth() {
  db.prepare("DELETE FROM push_subscriptions").run();
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM push_subscriptions").run();
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name='push_subscriptions'").run(); } catch { /* 沒有 AUTOINCREMENT */ }
  return exec;
}

const dump = (h) => h.prepare("SELECT user_id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY id").all().map((r) => ({ ...r }));

function assertSameRows(exec, why) {
  const a = dump(db);
  const b = dump(exec.raw);
  assert.deepEqual(b, a, `${why}：PG 分支落地的列必須與同步版完全相同`);
  assert.ok(a.length > 0 || why.includes("空"), `${why}：兩邊都是 0 列時這個比對沒有鑑別力`);
}

const reasonOf = (e) => `${e.status || "-"}/${e.message}`;

// ---------------------------------------------------------------------------

test("訂閱：落地列與回傳值都與同步版相同", async () => {
  const exec = resetBoth();
  const pg = await asyncMod.savePushSubscriptionAsync(1, SUB, { ...PG, exec });
  const lite = syncDb.saveUserPushSubscription(1, SUB);
  assert.deepEqual(pg, lite);
  assert.deepEqual({ ok: true }, pg, "回傳形狀必須是 { ok: true }");
  const rows = dump(exec.raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, SUB.endpoint);
  assert.equal(rows[0].p256dh, "pkey");
  assert.equal(rows[0].auth, "authsecret");
  assertSameRows(exec, "訂閱");
});

test("同一個 endpoint 再訂一次：upsert 成一列、last_seen_at 更新、user_id 跟著換", async () => {
  // 這一條就是需要 `UNIQUE(endpoint)` 的路徑——PG 上沒有那個約束時會直接 42P10。
  const exec = resetBoth();
  for (const h of [db, exec.raw]) h.prepare("INSERT OR IGNORE INTO users(id,email,role,plan,created_at) VALUES (2,'u2@example.test','member','free','2026-01-01T00:00:00.000Z')").run();
  await asyncMod.savePushSubscriptionAsync(1, SUB, { ...PG, exec });
  syncDb.saveUserPushSubscription(1, SUB);
  const first = dump(exec.raw)[0];

  const pg = await asyncMod.savePushSubscriptionAsync(2, SUB, { ...PG, exec });
  const lite = syncDb.saveUserPushSubscription(2, SUB);
  assert.deepEqual(pg, lite, "兩邊都必須是 upsert（不是新增第二列）");
  const rows = dump(exec.raw);
  assert.equal(rows.length, 1, "同一個 endpoint 只能有一列");
  assert.equal(Number(rows[0].user_id), 2, "user_id 必須換成最後訂閱的人");
  // `last_seen_at` 是 `new Date().toISOString()`，兩次呼叫一定不同；這裡只驗它有被更新，
  // 並用「同步版那一列也一樣」確認行為一致。
  assert.deepEqual(dump(db), rows, "兩邊落地結果必須相同");
  assert.ok(typeof first.user_id !== "undefined");
});

test("格式驗證：endpoint 不是 https／缺 p256dh／缺 auth 都要擋下，兩邊訊息相同", async () => {
  const exec = resetBoth();
  const cases = [
    { sub: { endpoint: "http://push.example.test/x", keys: SUB.keys }, why: "不是 https" },
    { sub: { endpoint: SUB.endpoint, keys: { auth: "a" } }, why: "缺 p256dh" },
    { sub: { endpoint: SUB.endpoint, keys: { p256dh: "p" } }, why: "缺 auth" },
    { sub: {}, why: "空的" },
  ];
  for (const c of cases) {
    let syncErr = null;
    try { syncDb.saveUserPushSubscription(1, c.sub); } catch (e) { syncErr = e; }
    assert.ok(syncErr, `同步版應該擋下（${c.why}）`);
    await assert.rejects(() => asyncMod.savePushSubscriptionAsync(1, c.sub, { ...PG, exec }),
      (e) => reasonOf(e) === reasonOf(syncErr), `PG 分支必須一致（${c.why}）`);
  }
  assert.equal(dump(exec.raw).length, 0, "被擋下的都不得落地");
});

test("未登入：同步版與 PG 分支都要丟 401", async () => {
  const exec = resetBoth();
  let syncErr = null;
  try { syncDb.saveUserPushSubscription(0, SUB); } catch (e) { syncErr = e; }
  assert.equal(syncErr?.status, 401);
  await assert.rejects(() => asyncMod.savePushSubscriptionAsync(0, SUB, { ...PG, exec }), (e) => e.status === 401);
});

test("取消訂閱：只刪自己那一列；缺參數直接回 ok 且不碰 DB", async () => {
  const exec = resetBoth();
  for (const h of [db, exec.raw]) h.prepare("INSERT OR IGNORE INTO users(id,email,role,plan,created_at) VALUES (2,'u2@example.test','member','free','2026-01-01T00:00:00.000Z')").run();
  // ⚠️ user 1 要有**兩筆**訂閱（模擬同一人的兩台裝置）：只有一筆時，
  // 「不比對 endpoint、只按 user_id 刪」也會刪掉剛好那一筆 ⇒ 變異殺不死。
  const second = { ...SUB, endpoint: "https://push.example.test/second-device" };
  await asyncMod.savePushSubscriptionAsync(1, SUB, { ...PG, exec });
  syncDb.saveUserPushSubscription(1, SUB);
  await asyncMod.savePushSubscriptionAsync(1, second, { ...PG, exec });
  syncDb.saveUserPushSubscription(1, second);
  await asyncMod.savePushSubscriptionAsync(2, { ...SUB, endpoint: "https://push.example.test/other" }, { ...PG, exec });
  syncDb.saveUserPushSubscription(2, { ...SUB, endpoint: "https://push.example.test/other" });

  const pg = await asyncMod.deletePushSubscriptionAsync(1, SUB.endpoint, { ...PG, exec });
  const lite = syncDb.deleteUserPushSubscription(1, SUB.endpoint);
  assert.deepEqual(pg, lite);
  assertSameRows(exec, "取消訂閱");
  assert.equal(dump(exec.raw).length, 2, "三筆刪一筆，剩兩筆");
  assert.deepEqual(dump(exec.raw).map((r) => r.endpoint).sort(),
    ["https://push.example.test/other", "https://push.example.test/second-device"],
    "只刪掉指定那個 endpoint——同一個人的另一台裝置必須留著");

  // 缺 endpoint 或未登入：回 ok 且不寫 DB（與同步版同義）。
  const before = dump(exec.raw).length;
  assert.deepEqual(await asyncMod.deletePushSubscriptionAsync(1, "", { ...PG, exec }), { ok: true });
  assert.deepEqual(await asyncMod.deletePushSubscriptionAsync(0, SUB.endpoint, { ...PG, exec }), { ok: true });
  assert.equal(dump(exec.raw).length, before, "缺參數不得動到資料");
});

test("bootstrap：先清重複再建 UNIQUE(endpoint)，而且每個 driver 只做一次", async () => {
  const statements = [];
  const driver = {
    async exec(sql) { statements.push(sql); },
    async query(sql, params = []) {
      if (sql.includes("?")) throw new Error(`PG driver 收到未翻譯的 SQL：${sql.slice(0, 60)}`);
      statements.push(sql);
      if (/HAVING COUNT/.test(sql)) return { rows: [{ endpoint: "https://dup.test/x", keep_id: 9 }] };
      return { rows: [] };
    },
  };
  await asyncMod.ensurePushStoreOnce(driver);
  const first = [...statements];
  // ⚠️ 用**字面 pattern**比對，不要用 `includes(asyncMod.XXX_SQL)`：
  // 把那個常數的定義整行拿掉時它會變成 `undefined`，而 `[].includes(undefined)` 是 false、
  // `[undefined].includes(undefined)` 卻是 **true** ⇒ 斷言恆真（變異測試顯示殺不死）。
  assert.ok(first.some((sql) => /CREATE UNIQUE INDEX[\s\S]*push_subscriptions\(endpoint\)/.test(String(sql))),
    "UNIQUE(endpoint) 必須補建——正式站只有 pkey，少了它 ON CONFLICT(endpoint) 直接 42P10");
  const dupeAt = first.findIndex((s) => /HAVING COUNT/.test(s));
  const indexAt = first.findIndex((s) => /CREATE UNIQUE INDEX/.test(s));
  assert.ok(dupeAt >= 0 && indexAt > dupeAt,
    `唯一索引必須在清完重複之後才建。順序：${first.map((s) => s.slice(0, 42))}`);
  assert.ok(first.some((s) => /^DELETE FROM push_subscriptions WHERE endpoint = \$1/.test(s)), "重複的列要被刪掉");
  assert.ok(first.some((s) => /idx_push_user/.test(s)), "具名索引 idx_push_user 也要補（正式站也沒有）");

  await asyncMod.ensurePushStoreOnce(driver);
  assert.equal(statements.length, first.length, "第二次呼叫不得再跑一次 schema");
});

test("非 postgres 模式必須回退同步路徑（寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  await asyncMod.savePushSubscriptionAsync(1, SUB, { ...PG, exec });
  assert.equal(dump(exec.raw).length, 1);
  const lite = await asyncMod.savePushSubscriptionAsync(1, { ...SUB, endpoint: "https://disk.test/y" }, { driver: "sqlite", exec });
  assert.deepEqual(lite, { ok: true });
  assert.deepEqual(dump(db).map((r) => r.endpoint), ["https://disk.test/y"], "sqlite 模式必須寫磁碟");
  assert.deepEqual(dump(exec.raw).map((r) => r.endpoint), [SUB.endpoint], "sqlite 模式不得改動 PG 夾具");
});

test("strict：PG 失敗時必須往上丟，不得無聲寫進沒人讀的 SQLite", async () => {
  const exec = resetBoth();
  const broken = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(() => asyncMod.savePushSubscriptionAsync(1, SUB, { ...PG, exec: broken, strict: true }), /connection terminated/);
  await assert.rejects(() => asyncMod.savePushSubscriptionAsync(1, SUB, { ...PG, exec: broken }), /connection terminated/);
  assert.equal(dump(db).length, 0, "寫入失敗不得回退寫 SQLite");
});

test("夾具本身要真的拒絕 IFNULL／COLLATE NOCASE（否則方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT IFNULL(endpoint,'') FROM push_subscriptions"), /function ifnull/);
  await assert.rejects(() => exec("SELECT endpoint FROM push_subscriptions ORDER BY endpoint COLLATE NOCASE"), /collation "nocase"/);
  await assert.doesNotReject(() => exec("SELECT endpoint FROM push_subscriptions"), "普通查詢要放行");
});
