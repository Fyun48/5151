// 建立站內刊登的 **live PG** 驗證（2026-09-29，第八十四批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **新刊登真的寫進 PG**（同步版只寫本機 ⇒ 站上的清單讀 PG、剛刊登的物件不在站上）。
//   2. **可刊登條件（停權／註冊時間／同時上限）在真 PG 上算得出來**。
//   3. **配對候選的 PG 讀取與 `MATCH_SET_SQL` 在真 PG 上跑得動**。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-create-live-"));
process.env.DATA_DIR = dataDir;
const MARK = `livetest-create-${Date.now()}`;
const DISTRICT = "1-2";
const STAMP = "2026-01-01T00:00:00.000Z";
const MEDIA_KEY = `${"2".repeat(32)}.jpg`;
const MEDIA_URL = `/media/lib/${MEDIA_KEY}`;
const INPUT = {
  district: DISTRICT, street: "民生西路 100 號", rent: 28000, ping: "25", accept_pledge: true,
  body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
  floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
  title: `${MARK} 新刊登`, kind: "apartment", role: "owner", contact_name: "測試屋主",
  photos: [MEDIA_URL],
};

test("live PG：新刊登要落在 PG（同步版只寫本機）、PG 停權要擋下", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const selfAsync = await import("../src/selfListingsAsync.js");
  const selfListings = await import("../src/selfListings.js");
  const catalogAsync = await import("../src/rentalCatalogAsync.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  const opts = { driver: "postgres", pgDriver, exec, strict: true };
  const local = dbMod.sqliteHandle();
  let ownerId = 0;

  t.after(async () => {
    try { await query("DELETE FROM listings WHERE title LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM listings WHERE title LIKE $1", [`%${MARK}%`]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM member_media WHERE storage_key = $1", [MEDIA_KEY]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM self_listing_create_idempotency WHERE idempotency_key LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    if (ownerId) { try { await query("DELETE FROM users WHERE id = $1", [ownerId]); } catch { /* 盡力而為 */ } }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  await query("SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM users), 1))");
  await query("SELECT setval(pg_get_serial_sequence('listings', 'post_id'), GREATEST((SELECT COALESCE(MAX(post_id),0) FROM listings), 1))");
  ownerId = Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'PG 屋主','member','free',$2) RETURNING id",
    [`${MARK}-owner@example.test`, STAMP],
  ))[0].id);
  await query(
    "INSERT INTO member_media(user_id, storage_key, mime, format, created_at, deleted_at) VALUES ($1,$2,'image/jpeg','jpg',$3,NULL)",
    [ownerId, MEDIA_KEY, STAMP],
  );
  const beforeFlags = (await query("SELECT value FROM settings WHERE key = 'rentalMarketplaceFlags'"))[0]?.value ?? null;
  await catalogAsync.saveRentalMarketplaceFlagsAsync({ wish: { owner_matching_enabled: true } }, opts);
  t.after(async () => {
    try {
      if (beforeFlags === null) await query("DELETE FROM settings WHERE key = 'rentalMarketplaceFlags'");
      else await query("UPDATE settings SET value = $1 WHERE key = 'rentalMarketplaceFlags'", [beforeFlags]);
    } catch { /* 盡力而為 */ }
  });

  const created = await selfAsync.createSelfListingAsync(ownerId, INPUT, opts);
  assert.ok(created.post_id, "要回新刊登");
  const row = (await query(
    "SELECT self_status, title, price_num, floor_name, area_name, contact_uid, self_expires_at FROM listings WHERE post_id = $1",
    [created.post_id],
  ))[0];
  assert.ok(row, "新刊登必須落在 PG");
  assert.equal(row.self_status, "open");
  assert.equal(row.title, `${MARK} 新刊登`);
  assert.equal(Number(row.price_num), 28000);
  assert.equal(String(row.contact_uid || ""), String(ownerId));
  assert.ok(Date.parse(row.self_expires_at) > Date.now(), "要有未來的到期日");

  // 同步版（只寫本機）不得在 PG 多出一列
  const pgCountBefore = (await query("SELECT COUNT(*)::int AS n FROM listings WHERE listed_by_user_id = $1", [ownerId]))[0].n;
  selfListings.createSelfListing(local, ownerId, { ...INPUT, title: `${MARK} 同步刊登` }, new Date(), { matchCandidates: () => [] });
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM listings WHERE listed_by_user_id = $1", [ownerId]))[0].n, pgCountBefore,
    "同步版不得在 PG 多出一列（它只寫本機）",
  );

  // PG 停權 ⇒ 403（本機那一份沒停權）
  await query("UPDATE users SET self_ban_until = $1 WHERE id = $2", ["2099-01-01T00:00:00.000Z", ownerId]);
  const banned = await selfAsync.createSelfListingAsync(ownerId, { ...INPUT, title: `${MARK} 停權後` }, opts)
    .then(() => null, (error) => error);
  assert.equal(banned?.status, 403, "PG 停權時必須 403");
  assert.match(String(banned?.message || ""), /暫停上傳/);
  await query("UPDATE users SET self_ban_until = '' WHERE id = $1", [ownerId]);

  // 冪等鍵：同鍵同內容回同一則
  const key = `${MARK}-key`;
  const first = await selfAsync.createSelfListingAsync(ownerId, { ...INPUT, title: `${MARK} 冪等`, idempotency_key: key }, opts);
  const again = await selfAsync.createSelfListingAsync(ownerId, { ...INPUT, title: `${MARK} 冪等`, idempotency_key: key }, opts);
  assert.equal(Number(again.post_id), Number(first.post_id), "同鍵同內容要回同一則");
});
