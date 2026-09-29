// 匯入功能說明（`listingImportMeta`）的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// `importMeta(db, {plan, now})` 全段只有**一句** DB 存取（取「匯入聲明」目前生效的那一版），
// 其餘是純組裝。所以移植很小：那句改用 `getEffectiveDocumentAsync()`（第十六批已移植），
// 組裝重用 `importMetaShape()`（本次從 `importMeta()` 抽出來，同步版照用同一份）。
//
// 涵蓋的路由：
//   `GET /api/listing-imports/meta`   → `importMetaAsync`（2026-09-27）
//   `GET /api/listing-imports`        → `listMineListingImportsAsync`（第四十五批）
//   `GET /api/admin/listing-imports`  → `listAdminListingImportsAsync`（第四十五批）
//
// 兩個清單都只有**一句** SELECT（後台那句多一個 `LEFT JOIN users` 取會員 email），
// 而且列 → 物件的轉換（`rowToImport`）與上限夾法都已抽成共用零件，
// 所以 PG 版只負責「換 runner」。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import { httpError } from "./selfListings.js";
import { getEffectiveDocumentAsync } from "./contentDocumentsAsync.js";
import {
  IMPORT_ADMIN_SQL,
  IMPORT_BY_ID_SQL,
  IMPORT_CONFIRM_UPDATE_SQL,
  IMPORT_DECLARATION_TYPE,
  IMPORT_MINE_SQL,
  IMPORT_STATUSES,
  IMPORT_STATUS_UPDATE_SQL,
  IMPORT_TITLE_TEXT_UPDATE_SQL,
  assertImportOwner,
  importAdminView,
  importListLimit,
  importMetaShape,
  publicImportShape,
  rowToImport,
} from "./listingImport.js";
import { sanitizeImportedText, sanitizeImportedTitle } from "./importSanitize.js";
import { abandonImportedDraftListingAsync, getSelfListingAsync, updateImportedDraftListingAsync } from "./selfListingsAsync.js";
import { deleteMemberMediaAsync } from "./memberMediaAsync.js";
import { recordConsentAsync } from "./memberConsentsAsync.js";

export const LISTING_IMPORT_TABLES = ["listing_import"];

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const schemaReady = new WeakMap();
export async function ensureListingImportOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = ensurePgSchema(pgDriver, sqliteHandle(), { tables: LISTING_IMPORT_TABLES });
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

async function withFallback(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureListingImportOnce(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return runSqlite();
  }
}

// `db.js listMineListingImports()` 的 PG 版。
export async function listMineListingImportsAsync(userId, { limit = 20 } = {}, options = {}) {
  const uid = Number(userId) || 0;
  return withFallback(options, async (run) => {
    const rows = (await run(IMPORT_MINE_SQL, [uid, importListLimit(limit, { cap: 50, fallback: 20 })])).rows || [];
    return rows.map(rowToImport);
  }, async () => (await import("./db.js")).listMineListingImports(uid, { limit }));
}

// `db.js listAdminListingImports()` 的 PG 版。
export async function listAdminListingImportsAsync({ limit = 50 } = {}, options = {}) {
  return withFallback(options, async (run) => {
    const rows = (await run(IMPORT_ADMIN_SQL, [importListLimit(limit, { cap: 200, fallback: 50 })])).rows || [];
    return rows.map(importAdminView);
  }, async () => (await import("./db.js")).listAdminListingImports({ limit }));
}

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

export async function importMetaAsync({ plan = "free", now = new Date(), ...options } = {}) {
  if (!isPg(options)) return (await import("./db.js")).listingImportMeta({ plan, now });
  const doc = await getEffectiveDocumentAsync(IMPORT_DECLARATION_TYPE, { now, ...options });
  return importMetaShape(doc, { plan });
}

// ---- 匯入生命週期：讀取／修改／取消（第四十七批）----
//
// 對應 `db.js` 的三個包裝（＝三條路由實際呼叫的入口）：
//   `GET   /api/listing-imports/:id`         → `getOwnedListingImportViewAsync`
//   `PATCH /api/listing-imports/:id`         → `reviewListingImportAsync`
//   `POST  /api/listing-imports/:id/cancel`  → `cancelListingImportAsync`
//
// ⚠️ 三件事與同步版逐條對齊：
//   1. **`publicImport()` 的 20 個鍵**用共用的 `publicImportShape()`，而 `listing` 那一格
//      在 PG 版是 `getSelfListingAsync()`（同步版是 `safeListing()` + 同步的 `getSelfListing()`），
//      兩邊都是「查不到就 null」。
//   2. **狀態機**：`reviewListingImport()` 只接受 `ready_for_review`；
//      `cancelListingImport()` 對 `confirmed` 丟 409、對 `cancelled` 直接回同一筆（idempotent）。
//   3. **取消時的媒體清理**用 `deleteMemberMediaAsync()`，而且逐筆 try/catch
//      （同步版也是——「已被引用或已刪」不該讓取消失敗）。

const IMPORT_ROW_OPTIONS = (options, exec) => ({ ...options, driver: "postgres", exec });

async function readImportRow(exec, id) {
  const rows = (await exec(IMPORT_BY_ID_SQL, [Number(id) || 0])).rows || [];
  return rowToImport(rows[0]) || null;
}

// 同步版的 `safeListing()`：查不到（或不可見）就 null，不讓整個回應爆掉。
async function safeListingAsync(row, options, exec) {
  if (!row?.listing_id) return null;
  try {
    return await getSelfListingAsync(row.listing_id, { viewerId: row.user_id, ...IMPORT_ROW_OPTIONS(options, exec) });
  } catch {
    return null;
  }
}

async function publicImportAsync(row, { listing = undefined, reused = false } = {}, options = {}, exec = null) {
  const resolved = listing === undefined ? await safeListingAsync(row, options, exec) : listing;
  return publicImportShape(row, { listing: resolved, reused });
}

// `db.js getOwnedListingImport()` 的 PG 版（回的是**公開形狀**，不是原始列）。
export async function getOwnedListingImportViewAsync(userId, id, options = {}) {
  return withFallback(options, async (run) => {
    const row = assertImportOwner(await readImportRow(run, id), userId);
    return publicImportAsync(row, {}, options, run);
  }, async () => (await import("./db.js")).getOwnedListingImport(userId, id));
}

// `db.js reviewListingImportFor()` 的 PG 版。
export async function reviewListingImportAsync(userId, id, input = {}, options = {}) {
  return withFallback(options, async (run) => {
    const row = assertImportOwner(await readImportRow(run, id), userId);
    if (row.status !== IMPORT_STATUSES.READY_FOR_REVIEW) {
      throw httpError("這筆匯入目前不能修改", 409, row.status);
    }
    const title = input.title != null ? sanitizeImportedTitle(input.title) : row.imported_title;
    const text = input.body != null || input.imported_text != null
      ? sanitizeImportedText(input.body ?? input.imported_text)
      : row.imported_text;
    const keep = Array.isArray(input.photos) ? input.photos : null;
    let listing = null;
    if (row.listing_id) {
      listing = await updateImportedDraftListingAsync(userId, row.listing_id, { title, body: text, photos: keep }, IMPORT_ROW_OPTIONS(options, run));
    }
    await run(IMPORT_TITLE_TEXT_UPDATE_SQL, [title, text, row.id]);
    // 本機追上（後台的匯入清單還有同步讀者時才看得到；與其他批次同一個紀律）。
    sqliteHandle().prepare(IMPORT_TITLE_TEXT_UPDATE_SQL).run(title, text, row.id);
    return publicImportAsync({ ...row, imported_title: title, imported_text: text }, { listing }, options, run);
  }, async () => (await import("./db.js")).reviewListingImportFor(userId, id, input));
}

// `db.js cancelListingImportFor()` 的 PG 版。
export async function cancelListingImportAsync(userId, id, options = {}) {
  const { now = new Date(), ...rest } = options;
  return withFallback(rest, async (run) => {
    const row = assertImportOwner(await readImportRow(run, id), userId);
    if (row.status === IMPORT_STATUSES.CONFIRMED) throw httpError("已確認的匯入不能取消", 409);
    if (row.status === IMPORT_STATUSES.CANCELLED) return publicImportAsync(row, {}, rest, run);
    if (row.listing_id) {
      await abandonImportedDraftListingAsync(userId, row.listing_id, { now, ...IMPORT_ROW_OPTIONS(rest, run) });
    }
    for (const mediaId of row.media_ids || []) {
      try {
        await deleteMemberMediaAsync(userId, mediaId, IMPORT_ROW_OPTIONS(rest, run));
      } catch {
        // 已被引用或已刪（與同步版的 cleanupImportedMedia 同義）
      }
    }
    await run(IMPORT_STATUS_UPDATE_SQL, [IMPORT_STATUSES.CANCELLED, row.id]);
    sqliteHandle().prepare(IMPORT_STATUS_UPDATE_SQL).run(IMPORT_STATUSES.CANCELLED, row.id);
    return publicImportAsync(await readImportRow(run, row.id), {}, rest, run);
  }, async () => (await import("./db.js")).cancelListingImportFor(userId, id));
}

// `db.js confirmListingImportFor()` 的 PG 版（第四十八批）。
//
// ⚠️ 三件事與同步版逐條對齊：
//   1. **只接受 `ready_for_review`**，而且必須明確 `accept === true`（或 `accepted === true`）。
//   2. **聲明必須是「目前有效的那一版」**：比對 document_id／version／content_hash，
//      不一致就 409 `declaration_stale`（使用者要重新閱讀）；取不到有效文件則 503。
//   3. **同意紀錄走 `recordConsentAsync()`**（idempotent：同一 (user, document_id, hash) 不寫第二列）。
export async function confirmListingImportAsync(userId, id, input = {}, options = {}) {
  const { now = new Date(), ...rest } = options;
  return withFallback(rest, async (run) => {
    const row = assertImportOwner(await readImportRow(run, id), userId);
    if (row.status !== IMPORT_STATUSES.READY_FOR_REVIEW) {
      throw httpError("這筆匯入還不能確認", 409, row.status);
    }
    if (input.accept !== true && input.accepted !== true) {
      throw httpError("請勾選匯入聲明後再確認", 400);
    }
    const current = await getEffectiveDocumentAsync(IMPORT_DECLARATION_TYPE, { now, ...IMPORT_ROW_OPTIONS(rest, run) });
    if (!current) throw httpError("目前無法取得有效的匯入聲明", 503);
    const submitted = {
      document_id: Number(input.document_id || input.terms_document_id) || 0,
      version: Number(input.version || input.declaration_version) || 0,
      content_hash: String(input.content_hash || input.declaration_content_hash || "").trim(),
    };
    if (
      submitted.document_id !== current.id
      || submitted.version !== current.version
      || submitted.content_hash !== current.content_hash
    ) {
      throw httpError("匯入聲明已更新，請重新閱讀目前有效版本後再確認", 409, "declaration_stale");
    }
    await recordConsentAsync(userId, {
      document_type: IMPORT_DECLARATION_TYPE,
      document_id: current.id,
      version: current.version,
      content_hash: current.content_hash,
      source: "import",
    }, { now, ...IMPORT_ROW_OPTIONS(rest, run) });
    const params = [IMPORT_STATUSES.CONFIRMED, current.id, current.version, current.content_hash, now instanceof Date ? now.toISOString() : new Date(now).toISOString(), row.id];
    await run(IMPORT_CONFIRM_UPDATE_SQL, params);
    sqliteHandle().prepare(IMPORT_CONFIRM_UPDATE_SQL).run(...params);
    return publicImportAsync(await readImportRow(run, row.id), {}, rest, run);
  }, async () => (await import("./db.js")).confirmListingImportFor(userId, id, input));
}
