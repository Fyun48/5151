// 站內刊登屋主配對的 **live PG** 驗證（2026-09-29，第八十批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **自己的刊登真的從 PG 讀**（同步版讀本機 ⇒ 別的節點建立的刊登列表是空的）。
//   2. **候選許願房的分塊掃描在真 PG 上跑得動**（`candidateSql()` ＋ `MATCH_CANDIDATE_CHUNK`），
//      而且帶行政區時會用到 `demand_match_districts`（索引為空要懶重建）。
//   3. **活動資料（`users.last_login_at`／`user_listing_flags`）的 `IN (…)` 批次查詢**在真 PG 上可行。
//
// ⚠️ 安全設計照抄 `member-consents-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-selfmatch-live-"));
process.env.DATA_DIR = dataDir;
const MARK = `livetest-selfmatch-${Date.now()}`;
const DISTRICT = "1-2";  // 台北市大同區
const STAMP = "2026-01-01T00:00:00.000Z";

test("live PG：PG 上的站內刊登要配得出 PG 上的許願房（同步版看不到）", { skip }, async (t) => {
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

  // 本機先建一列「示範用的站內刊登」，再用它的欄位原樣插進 PG（不必手寫 listings 的幾十個欄位）。
  const local = dbMod.sqliteHandle();
  local.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
    .run(900001, `${MARK}-local@example.test`, "本機屋主", STAMP);
  const localListing = selfListings.createSelfListing(local, 900001, {
    district: DISTRICT, street: "民生西路 100 號", rent: 28000, ping: "25", accept_pledge: true,
    body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
    floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
    title: `${MARK} 刊登`, kind: "apartment", role: "owner", contact_name: "測試屋主",
  }, new Date(), { maturity: true });
  const localRow = local.prepare("SELECT * FROM listings WHERE post_id = ?").get(localListing.post_id);
  assert.ok(localRow, "前提：本機建立成功");

  const userIds = [];
  t.after(async () => {
    try { await query("DELETE FROM listings WHERE title LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM demand_posts WHERE body LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    if (userIds.length) {
      try { await query("DELETE FROM users WHERE id = ANY($1::bigint[])", [userIds]); } catch { /* 盡力而為 */ }
    }
    try { await query("DELETE FROM demand_match_districts WHERE wish_id NOT IN (SELECT id FROM demand_posts)"); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  // 屋主：PG 的使用者 ＋ 那一列刊登（欄位原樣搬過去）
  await query("SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM users), 1))");
  const ownerId = Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'PG 屋主','member','free',$2) RETURNING id",
    [`${MARK}-owner@example.test`, STAMP],
  ))[0].id);
  userIds.push(ownerId);

  const cols = Object.keys(localRow);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  // ⚠️ 主鍵要讓 PG 自己配（本地 post_id 可能與 PG 撞號）。
  const insertCols = cols.filter((c) => c !== "post_id");
  const insertPlaceholders = insertCols.map((_, i) => `$${i + 1}`).join(",");
  const values = insertCols.map((c) => (c === "listed_by_user_id" ? ownerId : localRow[c]));
  const postId = Number((await query(
    `INSERT INTO listings(${insertCols.join(",")}) VALUES (${insertPlaceholders}) RETURNING post_id`,
    values,
  ))[0].post_id);
  void placeholders;
  assert.ok(postId, "PG 的刊登要建立成功");

  // 屋主配對要開（先記原值，收尾還原）
  const beforeFlags = (await query("SELECT value FROM settings WHERE key = 'rentalMarketplaceFlags'"))[0]?.value ?? null;
  await catalogAsync.saveRentalMarketplaceFlagsAsync({ wish: { owner_matching_enabled: true } }, opts);
  t.after(async () => {
    try {
      if (beforeFlags === null) await query("DELETE FROM settings WHERE key = 'rentalMarketplaceFlags'");
      else await query("UPDATE settings SET value = $1 WHERE key = 'rentalMarketplaceFlags'", [beforeFlags]);
    } catch { /* 盡力而為 */ }
  });

  // 三則同區許願房（別的會員）
  await query("SELECT setval(pg_get_serial_sequence('demand_posts', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM demand_posts), 1))");
  for (const [index, rentMax] of [30000, 32000, 34000].entries()) {
    const wishUserId = Number((await query(
      "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'許願會員','member','free',$2) RETURNING id",
      [`${MARK}-wish${index}@example.test`, STAMP],
    ))[0].id);
    userIds.push(wishUserId);
    await query(
      // ⚠️ `public_token` 一定要有：`scoreCandidates()` 會跳過沒有 token 的心願
      // （`if (!wish.public_token) continue;`）——第一版就是漏了它，配對數永远是 0。
      // `published_at`／`last_active_at`／`activity_score` 也照 `createDemandPost()` 的形狀補上。
      `INSERT INTO demand_posts(user_id, districts, rent_max, layout, housing_type, body, status, created_at, expires_at,
         lifecycle, public_token, published_at, last_active_at, activity_score)
       VALUES ($1, $2, $3, $4, 'apartment', $5, 'open', $6, $7, 'active', $8, $6, $6, 1)`,
      [wishUserId, JSON.stringify([DISTRICT]), rentMax, String(2 + index), `${MARK} 需求 ${index}`, STAMP, "2027-01-01T00:00:00.000Z", `${MARK}-wish-${index}`],
    );
  }
  // 索引刻意留空：`queryAllCandidateWishesAsync()` 應該自己懶重建
  await query("DELETE FROM demand_match_districts");

  // 同步版（讀本機）：PG 那一列在本機不存在 ⇒ 空陣列
  assert.deepEqual(dbMod.listMineSelfListings(ownerId), [], "前提：同步版讀本機 ⇒ 看不到 PG 的刊登");

  const listed = await matchAsync.listMineSelfListingsAsync(ownerId, opts);
  assert.equal(listed.length, 1, "PG 版要看得到 PG 的站內刊登");
  assert.equal(Number(listed[0].post_id), postId);
  assert.ok(listed[0].match_summary, "要附配對摘要");
  assert.equal(listed[0].match_summary.enabled, true);
  assert.ok(listed[0].match_summary.count >= 1, `三則同區需求應該配得上（實際 ${listed[0].match_summary.count}）`);

  const summary = await matchAsync.ownerListingMatchSummaryAsync(postId, ownerId, opts);
  assert.equal(summary.count, listed[0].match_summary.count, "兩條路徑的配對數要一致");
  assert.equal(summary.unavailable, false);
  assert.ok(String(summary.label || "").includes("活躍需求"));

  // 索引確實被重建了（否則上面那些配對數會是 0）
  assert.ok(
    (await query("SELECT COUNT(*)::int AS n FROM demand_match_districts"))[0].n >= 3,
    "懶重建要把行政區索引補回來",
  );
});
