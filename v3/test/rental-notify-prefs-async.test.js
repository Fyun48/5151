// 租屋通知偏好／配對訂閱／取消訂閱 PG 分支的 parity（2026-09-28，第四十三批）。
//
// 這一包要釘住六件事：
//
//   1. **行程內快取要先跟上 PG**：`*For` 包裝原本用 `hydrateRentalMarketplace()` 灌
//      `flagsCache`（`assertRentalNotificationsEnabled()` 讀它）與 marketplace flags
//      （`publicRentalNotifyCaps()` 讀它）。PG 分支若跳過，會出現「站上明明開了通知，
//      PG 站卻回 404 rental_notify_disabled」——那是**功能全滅**而不是小差異，
//      所以這裡刻意讓「本機 settings」與「PG settings」不一致，驗 PG 版跟的是 PG。
//   2. **兩個 store**：本機還有同步讀者（`planDeliveries()` 讀 prefs、worker 的摘要讀訂閱），
//      所以 PG 寫完之後本機要有**同一組值**；反過來本機沒有那個 token 時不得亂寫
//      （信件可能是別的節點寄的）。
//   3. **取消連結只能用一次**（`used_at`），第二次回 already。
//   4. **scope → 關哪些開關**：`all`／`new_match`／`digest`／`lifecycle` 四種都要與同步版相同。
//   5. **PG 上的唯一鍵**：`rental_match_subscriptions` 的 `UNIQUE(owner_user_id, listing_id)`
//      是 SQLite 的表約束，鏡射抓不到 ⇒ 由模組自己補，這裡驗清單。
//   6. **`rental_notify_prefs.user_id` 不是 identity**（SQLite 的 `INTEGER PRIMARY KEY` 會被
//      鏡射成 identity，而它是使用者 id）⇒ ensure 要補 `DROP IDENTITY`。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-notifyprefs-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/rentalNotify.js");
const asyncMod = await import("../src/rentalNotifyPrefsAsync.js");
const dbMod = await import("../src/db.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-28T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/julianday\s*\(/i, "function julianday(text) does not exist"],
];

const TABLES = [
  "users", "settings", "listings", "rental_notify_prefs", "rental_match_subscriptions",
  "rental_unsubscribe_tokens", "rental_analytics_daily",
];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
  }
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    rows.rowCount = Number(mem.prepare("SELECT changes() AS n").get().n) || 0;
    return rows;
  };
  exec.raw = mem;
  return exec;
}

function clearWorld(h) {
  h.prepare("DELETE FROM rental_notify_prefs").run();
  h.prepare("DELETE FROM rental_match_subscriptions").run();
  h.prepare("DELETE FROM rental_unsubscribe_tokens").run();
  h.prepare("DELETE FROM rental_analytics_daily").run();
  h.prepare("DELETE FROM listings WHERE post_id >= 900000").run();
  h.prepare("DELETE FROM users WHERE email LIKE 'nprefs%@example.com'").run();
  h.prepare("DELETE FROM settings WHERE key = 'rentalMarketplaceFlags'").run();
}

function seedUsers(h) {
  for (const id of [1, 2]) {
    h.prepare(
      "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'free', ?)",
    ).run(id, `nprefs${id}@example.com`, `會員${id}`, OLD);
    h.prepare("UPDATE users SET nickname = ?, created_at = ? WHERE id = ?").run(`會員${id}`, OLD, id);
  }
}

// 刊登（`listings`）的最小必需欄位：`source_key`／`title`／`url`／`first_seen_at`／`last_seen_at`
// 都是 NOT NULL，`self_status` 由 `selfListings.js` 的 ALTER 加上。
function seedListing(h, { id, ownerId, selfStatus = "open" }) {
  h.prepare(
    `INSERT INTO listings(post_id, source_key, title, url, source, listed_by_user_id, self_status, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'self', ?, ?, ?, ?)`,
  ).run(id, `self-${id}`, `刊登 ${id}`, `https://example.com/${id}`, ownerId, selfStatus, OLD, OLD);
}

// settings 的值格式與 `db.js writeSettingKey()` 相同（JSON 字串）。
function setFlags(h, flags) {
  h.prepare("INSERT INTO settings(key, value) VALUES ('rentalMarketplaceFlags', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(flags));
}

const FLAGS_ON = { wish: { notifications_enabled: true } };
const FLAGS_OFF = { wish: { notifications_enabled: false } };

function resetBoth(seedFn) {
  const disk = handle();
  clearWorld(disk);
  seedUsers(disk);
  const exec = pgFixture();
  clearWorld(exec.raw);
  seedUsers(exec.raw);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}

const prefsRow = (h, uid) => h.prepare("SELECT * FROM rental_notify_prefs WHERE user_id = ?").get(uid);
const subsRows = (h) => h.prepare("SELECT owner_user_id, listing_id, mode, public_token FROM rental_match_subscriptions ORDER BY id").all();
const analyticsRows = (h) => h.prepare("SELECT day, metric, value FROM rental_analytics_daily ORDER BY metric").all();
const plain = (value) => JSON.parse(JSON.stringify(value));
// `public_token` 是 `newToken()` 產生的隨機值（同步版也是）——兩個 driver 不可能同值，
// 比對前遮罩；「有值」與「兩個 store 一致」另外單獨驗。
const maskRef = (view) => ({ ...view, subscription_ref: view.subscription_ref ? "«ref»" : view.subscription_ref });
const errorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};
const syncErrorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};

// ---------------------------------------------------------------------------

test("常數：PG 缺這三句就等於沒有去重、而且健檢會永遠紅著", () => {
  const sql = asyncMod.RENTAL_NOTIFY_PREFS_UNIQUE_INDEXES.join("\n");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS \S+ ON rental_match_subscriptions\(owner_user_id, listing_id\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS \S+ ON rental_match_subscriptions\(public_token\)/);
  assert.match(asyncMod.PREFS_DROP_IDENTITY_SQL, /ALTER TABLE rental_notify_prefs ALTER COLUMN user_id DROP IDENTITY IF EXISTS/);
  assert.deepEqual(asyncMod.RENTAL_NOTIFY_PREFS_WRITE_TABLES, [
    "rental_notify_prefs", "rental_match_subscriptions", "rental_unsubscribe_tokens",
  ]);
});

test("prefs 讀取：預設值、caps、以及快取要跟 PG 的 settings 而不是本機的", async () => {
  const [disk, exec] = resetBoth((h) => setFlags(h, FLAGS_ON));
  // ⚠️ 本機刻意寫成「通知關閉」：PG 版若忘了先灌行程內快取（或灌錯來源），
  // 這裡就會回 enabled:false（或是下面的寫入直接 404 rental_notify_disabled）。
  setFlags(disk, FLAGS_OFF);

  const syncView = syncMod.getRentalNotifyPrefs(disk, 1);
  const asyncView = await asyncMod.getRentalNotifyPrefsForAsync(1, { ...PG, exec, strict: true });
  assert.deepEqual(asyncView, { ...syncView, ...syncMod.publicRentalNotifyCaps(FLAGS_ON) }, "PG 版必須用 PG 的 caps");
  assert.equal(asyncView.enabled, true, "PG 的 settings 說通知是開的，caps 就必須是開的");
  assert.equal(asyncView.lifecycle_reminder, true, "沒有設定列時回預設值");
});

test("prefs 寫入：兩個 store 同一組值、計數各記一次、只覆蓋已知鍵", async () => {
  const [disk, exec] = resetBoth((h) => setFlags(h, FLAGS_ON));
  const patch = { lifecycle_reminder: false, channel_mail: true, 不存在的鍵: "x" };

  const syncView = syncMod.saveRentalNotifyPrefs(disk, 1, patch, new Date(NOW));
  const syncRow = prefsRow(disk, 1);

  clearWorld(disk);
  seedUsers(disk);
  setFlags(disk, FLAGS_ON);

  const asyncView = await asyncMod.saveRentalNotifyPrefsForAsync(1, patch, { ...PG, exec, strict: true, now: NOW });
  const pgRow = prefsRow(exec.raw, 1);
  const diskRow = prefsRow(disk, 1);

  // 回傳值含 caps（`enabled` 等），所以只比 prefs 那幾個鍵。
  for (const key of ["lifecycle_reminder", "new_match", "offer_transactional", "daily_digest", "channel_dock", "channel_mail", "channel_push", "timezone"]) {
    assert.equal(asyncView[key], syncView[key], `回傳的 ${key} 必須與同步版相同`);
    assert.equal(pgRow[key], syncRow[key], `PG 上的 ${key} 必須與同步版相同`);
    assert.equal(diskRow[key], syncRow[key], `本機的 ${key} 必須追上（兩個 store 都要寫）`);
  }
  assert.equal(pgRow.lifecycle_reminder, 0, "patch 要生效（否則這條測試沒有鑑別力）");
  assert.equal(pgRow["不存在的鍵"], undefined, "未知的鍵不得被寫進表格（那會是 SQL 錯誤）");
  assert.equal(asyncView.enabled, true, "caps 必須在（`*For` 的形狀）");
  const pgAnalytics = analyticsRows(exec.raw);
  const diskAnalytics = analyticsRows(disk);
  assert.equal(pgAnalytics.length, 1, "PG 的計數一次");
  assert.equal(diskAnalytics.length, 1, "本機的計數一次（不能多也不能少）");
  assert.deepEqual(pgAnalytics, diskAnalytics, "兩個 store 的計數必須相同");
  assert.equal(pgAnalytics[0].metric, "pref_updated");
});

test("prefs 寫入：未登入 401、站上通知關閉時 404（兩個 driver 相同）", async () => {
  const [disk, exec] = resetBoth((h) => setFlags(h, FLAGS_ON));
  const cases = [
    { uid: 0, patch: { new_match: true }, flags: FLAGS_ON, why: "未登入" },
    { uid: 1, patch: { new_match: true }, flags: FLAGS_OFF, why: "站上通知關閉" },
  ];
  for (const c of cases) {
    setFlags(disk, c.flags);
    setFlags(exec.raw, c.flags);
    // ⚠️ 同步對照一定要用 `db.js` 的 `saveRentalNotifyPrefsFor()`（＝路由實際呼叫的入口）：
    // 它會先 `hydrateRentalMarketplace()` 把 `flagsCache` 換成 settings 的值。直接呼叫
    // `rentalNotify.saveRentalNotifyPrefs()` 的話，快取還是**上一個測試**留下的狀態，
    // 「站上通知關閉」那一條就永遠不會紅（第一版就是這樣寫的）。
    const syncErr = syncErrorShape(() => dbMod.saveRentalNotifyPrefsFor(c.uid, c.patch, new Date(NOW)));
    const asyncErr = await errorShape(() => asyncMod.saveRentalNotifyPrefsForAsync(c.uid, c.patch, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${c.why}）`);
    assert.equal(prefsRow(exec.raw, 1), undefined, `PG 不得被寫入（${c.why}）`);
  }
});

test("訂閱：讀取（沒有列回 off）、第一次 INSERT、第二次 UPDATE，兩個 store 同一個 token", async () => {
  const [disk, exec] = resetBoth((h) => {
    setFlags(h, FLAGS_ON);
    seedListing(h, { id: 900001, ownerId: 1 });
  });

  // 還沒有訂閱
  const syncEmpty = syncMod.getMatchSubscription(disk, 1, 900001);
  const asyncEmpty = await asyncMod.getMatchSubscriptionAsync(1, 900001, { ...PG, exec, strict: true });
  assert.deepEqual(asyncEmpty, syncEmpty, "沒有訂閱時的形狀必須相同");
  assert.deepEqual(asyncEmpty, { listing_ref: 900001, mode: "off", subscription_ref: "" });

  // 第一次（INSERT）
  const syncFirst = syncMod.saveMatchSubscription(disk, 1, 900001, "instant", new Date(NOW));
  const asyncFirst = await asyncMod.saveMatchSubscriptionAsync(1, 900001, "instant", { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(plain(maskRef(asyncFirst)), plain(maskRef(syncFirst)), "第一次的形狀必須相同（token 是隨機值）");
  assert.equal(asyncFirst.mode, "instant");
  assert.ok(asyncFirst.subscription_ref, "必須產生 public_token");
  assert.equal(subsRows(exec.raw).length, 1, "PG 上必須只有一列");
  assert.equal(subsRows(disk).length, 1, "本機也要有一列");
  assert.equal(subsRows(disk)[0].public_token, subsRows(exec.raw)[0].public_token, "兩個 store 的 token 必須相同");

  // 第二次（UPDATE，不得新增列）
  const syncSecond = syncMod.saveMatchSubscription(disk, 1, 900001, "daily_digest", new Date(NOW));
  const asyncSecond = await asyncMod.saveMatchSubscriptionAsync(1, 900001, "daily_digest", { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(plain(maskRef(asyncSecond)), plain(maskRef(syncSecond)), "第二次的形狀必須相同");
  assert.equal(asyncSecond.mode, "daily_digest");
  assert.equal(asyncSecond.subscription_ref, asyncFirst.subscription_ref, "UPDATE 不得換 token");
  assert.equal(subsRows(exec.raw).length, 1, "UPDATE 不得新增列");
  assert.equal(subsRows(disk).length, 1);
  assert.equal(subsRows(disk)[0].mode, "daily_digest", "本機也要追上");
});

test("訂閱：不是自己的刊登／不存在／不合法的 mode，錯誤與結果都要與同步版相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    setFlags(h, FLAGS_ON);
    seedListing(h, { id: 900002, ownerId: 2 });
  });
  const cases = [
    { uid: 1, lid: 900002, mode: "instant", why: "別人的刊登" },
    { uid: 1, lid: 900099, mode: "instant", why: "刊登不存在" },
    { uid: 1, lid: 0, mode: "instant", why: "沒有刊登 id" },
  ];
  for (const c of cases) {
    const syncErr = syncErrorShape(() => syncMod.saveMatchSubscription(disk, c.uid, c.lid, c.mode, new Date(NOW)));
    const asyncErr = await errorShape(() => asyncMod.saveMatchSubscriptionAsync(c.uid, c.lid, c.mode, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${c.why}）`);
    assert.equal(subsRows(exec.raw).length, 0, `PG 不得被寫入（${c.why}）`);
  }
  // 不合法的 mode 降級成 off（兩邊相同）
  seedListing(disk, { id: 900003, ownerId: 1 });
  seedListing(exec.raw, { id: 900003, ownerId: 1 });
  const syncOdd = syncMod.saveMatchSubscription(disk, 1, 900003, "亂寫", new Date(NOW));
  const asyncOdd = await asyncMod.saveMatchSubscriptionAsync(1, 900003, "亂寫", { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(plain(maskRef(asyncOdd)), plain(maskRef(syncOdd)), "不合法的 mode 的結果必須相同");
  assert.equal(asyncOdd.mode, "off");
});

test("取消訂閱：四種 scope 的效果與同步版相同，而且只能用一次", async () => {
  for (const scope of ["all", "new_match", "digest", "lifecycle"]) {
    const [disk, exec] = resetBoth((h) => setFlags(h, FLAGS_ON));
    // 先把 prefs 打開、並種兩筆訂閱（instant／daily_digest），才能看出 scope 的差別
    for (const h of [disk, exec.raw]) {
      h.prepare("INSERT INTO rental_notify_prefs(user_id, lifecycle_reminder, new_match, offer_transactional, daily_digest, channel_dock, channel_mail, channel_push, timezone, updated_at) VALUES (1,1,1,1,1,1,1,1,'Asia/Taipei',?)").run(OLD);
      h.prepare("INSERT INTO rental_match_subscriptions(public_token, owner_user_id, listing_id, mode, created_at, updated_at) VALUES ('tok-a',1,900011,'instant',?,?)").run(OLD, OLD);
      h.prepare("INSERT INTO rental_match_subscriptions(public_token, owner_user_id, listing_id, mode, created_at, updated_at) VALUES ('tok-b',1,900012,'daily_digest',?,?)").run(OLD, OLD);
      h.prepare("INSERT INTO rental_unsubscribe_tokens(token, user_id, scope, expires_at, used_at) VALUES (?, 1, ?, ?, NULL)").run(`tok-${scope}`, scope, FUTURE);
    }
    const syncResult = syncMod.applyUnsubscribeToken(disk, `tok-${scope}`, new Date(NOW));
    const syncPrefs = prefsRow(disk, 1);
    const syncSubs = subsRows(disk);
    // 同步版也要標記已用，而且第二次要回 already（少了那一行，「連結只能用一次」就失效）
    assert.ok(
      disk.prepare("SELECT used_at FROM rental_unsubscribe_tokens WHERE token = ?").get(`tok-${scope}`).used_at,
      `同步版必須標記 token 已用（scope=${scope}）`,
    );
    assert.deepEqual(
      syncMod.applyUnsubscribeToken(disk, `tok-${scope}`, new Date(NOW)),
      { ok: true, already: true },
      `同步版第二次必須回 already（scope=${scope}）`,
    );

    // 磁碟回到同一起點再跑 PG 分支
    disk.prepare("DELETE FROM rental_notify_prefs").run();
    disk.prepare("DELETE FROM rental_match_subscriptions").run();
    disk.prepare("DELETE FROM rental_unsubscribe_tokens").run();
    disk.prepare("INSERT INTO rental_notify_prefs(user_id, lifecycle_reminder, new_match, offer_transactional, daily_digest, channel_dock, channel_mail, channel_push, timezone, updated_at) VALUES (1,1,1,1,1,1,1,1,'Asia/Taipei',?)").run(OLD);
    disk.prepare("INSERT INTO rental_match_subscriptions(public_token, owner_user_id, listing_id, mode, created_at, updated_at) VALUES ('tok-a',1,900011,'instant',?,?)").run(OLD, OLD);
    disk.prepare("INSERT INTO rental_match_subscriptions(public_token, owner_user_id, listing_id, mode, created_at, updated_at) VALUES ('tok-b',1,900012,'daily_digest',?,?)").run(OLD, OLD);
    disk.prepare("INSERT INTO rental_unsubscribe_tokens(token, user_id, scope, expires_at, used_at) VALUES (?, 1, ?, ?, NULL)").run(`tok-${scope}`, scope, FUTURE);

    const asyncResult = await asyncMod.applyUnsubscribeTokenAsync(`tok-${scope}`, { ...PG, exec, strict: true, now: NOW });
    assert.deepEqual(asyncResult, syncResult, `回傳值必須相同（scope=${scope}）`);
    assert.deepEqual(plain(prefsRow(exec.raw, 1)), plain(syncPrefs), `PG 的 prefs 必須相同（scope=${scope}）`);
    assert.deepEqual(plain(prefsRow(disk, 1)), plain(syncPrefs), `本機的 prefs 必須追上（scope=${scope}）`);
    assert.deepEqual(plain(subsRows(exec.raw)), plain(syncSubs), `PG 的訂閱必須相同（scope=${scope}）`);
    assert.deepEqual(plain(subsRows(disk)), plain(syncSubs), `本機的訂閱必須追上（scope=${scope}）`);
    // 只能用一次
    const again = await asyncMod.applyUnsubscribeTokenAsync(`tok-${scope}`, { ...PG, exec, strict: true, now: NOW });
    assert.deepEqual(again, { ok: true, already: true }, `第二次必須回 already（scope=${scope}）`);
    assert.ok(exec.raw.prepare("SELECT used_at FROM rental_unsubscribe_tokens WHERE token = ?").get(`tok-${scope}`).used_at, "PG 上必須標記已用");
  }
});

test("取消訂閱：過期／不像 token 的字串、以及本機沒有這個 token 時仍要成功", async () => {
  const [disk, exec] = resetBoth((h) => {
    setFlags(h, FLAGS_ON);
    h.prepare("INSERT INTO rental_unsubscribe_tokens(token, user_id, scope, expires_at, used_at) VALUES ('tok-expired', 1, 'all', ?, NULL)").run(PAST);
  });
  for (const [token, why] of [["tok-expired", "已過期"], ["12345", "數字字串"], ["tok-missing", "不存在"]]) {
    const syncErr = syncErrorShape(() => syncMod.applyUnsubscribeToken(disk, token, new Date(NOW)));
    const asyncErr = await errorShape(() => asyncMod.applyUnsubscribeTokenAsync(token, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${why}）`);
  }

  // ⚠️ 站上通知**關閉**時，取消連結仍然必須生效（同步版是暫時把閘門打開再還原）。
  // 少了 `withNotificationsForcedEnabledAsync()`，PG 版會在 `savePrefsPg()` 的
  // `assertRentalNotificationsEnabled()` 直接 404 —— 使用者按了取消卻沒取消。
  for (const h of [disk, exec.raw]) {
    setFlags(h, FLAGS_OFF);
    h.prepare("INSERT INTO rental_unsubscribe_tokens(token, user_id, scope, expires_at, used_at) VALUES ('tok-off', 1, 'all', ?, NULL)").run(FUTURE);
  }
  const syncOff = dbMod.applyUnsubscribeTokenFor("tok-off", new Date(NOW));
  const asyncOff = await asyncMod.applyUnsubscribeTokenAsync("tok-off", { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(asyncOff, syncOff, "站上通知關閉時，取消連結的效果必須與同步版相同");
  assert.deepEqual(asyncOff, { ok: true, already: false });
  assert.equal(prefsRow(exec.raw, 1).channel_mail, 0, "PG 上的 prefs 必須真的被改到");

  // ⚠️ 「本機沒有這個 token」：信件可能是**別的節點**寄的，PG 有、本機沒有。
  // 這一條要成功（PG 上真的生效），而且不得在本機亂寫。
  exec.raw.prepare("INSERT INTO rental_unsubscribe_tokens(token, user_id, scope, expires_at, used_at) VALUES ('tok-elsewhere', 2, 'all', ?, NULL)").run(FUTURE);
  const result = await asyncMod.applyUnsubscribeTokenAsync("tok-elsewhere", { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(result, { ok: true, already: false }, "PG 上有 token 就要成功");
  assert.ok(exec.raw.prepare("SELECT used_at FROM rental_unsubscribe_tokens WHERE token = 'tok-elsewhere'").get().used_at, "PG 上必須標記已用");
  assert.equal(
    disk.prepare("SELECT COUNT(*) AS n FROM rental_unsubscribe_tokens WHERE token = 'tok-elsewhere'").get().n, 0,
    "本機沒有那個 token 時不得無中生有",
  );
});

test("非 postgres 模式必須走同步路徑（不碰傳入的 exec）", async () => {
  const [disk, exec] = resetBoth((h) => {
    setFlags(h, FLAGS_ON);
    seedListing(h, { id: 900004, ownerId: 1 });
  });
  let touched = 0;
  const counting = async (sql, params = []) => { touched += 1; return exec(sql, params); };
  const prefsView = await asyncMod.saveRentalNotifyPrefsForAsync(1, { new_match: true }, { driver: "sqlite", exec: counting, now: NOW });
  const sub = await asyncMod.saveMatchSubscriptionAsync(1, 900004, "instant", { driver: "sqlite", exec: counting, now: NOW });
  assert.equal(touched, 0, "SQLite 模式不得碰 PG runner");
  assert.equal(prefsView.new_match, true);
  assert.equal(sub.mode, "instant");
  assert.equal(prefsRow(disk, 1).new_match, 1, "要走同步路徑寫本機");
  assert.equal(prefsRow(exec.raw, 1), undefined, "不得寫 PG 夾具");
  assert.equal(subsRows(exec.raw).length, 0, "不得寫 PG 夾具");
});

test("prefs 寫入：PG 說通知關閉、本機說開啟 ⇒ PG 版必須擋（快取要跟 PG）", async () => {
  // ⚠️ 這一條是專門用來殺「忘記先 `getWishConditionsAsync()`」的變異：那時候行程內快取
  // 會停在**本機**的設定，於是 PG 站明明關了通知、寫入卻照樣成功。
  // 順序也刻意：先把快取弄成「本機說開啟」，再呼叫 PG 版。
  const [disk, exec] = resetBoth((h) => setFlags(h, FLAGS_ON));
  setFlags(exec.raw, FLAGS_OFF);
  dbMod.getWishConditions();
  const err = await errorShape(() => asyncMod.saveRentalNotifyPrefsForAsync(1, { new_match: true }, { ...PG, exec, strict: true, now: NOW }));
  assert.equal(err?.code, "rental_notify_disabled", "PG 說關閉就必須擋下來");
  assert.equal(err?.status, 404);
  assert.equal(prefsRow(exec.raw, 1), undefined, "擋下來時 PG 不得被寫入");
  assert.equal(prefsRow(disk, 1), undefined, "擋下來時本機也不得被寫入");
  // 收尾：把快取還原成「開啟」，免得影響（同一支測試檔後續的）同步路徑。
  setFlags(disk, FLAGS_ON);
  dbMod.getWishConditions();
});
