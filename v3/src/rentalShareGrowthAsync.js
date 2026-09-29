// 分享頁成長相關的 driver-aware 入口（PG 島嶼，2026-09-28，第四十四批）。
//
// 涵蓋的路由：`GET /api/public/wish-room/:id`（`sharePageExtrasFor()`）。
//
// 這一支幾乎沒有 SQL：`sharePageExtras()` 是**純函式**（吃 marketplace flags），
// 同步版的 `sharePageExtrasFor()` 只是「讀本機 flags 再交給它」。PG 版要做的只有
// 「先讓行程內快取跟上 PG 的 settings，再把同一支純函式跑一次」。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { getWishConditionsAsync } from "./rentalCatalogAsync.js";
import { currentRentalMarketplaceFlags } from "./demand.js";
import {
  recordShareEvent as recordShareEventSync,
  recordShareEventAsync as recordShareEventCore,
  sharePageExtras,
} from "./rentalShareGrowth.js";
import { bumpAnalyticsAsync } from "./rentalAnalyticsAsync.js";

// `db.js sharePageExtrasFor()` 的 PG 版。
// `getWishConditionsAsync()` 在非 PG 模式會 delegate 給同步版，所以兩種模式都先呼叫它，
// 之後讀到的就是同一份行程內快取（同步版是 `getRentalMarketplaceFlags()` 讀本機 settings）。
export async function sharePageExtrasAsync(options = {}) {
  await getWishConditionsAsync(options);
  return sharePageExtras(currentRentalMarketplaceFlags());
}

// ---- 分享事件的寫入（第五十三批）------------------------------------------------
//
// `GET /verify-email`（以及註冊、OAuth 註冊）會呼叫 `attributeShare()` 記一筆 `signup` 轉換。
// 同步版寫的是節點本機的 `rental_share_events` ＋ 本機的 analytics ⇒ PG 模式下
// 「分享帶來的註冊」永遠是 0，而且是**靜默的**（`attributeShare()` 的 catch 會把錯誤吞掉）。
//
// 規則全部留在 `rentalShareGrowth.recordShareEventAsync()`（它才拿得到私有的 helper 與政策），
// 這一支只負責「準備 exec 與 bumpAnalytics」。
const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

export async function recordShareEventAsync(input = {}, options = {}) {
  if (!isPg(options)) return recordShareEventSync(sqliteHandle(), input);
  const exec = options.exec
    ? async (sql, params = []) => rowsOf(await options.exec(sql, params))
    : async (sql, params = []) => (await (options.pgDriver || (await sharedPgDriver()))
      .query(toPostgresSql(sql), params)).rows;
  try {
    return await recordShareEventCore(exec, input, {
      bump: (metric, now) => bumpAnalyticsAsync(metric, now, 1, options),
    });
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return recordShareEventSync(sqliteHandle(), input);
  }
}
