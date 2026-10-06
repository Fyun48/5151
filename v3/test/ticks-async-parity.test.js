// 三支 5 分鐘 tick 的 PG 分支 parity（2026-10）。
//
// 驗證「同步版（本機 SQLite）」與「async 版（PG 替身，注入式 exec）」在**同一個起點**上
// 產出一致的結果與落地狀態。為什麼用 SQLite 當 PG 替身：`wish-offers-async.test.js` 的同一套
// 手法——把磁碟上的真實 DDL 鏡射進記憶體，PG 分支只換「誰去跑 SQL」，決策函式兩邊共用。
//
// ⚠️ `strict: true` 是必需品：async 分支是 fail-closed 寫入，但讀取會 fail-open；
// 不開 strict 的話 PG 分支丟錯會靜默回 SQLite 答案，parity 永遠是綠的。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-ticks-async-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const demand = await import("../src/demand.js");
const notify = await import("../src/rentalNotify.js");
const offers = await import("../src/wishOffers.js");
const lifecycle = await import("../src/wishLifecycleLoop.js");
const offerWorker = await import("../src/wishOfferWorker.js");
const notifyWorker = await import("../src/rentalNotifyWorker.js");
const lifecycleAsync = await import("../src/wishLifecycleAsync.js");
const offersAsync = await import("../src/wishOffersAsync.js");
const notifyWorkerAsync = await import("../src/rentalNotifyWorkerAsync.js");

const PG = { driver: "postgres" };
const NOW = new Date("2026-09-28T12:00:00.000Z");

const FLAGS = {
  wish: {
    lifecycle_enabled: true,
    offer_enabled: true,
    notifications_enabled: true,
    owner_matching_enabled: false,
    digest_enabled: false,
    outbound_mail_enabled: false,
    outbound_push_enabled: false,
  },
};

const handle = () => dbMod.sqliteHandle();

// 磁碟上的 DDL ＋ 資料鏡射進記憶體夾具（與 wish-offers-async.test.js 同一套）。
const FIXTURE_TABLES = [
  "users", "demand_posts", "wish_offers", "wish_offer_events",
  "rental_notify_events", "rental_notify_deliveries", "rental_notify_prefs",
  "rental_digest_buckets", "rental_digest_items", "rental_match_seen",
  "rental_match_subscriptions", "rental_notify_cursors", "rental_share_events",
  "rental_analytics_daily", "user_blocks",
];

function ensureSchemas(db) {
  demand.ensureDemandSchema(db);
  notify.ensureRentalNotifySchema(db);
  offers.ensureWishOfferSchema(db);
}

function mirrorFixture() {
  const mem = new DatabaseSync(":memory:");
  const ro = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true });
  for (const table of FIXTURE_TABLES) {
    const ddl = ro.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  ro.close();
  return mem;
}

function copyRows(from, to) {
  for (const table of FIXTURE_TABLES) {
    to.prepare(`DELETE FROM ${table}`).run();
    for (const row of from.prepare(`SELECT * FROM ${table}`).all()) {
      const cols = Object.keys(row);
      to.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
        .run(...cols.map((c) => row[c]));
    }
  }
}

function pgExec(mem) {
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string") throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
  exec.raw = mem;
  return exec;
}

function resetWorld() {
  const db = handle();
  ensureSchemas(db);
  for (const table of [
    "rental_share_events", "rental_digest_items", "rental_digest_buckets",
    "rental_notify_deliveries", "rental_notify_events", "rental_notify_cursors",
    "rental_notify_prefs", "rental_match_seen", "rental_match_subscriptions",
    "rental_analytics_daily", "wish_offer_events", "wish_offers", "demand_posts",
    "user_blocks",
  ]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* not yet created */ }
  }
  const mem = mirrorFixture();
  copyRows(db, mem);
  return [db, mem, pgExec(mem)];
}

function seedUser(db, id) {
  db.prepare("INSERT OR REPLACE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free','2026-01-01T00:00:00.000Z')")
    .run(id, `u${id}@example.com`, `會員${id}`);
}

function seedDueWish(db, id, { lifecycle: lc = "active", expiresAt = null, lastActiveAt = null, status = "open", token = `wish-${id}` } = {}) {
  seedUser(db, id); // demand_posts.user_id 有 FK 到 users.id（db.js 開 foreign_keys=ON）
  const stamp = NOW.toISOString();
  const expire = expiresAt || new Date(NOW.getTime() + 3 * 86400000).toISOString();
  db.prepare(
    `INSERT INTO demand_posts(id, user_id, status, lifecycle, expires_at, last_confirmed_at, last_active_at, created_at, public_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, status, lc, expire, lastActiveAt || stamp, lastActiveAt || stamp, stamp, token);
}

// ─────────────────────────────────────────────────────────────────────────────

test("許願房生命週期 tick：結果與落地狀態兩邊一致", async () => {
  const [db, mem, exec] = resetWorld();
  // 三筆：1 筆即將逾期（active → needs_confirmation）、1 筆剛確認（不變）、1 筆已過期（跳過）。
  seedUser(db, 1);
  seedDueWish(db, 1, { expiresAt: new Date(NOW.getTime() - 86400000).toISOString() });
  seedDueWish(db, 2, { expiresAt: new Date(NOW.getTime() + 30 * 86400000).toISOString(), lastActiveAt: NOW.toISOString() });
  seedDueWish(db, 3, { status: "expired", lifecycle: "expired", expiresAt: new Date(NOW.getTime() - 86400000).toISOString() });
  copyRows(db, mem);

  const cursorA = { value: 0 };
  const cursorB = { value: 0 };
  const sync = lifecycle.runWishLifecycleTick(db, NOW, {
    flags: FLAGS,
    cursor: { get: () => cursorA.value, set: (id) => { cursorA.value = id; } },
  });
  const async = await lifecycleAsync.runWishLifecycleTickAsync(NOW, {
    flags: FLAGS,
    cursor: { get: () => cursorB.value, set: (id) => { cursorB.value = id; } },
  }, { ...PG, exec, strict: true });

  assert.deepEqual(async, sync, "tick 結果必須逐鍵相同");
  assert.equal(sync.changed, 1, "只有 1 筆真的變更（否則這條沒鑑別力）");
  const states = (h) => h.prepare("SELECT lifecycle, status FROM demand_posts ORDER BY id").all();
  assert.deepEqual(states(exec.raw), states(db), "demand_posts 的最終狀態必須相同");
});

test("提案逾期 tick：結果與事件兩邊一致", async () => {
  const [db, mem, exec] = resetWorld();
  seedUser(db, 1);
  seedUser(db, 2);
  db.prepare(
    `INSERT INTO wish_offers(id, public_token, owner_user_id, tenant_user_id, listing_id, wish_id, status, version, expires_at, created_at, updated_at)
     VALUES (?, ?, 2, 1, 2, 1, 'pending', 1, ?, ?, ?)`,
  ).run(1, "offer-expired", "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
  db.prepare(
    `INSERT INTO wish_offers(id, public_token, owner_user_id, tenant_user_id, listing_id, wish_id, status, version, expires_at, created_at, updated_at)
     VALUES (?, ?, 2, 1, 2, 2, 'pending', 1, ?, ?, ?)`,
  ).run(2, "offer-future", new Date(NOW.getTime() + 7 * 86400000).toISOString(), "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
  copyRows(db, mem);

  const sync = offerWorker.runWishOfferExpiryTick(db, NOW, { flags: FLAGS });
  const async = await offersAsync.runWishOfferExpiryTickAsync(NOW, { flags: FLAGS }, { ...PG, exec, strict: true });

  assert.deepEqual(async, sync, "tick 結果必須逐鍵相同");
  assert.equal(sync.changed, 1, "只有過期的那筆被變更");
  const statuses = (h) => h.prepare("SELECT status FROM wish_offers ORDER BY id").all().map((r) => r.status);
  assert.deepEqual(statuses(exec.raw), statuses(db), "wish_offers 狀態必須相同");
  const events = (h) => h.prepare("SELECT event_type, offer_id FROM wish_offer_events ORDER BY id").all();
  assert.deepEqual(events(exec.raw), events(db), "wish_offer_events 必須相同");
});

test("租屋通知 tick：投遞／排程／清理結果兩邊一致", async () => {
  const [db, mem, exec] = resetWorld();
  seedUser(db, 1);
  // 一筆 3 天後到期的許願房 ⇒ lifecycle reminder（會再產生一筆 dock delivery，由同一輪 drain 掉）。
  seedDueWish(db, 10, { expiresAt: new Date(NOW.getTime() + 3 * 86400000).toISOString() });
  // 一筆 14 天沒動、沒有 active offer 的許願房 ⇒ tenant retention。
  seedDueWish(db, 11, { expiresAt: new Date(NOW.getTime() + 30 * 86400000).toISOString(), lastActiveAt: new Date(NOW.getTime() - 20 * 86400000).toISOString() });
  // 一筆 24 小時內到期的 pending 提案 ⇒ offer expiring。
  db.prepare(
    `INSERT INTO wish_offers(id, public_token, owner_user_id, tenant_user_id, listing_id, wish_id, status, version, expires_at, created_at, updated_at)
     VALUES (?, ?, 2, 1, 2, 10, 'pending', 1, ?, ?, ?)`,
  ).run(1, "offer-soon", new Date(NOW.getTime() + 12 * 3600_000).toISOString(), "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
  copyRows(db, mem);

  const sync = notifyWorker.runRentalNotifyTick(db, NOW, { flags: FLAGS });
  const async = await notifyWorkerAsync.runRentalNotifyTickAsync(NOW, { flags: FLAGS }, { ...PG, exec, strict: true });

  assert.equal(sync.skipped, false);
  assert.deepEqual(async.reminders, sync.reminders, "reminders 必須相同");
  assert.deepEqual(async.expiring, sync.expiring, "expiring 必須相同");
  assert.deepEqual(async.tenantRetention, sync.tenantRetention, "tenantRetention 必須相同");
  assert.deepEqual(async.ownerRetention, sync.ownerRetention, "ownerRetention 必須相同");
  assert.deepEqual(async.matches, sync.matches, "matches 必須相同");
  assert.deepEqual(async.digest, sync.digest, "digest 必須相同");
  assert.deepEqual(async.delivered, sync.delivered, "delivered 必須相同");
  assert.deepEqual(async.cleanup, sync.cleanup, "cleanup 必須相同");
  assert.ok(sync.reminders.emitted >= 1, "至少要排出一筆 reminder（否則沒鑑別力）");

  // 落地狀態：事件數、投遞狀態、分析計數在兩個 store 一致。
  const events = (h) => h.prepare("SELECT event_type, COUNT(*) AS n FROM rental_notify_events GROUP BY event_type ORDER BY event_type").all();
  assert.deepEqual(events(exec.raw), events(db), "rental_notify_events 必須相同");
  const deliveries = (h) => h.prepare("SELECT channel, status FROM rental_notify_deliveries ORDER BY id").all();
  assert.deepEqual(deliveries(exec.raw), deliveries(db), "rental_notify_deliveries 必須相同");
  const analytics = (h) => h.prepare("SELECT metric, value FROM rental_analytics_daily ORDER BY metric").all();
  assert.deepEqual(analytics(exec.raw), analytics(db), "rental_analytics_daily 必須相同");
});

test("租屋通知 tick：通知關閉時兩邊都跳過", async () => {
  const [db, mem, exec] = resetWorld();
  const off = { wish: { notifications_enabled: false } };
  const sync = notifyWorker.runRentalNotifyTick(db, NOW, { flags: off });
  const async = await notifyWorkerAsync.runRentalNotifyTickAsync(NOW, { flags: off }, { ...PG, exec, strict: true });
  assert.deepEqual(async, sync, "跳過形狀必須相同");
  assert.equal(sync.skipped, true);
});

test("非 postgres 必須回退同步路徑（不碰傳入的 exec）", async () => {
  const [db, mem] = resetWorld();
  seedUser(db, 1);
  seedDueWish(db, 1, { expiresAt: new Date(NOW.getTime() - 86400000).toISOString() });
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const cursor = { value: 0 };
  const result = await lifecycleAsync.runWishLifecycleTickAsync(NOW, {
    flags: FLAGS,
    cursor: { get: () => cursor.value, set: (id) => { cursor.value = id; } },
  }, { driver: "sqlite", exec: boom });
  assert.equal(result.changed, 1, "sqlite 模式必須讀磁碟");
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
});
