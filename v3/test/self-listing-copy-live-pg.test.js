// 複製站內刊登的 **live PG** 驗證（2026-09-29，第八十二批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **來源列真的從 PG 讀**（同步版讀本機 ⇒ 別的節點建立的刊登複製不到）。
//   2. **草稿真的寫進 PG**（同步版只寫本機 ⇒ 別的節點看不到那份草稿）。
//   3. **素材所有權在真 PG 上查得到**（`member_media.storage_key` ＋ `deleted_at IS NULL`）。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-copy-live-"));
process.env.DATA_DIR = dataDir;
const MARK = `livetest-copy-${Date.now()}`;
const DISTRICT = "1-2";
const STAMP = "2026-01-01T00:00:00.000Z";
const MEDIA_KEY = `${"c".repeat(32)}.jpg`;
const MEDIA_URL = `/media/lib/${MEDIA_KEY}`;

test("live PG：PG 上的刊登要複製得出草稿（同步版在本機看不到）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const selfAsync = await import("../src/selfListingsAsync.js");
  const selfListings = await import("../src/selfListings.js");
  const listingTools = await import("../src/listingTools.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 本機建一列來源刊登（再用它的欄位原樣插進 PG），並在本機留一份素材（PG 也會有一份）
  const local = dbMod.sqliteHandle();
  local.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
    .run(920001, `${MARK}-local@example.test`, "本機屋主", STAMP);
  const localListing = selfListings.createSelfListing(local, 920001, {
    district: DISTRICT, street: "民生西路 100 號", rent: 28000, ping: "25", accept_pledge: true,
    body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
    floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
    title: `${MARK} 來源刊登`, kind: "apartment", role: "owner", contact_name: "測試屋主",
  }, new Date(), { maturity: true });
  local.prepare("UPDATE listings SET self_photos = ?, cover = ? WHERE post_id = ?")
    .run(JSON.stringify([MEDIA_URL]), MEDIA_URL, localListing.post_id);
  const localRow = local.prepare("SELECT * FROM listings WHERE post_id = ?").get(localListing.post_id);
  let ownerId = 0;
  const userIds = [];

  t.after(async () => {
    try { await query("DELETE FROM listings WHERE title LIKE $1 OR title LIKE $2", [`${MARK}%`, `%${MARK}%`]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM member_media WHERE storage_key = $1", [MEDIA_KEY]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM listing_copy_idempotency WHERE request_key LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    if (userIds.length) {
      try { await query("DELETE FROM users WHERE id = ANY($1::bigint[])", [userIds]); } catch { /* 盡力而為 */ }
    }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  await query("SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM users), 1))");
  await query("SELECT setval(pg_get_serial_sequence('listings', 'post_id'), GREATEST((SELECT COALESCE(MAX(post_id),0) FROM listings), 1))");
  ownerId = Number((await query(
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
  await query(
    "INSERT INTO member_media(user_id, storage_key, mime, format, created_at, deleted_at) VALUES ($1,$2,'image/jpeg','jpg',$3,NULL)",
    [ownerId, MEDIA_KEY, STAMP],
  );

  // 同步版（讀本機）：PG 那一列在本機不存在（本機那一列已改成別的編號）⇒ 404
  const syncErr = (() => { try { listingTools.copyOwnListing(local, ownerId, postId, {}); return null; } catch (error) { return error; } })();
  assert.equal(syncErr?.status, 404, "前提：同步版讀本機 ⇒ 找不到 PG 的來源");

  const copied = await selfAsync.copyOwnListingAsync(ownerId, postId, {}, opts);
  assert.equal(copied.copied, true);
  assert.equal(copied.unpublished, true);
  assert.equal(Number(copied.original_id), postId);
  assert.deepEqual(copied.form.photos, [MEDIA_URL], "素材所有權要從 PG 查得到");
  const draft = (await query(
    "SELECT post_id, self_status, listed_by_user_id, self_photos FROM listings WHERE post_id = $1",
    [copied.listing.post_id],
  ))[0];
  assert.ok(draft, "草稿要落在 PG");
  assert.equal(draft.self_status, "draft");
  assert.equal(Number(draft.listed_by_user_id), ownerId);

  // 冪等鍵：**同一把鍵**呼叫兩次只會有一份草稿（上面那次沒有帶鍵，所以是另一份）
  const key = `${MARK}-key`;
  const withKey = await selfAsync.copyOwnListingAsync(ownerId, postId, { idempotency_key: key }, opts);
  assert.notEqual(withKey.reused, true, "第一次帶鍵是新建，不是重用");
  const again = await selfAsync.copyOwnListingAsync(ownerId, postId, { idempotency_key: key }, opts);
  assert.equal(again.reused, true, "第二次帶同一把鍵要標記 reused");
  assert.equal(Number(again.listing.post_id), Number(withKey.listing.post_id), "要回同一份草稿");
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM listings WHERE listed_by_user_id = $1 AND self_status = 'draft'", [ownerId]))[0].n,
    2,
    "無鍵一次 ＋ 有鍵一次 = 兩份草稿（有鍵的那一份不得重複）",
  );
});
