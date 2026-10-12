// 會員列表 `dbTotal`（＝`summarizeListingStats().counts.dbTotal`）的精準計數器：
// PostgreSQL 原生 schema 與「桶（bucket）」定義（sqlite-exit 系列，2026-10-12）。
//
// 為什麼需要這張表：
//   `v3/src/repository/listingStats.js` 的 `countProductListings()` 目前是「以
//   `MAX(data_revision.id)` 當版本號的跨請求快取 ＋ 每次換代就現讀
//   `SELECT COUNT(*) FROM listings WHERE (fixture_namespace IS NULL OR fixture_namespace = '')`」。
//   正式站實測（13:22–13:26 單請求窗口）：這條 COUNT **每個請求 1 次、99.6–215.2ms**
//   ——因為爬蟲讓 `data_revision` 幾乎每秒換代（`listing_updated` ≈1.25/s），版本化快取
//   從未命中。它是**要給使用者看的精確數字**，所以不能用估算（`reltuples`／`n_live_tup`
//   一律不接受）：只能改成「與 `listings` 寫入同一個交易維護」的精準計數器。
//
// 設計（與 `listingDistrictPrefilter.js`／`dataRevisionPgSchema.js` 同一慣例）：
//   1. 一個桶 =「一組述詞」（例如預設的「排除 fixture 的產品可見總數」）。桶以
//      `bucket_key`（人類可讀的鍵）表示，並把**當時實際使用的述詞**逐字記在
//      `predicate_sql`——述詞若改寫，鍵就不同、舊桶自然失效，不會靜默沿用錯的數字。
//   2. `total` 是**精準值**：由寫入路徑以 `total = total + 1`／`- 1` 在同交易維護；
//      對帳（reconcile）時以真正的 `COUNT(*)` 覆蓋。
//   3. `usable=0` 是 fail-safe 開關：讀取端看到它（或沒有這一列）就退回原本那條真 COUNT。
//      任何「不確定」都走這條，寧可慢、不可錯。
//   4. `row_count` 是同一筆 bucket 的列數（`listings` 的物理列數）：reconcile 只需要
//      `total` 一個真 COUNT，`row_count` 讓它順便記下「桶與整表的關係」以便診斷。
//
// 回退：`dropListingTotalsStatements()`（等同 `DROP TABLE listing_totals_counter`），
// 或把 `LISTING_TOTALS_COUNTER=0` 關掉 ⇒ 讀取端逐字跑原本那條 COUNT。
import { quoteIdent } from "./pgSchema.js";
import { toPostgresSql } from "./sqlDialect.js";

export const LISTING_TOTALS_TABLE = "listing_totals_counter";

/** 預設桶的鍵：`buildListRequestContextFromPg()` 未帶 namespace 時的 isolation 述詞。 */
export const DEFAULT_LISTING_TOTALS_BUCKET = "product-default";

/**
 * `buildListRequestContextFromPg()` 對「沒有 namespace」的情形產生的述詞（逐字相同）。
 * 桶的定義就是「這條述詞」，所以這裡只留一份。
 */
export const DEFAULT_LISTING_TOTALS_PREDICATE = "(fixture_namespace IS NULL OR fixture_namespace = '')";

/**
 * 述詞 → 桶。回傳 `null` 代表**這個述詞沒有被支援**（呼叫端必須退回真 COUNT）。
 *
 * 目前只支援兩種形狀（都是 `buildListRequestContextFromPg()` 會產生的）：
 *   • 預設（無 namespace）⇒ 桶 `product-default`
 *   • `fixture_namespace = ?` ⇒ 桶 `fixture-ns:<namespace>`（fixture 情境，不需要熱路徑）
 */
export function listingTotalsBucketForIsolation(isolation) {
  const sql = String(isolation?.sql || "").trim();
  if (!sql) return null;
  if (sql === DEFAULT_LISTING_TOTALS_PREDICATE) {
    return { bucketKey: DEFAULT_LISTING_TOTALS_BUCKET, predicateSql: DEFAULT_LISTING_TOTALS_PREDICATE, params: [] };
  }
  const match = /^fixture_namespace\s*=\s*(\?|\$1)$/.exec(sql);
  if (match) {
    const namespace = String((isolation?.params || [])[0] ?? "").trim();
    if (!namespace) return null;
    return { bucketKey: `fixture-ns:${namespace}`, predicateSql: "fixture_namespace = $1", params: [namespace] };
  }
  return null;
}

/**
 * 述詞的正規形式（**一律 PostgreSQL 的 `$n` 形**）。
 *
 * 為什麼要正規化：`buildListRequestContextFromPg()` 產生的是 `?` 形，而別的地方（測試、
 * 診斷、未來的呼叫端）可能直接給 `$1` 形；兩種寫法指的是**同一條述詞**，若不收斂成同一份
 * 文字，桶的「述詞指紋」就會無故不合而退回真 COUNT（功能變慢，卻沒有任何正確性理由）。
 */
export function normalizeListingTotalsPredicate(sql) {
  return toPostgresSql(String(sql || "").trim());
}

const TABLE = {
  name: LISTING_TOTALS_TABLE,
  columns: [
    { name: "bucket_key", type: "TEXT", primaryKey: true },
    { name: "predicate_sql", type: "TEXT", notNull: true },
    { name: "total", type: "BIGINT", notNull: true, default: "1" },
    { name: "row_count", type: "BIGINT" },
    { name: "usable", type: "SMALLINT", notNull: true, default: "0" },
    { name: "ensured_at", type: "BIGINT", notNull: true, default: "0" },
    { name: "last_reconcile_at", type: "BIGINT", notNull: true, default: "0" },
    { name: "last_reconcile_value", type: "BIGINT" },
    { name: "reconcile_count", type: "BIGINT", notNull: true, default: "0" },
    { name: "drift_count", type: "BIGINT", notNull: true, default: "0" },
    { name: "stat_baseline_ins", type: "BIGINT" },
    { name: "stat_baseline_del", type: "BIGINT" },
    { name: "stat_baseline_total", type: "BIGINT" },
    { name: "stat_baseline_at", type: "BIGINT" },
    { name: "stat_drift_ins", type: "BIGINT", notNull: true, default: "0" },
    { name: "stat_drift_del", type: "BIGINT", notNull: true, default: "0" },
  ],
  indexes: [["idx_listing_totals_reconciled", ["last_reconcile_at"]]],
};

function columnDef(column) {
  const parts = [quoteIdent(column.name), column.type];
  if (column.primaryKey) parts.push("PRIMARY KEY");
  if (column.notNull) parts.push("NOT NULL");
  if (column.default != null) parts.push(`DEFAULT ${column.default}`);
  return parts.join(" ");
}

function createTableStatement(table) {
  const lines = table.columns.map((column) => `  ${columnDef(column)}`);
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (\n${lines.join(",\n")}\n)`;
}

export function listingTotalsCreateTableStatements() {
  return [createTableStatement(TABLE)];
}

export function listingTotalsIndexStatements() {
  return TABLE.indexes.map(([name, columns]) =>
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(TABLE.name)} (${columns.map(quoteIdent).join(", ")})`,
  );
}

/** 建表＋索引＝PG 側權威 schema 的完整冪等 DDL。 */
export function listingTotalsDdlStatements() {
  return [...listingTotalsCreateTableStatements(), ...listingTotalsIndexStatements()];
}

/**
 * 冪等「確保桶存在」。**不覆蓋既有值**（`DO NOTHING`）：重跑不會把計數器歸零，
 * 只補「這一列還沒有」的情形。`predicate_sql` 若與既有不同 ⇒ 視為不同桶（由鍵區分）。
 */
export function listingTotalsEnsureBucketStatement() {
  const name = quoteIdent(TABLE.name);
  return `INSERT INTO ${name} (bucket_key, predicate_sql, total, row_count, usable, ensured_at, last_reconcile_at)
    VALUES ($1, $2, 0, NULL, 0, 0, 0)
    ON CONFLICT (bucket_key) DO NOTHING`;
}

/** 回退：一句 `DROP TABLE` 回到現行行為（讀取端自動退回真 COUNT）。 */
export function dropListingTotalsStatements() {
  return [`DROP TABLE IF EXISTS ${quoteIdent(TABLE.name)}`];
}
