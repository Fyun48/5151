// 贊助連動（Phase 3）driver-aware 入口（PG 島嶼）。規則與純函式留在 `sponsorEntitlement.js`。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import { getSiteSettingAsync, setSiteSettingAsync } from "./settingsKvAsync.js";
import { setUserPlanAsync } from "./usersAsync.js";
import {
  SPONSOR_ENTITLEMENT_TABLES,
  SPONSOR_ENTITLEMENT_FLAGS_KEY,
  SPONSOR_ENTITLEMENT_RULES_KEY,
  SUPPORT_CODE_INSERT_SQL,
  SUPPORT_CODE_RESOLVE_SQL,
  SUPPORT_CODE_CURRENT_SQL,
  SPONSOR_GRANT_ROW_SQL,
  SPONSOR_GRANT_INSERT_SQL,
  generateSupportCode,
  normalizeSponsorEntitlementFlags,
  normalizeSponsorEntitlementRules,
  ensureSponsorEntitlementSchema,
} from "./sponsorEntitlement.js";

function iso(value) {
  return (value instanceof Date ? value : new Date(value || Date.now())).toISOString();
}

async function entitlementExec(options = {}) {
  const driver = resolveDbDriver(options);
  if (driver === "postgres") {
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensurePgSchema(pgDriver, sqliteHandle(), { tables: SPONSOR_ENTITLEMENT_TABLES });
    const exec = async (sql, params = []) => pgDriver.query(toPostgresSql(sql), params);
    return { exec, pg: true };
  }
  if (!sqliteFallbackAllowed(options)) throw Object.assign(new Error("資料庫未就緒"), { status: 503 });
  const db = options.db || sqliteHandle();
  ensureSponsorEntitlementSchema(db);
  return { exec: async (sql, params = []) => db.prepare(sql).all(...params), pg: false };
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.rows) ? result.rows : [];
}

export async function getSponsorEntitlementFlagsAsync(options = {}) {
  return normalizeSponsorEntitlementFlags(await getSiteSettingAsync(SPONSOR_ENTITLEMENT_FLAGS_KEY, options));
}

export async function getSponsorEntitlementRulesAsync(options = {}) {
  return normalizeSponsorEntitlementRules(await getSiteSettingAsync(SPONSOR_ENTITLEMENT_RULES_KEY, options));
}

export async function setSponsorEntitlementFlagsAsync(flags, options = {}) {
  const next = normalizeSponsorEntitlementFlags(flags);
  await setSiteSettingAsync(SPONSOR_ENTITLEMENT_FLAGS_KEY, next, options);
  return next;
}

export async function setSponsorEntitlementRulesAsync(rules, options = {}) {
  const next = normalizeSponsorEntitlementRules(rules);
  await setSiteSettingAsync(SPONSOR_ENTITLEMENT_RULES_KEY, next, options);
  return next;
}

export async function issueMemberSupportCodeAsync({ userId, now = new Date(), ttlMs = 24 * 3600 * 1000 } = {}, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return null;
  const { exec } = await entitlementExec(options);
  const at = now instanceof Date ? now : new Date(now);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateSupportCode();
    try {
      await exec(SUPPORT_CODE_INSERT_SQL, [uid, code, iso(at.getTime() + ttlMs), iso(at)]);
      return { code, expiresAt: iso(at.getTime() + ttlMs) };
    } catch {
      if (attempt === 4) return null;
    }
  }
  return null;
}

export async function currentMemberSupportCodeAsync({ userId, now = new Date() } = {}, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return null;
  const { exec } = await entitlementExec(options);
  const rows = rowsOf(await exec(SUPPORT_CODE_CURRENT_SQL, [uid, iso(now)]));
  return rows[0] ? { code: rows[0].code, expiresAt: rows[0].expires_at } : null;
}

export async function resolveMemberSupportCodeAsync({ code, now = new Date() } = {}, options = {}) {
  const raw = String(code || "").trim().toUpperCase();
  if (!raw) return null;
  const { exec } = await entitlementExec(options);
  const rows = rowsOf(await exec(SUPPORT_CODE_RESOLVE_SQL, [raw, iso(now)]));
  return rows[0] ? { userId: Number(rows[0].user_id), code: rows[0].code } : null;
}

// 冪等開通：grant 表 UNIQUE(support_transaction_id) 擋重複；開通走既有 setUserPlanAsync。
// webhook 進帳落地（channel='webhook'，與人工補登的 manual 分開）。
const WEBHOOK_TX_INSERT_SQL = `INSERT INTO support_transaction(
    provider, provider_transaction_id, supporter_user_id, supporter_name, supporter_email,
    amount, fee, net_amount, currency, status, anonymous, message, channel, received_at, raw_reference, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const WEBHOOK_TX_DUP_SQL =
  "SELECT id FROM support_transaction WHERE provider=? AND provider_transaction_id=?";
const USER_WINDOW_SUM_SQL = `SELECT COALESCE(SUM(amount), 0) AS total FROM support_transaction
  WHERE supporter_user_id = ? AND status = 'completed' AND received_at >= ?`;

export async function recordSponsorWebhookTransactionAsync({
  provider, providerTransactionId, userId = null, supporterName = "", supporterEmail = "",
  amount = 0, message = "", receivedAt = new Date(), rawReference = "",
} = {}, options = {}) {
  const { exec } = await entitlementExec(options);
  const dup = rowsOf(await exec(WEBHOOK_TX_DUP_SQL, [String(provider || ""), String(providerTransactionId || "")]));
  if (dup.length) return { ok: true, duplicate: true, id: Number(dup[0].id) };
  const at = receivedAt instanceof Date ? receivedAt : new Date(receivedAt || Date.now());
  const stamp = iso(at);
  await exec(WEBHOOK_TX_INSERT_SQL, [
    String(provider || ""), String(providerTransactionId || ""), userId ? Number(userId) : null,
    String(supporterName || "").slice(0, 120), String(supporterEmail || "").slice(0, 160),
    Number(amount) || 0, 0, Number(amount) || 0, "TWD", "completed", userId ? 0 : 1,
    String(message || "").slice(0, 500), "webhook", stamp, String(rawReference || "").slice(0, 300), stamp, stamp,
  ]);
  return { ok: true, duplicate: false };
}

export async function recentSupportSumAsync({ userId, sinceMs } = {}, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  const { exec } = await entitlementExec(options);
  const rows = rowsOf(await exec(USER_WINDOW_SUM_SQL, [uid, iso(Date.now() - Number(sinceMs || 0))]));
  return Number(rows[0]?.total) || 0;
}

const QUEUE_SQL = `SELECT t.id, t.provider, t.provider_transaction_id, t.supporter_user_id, t.supporter_name,
    t.supporter_email, t.amount, t.status, t.message, t.channel, t.received_at, g.id AS grant_id
  FROM support_transaction t
  LEFT JOIN sponsor_entitlement_grant g
    ON g.support_transaction_id = (t.provider || ':' || t.provider_transaction_id)
  WHERE t.received_at >= ? ORDER BY t.received_at DESC LIMIT 100`;

// 人工對帳佇列：近 N 日的進帳（含 webhook 與人工補登），標出「已匹配會員」與「已開通」。
export async function listEntitlementQueueAsync({ days = 30, now = new Date() } = {}, options = {}) {
  const { exec } = await entitlementExec(options);
  const since = iso((now instanceof Date ? now : new Date(now)).getTime() - Number(days || 30) * 86400000);
  const rows = rowsOf(await exec(QUEUE_SQL, [since]));
  return {
    items: rows.map((row) => ({
      id: Number(row.id),
      provider: row.provider,
      providerTransactionId: row.provider_transaction_id,
      userId: row.supporter_user_id ? Number(row.supporter_user_id) : null,
      supporterName: row.supporter_name || "",
      supporterEmail: row.supporter_email || "",
      amount: Number(row.amount) || 0,
      status: row.status,
      message: row.message || "",
      channel: row.channel,
      receivedAt: row.received_at,
      entitled: Boolean(row.grant_id),
    })),
  };
}

export async function applySponsorEntitlementAsync({
  userId, transactionId, provider = "", amount = 0, reason = "", now = new Date(), durationDays = 30,
} = {}, options = {}) {
  const uid = Number(userId) || 0;
  const tx = String(transactionId || "").trim();
  if (!uid || !tx) return { ok: false, code: "bad_request" };
  const { exec } = await entitlementExec(options);
  const existing = rowsOf(await exec(SPONSOR_GRANT_ROW_SQL, [tx]));
  if (existing.length) return { ok: true, already: true, userId: uid };
  const at = now instanceof Date ? now : new Date(now);
  const expiresAt = iso(at.getTime() + Number(durationDays || 0) * 86400000);
  await exec(SPONSOR_GRANT_INSERT_SQL, [tx, uid, String(provider || ""), Number(amount) || 0, String(reason || "").slice(0, 200), expiresAt, iso(at)]);
  await setUserPlanAsync(uid, "sponsor", options);
  return { ok: true, already: false, userId: uid, entitlementExpiresAt: expiresAt };
}
