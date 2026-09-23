// provider／budget 這個 store 的 PostgreSQL 實作（2.4）。
//
// SQLite 分支＝budgetGuard.js 的同步函式（行為完全不變）；PG 分支＝這個檔。
// 兩邊共用 repository/budgetGuard.js 的語句文字與 budgetGuard.js 的純判斷
// （bucketSpecs／reservePrecheck／firstOverflowBucket／settleDecision…），所以判斷只有一份。
//
// 交易：每個寫入動作都在 pgDriver.withTransaction() 內完成——對應 SQLite 的 BEGIN IMMEDIATE。
// 離線替身（options.exec）沒有交易，測試以「同一條連線連續執行」近似。
//
// ⚠️ PG 端兩個一定要先處理的事（見 ensureBudgetStoreOnce）：
//   1. SQLite 的 UNIQUE **表約束**不會被 pgSchema 鏡射（它是隱式索引，不在 sqlite_master 裡），
//      所以要自己建唯一索引，否則 ON CONFLICT(...) 直接回 42P10。
//   2. 帶 id 的匯入不會推進 identity 序號 → 不重對齊的話第一筆 INSERT 撞 pkey
//      （實測影子站 provider_usage_logs 有 24705 列、序號還在 1）。
import { randomUUID } from "node:crypto";
import { taipeiYmd, monthKey } from "./mapsBilling.js";
import {
  bucketSpecs,
  categoryMeta,
  firstOverflowBucket,
  holdDecision,
  httpError,
  providerAdminItem,
  providerAdminPayload,
  providerConfigSeedRows,
  publicProviderConfigShape,
  releaseDecision,
  reservationReused,
  reservePrecheck,
  settingNumberFrom,
  settleAmount,
  settleDecision,
  minorToTwd,
  twdToMinor,
  usageLogShape,
  PROVIDER_CATEGORIES,
} from "./budgetGuard.js";
import {
  ensureBudgetSchema as ensureBudgetSchemaSync,
  getProviderConfig as getProviderConfigSync,
  hasCredentials as hasCredentialsSync,
  holdBudget as holdBudgetSync,
  listProviderAdmin as listProviderAdminSync,
  loadEnabledProvider as loadEnabledProviderSync,
  publicProviderConfig as publicProviderConfigSync,
  readCredential as readCredentialSync,
  releaseBudget as releaseBudgetSync,
  reserveBudget as reserveBudgetSync,
  saveProviderConfig as saveProviderConfigSync,
  saveSiteBudget as saveSiteBudgetSync,
  settleBudget as settleBudgetSync,
  writeUsageLog as writeUsageLogSync,
} from "./budgetGuard.js";
import { resolveDbDriver } from "./dbDriver.js";
import { ensurePgSchema, resyncIdentitySequences } from "./pgSchema.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import * as repo from "./repository/budgetGuard.js";

function firstRow(rows) {
  return (rows || [])[0] || null;
}

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

// 每次呼叫都帶著 sqliteHandle：PG 分支要靠 SQLite schema 鏡射建表與對齊序號。
function withConn(options, conn) {
  if (!conn || options.sqliteHandle) return options;
  return { ...options, sqliteHandle: conn };
}

const schemaReady = new WeakSet();

async function ensureBudgetStoreOnce(pgDriver, sqliteDb) {
  const key = pgDriver;
  if (schemaReady.has(key)) return;
  if (!sqliteDb) throw new Error("budget store(postgres) requires the SQLite handle for schema mirroring");
  await ensurePgSchema(pgDriver, sqliteDb, { tables: repo.BUDGET_TABLES });
  for (const spec of repo.BUDGET_UNIQUE_INDEXES) {
    await pgDriver.exec(repo.uniqueIndexStatement(spec).sql);
  }
  await resyncIdentitySequences(pgDriver, sqliteDb, { tables: repo.BUDGET_TABLES });
  schemaReady.add(key);
}

// 讀取：不開交易。
async function withFallback(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    if (options.exec) return await runPostgres(options.exec);
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureBudgetStoreOnce(pgDriver, options.sqliteHandle);
    const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
    return await runPostgres(exec);
  } catch (error) {
    if (options.strict) throw error;
    return runSqlite();
  }
}

// 寫入：整段包在一個 PostgreSQL 交易裡（對應 SQLite 的 withImmediate）。
async function withFallbackTx(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    if (options.exec) return await runPostgres(options.exec);
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureBudgetStoreOnce(pgDriver, options.sqliteHandle);
    return await pgDriver.withTransaction(async (client) => {
      const exec = async (sql, params = []) => (await client.query(toPostgresSql(sql), params)).rows;
      return runPostgres(exec);
    });
  } catch (error) {
    if (options.strict) throw error;
    return runSqlite();
  }
}

// ---- PostgreSQL 實作（不 export；由下面的 async 入口分派） --------------------

async function pgConfig(exec, category) {
  const q = repo.providerConfigQuery(category);
  return firstRow(await exec(q.sql, q.params));
}

async function pgSettingNumber(exec, key, fallback = 0) {
  const q = repo.settingValueQuery(key);
  const row = firstRow(await exec(q.sql, q.params));
  return settingNumberFrom(row?.value, fallback);
}

async function pgBuckets(exec, { category, now, dailyLimitMinor, monthlyLimitMinor }) {
  const siteDaily = await pgSettingNumber(exec, "budget_site_daily_minor", 0);
  const siteMonthly = await pgSettingNumber(exec, "budget_site_monthly_minor", 0);
  const { specs } = bucketSpecs({
    category,
    now,
    dailyLimitMinor,
    monthlyLimitMinor,
    siteDailyMinor: siteDaily,
    siteMonthlyMinor: siteMonthly,
  });
  const buckets = [];
  for (const spec of specs) {
    const upsert = repo.ensureBucketQuery(spec);
    await exec(upsert.sql, upsert.params);
    const select = repo.bucketQuery(spec);
    buckets.push(firstRow(await exec(select.sql, select.params)));
  }
  return buckets;
}

async function pgUsageLog(exec, row) {
  const q = repo.insertUsageLogQuery();
  await exec(q.sql, [
    iso(row.now),
    String(row.category || ""),
    row.provider_code || null,
    row.reservation_id ?? null,
    String(row.event_kind || "event"),
    row.amount_minor ?? null,
    row.job_state || null,
    String(row.note || "").slice(0, 300) || null,
  ]);
}

async function pgBumpBuckets(exec, buckets, deltaReserved, deltaSettled) {
  for (const bucket of buckets) {
    const q = repo.bumpBucketsQuery(bucket.id, deltaReserved, deltaSettled);
    await exec(q.sql, q.params);
  }
}

async function pgReservation(exec, id) {
  const q = repo.reservationByIdQuery(Number(id) || 0);
  return firstRow(await exec(q.sql, q.params));
}

async function pgCategoryOf(exec, configId) {
  const q = repo.providerCategoryQuery(configId);
  return firstRow(await exec(q.sql, q.params))?.category;
}

async function pgSetState(exec, id, state, settledAt = null) {
  const q = repo.setReservationStateQuery({ id, state, settledAt });
  await exec(q.sql, q.params);
}

async function pgReservationBuckets(exec, reservation, category, now) {
  let cfg = null;
  if (reservation.config_id) {
    const q = repo.providerConfigByIdQuery(reservation.config_id);
    cfg = firstRow(await exec(q.sql, q.params));
  } else {
    cfg = await pgConfig(exec, category);
  }
  return pgBuckets(exec, {
    category: category || cfg?.category,
    now,
    dailyLimitMinor: Number(cfg?.daily_limit_minor || 0),
    monthlyLimitMinor: Number(cfg?.monthly_limit_minor || 0),
  });
}

// reserveBudget 的 PG 版（步驟順序與 budgetGuard.js 的同步版逐條對應）。
async function pgReserveBudget(exec, args = {}) {
  const cat = String(args.category || "").trim();
  if (!cat) throw httpError("category required");
  const ceiling = Math.max(0, Math.round(Number(args.ceilingMinor) || 0));
  const reqId = String(args.requestId || randomUUID());
  const attId = String(args.attemptId || randomUUID());
  const now = args.now || new Date();
  const cfg = await pgConfig(exec, cat);
  const dayLimit = args.dailyLimitMinor ?? Number(cfg?.daily_limit_minor || 0);
  const monthLimit = args.monthlyLimitMinor ?? Number(cfg?.monthly_limit_minor || 0);
  const precheck = reservePrecheck({ dayLimit, ceiling });
  if (precheck) {
    await pgUsageLog(exec, {
      now,
      category: cat,
      provider_code: cfg?.provider_code,
      event_kind: "budget_exceeded",
      amount_minor: 0,
      note: precheck === "budget_zero" ? "daily_budget_twd=0" : "no_cost_ceiling",
    });
    return { ok: false, reason: precheck, reserved_minor: 0, request_id: reqId, attempt_id: attId };
  }
  const byRequest = repo.reservationByRequestQuery(reqId, attId);
  const existing = firstRow(await exec(byRequest.sql, byRequest.params));
  if (existing) {
    return { ok: reservationReused(existing), reservation: existing, reused: true };
  }
  const buckets = await pgBuckets(exec, {
    category: cat,
    now,
    dailyLimitMinor: dayLimit,
    monthlyLimitMinor: monthLimit,
  });
  const overflow = firstOverflowBucket(buckets, ceiling);
  if (overflow) {
    await pgUsageLog(exec, {
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
  await pgBumpBuckets(exec, buckets, ceiling, 0);
  const insert = repo.insertReservationQuery({
    requestId: reqId,
    attemptId: attId,
    configId: args.configId ?? cfg?.id ?? null,
    priceVersion: args.priceVersion,
    ceilingMinor: ceiling,
    createdAt: iso(now),
  });
  const inserted = firstRow(await exec(insert.sql, insert.params));
  const reservation = await pgReservation(exec, inserted?.id);
  await pgUsageLog(exec, {
    now,
    category: cat,
    provider_code: cfg?.provider_code,
    reservation_id: reservation.id,
    event_kind: "reserved",
    amount_minor: ceiling,
    job_state: "reserved",
  });
  return { ok: true, reservation, request_id: reqId, attempt_id: attId, reserved_minor: ceiling };
}

async function pgSettleBudget(exec, reservationInput, usageMinor, { category, now = new Date() } = {}) {
  const reservation = await pgReservation(exec, reservationInput?.id || reservationInput);
  if (!reservation) throw httpError("reservation not found", 404);
  const decision = settleDecision(reservation);
  if (decision.kind === "reuse") return { ok: true, reservation, reused: true };
  if (decision.kind === "error") throw httpError(decision.message);
  const actual = settleAmount(reservation, usageMinor);
  const cat = category || await pgCategoryOf(exec, reservation.config_id);
  const buckets = await pgReservationBuckets(exec, reservation, cat, now);
  await pgBumpBuckets(exec, buckets, -Number(reservation.ceiling_minor), actual);
  await pgSetState(exec, reservation.id, "settled", iso(now));
  const next = await pgReservation(exec, reservation.id);
  await pgUsageLog(exec, {
    now,
    category: cat,
    reservation_id: reservation.id,
    event_kind: "settled",
    amount_minor: actual,
    job_state: "settled",
  });
  return { ok: true, reservation: next, settled_minor: actual };
}

async function pgReleaseBudget(exec, reservationInput, { category, now = new Date() } = {}) {
  const reservation = await pgReservation(exec, reservationInput?.id || reservationInput);
  if (!reservation) throw httpError("reservation not found", 404);
  const decision = releaseDecision(reservation);
  if (decision.kind === "reuse") return { ok: true, reservation, reused: true };
  if (decision.kind === "refuse") return { ok: false, reason: decision.reason, reservation };
  const cat = category || await pgCategoryOf(exec, reservation.config_id);
  const buckets = await pgReservationBuckets(exec, reservation, cat, now);
  await pgBumpBuckets(exec, buckets, -Number(reservation.ceiling_minor), 0);
  await pgSetState(exec, reservation.id, "released", iso(now));
  const next = await pgReservation(exec, reservation.id);
  await pgUsageLog(exec, {
    now,
    category: cat,
    reservation_id: reservation.id,
    event_kind: "released",
    amount_minor: 0,
    job_state: "released",
  });
  return { ok: true, reservation: next };
}

async function pgHoldBudget(exec, reservationInput, { category, now = new Date(), note = "timeout" } = {}) {
  const reservation = await pgReservation(exec, reservationInput?.id || reservationInput);
  if (!reservation) throw httpError("reservation not found", 404);
  const decision = holdDecision(reservation);
  if (decision.kind === "reuse") return { ok: true, reservation, reused: true };
  if (decision.kind === "refuse") return { ok: false, reason: decision.reason, reservation };
  await pgSetState(exec, reservation.id, "unknown");
  const next = await pgReservation(exec, reservation.id);
  const cat = category || await pgCategoryOf(exec, reservation.config_id);
  await pgUsageLog(exec, {
    now,
    category: cat,
    reservation_id: reservation.id,
    event_kind: "unknown",
    amount_minor: Number(reservation.ceiling_minor),
    job_state: "unknown",
    note,
  });
  return { ok: true, reservation: next };
}

// ---- 對外入口（簽名：(conn, …, options)，與其他 *Async 模組一致） --------------

// DB_DRIVER=postgres 時的 schema 準備：鏡射建表 ＋ 唯一索引 ＋ 序號對齊 ＋ 種子列。
export function ensureBudgetSchemaAsync(conn, options = {}) {
  const opts = withConn(options, conn);
  return withFallback(
    opts,
    async (exec) => {
      if (!opts.exec) {
        const pgDriver = opts.pgDriver || (await sharedPgDriver());
        await ensureBudgetStoreOnce(pgDriver, opts.sqliteHandle || conn);
      }
      const stamp = iso();
      const insert = repo.seedProviderConfigQuery();
      for (const row of providerConfigSeedRows()) {
        await exec(insert.sql, [row.category, row.code, row.ceiling, row.order, stamp, stamp]);
      }
      return { driver: "postgres", tables: repo.BUDGET_TABLES };
    },
    () => ensureBudgetSchemaSync(conn),
  );
}

export function getProviderConfigAsync(conn, category, options = {}) {
  const opts = withConn(options, conn);
  return withFallback(opts, (exec) => pgConfig(exec, category), () => getProviderConfigSync(conn, category));
}

export function loadEnabledProviderAsync(conn, category, options = {}) {
  const opts = withConn(options, conn);
  return withFallback(
    opts,
    async (exec) => {
      const row = await pgConfig(exec, category);
      if (!row || !row.is_enabled) return null;
      if (row.provider_code === "none") return null;
      return row;
    },
    () => loadEnabledProviderSync(conn, category),
  );
}

export function hasCredentialsAsync(conn, cfg, options = {}) {
  const opts = withConn(options, conn);
  if (!cfg) return Promise.resolve(false);
  if (cfg.provider_code === "stub_paid" || cfg.provider_code === "google_routes") return Promise.resolve(true);
  if (!cfg.credential_ref) return Promise.resolve(false);
  return withFallback(
    opts,
    async (exec) => {
      const q = repo.providerSecretRefQuery(cfg.credential_ref);
      return Boolean(firstRow(await exec(q.sql, q.params)));
    },
    () => hasCredentialsSync(conn, cfg),
  );
}

export function readCredentialAsync(conn, cfg, options = {}) {
  const opts = withConn(options, conn);
  if (!cfg?.credential_ref) return Promise.resolve("");
  return withFallback(
    opts,
    async (exec) => {
      const q = repo.providerSecretQuery(cfg.credential_ref);
      return decryptSecret(firstRow(await exec(q.sql, q.params)));
    },
    () => readCredentialSync(conn, cfg),
  );
}

export function publicProviderConfigAsync(conn, category, options = {}) {
  const opts = withConn(options, conn);
  return withFallback(
    opts,
    async (exec) => publicProviderConfigShape(await pgConfig(exec, category), category),
    () => publicProviderConfigSync(conn, category),
  );
}

export function listProviderAdminAsync(conn, { now = new Date() } = {}, options = {}) {
  const opts = withConn(options, conn);
  return withFallback(
    opts,
    async (exec) => {
      const day = taipeiYmd(now);
      const month = monthKey(day);
      const items = [];
      for (const meta of PROVIDER_CATEGORIES) {
        const cfg = await pgConfig(exec, meta.id);
        const pub = publicProviderConfigShape(cfg, meta.id);
        const dayQuery = repo.bucketQuery({ scopeKind: "category", scopeKey: meta.id, periodKind: "day", periodKey: day });
        const monthQuery = repo.bucketQuery({ scopeKind: "category", scopeKey: meta.id, periodKind: "month", periodKey: month });
        const dayBucket = firstRow(await exec(dayQuery.sql, dayQuery.params));
        const monthBucket = firstRow(await exec(monthQuery.sql, monthQuery.params));
        items.push(providerAdminItem(pub, dayBucket, monthBucket, { day, month }));
      }
      const logsQuery = repo.usageLogsQuery(50);
      const logs = ((await exec(logsQuery.sql, logsQuery.params)) || []).map(usageLogShape);
      return providerAdminPayload({
        items,
        logs,
        siteDailyMinor: await pgSettingNumber(exec, "budget_site_daily_minor", 0),
        siteMonthlyMinor: await pgSettingNumber(exec, "budget_site_monthly_minor", 0),
      });
    },
    () => listProviderAdminSync(conn, { now }),
  );
}

// saveProviderConfig 的 PG 版（驗證規則與同步版相同，只是全部 await）。
async function pgSaveProviderConfig(exec, input = {}, { now = new Date() } = {}) {
  const category = String(input.category || "").trim();
  const meta = categoryMeta(category);
  if (!meta) throw httpError("unknown category");
  const providerCode = String(input.provider_code || input.providerCode || "").trim() || "none";
  if (!meta.codes.includes(providerCode)) throw httpError("unsupported provider");
  const enabled = input.is_enabled === true || input.is_enabled === 1 || input.is_enabled === "1";
  const daily = twdToMinor(input.daily_budget_twd ?? input.dailyBudgetTwd ?? 0);
  const monthly = twdToMinor(input.monthly_budget_twd ?? input.monthlyBudgetTwd ?? 0);
  const ceiling = twdToMinor(input.ceiling_twd ?? input.ceilingTwd ?? (category === "distance_matrix" ? 0.2 : 1));
  const existing = await pgConfig(exec, category);
  let credentialRef = existing?.credential_ref || null;
  if (Object.prototype.hasOwnProperty.call(input, "credential") && String(input.credential || "").trim()) {
    const packed = encryptSecret(String(input.credential).trim());
    credentialRef = `cfg:${category}:${randomUUID()}`;
    const secret = repo.insertProviderSecretQuery({
      credentialRef,
      nonce: packed.nonce,
      ciphertext: packed.ciphertext,
      createdAt: iso(now),
    });
    await exec(secret.sql, secret.params);
  }
  if (input.clear_credential === true) credentialRef = null;
  const stamp = iso(now);
  if (existing) {
    const q = repo.updateProviderConfigQuery({
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
    await exec(q.sql, q.params);
  } else {
    const q = repo.insertProviderConfigQuery({ category, providerCode, enabled, credentialRef, daily, monthly, ceiling, stamp });
    await exec(q.sql, q.params);
  }
  if (input.site_daily_budget_twd != null) {
    const q = repo.upsertSettingQuery("budget_site_daily_minor", twdToMinor(input.site_daily_budget_twd));
    await exec(q.sql, q.params);
  }
  if (input.site_daily_budget_twd != null || input.site_monthly_budget_twd != null) {
    await pgSaveSiteBudget(exec, input);
  }
  return publicProviderConfigShape(await pgConfig(exec, category), category);
}

async function pgSaveSiteBudget(exec, input = {}) {
  if (input.site_daily_budget_twd != null) {
    const q = repo.upsertSettingQuery("budget_site_daily_minor", twdToMinor(input.site_daily_budget_twd));
    await exec(q.sql, q.params);
  }
  if (input.site_monthly_budget_twd != null) {
    const q = repo.upsertSettingQuery("budget_site_monthly_minor", twdToMinor(input.site_monthly_budget_twd));
    await exec(q.sql, q.params);
  }
  return {
    site_daily_budget_twd: minorToTwd(await pgSettingNumber(exec, "budget_site_daily_minor", 0)),
    site_monthly_budget_twd: minorToTwd(await pgSettingNumber(exec, "budget_site_monthly_minor", 0)),
  };
}

export function writeUsageLogAsync(conn, row, options = {}) {
  const opts = withConn(options, conn);
  return withFallbackTx(opts, (exec) => pgUsageLog(exec, row), () => writeUsageLogSync(conn, row));
}

export function reserveBudgetAsync(conn, args = {}, options = {}) {
  const opts = withConn(options, conn);
  return withFallbackTx(opts, (exec) => pgReserveBudget(exec, args), () => reserveBudgetSync(conn, args));
}

export function settleBudgetAsync(conn, reservationInput, usageMinor, args = {}, options = {}) {
  const opts = withConn(options, conn);
  return withFallbackTx(
    opts,
    (exec) => pgSettleBudget(exec, reservationInput, usageMinor, args),
    () => settleBudgetSync(conn, reservationInput, usageMinor, args),
  );
}

export function releaseBudgetAsync(conn, reservationInput, args = {}, options = {}) {
  const opts = withConn(options, conn);
  return withFallbackTx(
    opts,
    (exec) => pgReleaseBudget(exec, reservationInput, args),
    () => releaseBudgetSync(conn, reservationInput, args),
  );
}

export function holdBudgetAsync(conn, reservationInput, args = {}, options = {}) {
  const opts = withConn(options, conn);
  return withFallbackTx(
    opts,
    (exec) => pgHoldBudget(exec, reservationInput, args),
    () => holdBudgetSync(conn, reservationInput, args),
  );
}

export function saveProviderConfigAsync(conn, input = {}, { now = new Date() } = {}, options = {}) {
  const opts = withConn(options, conn);
  return withFallbackTx(
    opts,
    (exec) => pgSaveProviderConfig(exec, input, { now }),
    () => saveProviderConfigSync(conn, input, { now }),
  );
}

export function saveSiteBudgetAsync(conn, input = {}, options = {}) {
  const opts = withConn(options, conn);
  return withFallbackTx(
    opts,
    (exec) => pgSaveSiteBudget(exec, input),
    () => saveSiteBudgetSync(conn, input),
  );
}

// 暴露給測試／診斷：PG 路徑跑的 builder。
export function budgetAsyncContext() {
  return repo;
}