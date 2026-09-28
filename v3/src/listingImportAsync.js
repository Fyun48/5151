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
import { getEffectiveDocumentAsync } from "./contentDocumentsAsync.js";
import {
  IMPORT_ADMIN_SQL,
  IMPORT_DECLARATION_TYPE,
  IMPORT_MINE_SQL,
  importAdminView,
  importListLimit,
  importMetaShape,
  rowToImport,
} from "./listingImport.js";

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
