// 通勤快照（`/api/commute/snapshot`）的 driver-aware 入口（PG 島嶼，2026-09-29，第七十六批）。
//
// `db.js:listingCommutePatch(postId, userId, settings)` 是同步的 SQLite 讀取：列本身、可見性
// 關卡、觀看者旗標，再跑共用的裝飾器。PG 模式下列表已經是 PG 在服務，這一條卻還在讀**節點本機**：
//
//   - PG 才有的刊登（別的節點爬到的、匯入的）在這裡拿到 `null` ⇒ 地圖上的卡片**沒有通勤資訊**，
//     而且前端只會看到「這台節點沒有這筆」，不會有人知道是讀錯 store。
//   - 觀看者旗標（`overlayPersonal`）與個人同戶群組（`personalGroupAgrees`）也讀本機 ⇒
//     同一張卡片在兩台節點可能顯示不同的通勤／同戶狀態。
//
// 做法與 `listingDetailAsync.js` 完全一樣（可見性關卡 → 共用裝飾器），只差在：
//   - 一次讀**一批** id（快照最多 80 筆），裝飾資料（flags／personalIndex／splitPairs／prep／
//     routeCache／mrtCache／routeJobs）**預載一次**，不是一筆一次查詢；
//   - `sameHouse: false`（與同步版一致）：快照不需要同戶 peers ⇒ `peers: false` 連 2-hop 都不載；
//   - 欄位投影用 `db.js:commutePatchFields()`，兩個 driver 不可能漂移。
import { resolveDbDriver } from "./dbDriver.js";
import {
  commutePatchFields,
  decorateRowsWithProvider,
  listingCommutePatch,
  preloadDecorationProviderAsync,
} from "./db.js";
import { idPlaceholders } from "./repository/listings.js";
import { LISTING_SURFACE, listingVisibleOnSurface } from "./stage1FixtureIsolation.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { toPostgresSql } from "./sqlDialect.js";
import { defaultUserIdAsync } from "./usersAsync.js";

// 與 `repository/listings.js` 的 `hydrate()` 同一句 `SELECT *`（同一個佔位符規則）：
// repository 走 `pgDriver.query()`，吃不到注入的 exec，所以這裡用注入式執行器跑同一句。
export const listingsByIdsSql = (ids) => `SELECT * FROM listings WHERE post_id IN (${idPlaceholders(ids, "postgres")})`;

export async function listingCommutePatchesAsync(postIds, userId = null, options = {}) {
  const ids = (Array.isArray(postIds) ? postIds : [])
    .map((id) => Number(id) || 0)
    .filter((id) => id > 0);
  if (!ids.length) return [];
  const driver = options.driver || resolveDbDriver();
  const fallback = () => ids.map((id) => listingCommutePatch(id, userId, options.settings)).filter(Boolean);
  if (driver !== "postgres") return fallback();

  try {
    const uid = userId == null ? await defaultUserIdAsync(options) : Number(userId) || 0;
    // PG 版**必須**有 settings（`preloadDecorationProviderAsync` 會檢查）：沒有就往上丟，
    // 不要偷偷回退去讀本機設定（那樣暫停／通勤設定都會是別台節點的版本）。
    const settings = options.settings;
    if (!settings) throw new Error("PG 版通勤快照需要 settings（不得回退本機設定）");
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    // ⚠️ 裝飾資料的載入器（`preloadDecorationProviderAsync` → `repository/decorationData.js`）
    // 吃的是**純陣列**，而有些島嶼的注入式 exec 回 `{rows, rowCount}`（本專案兩種寫法都有）。
    // 這裡統一轉成陣列，呼叫端兩種形狀都能用——不然 `crawlSourcesFromRows(rows.find)` 會爆
    // 「rows.find is not a function」（live PG 測試抓到的）。
    const toArray = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));
    const nativeExec = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
    const source = options.exec || nativeExec;
    const exec = async (sql, params = []) => toArray(await source(sql, params));
    const rows = await exec(listingsByIdsSql(ids), ids);
    const byId = new Map(rows.map((row) => [Number(row.post_id), row]));
    const visible = ids
      .map((id) => byId.get(id))
      .filter((row) => row && listingVisibleOnSurface(row, { surface: LISTING_SURFACE.MAP, viewerId: uid }));
    if (!visible.length) return [];
    const provider = options.decorationProvider || (await preloadDecorationProviderAsync({
      exec,
      rows: visible,
      settings,
      userId: uid,
      matchVoteUserId: uid,
      sameHouse: false,
      peers: false,
    }));
    const decorated = decorateRowsWithProvider(visible, {
      settings,
      userId: uid,
      provider,
      sameHouse: false,
      matchVoteUserId: uid,
    });
    const patchById = new Map(decorated.map((row) => [Number(row.post_id), commutePatchFields(row, settings)]));
    // 順序照呼叫端給的 ids（同步版就是一筆一筆 map，前端靠這個順序對應卡片）。
    return ids.map((id) => patchById.get(id)).filter(Boolean);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return fallback();
  }
}

/** 單筆版本：語意與 `db.js:listingCommutePatch()` 相同，只是走 PG。 */
export async function listingCommutePatchAsync(postId, userId = null, options = {}) {
  const patches = await listingCommutePatchesAsync([postId], userId, options);
  return patches.length ? patches[0] : null;
}
