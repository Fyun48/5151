// Driver-aware listing state WRITES for the crawler / worker loops (the read half is
// crawlerReads.js).
//
// The background loops now read their work from the same store the site reads, but their results
// still went through the synchronous SQLite helpers in db.js - so in DB_DRIVER=postgres mode a
// listing that went offline, a probe that found it alive again, or an invalidated route cache
// never reached PostgreSQL. This module gives those writes one async entry point; the SQLite
// driver delegates to the existing db.js functions, so production behaviour is unchanged.
import {
  invalidateListingLocation as invalidateListingLocationSync,
  markListingAlive as markListingAliveSync,
  markListingOffline as markListingOfflineSync,
  markSourceKitRetry as markSourceKitRetrySync,
  restoreListingOnline as restoreListingOnlineSync,
  setCachedMrt as setCachedMrtSync,
  setCommunityCache as setCommunityCacheSync,
  setListingDetail as setListingDetailSync,
  touchListingChecked as touchListingCheckedSync,
  confirmExpiredOfflineListings as confirmExpiredOfflineListingsSync,
  listingLocationUpdate,
  notifyReopenQuery,
  updateListingsGeoByAddress as updateListingsGeoByAddressSync,
  persistHpListingFields as persistHpListingFieldsSync,
  listingFieldsBuildContext,
} from "./db.js";
import * as crawlerProgressRepo from "./repository/crawlerProgress.js";
import { getListingAsync } from "./listingDetailAsync.js";
import { upsertListingPrepAsync as upsertListingPrepRepo } from "./listingEnrichQueue.js";
import {
  clearRouteJobs as clearRouteJobsRepo,
  markListingAlive as markListingAliveRepo,
  markListingOffline as markListingOfflineRepo,
  restoreListingOnline as restoreListingOnlineRepo,
  touchListingChecked as touchListingCheckedRepo,
} from "./repository/listingState.js";
import {
  persistHpListingFields as persistHpListingFieldsRepo,
  setCachedMrt as setCachedMrtRepo,
  setCommunityCache as setCommunityCacheRepo,
  setListingDetail as setListingDetailRepo,
} from "./repository/listingFields.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { enqueueListingEventAsync } from "./notifyEnqueueAsync.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { normalizeOfflineConfirmDays } from "./offline.js";
import { setCachedGeoAsync } from "./geoCacheAsync.js";

async function postgresExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

async function write(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    const exec = await postgresExec(options);
    return await runPostgres(exec);
  } catch (error) {
    /* 寫入 fail-closed：不落回本機 SQLite（見 sqliteFallback.js）。 */
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return runSqlite();
  }
}

export function markListingOfflineAsync(postId, options = {}) {
  return write(options, (exec) => markListingOfflineRepo(exec, postId), () => markListingOfflineSync(postId));
}

export function restoreListingOnlineAsync(postId, options = {}) {
  return write(options, (exec) => restoreListingOnlineRepo(exec, postId), () => restoreListingOnlineSync(postId));
}

export function markListingAliveAsync(postId, options = {}) {
  return write(
    options,
    (exec) => markListingAliveRepo(exec, postId, { wasOffline: options.wasOffline === true }),
    () => markListingAliveSync(postId),
  );
}

export function touchListingCheckedAsync(postId, options = {}) {
  return write(options, (exec) => touchListingCheckedRepo(exec, postId), () => touchListingCheckedSync(postId));
}

// db.js invalidateListingLocation(): the route_jobs rows plus (SQLite only) the in-process memo -
// the SQLite branch goes through the original function so the memo is cleared there too.
export function invalidateListingLocationAsync(postId, options = {}) {
  const id = Number(postId) || 0;
  return write(
    options,
    (exec) => clearRouteJobsRepo(exec, id),
    () => {
      invalidateListingLocationSync({ post_id: id }, { post_id: id });
      return { postId: id, cleared: true };
    },
  );
}

// db.js setListingDetail(): the 591 detail (fees, contact, coords, community, kit columns) the
// detail backfill loop applies. The PostgreSQL side reads the row it is about to patch from the
// same store (getListingAsync), so the "which field wins" decision sees what the site sees.
export async function setListingDetailAsync(postId, input = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return setListingDetailSync(postId, input);
  try {
    const exec = await postgresExec(options);
    const deps = options.deps || listingFieldsBuildContext();
    const listing = options.listing || await loadListingForWrite(postId, options);
    if (!listing) return null;
    const result = await setListingDetailRepo(exec, { deps, listing, input });
    // The fee change db.js enqueues inline on SQLite; PostgreSQL goes through the driver-aware
    // entry point so the event lands in the queue the site reads (POSTGRES_SWITCH_PLAN ③).
    if (result && result.feeChange) {
      const saved = await loadListingForWrite(postId, options);
      if (saved) {
        await enqueueListingEventAsync(saved, {
          type: "fee_update",
          detail: result.feeChange.detail,
          created_at: result.feeChange.created_at,
        }, options);
      }
    }
    return result;
  } catch (error) {
    if (options.strict) throw error;
    return setListingDetailSync(postId, input);
  }
}

// db.js persistHpListingFields(): the 5168 enrich worker's field patch.
export async function persistHpListingFieldsAsync(postId, next, options = {}) {
  const { locationChanged = false, previous = null, ...driverOptions } = options || {};
  const driver = driverOptions.driver || resolveDbDriver();
  if (driver !== "postgres") return persistHpListingFieldsSync(postId, next, { locationChanged, previous });
  try {
    const exec = await postgresExec(driverOptions);
    const deps = driverOptions.deps || listingFieldsBuildContext();
    const listing = driverOptions.listing || await loadListingForWrite(postId, driverOptions);
    if (!listing) return null;
    const result = await persistHpListingFieldsRepo(exec, { deps, listing, next, locationChanged });
    return { ...result, postId: Number(postId) || 0 };
  } catch (error) {
    if (driverOptions.strict) throw error;
    return persistHpListingFieldsSync(postId, next, { locationChanged, previous });
  }
}

// db.js setCachedMrt(): the MRT access cache (decoration reads it per row).
//
// R1：`mrt_cache` 的「來源／演算法版本／查證狀態／原始公尺」四欄 —— 升級與常數搬到
// `mrtCacheSchema.js`，讓**讀取路徑**（裝飾資料的 provider）也能在 SELECT 之前先升級。
// 這裡只負責在寫入前確保一次。
export { MRT_CACHE_PG_COLUMNS, ensureMrtCacheContractOnce } from "./mrtCacheSchema.js";

export function setCachedMrtAsync(lat, lng, access, options = {}) {
  return write(
    options,
    async (exec) => {
      if (!options.exec) {
        const { ensureMrtCacheContractOnce } = await import("./mrtCacheSchema.js");
        await ensureMrtCacheContractOnce(options.pgDriver || (await sharedPgDriver()));
      }
      return setCachedMrtRepo(exec, { deps: options.deps || listingFieldsBuildContext(), lat, lng, access });
    },
    () => setCachedMrtSync(lat, lng, access),
  );
}

// db.js setCommunityCache(): the community pin cache (the 591 geo scan reads it back).
export function setCommunityCacheAsync(community, options = {}) {
  return write(
    options,
    (exec) => setCommunityCacheRepo(exec, { deps: options.deps || listingFieldsBuildContext(), community }),
    () => setCommunityCacheSync(community),
  );
}

// listingEnrichQueue.upsertListingPrep(): the 5168 prep row the site's display_ready gate reads.
export function upsertListingPrepAsync(postId, listing, evalResult, options = {}) {
  return write(
    options,
    (exec) => upsertListingPrepRepo(exec, { postId, listing, evalResult }),
    () => null,
  );
}

// db.js markSourceKitRetry(): source-kit 抓取失敗後的重試排程。
// 原本只寫呼叫端那台節點的 SQLite，所以 A 排定的重試 B 看不到 → 同一筆房源在另一台被當成
// 從未重試而重複排、或永遠不重試。時間計算沿用 db.js 的 max(60s, delayMs)。
export function markSourceKitRetryAsync(postId, { error = "", delayMs = 15 * 60 * 1000 } = {}, options = {}) {
  const next = new Date(Date.now() + Math.max(60_000, Number(delayMs) || 0)).toISOString();
  return write(
    options,
    async (exec) => {
      await exec(crawlerProgressRepo.MARK_SOURCE_KIT_RETRY_SQL, [
        String(error || "").slice(0, 200),
        next,
        postId,
      ]);
      return true;
    },
    () => markSourceKitRetrySync(postId, { error, delayMs }),
  );
}

// db.js updateListingsGeoByAddress(): geo 回填 worker 的落點——依「去掉空白的地址」找出同一地址的
// listings 列，逐列把座標寫回去（`listingLocationUpdate()` 的「誰比較好」判斷是純函式，兩個 driver
// 共用）。原本只寫本機 SQLite ⇒ PG 模式下回填算出來的座標不會出現在站上讀的那一份。
export const LISTING_GEO_CANDIDATES_SQL = `SELECT post_id, address, lat, lng, geo_source, location_class, coord_version
       FROM listings
       WHERE replace(IFNULL(address, ''), ' ', '') = ?
          OR replace(IFNULL(address_norm, ''), ' ', '') = ?`;
export const LISTING_GEO_CANDIDATES_LEGACY_SQL = `SELECT post_id, address, lat, lng, geo_source
       FROM listings
       WHERE replace(IFNULL(address, ''), ' ', '') = ?`;

const isMissingRelation = (error) =>
  error?.code === "42703" || /no such column|has no column named|does not exist/i.test(String(error?.message || ""));

async function selectGeoRows(exec, key) {
  try {
    return await exec(LISTING_GEO_CANDIDATES_SQL, [key, key]);
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
    return exec(LISTING_GEO_CANDIDATES_LEGACY_SQL, [key]);
  }
}

export async function updateListingsGeoByAddressAsync(address, lat, lng, meta = {}, options = {}) {
  const key = String(address || "").replace(/\s+/g, "");
  // 與同步版同義：座標不是有限數、或位址去空白後是空的，就不落地（連快取都不寫）。
  if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return 0;
  // 快取先寫（走第六十四批的 geo_cache 島嶼；PG 模式寫 PG）。
  await setCachedGeoAsync(address, lat, lng, meta, options);
  const next = {
    lat,
    lng,
    geo_source: meta.geo_source || "geocode",
    location_class: meta.location_class,
    address_norm: meta.address_used || address,
    provider: meta.provider || "",
    geo_job_state: "done",
  };
  return write(options, async (exec) => {
    const rows = await selectGeoRows(exec, key);
    let updated = 0;
    for (const row of rows) {
      // 每一列的 coord_version 從**它自己**的現值往上加（與同步版逐列相同）。
      const update = listingLocationUpdate(row, { ...next, coord_version: (Number(row.coord_version) || 0) + 1 }, row.post_id);
      if (!update) continue;
      await exec(update.sql, update.params);
      const reopen = notifyReopenQuery(row.post_id, update.coordVersion);
      try {
        await exec(reopen.sql, reopen.params);
      } catch {
        /* 舊 fixture 沒有那張表（同步版也是 try/catch） */
      }
      updated += 1;
    }
    return updated;
  }, () => updateListingsGeoByAddressSync(address, lat, lng, meta));
}

// db.js confirmExpiredOfflineListings(): 「已下線但還沒被確認」的房源在 N 天後自動確認為下線。
// 這一支是**站上讀取路徑**會順手跑的掃描（`/api/listings`、`/api/state`），原本只寫本機 SQLite
// ⇒ PG 模式下那個 UPDATE 永遠不會落到站上讀的那一份（清單上的「已確認下線」永遠不翻）。
//
// ⚠️ 回傳值要是「改了幾個列」：PG 的 `query()` 對沒有 RETURNING 的 UPDATE 只回空陣列，
// 所以語句尾端接 `RETURNING 1` 再數列數（SQLite 也支援 RETURNING，兩邊同一句文字）。
// 節流與同步版同義（每個節點每 60 秒最多掃一次；`options.now` 是測試用的時間縫）。
// ⚠️ 語句文字**逐字沿用** `db.js:5098-5105`（含 SQLite 的 `IFNULL`）——真 PG 路徑由
// `postgresExec()` 的 `toPostgresSql()` 轉成 `COALESCE`；改成 COALESCE 反而會讓「同一句」有兩份。
export const EXPIRED_OFFLINE_SQL = `UPDATE listings
       SET offline_confirmed = 1,
           last_event = 'offline',
           last_checked_at = ?
       WHERE IFNULL(offline, 0) = 1
         AND IFNULL(offline_confirmed, 0) = 0
         AND COALESCE(NULLIF(offline_at, ''), last_checked_at, last_seen_at) != ''
         AND COALESCE(NULLIF(offline_at, ''), last_checked_at, last_seen_at) <= ?`;
export const EXPIRED_OFFLINE_SWEEP_MS = 60_000;
let lastExpiredOfflineSweepAt = 0;
export function resetExpiredOfflineSweepForTests() {
  lastExpiredOfflineSweepAt = 0;
}

export async function confirmExpiredOfflineAsync({ days = 7, now = Date.now() } = {}, options = {}) {
  const at = Number(now) || Date.now();
  if (at - lastExpiredOfflineSweepAt < EXPIRED_OFFLINE_SWEEP_MS) return 0;
  lastExpiredOfflineSweepAt = at;
  const n = normalizeOfflineConfirmDays(days);
  const cutoff = new Date(at - n * 86_400_000).toISOString();
  const stamp = new Date(at).toISOString();
  return write(
    options,
    async (exec) => (await exec(`${EXPIRED_OFFLINE_SQL} RETURNING 1`, [stamp, cutoff])).length,
    () => confirmExpiredOfflineListingsSync(days),
  );
}

// The row the field planners patch, read through the driver-aware detail loader (same decorated
// shape getListing() gives the SQLite functions). `sameHouse: false` is the crawler seam's read
// (watcher's listingForWatch), and the planners only look at the row's own columns anyway.
async function loadListingForWrite(postId, options = {}) {
  return getListingAsync(postId, undefined, {
    driver: "postgres",
    pgDriver: options.pgDriver,
    sameHouse: false,
    strict: options.strict === true,
  });
}

