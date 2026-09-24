// 量測：Node 路徑 vs SQL 路徑 的結果差異（Same-house affiliate 缺口）。
//
// 方法：同一組 args 分別跑
//   Node：listListings(args)            ← 完整管線（含 attachSameHouseRoles + listingMatchesMatchFilter）
//   SQL ：listListingsSqlFirst(args)    ← SQL-first（現行 builder，沒有 affiliate 條件）
// 比較兩邊的 post_id 集合，列出「SQL 有、Node 沒有」的列，並檢查它們的 match_post_id / match_verdict。
import { createRequire } from "node:module";
import { listListings, listListingsSqlFirst } from "./src/db.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/v3.db", { readOnly: true });
// 會員路徑的 builder 需要行政區才算在 envelope 內；取一個真實且有量的行政區，讓兩邊條件一致。
const district = String(db.prepare(
  `SELECT district FROM listing_search_projection WHERE district <> '' GROUP BY district ORDER BY COUNT(*) DESC LIMIT 1`).get()?.district || "");

const ARGS = {
  userId: 0, searchKeys: [], settings: {}, sort: "newest", limit: 300, offset: 0,
  filter: "all", districts: [district],
};

const nodeRes = listListings({ ...ARGS });
const sqlRes = listListingsSqlFirst({ ...ARGS });
const nodeRows = nodeRes?.listings || [];
const sqlRows = sqlRes?.listings || [];

const nodeIds = new Set(nodeRows.map((r) => Number(r.post_id)));
const sqlIds = new Set(sqlRows.map((r) => Number(r.post_id)));
const sqlOnly = [...sqlIds].filter((id) => !nodeIds.has(id));
const detail = {};
for (const id of sqlOnly.slice(0, 8)) {
  const row = sqlRows.find((r) => Number(r.post_id) === id) || {};
  detail[id] = {
    match_post_id: row.match_post_id ?? null,
    match_verdict: row.match_verdict ?? null,
    same_house_role: row.same_house_role ?? null,
  };
}
console.log(`DIFF ${JSON.stringify({
  district,
  nodeCount: nodeIds.size, sqlCount: sqlIds.size,
  nodeTotalMatched: nodeRes?.totalMatched ?? null,
  sqlTotalMatched: sqlRes?.totalMatched ?? null,
  sqlOnlyCount: sqlOnly.length, sqlOnlySample: sqlOnly.slice(0, 8), detail,
})}`);

