// 物件一鍵分享（Phase 1）的 PG 島嶼 parity（對照 `share-events-async.test.js` 形狀）。
//
// 刻意**不注入假 handle 給同步版**（那會讓同步 `.get()` 拿到 Promise ⇒ 判成找不到分享）。
// async 版把同一組規則跑在 async exec 上，兩邊共用同一份 helper（bot 判斷、訪客雜湊、
// 速率限制、事件類型政策）。沒有真 PG 也不依賴它：exec 是 SQLite 當替身，無 PG 照樣綠。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createListingShareLink,
  ensureListingShareSchema,
  recordListingShareEvent,
} from "../src/listingShare.js";
import { resetShareGrowthLimits } from "../src/rentalShareGrowth.js";
import {
  createListingShareLinkAsync,
  recordListingShareEventAsync,
} from "../src/listingShareAsync.js";

const NOW = new Date("2026-09-18T04:00:00.000Z");
const FLAGS = { enabled: true, dailyLimit: 20 };

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS listings (
      post_id INTEGER PRIMARY KEY,
      source TEXT NOT NULL DEFAULT '591',
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      self_status TEXT,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS rental_analytics_daily (
      day TEXT NOT NULL,
      metric TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, metric)
    );
  `);
  ensureListingShareSchema(db);
  db.prepare("INSERT INTO listings(post_id, source, title, url) VALUES (?, ?, ?, ?)")
    .run(5001, "591", "測試物件", "https://example.com/5001");
  return db;
}

test("createListingShareLink：同步與 async 回傳逐欄相同、兩邊都落地一筆", async () => {
  const lite = open();
  const pg = open();
  const exec = async (sql, params = []) => pg.prepare(sql).all(...params);
  const sync = createListingShareLink(lite, { listingId: 5001, actorId: 7, now: NOW, flags: FLAGS });
  const asyncRes = await createListingShareLinkAsync(
    { listingId: 5001, actorId: 7, now: NOW },
    { driver: "postgres", exec, strict: true },
  );
  assert.equal(asyncRes.ok, sync.ok);
  assert.equal(asyncRes.dailyUsed, sync.dailyUsed);
  assert.equal(asyncRes.dailyLimit, sync.dailyLimit);
  assert.equal(asyncRes.shareToken.length, 16);
  assert.equal(lite.prepare("SELECT COUNT(*) AS n FROM listing_share_tokens").get().n, 1);
  assert.equal(pg.prepare("SELECT COUNT(*) AS n FROM listing_share_tokens").get().n, 1);
});

test("recordListingShareEvent：view／去重／bot／cta 四情境回傳與落地都與同步版相同", async () => {
  resetShareGrowthLimits();
  const lite = open();
  const pg = open();
  const exec = async (sql, params = []) => pg.prepare(sql).all(...params);
  const syncLink = createListingShareLink(lite, { listingId: 5001, actorId: 7, now: NOW, flags: FLAGS });
  // async 端也建一筆，再把 token 對齊成同一支（create 每次都隨機 token）。
  await createListingShareLinkAsync({ listingId: 5001, actorId: 7, now: NOW }, { driver: "postgres", exec, strict: true });
  pg.prepare("UPDATE listing_share_tokens SET share_token = ?").run(syncLink.shareToken);

  const inputs = [
    { shareToken: syncLink.shareToken, eventType: "view", ip: "1.1.1.1", userAgent: "Mozilla", now: NOW },
    { shareToken: syncLink.shareToken, eventType: "view", ip: "1.1.1.1", userAgent: "Mozilla", now: NOW }, // dedup
    { shareToken: syncLink.shareToken, eventType: "view", ip: "2.2.2.2", userAgent: "Googlebot", now: NOW }, // bot
    { shareToken: syncLink.shareToken, eventType: "cta", ip: "3.3.3.3", userAgent: "Mozilla", now: NOW, channel: "line" },
  ];
  const syncOut = inputs.map((input) => recordListingShareEvent(lite, input));
  resetShareGrowthLimits();
  const asyncOut = [];
  for (const input of inputs) asyncOut.push(await recordListingShareEventAsync(input, { driver: "postgres", exec, strict: true }));
  assert.deepEqual(asyncOut, syncOut, "回傳值必須逐欄相同");
  assert.equal(asyncOut[0].recorded, true);
  assert.equal(asyncOut[1].reason, "deduped");
  assert.equal(asyncOut[2].is_bot, true);
  assert.equal(asyncOut[3].recorded, true);

  const dump = (db) => db.prepare("SELECT * FROM listing_share_events ORDER BY id").all()
    .map((row) => ({ ...row, id: 0 }));
  assert.deepEqual(dump(pg), dump(lite), "兩邊落地的列必須逐欄相同（id 已正規化）");
  const analytics = (db) => db.prepare("SELECT day, metric, value FROM rental_analytics_daily ORDER BY metric").all();
  assert.deepEqual(analytics(pg), analytics(lite), "兩邊的 analytics 計數必須相同");
});

test("政策守衛：偽造 token／未知事件類型都要擋，兩邊錯誤相同", async () => {
  resetShareGrowthLimits();
  const lite = open();
  const pg = open();
  const exec = async (sql, params = []) => pg.prepare(sql).all(...params);
  const syncLink = createListingShareLink(lite, { listingId: 5001, actorId: 7, now: NOW, flags: FLAGS });
  await createListingShareLinkAsync({ listingId: 5001, actorId: 7, now: NOW }, { driver: "postgres", exec, strict: true });
  pg.prepare("UPDATE listing_share_tokens SET share_token = ?").run(syncLink.shareToken);

  const cases = [
    { input: { shareToken: "forged-token-xxxx", eventType: "view", now: NOW }, why: "偽造 token" },
    { input: { shareToken: syncLink.shareToken, eventType: "signup", now: NOW }, why: "未知事件類型" },
  ];
  for (const { input, why } of cases) {
    let syncError = null;
    try { recordListingShareEvent(lite, input); } catch (error) { syncError = error; }
    let asyncError = null;
    try { await recordListingShareEventAsync(input, { driver: "postgres", exec, strict: true }); } catch (error) { asyncError = error; }
    assert.ok(syncError, `${why}：同步版必須擋下（前提）`);
    assert.ok(asyncError, `${why}：async 版必須擋下`);
    assert.equal(asyncError.status, syncError.status, `${why}：status 必須相同`);
    assert.equal(asyncError.code, syncError.code, `${why}：code 必須相同`);
  }
});

test("非 postgres：走同步路徑（不碰傳入的 exec）", async () => {
  resetShareGrowthLimits();
  const input = { shareToken: "no-such-token-xyz", eventType: "view", now: NOW };
  let syncError = null;
  try { recordListingShareEvent(open(), input); } catch (error) { syncError = error; }
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  let asyncError = null;
  try { await recordListingShareEventAsync(input, { driver: "sqlite", exec: boom, strict: true }); } catch (error) { asyncError = error; }
  assert.ok(syncError, "前提：沒有這個 token，同步版必須丟錯");
  assert.ok(asyncError, "sqlite 模式的 async 版也要丟同一種錯");
  assert.equal(asyncError.code, syncError.code, "code 必須相同");
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
});
