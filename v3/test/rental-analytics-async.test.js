// `bumpAnalyticsAsync()` 的 parity（2026-09-28）。
//
// 為什麼單獨測這一支：`rental_analytics_daily` 的 upsert 是**9 條缺口路由**的卡點，
// 而它只是「同一天同一指標累加」。這種「看起來很簡單」的函式最容易在移植時被寫成
// 「覆蓋」而不是「累加」，所以這裡的核心斷言是**多次呼叫之後的總和**，不是單次結果。
//
// ⚠️ `strict: true`：分析寫入若靜默回退 SQLite，正式站就會出現「PG 沒有數字、
// 節點本機有」的分歧，而測試還會是綠的。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-analytics-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const notify = await import("../src/rentalNotify.js");
const analytics = await import("../src/rentalAnalyticsAsync.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const TABLE = "rental_analytics_daily";

function fixture() {
  const mem = new DatabaseSync(":memory:");
  const ddl = handle().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
  assert.ok(ddl?.sql, "必須抓到 rental_analytics_daily 的 DDL（夾具不自己寫表格定義）");
  mem.exec(ddl.sql);
  const exec = async (sql, params = []) => {
    const rows = mem.prepare(sql).all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
  exec.raw = mem;
  return exec;
}

function resetBoth() {
  const db = handle();
  db.prepare(`DELETE FROM ${TABLE}`).run();
  const exec = fixture();
  exec.raw.prepare(`DELETE FROM ${TABLE}`).run();
  return [db, exec];
}

const rowsOf = (h) => h.prepare(`SELECT day, metric, value FROM ${TABLE} ORDER BY day, metric`).all()
  .map((r) => ({ ...r }));

// ---------------------------------------------------------------------------

test("累加：多次呼叫的總和，PG 與同步版必須相同", async () => {
  const [db, exec] = resetBoth();
  const now = new Date("2026-09-28T10:00:00.000Z");
  await analytics.bumpAnalyticsAsync("notify_generated", now, 1, { ...PG, exec, strict: true });
  await analytics.bumpAnalyticsAsync("notify_generated", now, 2, { ...PG, exec, strict: true });
  await analytics.bumpAnalyticsAsync("notify_generated", now, 3, { ...PG, exec, strict: true });
  notify.bumpAnalytics(db, "notify_generated", now, 1);
  notify.bumpAnalytics(db, "notify_generated", now, 2);
  notify.bumpAnalytics(db, "notify_generated", now, 3);

  assert.deepEqual(rowsOf(exec.raw), rowsOf(db), "累加結果必須相同");
  assert.equal(rowsOf(exec.raw).length, 1, "同一天同一指標只能有一列");
  assert.equal(rowsOf(exec.raw)[0].value, 6, "必須是累加（1+2+3），不是覆蓋");
  assert.equal(rowsOf(db)[0].value, 6, "同步版必須也是 6（否則這條沒鑑別力）");
});

test("日界線：用同一支 taipeiDay()，跨時區的時刻要落在同一天", async () => {
  const [db, exec] = resetBoth();
  // 台北時間 2026-09-28 07:00 == UTC 2026-09-27 23:00 ⇒ 兩者都必須記在 09-28
  const taipeiMorning = new Date("2026-09-27T23:00:00.000Z");
  const utcNoon = new Date("2026-09-28T04:00:00.000Z");
  assert.equal(notify.taipeiDay(taipeiMorning), "2026-09-28");
  assert.equal(notify.taipeiDay(utcNoon), "2026-09-28");

  await analytics.bumpAnalyticsAsync("share_view", taipeiMorning, 1, { ...PG, exec, strict: true });
  await analytics.bumpAnalyticsAsync("share_view", utcNoon, 1, { ...PG, exec, strict: true });
  notify.bumpAnalytics(db, "share_view", taipeiMorning, 1);
  notify.bumpAnalytics(db, "share_view", utcNoon, 1);

  assert.deepEqual(rowsOf(exec.raw), rowsOf(db), "跨時區的日界線必須一致");
  assert.equal(rowsOf(exec.raw)[0].day, "2026-09-28");
  assert.equal(rowsOf(exec.raw)[0].value, 2, "兩個時刻必須累加到同一列");
});

test("不同指標／不同日期各自成列，兩邊一致", async () => {
  const [db, exec] = resetBoth();
  const d1 = new Date("2026-09-28T04:00:00.000Z");
  const d2 = new Date("2026-09-29T04:00:00.000Z");
  for (const [metric, when] of [["notify_queued", d1], ["notify_delivered", d1], ["notify_queued", d2]]) {
    await analytics.bumpAnalyticsAsync(metric, when, 5, { ...PG, exec, strict: true });
    notify.bumpAnalytics(db, metric, when, 5);
  }
  assert.deepEqual(rowsOf(exec.raw), rowsOf(db), "多指標／多日期必須一致");
  assert.equal(rowsOf(exec.raw).length, 3, "應該有三列");
  assert.equal(rowsOf(exec.raw).find((r) => r.day === "2026-09-28" && r.metric === "notify_queued").value, 5);
});

test("n 的邊界：0 與非數字要與同步版同樣對待", async () => {
  const [db, exec] = resetBoth();
  const now = new Date("2026-09-28T04:00:00.000Z");
  for (const n of [0, undefined, null, "abc", -3]) {
    await analytics.bumpAnalyticsAsync("edge", now, n, { ...PG, exec, strict: true });
    notify.bumpAnalytics(db, "edge", now, n);
    assert.deepEqual(rowsOf(exec.raw), rowsOf(db), `n=${String(n)} 必須一致`);
  }
  // 同步版對 n 的規則是 `Number(n) || 1`：0／undefined／null／NaN **都算 1**，負數照加。
  // ⇒ 0、undefined、null、"abc" 各 +1，-3 則是 -3 ⇒ 1+1+1+1-3 = 1
  assert.equal(rowsOf(exec.raw)[0].value, 1, "1+1+1+1-3 = 1");
});

test("寫入失敗時 fail-closed：PG 丟錯就往上丟，不得靜默回退 SQLite", async () => {
  const [db] = resetBoth();
  const bad = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    () => analytics.bumpAnalyticsAsync("x", new Date(), 1, { ...PG, exec: bad, strict: true }),
    /connection terminated/,
  );
  assert.equal(rowsOf(db).length, 0, "fail-closed：不得偷偷寫回本機 SQLite");
});

test("非 postgres 必須回退同步路徑（讀磁碟，不碰傳入的 exec）", async () => {
  const [db, exec] = resetBoth();
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  await analytics.bumpAnalyticsAsync("fallback", new Date("2026-09-28T04:00:00.000Z"), 1, { driver: "sqlite", exec: boom });
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.equal(rowsOf(db)[0].value, 1, "sqlite 模式必須寫磁碟");
  assert.equal(rowsOf(exec.raw).length, 0, "sqlite 模式不得寫夾具");
});

test("同一天的不同指標不得互相覆蓋（UPDATE 必須帶 metric）", async () => {
  // ⚠️ 這一條是變異測試逼出來的：原本只測「不同指標掛在不同天」，那種情況就算
  // UPDATE 忘了帶 `metric` 也照樣過關。必須**同一天兩個指標**才驗得到。
  const [db, exec] = resetBoth();
  const day = new Date("2026-09-28T04:00:00.000Z");
  for (const metric of ["notify_queued", "notify_delivered"]) {
    await analytics.bumpAnalyticsAsync(metric, day, 2, { ...PG, exec, strict: true });
    notify.bumpAnalytics(db, metric, day, 2);
  }
  await analytics.bumpAnalyticsAsync("notify_queued", day, 3, { ...PG, exec, strict: true });
  notify.bumpAnalytics(db, "notify_queued", day, 3);
  assert.deepEqual(rowsOf(exec.raw), rowsOf(db), "同一天兩個指標的結果必須與同步版相同");
  assert.equal(rowsOf(exec.raw).length, 2, "兩個指標必須各有一列");
  assert.equal(rowsOf(exec.raw).find((r) => r.metric === "notify_queued").value, 5, "notify_queued 應為 2+3");
  assert.equal(rowsOf(exec.raw).find((r) => r.metric === "notify_delivered").value, 2, "另一個指標不得被動到");
});

test("累加語句不得使用 ON CONFLICT（方言分歧會在 CI 才爆）", async () => {
  // ⚠️ 這條守衛來自 CI 的兩次紅燈：`ON CONFLICT … DO UPDATE SET value = value + excluded.value`
  // 在 PG 上是 `42702 ambiguous`，改成限定表名之後 SQLite 又不接受（離線夾具是 SQLite）。
  // 所以這一支刻意走「先讀再寫」——語句必須維持兩邊都合法的形狀。
  const all = [analytics.ANALYTICS_SELECT_SQL, analytics.ANALYTICS_UPDATE_SQL, analytics.ANALYTICS_INSERT_SQL].join("\n");
  assert.doesNotMatch(all, /ON CONFLICT/i, "不得再回到 ON CONFLICT（那個寫法兩邊不能共用）");
  assert.doesNotMatch(all, /excluded\./i, "不得引用 excluded");
  assert.match(analytics.ANALYTICS_SELECT_SQL, /SELECT value FROM rental_analytics_daily WHERE day = \? AND metric = \?/);
  assert.match(analytics.ANALYTICS_UPDATE_SQL, /UPDATE rental_analytics_daily SET value = \? WHERE day = \? AND metric = \?/);
  assert.match(analytics.ANALYTICS_INSERT_SQL, /INSERT INTO rental_analytics_daily\(day, metric, value\) VALUES \(\?, \?, \?\)/);
});

test("非 postgres 必須回退同步路徑（讀磁碟，不碰傳入的 exec）", async () => {
  const [db, exec] = resetBoth();
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  await analytics.bumpAnalyticsAsync("fallback", new Date("2026-09-28T04:00:00.000Z"), 1, { driver: "sqlite", exec: boom });
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.equal(rowsOf(db)[0].value, 1, "sqlite 模式必須寫磁碟");
  assert.equal(rowsOf(exec.raw).length, 0, "sqlite 模式不得寫夾具");
});

