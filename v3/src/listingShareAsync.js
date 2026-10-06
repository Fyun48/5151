// 物件一鍵分享的 driver-aware 入口（PG 島嶼）。規則留在 `listingShare.js`
// （bot 偵測／去重／限流／URL／OG meta 都是同一份），這裡只負責「準備 exec 與 bump」。
//
// 對應同步版的函式：
//   - getListingShareFlagsAsync   ← getListingShareFlags
//   - createListingShareLinkAsync ← createListingShareLink
//   - recordListingShareEventAsync ← recordListingShareEvent（核心是 listingShare.recordListingShareEventAsync）
//   - listingShareStatsForUserAsync ← listingShareStatsForUser
//   - listingShareStatsForAdminAsync ← listingShareStatsForAdmin
//   - listingShareOverviewAsync ← listingShareOverview
import { randomBytes } from "node:crypto";
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import { bumpAnalyticsAsync } from "./rentalAnalyticsAsync.js";
import { getSiteSettingAsync } from "./settingsKvAsync.js";
import {
  LISTING_SHARE_FLAGS_KEY,
  LISTING_SHARE_TABLES,
  LISTING_PUBLIC_ROW_SQL,
  LISTING_SHARE_TOKEN_INSERT_SQL,
  LISTING_SHARE_DAILY_COUNT_SQL,
  LISTING_SHARE_TOTALS_SQL,
  LISTING_SHARE_DAILY_SQL,
  LISTING_SHARE_TOP_SQL,
  LISTING_SHARE_LINKS_COUNT_SQL,
  LISTING_SHARE_USER_TOKENS_SQL,
  LISTING_SHARE_TOKEN_EVENTS_SQL,
  createListingShareLink as createListingShareLinkSync,
  listingShareStatsForUser as listingShareStatsForUserSync,
  listingShareStatsForAdmin as listingShareStatsForAdminSync,
  listingShareOverview as listingShareOverviewSync,
  listingIsPublicRow,
  listingShareUrl,
  normalizeListingShareFlags,
  recordListingShareEventAsync as recordListingShareEventCore,
} from "./listingShare.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// PG 的 `pg` 回 `{ rows, rowCount }`，注入式替身可能只回陣列。統一成 `{ rows, rowCount }`。
function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

function isoOf(now) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

const schemaReady = new WeakMap();
async function ensureListingShareOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = (async () => ensurePgSchema(pgDriver, sqliteHandle(), { tables: LISTING_SHARE_TABLES }))();
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

async function withExec(options, run) {
  if (options.exec) {
    const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
    return run(injected);
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  await ensureListingShareOnce(pgDriver);
  const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
  return run(exec);
}

async function withFallback(options, { write = false }, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    return await withExec(options, runPostgres);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

export async function getListingShareFlagsAsync(options = {}) {
  const raw = await getSiteSettingAsync(LISTING_SHARE_FLAGS_KEY, options);
  return normalizeListingShareFlags(raw);
}

export async function createListingShareLinkAsync(input = {}, options = {}) {
  const listingId = Number(input.listingId) || 0;
  const actorId = Number(input.actorId) || 0;
  const now = input.now ?? new Date();
  const flags = normalizeListingShareFlags(await getListingShareFlagsAsync(options));
  if (!isPg(options)) {
    return createListingShareLinkSync(sqliteHandle(), { listingId, actorId, now, flags });
  }
  return withFallback(options, { write: true }, async (exec) => {
    if (!listingId || !actorId) return { ok: false, code: "listing_not_found" };
    const row = (await exec(LISTING_PUBLIC_ROW_SQL, [listingId])).rows[0] || null;
    if (!listingIsPublicRow(row, listingId)) return { ok: false, code: "listing_not_found" };
    const dailyLimit = flags.dailyLimit;
    const since = `${isoOf(now).slice(0, 10)}T00:00:00.000Z`;
    const cnt = (await exec(LISTING_SHARE_DAILY_COUNT_SQL, [actorId, since])).rows[0] || null;
    const dailyUsed = Number(cnt?.n) || 0;
    if (dailyUsed >= dailyLimit) return { ok: false, code: "daily_limit", dailyUsed, dailyLimit };
    const token = randomBytes(12).toString("base64url");
    await exec(LISTING_SHARE_TOKEN_INSERT_SQL, [listingId, actorId, token, isoOf(now)]);
    return { ok: true, shareToken: token, dailyUsed: dailyUsed + 1, dailyLimit };
  }, () => createListingShareLinkSync(sqliteHandle(), { listingId, actorId, now, flags }));
}

export async function recordListingShareEventAsync(input = {}, options = {}) {
  if (!isPg(options)) {
    const { recordListingShareEvent } = await import("./listingShare.js");
    return recordListingShareEvent(sqliteHandle(), input);
  }
  return withFallback(options, { write: true }, async (exec) => {
    const rowsExec = async (sql, params = []) => (await exec(sql, params)).rows;
    return recordListingShareEventCore(rowsExec, input, {
      bump: (metric, now) => bumpAnalyticsAsync(metric, now, 1, options),
    });
  }, async () => {
    const { recordListingShareEvent } = await import("./listingShare.js");
    return recordListingShareEvent(sqliteHandle(), input);
  });
}

export async function listingShareStatsForUserAsync(userId, opts = {}, options = {}) {
  const flags = normalizeListingShareFlags(await getListingShareFlagsAsync(options));
  const now = opts.now ?? new Date();
  const baseUrl = opts.baseUrl || "";
  const uid = Number(userId) || 0;
  if (!isPg(options)) {
    return listingShareStatsForUserSync(sqliteHandle(), uid, { now, baseUrl, flags });
  }
  return withFallback(options, { write: false }, async (exec) => {
    if (!uid) return { dailyLimit: flags.dailyLimit, dailyUsed: 0, totals: { views: 0, ctas: 0 }, items: [] };
    const since = `${isoOf(now).slice(0, 10)}T00:00:00.000Z`;
    const cnt = (await exec(LISTING_SHARE_DAILY_COUNT_SQL, [uid, since])).rows[0] || null;
    const dailyUsed = Number(cnt?.n) || 0;
    const tokens = (await exec(LISTING_SHARE_USER_TOKENS_SQL, [uid])).rows;
    const counts = new Map();
    let views = 0;
    let ctas = 0;
    for (const t of tokens) {
      let v = 0;
      let c = 0;
      const rows = (await exec(LISTING_SHARE_TOKEN_EVENTS_SQL, [t.share_token])).rows;
      for (const r of rows) {
        if (r.event_type === "view") v = Number(r.n) || 0;
        if (r.event_type === "cta") c = Number(r.n) || 0;
      }
      views += v;
      ctas += c;
      counts.set(t.share_token, { v, c });
    }
    const items = tokens.map((t) => ({
      shareToken: t.share_token,
      listingId: Number(t.listing_id) || 0,
      url: listingShareUrl(Number(t.listing_id), t.share_token, baseUrl),
      views: counts.get(t.share_token)?.v || 0,
      ctas: counts.get(t.share_token)?.c || 0,
      createdAt: t.created_at,
    }));
    return { dailyLimit: flags.dailyLimit, dailyUsed, totals: { views, ctas }, items };
  }, () => listingShareStatsForUserSync(sqliteHandle(), uid, { now, baseUrl, flags }));
}

export async function listingShareStatsForAdminAsync(days = 7, opts = {}, options = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const now = opts.now ?? new Date();
  const since = new Date((now instanceof Date ? now.getTime() : new Date(now).getTime()) - n * 86400000).toISOString();
  if (!isPg(options)) return listingShareStatsForAdminSync(sqliteHandle(), n, { now });
  return withFallback(options, { write: false }, async (exec) => {
    const totalsRow = (await exec(LISTING_SHARE_TOTALS_SQL, [since])).rows[0] || null;
    const totals = { views: Number(totalsRow?.views) || 0, ctas: Number(totalsRow?.ctas) || 0 };
    const daily = (await exec(LISTING_SHARE_DAILY_SQL, [since])).rows.map((r) => ({
      day: String(r.day),
      views: Number(r.views) || 0,
      ctas: Number(r.ctas) || 0,
    }));
    const top = (await exec(LISTING_SHARE_TOP_SQL, [since])).rows.map((r) => ({
      listingId: Number(r.listing_id) || 0,
      views: Number(r.views) || 0,
      ctas: Number(r.ctas) || 0,
    }));
    return { totals, daily, top };
  }, () => listingShareStatsForAdminSync(sqliteHandle(), n, { now }));
}

export async function listingShareOverviewAsync(days = 7, opts = {}, options = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const now = opts.now ?? new Date();
  const since = new Date((now instanceof Date ? now.getTime() : new Date(now).getTime()) - n * 86400000).toISOString();
  if (!isPg(options)) return listingShareOverviewSync(sqliteHandle(), n, { now });
  return withFallback(options, { write: false }, async (exec) => {
    const totalsRow = (await exec(LISTING_SHARE_TOTALS_SQL, [since])).rows[0] || null;
    const linkRow = (await exec(LISTING_SHARE_LINKS_COUNT_SQL, [since])).rows[0] || null;
    return {
      views7d: Number(totalsRow?.views) || 0,
      ctas7d: Number(totalsRow?.ctas) || 0,
      links7d: Number(linkRow?.n) || 0,
    };
  }, () => listingShareOverviewSync(sqliteHandle(), n, { now }));
}
