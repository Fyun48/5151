// 需求統計（`/api/demand/aggregate`）與首頁需求曝險（`/api/demand/exposure`）的 driver-aware 入口
// （PG 島嶼，2026-09-29，第七十九批）。
//
// 這兩條是**純讀取**，但同步版整條讀的是節點本機的 `demand_posts`／`rental_match_*`：
//
//   - PG 模式下許願房已經寫在 PG（第六十五批起），統計卻從本機讀 ⇒ 訪客看到的「需求熱區」是
//     **這台節點**的樣本（別的節點收到的心願完全不算），而且樣本數不足時還會誤判成
//     「需求樣本不足」。
//   - `expireOpenPosts()` 也一併在本機跑（PG 的過期由 `expireOpenPostsAsync()` 負責）。
//
// 做法與其他島嶼相同：目錄／開關先用 `getWishConditionsAsync()` 補水（PG 的租賃目錄與
// marketplace flags 會灌進 `rentalMatchQuery` 的模組狀態），再用同一組純函式
// （`normalizeAggregateFilters()`／`assertAggregateConditions()`／`wishMatchesAggregateFilters()`／
// `aggregateDemandRows()`／`homepageExposureFromAggregate()`）跑同一份彙總，
// 只有「誰去撈列」換成 PG。掃描本身是**分塊**的（`aggregateSql()` ＋ `AGGREGATE_SCAN_CHUNK`），
// 與同步版同一句 SQL。
import { resolveDbDriver } from "./dbDriver.js";
import {
  demandMatchDistrictIndexCountAsync,
  expireOpenPostsAsync,
  rebuildDemandMatchDistrictsAsync,
} from "./demandAsync.js";
import { getWishConditionsAsync } from "./rentalCatalogAsync.js";
import { AGGREGATE_SCAN_CHUNK, normalizeAggregateFilters } from "./rentalMatch.js";
import {
  aggregateDemand as aggregateDemandSync,
  aggregateDemandRows,
  aggregateSql,
  assertAggregateConditions,
  assertMatchingEnabled,
  currentMatchCatalog,
  currentMatchFlags,
  homepageDemandExposure as homepageDemandExposureSync,
  homepageExposureFromAggregate,
  wishMatchesAggregateFilters,
} from "./rentalMatchQuery.js";
import { isWishOwnerMatchingEnabled } from "./rentalMarketplaceFlags.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { sqliteHandle } from "./db.js";
import { toPostgresSql } from "./sqlDialect.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const nowOf = (options) => (options.now ? new Date(options.now) : new Date());
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

// runner 一律回 `{ rows }`（`expireOpenPostsAsync()` 與分塊掃描都吃這個形狀）。
async function pgRunner(options = {}) {
  if (options.exec) {
    const injected = options.exec;
    return async (sql, params = []) => {
      const raw = await injected(sql, params);
      return Array.isArray(raw) ? { rows: raw } : raw;
    };
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params);
}

// 同步版的 `queryAllAggregateWishes()`，只是把 handle 換成 runner（同一句 SQL、同一個分塊大小）。
async function queryAllAggregateWishesAsync(run, filters) {
  const rows = [];
  let afterId = 0;
  for (;;) {
    const { sql, params } = aggregateSql(filters, { afterId, limit: AGGREGATE_SCAN_CHUNK });
    const chunk = rowsOf(await run(sql, params));
    if (!chunk.length) break;
    rows.push(...chunk);
    afterId = Number(chunk[chunk.length - 1].id) || afterId;
    if (chunk.length < AGGREGATE_SCAN_CHUNK) break;
  }
  return rows;
}

/** `rentalMatchQuery.js:aggregateDemand()` 的 PG 版。 */
export async function aggregateDemandAsync(rawFilters = {}, options = {}) {
  const now = nowOf(options);
  if (!isPg(options)) return aggregateDemandSync(sqliteHandle(), rawFilters, now);
  try {
    // 目錄／開關的快取必須先補水（PG 的版本），否則條件清單與「屋主配對是否開放」都會判錯。
    await getWishConditionsAsync(options);
    assertMatchingEnabled();
    const run = await pgRunner(options);
    await expireOpenPostsAsync(run, now);
    const filters = normalizeAggregateFilters(rawFilters);
    // 行政區篩選靠 `demand_match_districts`：索引表**空的時候**要重建（與同步版
    // `ensureRentalMatchIndexes()` 的懶重建同一條規則）。沒有這一步，PG 模式下
    // 「帶行政區的需求統計」會回 0 筆（第七十九批的 live PG 測試抓到）。
    if (filters.districts.length && (await demandMatchDistrictIndexCountAsync(run)) === 0) {
      await rebuildDemandMatchDistrictsAsync(run);
    }
    const catalog = currentMatchCatalog();
    assertAggregateConditions(filters, catalog);
    const rows = (await queryAllAggregateWishesAsync(run, filters)).filter((row) => (
      wishMatchesAggregateFilters(row, filters, catalog)
    ));
    return aggregateDemandRows(rows, { catalog });
  } catch (error) {
    // 業務錯誤（404 未開放／400 條件不可用）直接往上丟，不要假裝回退同步版再丟一次。
    if (error?.status) throw error;
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return aggregateDemandSync(sqliteHandle(), rawFilters, now);
  }
}

/** `rentalMatchQuery.js:homepageDemandExposure()` 的 PG 版。 */
export async function homepageDemandExposureAsync(options = {}) {
  const now = nowOf(options);
  if (!isPg(options)) return homepageDemandExposureSync(sqliteHandle(), now);
  try {
    await getWishConditionsAsync(options);
    if (!isWishOwnerMatchingEnabled(currentMatchFlags())) return { enabled: false, districts: [] };
    const agg = await aggregateDemandAsync({}, { ...options, now });
    return homepageExposureFromAggregate(agg);
  } catch (error) {
    if (error?.status) throw error;
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return homepageDemandExposureSync(sqliteHandle(), now);
  }
}

// 供測試／診斷：PG 版的候選列（與同步版的 `queryAllAggregateWishes()` 同一句 SQL）。
export async function aggregateWishRowsAsync(rawFilters = {}, options = {}) {
  const run = await pgRunner(options);
  return queryAllAggregateWishesAsync(run, normalizeAggregateFilters(rawFilters));
}
