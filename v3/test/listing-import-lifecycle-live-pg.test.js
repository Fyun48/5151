// 匯入生命週期（讀取／修改／取消）的 **live PG** 驗證（2026-09-28，第四十七批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **`listing_import` 的 UPDATE 與 `listings` 的 self_* 欄位**在真 PG 上真的生效
//      （`self_body`／`self_photos`／`cover`／`self_status` 都是 ALTER 加上去的欄位）。
//   2. **取消時的媒體清理**：`deleteMemberMediaAsync()` 在 PG 上走的是真交易
//      （`member_media` 的 soft delete ＋ tag map），離線夾具只驗到「被 try/catch 包住」。
//   3. **`getSelfListingAsync()` 的 try/catch 寬容度**：`listing_import.listing_id` 指向
//      不存在的刊登時，`listing` 要是 `null` 而不是整個回應爆掉。
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
const TOKEN = "livetest-implife";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-implife-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：讀取／修改／取消端到端（含媒體清理與孤兒 listing）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const importsAsync = await import("../src/listingImportAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  // ⚠️ 主鍵欄位**自己查**，不要靠呼叫端記得傳：`listings` 是 `post_id`、其餘多半是 `id`，
  // 這一輪已經有三支 live 測試因為「預設 id」拿到 `column "id" does not exist`。
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
  const cleanup = async () => {
    const users = await query("SELECT id FROM users WHERE email LIKE $1", [`${TOKEN}-%@example.com`]);
    const ids = users.map((r) => Number(r.id));
    if (ids.length) {
      const imports = await query("SELECT id FROM listing_import WHERE user_id = ANY($1)", [ids]);
      const importIds = imports.map((r) => Number(r.id));
      if (importIds.length) await query("DELETE FROM listing_import WHERE id = ANY($1)", [importIds]);
      await query("DELETE FROM member_media WHERE user_id = ANY($1)", [ids]);
      await query("DELETE FROM listings WHERE listed_by_user_id = ANY($1)", [ids]);
      await query("DELETE FROM users WHERE id = ANY($1)", [ids]);
    }
    await query("DELETE FROM listing_import WHERE original_source_url LIKE $1", [`https://example.com/${TOKEN}%`]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  await cleanup();
  await syncSequence("users");
  await syncSequence("listings");
  await syncSequence("listing_import");
  await syncSequence("member_media");

  const [UID] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'匯入會員','member','sponsor',$2) RETURNING id",
    [`${TOKEN}-owner@example.com`, OLD],
  )).map((r) => Number(r.id));
  assert.ok(UID);

  const mkDraft = async (tag) => Number((await query(
    `INSERT INTO listings(source_key, title, url, source, listed_by_user_id, self_status, self_body, self_photos, cover, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, 'self', $4, 'draft', '草稿內容', '[]', '', $5, $5) RETURNING post_id`,
    [`self-${TOKEN}-${tag}`, `${TOKEN} 草稿 ${tag}`, `https://example.com/${TOKEN}-${tag}`, UID, OLD],
  ))[0].post_id);

  const mkImport = async ({ tag, status = "ready_for_review", listingId = null, mediaIds = [] }) => Number((await query(
    `INSERT INTO listing_import(user_id, provider, original_source_url, normalized_source_url, source_listing_id,
       status, imported_title, imported_text, listing_id, created_at, fetched_at, photo_errors, media_ids)
     VALUES ($1, '591', $2, $2, '', $3, $4, '匯入內容', $5, $6, $6, '[]', $7) RETURNING id`,
    [UID, `https://example.com/${TOKEN}-${tag}`, status, `${TOKEN} 匯入 ${tag}`, listingId, OLD, JSON.stringify(mediaIds)],
  ))[0].id);

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true, now: NOW };

  // 1) 讀取：巢狀 listing 要帶出來
  const DRAFT_ID = await mkDraft("read");
  const IMPORT_ID = await mkImport({ tag: "read", listingId: DRAFT_ID });
  const view = await importsAsync.getOwnedListingImportViewAsync(UID, IMPORT_ID, opts);
  assert.equal(view.status, "ready_for_review");
  assert.ok(view.listing, "巢狀 listing 必須在");
  assert.equal(Number(view.listing.post_id), DRAFT_ID);

  // 2) 讀取：listing_id 指向不存在的刊登時，listing 要是 null（不得整個爆掉）
  const ORPHAN_ID = await mkImport({ tag: "orphan", listingId: 999999999 });
  const orphanView = await importsAsync.getOwnedListingImportViewAsync(UID, ORPHAN_ID, opts);
  assert.strictEqual(orphanView.listing, null, "找不到草稿時 listing 必須是 null");

  // 3) 修改：標題與內容寫進 PG，草稿也一起更新
  const reviewed = await importsAsync.reviewListingImportAsync(UID, IMPORT_ID, { title: "  改過的標題  ", body: "改過的內容" }, opts);
  assert.equal(reviewed.imported_title, "改過的標題", "標題要 trim");
  const afterReview = (await query("SELECT imported_title, imported_text FROM listing_import WHERE id = $1", [IMPORT_ID]))[0];
  assert.equal(afterReview.imported_title, "改過的標題");
  const draftAfter = (await query("SELECT title, self_body FROM listings WHERE post_id = $1", [DRAFT_ID]))[0];
  assert.equal(draftAfter.title, "改過的標題", "草稿標題要一起更新");
  assert.equal(draftAfter.self_body, "改過的內容", "草稿內容要一起更新");

  // 4) 取消：匯入與草稿都變 cancelled，而且媒體列真的被 soft delete
  const [MEDIA_ID] = (await query(
    `INSERT INTO member_media(user_id, public_token, storage_key, mime_type, bytes, created_at, updated_at)
     VALUES ($1, $2, $3, 'image/jpeg', 1234, $4, $4) RETURNING id`,
    [UID, `${TOKEN}-media`, `media/${TOKEN}/a.jpg`, OLD],
  )).map((r) => Number(r.id));
  const DRAFT2 = await mkDraft("cancel");
  const CANCEL_ID = await mkImport({ tag: "cancel", listingId: DRAFT2, mediaIds: [MEDIA_ID] });
  const cancelled = await importsAsync.cancelListingImportAsync(UID, CANCEL_ID, opts);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(
    (await query("SELECT status FROM listing_import WHERE id = $1", [CANCEL_ID]))[0].status, "cancelled",
    "匯入狀態必須在 PG 上變 cancelled",
  );
  assert.equal(
    (await query("SELECT self_status FROM listings WHERE post_id = $1", [DRAFT2]))[0].self_status, "cancelled",
    "取消要一起收掉草稿",
  );
  assert.ok(
    (await query("SELECT deleted_at FROM member_media WHERE id = $1", [MEDIA_ID]))[0]?.deleted_at,
    "媒體列必須被 soft delete（清理是 best-effort，但存在的列一定要被處理）",
  );

  // 5) 已取消再取消：idempotent
  const again = await importsAsync.cancelListingImportAsync(UID, CANCEL_ID, opts);
  assert.equal(again.status, "cancelled");
});
