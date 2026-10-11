// 行政區「投影預篩」：用 `listing_search_projection.district`（`idx_proj_district`）先取
// 候選 post_id 集合，取代 `split_part(source_key…)` 那個**無法建索引**的行政區子句。
//
// 為什麼可以這樣做（語意論證，逐條對應裁決 §4.1 P1）：
//   1. `listings` **沒有 `district` 欄**，現行子句只能對 `source_key` 做 `split_part` ⇒ seq scan。
//      `listing_search_projection.district` 是 `districtNameFromListing(row)` 的投影
//      （`listingSearchProjection.js:96`），該函式正是**會員列表判定鏈最後一道行政區過濾**
//      （`db.js` `districtSet.has(row.district || districtNameFromListing(row))`）用的同一個函式。
//   2. 所以投影集合 ⊇「Node 判定鏈最後會留下的行政區列」；預篩**只是多餘的前置縮窄**，
//      不取代任何現有判定 —— 判定鏈照舊逐列跑一次。
//   3. **投影滯後／過期必須退回完整掃描**：見 `districtProjectionVerified()` 的兩項證明
//      （缺列 ＋ 前綴與投影不一致），任一非 0 就回 `null`，呼叫端沿用原本的 `split_part` 子句
//      ⇒ **絕不靜默少算**。證明值依 `data_revision|districts` 版本快取。
//   4. 可用 `MEMBER_DISTRICT_PREFILTER=0` 完全關閉（等價測試的 A/B 開關）。
import {
  districtKeyLists, districtKeyPrefixExpression,
} from "./listDistrictSql.js";

const TABLE = "listing_search_projection";

/** 關閉開關（A/B 等價證據用）；預設開啟。 */
export function districtPrefilterEnabled() {
  const raw = process.env.MEMBER_DISTRICT_PREFILTER;
  if (raw == null || raw === "") return true;
  return !["0", "false", "off", "no"].includes(String(raw).trim().toLowerCase());
}

// 驗證結果的版本化快取。key = `<revision>|<districts>`；revision 改變或行政區組合不同就重驗。
// 用有上限的 `Map`，避免 district 組合無上限成長。
const GUARD_CACHE_LIMIT = 64;
const guardCache = new Map();

/** 測試／寫入端主動失效用（同 `resetPgProductCountCache` 的形狀）。 */
export function resetDistrictProjectionCompletenessCache() {
  guardCache.clear();
  idsCache.clear();
}

async function currentRevision(runOne) {
  try {
    const hasTable = await runOne("SELECT to_regclass('data_revision') IS NOT NULL AS has_table");
    if (!hasTable?.has_table) return null;
    const row = await runOne("SELECT MAX(id) AS n FROM data_revision");
    if (row?.n == null) return null;
    const revision = Number(row.n);
    return Number.isFinite(revision) ? revision : null;
  } catch {
    return null;
  }
}

function defaultRunOne(exec) {
  return async (sql, params = []) => {
    const rows = await exec(sql, params);
    return Array.isArray(rows) ? rows[0] ?? null : rows ?? null;
  };
}

/**
 * 投影「可用」的兩項證明（**一次往返**，兩項都必須為 0）：
 *   `missing`    —— 有 listings 列卻沒有投影列 ⇒ 投影滯後（缺列）。
 *   `mismatched` —— `source_key` 前綴屬於本次要篩的行政區、但投影 `district` 不在本次清單內
 *                   ⇒ 兩套推導不一致（＝投影內容過期，例如 refresh 失敗）。
 *
 * 任一非 0 就不能用預篩（回 `false`）：否則可能把 Node 判定鏈會留下的列事先濾掉，
 * 也就是**靜默少算**。這正是裁決 §4.1 P1「投影滯後必須退回完整掃描」的要求。
 *
 * repro 實測（184,245 列、7 個行政區）：`missing=0`、`mismatched=0`
 * （前綴相符 15,379 ＝ 投影相符 15,379），兩項同一次往返約 70–120ms，之後依版本快取。
 */
export async function districtProjectionVerified(exec, { districtNames = [], allowedKeys = null, runOne = null, revision = undefined } = {}) {
  const one = runOne || defaultRunOne(exec);
  const names = [...new Set((districtNames || []).filter(Boolean))];
  const keys = Array.isArray(allowedKeys) ? allowedKeys : [];
  if (!names.length || !keys.length) return false;
  const rev = revision === undefined ? await currentRevision(one) : revision;
  const cacheKey = `${rev == null ? "norev" : rev}|${names.join(",")}`;
  if (rev != null && guardCache.has(cacheKey)) return guardCache.get(cacheKey);

  let ok = false;
  try {
    // ⚠️ 先確認**兩個表都在**才發查詢。
    // 為什麼非做不可：`listing-search-parity.test.js` 會把 `listings` 改名來模擬缺 schema；
    // 若這一支在缺表時仍然送出 `FROM listings`，PG 會回 42P01 並讓**整個快照交易進入 aborted**，
    // 後續真正的候選查詢就變成 25P02（current transaction is aborted），呼叫端再也拿不到
    // 期待的 42P01 ⇒ 測試紅、而且真實環境的錯誤碼也會失真。
    const hasTables = await one(
      `SELECT to_regclass('listings') IS NOT NULL AND to_regclass('${TABLE}') IS NOT NULL AS ok`,
    );
    if (hasTables?.ok) {
      const prefix = districtKeyPrefixExpression("pg");
      const placeholders = (n, offset) => Array.from({ length: n }, (_, i) => `$${i + offset}`).join(",");
      const row = await one(
        // 兩個證明用**同一次 listings 掃描**（LEFT JOIN 投影）取得：分開寫會掃兩次，
        // repro 冷啟動實測多付約 80ms。
        `SELECT
           COUNT(*) FILTER (WHERE p.post_id IS NULL) AS missing,
           COUNT(*) FILTER (WHERE p.post_id IS NOT NULL
                              AND (${prefix} IN (${placeholders(keys.length, 1)}))
                              AND NOT (p.district = ANY($${keys.length + 1}::text[]))) AS mismatched
           FROM listings l LEFT JOIN ${TABLE} p ON p.post_id = l.post_id`,
        [...keys, names],
      );
      const missing = Number(row?.missing);
      const mismatched = Number(row?.mismatched);
      ok = missing === 0 && mismatched === 0;
    }
  } catch {
    ok = false;
  }
  if (rev != null) {
    if (guardCache.size >= GUARD_CACHE_LIMIT) guardCache.clear();
    guardCache.set(cacheKey, ok);
  }
  return ok;
}

/** 只做「缺列」那一項（測試／獨立檢查用）。 */
export async function districtProjectionComplete(exec, { runOne = null } = {}) {
  const one = runOne || defaultRunOne(exec);
  try {
    const hasTable = await one(`SELECT to_regclass('${TABLE}') IS NOT NULL AS has_table`);
    if (!hasTable?.has_table) return false;
    const row = await one(`SELECT COUNT(*) AS n FROM listings l WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} p WHERE p.post_id = l.post_id)`);
    return Number(row?.n) === 0;
  } catch {
    return false;
  }
}

/**
 * 預篩 id 集合（依 `revision|districts` 快取）。
 *
 * 為什麼要快取：同一個請求裡 list 與 stats 會**各問一次**同一個行政區組合（兩邊的
 * `memberRegionDistrictNames`／`resolveListDistrictNames` 在預設情境下是同一組），
 * 而每次查詢都要把上萬個 post_id 從 PG 搬回 Node（repro 實測 33–80ms）。
 * 快取只依 `data_revision` 與行政區組合，**不依時間**，所以不會讓過期結果被沿用。
 */
const idsCache = new Map();
const IDS_CACHE_LIMIT = 64;

async function projectedIdsForRevision(exec, names, cacheSuffix) {
  const one = defaultRunOne(exec);
  const rev = await currentRevision(one);
  const cacheKey = `${rev == null ? "norev" : rev}|${cacheSuffix}`;
  if (rev != null && idsCache.has(cacheKey)) return idsCache.get(cacheKey);
  const rows = await exec(`SELECT post_id FROM ${TABLE} WHERE district = ANY(?::text[])`, [names]);
  const postIds = [];
  for (const row of rows || []) {
    const id = Number(Array.isArray(row) ? row[0] : row?.post_id);
    if (Number.isFinite(id) && id > 0) postIds.push(id);
  }
  if (rev != null) {
    if (idsCache.size >= IDS_CACHE_LIMIT) idsCache.clear();
    idsCache.set(cacheKey, postIds);
  }
  return postIds;
}

/**
 * 取行政區預篩 id 集合。回傳 `{ postIds, districtNames }` 或 `null`
 * （＝不用預篩，呼叫端沿用原本的 `split_part` 子句）。
 *
 * `districtNames` 為空、選滿全部行政區（本來就不縮減）、開關關閉、或投影驗證不通過時都回 `null`。
 */
export async function loadDistrictPrefilterIds(exec, { districtNames = [], allDistrictNames = [] } = {}) {
  if (!districtPrefilterEnabled()) return null;
  const names = [...new Set((districtNames || []).filter(Boolean))];
  if (!names.length) return null;
  if (allDistrictNames.length && names.length >= allDistrictNames.length) return null;
  const { allowed, allKeys } = districtKeyLists(names);
  if (!allowed.length || allowed.length === allKeys.length) return null;
  if (!(await districtProjectionVerified(exec, { districtNames: names, allowedKeys: allowed }))) return null;
  const postIds = await projectedIdsForRevision(exec, names, `${names.join(",")}`);
  return { postIds, districtNames: names };
}
