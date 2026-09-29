// 配對清單的 **live PG** 驗證（2026-09-29，第八十一批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **配對清單真的從 PG 讀**（同步版讀本機 ⇒ 別的節點建立的刊登與提案看不到）。
//   2. **游標分頁在真 PG 上跑得動**（`assertUpcomingCursorWishesMatchableAsync()` 的
//      `public_token IN (…)` 批次查詢 ＋ 一次性的不透明游標）。
//   3. **CTA 的提案狀態來自 PG**（`wish_offers`／`user_blocks` 的查詢與 `pending` 文案）。
//
// ⚠️ 安全設計照抄 `member-consents-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-selfmatches-live-"));
process.env.DATA_DIR = dataDir;
const MARK = `livetest-matches-${Date.now()}`;
const DISTRICT = "1-2";
const STAMP = "2026-01-01T00:00:00.000Z";

test("live PG：PG 上的提案狀態要反映在配對清單的 CTA（同步版看不到）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const matchAsync = await import("../src/rentalMatchAsync.js");
  const selfListings = await import("../src/selfListings.js");
  const catalogAsync = await import("../src/rentalCatalogAsync.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 本機建一列站內刊登，再用它的欄位原樣插進 PG（不必手寫 listings 的幾十個欄位）
  const local = dbMod.sqliteHandle();
  local.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
    .run(910001, `${MARK}-local@example.test`, "本機屋主", STAMP);
  const localListing = selfListings.createSelfListing(local, 910001, {
    district: DISTRICT, street: "民生西路 100 號", rent: 28000, ping: "25", accept_pledge: true,
    body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
    floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
    title: `${MARK} 刊登`, kind: "apartment", role: "owner", contact_name: "測試屋主",
  }, new Date(), { maturity: true });
  const localRow = local.prepare("SELECT * FROM listings WHERE post_id = ?").get(localListing.post_id);
  const userIds = [];

  t.after(async () => {
    try { await query("DELETE FROM wish_offers WHERE listing_id IN (SELECT post_id FROM listings WHERE title LIKE $1)", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM listings WHERE title LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM demand_posts WHERE body LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM user_blocks WHERE blocker_user_id = ANY($1::bigint[]) OR blocked_user_id = ANY($1::bigint[])", [userIds.length ? userIds : [0], userIds.length ? userIds : [0]]); } catch { /* 盡力而為 */ }
    if (userIds.length) {
      try { await query("DELETE FROM users WHERE id = ANY($1::bigint[])", [userIds]); } catch { /* 盡力而為 */ }
    }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  await query("SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM users), 1))");
  await query("SELECT setval(pg_get_serial_sequence('listings', 'post_id'), GREATEST((SELECT COALESCE(MAX(post_id),0) FROM listings), 1))");
  const ownerId = Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'PG 屋主','member','free',$2) RETURNING id",
    [`${MARK}-owner@example.test`, STAMP],
  ))[0].id);
  userIds.push(ownerId);

  const cols = Object.keys(localRow).filter((c) => c !== "post_id");
  const values = cols.map((c) => (c === "listed_by_user_id" ? ownerId : localRow[c]));
  const postId = Number((await query(
    `INSERT INTO listings(${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING post_id`,
    values,
  ))[0].post_id);

  // 開關（先記原值，收尾還原）
  const beforeFlags = (await query("SELECT value FROM settings WHERE key = 'rentalMarketplaceFlags'"))[0]?.value ?? null;
  await catalogAsync.saveRentalMarketplaceFlagsAsync({ wish: { owner_matching_enabled: true, offer_enabled: true } }, opts);
  t.after(async () => {
    try {
      if (beforeFlags === null) await query("DELETE FROM settings WHERE key = 'rentalMarketplaceFlags'");
      else await query("UPDATE settings SET value = $1 WHERE key = 'rentalMarketplaceFlags'", [beforeFlags]);
    } catch { /* 盡力而為 */ }
  });

  // 三則同區心願（一則已有 pending 提案）
  await query("SELECT setval(pg_get_serial_sequence('demand_posts', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM demand_posts), 1))");
  const wishIds = [];
  for (const [index, rentMax] of [30000, 32000, 34000].entries()) {
    const wishUserId = Number((await query(
      "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'許願會員','member','free',$2) RETURNING id",
      [`${MARK}-wish${index}@example.test`, STAMP],
    ))[0].id);
    userIds.push(wishUserId);
    const wishId = Number((await query(
      `INSERT INTO demand_posts(user_id, districts, rent_max, layout, housing_type, body, status, created_at, expires_at,
         lifecycle, public_token, published_at, last_active_at, activity_score)
       VALUES ($1, $2, $3, 2, 'apartment', $4, 'open', $5, $6, 'active', $7, $5, $5, 1) RETURNING id`,
      [wishUserId, JSON.stringify([DISTRICT]), rentMax, `${MARK} 需求 ${index}`, STAMP, "2027-01-01T00:00:00.000Z", `${MARK}-wish-${index}`],
    ))[0].id);
    wishIds.push({ id: wishId, userId: wishUserId });
  }
  await query("DELETE FROM demand_match_districts");   // 讓掃描走懶重建
  const pending = wishIds[0];
  await query(
    `INSERT INTO wish_offers(public_token, wish_id, listing_id, owner_user_id, tenant_user_id, status, created_at, updated_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$6,$7)`,
    [`${MARK}-offer-pending`, pending.id, postId, ownerId, pending.userId, STAMP, "2027-01-01T00:00:00.000Z"],
  );

  // 同步版（讀本機）：PG 那一列在本機不存在 ⇒ 404
  const syncErr = (() => { try { dbMod.ownerListingMatches(postId, ownerId, {}); return null; } catch (error) { return error; } })();
  assert.equal(syncErr?.status, 404, "前提：同步版讀本機 ⇒ 看不到 PG 的刊登");

  const first = await matchAsync.ownerListingMatchesAsync(postId, ownerId, { ...opts, limit: 2 });
  assert.equal(Number(first.listing_id), postId);
  assert.ok(first.total >= 1, `三則同區心願至少要配得上（實際 ${first.total}）`);
  assert.equal(first.items.length, Math.min(2, first.total));
  const pendingItem = first.items.find((item) => item.wish_ref === `${MARK}-wish-0`);
  if (pendingItem) {
    assert.equal(pendingItem.offer_status, "pending", "PG 的提案狀態要反映在 CTA");
    assert.equal(pendingItem.offer_available, false);
    assert.match(String(pendingItem.offer_cta || ""), /等待對方回覆/);
    assert.equal(pendingItem.offer_ref, `${MARK}-offer-pending`);
  }
  const readyItem = first.items.find((item) => item.wish_ref === `${MARK}-wish-1`);
  if (readyItem) assert.equal(readyItem.offer_status, "ready", "沒有提案的心願要是可提供");

  // 游標分頁（真 PG）
  if (first.next_cursor) {
    const second = await matchAsync.ownerListingMatchesAsync(postId, ownerId, { ...opts, limit: 2, cursor: first.next_cursor });
    assert.equal(Number(second.listing_id), postId);
    assert.notDeepEqual(second.items, first.items, "第二頁要是不同的項目");
  }
});
