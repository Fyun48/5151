// 同房源「會員確認／拆開」的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼放在獨立模組而不放 db.js：這個入口需要 `getListingAsync`（listingDetailAsync.js），
// 而 listingDetailAsync.js 本身會匯入 db.js——放在 db.js 會形成循環匯入。獨立模組最乾淨。
//
// 目前涵蓋範圍（誠實標註）：
//   - 非 postgres            → 現有同步路徑，行為完全不變
//   - postgres + **會員**    → PG（userSameHouseAsync 的 mergePersonalSameHouse）
//   - postgres + **管理員**  → 仍走 `confirmSameHouseAsAdmin()`，那一條**還沒移植**，
//                              仍是節點本機 SQLite。`/api/admin/same-house/confirm` 因此
//                              仍是 MIXED，不是完成。
import { resolveDbDriver } from "./dbDriver.js";
import {
  confirmSameHouseAsAdmin,
  mergeSameHouseForUser as mergeSameHouseForUserSync,
} from "./db.js";
import { normalizeMergeIds } from "./userSameHouse.js";
import {
  loadRawListingsAsync,
  mergePersonalSameHouse as mergePersonalSameHousePg,
} from "./userSameHouseAsync.js";
import { getListingAsync } from "./listingDetailAsync.js";

export async function mergeSameHouseForUserAsync(userId, postIds, { admin = false, ...options } = {}) {
  // 明確要求走某個 driver（測試用）時要尊重它，不要被環境變數蓋掉。
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return mergeSameHouseForUserSync(userId, postIds, { admin });
  }
  const ids = normalizeMergeIds(postIds);
  if (admin) return confirmSameHouseAsAdmin(userId, ids);

  const listings = await loadRawListingsAsync(ids, options);
  const result = await mergePersonalSameHousePg(userId, listings, options);
  if (!result.ok) return result;
  // 與同步版相同：成功後回傳裝飾過的 listing（失敗時不回）。
  return { ...result, listing: await getListingAsync(ids[0], userId, { ...options, driver: "postgres" }) };
}

// db.js confirmSuspectedMatch() 的 PG 分支：先取該筆的 peer，再走同一個 merge。
// 與同步版相同：找不到 listing 或沒有 peer 就回 null。
export async function confirmSuspectedMatchAsync(postId, userId, { admin = false, ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    const { confirmSuspectedMatch } = await import("./db.js");
    return confirmSuspectedMatch(postId, userId, { admin });
  }
  const rows = await loadRawListingsAsync([postId], options);
  const listing = rows[0];
  if (!listing) return null;
  const peerId = Number(listing.match_post_id) || 0;
  if (!peerId) return null;
  const result = await mergeSameHouseForUserAsync(userId, [postId, peerId], { admin, ...options });
  return result?.ok ? result : null;
}
