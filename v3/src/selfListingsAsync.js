// 站內刊登（self listing）讀取的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼挑這個：把缺口路由分成「卡點全在 handler 內／部分／全在深模組」三類之後，
// `getSelfListing()` 是「唯一卡點」名單裡最大的單一函式（3 條路由），而且它同時是
// 另外 6 條 self-listings／listing-imports 路由的卡點之一——投報率比表面上高。
//
// 它需要的東西很少，而且**大部分是純函式，直接重用不必複製**：
//   - `expireOpenSelfListings()` → 需要 PG 版（一句 UPDATE）
//   - `getSelfRow()`            → 需要 PG 版（一句 SELECT）
//   - `decorateSelfListing()`   → **純函式**，已在 selfListings.js 匯出
//   - `listingVisibleOnSurface()`／`LISTING_SURFACE` → **純函式**，在 stage1FixtureIsolation.js
//   - `httpError()`             → 錯誤工廠，為此把 selfListings.js 的區域版本加上 `export`
//                                 （只加 export，行為不變），確保兩邊丟出的 Error 形狀一致
//
// ⚠️ 方言：同步版的 UPDATE 用 `IFNULL(self_expires_at, '')`，**PG 不接受 IFNULL**，
// 而 `pgExec()` 在注入 `exec` 時不經過 `toPostgresSql`，所以這裡一律寫 `COALESCE`
// （兩邊都合法、轉譯器也不會再改它）。這與 reject-match 那批踩到的是同一個坑。
import { resolveDbDriver } from "./dbDriver.js";
// SQLite 分支需要 handle：`selfListings.js` 的函式吃 `(db, ...)` 參數，
// 與 `listingGroupsAsync.js`／`supportAsync.js` 用同一個既有模式。
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { LISTING_SURFACE, listingVisibleOnSurface } from "./stage1FixtureIsolation.js";
import {
  decorateSelfListing,
  getListingOfferHook,
  expireOpenSelfListings as expireOpenSelfListingsSync,
  getSelfListing as getSelfListingSync,
  getSelfRow as getSelfRowSync,
  httpError,
} from "./selfListings.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// 逐字對應 selfListings.js:349 的 UPDATE，只把 IFNULL 換成 COALESCE（見檔頭說明）。
export const EXPIRE_SELF_LISTINGS_SQL = `UPDATE listings
   SET self_status = 'expired'
   WHERE source = 'self'
     AND COALESCE(self_status, 'open') = 'open'
     AND COALESCE(self_expires_at, '') != ''
     AND self_expires_at <= ?`;

// selfListings.js:632 的 SELECT（同步版本來就用 COALESCE，所以逐字相同）。
export const SELF_ROW_SQL =
  "SELECT * FROM listings WHERE post_id = ? AND COALESCE(source, '591') = 'self'";

// 回傳受影響的列數；同步版把任何錯誤吞掉回 0，這裡照抄（過期清理失敗不該擋住讀取）。
export async function expireOpenSelfListingsAsync(exec, now = new Date()) {
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  try {
    const rows = await exec(EXPIRE_SELF_LISTINGS_SQL, [stamp]);
    // 注意：注入式 exec 的 UPDATE 回空陣列、PG 也不回資料列，所以這裡拿不到「改了幾列」。
    // 同步版回 `changes`，但**唯一的呼叫端 `getSelfListing()` 不使用它**，
    // 所以兩邊的行為仍然一致；需要精確列數時要另寫一句 SELECT。
    return Number(rows?.changes ?? 0) || 0;
  } catch {
    return 0;
  }
}

export async function getSelfRowAsync(postId, options = {}) {
  if (!isPg(options)) return getSelfRowSync(sqliteHandle(), postId);
  const exec = await pgExec(options);
  const rows = await exec(SELF_ROW_SQL, [Number(postId) || 0]);
  return rows[0] || undefined;
}

// selfListings.js:649 `getSelfListing()` 的 PG 分支。步驟逐條對應：
//   過期清理 → 取列（沒有就 404）→ 可見性（不可見也 404）→ 已關閉且不是本人（404）→ 裝飾
// `now` 只有測試會傳；不傳時與同步版一樣用 `new Date()`。
export async function getSelfListingAsync(postId, { viewerId = 0, now = new Date(), ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return getSelfListingSync(sqliteHandle(), postId, { viewerId });
  }
  const exec = await pgExec(options);
  await expireOpenSelfListingsAsync(exec, now);
  const row = await getSelfRowAsync(postId, { ...options, exec });
  if (!row) throw httpError("找不到這則站內刊登", 404);
  const mine = Number(row.listed_by_user_id) === Number(viewerId);
  const surface = mine ? LISTING_SURFACE.OWNER_SELF : LISTING_SURFACE.PUBLIC_DETAIL;
  if (!listingVisibleOnSurface(row, { surface, viewerId })) {
    throw httpError("找不到這則站內刊登", 404);
  }
  const status = String(row.self_status || "open");
  if (status !== "open" && !mine) throw httpError("這則刊登已關閉或隱藏", 404);
  return decorateSelfListing(row, { viewerId });
}

// ---- 關閉自己的站內刊登 ----
//
// 對應 `selfListings.js:1219 closeSelfListing()`。步驟逐條照抄：
//   取列（沒有 → 404）→ 擁有權（非本人且非 admin → 403）→ UPDATE → 通知 hook → 回傳裝飾後的列
//
// ⚠️ `listingOfferHook`（由 `wishOffers.js` 註冊的 `handleWishOfferLifecycle`）**仍用本機
// SQLite handle 呼叫**：那個 hook 做的是「許願出價的清掃」，而 `wishOffers.js` 還沒移植
// （它的函式全都吃 handle）。用 PG 的 exec 呼叫它會直接壞掉；維持原樣是本批唯一的選擇，
// 而且同步版也是 try/catch 包住（清掃失敗不得擋住關閉）。等 wishOffers 移植時再一起改。
export const CLOSE_SELF_LISTING_SQL =
  "UPDATE listings SET self_status = 'closed', last_event = 'offline', last_seen_at = ? WHERE post_id = ?"; // selfListings.js:1226
export const HIDE_SELF_LISTING_SQL =
  "UPDATE listings SET self_status = 'hidden', hidden = 1, hidden_at = ? WHERE post_id = ?"; // selfListings.js:1236

export async function closeSelfListingAsync(userId, postId, { admin = false, now = new Date(), ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    const { closeSelfListing } = await import("./db.js");
    return closeSelfListing(userId, postId, { admin });
  }
  const exec = await pgExec(options);
  const row = await getSelfRowAsync(postId, { ...options, exec });
  if (!row) throw httpError("找不到這則站內刊登", 404);
  if (!admin && Number(row.listed_by_user_id) !== Number(userId)) {
    throw httpError("只能關閉自己的刊登", 403);
  }
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  await exec(CLOSE_SELF_LISTING_SQL, [stamp, row.post_id]);
  try { getListingOfferHook()?.(sqliteHandle(), { listingId: row.post_id, now }); } catch { /* 清掃失敗不得擋住關閉 */ }
  return getSelfListingAsync(row.post_id, { viewerId: userId, ...options, exec });
}
