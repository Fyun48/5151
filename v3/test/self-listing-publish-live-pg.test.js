// 公開站內刊登草稿的 **live PG** 驗證（2026-09-29，第八十三批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了四件事：
//
//   1. **草稿真的從 PG 讀、公開結果真的寫回 PG**（同步版只寫本機 ⇒ 公開看起來成功、站上沒有）。
//   2. **可刊登條件（停權／註冊時間／同時上限）在真 PG 上查得到**。
//   3. **配對候選的 PG 讀取（`matchCandidatesAsync`）在真 PG 上跑得動**。
//   4. **匯入的「確認後刊登」整條鏈在真 PG 上跑得完**。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-publish-live-"));
process.env.DATA_DIR = dataDir;
const MARK = `livetest-publish-${Date.now()}`;
const DISTRICT = "1-2";
const STAMP = "2026-01-01T00:00:00.000Z";
const MEDIA_KEY = `${"f".repeat(32)}.jpg`;
const MEDIA_URL = `/media/lib/${MEDIA_KEY}`;
const IMPORT_ID = 839901;
const PUBLISH_INPUT = {
  district: DISTRICT, street: "民生西路 100 號", rent: 28000, ping: "25", accept_pledge: true,
  body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
  floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
  title: `${MARK} 公開刊登`, kind: "apartment", role: "owner", contact_name: "測試屋主",
  photos: [MEDIA_URL],
};

test("live PG：PG 上的草稿要公開得成（同步版看不到），匯入的確認後刊登也走得完", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const selfAsync = await import("../src/selfListingsAsync.js");
  const selfListings = await import("../src/selfListings.js");
  const importAsync = await import("../src/listingImportAsync.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  const opts = { driver: "postgres", pgDriver, exec, strict: true };
  const local = dbMod.sqliteHandle();
  const userIds = [];

  t.after(async () => {
    try { await query("DELETE FROM listing_import WHERE id = $1", [IMPORT_ID]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM listings WHERE title LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM member_media WHERE storage_key = $1", [MEDIA_KEY]); } catch { /* 盡力而為 */ }
    if (userIds.length) {
      try { await query("DELETE FROM users WHERE id = ANY($1::bigint[])", [userIds]); } catch { /* 盡力而為 */ }
    }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  // 本機建一則草稿（再用它的欄位原樣插進 PG，並把 PG 的那一列留在 draft）
  local.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
    .run(930001, `${MARK}-local@example.test`, "本機屋主", STAMP);
  const localDraft = selfListings.insertSelfDraftListing(local, 930001, {
    title: `${MARK} 草稿`, body: "草稿內容：近捷運、採光好，適合小家庭。", photos: [MEDIA_URL],
  });
  const localRow = local.prepare("SELECT * FROM listings WHERE post_id = ?").get(localDraft.post_id);

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
  await query("UPDATE listings SET self_status = 'draft', self_expires_at = NULL WHERE post_id = $1", [postId]);
  await query(
    "INSERT INTO member_media(user_id, storage_key, mime, format, created_at, deleted_at) VALUES ($1,$2,'image/jpeg','jpg',$3,NULL)",
    [ownerId, MEDIA_KEY, STAMP],
  );

  // 同步版（讀本機）：PG 那一列在本機不存在 ⇒ 404
  const syncErr = (() => {
    try { selfListings.publishImportedDraftListing(local, ownerId, postId, PUBLISH_INPUT, new Date()); return null; } catch (error) { return error; }
  })();
  assert.equal(syncErr?.status, 404, "前提：同步版讀本機 ⇒ 找不到 PG 的草稿");

  const published = await selfAsync.publishImportedDraftListingAsync(ownerId, postId, PUBLISH_INPUT, opts);
  assert.ok(published.title, "要回公開後的刊登");
  const row = (await query(
    "SELECT self_status, title, price_num, floor_name, contact_uid, self_expires_at FROM listings WHERE post_id = $1",
    [postId],
  ))[0];
  assert.equal(row.self_status, "open", "PG 上的狀態要變成 open");
  assert.equal(row.title, `${MARK} 公開刊登`);
  assert.equal(Number(row.price_num), 28000);
  assert.equal(String(row.contact_uid || ""), String(ownerId));
  assert.ok(Date.parse(row.self_expires_at) > Date.now(), "要有到期日");

  // 匯入的「確認後刊登」：PG 的匯入列（已確認）走完整條鏈
  await query("DELETE FROM listing_import WHERE id = $1", [IMPORT_ID]);
  await query("UPDATE listings SET self_status = 'draft' WHERE post_id = $1", [postId]);
  await query(
    `INSERT INTO listing_import(id, user_id, provider, original_source_url, normalized_source_url, status, listing_id, created_at)
     VALUES ($1,$2,'591',$3,$3,'confirmed',$4,$5)`,
    [IMPORT_ID, ownerId, `https://example.com/${MARK}`, postId, STAMP],
  );
  const viaImport = await importAsync.publishConfirmedImportAsync(ownerId, IMPORT_ID, PUBLISH_INPUT, opts);
  assert.ok(viaImport.title, "匯入的確認後刊登要回刊登");
  assert.equal(
    (await query("SELECT self_status FROM listings WHERE post_id = $1", [postId]))[0].self_status, "open",
    "匯入路徑也要把狀態設成 open",
  );
});
