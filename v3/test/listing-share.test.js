// 物件一鍵分享（Phase 1）核心規則的同步（SQLite）測試。
// 覆蓋：建表冪等、建立分享連結、每日上限、listing 404、事件去重與 bot、統計。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createListingShareLink,
  ensureListingShareSchema,
  listingShareStatsForAdmin,
  listingShareStatsForUser,
  normalizeListingShareFlags,
  recordListingShareEvent,
} from "../src/listingShare.js";
import { resetShareGrowthLimits } from "../src/rentalShareGrowth.js";

const NOW = new Date("2026-09-18T04:00:00.000Z");

function fixture() {
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
  db.prepare("INSERT INTO listings(post_id, source, title, url, self_status) VALUES (?, ?, ?, ?, ?)")
    .run(2100000001, "self", "站內物件", "https://example.com/self", "open");
  return db;
}

test("建表冪等：重複呼叫 ensureListingShareSchema 不拋錯且兩張表都在", () => {
  const db = fixture();
  ensureListingShareSchema(db); // 第二遍
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('listing_share_tokens','listing_share_events')",
  ).all().map((r) => r.name).sort();
  assert.deepEqual(names, ["listing_share_events", "listing_share_tokens"]);
});

test("createListingShareLink：產生 16 字元 base64url token 並落地", () => {
  const db = fixture();
  const r = createListingShareLink(db, { listingId: 5001, actorId: 7, now: NOW, flags: { enabled: true, dailyLimit: 20 } });
  assert.equal(r.ok, true);
  assert.equal(r.shareToken.length, 16, "randomBytes(12) base64url 應為 16 字元");
  assert.match(r.shareToken, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(r.dailyUsed, 1);
  assert.equal(r.dailyLimit, 20);
  const row = db.prepare("SELECT listing_id, actor_id, share_token FROM listing_share_tokens").get();
  assert.equal(row.listing_id, 5001);
  assert.equal(row.actor_id, 7);
  assert.equal(row.share_token, r.shareToken);
});

test("每會員每日上限：達到 dailyLimit 回 daily_limit", () => {
  const db = fixture();
  const flags = { enabled: true, dailyLimit: 2 };
  assert.equal(createListingShareLink(db, { listingId: 5001, actorId: 7, now: NOW, flags }).ok, true);
  assert.equal(createListingShareLink(db, { listingId: 5001, actorId: 7, now: NOW, flags }).ok, true);
  const r3 = createListingShareLink(db, { listingId: 5001, actorId: 7, now: NOW, flags });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, "daily_limit");
  assert.equal(r3.dailyUsed, 2);
  assert.equal(r3.dailyLimit, 2);
});

test("listing 不存在／非公開：回 listing_not_found", () => {
  const db = fixture();
  const missing = createListingShareLink(db, { listingId: 9999, actorId: 7, now: NOW });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "listing_not_found");
  // 站內刊登已關閉（非公開）
  db.prepare("UPDATE listings SET self_status='closed' WHERE post_id=2100000001").run();
  const closed = createListingShareLink(db, { listingId: 2100000001, actorId: 7, now: NOW });
  assert.equal(closed.ok, false);
  assert.equal(closed.code, "listing_not_found");
  // 被後台隱藏（非公開）
  db.prepare("UPDATE listings SET hidden=1 WHERE post_id=5001").run();
  const hidden = createListingShareLink(db, { listingId: 5001, actorId: 7, now: NOW });
  assert.equal(hidden.ok, false);
  assert.equal(hidden.code, "listing_not_found");
});

test("recordListingShareEvent：view/cta 落地、bot 標記、同日去重、analytics 指標", () => {
  resetShareGrowthLimits();
  const db = fixture();
  const link = createListingShareLink(db, { listingId: 5001, actorId: 7, now: NOW });
  const token = link.shareToken;
  const v1 = recordListingShareEvent(db, { shareToken: token, eventType: "view", ip: "1.1.1.1", userAgent: "Mozilla", now: NOW });
  assert.equal(v1.recorded, true);
  assert.equal(v1.is_bot, false);
  const v2 = recordListingShareEvent(db, { shareToken: token, eventType: "view", ip: "1.1.1.1", userAgent: "Mozilla", now: NOW });
  assert.equal(v2.recorded, false);
  assert.equal(v2.reason, "deduped");
  const bot = recordListingShareEvent(db, { shareToken: token, eventType: "view", ip: "2.2.2.2", userAgent: "Googlebot", now: NOW });
  assert.equal(bot.recorded, true);
  assert.equal(bot.is_bot, true);
  const cta = recordListingShareEvent(db, { shareToken: token, eventType: "cta", ip: "3.3.3.3", userAgent: "Mozilla", now: NOW, channel: "line" });
  assert.equal(cta.recorded, true);
  const metrics = db.prepare("SELECT metric FROM rental_analytics_daily ORDER BY metric").all().map((r) => r.metric);
  assert.ok(metrics.includes("listing_share_view"), "應有 listing_share_view");
  assert.ok(metrics.includes("listing_share_view_bot"), "bot 應記 listing_share_view_bot");
  assert.ok(metrics.includes("listing_share_cta"), "應有 listing_share_cta");
  const row = db.prepare("SELECT listing_id, channel, is_bot FROM listing_share_events WHERE event_type='cta'").get();
  assert.equal(row.listing_id, 5001);
  assert.equal(row.channel, "line");
});

test("recordListingShareEvent：無效 token 404、公開來源非 view/cta 403", () => {
  resetShareGrowthLimits();
  const db = fixture();
  assert.throws(
    () => recordListingShareEvent(db, { shareToken: "no-such-token-xyz", eventType: "view", now: NOW }),
    (e) => e.status === 404,
  );
  const link = createListingShareLink(db, { listingId: 5001, actorId: 7, now: NOW });
  assert.throws(
    () => recordListingShareEvent(db, { shareToken: link.shareToken, eventType: "signup", now: NOW }),
    (e) => e.status === 403,
  );
});

test("listingShareStatsForUser：dailyLimit／dailyUsed／totals／items 都正確", () => {
  resetShareGrowthLimits();
  const db = fixture();
  const flags = { enabled: true, dailyLimit: 20 };
  const l1 = createListingShareLink(db, { listingId: 5001, actorId: 7, now: NOW, flags });
  recordListingShareEvent(db, { shareToken: l1.shareToken, eventType: "view", ip: "1.1.1.1", userAgent: "Mozilla", now: NOW });
  recordListingShareEvent(db, { shareToken: l1.shareToken, eventType: "view", ip: "1.1.1.2", userAgent: "Mozilla", now: NOW });
  recordListingShareEvent(db, { shareToken: l1.shareToken, eventType: "cta", ip: "1.1.1.3", userAgent: "Mozilla", now: NOW });
  const stats = listingShareStatsForUser(db, 7, { now: NOW, baseUrl: "https://example.com", flags });
  assert.equal(stats.dailyLimit, 20);
  assert.equal(stats.dailyUsed, 1);
  assert.deepEqual(stats.totals, { views: 2, ctas: 1 });
  assert.equal(stats.items.length, 1);
  assert.equal(stats.items[0].shareToken, l1.shareToken);
  assert.equal(stats.items[0].listingId, 5001);
  assert.equal(stats.items[0].views, 2);
  assert.equal(stats.items[0].ctas, 1);
  assert.match(stats.items[0].url, /^https:\/\/example\.com\/p\/5001\?ref=/);
});

test("listingShareStatsForAdmin：totals／daily／top 都正確", () => {
  resetShareGrowthLimits();
  const db = fixture();
  const l1 = createListingShareLink(db, { listingId: 5001, actorId: 7, now: NOW });
  recordListingShareEvent(db, { shareToken: l1.shareToken, eventType: "view", ip: "1.1.1.1", userAgent: "Mozilla", now: NOW });
  recordListingShareEvent(db, { shareToken: l1.shareToken, eventType: "cta", ip: "1.1.1.2", userAgent: "Mozilla", now: NOW });
  const stats = listingShareStatsForAdmin(db, 7, { now: NOW });
  assert.deepEqual(stats.totals, { views: 1, ctas: 1 });
  assert.equal(stats.daily.length, 1);
  assert.equal(stats.daily[0].views, 1);
  assert.equal(stats.daily[0].ctas, 1);
  assert.equal(stats.top.length, 1);
  assert.equal(stats.top[0].listingId, 5001);
  assert.equal(stats.top[0].views, 1);
  assert.equal(stats.top[0].ctas, 1);
});

test("normalizeListingShareFlags：預設 enabled=true、dailyLimit=20", () => {
  assert.deepEqual(normalizeListingShareFlags(undefined), { enabled: true, dailyLimit: 20 });
  assert.deepEqual(normalizeListingShareFlags({ enabled: false, dailyLimit: 3 }), { enabled: false, dailyLimit: 3 });
  assert.deepEqual(normalizeListingShareFlags({ dailyLimit: "bad" }), { enabled: true, dailyLimit: 20 });
});

test("recordListingShareEvent：cta 依管道保留歸因（同日不同管道各一筆、同管道去重）", () => {
  const db = fixture();
  const link = createListingShareLink(db, { listingId: 5001, actorId: 7, now: NOW, flags: { enabled: true, dailyLimit: 20 } });
  const a = recordListingShareEvent(db, { shareToken: link.shareToken, eventType: "cta", userId: 7, channel: "line", userAgent: "Mozilla", now: NOW });
  const b = recordListingShareEvent(db, { shareToken: link.shareToken, eventType: "cta", userId: 7, channel: "copy", userAgent: "Mozilla", now: NOW });
  const c = recordListingShareEvent(db, { shareToken: link.shareToken, eventType: "cta", userId: 7, channel: "line", userAgent: "Mozilla", now: NOW });
  assert.equal(a.recorded, true);
  assert.equal(b.recorded, true, "不同管道不應被同日去重吞掉");
  assert.deepEqual([c.recorded, c.reason], [false, "deduped"], "同管道同日應去重");
  const rows = db.prepare("SELECT channel FROM listing_share_events WHERE event_type='cta' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => r.channel), ["line", "copy"]);
});
