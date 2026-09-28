// 分享頁成長相關的 driver-aware 入口（PG 島嶼，2026-09-28，第四十四批）。
//
// 涵蓋的路由：`GET /api/public/wish-room/:id`（`sharePageExtrasFor()`）。
//
// 這一支幾乎沒有 SQL：`sharePageExtras()` 是**純函式**（吃 marketplace flags），
// 同步版的 `sharePageExtrasFor()` 只是「讀本機 flags 再交給它」。PG 版要做的只有
// 「先讓行程內快取跟上 PG 的 settings，再把同一支純函式跑一次」。
import { getWishConditionsAsync } from "./rentalCatalogAsync.js";
import { currentRentalMarketplaceFlags } from "./demand.js";
import { sharePageExtras } from "./rentalShareGrowth.js";

// `db.js sharePageExtrasFor()` 的 PG 版。
// `getWishConditionsAsync()` 在非 PG 模式會 delegate 給同步版，所以兩種模式都先呼叫它，
// 之後讀到的就是同一份行程內快取（同步版是 `getRentalMarketplaceFlags()` 讀本機 settings）。
export async function sharePageExtrasAsync(options = {}) {
  await getWishConditionsAsync(options);
  return sharePageExtras(currentRentalMarketplaceFlags());
}
