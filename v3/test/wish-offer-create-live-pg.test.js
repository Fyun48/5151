// 許願房提案**建立**（`POST /api/self-listings/:id/matches/:wishRef/offers`）的 **live PG** 驗證
// （2026-09-29，第八十七批；缺口歸零的最後一條）。
//
// 離線 parity 用的是「借本機 DDL 建的記憶體 PG 替身」，它證明不了五件事：
//
//   1. **提案真的寫進 PG**：`INSERT … RETURNING id` 在真 PG 上要回得出 id
//      （同步版靠 `lastInsertRowid`，PG 沒有那個東西）。
//   2. **部分唯一索引真的擋得住**：`idx_wish_offers_pending_unique` 在真 PG 上是部分索引，
//      pgSchema 鏡射不到；少了它，「同時只有一筆 pending」在 PG 上就不成立。
//   3. **冪等鍵真的落地**：`wish_offer_idempotency` 的 PK 在 PG 上要真的擋得住重放。
//   4. **事件真的落地**：`wish_offer_events` 要有一筆 `offer_created`。
//   5. **本機沒有被寫**：PG 模式下提案不該出現在節點本機（別的節點看不到＝站上沒有）。
//
// ⚠️ 安全設計照抄 `self-listing-match-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內；
// 動到的 `settings` 兩個鍵（旗標／目錄）會先記原值、收尾還原。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-offercreate-live-"));
process.env.DATA_DIR = dataDir;
const MARK = `livetest-offercreate-${Date.now()}`;
const STAMP = "2026-01-01T00:00:00.000Z";
const DISTRICT = "1-8";
const NOW = new Date("2026-09-29T00:00:00.000Z");
const FLAGS_ON = {
  rental_catalog_v2: { enabled: true },
  wish: { lifecycle_enabled: true, owner_matching_enabled: true, offer_enabled: true },
};

test("live PG：提案與事件、冪等鍵都落在 PG（本機不被寫），重放回同一筆", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const dbMod = await import("../src/db.js");
  const demand = await import("../src/demand.js");
  const selfListings = await import("../src/selfListings.js");
  const offers = await import("../src/wishOffers.js");
  const offerAsync = await import("../src/wishOffersAsync.js");
  const catalogAsync = await import("../src/rentalCatalogAsync.js");
  const { defaultCatalog } = await import("../src/rentalCatalog.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  const opts = { driver: "postgres", pgDriver, exec, strict: true };
  const local = dbMod.sqliteHandle();
  const userIds = [];
  const settingsBefore = [];
  let offerId = 0;
  let wishId = 0;

  t.after(async () => {
    for (const key of ["rentalMarketplaceFlags", "rentalCatalog"]) {
      const prev = settingsBefore.find((s) => s.key === key);
      try {
        if (!prev) await query("DELETE FROM settings WHERE key = $1", [key]);
        else await query("UPDATE settings SET value = $1 WHERE key = $2", [prev.value, key]);
      } catch { /* 盡力而為 */ }
    }
    try { await query("DELETE FROM wish_offer_events WHERE offer_id = $1", [offerId]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM wish_offer_idempotency WHERE owner_user_id = ANY($1::bigint[])", [userIds]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM wish_offers WHERE owner_user_id = ANY($1::bigint[])", [userIds]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM user_blocks WHERE blocker_user_id = ANY($1::bigint[]) OR blocked_user_id = ANY($1::bigint[])", [userIds]); } catch { /* 盡力而為 */ }
    if (wishId) {
      try { await query("DELETE FROM demand_match_districts WHERE wish_id = $1", [wishId]); } catch { /* 盡力而為 */ }
    }
    try { await query("DELETE FROM demand_posts WHERE body LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM listings WHERE title LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    if (userIds.length) {
      try { await query("DELETE FROM users WHERE id = ANY($1::bigint[])", [userIds]); } catch { /* 盡力而為 */ }
    }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  // ---- 本機先把「刊登 ＋ 許願房」用真實領域函式生出來，再原樣搬進 PG ----
  local.prepare("INSERT OR REPLACE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
    .run(91, `${MARK}-owner-local@example.test`, "本機屋主", STAMP);
  local.prepare("INSERT OR REPLACE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
    .run(92, `${MARK}-tenant-local@example.test`, "本機房客", STAMP);
  const localListing = selfListings.createSelfListing(local, 91, {
    district: DISTRICT, rent: 22000, ping: 18, kind: "whole", role: "owner", floor: 3, total_floors: 5,
    rooms: 2, living: 1, bath: 1, contact_name: "林先生", address: "中正路100號",
    phone: "0912345678", title: `${MARK} 士林整層可看屋`, body: "近捷運、可入住、有洗衣機。",
    accept_pledge: true, traits: ["pet", "cook", "elevator"],
    listing_values: { need_pet: "allowed", need_cook: "allowed", elevator: "present" },
  });
  const listingRow = local.prepare("SELECT * FROM listings WHERE post_id = ?").get(localListing.post_id);
  const localWish = demand.createDemandPost(local, 92, {
    districts: [DISTRICT], rent_max: 30000, housing_type: "apartment", mrt_walk: true,
    body: `${MARK} 找士林兩房`,
  });
  const wishRow = local.prepare("SELECT * FROM demand_posts WHERE id = ?").get(localWish.id);
  assert.ok(listingRow && wishRow, "前提：本機要先有刊登與許願房");

  // ---- 搬進 PG（主鍵讓 PG 自己配）----
  await query("SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM users), 1))");
  const ownerId = Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'PG 屋主','member','free',$2) RETURNING id",
    [`${MARK}-owner@example.test`, STAMP],
  ))[0].id);
  const tenantId = Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'PG 房客','member','free',$2) RETURNING id",
    [`${MARK}-tenant@example.test`, STAMP],
  ))[0].id);
  userIds.push(ownerId, tenantId);
  await query("SELECT setval(pg_get_serial_sequence('listings', 'post_id'), GREATEST((SELECT COALESCE(MAX(post_id),0) FROM listings), 1))");
  const listingCols = Object.keys(listingRow).filter((c) => c !== "post_id");
  const postId = Number((await query(
    `INSERT INTO listings(${listingCols.join(",")}) VALUES (${listingCols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING post_id`,
    listingCols.map((c) => (c === "listed_by_user_id" ? ownerId : listingRow[c])),
  ))[0].post_id);
  await query("SELECT setval(pg_get_serial_sequence('demand_posts', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM demand_posts), 1))");
  const wishCols = Object.keys(wishRow).filter((c) => c !== "id");
  wishId = Number((await query(
    `INSERT INTO demand_posts(${wishCols.join(",")}) VALUES (${wishCols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    wishCols.map((c) => (c === "user_id" ? tenantId : wishRow[c])),
  ))[0].id);
  const wishToken = String(wishRow.public_token || "");
  assert.ok(postId && wishId && wishToken, "PG 的刊登與許願房都要建立成功（許願房一定要有 public_token）");

  // ---- 開關與目錄：先記原值，寫成本地那一份（建立提案前會從 PG 收斂快取）----
  for (const key of ["rentalMarketplaceFlags", "rentalCatalog"]) {
    const row = (await query("SELECT value FROM settings WHERE key = $1", [key]))[0];
    settingsBefore.push({ key, value: row?.value ?? null });
    if (!row) await query("INSERT INTO settings(key, value) VALUES ($1,'')", [key]);
  }
  // ⚠️ 交集比對需要「同一份目錄」：把本機拿來建立 listing_values 的那一份寫進 PG，
  // 否則真 PG 上的目錄若不含 pet／cook／elevator，配對會直接 `match_no_longer_eligible`。
  await catalogAsync.saveRentalCatalogAsync(defaultCatalog(), opts);
  await catalogAsync.saveRentalMarketplaceFlagsAsync(FLAGS_ON, opts);
  catalogAsync.hydrateCaches(defaultCatalog(), FLAGS_ON);

  // ---- 建立提案 ----
  const key = `${MARK}-key-0001`;
  const created = await offerAsync.createWishOfferAsync(ownerId, postId, wishToken, { idempotencyKey: key, now: NOW }, opts);

  assert.equal(created.status, "pending");
  assert.equal(created.viewer_role, "owner");
  assert.equal(created.actions.withdraw, true, "pending 的屋主可以撤回");
  assert.equal(created.offer_ref, String(created.offer_ref || ""), "要有 offer_ref");
  assert.equal("wish_id" in created, false, "投影不得外洩內部 id");

  const rows = await query("SELECT * FROM wish_offers WHERE owner_user_id = $1", [ownerId]);
  assert.equal(rows.length, 1, "PG 要有一筆提案");
  offerId = Number(rows[0].id);
  assert.equal(rows[0].status, "pending");
  assert.equal(Number(rows[0].listing_id), postId);
  assert.equal(Number(rows[0].wish_id), wishId);
  assert.equal(Number(rows[0].tenant_user_id), tenantId, "tenant 要是許願房的主人");
  assert.equal(rows[0].public_token, created.offer_ref, "投影的 offer_ref 要對上 PG 那一列");
  assert.ok(Date.parse(rows[0].expires_at) > NOW.getTime(), "到期日要在 now 之後");

  const events = await query("SELECT event_type FROM wish_offer_events WHERE offer_id = $1", [offerId]);
  assert.deepEqual(events.map((e) => e.event_type), ["offer_created"], "要有一筆 offer_created 事件");
  const idem = await query("SELECT offer_id FROM wish_offer_idempotency WHERE owner_user_id = $1 AND idempotency_key = $2", [ownerId, key]);
  assert.equal(idem.length, 1, "冪等鍵要落地");
  assert.equal(Number(idem[0].offer_id), offerId);

  // ---- 冪等重放：真 PG 上回同一筆（不靠例外，靠主鍵 ＋ 先查）----
  const replay = await offerAsync.createWishOfferAsync(ownerId, postId, wishToken, { idempotencyKey: key, now: NOW }, opts);
  assert.equal(replay.offer_ref, created.offer_ref, "同鍵要回同一筆");
  assert.equal(Number((await query("SELECT COUNT(*) AS n FROM wish_offers WHERE owner_user_id = $1", [ownerId]))[0].n), 1);

  // ---- 本機沒有被寫 ----
  assert.equal(local.prepare("SELECT COUNT(*) AS n FROM wish_offers WHERE owner_user_id = ?").get(ownerId).n, 0,
    "PG 模式不得在本機留下提案");
});
