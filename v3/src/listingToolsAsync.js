// 刊登生產力工具（說明範本 ＋ 聯絡人快選）的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼挑這個：`/api/listing-description-templates`（5 條）與
// `/api/listing-contact-profiles`（5 條）共 **10 條**路由，是當時缺口裡最集中的一群，
// 而且只碰三張表，沒有跟 `listings` 的複雜寫入糾纏。
//
// 形狀與其他島嶼一致：
//   sqlite   - `listingTools.js` 既有的同步函式（行為完全不變）。
//   postgres - 同一組語句文字跑在呼叫端的交易裡（對應 SQLite 的 `BEGIN IMMEDIATE`）。
//
// **純邏輯一律重用、不複製。** 為了讓 PG 分支也能用，2026-09-27 把三個純函式抽出來並
// 加上 `export`（同步版照用同一份，行為不變）：`templateFields()`、`accountFieldsFromUser()`、
// `sanitizeContactInput()`。輸出形狀用 `publicTemplate()`／`publicContact()`，也只有一份。
//
// ⚠️ 方言：同步版的 `IFNULL(is_account,0)` **PG 不接受**，而且注入式 `exec` 不經過
// `toPostgresSql`，所以這裡一律寫 `COALESCE`。與 reject-match／self-listings 同一個坑。
//
// ⚠️ 另一件同步版有、PG 沒有的東西：`hasAccountContactUniqueIndex()` 讀 `sqlite_master`
// 來確認「一位使用者最多一筆帳號聯絡人」的部分唯一索引存在。**PG 沒有 `sqlite_master`**，
// 而且實測正式站那三張表**只有 pkey**（匯入時 indexes:false）⇒ 索引根本不存在。
// 這裡改用 `pg_indexes` 並在第一次使用時補建，否則併發首次建立會生出兩筆帳號聯絡人。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import {
  ACCOUNT_CONTACT_LABEL,
  CONTACT_PROFILE_LIMIT,
  accountFieldsFromUser,
  createContactProfile as createContactProfileSync,
  createDescriptionTemplate as createDescriptionTemplateSync,
  deleteContactProfile as deleteContactProfileSync,
  deleteDescriptionTemplate as deleteDescriptionTemplateSync,
  descriptionTemplateLimit,
  ensureAccountContactProfile as ensureAccountContactProfileSync,
  getOwnedContactProfile as getOwnedContactProfileSync,
  getOwnedDescriptionTemplate as getOwnedDescriptionTemplateSync,
  httpError,
  iso,
  listContactProfiles as listContactProfilesSync,
  listDescriptionTemplates as listDescriptionTemplatesSync,
  publicContact,
  publicTemplate,
  sanitizeContactInput,
  templateFields,
  updateContactProfile as updateContactProfileSync,
  updateDescriptionTemplate as updateDescriptionTemplateSync,
} from "./listingTools.js";

const ACCOUNT_INDEX = "idx_listing_contact_one_account";

// ---- 語句文字（逐字對應 listingTools.js 的行號；唯一的方言差異是 IFNULL→COALESCE）----
export const LIST_TEMPLATES_SQL =
  "SELECT * FROM listing_description_template WHERE user_id=? ORDER BY sort_order, id"; // listingTools.js:357
export const TEMPLATE_BY_NAME_SQL =
  "SELECT * FROM listing_description_template WHERE user_id=? AND name=?"; // listingTools.js:372
export const TOUCH_TEMPLATE_BODY_SQL =
  "UPDATE listing_description_template SET body=?, updated_at=? WHERE id=? AND user_id=?"; // listingTools.js:376
export const COUNT_TEMPLATES_SQL =
  "SELECT COUNT(*) AS n FROM listing_description_template WHERE user_id=?"; // listingTools.js:381
// PG 用 RETURNING 取回新列（同步版是 `lastInsertRowid` 再 SELECT 一次）。
export const INSERT_TEMPLATE_SQL =
  `INSERT INTO listing_description_template(user_id, name, body, sort_order, created_at, updated_at)
   VALUES (?,?,?,?,?,?) RETURNING *`; // listingTools.js:387
export const TEMPLATE_BY_ID_SQL = "SELECT * FROM listing_description_template WHERE id=?"; // listingTools.js:395
export const TEMPLATE_BY_NAME_OTHER_SQL =
  "SELECT * FROM listing_description_template WHERE user_id=? AND name=? AND id!=?"; // listingTools.js:409
export const RENAME_TEMPLATE_SQL =
  "UPDATE listing_description_template SET name=?, body=?, updated_at=? WHERE id=? AND user_id=?"; // listingTools.js:418
export const DELETE_TEMPLATE_SQL =
  "DELETE FROM listing_description_template WHERE id=? AND user_id=?"; // listingTools.js:426
export const LIST_CONTACTS_SQL =
  "SELECT * FROM listing_contact_profile WHERE user_id=? ORDER BY COALESCE(is_account,0) DESC, id"; // listingTools.js:434（IFNULL→COALESCE）
export const CONTACT_BY_ID_SQL = "SELECT * FROM listing_contact_profile WHERE id=?"; // listingTools.js:475
export const READ_ACCOUNT_CONTACT_SQL =
  "SELECT * FROM listing_contact_profile WHERE user_id=? AND COALESCE(is_account,0)=1 ORDER BY id LIMIT 1"; // listingTools.js:232（IFNULL→COALESCE）
export const UPDATE_ACCOUNT_CONTACT_SQL =
  "UPDATE listing_contact_profile SET label=?, contact_name=?, phone=?, line_url=?, updated_at=? WHERE id=?"; // listingTools.js:238
export const INSERT_ACCOUNT_CONTACT_SQL =
  `INSERT INTO listing_contact_profile(user_id, label, contact_name, phone, line_url, is_account, created_at, updated_at)
   VALUES (?,?,?,?,?,1,?,?) RETURNING *`; // listingTools.js:244
export const COUNT_MANUAL_CONTACTS_SQL =
  "SELECT COUNT(*) AS n FROM listing_contact_profile WHERE user_id=? AND COALESCE(is_account,0)=0"; // listingTools.js:460（IFNULL→COALESCE）
export const INSERT_CONTACT_SQL =
  `INSERT INTO listing_contact_profile(user_id, label, contact_name, phone, line_url, is_account, created_at, updated_at)
   VALUES (?,?,?,?,?,0,?,?) RETURNING *`; // listingTools.js:466
export const UPDATE_CONTACT_SQL =
  "UPDATE listing_contact_profile SET label=?, contact_name=?, phone=?, line_url=?, updated_at=? WHERE id=? AND user_id=?"; // listingTools.js:487
export const DELETE_CONTACT_SQL =
  "DELETE FROM listing_contact_profile WHERE id=? AND user_id=?"; // listingTools.js:498
export const ACCOUNT_FIELDS_SQL =
  "SELECT nickname, email, contact_phone, line_id FROM users WHERE id=?"; // listingTools.js:206

// ---- schema ----
// 同步版是 `ensureListingToolsSchema()`（listingTools.js:107）在 SQLite 上建表。
// PG 這邊**不鏡射本機 SQLite**（正式節點的本機檔可能過期），而是自己寫明確的 DDL：
// 同樣的欄位與索引，另外補上同步版會建、但 PG 正式站實測**不存在**的那個部分唯一索引。
export const PG_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS listing_description_template (
     id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
     user_id BIGINT NOT NULL,
     name TEXT NOT NULL,
     body TEXT NOT NULL,
     sort_order BIGINT NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_listing_desc_tpl_user ON listing_description_template(user_id, id)",
  `CREATE TABLE IF NOT EXISTS listing_contact_profile (
     id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
     user_id BIGINT NOT NULL,
     label TEXT NOT NULL,
     contact_name TEXT NOT NULL DEFAULT '',
     phone TEXT NOT NULL DEFAULT '',
     line_url TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     is_account BIGINT NOT NULL DEFAULT 0
   )`,
  "CREATE INDEX IF NOT EXISTS idx_listing_contact_profile_user ON listing_contact_profile(user_id, id)",
  `CREATE TABLE IF NOT EXISTS listing_copy_idempotency (
     user_id BIGINT NOT NULL,
     request_key TEXT NOT NULL,
     draft_id BIGINT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (user_id, request_key)
   )`,
];
// `ADD COLUMN IF NOT EXISTS` 是 PG 語法（SQLite 沒有），對應同步版 try/catch 的 ALTER
// （listingTools.js:138）。
export const PG_ALTER_STATEMENTS = [
  "ALTER TABLE listing_contact_profile ADD COLUMN IF NOT EXISTS is_account BIGINT NOT NULL DEFAULT 0",
];
// 對應 listingTools.js:150-166「先清重複、再建唯一索引」。
export const PG_DUPLICATE_ACCOUNT_SQL = `SELECT user_id FROM listing_contact_profile
   WHERE COALESCE(is_account,0)=1
   GROUP BY user_id
   HAVING COUNT(*) > 1`;
export const PG_KEEP_ACCOUNT_SQL =
  "SELECT id FROM listing_contact_profile WHERE user_id=? AND COALESCE(is_account,0)=1 ORDER BY id LIMIT 1";
export const PG_DROP_EXTRA_ACCOUNT_SQL =
  "DELETE FROM listing_contact_profile WHERE user_id=? AND COALESCE(is_account,0)=1 AND id!=?";
export const PG_CREATE_ACCOUNT_INDEX_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS ${ACCOUNT_INDEX} ON listing_contact_profile(user_id) WHERE is_account = 1`;
export const PG_ACCOUNT_INDEX_EXISTS_SQL =
  "SELECT 1 AS ok FROM pg_indexes WHERE schemaname='public' AND indexname=$1";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const firstRow = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
// PG 的 COUNT(*) 是 bigint，node-pg 會回字串；同步版也是 `Number(...?.n)`。
const countOf = (rows) => Number(firstRow(rows)?.n) || 0;
const stampOf = (now) => iso(now instanceof Date ? now : new Date(now || Date.now()));

function requireUser(userId) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  return uid;
}

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// 每個 pgDriver 只建一次 schema（含補建那個正式站缺少的唯一索引）。沿用 budgetGuardAsync
// 的 `ensureBudgetStoreOnce` 形狀：記住 promise，併發呼叫不會各建一次。
const schemaReady = new WeakMap();
export async function ensureListingToolsStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = (async () => {
    for (const sql of PG_SCHEMA_STATEMENTS) await pgDriver.exec(sql);
    for (const sql of PG_ALTER_STATEMENTS) await pgDriver.exec(sql);
    await dedupeAccountContacts(pgDriver);
    await pgDriver.exec(PG_CREATE_ACCOUNT_INDEX_SQL);
  })();
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver); // 失敗不要快取，下次再試
    throw error;
  }
}

// 對應 listingTools.js:148 `ensureOneAccountContactPerUser()`：先把重複的清掉，唯一索引才
// 建得起來。同步版也是這個順序（保留 id 最小的那一筆）。
async function dedupeAccountContacts(pgDriver) {
  const dupes = await pgDriver.query(PG_DUPLICATE_ACCOUNT_SQL);
  for (const row of dupes.rows) {
    const keep = await pgDriver.query(PG_KEEP_ACCOUNT_SQL, [row.user_id]);
    const keepId = keep.rows[0]?.id;
    if (keepId == null) continue;
    await pgDriver.query(PG_DROP_EXTRA_ACCOUNT_SQL, [row.user_id, keepId]);
  }
}

async function pgHandle(options = {}) {
  const exec = await pgExec(options);
  if (!options.exec) await ensureListingToolsStoreOnce(options.pgDriver || (await sharedPgDriver()));
  return exec;
}

// 讀取：不開交易；失敗時依 `sqliteFallbackAllowed` 回退（讀取預設 fail-open）。
async function withFallback(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres(await pgHandle(options));
  } catch (error) {
    if (!sqliteFallbackAllowed(options)) throw error;
    return runSqlite();
  }
}

// 寫入：整段包在一個 PG 交易裡，對應 SQLite 的 `BEGIN IMMEDIATE`（`withImmediate`）。
// 寫入預設 **fail-closed**（`sqliteFallbackAllowed` 的 write:true）——寫進沒人讀的 SQLite
// 是無聲的資料分歧，這正是 2026-09-23 HA 演練暴露的問題。
async function withFallbackTx(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    // 注入式 exec 沒有交易（測試以「同一條連線連續執行」近似，與 budgetGuardAsync 相同）。
    if (options.exec) return await runPostgres(options.exec);
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureListingToolsStoreOnce(pgDriver);
    return await pgDriver.withTransaction(async (client) => {
      const exec = (sql, params = []) => client.query(toPostgresSql(sql), params).then((res) => res.rows);
      return runPostgres(exec);
    });
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return runSqlite();
  }
}

// ---- 說明範本 ----

export async function listDescriptionTemplatesAsync(userId, options = {}) {
  const uid = requireUser(userId);
  return withFallback(
    options,
    async (exec) => (await exec(LIST_TEMPLATES_SQL, [uid])).map(publicTemplate),
    () => listDescriptionTemplatesSync(sqliteHandle(), uid),
  );
}

export async function createDescriptionTemplateAsync(userId, rawInput = {}, { now = new Date(), ...options } = {}) {
  const uid = requireUser(userId);
  if (!isPg(options)) {
    return createDescriptionTemplateSync(sqliteHandle(), uid, rawInput, now, {
      plan: options.plan, role: options.role, limit: options.limit,
    });
  }
  // 正規化與驗證用共用的 `templateFields`（同步版也走同一份）。
  const { name, body } = templateFields(rawInput);
  const stamp = stampOf(now);
  const limit = descriptionTemplateLimit({ plan: options.plan, role: options.role });
  return withFallbackTx(options, async (exec) => {
    const same = firstRow(await exec(TEMPLATE_BY_NAME_SQL, [uid, name]));
    if (same) {
      await exec(TOUCH_TEMPLATE_BODY_SQL, [body, stamp, same.id, uid]);
      return publicTemplate(firstRow(await exec(TEMPLATE_BY_ID_SQL, [same.id])));
    }
    const n = countOf(await exec(COUNT_TEMPLATES_SQL, [uid]));
    if (n >= limit) throw httpError(`說明範本最多 ${limit} 則`, 409, "template_limit");
    return publicTemplate(firstRow(await exec(INSERT_TEMPLATE_SQL, [uid, name, body, n, stamp, stamp])));
  }, () => createDescriptionTemplateSync(sqliteHandle(), uid, rawInput, now, {
    plan: options.plan, role: options.role, limit: options.limit,
  }));
}

export async function getOwnedDescriptionTemplateAsync(userId, id, options = {}) {
  const uid = requireUser(userId);
  return withFallback(
    options,
    async (exec) => publicTemplate(await ownedTemplateRow(exec, uid, id)),
    () => getOwnedDescriptionTemplateSync(sqliteHandle(), uid, id),
  );
}

export async function updateDescriptionTemplateAsync(userId, id, rawInput = {}, { now = new Date(), ...options } = {}) {
  const uid = requireUser(userId);
  if (!isPg(options)) return updateDescriptionTemplateSync(sqliteHandle(), uid, id, rawInput, now);
  const stamp = stampOf(now);
  return withFallbackTx(options, async (exec) => {
    const row = await ownedTemplateRow(exec, uid, id);
    const { name, body } = templateFields(rawInput, row); // 沒帶的欄位沿用舊值（同步版同義）
    const sameName = firstRow(await exec(TEMPLATE_BY_NAME_OTHER_SQL, [uid, name, row.id]));
    if (sameName) {
      await exec(TOUCH_TEMPLATE_BODY_SQL, [body, stamp, sameName.id, uid]);
      return publicTemplate(firstRow(await exec(TEMPLATE_BY_ID_SQL, [sameName.id])));
    }
    await exec(RENAME_TEMPLATE_SQL, [name, body, stamp, row.id, uid]);
    return publicTemplate(firstRow(await exec(TEMPLATE_BY_ID_SQL, [row.id])));
  }, () => updateDescriptionTemplateSync(sqliteHandle(), uid, id, rawInput, now));
}

export async function deleteDescriptionTemplateAsync(userId, id, options = {}) {
  const uid = requireUser(userId);
  return withFallbackTx(options, async (exec) => {
    await ownedTemplateRow(exec, uid, id); // 沒有／不是自己的就丟 404／403，與同步版同義
    await exec(DELETE_TEMPLATE_SQL, [Number(id) || 0, uid]);
    return { deleted: true };
  }, () => deleteDescriptionTemplateSync(sqliteHandle(), uid, id));
}

async function ownedTemplateRow(exec, uid, id) {
  const row = firstRow(await exec(TEMPLATE_BY_ID_SQL, [Number(id) || 0]));
  if (!row) throw httpError("找不到這個範本", 404);
  if (Number(row.user_id) !== Number(uid)) throw httpError("只能使用自己的說明範本", 403);
  return row;
}

// ---- 聯絡人 ----

export async function listContactProfilesAsync(userId, options = {}) {
  const uid = requireUser(userId);
  const now = options.now instanceof Date ? options.now : new Date();
  return withFallback(
    options,
    async (exec) => {
      await ensureAccountContactRow(exec, uid, now);
      return (await exec(LIST_CONTACTS_SQL, [uid])).map(publicContact);
    },
    () => listContactProfilesSync(sqliteHandle(), uid),
  );
}

export async function ensureAccountContactProfileAsync(userId, options = {}) {
  const uid = requireUser(userId);
  const now = options.now instanceof Date ? options.now : new Date();
  return withFallbackTx(
    options,
    (exec) => ensureAccountContactRow(exec, uid, now),
    () => ensureAccountContactProfileSync(sqliteHandle(), uid, now),
  );
}

export async function createContactProfileAsync(userId, rawInput = {}, { now = new Date(), ...options } = {}) {
  const uid = requireUser(userId);
  if (!isPg(options)) return createContactProfileSync(sqliteHandle(), uid, rawInput, now);
  const fields = sanitizeContactInput(rawInput); // 純驗證，兩邊共用同一份
  const stamp = stampOf(now);
  return withFallbackTx(options, async (exec) => {
    const n = countOf(await exec(COUNT_MANUAL_CONTACTS_SQL, [uid]));
    if (n >= CONTACT_PROFILE_LIMIT) {
      throw httpError(`聯絡人最多 ${CONTACT_PROFILE_LIMIT} 則`, 409, "contact_limit");
    }
    const row = firstRow(await exec(INSERT_CONTACT_SQL, [
      uid, fields.label, fields.contact_name, fields.phone, fields.line_url, stamp, stamp,
    ]));
    return publicContact(row);
  }, () => createContactProfileSync(sqliteHandle(), uid, rawInput, now));
}

export async function getOwnedContactProfileAsync(userId, id, options = {}) {
  const uid = requireUser(userId);
  return withFallback(
    options,
    async (exec) => publicContact(await ownedContactRow(exec, uid, id)),
    () => getOwnedContactProfileSync(sqliteHandle(), uid, id),
  );
}

export async function updateContactProfileAsync(userId, id, rawInput = {}, { now = new Date(), ...options } = {}) {
  const uid = requireUser(userId);
  if (!isPg(options)) return updateContactProfileSync(sqliteHandle(), uid, id, rawInput, now);
  const stamp = stampOf(now);
  return withFallbackTx(options, async (exec) => {
    const row = await ownedContactRow(exec, uid, id);
    if (Number(row.is_account) === 1) {
      throw httpError("此帳號聯絡人會跟著個人資料更新，不能改這裡", 403, "account_contact_locked");
    }
    const fields = sanitizeContactInput(rawInput, row); // 沒帶的欄位沿用舊值
    await exec(UPDATE_CONTACT_SQL, [fields.label, fields.contact_name, fields.phone, fields.line_url, stamp, row.id, uid]);
    return publicContact(firstRow(await exec(CONTACT_BY_ID_SQL, [row.id])));
  }, () => updateContactProfileSync(sqliteHandle(), uid, id, rawInput, now));
}

export async function deleteContactProfileAsync(userId, id, options = {}) {
  const uid = requireUser(userId);
  return withFallbackTx(options, async (exec) => {
    const row = await ownedContactRow(exec, uid, id);
    if (Number(row.is_account) === 1) throw httpError("此帳號聯絡人不能刪除", 403, "account_contact_locked");
    await exec(DELETE_CONTACT_SQL, [Number(id) || 0, uid]);
    return { deleted: true };
  }, () => deleteContactProfileSync(sqliteHandle(), uid, id));
}

async function ownedContactRow(exec, uid, id) {
  const row = firstRow(await exec(CONTACT_BY_ID_SQL, [Number(id) || 0]));
  if (!row) throw httpError("找不到這個聯絡人", 404);
  if (Number(row.user_id) !== Number(uid)) throw httpError("只能使用自己的聯絡人", 403);
  return row;
}

// 對應 listingTools.js:226 `ensureAccountContactProfile()` 的 upsert 段：
// 讀帳號欄位 → 有就更新、沒有就插入 → 插入撞唯一索引時重讀（併發）。
async function ensureAccountContactRow(exec, uid, now = new Date()) {
  const fields = accountFieldsFromUser(firstRow(await exec(ACCOUNT_FIELDS_SQL, [Number(uid) || 0])) || {});
  const stamp = stampOf(now);
  const existing = firstRow(await exec(READ_ACCOUNT_CONTACT_SQL, [uid]));
  if (existing) {
    await exec(UPDATE_ACCOUNT_CONTACT_SQL, [
      ACCOUNT_CONTACT_LABEL, fields.contact_name, fields.phone, fields.line_url, stamp, existing.id,
    ]);
    return publicContact(firstRow(await exec(CONTACT_BY_ID_SQL, [existing.id])));
  }
  try {
    const row = firstRow(await exec(INSERT_ACCOUNT_CONTACT_SQL, [
      uid, ACCOUNT_CONTACT_LABEL, fields.contact_name, fields.phone, fields.line_url, stamp, stamp,
    ]));
    return publicContact(row);
  } catch (error) {
    const raced = firstRow(await exec(READ_ACCOUNT_CONTACT_SQL, [uid]));
    if (raced) return publicContact(raced);
    throw error;
  }
}
