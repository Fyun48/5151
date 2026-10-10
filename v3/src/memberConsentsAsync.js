// 會員同意紀錄（member consents）的 driver-aware 入口（PG 島嶼，2026-09-28，第四十八批）。
//
// 涵蓋的路由（三條 consent 路由 ＋ 匯入確認的最後一塊零件）：
//   `GET  /api/consents`              → `listMyConsentsAsync`
//   `POST /api/consents`              → `acceptPendingDocumentsAsync`
//   `GET  /api/consents/:id/document`  → `getOwnConsentDocumentAsync`
//   （`POST /api/listing-imports/:id/confirm` 用 `recordConsentAsync`）
//
// `memberConsents.js` 只有 194 行，而且大部分是「讀目前有效文件 ＋ 比對同意紀錄」——
// 文件那一半已經在島上（`contentDocumentsAsync.js`），所以這一包只補：
//   - `member_consents` 的三句 SQL（列表／查既有／插入）
//   - `users.accepted_disclaimer_at`（legacy 註冊同意）的讀取
//
// ⚠️ 兩個一定要照抄的語意：
//   1. **`hasAcceptedRequiredDocument()` 比的是「id ＋ content_hash」**，不是「曾經同意過某一版」；
//      而且文件若 `requires_reacceptance`，legacy 的註冊同意**不算數**。
//   2. **`recordConsent()` 是 idempotent**：同一 (user, document_id, content_hash) 已存在就回舊的、
//      不寫第二列。`idx_member_consents_unique` 是 `CREATE UNIQUE INDEX`（**會**被
//      `ensurePgSchema()` 鏡射），所以撞到時兩個 driver 都會丟唯一鍵錯誤——同步語意是
//      **先查再寫並回舊的那一筆**，這裡逐字照抄（不是靠吞例外）。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import { httpError, matchRegistrationConsents, publicConsentRow } from "./memberConsents.js";
// `REGISTRATION_DOC_TYPES` 的來源是 contentDocuments.js（memberConsents.js 只是再匯入）。
import { REGISTRATION_DOC_TYPES, publicDocumentView } from "./contentDocuments.js";
import { getRequiredRegistrationDocumentsAsync } from "./contentDocumentsAsync.js";
import {
  getDocumentByIdAsync,
  getEffectiveDocumentAsync,
} from "./contentDocumentsAsync.js";

export const MEMBER_CONSENT_TABLES = ["member_consents", "content_documents"];

// 三句共用的 SQL（PG 也接受）。
export const CONSENTS_BY_USER_SQL = "SELECT * FROM member_consents WHERE user_id=? ORDER BY id DESC";
export const CONSENT_EXISTS_SQL =
  "SELECT id FROM member_consents WHERE user_id=? AND document_id=? AND content_hash=? LIMIT 1";
export const CONSENT_INSERT_SQL = `INSERT INTO member_consents(user_id, document_type, document_id, version, content_hash, source, agreed_at)
     VALUES (?,?,?,?,?,?,?)`;
export const CONSENT_BY_ID_SQL = "SELECT * FROM member_consents WHERE id=?";
export const CONSENT_BY_ID_OWNED_SQL = "SELECT * FROM member_consents WHERE id=? AND user_id=?";
export const USER_DISCLAIMER_SQL = "SELECT accepted_disclaimer_at, disclaimer_version FROM users WHERE id=?";
export const LOCAL_USER_SQL = "SELECT id FROM users WHERE id=?";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
const isoOf = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

const schemaReady = new WeakMap();
export async function ensureMemberConsentStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = ensurePgSchema(pgDriver, sqliteHandle(), { tables: MEMBER_CONSENT_TABLES });
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

async function withFallback(options, { write = false }, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureMemberConsentStoreOnce(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

const nested = (options, run) => ({ ...options, driver: "postgres", exec: run });

// `db.js listMyConsents()` 的 PG 版。
export async function listMyConsentsAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  return withFallback(options, {}, async (run) => {
    const rows = (await run(CONSENTS_BY_USER_SQL, [uid])).rows || [];
    return rows.map(publicConsentRow);
  }, async () => (await import("./db.js")).listMyConsents(uid));
}

// `recordConsent()` 的 PG 版：先查再寫並回舊的那一筆（idempotent）。
export async function recordConsentAsync(userId, input = {}, { now = new Date(), ...options } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const type = String(input.document_type || "");
  const documentId = Number(input.document_id) || 0;
  const version = Number(input.version) || 0;
  const hash = String(input.content_hash || "").trim();
  const source = String(input.source || "registration").slice(0, 40);
  if (!type || !documentId || !version || !hash) throw httpError("同意紀錄不完整", 400);
  return withFallback(options, { write: true }, async (run) => {
    const existing = one((await run(CONSENT_EXISTS_SQL, [uid, documentId, hash])).rows);
    if (existing) {
      const row = one((await run(CONSENT_BY_ID_SQL, [existing.id])).rows);
      return publicConsentRow(row);
    }
    await run(CONSENT_INSERT_SQL, [uid, type, documentId, version, hash, source, isoOf(now)]);
    // 回讀剛寫的那一列：用 (user, document_id, hash) 找，不必依賴 lastInsertRowid／RETURNING
    // （兩個 driver 的「最後一列」語意不同，這裡刻意避開）。
    const landed = (await run(CONSENTS_BY_USER_SQL, [uid])).rows.find((row) => (
      Number(row.document_id) === documentId && String(row.content_hash || "") === hash
    ));
    return publicConsentRow(landed || null);
    // ⚠️ SQLite 分支要呼叫**吃 handle 的同步函式**：`db.js` 的 `recordMemberConsent`
    // 只是 `recordConsent` 的原樣再匯出（沒有綁 handle），照包裝的簽章呼叫會把 userId 當成 db。
  }, async () => {
    const { recordConsent } = await import("./memberConsents.js");
    return recordConsent(sqliteHandle(), uid, input, { now });
  });
}

// `hasExactConsent()` 的 PG 版。
async function hasExactConsentAsync(run, userId, doc) {
  if (!doc) return false;
  const row = one((await run(CONSENT_EXISTS_SQL, [Number(userId), Number(doc.id), doc.content_hash])).rows);
  return Boolean(row);
}

// `hasLegacyRegistration()` 的 PG 版（`users.accepted_disclaimer_at`）。
async function hasLegacyRegistrationAsync(run, userId) {
  try {
    const row = one((await run(USER_DISCLAIMER_SQL, [Number(userId)])).rows);
    return Boolean(String(row?.accepted_disclaimer_at || "").trim());
  } catch {
    return false;
  }
}

// `hasAcceptedRequiredDocument()` 的 PG 版：**比 id ＋ content_hash**，不是「曾經同意過」。
// `memberConsents.js:assertRegistrationConsents()` 的 PG 版（`POST /api/register` 的前置）。
// 判斷本身是純函式（`matchRegistrationConsents()`），這裡只把「目前有效且必要的文件」從 PG 讀進來。
export async function assertRegistrationConsentsAsync(submitted, { now = new Date(), ...options } = {}) {
  const required = await getRequiredRegistrationDocumentsAsync({ now, ...options });
  // 與同步版 `assertRequiredRegistrationReady()` 同義：缺任何一型就 503（不是讓使用者看到空清單）。
  if (required.length !== REGISTRATION_DOC_TYPES.length) {
    throw httpError("目前無法取得有效的註冊條款，請稍後再試", 503);
  }
  return matchRegistrationConsents(required, submitted);
}

// `memberConsents.js:recordRegistrationConsents()` 的 PG 版：逐份文件呼叫既有的
// `recordConsentAsync()`（只寫 PG；重複同意會回既有那一列）。
export async function recordRegistrationConsentsAsync(userId, docs = [], { source = "registration", now = new Date(), ...options } = {}) {
  const out = [];
  for (const doc of Array.isArray(docs) ? docs : []) {
    out.push(await recordConsentAsync(userId, {
      document_type: doc.document_type,
      document_id: doc.id,
      version: doc.version,
      content_hash: doc.content_hash,
      source,
    }, { now, ...options }));
  }
  return out;
}

export async function hasAcceptedRequiredDocumentAsync(userId, documentType, { now = new Date(), ...options } = {}) {
  return withFallback(options, {}, async (run) => {
    const doc = await getEffectiveDocumentAsync(documentType, { now, ...nested(options, run) });
    if (!doc) return false;
    if (await hasExactConsentAsync(run, userId, doc)) return true;
    if (doc.requires_reacceptance) return false;
    if (REGISTRATION_DOC_TYPES.includes(documentType) && await hasLegacyRegistrationAsync(run, userId)) return true;
    return false;
  }, async () => (await import("./db.js")).hasAcceptedRequiredDocument(userId, documentType, { now }));
}

// `pendingRequiredDocuments()` 的 PG 版。
export async function pendingRequiredDocumentsAsync(userId, { now = new Date(), ...options } = {}) {
  return withFallback(options, {}, async (run) => {
    const out = [];
    for (const type of REGISTRATION_DOC_TYPES) {
      const doc = await getEffectiveDocumentAsync(type, { now, ...nested(options, run) });
      if (!doc) continue;
      if (await hasAcceptedRequiredDocumentAsync(userId, doc.document_type, { now, ...nested(options, run) })) continue;
      out.push(publicDocumentView(doc));
    }
    return out;
  }, async () => (await import("./db.js")).pendingMemberDocuments(userId, { now }));
}

// `recordExactSubmittedConsents()` 的 PG 版（`POST /api/consents`）。
export async function acceptPendingDocumentsAsync(userId, submitted, { source = "reaccept", now = new Date(), ...options } = {}) {
  return withFallback(options, { write: true }, async (run) => {
    const required = await pendingRequiredDocumentsAsync(userId, { now, ...nested(options, run) });
    const items = Array.isArray(submitted) ? submitted : [];
    const acceptedDocs = [];
    for (const doc of required) {
      const hit = items.find((row) => (
        Number(row?.document_id) === doc.id
        && String(row?.content_hash || "") === doc.content_hash
      ));
      if (!hit) throw httpError("請先閱讀並同意更新後的條款", 400);
      acceptedDocs.push({
        document_type: doc.document_type,
        document_id: doc.id,
        version: doc.version,
        content_hash: doc.content_hash,
      });
    }
    const out = [];
    for (const row of acceptedDocs) {
      out.push(await recordConsentAsync(userId, { ...row, source }, { now, ...nested(options, run) }));
    }
    return out;
  }, async () => (await import("./db.js")).acceptPendingDocuments(userId, submitted, { source, now }));
}

// `historicalDocumentForConsent()` 的 PG 版（`GET /api/consents/:id/document`）。
export async function getOwnConsentDocumentAsync(userId, consentId, options = {}) {
  const uid = Number(userId) || 0;
  return withFallback(options, {}, async (run) => {
    const row = one((await run(CONSENT_BY_ID_OWNED_SQL, [Number(consentId) || 0, uid])).rows);
    if (!row || !row.document_id) return null;
    const doc = await getDocumentByIdAsync(row.document_id, nested(options, run));
    if (!doc || doc.status !== "published") return null;
    return publicDocumentView(doc);
  }, async () => (await import("./db.js")).getOwnConsentDocument(uid, consentId));
}
