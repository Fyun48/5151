// listings 的 hot path 索引：PostgreSQL 原生 DDL（sqlite-exit 系列，2026-10-12）。
//
// 為什麼需要這個檔：`v3/src/db.js` 裡那批 `db.exec("CREATE INDEX IF NOT EXISTS …")` 是
// **SQLite 時代的 schema 陳述**，`DB_DRIVER=postgres` 時整段不會執行 ⇒ PG 側一概沒有這些索引。
// 2026-10-12 唯讀實測正式庫（casa `5151-postgres-A`／DB `5151_shadow`）：
//   `pg_indexes WHERE tablename='listings'` 共 12 條，**沒有任何一條**是 db.js 宣告的名字；
//   `to_regclass('idx_listings_search')` → NULL。
// 後果：`storedSearchKeysFromPg()` 的 `to_regclass` 探測每次都落空，一路退回
//   `SELECT DISTINCT search_key FROM listings`（正式庫實測 225ms／次、`pg_stat_statements`
//   queryid -1058412334999276296 累計 2,244 次、平均 385.9ms）。
//
// 本檔只補「hot path 真的缺、而且沒有等效索引頂著」的那幾條。逐條盤點（正式庫證據）：
//
//   索引名                     │ db.js 宣告 │ 正式庫   │ 是否有等效索引 │ 本檔處置
//   ───────────────────────────┼───────────┼─────────┼───────────────┼─────────────────────
//   idx_listings_search        │ :848      │ 缺席     │ 無            │ **建立**（hot path 核心）
//   idx_listings_origin        │ :837      │ 缺席     │ 無            │ 不建（僅寫入路徑 upsert 用，
//                              │           │         │               │   每個 listing 多一條維護成本）
//   idx_listings_hidden        │ :849      │ 缺席     │ 無            │ 不建（見下方說明）
//   idx_listings_match         │ :850      │ 缺席     │ 無            │ 不建（match_level 非 hot 謂詞）
//   idx_listings_offline       │ :851      │ 缺席     │ idx_listings_offline_state(offline,…) │ 不建（重複）
//   idx_listings_match_peer    │ :866      │ 缺席     │ idx_listings_match_post_id(match_post_id, post_id) │ 不建（重複）
//   idx_listings_list_scan     │ :867      │ 缺席     │ 無            │ 不建（複合索引的維護成本高；
//                              │           │         │               │   搜尋改走 listing_search 投影）
//   idx_listings_offline_counts│ :869      │ 缺席     │ idx_listings_offline_state 已覆蓋 │ 不建（重複）
//   idx_listings_source 等     │ :608-612  │ 缺席     │ 無            │ 不建（SQLite 舊欄位，PG 走 source_key）
//
// 為什麼 `idx_listings_hidden` 先不建：hot path 的實際形狀是
//   `WHERE COALESCE(hidden,0)=0 AND COALESCE(offline_confirmed,0)=0 LIMIT 500`，
//   正式庫 EXPLAIN 走 Parallel Seq Scan＋Limit 只要 35ms（只要 500 列，取到就停）；
//   換成索引反而要走 index scan 再回表，實測不會更快。4 核 NAS 上每條索引都是寫入開銷，
//   沒有量到的收益就不該加（Owner 指示：只補 hot path 真的缺的）。
//
// 交易語意與回退：這裡全部是 `CREATE INDEX IF NOT EXISTS`（**非 CONCURRENTLY**）。
// 理由：CONCURRENTLY 不能跑在交易內、中斷會留 INVALID 索引殘骸；本 DDL 走 autocommit、
// 在啟動空檔執行最單純。代價是 `CREATE INDEX` 會取 SHARE 鎖、擋住同時的寫入；
// 隔離靶實測 184,736 列／342MB 的 listings 建立只要 653ms、索引佔 1,776kB，
// 放在容器啟動空檔可接受。已存在時 `IF NOT EXISTS` 只花 0.9ms。
//
// 回退方法：`dropListingHotPathIndexStatements()`（等同 `DROP INDEX idx_listings_search`）。
// 回退是安全的——`storedSearchKeysFromPg()` 的 `to_regclass` 探測會自動退回 `DISTINCT` 路徑。
// 若在待機節點回退，索引異動會照一般 DDL 經串流複製傳遞，回退指令本身也是 DDL 亦然。
import { quoteIdent } from "./pgSchema.js";

const TABLE = "listings";

// 只放「hot path 真的缺、且無等效索引」的條目。新增前先看檔頭盤點表的規則。
const HOT_PATH_INDEXES = [
  // `SELECT DISTINCT search_key FROM listings` 的 loose index scan 後盾。
  // 沒有它，`storedSearchKeysFromPg()` 的每輪 `min(search_key) WHERE search_key > k`
  // 都退化成整表掃描：正式庫同一條 recursive SQL 實測 15,217ms（比 DISTINCT 的 225ms 差 67 倍）。
  { name: "idx_listings_search", table: TABLE, columns: ["search_key"] },
];

export function listingHotPathIndexNames() {
  return HOT_PATH_INDEXES.map((index) => index.name);
}

export function listingHotPathIndexStatements() {
  return HOT_PATH_INDEXES.map(
    ({ name, table, columns }) =>
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")})`,
  );
}

// 回退用（PR 描述與 runbook 要能照抄）。刻意不 export 成自動執行，只給人／運維手動下。
export function dropListingHotPathIndexStatements() {
  return HOT_PATH_INDEXES.map(({ name }) => `DROP INDEX IF EXISTS ${quoteIdent(name)}`);
}
