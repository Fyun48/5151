// `dbTotal` 精準計數器的**寫入端**：與 `listings` 的寫入**同一個交易**內維護計數值。
//
// 契約（缺一條就是錯的）：
//   1. 只在**呼叫端自己提供的交易 client** 上執行（由 `db.js` 的 `pool.withTransaction`
//      傳進來）⇒ 主列寫入與計數器要嘛一起成立、要嘛一起回滾。
//   2. 三種事件都要正確：
//        • INSERT（新列、非 fixture）⇒ `+1`
//        • INSERT（新列、`fixture_namespace` 非空）⇒ `0`（fixture 不得進產品數字）
//        • DELETE（非 fixture）⇒ `-1`
//        • 已存在列的 UPDATE ⇒ `0`（本 repo 目前**沒有任何**路徑改 `listings.fixture_namespace`；
//          真的改了會被「對帳 ＋ 統計指紋」在一個週期內抓回來，見 `listingTotalsPgCounter.js`）
//      `upsertListingRow()` 的 `ON CONFLICT DO UPDATE` 是在**同一個 statement 裡**判斷前後的，
//      所以那個「到底是新增還是更新」的答案由 `listingsUpsertRowImpactSql()`（`xmax = 0`）
//      在 SQL 端回答，不需要多一次往返。
//   3. **失敗絕不毒化整個交易**：計數器維護用 SAVEPOINT 隔離；失敗時記 warn 並放棄
//      這一次 delta（計數器會因此暫時不準，但讀取端有 fail-safe、對帳會在一個週期內覆蓋成真值）。
//      「多 +1」**不可以**用 rollback 之外的方式補償——那就變成估算值了。
import { toPostgresSql } from "./sqlDialect.js";
import { DEFAULT_LISTING_TOTALS_BUCKET, DEFAULT_LISTING_TOTALS_PREDICATE, LISTING_TOTALS_TABLE } from "./listingTotalsPgSchema.js";
import { quoteIdent } from "./pgSchema.js";

/** 物理列增減（給 `pg_stat_user_tables` 的偵測器與 `listings` 的 row-count 對照）。 */
export function listingInsertImpact({ fixtureNamespace = null } = {}) {
  return String(fixtureNamespace || "").trim() === "" ? 1 : 0;
}

export function listingDeleteImpact({ fixtureNamespace = null } = {}) {
  return String(fixtureNamespace || "").trim() === "" ? -1 : 0;
}

/**
 * `upsertListingRow()` 之後追加的一句話：回傳這一列是「新增」還是「命中既有列」。
 * PostgreSQL 的 `xmax = 0` 在 `INSERT ... ON CONFLICT DO UPDATE` 成功**插入**時成立；
 * 走到 `DO UPDATE` 時 `xmax != 0`。（`SELECT` 不帶 `FROM listings`，只讀 `excluded` 與系統欄。）
 */
export function listingsUpsertRowImpactSql() {
  return "SELECT (xmax = 0) AS inserted, COALESCE(fixture_namespace, '') AS fixture_namespace FROM listings WHERE post_id = ?";
}

/**
 * 計數器維護語句（UPSERT）：列不存在時「先建立再套用」，所以**不會有 delta 無聲掉在
 * 不存在的列上**（那正是「批次刪除／第一次寫入」最容易被忽略的漏洞）。
 *
 * • `ON CONFLICT DO UPDATE` ⇒ `total = total + $1`（同交易、精準）。
 * • `INSERT` 分支 ⇒ `GREATEST($1, 0)`：新桶遇到「刪除」時從 0 起算，**不會出現負數**
 *   （負數代表某個更早的 +1 從沒被記到，那由對帳覆蓋，不用捏造值）。
 * • `predicate_sql` **必須是這一桶的正式述詞**（`$4`），不是空字串。
 *
 * ⚠️ 2026-10-12 正式站實測的缺陷（#734 留下）：這一支原本寫死 `''`，而讀取端
 * （`listingTotalsFastState`）是拿 `normalizeListingTotalsPredicate(桶的述詞)` 跟列上的
 * `predicate_sql` 比對 ⇒ 空字串永遠不合 ⇒ `usable=false` ⇒ **每個請求退回一次全表 COUNT**
 * （單請求窗口實測 Δcalls=1／Δms=173–465，正式站四輪全部 `db_total_source=unusable`）。
 * 值本身是準的（對帳覆蓋 total），壞掉的只有指紋。既有列由 `repairListingTotalsPredicateOnce()`
 * 自癒（見 `listingTotalsPgCounter.js`）。
 */
export function listingTotalsDeltaSql(bucketKey = DEFAULT_LISTING_TOTALS_BUCKET, predicateSql = DEFAULT_LISTING_TOTALS_PREDICATE) {
  void bucketKey;
  return `INSERT INTO ${quoteIdent(LISTING_TOTALS_TABLE)} (bucket_key, predicate_sql, total, usable, ensured_at, last_reconcile_at)
    VALUES ($3, $4, GREATEST($1::bigint, 0), 1, $2, 0)
    ON CONFLICT (bucket_key) DO UPDATE SET
      total = ${quoteIdent(LISTING_TOTALS_TABLE)}.total + $1::bigint,
      usable = 1,
      ensured_at = CASE WHEN $2::bigint > 0 THEN $2::bigint ELSE ${quoteIdent(LISTING_TOTALS_TABLE)}.ensured_at END`;
}

/**
 * 在同一個交易內套用一次 delta。`bucketKey` 預設是產品桶（`product-default`）。
 *
 * 回傳 `{ applied, reason }`。**永不丟例外**（只 warn）——計數器壞掉不可以讓入庫失敗。
 */
export async function applyListingTotalsDelta(client, { bucketKey = DEFAULT_LISTING_TOTALS_BUCKET, predicateSql = DEFAULT_LISTING_TOTALS_PREDICATE, delta, now = Date.now(), log = console } = {}) {
  if (!client?.query) return { applied: false, reason: "no-client" };
  if (!bucketKey) return { applied: false, reason: "no-bucket" };
  if (!Number.isFinite(delta) || delta === 0) return { applied: false, reason: "no-op" };
  try {
    // 沒有 SAVEPOINT 也可以用，但有了它「計數器這一段失敗」就不會讓整個交易變成 aborted。
    await client.query("SAVEPOINT listing_totals");
  } catch {
    // 有些 driver（例如測試替身）不支援 SAVEPOINT ⇒ 照樣嘗試直接套用。
  }
  try {
    await client.query(toPostgresSql(listingTotalsDeltaSql(bucketKey, predicateSql)), [delta, now, bucketKey, predicateSql]);
    return { applied: true, reason: "ok" };
  } catch (error) {
    try {
      await client.query("ROLLBACK TO SAVEPOINT listing_totals");
    } catch {
      // 沒有 SAVEPOINT 就沒有東西可以回捲；交易若已 aborted，外層會自己處理。
    }
    log?.warn?.("[listing-totals] 計數器維護失敗（入庫不受影響；讀取端會退回真 COUNT、對帳會覆蓋）：", error?.message || error);
    return { applied: false, reason: String(error?.message || error) };
  }
}

/** 「這一列是新增還是更新」＋「是否在 fixture 內」的判讀（`upsertListingRow` 的讀回列）。 */
export function listingUpsertDelta(row) {
  const inserted = row?.inserted === true || row?.inserted === "t" || Number(row?.inserted) === 1;
  if (!inserted) return 0;
  return listingInsertImpact({ fixtureNamespace: row?.fixture_namespace });
}
