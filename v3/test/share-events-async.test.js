// 分享事件寫入（`recordShareEventAsync`）的 parity（2026-09-28，第五十三批）。
//
// `GET /verify-email`（以及註冊、OAuth 註冊）會呼叫 `attributeShare()` 記一筆 `signup` 轉換。
// 同步版寫節點本機的 `rental_share_events` ＋ 本機 analytics ⇒ PG 模式下「分享帶來的註冊」
// 永遠是 0，而且是**靜默的**（`attributeShare()` 的 catch 會把錯誤吞掉）。
//
// 這一支刻意**不注入假 handle 給同步版**（那會讓同步的 `.get()` 拿到 Promise ⇒ 判成
// 「找不到分享」，變成另一種靜默失效）；async 版是把同一組規則跑在 async exec 上，
// 兩邊的 helper（bot 判斷、訪客雜湊、速率限制、事件類型政策）都是同一份。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createDemandPost, ensureDemandSchema } from "../src/demand.js";
import { ensureRentalNotifySchema } from "../src/rentalNotify.js";
import { recordShareEvent, resetShareGrowthLimits } from "../src/rentalShareGrowth.js";
import { sqliteHandle } from "../src/db.js";
import { recordShareEventAsync } from "../src/rentalShareGrowthAsync.js";

const NOW = new Date("2026-09-18T04:00:00.000Z");

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureDemandSchema(db);
  ensureRentalNotifySchema(db);
  db.prepare("INSERT INTO users(id, email, created_at) VALUES (?,?,?)")
    .run(1, "owner@example.test", "2026-01-01T00:00:00.000Z");
  return db;
}

function seedWish(db) {
  return createDemandPost(db, 1, {
    districts: ["1-8"],
    rent_max: 28000,
    housing_type: "whole",
    layout: "2",
    body: "士林兩房找屋",
    must_have: ["need_cook"],
  });
}

// 兩個獨立的 store：左邊給同步版、右邊給 async 版（用 exec 當 PG 替身）。
function worlds() {
  const lite = open();
  const pg = open();
  const wish = seedWish(lite);
  seedWish(pg);
  // `createDemandPost()` 每次都產生隨機 public_token ⇒ 讓兩邊指向同一個 token，
  // 否則 async 那一邊會查不到分享（這一條第一版就是這樣紅的）。
  pg.prepare("UPDATE demand_posts SET public_token = ?").run(wish.public_token);
  const exec = async (sql, params = []) => pg.prepare(sql).all(...params);
  const dump = (db) => db.prepare("SELECT * FROM rental_share_events ORDER BY id").all()
    .map((row) => ({ ...row, id: 0, public_token: "x" }));
  const analytics = (db) => db.prepare("SELECT day, metric, value FROM rental_analytics_daily ORDER BY metric").all();
  return [lite, pg, wish.public_token, exec, dump, analytics];
}

test("view：去重、bot 標記、速率限制三種情境都與同步版相同", async () => {
  resetShareGrowthLimits();
  const [lite, pg, token, exec, dump] = worlds();
  const inputs = [
    { shareToken: token, eventType: "view", ip: "1.1.1.1", userAgent: "Mozilla", now: NOW },
    { shareToken: token, eventType: "view", ip: "1.1.1.1", userAgent: "Mozilla", now: NOW }, // 同一天同訪客 ⇒ deduped
    { shareToken: token, eventType: "view", ip: "2.2.2.2", userAgent: "Googlebot", now: NOW }, // bot
  ];
  const syncOut = inputs.map((input) => recordShareEvent(lite, input));
  resetShareGrowthLimits();
  const asyncOut = [];
  for (const input of inputs) asyncOut.push(await recordShareEventAsync(input, { driver: "postgres", exec, strict: true }));
  assert.deepEqual(asyncOut, syncOut, "回傳值必須逐欄相同");
  assert.equal(asyncOut[0].recorded, true);
  assert.equal(asyncOut[1].reason, "deduped", "同一天同訪客要 dedupe");
  assert.equal(asyncOut[2].is_bot, true, "bot 要標記");
  // 三筆輸入裡第二筆是同一天同訪客 ⇒ dedupe，所以落地兩列（第一筆與 bot 那筆）。
  assert.equal(dump(lite).length, 2, "同步版那一份要落地兩列（重複的那筆被 dedupe）");
  assert.deepEqual(dump(pg), dump(lite), "兩邊落地的列必須逐欄相同（id／public_token 已正規化）");
});

test("signup 轉換：落地列與 analytics 都與同步版相同", async () => {
  resetShareGrowthLimits();
  const [lite, pg, token, exec, dump, analytics] = worlds();
  const input = { shareToken: token, eventType: "signup", userId: 1, ip: "3.3.3.3", userAgent: "Mozilla", now: NOW, source: "server" };
  const syncOut = recordShareEvent(lite, input);
  const asyncOut = await recordShareEventAsync(input, { driver: "postgres", exec, strict: true });
  assert.deepEqual(asyncOut, syncOut, "回傳值必須相同");
  assert.equal(asyncOut.recorded, true, "必須真的記下來（否則這條測試沒有鑑別力）");
  assert.equal(pg.prepare("SELECT COUNT(*) AS n FROM rental_share_events").get().n, 1, "PG 那一份要有一列");
  assert.equal(pg.prepare("SELECT event_type FROM rental_share_events").get().event_type, "signup");
  assert.equal(pg.prepare("SELECT user_id FROM rental_share_events").get().user_id, 1);
  // 同一個使用者同一天再記一次 ⇒ dedupe（兩邊一致）
  const again = await recordShareEventAsync(input, { driver: "postgres", exec, strict: true });
  assert.deepEqual(again, recordShareEvent(lite, input), "重複的要一起 dedupe");
  assert.equal(again.reason, "deduped");
  // analytics 也要寫進 PG 那一份（同步版寫本機）
  assert.equal(analytics(pg).length >= 1, true, "PG 的 analytics 必須有計數");
  assert.deepEqual(analytics(pg), analytics(lite), "兩邊的計數必須相同");
});

test("政策守衛：偽造 token／公開來源的轉換事件都要擋，兩邊錯誤相同", async () => {
  resetShareGrowthLimits();
  const [lite, , token, exec] = worlds();
  const cases = [
    { input: { shareToken: "forged-share-token-xxxx", eventType: "signup", source: "server", userId: 1, now: NOW }, why: "偽造 token" },
    { input: { shareToken: token, eventType: "signup", source: "public", userId: 1, now: NOW }, why: "公開來源不得記轉換" },
    { input: { shareToken: token, eventType: "nope", source: "server", userId: 1, now: NOW }, why: "未知事件類型" },
  ];
  for (const { input, why } of cases) {
    let syncError = null;
    try { recordShareEvent(lite, input); } catch (error) { syncError = error; }
    let asyncError = null;
    try { await recordShareEventAsync(input, { driver: "postgres", exec, strict: true }); } catch (error) { asyncError = error; }
    assert.ok(syncError, `${why}：同步版必須擋下（前提）`);
    assert.ok(asyncError, `${why}：async 版必須擋下`);
    assert.equal(asyncError.status, syncError.status, `${why}：status 必須相同`);
    assert.equal(asyncError.message, syncError.message, `${why}：訊息必須相同`);
    assert.equal(asyncError.code, syncError.code, `${why}：code 必須相同`);
  }
});

test("非 postgres：走同步路徑（讀的是應用程式的本機 store，不碰傳入的 exec）", async () => {
  resetShareGrowthLimits();
  // ⚠️ sqlite 分支用的是 `sqliteHandle()`（應用程式自己的 v3.db），**不是**測試夾具，
  // 所以這裡刻意用一個不存在的 token：兩邊都必須丟出同一句「找不到分享」，
  // 藉此證明 async 版確實把工作交給了同步版（而不是偷偷用了 PG runner）。
  const input = { shareToken: "no-such-share-token", eventType: "signup", userId: 1, source: "server", now: NOW };
  let syncError = null;
  try { recordShareEvent(sqliteHandle(), input); } catch (error) { syncError = error; }
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  let asyncError = null;
  try { await recordShareEventAsync(input, { driver: "sqlite", exec: boom }); } catch (error) { asyncError = error; }
  assert.ok(syncError, "前提：本機沒有這個 token，同步版必須丟錯");
  assert.ok(asyncError, "sqlite 模式的 async 版也要丟同一種錯");
  assert.equal(asyncError.message, syncError.message, "訊息必須相同");
  assert.equal(asyncError.code, syncError.code, "code 必須相同");
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
});
