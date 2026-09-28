// Admin 營運分析（rental ops）PG 分支的 parity（2026-09-28，第四十二批）。
//
// 這一支是一包 30 幾個查詢的彙總，所以測試的重點是「**整包逐鍵相同**」與「錯誤碼相同」：
//
//   1. 語句只有一份（`RENTAL_OPS_SQL` 等常數），但**組裝**是同步版的轉錄——
//      所以要深度比對整個 summary（含每個 `*_definition` 文案），任何一個鍵接錯都會紅。
//   2. **中位數是方言分支**：SQLite 用 `julianday()`、PG 用 `EXTRACT(EPOCH FROM …)`。
//      離線夾具是記憶體 SQLite，所以它把 PG 那一句**翻回去**（見 `PG_TO_STANDIN`）；
//      真正的 PG 語句由 `rental-ops-live-pg.test.js` 在真 PG 上驗。
//      奇數與偶數的母體都要各驗一次（兩條分支不一樣）。
//   3. **錯誤碼**：`analytics_metric_failed`／`analytics_series_failed`／`analytics_count_failed`／
//      `analytics_median_failed`／`analytics_drill_failed` 是 admin 畫面用來分辨「哪一類查詢壞掉」
//      的資訊，不能因為換 driver 就變成同一個碼。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-rentalops-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/rentalOpsAnalytics.js");
const asyncMod = await import("../src/rentalOpsAnalyticsAsync.js");
const dbMod = await import("../src/db.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const OLD = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2099-01-01T00:00:00.000Z";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/julianday\s*\(/i, "function julianday(text) does not exist"],
];

// ⚠️ 這一條是**刻意**的例外：`medianOrderPg` 是 PG 專屬寫法，而離線夾具是 SQLite 替身。
// 夾具把 PG 那一句翻回 SQLite 的等價寫法，讓 parity 測試仍然能驗到
// 「取中間 1～2 列」的邏輯；真正的 PG 語句由 live PG 測試負責。
const PG_TO_STANDIN = [
  [
    /\(EXTRACT\(EPOCH FROM \(accepted_at::timestamptz - created_at::timestamptz\)\)\)/gi,
    "(julianday(accepted_at) - julianday(created_at)) * 86400",
  ],
];

const TABLES = [
  "users", "demand_posts", "demand_replies", "demand_match_districts", "user_listing_flags",
  "settings", "wish_offers", "wish_offer_reports", "rental_analytics_daily",
  "rental_match_subscriptions", "rental_match_seen", "rental_completion_surveys",
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
  const exec = async (rawSql, params = []) => {
    let sql = String(rawSql);
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(rawSql)}`);
    }
    // ⚠️ 順序很重要：**先**驗「PG 分支有沒有寫出 SQLite 專屬語法」，**再**翻譯。
    // 顛倒過來的話，翻譯出來的 `julianday(...)` 會被自己的守衛擋下來
    // （症狀是 `analytics_median_failed`，看起來像模組壞了）。
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    for (const [pattern, replacement] of PG_TO_STANDIN) sql = sql.replace(pattern, replacement);
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    rows.rowCount = Number(mem.prepare("SELECT changes() AS n").get().n) || 0;
    return rows;
  };
  exec.raw = mem;
  return exec;
}

function clearWorld(h) {
  h.prepare("DELETE FROM wish_offer_reports").run();
  h.prepare("DELETE FROM wish_offers").run();
  h.prepare("DELETE FROM rental_analytics_daily").run();
  h.prepare("DELETE FROM rental_match_subscriptions").run();
  h.prepare("DELETE FROM rental_match_seen").run();
  h.prepare("DELETE FROM rental_completion_surveys").run();
  h.prepare("DELETE FROM demand_replies").run();
  h.prepare("DELETE FROM demand_posts").run();
  h.prepare("DELETE FROM users WHERE email LIKE 'ops%@example.com'").run();
}

function seedUsers(h) {
  // ⚠️ 每一位許願房都要用**不同**的帳號：`idx_demand_one_mutable` 是
  // UNIQUE(user_id) WHERE status IN ('open','draft')，同一人不能同時有兩則 open／draft
  // （測試第一版就是這樣紅的）。1～6 給許願房、7～8 給提案的承租人。
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) {
    h.prepare(
      "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'free', ?)",
    ).run(id, `ops${id}@example.com`, `會員${id}`, OLD);
    h.prepare("UPDATE users SET nickname = ?, created_at = ? WHERE id = ?").run(`會員${id}`, OLD, id);
  }
}

function seedWish(h, { id, userId, lifecycle, status = "open" }) {
  h.prepare(
    `INSERT INTO demand_posts(id, user_id, districts, rent_max, housing_type, mrt_walk, body, status,
       created_at, updated_at, expires_at, published_at, public_token, legacy_numeric_share, lifecycle, closed_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, '["1-5"]', 30000, "any", 0, "找房的內容", status, OLD, OLD, EXPIRES, OLD, `tok-${id}`, 1, lifecycle, "");
}

// ⚠️ 欄位要照 `wishOffers.js` 的 DDL：`wish_offers` 沒有 `message`，
// 但有 `updated_at`／`expires_at`（NOT NULL）。夾具是從磁碟鏡射 DDL，所以欄位錯了會直接紅。
// 另外 `listing_id` 一定要一筆一個：`idx_wish_offers_active_unique` 是
// UNIQUE(owner_user_id, listing_id, wish_id) WHERE status IN ('pending','accepted')，
// 同一組三元最多一筆 pending／accepted。
function seedOffer(h, { id, userId = 7, status, createdAt, acceptedAt = null }) {
  h.prepare(
    `INSERT INTO wish_offers(id, public_token, wish_id, listing_id, owner_user_id, tenant_user_id, status,
       created_at, updated_at, expires_at, accepted_at)
     VALUES (?, ?, 1002, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `offer-${id}`, id, userId, status, createdAt, createdAt, EXPIRES, acceptedAt);
}

function seedMetric(h, day, metric, value) {
  h.prepare("INSERT INTO rental_analytics_daily(day, metric, value) VALUES (?, ?, ?)").run(day, metric, value);
}

// 一份「每個分支都有東西」的資料集：存量、期間流量、中位數（偶數／奇數）、序列、問卷。
function seedWorld(h, { acceptedCount }) {
  seedWish(h, { id: 1001, userId: 1, lifecycle: "draft", status: "draft" });
  seedWish(h, { id: 1002, userId: 2, lifecycle: "active" });
  seedWish(h, { id: 1003, userId: 3, lifecycle: "needs_confirmation" });
  seedWish(h, { id: 1004, userId: 4, lifecycle: "paused", status: "closed" });
  seedWish(h, { id: 1005, userId: 5, lifecycle: "completed", status: "closed" });
  seedWish(h, { id: 1006, userId: 6, lifecycle: "expired", status: "closed" });

  // 期間內：3 筆 created（其中 acceptedCount 筆 accepted）＋ 1 筆期間外
  for (let i = 0; i < acceptedCount; i += 1) {
    seedOffer(h, {
      id: 2001 + i,
      status: "accepted",
      createdAt: `2026-09-0${i + 1}T00:00:00.000Z`,
      // 秒差：600、1200、1800、2400（母體中位數就是中間兩個的平均或正中間那個）
      acceptedAt: `2026-09-0${i + 1}T00:${String(10 * (i + 1)).padStart(2, "0")}:00.000Z`,
    });
  }
  seedOffer(h, { id: 2100, status: "pending", createdAt: "2026-09-05T00:00:00.000Z" });
  if (acceptedCount < 3) seedOffer(h, { id: 2101, status: "declined", createdAt: "2026-09-06T00:00:00.000Z" });
  seedOffer(h, { id: 2102, status: "withdrawn", createdAt: "2026-08-01T00:00:00.000Z" }); // 期間外（早於 from）
  // 期間外（晚於 to）：**兩端都要有**，否則「迄日被忽略」那一類的錯誤不會有任何測試紅
  seedOffer(h, { id: 2105, status: "accepted", createdAt: "2026-10-15T00:00:00.000Z", acceptedAt: "2026-10-15T00:10:00.000Z" });
  seedOffer(h, { id: 2103, status: "expired", createdAt: "2026-09-07T00:00:00.000Z" });
  seedOffer(h, { id: 2104, status: "blocked", createdAt: "2026-09-08T00:00:00.000Z" });
  // `wish_offer_reports` 的欄位是 reporter_user_id／reported_user_id／listing_id（照 DDL），
  // 而且有 UNIQUE(reporter_user_id, offer_id) 的防重複索引 ⇒ 兩筆要用不同的檢舉人。
  h.prepare(
    `INSERT INTO wish_offer_reports(id, public_token, offer_id, reporter_user_id, reported_user_id, listing_id, reason, created_at)
     VALUES (3001, 'report-1', 2001, 7, 1, 2001, '廣告', '2026-09-03T00:00:00.000Z')`,
  ).run();
  h.prepare(
    `INSERT INTO wish_offer_reports(id, public_token, offer_id, reporter_user_id, reported_user_id, listing_id, reason, created_at)
     VALUES (3002, 'report-2', 2001, 8, 1, 2001, '廣告', '2026-07-01T00:00:00.000Z')`,
  ).run();

  for (const [day, metric, value] of [
    ["2026-09-01", "notify_generated", 5],
    ["2026-09-02", "notify_generated", 7],
    ["2026-09-02", "notify_delivered", 6],
    ["2026-09-03", "share_view", 11],
    ["2026-09-04", "survey_submitted", 2],
    ["2026-09-04", "wish_confirmed", 1],
    ["2026-09-05", "wish_resumed", 3],
    ["2026-09-05", "wish_cloned", 4],
  ]) seedMetric(h, day, metric, value);

  // `rental_match_subscriptions` 的欄位是 owner_user_id／public_token／updated_at（照 DDL）。
  h.prepare(
    `INSERT INTO rental_match_subscriptions(id, public_token, owner_user_id, listing_id, mode, created_at, updated_at)
     VALUES (4001, 'sub-1', 1, 1, 'instant', ?, ?)`,
  ).run(OLD, OLD);
  h.prepare(
    `INSERT INTO rental_match_subscriptions(id, public_token, owner_user_id, listing_id, mode, created_at, updated_at)
     VALUES (4002, 'sub-2', 2, 2, 'off', ?, ?)`,
  ).run(OLD, OLD);
  // `rental_match_seen` 是 PRIMARY KEY(owner_user_id, listing_id, wish_ref)，沒有 id 欄位。
  h.prepare(
    "INSERT INTO rental_match_seen(owner_user_id, listing_id, wish_ref, created_at) VALUES (1, 1, '1002', ?)",
  ).run(OLD);

  h.prepare(
    `INSERT INTO rental_completion_surveys(id, public_token, wish_id, user_id, found_via_site, via_feature, helpful, detail, created_at)
     VALUES (6001, 'survey-1', 1005, 5, 'yes', 'search', 5, '', '2026-09-04T00:00:00.000Z')`,
  ).run();
  // 第二筆（`wish_id` 是全域唯一，所以要用另一則許願房）：讓 surveys 的分頁也測得到
  h.prepare(
    `INSERT INTO rental_completion_surveys(id, public_token, wish_id, user_id, found_via_site, via_feature, helpful, detail, created_at)
     VALUES (6002, 'survey-2', 1006, 6, 'no', '', NULL, '', '2026-09-05T00:00:00.000Z')`,
  ).run();
}

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

const plain = (value) => JSON.parse(JSON.stringify(value));
const errorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};
const syncErrorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};

const RANGE = { from: "2026-09-01", to: "2026-09-30" };

// ---------------------------------------------------------------------------

test("彙總：整包逐鍵相同（母體中位數是偶數）", async () => {
  const [disk, exec] = resetBoth((h) => seedWorld(h, { acceptedCount: 4 }));
  const syncSummary = plain(syncMod.rentalOpsSummary(disk, RANGE));
  const asyncSummary = plain(await asyncMod.rentalOpsSummaryAsync(RANGE, { ...PG, exec, strict: true }));

  assert.deepEqual(asyncSummary, syncSummary, "整包 summary 必須逐鍵相同");
  assert.equal(asyncSummary.offers.median_sample_size, 4, "母體必須是 4 筆（偶數分支）");
  assert.equal(asyncSummary.offers.median_seconds_to_accept, syncSummary.offers.median_seconds_to_accept);
  assert.notEqual(asyncSummary.offers.median_seconds_to_accept, null, "中位數必須算得出來（否則這條測試沒有鑑別力）");
  // 這一包的重點：30 幾個查詢裡任何一個接錯都會反映在這裡
  assert.equal(asyncSummary.wish.active, 1);
  assert.equal(asyncSummary.wish.needs_confirmation, 1);
  // 期間內 created：4 筆 accepted ＋ 1 pending ＋ 1 expired ＋ 1 blocked = 7
  // （`declined` 只在 acceptedCount < 3 的資料集裡種；`withdrawn` 刻意放在期間外）
  assert.equal(asyncSummary.offers.created, 7);
  assert.equal(asyncSummary.offers.reported, 1, "期間外的檢舉不得算進來");
  assert.equal(asyncSummary.offers.acceptance_rate, Number((4 / 7).toFixed(4)), "接受率＝期間 accepted／期間 created");
  assert.equal(asyncSummary.notifications.generated, 12);
  assert.equal(asyncSummary.growth.share_views, 11);
  assert.equal(asyncSummary.growth.confirm_after_reminder, 1, "confirm_after_reminder 要接 wish_confirmed");
  assert.equal(asyncSummary.growth.resume_after_pause, 3, "resume_after_pause 要接 wish_resumed");
  assert.equal(asyncSummary.wish.clone_or_restart, 4);
  assert.equal(asyncSummary.series.notify_generated.length, 2);
});

test("彙總：母體中位數是奇數時也要相同", async () => {
  const [disk, exec] = resetBoth((h) => seedWorld(h, { acceptedCount: 3 }));
  const syncSummary = plain(syncMod.rentalOpsSummary(disk, RANGE));
  const asyncSummary = plain(await asyncMod.rentalOpsSummaryAsync(RANGE, { ...PG, exec, strict: true }));
  assert.deepEqual(asyncSummary, syncSummary, "整包 summary 必須逐鍵相同（奇數分支）");
  assert.equal(asyncSummary.offers.median_sample_size, 3);
  assert.equal(asyncSummary.offers.median_seconds_to_accept, syncSummary.offers.median_seconds_to_accept);
});

test("彙總：空資料庫也要相同（中位數是 null）", async () => {
  const [disk, exec] = resetBoth(() => {});
  const syncSummary = plain(syncMod.rentalOpsSummary(disk, RANGE));
  const asyncSummary = plain(await asyncMod.rentalOpsSummaryAsync(RANGE, { ...PG, exec, strict: true }));
  assert.deepEqual(asyncSummary, syncSummary, "空集合的 summary 必須逐鍵相同");
  assert.strictEqual(asyncSummary.offers.median_seconds_to_accept, null);
  assert.equal(asyncSummary.offers.acceptance_rate, 0, "分母 0 時必須是 0，不是 NaN");
});

test("彙總：區間驗證的錯誤形狀與同步版相同", async () => {
  const [, exec] = resetBoth((h) => seedWorld(h, { acceptedCount: 2 }));
  const cases = [
    { range: { from: "亂寫", to: "2026-09-30" }, why: "日期格式不正確" },
    { range: { from: "2026-01-01", to: "2026-09-30" }, why: "查詢區間過長" },
  ];
  for (const c of cases) {
    const syncErr = syncErrorShape(() => syncMod.rentalOpsSummary(handle(), c.range));
    const asyncErr = await errorShape(() => asyncMod.rentalOpsSummaryAsync(c.range, { ...PG, exec, strict: true }));
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${c.why}）`);
  }
});

test("明細：offers 與 surveys 兩種 kind 都要相同（含 next_cursor 分頁）", async () => {
  const [disk, exec] = resetBoth((h) => seedWorld(h, { acceptedCount: 4 }));
  for (const input of [
    { kind: "offers", limit: 50 },
    { kind: "surveys", limit: 50 },
    { kind: "offers", limit: 1 },
    { kind: "offers", limit: 1, cursor: 1 },
    { kind: "surveys", limit: 1 },
  ]) {
    const syncView = plain(syncMod.rentalOpsDrilldown(disk, { ...RANGE, ...input }));
    const asyncView = plain(await asyncMod.rentalOpsDrilldownAsync({ ...RANGE, ...input }, { ...PG, exec, strict: true }));
    assert.deepEqual(asyncView, syncView, `明細必須逐鍵相同（${JSON.stringify(input)}）`);
    if (input.limit === 1) assert.ok(asyncView.next_cursor !== "", `limit=1 時必須有下一頁游標（${JSON.stringify(input)}）`);
  }
});

test("錯誤碼：五種查詢失敗要各自回自己的碼（admin 靠它分辨哪一類壞掉）", async () => {
  const [, exec] = resetBoth((h) => seedWorld(h, { acceptedCount: 2 }));
  const failOn = (pattern) => async (sql, params = []) => {
    if (pattern.test(String(sql))) {
      const error = new Error("relation does not exist");
      error.code = "42P01";
      throw error;
    }
    return exec(sql, params);
  };
  const cases = [
    { pattern: /FROM rental_analytics_daily WHERE metric = \? AND day >= \? AND day <= \? ORDER BY day ASC/, code: "analytics_series_failed" },
    { pattern: /COALESCE\(SUM\(value\), 0\)/, code: "analytics_metric_failed" },
    { pattern: /FROM demand_posts WHERE COALESCE\(lifecycle/, code: "analytics_count_failed" },
    { pattern: /COUNT\(\*\) AS n FROM wish_offers\s+WHERE accepted_at IS NOT NULL/, code: "analytics_median_failed" },
  ];
  for (const c of cases) {
    const err = await errorShape(() => asyncMod.rentalOpsSummaryAsync(RANGE, { ...PG, exec: failOn(c.pattern), strict: true }));
    assert.equal(err?.code, c.code, `錯誤碼必須是 ${c.code}（實際：${JSON.stringify(err)}）`);
    assert.equal(err?.status, 500);
  }
  const drillErr = await errorShape(() => asyncMod.rentalOpsDrilldownAsync(
    { ...RANGE, kind: "offers" }, { ...PG, exec: failOn(/FROM wish_offers\s+WHERE created_at >= \?/), strict: true },
  ));
  assert.equal(drillErr?.code, "analytics_drill_failed");
});

test("非 postgres 模式必須走同步路徑（不碰傳入的 exec）", async () => {
  const [disk, exec] = resetBoth((h) => seedWorld(h, { acceptedCount: 2 }));
  let touched = 0;
  const counting = async (sql, params = []) => { touched += 1; return exec(sql, params); };
  const summary = await asyncMod.rentalOpsSummaryAsync(RANGE, { driver: "sqlite", exec: counting });
  const drill = await asyncMod.rentalOpsDrilldownAsync({ ...RANGE, kind: "offers" }, { driver: "sqlite", exec: counting });
  assert.equal(touched, 0, "SQLite 模式不得碰 PG runner");
  assert.deepEqual(plain(summary), plain(syncMod.rentalOpsSummary(disk, RANGE)));
  assert.deepEqual(plain(drill), plain(syncMod.rentalOpsDrilldown(disk, { ...RANGE, kind: "offers" })));
});
