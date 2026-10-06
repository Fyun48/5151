// 贊助連動（Phase 3）核心：贊助代碼、出站 URL 組裝、開通管線、webhook 簽章驗證。
// 鐵則：
//   - 四個新 flag 全預設關（`sponsorEntitlementFlags`），且功能以既有 `flags.sponsor_enabled` 為前提。
//   - email 預設不送第三方；可靠對帳鍵是站內一次性贊助代碼（見 agent-brain L-0100）。
//   - 贊助資料不得進物件排序；本模組不 import 任何 listing/ranking 模組。
//   - 外部整合 fail-soft：單筆對帳失敗只損失該筆，不得整批歸零。
import crypto from "node:crypto";

export const SPONSOR_ENTITLEMENT_FLAGS_KEY = "sponsorEntitlementFlags";
export const SPONSOR_ENTITLEMENT_RULES_KEY = "sponsorEntitlementRules";
export const SUPPORT_CODE_TTL_MS = 24 * 60 * 60 * 1000;
export const SUPPORT_CODE_PREFIX = "JIBBY-";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉易混字（I/L/O/0/1）

export const DEFAULT_SPONSOR_ENTITLEMENT_FLAGS = Object.freeze({
  codeAttribution: false,
  autoEntitlement: false,
  apiPoll: false,
  webhook: false,
});

export const DEFAULT_SPONSOR_ENTITLEMENT_RULES = Object.freeze({
  minAmountTWD: 100,
  windowDays: 30,
  durationDays: 30,
  revokeOnRefund: false,
});

export function normalizeSponsorEntitlementFlags(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = { ...DEFAULT_SPONSOR_ENTITLEMENT_FLAGS };
  for (const key of Object.keys(out)) {
    if (typeof src[key] === "boolean") out[key] = src[key];
  }
  return out;
}

export function normalizeSponsorEntitlementRules(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = { ...DEFAULT_SPONSOR_ENTITLEMENT_RULES };
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  out.minAmountTWD = num(src.minAmountTWD, out.minAmountTWD, 1, 100000);
  out.windowDays = num(src.windowDays, out.windowDays, 1, 365);
  out.durationDays = num(src.durationDays, out.durationDays, 1, 365);
  if (typeof src.revokeOnRefund === "boolean") out.revokeOnRefund = src.revokeOnRefund;
  return out;
}

function readSettingsJson(db, key) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

function writeSettingsJson(db, key, value) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

export function getSponsorEntitlementFlags(db) {
  return normalizeSponsorEntitlementFlags(readSettingsJson(db, SPONSOR_ENTITLEMENT_FLAGS_KEY));
}

export function getSponsorEntitlementRules(db) {
  return normalizeSponsorEntitlementRules(readSettingsJson(db, SPONSOR_ENTITLEMENT_RULES_KEY));
}

export function setSponsorEntitlementFlags(db, flags) {
  writeSettingsJson(db, SPONSOR_ENTITLEMENT_FLAGS_KEY, normalizeSponsorEntitlementFlags(flags));
  return getSponsorEntitlementFlags(db);
}

export function setSponsorEntitlementRules(db, rules) {
  writeSettingsJson(db, SPONSOR_ENTITLEMENT_RULES_KEY, normalizeSponsorEntitlementRules(rules));
  return getSponsorEntitlementRules(db);
}

// ---- schema（migration v11）----

export const SPONSOR_ENTITLEMENT_TABLES = [
  "member_support_code",
  "sponsor_entitlement_grant",
  "support_poll_cursor",
];

export function ensureSponsorEntitlementSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_support_code (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_member_support_code_user
      ON member_support_code(user_id, created_at);

    CREATE TABLE IF NOT EXISTS sponsor_entitlement_grant (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      support_transaction_id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      entitlement_expires_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sponsor_grant_user
      ON sponsor_entitlement_grant(user_id, created_at);

    CREATE TABLE IF NOT EXISTS support_poll_cursor (
      provider TEXT PRIMARY KEY,
      cursor_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

// ---- 贊助代碼 ----

function iso(value) {
  return (value instanceof Date ? value : new Date(value || Date.now())).toISOString();
}

export function generateSupportCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(5);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${SUPPORT_CODE_PREFIX}${out}`;
}

export const SUPPORT_CODE_INSERT_SQL = `INSERT INTO member_support_code
  (user_id, code, expires_at, created_at) VALUES (?, ?, ?, ?)`;
export const SUPPORT_CODE_RESOLVE_SQL = `SELECT user_id, code FROM member_support_code
  WHERE code = ? AND used_at IS NULL AND expires_at > ?`;
export const SUPPORT_CODE_CURRENT_SQL = `SELECT code, expires_at FROM member_support_code
  WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`;

export function issueMemberSupportCode(db, { userId, now = new Date(), ttlMs = SUPPORT_CODE_TTL_MS } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw Object.assign(new Error("無法產生贊助代碼"), { status: 401, code: "unauthorized" });
  const at = now instanceof Date ? now : new Date(now);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateSupportCode();
    try {
      db.prepare(SUPPORT_CODE_INSERT_SQL).run(uid, code, iso(at.getTime() + ttlMs), iso(at));
      return { code, expiresAt: iso(at.getTime() + ttlMs) };
    } catch (error) {
      if (attempt === 4) throw error; // UNIQUE 撞碼重試 5 次仍失敗才拋
    }
  }
  throw Object.assign(new Error("無法產生贊助代碼"), { status: 500, code: "support_code_failed" });
}

export function currentMemberSupportCode(db, { userId, now = new Date() } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return null;
  const row = db.prepare(SUPPORT_CODE_CURRENT_SQL).get(uid, iso(now));
  return row ? { code: row.code, expiresAt: row.expires_at } : null;
}

export function resolveMemberSupportCode(db, { code, now = new Date() } = {}) {
  const raw = String(code || "").trim().toUpperCase();
  if (!raw) return null;
  const row = db.prepare(SUPPORT_CODE_RESOLVE_SQL).get(raw, iso(now));
  return row ? { userId: Number(row.user_id), code: row.code } : null;
}

export function markSupportCodeUsed(db, { code, now = new Date() } = {}) {
  db.prepare("UPDATE member_support_code SET used_at = ? WHERE code = ?").run(iso(now), String(code || ""));
}

export function extractSupportCode(text) {
  const match = String(text || "").toUpperCase().match(/JIBBY-[A-Z2-9]{5}\b/);
  return match ? match[0] : "";
}

// ---- 出站能力矩陣與 URL 組裝（實測見 evidence/tmp-planning/sponsor-provider-matrix.md）----

export const SPONSOR_PROVIDER_CAPABILITIES = Object.freeze({
  bmc: Object.freeze({ serverOrder: false, webhook: true, apiPoll: true, prefill: "none", matchKeys: ["code"], noteField: "support_note" }),
  kofi: Object.freeze({ serverOrder: false, webhook: true, apiPoll: false, prefill: "none", matchKeys: ["code"], noteField: "message" }),
  paypal: Object.freeze({ serverOrder: false, webhook: false, apiPoll: false, prefill: "none", matchKeys: ["code-manual"], noteField: "" }), // 現行 PayPal.Me 靜態；Orders API 留 Phase 4
  opay: Object.freeze({ serverOrder: false, webhook: false, apiPoll: false, prefill: "none", matchKeys: ["code-manual"], noteField: "" }), // 現行快速收款連結；AioCheckOut 留 Phase 4
  ezpay: Object.freeze({ serverOrder: false, webhook: false, apiPoll: false, prefill: "none", matchKeys: ["code-manual"], noteField: "" }),
  oen: Object.freeze({ serverOrder: false, webhook: false, apiPoll: false, prefill: "none", matchKeys: ["code-manual"], noteField: "" }),
  github: Object.freeze({ serverOrder: false, webhook: true, apiPoll: true, prefill: "none", matchKeys: ["oauth"], noteField: "" }),
  custom: Object.freeze({ serverOrder: false, webhook: false, apiPoll: false, prefill: "none", matchKeys: ["code-manual"], noteField: "" }),
});

export function sponsorProviderCapability(providerId) {
  return SPONSOR_PROVIDER_CAPABILITIES[providerId] || SPONSOR_PROVIDER_CAPABILITIES.custom;
}

// 組出站資訊。`sendEmail=true` 且管道支援時才把 email 放進給人看的文字；
// 目前沒有任何管道支援 URL 預填（矩陣實測），所以一律回「原網址＋代碼文案」。
export function buildSponsorOutbound(providerId, url, { code, displayName = "", sendEmail = false, email = "" } = {}) {
  const safeUrl = String(url || "").trim();
  const capability = sponsorProviderCapability(providerId);
  const identity = sendEmail && email ? `${displayName}（${email}）` : String(displayName || "").trim();
  const lines = [];
  if (code) lines.push(`贊助代碼 ${code}（付款時請貼在留言／備註欄，我們靠它認出你）`);
  if (identity) lines.push(`贊助者顯示：${identity}`);
  if (!code && !identity) lines.push("未帶身分：這筆贊助會進人工對帳佇列");
  return {
    url: safeUrl,
    mode: capability.serverOrder ? "server-order" : "static-with-code",
    codeText: code ? `贊助代碼 ${code}` : "",
    instructions: lines.join("；"),
    capability,
  };
}

// ---- 開通管線（冪等）----

export const SPONSOR_GRANT_ROW_SQL = `SELECT id FROM sponsor_entitlement_grant WHERE support_transaction_id = ?`;
export const SPONSOR_GRANT_INSERT_SQL = `INSERT INTO sponsor_entitlement_grant
  (support_transaction_id, user_id, provider, amount, reason, entitlement_expires_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

export function applySponsorEntitlement(db, {
  userId,
  transactionId,
  provider = "",
  amount = 0,
  reason = "",
  now = new Date(),
  durationDays = DEFAULT_SPONSOR_ENTITLEMENT_RULES.durationDays,
  applyPlan,
} = {}) {
  const uid = Number(userId) || 0;
  const tx = String(transactionId || "").trim();
  if (!uid || !tx) return { ok: false, code: "bad_request" };
  const at = now instanceof Date ? now : new Date(now);
  if (db.prepare(SPONSOR_GRANT_ROW_SQL).get(tx)) return { ok: true, already: true, userId: uid };
  const expiresAt = iso(at.getTime() + Number(durationDays || 0) * 86400000);
  db.prepare(SPONSOR_GRANT_INSERT_SQL).run(tx, uid, String(provider || ""), Number(amount) || 0, String(reason || "").slice(0, 200), expiresAt, iso(at));
  if (typeof applyPlan === "function") applyPlan(uid, "sponsor");
  return { ok: true, already: false, userId: uid, entitlementExpiresAt: expiresAt };
}

// 到期降回 free：只有「最後一筆 grant 已過期」且目前 plan=sponsor 才動；回傳被降級的 userId 清單。
export const SPONSOR_EXPIRED_GRANT_SQL = `SELECT g.user_id FROM sponsor_entitlement_grant g
  JOIN (SELECT user_id, MAX(created_at) AS latest FROM sponsor_entitlement_grant GROUP BY user_id) m
    ON m.user_id = g.user_id AND m.latest = g.created_at
  WHERE g.entitlement_expires_at IS NOT NULL AND g.entitlement_expires_at <= ?`;

export function expireSponsorEntitlements(db, { now = new Date(), readPlan, applyPlan } = {}) {
  const rows = db.prepare(SPONSOR_EXPIRED_GRANT_SQL).all(iso(now));
  const downgraded = [];
  for (const row of rows || []) {
    const uid = Number(row.user_id) || 0;
    if (!uid) continue;
    const plan = typeof readPlan === "function" ? readPlan(uid) : "sponsor";
    if (plan !== "sponsor") continue;
    if (typeof applyPlan === "function") applyPlan(uid, "free");
    downgraded.push(uid);
  }
  return downgraded;
}

// ---- webhook 簽章驗證 ----

export function verifyBmcWebhookSignature(rawBody, secret, signatureHeader) {
  const key = String(secret || "");
  const given = String(signatureHeader || "").trim();
  if (!key || !given) return false;
  const expected = crypto.createHmac("sha256", key).update(String(rawBody || ""), "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given.toLowerCase(), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyKofiVerificationToken(payload, secret) {
  const key = String(secret || "");
  const given = String(payload?.verification_token || "");
  if (!key || !given) return false;
  const a = Buffer.from(key, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- 對帳判定（純函式，方便單測）----

export function evaluateSupportMatch({ amount, rules = DEFAULT_SPONSOR_ENTITLEMENT_RULES, recentSumTWD = 0 } = {}) {
  const min = Number(rules?.minAmountTWD ?? DEFAULT_SPONSOR_ENTITLEMENT_RULES.minAmountTWD);
  const value = Number(amount) || 0;
  if (value >= min) return { eligible: true, reason: "single" };
  if (recentSumTWD + value >= min * 2) return { eligible: true, reason: "window" };
  return { eligible: false, reason: "below_threshold" };
}
