// 租屋通知「偏好設定／配對訂閱／取消訂閱」的 driver-aware 入口（PG 島嶼，2026-09-28，第四十三批）。
//
// 涵蓋的路由：
//   `GET  /api/rental-notify/prefs`                       → `getRentalNotifyPrefsForAsync`
//   `PUT  /api/rental-notify/prefs`                       → `saveRentalNotifyPrefsForAsync`
//   `GET  /api/self-listings/:id/match-subscription`      → `getMatchSubscriptionAsync`
//   `PUT  /api/self-listings/:id/match-subscription`      → `saveMatchSubscriptionAsync`
//   `POST /api/public/unsubscribe/:token`                 → `applyUnsubscribeTokenAsync`
//
// 這五條原本各差「一組吃 handle 的同步函式」，涉及的都是一個使用者的三張小表。
//
// 重用（不重寫）：
//   - `prefsFromRow()`／`mergeRentalNotifyPrefs()`／`prefsUpsertParams()`／`PREFS_UPSERT_SQL`
//   - `matchSubscriptionView()`／`SUBSCRIPTION_*_SQL`／`unsubscribePrefsPatch()`／`UNSUB_*_SQL`
//   - `listingOwnedBy()` 的語句（`LISTING_OWNER_SQL`）與它的兩個錯誤碼
//   - `currentRentalNotifyFlags()`／`publicRentalNotifyCaps()`／`withNotificationsForcedEnabledAsync()`
//   - `getRentalNotifyPrefsAsync()`（36.6 就搬好了）與 `bumpAnalyticsAsync()`（36.5）
//
// ⚠️ 四個一定要處理的耦合（每一個都對應一次實際踩到的坑）：
//
//   1. **行程內快取**：`db.js` 的 `*For` 包裝第一件事是 `hydrateRentalMarketplace()`，
//      它灌的是 `flagsCache`（`assertRentalNotificationsEnabled()` 讀它）與
//      `demand.js` 的 marketplace flags（`publicRentalNotifyCaps()` 讀它）。
//      PG 分支跳過就會出現「站上明明開了通知，PG 站卻回 404 rental_notify_disabled」。
//      所以每一支都先 `await getWishConditionsAsync(options)`。
//   2. **取消訂閱的閘門**：`applyUnsubscribeToken()` 會**暫時**把 `notifications_enabled`
//      設成 true（使用者按了取消連結就一定要生效）。同步版的 `finally` 在 async 用會提早還原，
//      所以要 `withNotificationsForcedEnabledAsync()`。
//   3. **兩個 store**：本機還有**同步**讀者（`planDeliveries()` 讀 prefs、worker 的摘要查詢
//      讀訂閱），所以 PG 寫完之後本機也要寫同一組值。反過來，本機的**投遞**與**worker**
//      路徑仍在 SQLite 上，這也是這一包不能只寫 PG 的原因。
//   4. **`rental_notify_prefs.user_id` 在 PG 上是 identity**（SQLite 的 `INTEGER PRIMARY KEY`
//      被鏡射成 identity），但它是使用者 id、永遠由呼叫端提供 ⇒ 明確寫入不會推進序列，
//      `pg-identity-sequences` 的健檢會永遠紅著。ensure 要多一句 `DROP IDENTITY`。
//
// ⚠️ `rental_match_subscriptions` 的 `UNIQUE(owner_user_id, listing_id)`（以及 `public_token`
//    UNIQUE）是 **SQLite 的表約束**：`ensurePgSchema()` 只鏡射 `sqlite_master` 裡有 `sql`
//    的索引，表約束抓不到（本系列已中過五次）。少了它們，PG 上「一則刊登一組訂閱」會失效
//    （同一刊登會出現多列，之後的 UPDATE 只會改到其中一列）。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import {
  LISTING_OWNER_SQL,
  PREFS_UPSERT_SQL,
  RENTAL_MATCH_MODES,
  SUBSCRIPTION_BY_OWNER_LISTING_SQL,
  SUBSCRIPTION_INSERT_SQL,
  SUBSCRIPTIONS_OFF_ALL_SQL,
  SUBSCRIPTIONS_OFF_DIGEST_SQL,
  SUBSCRIPTION_UPDATE_MODE_SQL,
  UNSUB_MARK_USED_SQL,
  UNSUB_TOKEN_SQL,
  assertRentalNotificationsEnabled,
  bumpAnalytics,
  matchSubscriptionView,
  mergeRentalNotifyPrefs,
  newToken,
  policyCheckError,
  prefsUpsertParams,
  publicRentalNotifyCaps,
  rentalNotifyHttpError,
  unsubscribePrefsPatch,
  withNotificationsForcedEnabledAsync,
} from "./rentalNotify.js";
import { currentRentalMarketplaceFlags } from "./demand.js";
import { getWishConditionsAsync } from "./rentalCatalogAsync.js";
import { getRentalNotifyPrefsAsync, prefsFromRow, PREFS_BY_USER_SQL } from "./rentalNotifyReadsAsync.js";
import { bumpAnalyticsAsync } from "./rentalAnalyticsAsync.js";

export const RENTAL_NOTIFY_PREFS_WRITE_TABLES = [
  "rental_notify_prefs",
  "rental_match_subscriptions",
  "rental_unsubscribe_tokens",
];
export const RENTAL_NOTIFY_PREFS_UNIQUE_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS rental_match_subscriptions_owner_listing_key ON rental_match_subscriptions(owner_user_id, listing_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS rental_match_subscriptions_token_key ON rental_match_subscriptions(public_token)",
];
// 本機那一列的收斂：PG 是來源，所以連 `public_token` 一起蓋（只在兩個 store 不一致時才會有差）。
export const SUBSCRIPTION_SYNC_LOCAL_SQL =
  "UPDATE rental_match_subscriptions SET mode = ?, updated_at = ?, public_token = ? WHERE id = ?";

// `user_id` 是使用者帶進來的 id，不該是 identity（理由見檔頭第 4 點）。
export const PREFS_DROP_IDENTITY_SQL =
  "ALTER TABLE rental_notify_prefs ALTER COLUMN user_id DROP IDENTITY IF EXISTS";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
const isoOf = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
const nested = (options, run) => ({ ...options, driver: "postgres", exec: run });
const nowOf = (options) => (options.now ? new Date(options.now) : new Date());

const schemaReady = new WeakMap();
export async function ensureRentalNotifyPrefsWriteOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = (async () => {
    await ensurePgSchema(pgDriver, sqliteHandle(), { tables: RENTAL_NOTIFY_PREFS_WRITE_TABLES });
    for (const sql of RENTAL_NOTIFY_PREFS_UNIQUE_INDEXES) await pgDriver.exec(sql);
    await pgDriver.exec(PREFS_DROP_IDENTITY_SQL);
  })();
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
    await ensureRentalNotifyPrefsWriteOnce(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

// `publicRentalNotifyCaps()` 吃的是**行程內**的 flags：PG 模式下由
// `getWishConditionsAsync()` 灌成 PG 的版本（同步版是 `getRentalMarketplaceFlags()` 讀本機）。
const withCaps = (prefs) => ({ ...prefs, ...publicRentalNotifyCaps(currentRentalMarketplaceFlags()) });

// `db.js getRentalNotifyPrefsFor()` 的 PG 版。
export async function getRentalNotifyPrefsForAsync(userId, options = {}) {
  await getWishConditionsAsync(options);
  const prefs = await getRentalNotifyPrefsAsync(userId, options);
  return withCaps(prefs);
}

// prefs 的寫入（PG）。**兩個 store 都寫**：本機的 `planDeliveries()` 還讀本機 prefs。
async function savePrefsPg(run, userId, patch, now, options) {
  assertRentalNotificationsEnabled();
  const uid = Number(userId) || 0;
  if (!uid) throw rentalNotifyHttpError("請先登入", 401, "auth_required");
  const current = prefsFromRow(one((await run(PREFS_BY_USER_SQL, [uid])).rows));
  const next = mergeRentalNotifyPrefs(current, patch);
  const params = prefsUpsertParams(uid, next, now);
  await run(PREFS_UPSERT_SQL, params);
  // 本機追上：同一組值（不是重算一次，避免兩邊因為起點不同而分歧）。
  sqliteHandle().prepare(PREFS_UPSERT_SQL).run(...params);
  // 計數也各記一次：`bumpAnalyticsAsync()` 的 PG 分支不會碰本機 handle，所以本機要用
  // **同步版**再記一次（同一個 `taipeiDay()` 與同一句 upsert，不自己重寫）。
  await bumpAnalyticsAsync("pref_updated", now, 1, nested(options, run));
  bumpAnalytics(sqliteHandle(), "pref_updated", now);
  return prefsFromRow(one((await run(PREFS_BY_USER_SQL, [uid])).rows));
}

// `db.js saveRentalNotifyPrefsFor()` 的 PG 版。
export async function saveRentalNotifyPrefsForAsync(userId, patch = {}, options = {}) {
  await getWishConditionsAsync(options);
  const now = nowOf(options);
  return withFallback(options, { write: true }, async (run) => {
    const prefs = await savePrefsPg(run, userId, patch, now, options);
    return withCaps(prefs);
  }, async () => (await import("./db.js")).saveRentalNotifyPrefsFor(userId, patch, now));
}

// 所有權檢查的 PG 版。錯誤形狀與 `listingOwnedBy()` 相同：
// 表不存在 ⇒ policy_check_failed / listings_unavailable；查詢失敗 ⇒ …/ listing_ownership_lookup_failed；
// 不是自己的（或不存在）⇒ 404 listing_not_found（由呼叫端丟）。
async function listingOwnedAsync(run, ownerUserId, listingId) {
  let row;
  try {
    row = one((await run(LISTING_OWNER_SQL, [Number(listingId) || 0])).rows);
  } catch (error) {
    // PG 的 undefined_table（42P01）對應同步版的「本機沒有 listings 這張表」。
    if (String(error?.code || "") === "42P01") throw policyCheckError("listings_unavailable", error);
    throw policyCheckError("listing_ownership_lookup_failed", error);
  }
  if (!row) return false;
  return Number(row.listed_by_user_id) === Number(ownerUserId);
}

// `db.js getMatchSubscriptionFor()` 的 PG 版。
export async function getMatchSubscriptionAsync(ownerUserId, listingId, options = {}) {
  await getWishConditionsAsync(options);
  const uid = Number(ownerUserId) || 0;
  const lid = Number(listingId) || 0;
  return withFallback(options, {}, async (run) => {
    const row = one((await run(SUBSCRIPTION_BY_OWNER_LISTING_SQL, [uid, lid])).rows);
    return matchSubscriptionView(row, lid);
  }, async () => (await import("./db.js")).getMatchSubscriptionFor(uid, lid));
}

// `db.js saveMatchSubscriptionFor()` 的 PG 版。
export async function saveMatchSubscriptionAsync(ownerUserId, listingId, mode, options = {}) {
  await getWishConditionsAsync(options);
  const now = nowOf(options);
  const uid = Number(ownerUserId) || 0;
  const lid = Number(listingId) || 0;
  return withFallback(options, { write: true }, async (run) => {
    assertRentalNotificationsEnabled();
    const next = RENTAL_MATCH_MODES.includes(mode) ? mode : "off";
    if (!uid || !lid) throw rentalNotifyHttpError("找不到這則刊登", 404, "listing_not_found");
    if (!(await listingOwnedAsync(run, uid, lid))) {
      throw rentalNotifyHttpError("找不到這則刊登", 404, "listing_not_found");
    }
    const stamp = isoOf(now);
    const local = sqliteHandle();
    const localRow = local.prepare(SUBSCRIPTION_BY_OWNER_LISTING_SQL).get(uid, lid);
    const existing = one((await run(SUBSCRIPTION_BY_OWNER_LISTING_SQL, [uid, lid])).rows);
    // token 的優先序：PG 已有的 → 本機已有的 → 新產生。
    // ⚠️ 先看本機是刻意的：PG 上還沒有這一列、但本機有時（島嶼搬遷前建立的訂閱），
    // 沿用本機的 token 才不會讓**已經寄出去**的連結失效；兩個 store 也才會一致。
    const token = existing?.public_token || localRow?.public_token || newToken();
    if (existing) {
      await run(SUBSCRIPTION_UPDATE_MODE_SQL, [next, stamp, existing.id]);
    } else {
      await run(SUBSCRIPTION_INSERT_SQL, [token, uid, lid, next, stamp, stamp]);
    }
    // 本機追上（worker 的摘要查詢讀本機）：同一組值、同一個 token。
    // PG 是來源，所以本機那一列連 `public_token` 一起收斂（只有本機有那一列時值相同、不會變動）。
    if (localRow) local.prepare(SUBSCRIPTION_SYNC_LOCAL_SQL).run(next, stamp, token, localRow.id);
    else local.prepare(SUBSCRIPTION_INSERT_SQL).run(token, uid, lid, next, stamp, stamp);
    return matchSubscriptionView(one((await run(SUBSCRIPTION_BY_OWNER_LISTING_SQL, [uid, lid])).rows), lid);
  }, async () => (await import("./db.js")).saveMatchSubscriptionFor(uid, lid, mode, now));
}

// `db.js applyUnsubscribeTokenFor()` 的 PG 版。
export async function applyUnsubscribeTokenAsync(token, options = {}) {
  await getWishConditionsAsync(options);
  const now = nowOf(options);
  return withFallback(options, { write: true }, async (run) => {
    const raw = String(token || "").trim();
    if (!raw || /^\d+$/.test(raw)) throw rentalNotifyHttpError("找不到取消連結", 404, "unsub_not_found");
    const row = one((await run(UNSUB_TOKEN_SQL, [raw])).rows);
    if (!row) throw rentalNotifyHttpError("找不到取消連結", 404, "unsub_not_found");
    if (row.used_at) return { ok: true, already: true };
    if (Date.parse(row.expires_at) <= now.getTime()) {
      throw rentalNotifyHttpError("取消連結已過期", 400, "unsub_expired");
    }
    const scope = String(row.scope || "all");
    const stamp = isoOf(now);
    // 閘門要**暫時**打開（理由見檔頭第 2 點）。
    await withNotificationsForcedEnabledAsync(async () => {
      if (scope === "new_match" || scope === "all") {
        await run(SUBSCRIPTIONS_OFF_ALL_SQL, [stamp, row.user_id]);
      } else if (scope === "digest") {
        await run(SUBSCRIPTIONS_OFF_DIGEST_SQL, [stamp, row.user_id]);
      }
      await savePrefsPg(run, row.user_id, unsubscribePrefsPatch(scope), now, options);
    });
    await run(UNSUB_MARK_USED_SQL, [stamp, raw]);
    // 本機追上：**只有本機也有這個 token 時**才動（信件可能是別的節點寄的；
    // 本機沒有那一列時硬寫會讓一個已經成功的 PG 請求變成 404——與 wish_room_example
    // 那個 FK 陷阱同一類）。
    const local = sqliteHandle();
    const localToken = local.prepare(UNSUB_TOKEN_SQL).get(raw);
    if (localToken && !localToken.used_at) {
      if (scope === "new_match" || scope === "all") {
        local.prepare(SUBSCRIPTIONS_OFF_ALL_SQL).run(stamp, localToken.user_id);
      } else if (scope === "digest") {
        local.prepare(SUBSCRIPTIONS_OFF_DIGEST_SQL).run(stamp, localToken.user_id);
      }
      local.prepare(UNSUB_MARK_USED_SQL).run(stamp, raw);
    }
    return { ok: true, already: false };
  }, async () => (await import("./db.js")).applyUnsubscribeTokenFor(token, now));
}
