// 第 6 包：v3 BudgetGuard。先在短交易保留額度，交易結束後才打外網。
// daily_budget_twd = 0＝不准花錢。金額用整數最小單位（百萬分之一元），不用 float。
// 金鑰與預算只活在本站 v3.db，不進 OPS。

import { randomUUID, createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { taipeiYmd, monthKey } from "./mapsBilling.js";
// 2.4：語句文字集中在 repository builder，sync（SQLite）與 async（PostgreSQL）兩條路徑共用同一份。
import * as budgetRepo from "./repository/budgetGuard.js";

export const TWD_MINOR = 1_000_000;
export const BUDGET_TZ = "Asia/Taipei";
export const PACK6_BASELINE = "pack6-budget-guard-v1";

export const PROVIDER_CATEGORIES = Object.freeze([
  { id: "scraping_api", label: "網頁代爬", suggestedDailyTwd: 20, codes: ["none", "stub_paid", "zenrows", "scrape_do"] },
  { id: "residential_proxy", label: "住宅代理", suggestedDailyTwd: 20, codes: ["none", "stub_paid", "brightdata", "smartproxy"] },
  { id: "llm", label: "LLM 同源", suggestedDailyTwd: 20, codes: ["none", "stub_paid", "openai", "qwen"], pack: 7 },
  { id: "llm_crawl_insight", label: "爬蟲洞察", suggestedDailyTwd: 20, codes: ["none", "stub_paid", "openai", "qwen"], pack: 7 },
  { id: "distance_matrix", label: "地圖距離", suggestedDailyTwd: 50, codes: ["none", "google_routes"] },
]);

const RESERVATION_STATES = new Set(["reserved", "settled", "released", "unknown"]);

let boundDb = null;
let secretKey = null;

export function bindBudgetDb(db) {
  boundDb = db || null;
}

export function getBoundBudgetDb() {
  return boundDb;
}

export function bindBudgetSecret(secret) {
  secretKey = deriveKey(secret);
}

function deriveKey(secret) {
  const raw = String(secret || "").trim();
  if (!raw) return null;
  return createHash("sha256").update(raw).digest();
}

function activeSecret() {
  if (secretKey) return secretKey;
  const fromEnv = deriveKey(process.env.V3_PROVIDER_SECRET || process.env.AUTH_PASSWORD || "v3-local-provider-secret");
  secretKey = fromEnv;
  return secretKey;
}

export function twdToMinor(twd) {
  const n = Number(twd);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * TWD_MINOR);
}

export function minorToTwd(minor) {
  return Math.round((Number(minor) || 0) / TWD_MINOR * 1000) / 1000;
}

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// SQLite 用 BEGIN IMMEDIATE 取得寫鎖；PostgreSQL 沒有這個語法，PG 分支走
// pgDriver.withTransaction()（見 budgetGuardAsync.js），所以這一支只在 SQLite 分支使用。
function withImmediate(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

// ---- 2.4：sync（SQLite）與 async（PostgreSQL）共用的判斷 ---------------------
// 這一區只有純函式（不含 SQL），兩條路徑都呼叫它們，避免「兩份判斷各自漂移」。

// 種子列的預設值（ensureBudgetSchema 與 PG 的 schema 準備共用）。
export function providerConfigSeedRows() {
  const defaults = {
    scraping_api: { code: "zenrows", ceiling: twdToMinor(1), order: 10 },
    residential_proxy: { code: "brightdata", ceiling: twdToMinor(1), order: 20 },
    llm: { code: "qwen", ceiling: twdToMinor(1), order: 30 },
    llm_crawl_insight: { code: "qwen", ceiling: twdToMinor(1), order: 40 },
    distance_matrix: { code: "google_routes", ceiling: twdToMinor(0.2), order: 50 },
  };
  return PROVIDER_CATEGORIES.map((cat) => ({
    category: cat.id,
    code: defaults[cat.id].code,
    ceiling: defaults[cat.id].ceiling,
    order: defaults[cat.id].order,
  }));
}

// 某個 category 在某時刻要維護的額度桶（**順序即檢查順序**：category day → category month →
// site day → site month）。
export function bucketSpecs({
  category,
  now = new Date(),
  dailyLimitMinor = 0,
  monthlyLimitMinor = 0,
  siteDailyMinor = 0,
  siteMonthlyMinor = 0,
} = {}) {
  const day = taipeiYmd(now);
  const month = monthKey(day);
  const specs = [
    { scopeKind: "category", scopeKey: category, periodKind: "day", periodKey: day, limitMinor: dailyLimitMinor },
  ];
  if (monthlyLimitMinor > 0) {
    specs.push({ scopeKind: "category", scopeKey: category, periodKind: "month", periodKey: month, limitMinor: monthlyLimitMinor });
  }
  if (siteDailyMinor > 0) {
    specs.push({ scopeKind: "site", scopeKey: "v3", periodKind: "day", periodKey: day, limitMinor: siteDailyMinor });
  }
  if (siteMonthlyMinor > 0) {
    specs.push({ scopeKind: "site", scopeKey: "v3", periodKind: "month", periodKey: month, limitMinor: siteMonthlyMinor });
  }
  return { day, month, specs };
}

// reserveBudget 的兩個「還沒進桶子就先不花錢」條件。
export function reservePrecheck({ dayLimit = 0, ceiling = 0 } = {}) {
  if (dayLimit <= 0) return "budget_zero";
  if (ceiling <= 0) return "no_cost_ceiling";
  return "";
}

// 回第一個會被 ceiling 打爆的桶（沒有就回 null）。
export function firstOverflowBucket(buckets, ceiling) {
  for (const bucket of buckets) {
    const used = Number(bucket.settled_minor || 0) + Number(bucket.reserved_minor || 0);
    if (used + ceiling > Number(bucket.limit_minor || 0)) return bucket;
  }
  return null;
}

// 同一個 (request_id, attempt_id) 重複進來時要不要直接沿用。
export function reservationReused(reservation) {
  return reservation.job_state === "reserved" || reservation.job_state === "unknown";
}

export function encryptSecret(plain) {
  const text = String(plain || "");
  if (!text) return null;
  const key = activeSecret();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: iv.toString("base64"),
    ciphertext: Buffer.concat([enc, tag]).toString("base64"),
  };
}

export function decryptSecret(row) {
  if (!row?.ciphertext || !row?.nonce) return "";
  const key = activeSecret();
  const raw = Buffer.from(row.ciphertext, "base64");
  const tag = raw.subarray(raw.length - 16);
  const enc = raw.subarray(0, raw.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.nonce, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ---- 2.4：sync（SQLite）與 async（PostgreSQL）共用的判斷（續）

export function settleDecision(reservation) {
  if (reservation.job_state === "settled") return { kind: "reuse" };
  if (reservation.job_state === "released") return { kind: "error", message: "reservation already released" };
  return { kind: "proceed" };
}

export function settleAmount(reservation, usageMinor) {
  return Math.max(0, Math.min(Number(reservation.ceiling_minor), Math.round(Number(usageMinor) || 0)));
}

export function releaseDecision(reservation) {
  if (reservation.job_state === "released" || reservation.job_state === "settled") return { kind: "reuse" };
  if (reservation.job_state === "unknown") return { kind: "refuse", reason: "uncertain_charge" };
  return { kind: "proceed" };
}

export function holdDecision(reservation) {
  if (reservation.job_state === "unknown") return { kind: "reuse" };
  if (reservation.job_state !== "reserved") return { kind: "refuse", reason: reservation.job_state };
  return { kind: "proceed" };
}

// settings 的數字讀取（找不到或壞值就回 fallback）。
export function settingNumberFrom(value, fallback = 0) {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// 後台要顯示的形狀（純映射；查詢由 driver 負責）。
export function publicProviderConfigShape(row, category) {
  if (!row) return null;
  const meta = categoryMeta(category);
  return {
    id: row.id,
    category: row.category,
    label: meta?.label || row.category,
    provider_code: row.provider_code,
    is_enabled: Number(row.is_enabled) === 1,
    has_credential: Boolean(row.credential_ref),
    daily_budget_twd: minorToTwd(row.daily_limit_minor),
    monthly_budget_twd: minorToTwd(row.monthly_limit_minor),
    ceiling_twd: minorToTwd(row.ceiling_minor),
    suggested_daily_twd: meta?.suggestedDailyTwd || 0,
    pack: meta?.pack || 6,
    price_version: row.price_version,
    codes: meta?.codes || [],
  };
}

export function providerAdminItem(pub, dayBucket, monthBucket, { day, month }) {
  const settled = Number(dayBucket?.settled_minor || 0);
  const reserved = Number(dayBucket?.reserved_minor || 0);
  const limit = Number(dayBucket?.limit_minor ?? pub?.daily_budget_twd ? twdToMinor(pub.daily_budget_twd) : 0);
  const ratio = limit > 0 ? (settled + reserved) / limit : 0;
  return {
    ...pub,
    today: day,
    month,
    today_settled_twd: minorToTwd(settled),
    today_reserved_twd: minorToTwd(reserved),
    today_limit_twd: minorToTwd(limit),
    month_settled_twd: minorToTwd(monthBucket?.settled_minor || 0),
    fuse: ratio >= 1 ? "tripped" : ratio >= 0.8 ? "warn" : "ok",
  };
}

export function usageLogShape(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    category: row.category,
    category_label: categoryMeta(row.category)?.label || row.category,
    event_kind: row.event_kind,
    event_label: USAGE_EVENT_LABEL[row.event_kind] || row.event_kind,
    job_state: row.job_state,
    state_label: RESERVATION_LABEL[row.job_state] || row.job_state || "—",
    amount_twd: row.amount_minor == null ? null : minorToTwd(row.amount_minor),
  };
}

export function providerAdminPayload({ items = [], logs = [], siteDailyMinor = 0, siteMonthlyMinor = 0 } = {}) {
  return {
    baseline: PACK6_BASELINE,
    legal: "金鑰與每日預算只存在本站資料庫。關掉開關會回到原本的免費路徑，不會撤銷已送出的保留額度。",
    site_daily_budget_twd: minorToTwd(siteDailyMinor),
    site_monthly_budget_twd: minorToTwd(siteMonthlyMinor),
    site_zero_means: "uncapped",
    items,
    logs,
  };
}

export function ensureBudgetSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_provider_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      provider_code TEXT NOT NULL,
      region TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      endpoint TEXT NOT NULL DEFAULT '',
      is_enabled INTEGER NOT NULL DEFAULT 0,
      credential_ref TEXT,
      price_version TEXT NOT NULL DEFAULT 'v1',
      fallback_policy TEXT,
      daily_limit_minor INTEGER NOT NULL DEFAULT 0,
      monthly_limit_minor INTEGER NOT NULL DEFAULT 0,
      ceiling_minor INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(category, provider_code, region, model_id)
    );
    CREATE TABLE IF NOT EXISTS provider_secrets (
      credential_ref TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS budget_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      period_kind TEXT NOT NULL,
      period_key TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
      limit_minor INTEGER NOT NULL DEFAULT 0,
      settled_minor INTEGER NOT NULL DEFAULT 0,
      reserved_minor INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scope_kind, scope_key, period_kind, period_key)
    );
    CREATE TABLE IF NOT EXISTS call_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      config_id INTEGER,
      price_version TEXT,
      ceiling_minor INTEGER NOT NULL,
      job_state TEXT NOT NULL,
      provider_request_id TEXT,
      created_at TEXT NOT NULL,
      settled_at TEXT,
      UNIQUE(request_id, attempt_id)
    );
    CREATE TABLE IF NOT EXISTS provider_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      category TEXT NOT NULL,
      provider_code TEXT,
      reservation_id INTEGER,
      event_kind TEXT NOT NULL,
      amount_minor INTEGER,
      job_state TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_budget_period ON budget_limits(period_kind, period_key);
    CREATE INDEX IF NOT EXISTS idx_reservation_state ON call_reservations(job_state, id);
    CREATE INDEX IF NOT EXISTS idx_usage_created ON provider_usage_logs(created_at, id);
  `);
  seedProviderConfigs(db);
  return db;
}

function seedProviderConfigs(db) {
  const now = iso();
  const insert = budgetRepo.seedProviderConfigQuery();
  for (const row of providerConfigSeedRows()) {
    db.prepare(insert.sql).run(row.category, row.code, row.ceiling, row.order, now, now);
  }
}

export function writeUsageLog(db, row) {
  const q = budgetRepo.insertUsageLogQuery();
  db.prepare(q.sql).run(
    iso(row.now),
    String(row.category || ""),
    row.provider_code || null,
    row.reservation_id ?? null,
    String(row.event_kind || "event"),
    row.amount_minor ?? null,
    row.job_state || null,
    String(row.note || "").slice(0, 300) || null,
  );
}

export function categoryMeta(category) {
  return PROVIDER_CATEGORIES.find((row) => row.id === category) || null;
}

export function getProviderConfig(db, category) {
  const q = budgetRepo.providerConfigQuery(category);
  return db.prepare(q.sql).get(...q.params) || null;
}

export function loadEnabledProvider(db, category) {
  const row = getProviderConfig(db, category);
  if (!row || !row.is_enabled) return null;
  if (row.provider_code === "none") return null;
  return row;
}

export function hasCredentials(db, cfg) {
  if (!cfg) return false;
  if (cfg.provider_code === "stub_paid") return true;
  if (cfg.provider_code === "google_routes") return true;
  if (!cfg.credential_ref) return false;
  const q = budgetRepo.providerSecretRefQuery(cfg.credential_ref);
  return Boolean(db.prepare(q.sql).get(...q.params));
}

export function readCredential(db, cfg) {
  if (!cfg?.credential_ref) return "";
  const q = budgetRepo.providerSecretQuery(cfg.credential_ref);
  return decryptSecret(db.prepare(q.sql).get(...q.params));
}

function ensurePeriodBucket(db, spec) {
  const upsert = budgetRepo.ensureBucketQuery(spec);
  db.prepare(upsert.sql).run(...upsert.params);
  const select = budgetRepo.bucketQuery(spec);
  return db.prepare(select.sql).get(...select.params);
}

function applicableBuckets(db, { category, now, dailyLimitMinor, monthlyLimitMinor }) {
  const siteDaily = Number(settingNumber(db, "budget_site_daily_minor", 0));
  const siteMonthly = Number(settingNumber(db, "budget_site_monthly_minor", 0));
  const { specs } = bucketSpecs({
    category,
    now,
    dailyLimitMinor,
    monthlyLimitMinor,
    siteDailyMinor: siteDaily,
    siteMonthlyMinor: siteMonthly,
  });
  return specs.map((spec) => ensurePeriodBucket(db, spec));
}

function settingNumber(db, key, fallback = 0) {
  try {
    const q = budgetRepo.settingValueQuery(key);
    const row = db.prepare(q.sql).get(...q.params);
    return settingNumberFrom(row?.value, fallback);
  } catch {
    return fallback;
  }
}

function upsertSetting(db, key, value) {
  const q = budgetRepo.upsertSettingQuery(key, value);
  db.prepare(q.sql).run(...q.params);
}

function bumpBuckets(db, buckets, deltaReserved, deltaSettled) {
  const sample = budgetRepo.bumpBucketsQuery(0, deltaReserved, deltaSettled);
  const stmt = db.prepare(sample.sql);
  for (const bucket of buckets) {
    stmt.run(deltaReserved, deltaSettled, bucket.id);
  }
}

export function reserveBudget(db, {
  category,
  ceilingMinor,
  requestId,
  attemptId,
  configId = null,
  priceVersion = "v1",
  now = new Date(),
  dailyLimitMinor,
  monthlyLimitMinor,
} = {}) {
  const cat = String(category || "").trim();
  if (!cat) throw httpError("category required");
  const ceiling = Math.max(0, Math.round(Number(ceilingMinor) || 0));
  const reqId = String(requestId || randomUUID());
  const attId = String(attemptId || randomUUID());
  return withImmediate(db, () => {
    const cfg = getProviderConfig(db, cat);
    const dayLimit = dailyLimitMinor ?? Number(cfg?.daily_limit_minor || 0);
    const monthLimit = monthlyLimitMinor ?? Number(cfg?.monthly_limit_minor || 0);
    const precheck = reservePrecheck({ dayLimit, ceiling });
    if (precheck) {
      writeUsageLog(db, {
        now,
        category: cat,
        provider_code: cfg?.provider_code,
        event_kind: "budget_exceeded",
        amount_minor: 0,
        note: precheck === "budget_zero" ? "daily_budget_twd=0" : "no_cost_ceiling",
      });
      return { ok: false, reason: precheck, reserved_minor: 0, request_id: reqId, attempt_id: attId };
    }
    const byRequest = budgetRepo.reservationByRequestQuery(reqId, attId);
    const existing = db.prepare(byRequest.sql).get(...byRequest.params);
    if (existing) {
      return { ok: reservationReused(existing), reservation: existing, reused: true };
    }
    const buckets = applicableBuckets(db, {
      category: cat,
      now,
      dailyLimitMinor: dayLimit,
      monthlyLimitMinor: monthLimit,
    });
    const overflow = firstOverflowBucket(buckets, ceiling);
    if (overflow) {
      writeUsageLog(db, {
        now,
        category: cat,
        provider_code: cfg?.provider_code,
        event_kind: "budget_exceeded",
        amount_minor: 0,
        note: `${overflow.scope_kind}:${overflow.period_kind}`,
      });
      return {
        ok: false,
        reason: "budget_exceeded",
        reserved_minor: 0,
        request_id: reqId,
        attempt_id: attId,
        limit_minor: Number(overflow.limit_minor || 0),
        settled_minor: Number(overflow.settled_minor || 0),
        held_minor: Number(overflow.reserved_minor || 0),
      };
    }
    bumpBuckets(db, buckets, ceiling, 0);
    const insert = budgetRepo.insertReservationQuery({
      requestId: reqId,
      attemptId: attId,
      configId: configId ?? cfg?.id ?? null,
      priceVersion,
      ceilingMinor: ceiling,
      createdAt: iso(now),
    });
    const inserted = db.prepare(insert.sql).get(...insert.params);
    const reservation = loadReservation(db, Number(inserted?.id));
    writeUsageLog(db, {
      now,
      category: cat,
      provider_code: cfg?.provider_code,
      reservation_id: reservation.id,
      event_kind: "reserved",
      amount_minor: ceiling,
      job_state: "reserved",
    });
    return { ok: true, reservation, request_id: reqId, attempt_id: attId, reserved_minor: ceiling };
  });
}

function loadReservation(db, reservation) {
  const q = budgetRepo.reservationByIdQuery(Number(reservation?.id || reservation));
  return db.prepare(q.sql).get(...q.params) || null;
}

function providerCategoryOf(db, configId) {
  const q = budgetRepo.providerCategoryQuery(configId);
  return db.prepare(q.sql).get(...q.params)?.category;
}

function setReservationState(db, id, state, settledAt = null) {
  const q = budgetRepo.setReservationStateQuery({ id, state, settledAt });
  db.prepare(q.sql).run(...q.params);
}

function reservationBuckets(db, reservation, category, now) {
  const cfg = reservation.config_id
    ? db.prepare(budgetRepo.providerConfigByIdQuery(reservation.config_id).sql).get(Number(reservation.config_id) || 0)
    : getProviderConfig(db, category);
  return applicableBuckets(db, {
    category: category || cfg?.category,
    now,
    dailyLimitMinor: Number(cfg?.daily_limit_minor || 0),
    monthlyLimitMinor: Number(cfg?.monthly_limit_minor || 0),
  });
}

export function settleBudget(db, reservationInput, usageMinor, { category, now = new Date() } = {}) {
  return withImmediate(db, () => {
    const reservation = loadReservation(db, reservationInput);
    if (!reservation) throw httpError("reservation not found", 404);
    const decision = settleDecision(reservation);
    if (decision.kind === "reuse") return { ok: true, reservation, reused: true };
    if (decision.kind === "error") throw httpError(decision.message);
    const actual = settleAmount(reservation, usageMinor);
    const cat = category || providerCategoryOf(db, reservation.config_id);
    const buckets = reservationBuckets(db, reservation, cat, now);
    bumpBuckets(db, buckets, -Number(reservation.ceiling_minor), actual);
    setReservationState(db, reservation.id, "settled", iso(now));
    const next = loadReservation(db, reservation.id);
    writeUsageLog(db, {
      now,
      category: cat,
      reservation_id: reservation.id,
      event_kind: "settled",
      amount_minor: actual,
      job_state: "settled",
    });
    return { ok: true, reservation: next, settled_minor: actual };
  });
}

export function releaseBudget(db, reservationInput, { category, now = new Date() } = {}) {
  return withImmediate(db, () => {
    const reservation = loadReservation(db, reservationInput);
    if (!reservation) throw httpError("reservation not found", 404);
    const decision = releaseDecision(reservation);
    if (decision.kind === "reuse") return { ok: true, reservation, reused: true };
    if (decision.kind === "refuse") return { ok: false, reason: decision.reason, reservation };
    const cat = category || providerCategoryOf(db, reservation.config_id);
    const buckets = reservationBuckets(db, reservation, cat, now);
    bumpBuckets(db, buckets, -Number(reservation.ceiling_minor), 0);
    setReservationState(db, reservation.id, "released", iso(now));
    const next = loadReservation(db, reservation.id);
    writeUsageLog(db, {
      now,
      category: cat,
      reservation_id: reservation.id,
      event_kind: "released",
      amount_minor: 0,
      job_state: "released",
    });
    return { ok: true, reservation: next };
  });
}

export function holdBudget(db, reservationInput, { category, now = new Date(), note = "timeout" } = {}) {
  return withImmediate(db, () => {
    const reservation = loadReservation(db, reservationInput);
    if (!reservation) throw httpError("reservation not found", 404);
    const decision = holdDecision(reservation);
    if (decision.kind === "reuse") return { ok: true, reservation, reused: true };
    if (decision.kind === "refuse") return { ok: false, reason: decision.reason, reservation };
    setReservationState(db, reservation.id, "unknown");
    const next = loadReservation(db, reservation.id);
    const cat = category || providerCategoryOf(db, reservation.config_id);
    writeUsageLog(db, {
      now,
      category: cat,
      reservation_id: reservation.id,
      event_kind: "unknown",
      amount_minor: Number(reservation.ceiling_minor),
      job_state: "unknown",
      note,
    });
    return { ok: true, reservation: next };
  });
}

export function saveProviderConfig(db, input = {}, { now = new Date() } = {}) {
  const category = String(input.category || "").trim();
  const meta = categoryMeta(category);
  if (!meta) throw httpError("unknown category");
  const providerCode = String(input.provider_code || input.providerCode || "").trim() || "none";
  if (!meta.codes.includes(providerCode)) throw httpError("unsupported provider");
  const enabled = input.is_enabled === true || input.is_enabled === 1 || input.is_enabled === "1";
  const daily = twdToMinor(input.daily_budget_twd ?? input.dailyBudgetTwd ?? 0);
  const monthly = twdToMinor(input.monthly_budget_twd ?? input.monthlyBudgetTwd ?? 0);
  const ceiling = twdToMinor(input.ceiling_twd ?? input.ceilingTwd ?? (category === "distance_matrix" ? 0.2 : 1));
  const existing = getProviderConfig(db, category);
  let credentialRef = existing?.credential_ref || null;
  if (Object.prototype.hasOwnProperty.call(input, "credential") && String(input.credential || "").trim()) {
    const packed = encryptSecret(String(input.credential).trim());
    credentialRef = `cfg:${category}:${randomUUID()}`;
    const secret = budgetRepo.insertProviderSecretQuery({
      credentialRef,
      nonce: packed.nonce,
      ciphertext: packed.ciphertext,
      createdAt: iso(now),
    });
    db.prepare(secret.sql).run(...secret.params);
  }
  if (input.clear_credential === true) credentialRef = null;
  const stamp = iso(now);
  if (existing) {
    const q = budgetRepo.updateProviderConfigQuery({
      id: existing.id,
      providerCode,
      enabled,
      credentialRef,
      daily,
      monthly,
      ceiling,
      endpoint: String(input.endpoint || existing.endpoint || ""),
      modelId: String(input.model_id || existing.model_id || ""),
      stamp,
    });
    db.prepare(q.sql).run(...q.params);
  } else {
    const q = budgetRepo.insertProviderConfigQuery({
      category,
      providerCode,
      enabled,
      credentialRef,
      daily,
      monthly,
      ceiling,
      stamp,
    });
    db.prepare(q.sql).run(...q.params);
  }
  if (input.site_daily_budget_twd != null) {
    upsertSetting(db, "budget_site_daily_minor", twdToMinor(input.site_daily_budget_twd));
  }
  if (input.site_daily_budget_twd != null || input.site_monthly_budget_twd != null) {
    saveSiteBudget(db, input);
  }
  return publicProviderConfig(db, category);
}

export function saveSiteBudget(db, input = {}) {
  if (input.site_daily_budget_twd != null) {
    upsertSetting(db, "budget_site_daily_minor", twdToMinor(input.site_daily_budget_twd));
  }
  if (input.site_monthly_budget_twd != null) {
    upsertSetting(db, "budget_site_monthly_minor", twdToMinor(input.site_monthly_budget_twd));
  }
  return {
    site_daily_budget_twd: minorToTwd(settingNumber(db, "budget_site_daily_minor", 0)),
    site_monthly_budget_twd: minorToTwd(settingNumber(db, "budget_site_monthly_minor", 0)),
  };
}

export function publicProviderConfig(db, category) {
  return publicProviderConfigShape(getProviderConfig(db, category), category);
}

const USAGE_EVENT_LABEL = Object.freeze({
  reserved: "已保留",
  settled: "已結算",
  released: "已釋放",
  unknown: "未確認（不釋放）",
  fallback: "改走免費路徑",
  budget_exceeded: "超過預算",
  error: "呼叫失敗",
});

const RESERVATION_LABEL = Object.freeze({
  reserved: "保留中",
  settled: "已結算",
  released: "已釋放",
  unknown: "未確認",
});

export function listProviderAdmin(db, { now = new Date() } = {}) {
  const day = taipeiYmd(now);
  const month = monthKey(day);
  const items = PROVIDER_CATEGORIES.map((meta) => {
    const pub = publicProviderConfig(db, meta.id);
    const dayQuery = budgetRepo.bucketQuery({ scopeKind: "category", scopeKey: meta.id, periodKind: "day", periodKey: day });
    const monthQuery = budgetRepo.bucketQuery({ scopeKind: "category", scopeKey: meta.id, periodKind: "month", periodKey: month });
    const dayBucket = db.prepare(dayQuery.sql).get(...dayQuery.params);
    const monthBucket = db.prepare(monthQuery.sql).get(...monthQuery.params);
    return providerAdminItem(pub, dayBucket, monthBucket, { day, month });
  });
  const logsQuery = budgetRepo.usageLogsQuery(50);
  const logs = db.prepare(logsQuery.sql).all(...logsQuery.params).map(usageLogShape);
  return providerAdminPayload({
    items,
    logs,
    siteDailyMinor: settingNumber(db, "budget_site_daily_minor", 0),
    siteMonthlyMinor: settingNumber(db, "budget_site_monthly_minor", 0),
  });
}

export function reservationStateOk(state) {
  return RESERVATION_STATES.has(state);
}
