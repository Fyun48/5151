// 法律文案（免責聲明／個資說明）的 **live PG** 驗證（2026-09-28，第五十批）。
//
// 這一條驗的是「一份文案、兩個 store」在**真 PG** 上的落地：
//   1. `PUT /api/admin/legal-copy` 走 `saveLegalCopyAsync()` → settings（bootstrap 種子）
//      ＋ `content_documents`（真正生效的來源；PG 上有不可變性 trigger）。
//   2. `GET /api/disclaimer`／`GET /api/admin/legal-copy` 走 `getLegalCopyAsync()` 讀回來。
//   3. 讀回來的那一份必須是**剛寫的那一份**（寫讀同源），而且文件是 `published`。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向正式影子庫），
// 只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
//
// 🚨 這一條會動到 `settings.legalCopy` 與兩份正式文件（`registration_terms`／`privacy_notice`），
// 所以測試開始前先快照、結束後**還原**（刪掉新增的文件列 ＋ 把 settings 寫回去）。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-legalcopy-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：法律文案寫進 PG、讀回來（settings ＋ 內容文件都落地）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const docsAsync = await import("../src/contentDocumentsAsync.js");
  const legalAsync = await import("../src/legalCopyAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");

  await docsAsync.ensureContentDocumentStoreOnce(pgDriver);
  const snapshotSetting = (await query("SELECT value FROM settings WHERE key = 'legalCopy'"))[0]?.value ?? null;
  const maxDocId = Number((await query("SELECT COALESCE(MAX(id), 0) AS n FROM content_documents"))[0].n);
  t.after(async () => {
    try { await query("DELETE FROM content_documents WHERE id > $1", [maxDocId]); } catch { /* 盡力而為 */ }
    try {
      if (snapshotSetting == null) await query("DELETE FROM settings WHERE key = 'legalCopy'");
      else await query("UPDATE settings SET value = $1 WHERE key = 'legalCopy'", [snapshotSetting]);
    } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  const before = await legalAsync.getLegalCopyAsync(opts);
  assert.equal(typeof before.disclaimer, "string", "讀到的必須是一份文案");

  const TEXT = `livetest 法律文案 ${Date.now()}`;
  const saved = await legalAsync.saveLegalCopyAsync({ disclaimer: TEXT }, opts);
  assert.match(saved.disclaimer, new RegExp(`^${TEXT}`), "讀回來的必須以剛寫的字開頭（閒置條款會自動補在後面）");
  assert.equal(saved.privacy, before.privacy, "沒給的欄位要沿用目前值");

  // 1. settings（bootstrap 種子的來源）：存的是**原文**，不是讀出來補過條款的那一份。
  const settingRow = (await query("SELECT value FROM settings WHERE key = 'legalCopy'"))[0];
  assert.ok(settingRow, "settings.legalCopy 必須存在");
  assert.equal(JSON.parse(settingRow.value).disclaimer, TEXT, "PG settings 必須是這次寫的原文");

  // 2. 內容文件（真正生效的來源）：只有**被改到的那一份**會產生新版本（未變動的不重寫），
  //    而且新建的那一份必須是 published。
  const created = await query(
    "SELECT id, document_type, body, status FROM content_documents WHERE id > $1 ORDER BY id",
    [maxDocId],
  );
  assert.deepEqual(created.map((row) => row.document_type), ["registration_terms"],
    `只有免責那份該被改版（實際：${JSON.stringify(created.map((r) => [r.document_type, r.status]))}）`);
  assert.equal(created[0].status, "published", "新建的那一份必須是 published");
  assert.equal(created[0].body, TEXT, "免責文件的 body 必須是這次寫的原文");
  const privacyMaxId = Number((await query(
    "SELECT COALESCE(MAX(id), 0) AS n FROM content_documents WHERE document_type = 'privacy_notice'",
  ))[0].n);
  assert.ok(privacyMaxId <= maxDocId, "沒被改動的個資文件不該產生新列");

  // 3. 寫讀同源：再讀一次（走 PG）必須等於剛剛回傳的那一份。
  const reread = await legalAsync.getLegalCopyAsync(opts);
  assert.equal(reread.disclaimer, saved.disclaimer, "讀回來的必須與寫入後回傳的一致");
  assert.equal(reread.privacy, saved.privacy);
  // 而且必須是「文件」那條路（版本會變成 vN），不是預設值。
  assert.match(String(reread.version), /^v\d+$/, `有生效文件時版本應該是 vN（實際 ${reread.version}）`);

  // 4. 不可變性 trigger 還在：直接改已發布的文件必須被擋（PG 版的業務規則）。
  await assert.rejects(
    () => query("UPDATE content_documents SET body = 'tampered' WHERE id = $1", [created[0].id]),
    /published_document_immutable|權限|permission|denied/i,
    "已發布的文件不得被就地改寫",
  );
});
