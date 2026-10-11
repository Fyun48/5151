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
//   3. **只有一個 store（2026-10-10 SQLite 退場 P5a 起）**：原本 PG 寫完之後還會把同一組值
//      鏡射進本機 SQLite（`planDeliveries()`／worker 摘要那時還讀本機）。那些鏡射在正式站
//      （`PG_NO_SQLITE_OPEN=1`）**必拋** `business SQLite is closed` ⇒ 會員按「儲存通知偏好」
//      或按取消訂閱連結都拿到 400。Owner 裁決：正式讀寫不回退節點 SQLite，鏡射整條刪除，
//      PG 是唯一來源。
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
// 🚫 `SUBSCRIPTION_SYNC_LOCAL_SQL`（本機那一列的收斂）已隨 SQLite 退場 P5a 刪除：
// PG 是唯一來源，不再有「本機鏡射」這一步。

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

// prefs 的寫入（PG）。SQLite 退場 P5a 起**只寫 PG**（原本的「本機追上」鏡射已刪）。
async function savePrefsPg(run, userId, patch, now, options) {
  assertRentalNotificationsEnabled();
  const uid = Number(userId) || 0;
  if (!uid) throw rentalNotifyHttpError("請先登入", 401, "auth_required");
  const current = prefsFromRow(one((await run(PREFS_BY_USER_SQL, [uid])).rows));
  const next = mergeRentalNotifyPrefs(current, patch);
  const params = prefsUpsertParams(uid, next, now);
  await run(PREFS_UPSERT_SQL, params);
  // 🚫 本機鏡射已刪（SQLite 退場 P5a）：`PG_NO_SQLITE_OPEN=1` 時這一句必拋
  // `business SQLite is closed` ⇒ 會員按「儲存通知偏好」收到 400（PG 其實已寫成功）。
  // 計數只記 PG：`bumpAnalyticsAsync()` 的 PG 分支本來就不碰本機 handle。
  await bumpAnalyticsAsync("pref_updated", now, 1, nested(options, run));
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
    const existing = one((await run(SUBSCRIPTION_BY_OWNER_LISTING_SQL, [uid, lid])).rows);
    // token 的優先序：PG 已有的 → 新產生。
    // 🚫 原本還會讀本機 `localRow.public_token`（島嶼搬遷前建立的訂閱）——SQLite 退場 P5a 已刪：
    // 開閘時那個 `local.prepare()` 必拋，而且 PG 是唯一來源（舊的本機 token 不該再影響新寫入）。
    const token = existing?.public_token || newToken();
    if (existing) {
      await run(SUBSCRIPTION_UPDATE_MODE_SQL, [next, stamp, existing.id]);
    } else {
      await run(SUBSCRIPTION_INSERT_SQL, [token, uid, lid, next, stamp, stamp]);
    }
    // 🚫 本機鏡射已刪（SQLite 退場 P5a）：原本還會把同一列（含 public_token）寫進本機
    // `rental_match_subscriptions`，開閘時那兩句都會拋。PG 是唯一來源。
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
    // 🚫 本機鏡射已刪（SQLite 退場 P5a）：這是**免登入的公開路由**（`POST /api/public/unsubscribe/:token`），
    // 開閘時原本那一段 `sqliteHandle()` 讀寫必拋 ⇒ 使用者按下取消訂閱拿到 400（PG 其實已生效）。
    return { ok: true, already: false };
  }, async () => (await import("./db.js")).applyUnsubscribeTokenFor(token, now));
}
