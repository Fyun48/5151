// 匯入清單的 **live PG** 驗證（2026-09-28，第四十五批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了兩件事：
//
//   1. **後台清單的 `LEFT JOIN users`** 在真 PG 上真的能跑（`i.*` 與 `u.email` 的別名、
//      以及 `ORDER BY i.id DESC` 的寫法），而且查不到使用者時 `member_email` 是空字串。
//   2. **`LIMIT ?` 帶參數**在 PG 上也接受（SQLite 接受不代表 PG 接受——這一系列踩過
//      `IFNULL`／`LIMIT -1`／`julianday` 三次）。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
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

const OLD = "2026-01-01T00:00:00.000Z";
const TOKEN = "livetest-imports";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-imports-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：匯入清單的 JOIN／LIMIT 與列轉換都正確", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const importsAsync = await import("../src/listingImportAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  const syncSequence = async (table, column = "id") => {
    await query(
      `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(MAX(${column}),0) FROM ${table}), 1))`,
      [table, column],
    );
  };
  const cleanup = async () => {
    await query("DELETE FROM listing_import WHERE original_source_url LIKE $1", [`https://example.com/${TOKEN}%`]);
    await query("DELETE FROM users WHERE email LIKE $1", [`${TOKEN}-%@example.com`]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  await cleanup();
  await syncSequence("users");
  await syncSequence("listing_import");

  const [UID] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'匯入會員','member','free',$2) RETURNING id",
    [`${TOKEN}-owner@example.com`, OLD],
  )).map((r) => Number(r.id));
  assert.ok(UID);
  for (const [n, status] of [[1, "draft"], [2, "confirmed"], [3, "cancelled"]]) {
    await query(
      `INSERT INTO listing_import(user_id, provider, original_source_url, normalized_source_url, source_listing_id,
         status, imported_title, imported_text, listing_id, created_at, fetched_at, photo_errors, media_ids)
       VALUES ($1, '591', $2, $2, '', $3, $4, '', NULL, $5, $5, '[]', '[]')`,
      [UID, `https://example.com/${TOKEN}-${n}`, status, `匯入 ${n}`, OLD],
    );
  }

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  const mine = await importsAsync.listMineListingImportsAsync(UID, {}, opts);
  assert.equal(mine.length, 3, `會員清單必須回三列（實際 ${mine.length}）`);
  assert.deepEqual(mine.map((row) => row.imported_title), ["匯入 3", "匯入 2", "匯入 1"], "新到舊");
  assert.equal(typeof mine[0].id, "number", "id 必須是數字（PG 的 bigint 是字串，rowToImport 要轉）");
  assert.equal(mine[0].listing_id, null, "沒有關聯刊登時要是 null");

  const limited = await importsAsync.listMineListingImportsAsync(UID, { limit: 2 }, opts);
  assert.equal(limited.length, 2, "LIMIT ? 在 PG 上要生效");

  const admin = await importsAsync.listAdminListingImportsAsync({ limit: 200 }, opts);
  const mineInAdmin = admin.filter((row) => Number(row.user_id) === UID);
  assert.equal(mineInAdmin.length, 3, "後台清單看得到這三筆");
  assert.equal(mineInAdmin[0].member_email, `${TOKEN}-owner@example.com`, "LEFT JOIN 要帶出會員 email");
  // 沒有對應使用者的列（模擬帳號已被刪除）：`member_email` 要是空字串
  const [ORPHAN_UID] = [999000000 + (UID % 1000)];
  await query(
    `INSERT INTO listing_import(user_id, provider, original_source_url, normalized_source_url, source_listing_id,
       status, imported_title, imported_text, listing_id, created_at, fetched_at, photo_errors, media_ids)
     VALUES ($1, '591', $2, $2, '', 'draft', '孤兒匯入', '', NULL, $3, $3, '[]', '[]')`,
    [ORPHAN_UID, `https://example.com/${TOKEN}-orphan`, OLD],
  );
  const admin2 = await importsAsync.listAdminListingImportsAsync({ limit: 200 }, opts);
  const orphan = admin2.find((row) => row.imported_title === "孤兒匯入");
  assert.ok(orphan, "孤兒列必須在後台清單裡（否則這條測試沒有鑑別力）");
  assert.equal(orphan.member_email, "", "LEFT JOIN 查不到時要是空字串，不是 undefined");
});
