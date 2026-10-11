/**
 * `mrt_cache` 的來源／版本契約與 PG 欄位升級（R1，第二輪複審）。
 *
 * 為什麼要獨立一支：**讀取路徑也會用到新欄位**（`repository/decorationData.loadMrtCacheEntries()`
 * 會 SELECT `source`／`checked`／`walk_m`／`searched_m`），但升級原本只掛在寫入路徑
 * （`crawlerWrites.setCachedMrtAsync()`）。在「既有 PG 表、還沒寫過新快取」的情況下先讀，
 * 就會撞 `42703 column "source" does not exist`（審閱用舊 schema 重現過）。
 *
 * 所以升級要在**讀與寫之前**都保證：寫入路徑拿 `pgDriver`（`.exec` 逐句送），
 * 讀取路徑拿注入式 `exec`。
 *
 * ⚠️ 讀取路徑的記憶**不能** keyed on `exec`：讀取路徑的 `exec` 是**每個請求新建的閉包**
 * （`listingDetailAsync.js` 每次 `(sql, params) => pgDriver.query(...)`），而 driver 才是行程內單例
 * （`pgSharedDriver.js`）。keyed on exec ⇒ memo 永不命中 ⇒ 每個詳情／通勤／清單請求都送 4 條
 * `ALTER TABLE mrt_cache ADD COLUMN IF NOT EXISTS`；那 4 欄在正式站早就存在（no-op），但每條都要
 * `ACCESS EXCLUSIVE` 鎖，與爬蟲／enrich 寫入互相排隊。所以改成與寫入路徑同一形狀：**keyed on
 * 呼叫端手上那個 driver 實例**；真的沒有 driver 身分（離線夾具直接注入假 exec）時退回
 * 「模組級單飛」——整個行程最多一輪，也絕不會變成「每個假 exec 一輪」。
 */
export const MRT_CACHE_PG_COLUMNS = [
  "ALTER TABLE mrt_cache ADD COLUMN IF NOT EXISTS source TEXT",
  "ALTER TABLE mrt_cache ADD COLUMN IF NOT EXISTS checked BIGINT NOT NULL DEFAULT 0",
  "ALTER TABLE mrt_cache ADD COLUMN IF NOT EXISTS walk_m DOUBLE PRECISION",
  "ALTER TABLE mrt_cache ADD COLUMN IF NOT EXISTS searched_m DOUBLE PRECISION",
];

const byDriver = new WeakMap();
// 讀取路徑的記憶：key 是「呼叫端手上那個 driver 實例」（production 就是 `sharedPgDriver()` 的
// 行程單例）。與寫入路徑的 byDriver 分開 —— 寫入路徑的形狀不動。
const byReadDriver = new WeakMap();
// 沒有任何 driver 身分可 key 時的退路（離線夾具只注入假 exec）：模組級單飛，
// 整個行程最多一輪。修前是「每個 exec 身分一輪」＝每個請求 4 條 ALTER。
let readOnceWithoutDriver = null;

const runMrtCacheColumns = (exec) => (async () => {
  for (const sql of MRT_CACHE_PG_COLUMNS) await exec(sql, []);
})();

/**
 * 用 `pgDriver.exec()` 升級（寫入路徑）。失敗不快取，下一次再試。
 */
export async function ensureMrtCacheContractOnce(pgDriver) {
  if (!pgDriver) return;
  if (byDriver.has(pgDriver)) return byDriver.get(pgDriver);
  const ready = (async () => {
    for (const sql of MRT_CACHE_PG_COLUMNS) await pgDriver.exec(sql);
  })();
  byDriver.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    byDriver.delete(pgDriver);
    throw error;
  }
}

/**
 * 用注入式 `exec` 升級（**讀取路徑**：裝飾資料的 provider 只有 exec，沒有 driver）。
 *
 * `pgDriver` 是**選填的身分**：有給就以它為 key（同一個 driver 在整個行程內只升級一次，
 * 即使每個請求都新建一個 exec 閉包）；driver 是行程內單例（`sharedPgDriver.js`）時
 * ⇒ 每行程一輪。多個 driver 實例（測試各自建 driver、或連不同庫）⇒ 每個實例一輪
 * —— 這是**正確**的：不同實例可能打不同 schema，不能互相代表。
 *
 * 沒給 driver 身分時（離線夾具注入假 exec，數量不固定）退回模組級單飛：
 * 整個行程最多一輪，因此「注入 N 個假 exec」不會變成 N 輪 ALTER。
 * 兩條分支都是「失敗不快取」：失敗時把記憶刪掉，下一次呼叫再試（交由後面的 SELECT 用 42703 明講）。
 */
export async function ensureMrtCacheContractForRead(exec, pgDriver = null) {
  if (typeof exec !== "function") return;
  const keyable = pgDriver !== null
    && (typeof pgDriver === "object" || typeof pgDriver === "function");
  if (keyable) {
    if (byReadDriver.has(pgDriver)) return byReadDriver.get(pgDriver);
    const ready = runMrtCacheColumns(exec);
    byReadDriver.set(pgDriver, ready);
    try {
      await ready;
    } catch (error) {
      byReadDriver.delete(pgDriver);
      throw error;
    }
    return;
  }
  if (!readOnceWithoutDriver) {
    const ready = runMrtCacheColumns(exec);
    readOnceWithoutDriver = ready;
    ready.catch(() => {
      if (readOnceWithoutDriver === ready) readOnceWithoutDriver = null;
    });
  }
  return readOnceWithoutDriver;
}
