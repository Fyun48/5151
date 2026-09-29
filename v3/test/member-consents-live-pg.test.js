// 會員同意紀錄 ＋ 匯入確認的 **live PG** 驗證（2026-09-28，第四十八批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了四件事：
//
//   1. **`idx_member_consents_unique` 在 PG 上真的存在**（它是 `CREATE UNIQUE INDEX`，
//      `ensurePgSchema()` 會鏡射；同步語意是「先查再寫並回舊的那一筆」）。
//   2. **`getEffectiveDocumentAsync()` 在真 PG 上讀得到 bootstrap 種的文件**
//      （離線夾具是把磁碟的列複製過去才對得起來的）。
//   3. **匯入確認的 UPDATE**（`status` ／ `terms_document_id` ／ `declaration_version` ／
//      `declaration_content_hash` ／ `confirmed_at`）在真 PG 上落地。
//   4. **同意列是 append-only**（DDL 有 trigger 擋 DELETE）——測試資料不能靠刪除隔離，
//      所以這支測試用**全新的帳號**，而且收尾只清匯入列與刊登（不刪帳號）。
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
const NOW = "2026-09-28T00:00:00.000Z";
const TOKEN = "livetest-consents";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-consents-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：同意紀錄 idempotent、待同意清單、匯入確認端到端", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const consentsAsync = await import("../src/memberConsentsAsync.js");
  const importsAsync = await import("../src/listingImportAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  const syncSequence = async (table) => {
    const pk = (await query(
      `SELECT a.attname AS column FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [table],
    ))[0]?.column;
    assert.ok(pk, `${table} 必須有主鍵（序列同步要用）`);
    await query(
      `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(MAX("${pk}"),0) FROM ${table}), 1))`,
      [table, pk],
    );
  };
  // 同意列 append-only ⇒ 不能刪帳號；只清這支測試種的匯入與刊登。
  const cleanup = async () => {
    await query("DELETE FROM listing_import WHERE original_source_url LIKE $1", [`https://example.com/${TOKEN}%`]);
    await query("DELETE FROM listings WHERE title LIKE $1", [`${TOKEN}%`]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  await cleanup();
  await syncSequence("users");
  await syncSequence("listings");
  await syncSequence("listing_import");

  const stamp = Date.now();
  const [UID] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'同意測試','member','sponsor',$2) RETURNING id",
    [`${TOKEN}-${stamp}@example.com`, OLD],
  )).map((r) => Number(r.id));
  assert.ok(UID);

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 1) 待同意清單：bootstrap 的註冊文件應該在裡面（真 PG 上讀得到）
  const pending = await consentsAsync.pendingRequiredDocumentsAsync(UID, { now: NOW, ...opts });
  assert.ok(pending.length >= 1, `真 PG 上要讀得到 bootstrap 的待同意文件（實際 ${pending.length} 份）`);
  assert.ok(pending.every((doc) => doc.id && doc.content_hash), "每份文件都要有 id 與 content_hash");

  // 2) 逐一同意 → idempotent（第二次回同一筆，且不多寫）
  for (const doc of pending) {
    const first = await consentsAsync.recordConsentAsync(UID, {
      document_type: doc.document_type, document_id: doc.id, version: doc.version, content_hash: doc.content_hash, source: "reaccept",
    }, { now: NOW, ...opts });
    assert.equal(first.document_id, doc.id);
    const again = await consentsAsync.recordConsentAsync(UID, {
      document_type: doc.document_type, document_id: doc.id, version: doc.version, content_hash: doc.content_hash, source: "reaccept",
    }, { now: NOW, ...opts });
    assert.equal(again.id, first.id, "重複同意必須回同一筆（idempotent）");
    assert.equal(
      (await query("SELECT COUNT(*)::int AS n FROM member_consents WHERE user_id = $1 AND document_id = $2", [UID, doc.id]))[0].n, 1,
      "同一份文件不得有兩列同意",
    );
  }
  const after = await consentsAsync.pendingRequiredDocumentsAsync(UID, { now: NOW, ...opts });
  assert.equal(after.length, 0, "全部同意之後不該再有待同意文件");

  // 3) 匯入確認：用真 PG 上有效的匯入聲明
  const [DECL] = await query(
    "SELECT id, version, content_hash FROM content_documents WHERE document_type = 'external_import_declaration' AND status = 'published' AND enabled = 1 ORDER BY version DESC, id DESC LIMIT 1",
  );
  assert.ok(DECL, "真 PG 上必須有已發布的匯入聲明（bootstrap 種的）");
  const LISTING_ID = Number((await query(
    `INSERT INTO listings(source_key, title, url, source, listed_by_user_id, self_status, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, 'self', $4, 'draft', $5, $5) RETURNING post_id`,
    [`self-${TOKEN}`, `${TOKEN} 草稿`, `https://example.com/${TOKEN}`, UID, OLD],
  ))[0].post_id);
  const IMPORT_ID = Number((await query(
    `INSERT INTO listing_import(user_id, provider, original_source_url, normalized_source_url, source_listing_id, status,
       imported_title, imported_text, listing_id, created_at, fetched_at, photo_errors, media_ids)
     VALUES ($1, '591', $2, $2, '', 'ready_for_review', '標題', '內容', $3, $4, $4, '[]', '[]') RETURNING id`,
    [UID, `https://example.com/${TOKEN}-import`, LISTING_ID, OLD],
  ))[0].id);

  // 3a) 舊版聲明 → 409 declaration_stale
  const staleErr = await (async () => {
    try {
      await importsAsync.confirmListingImportAsync(UID, IMPORT_ID, {
        accept: true, document_id: DECL.id, version: 0, content_hash: "stale",
      }, { now: NOW, ...opts });
      return null;
    } catch (error) { return { status: error.status, code: error.code || "" }; }
  })();
  assert.equal(staleErr?.status, 409, "舊版聲明必須擋下");
  assert.equal(staleErr?.code, "declaration_stale");

  // 3b) 正確版本 → 確認成功、同意列落地、匯入列更新
  const confirmed = await importsAsync.confirmListingImportAsync(UID, IMPORT_ID, {
    accept: true, document_id: DECL.id, version: DECL.version, content_hash: DECL.content_hash,
  }, { now: NOW, ...opts });
  assert.equal(confirmed.status, "confirmed");
  const row = (await query(
    "SELECT status, terms_document_id, declaration_version, declaration_content_hash, confirmed_at FROM listing_import WHERE id = $1",
    [IMPORT_ID],
  ))[0];
  assert.equal(row.status, "confirmed", "PG 上必須真的變 confirmed");
  assert.equal(Number(row.terms_document_id), Number(DECL.id));
  assert.equal(Number(row.declaration_version), Number(DECL.version));
  assert.equal(row.declaration_content_hash, DECL.content_hash);
  assert.ok(row.confirmed_at, "confirmed_at 必須有值");
  assert.equal(
    (await query(
      "SELECT COUNT(*)::int AS n FROM member_consents WHERE user_id = $1 AND document_id = $2 AND content_hash = $3 AND source = 'import'",
      [UID, DECL.id, DECL.content_hash],
    ))[0].n, 1,
    "匯入同意必須留下一列（source=import）",
  );
});
