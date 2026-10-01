/**
 * `mrt_cache` 的來源／版本契約與 PG 欄位升級（R1，第二輪複審）。
 *
 * 為什麼要獨立一支：**讀取路徑也會用到新欄位**（`repository/decorationData.loadMrtCacheEntries()`
 * 會 SELECT `source`／`checked`／`walk_m`／`searched_m`），但升級原本只掛在寫入路徑
 * （`crawlerWrites.setCachedMrtAsync()`）。在「既有 PG 表、還沒寫過新快取」的情況下先讀，
 * 就會撞 `42703 column "source" does not exist`（審閱用舊 schema 重現過）。
 *
 * 所以升級要在**讀與寫之前**都保證：寫入路徑拿 `pgDriver`（`.exec` 逐句送），
 * 讀取路徑拿注入式 `exec`，用函式身分做 WeakMap 記憶（同一個 provider 的 exec 只升級一次）。
 */
export const MRT_CACHE_PG_COLUMNS = [
  "ALTER TABLE mrt_cache ADD COLUMN IF NOT EXISTS source TEXT",
  "ALTER TABLE mrt_cache ADD COLUMN IF NOT EXISTS checked BIGINT NOT NULL DEFAULT 0",
  "ALTER TABLE mrt_cache ADD COLUMN IF NOT EXISTS walk_m DOUBLE PRECISION",
  "ALTER TABLE mrt_cache ADD COLUMN IF NOT EXISTS searched_m DOUBLE PRECISION",
];

const byDriver = new WeakMap();
const byExec = new WeakMap();

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
 * 以 exec 的函式身分記憶 —— 同一個 provider 的 exec 在整個行程內只升級一次。
 */
export async function ensureMrtCacheContractForRead(exec) {
  if (typeof exec !== "function") return;
  if (byExec.has(exec)) return byExec.get(exec);
  const ready = (async () => {
    for (const sql of MRT_CACHE_PG_COLUMNS) await exec(sql, []);
  })();
  byExec.set(exec, ready);
  try {
    await ready;
  } catch (error) {
    byExec.delete(exec);
    throw error;
  }
}
