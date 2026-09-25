// B5 第一步：同 args 的 A/B 對照（同一份 PG 資料）
//   A = SQL-first（正式路徑：repository.searchPage，PG）
//   B = PG-fed Node（searchListingsNodePg）
// 比較 totalMatched 與 ID 集合；差異即兩條管線的語意差（同屋源角色等）。
import { createPostgresDriver } from "/app/src/dbDriverPostgres.js";
import { listingSearchBuildContext } from "./src/db.js";
import { searchListingsNodePg } from "./src/listingSearchNodePg.js";
import { createListingsRepository } from "./src/repository/listings.js";

const drv = await createPostgresDriver({ env: process.env });
const deps = listingSearchBuildContext();
const repo = createListingsRepository({ driver: "postgres", pgDriver: drv, deps });
const pgDriver = { query: (sql, params) => drv.query(sql, params), pool: drv.pool };

const DISTRICTS = [process.env.DISTRICT || "西屯區"];
const CASES = [
  { label: "all/newest (prod args)", args: { filter: "all", sort: "newest" } },
  { label: "all/newest (searchKeys=[])", args: { filter: "all", sort: "newest", searchKeys: [] } },
  { label: "all/price_asc (searchKeys=[])", args: { filter: "all", sort: "price_asc", searchKeys: [] } },
  { label: "kind=whole (searchKeys=[])", args: { filter: "all", sort: "newest", searchKeys: [], kind: "whole" } },
  { label: "q=電梯 (searchKeys=[])", args: { filter: "all", sort: "newest", searchKeys: [], q: "電梯" } },
  { label: "filter=hidden (searchKeys=[])", args: { filter: "hidden", sort: "newest", searchKeys: [] } },
];

const results = [];
for (const item of CASES) {
  const args = { limit: 50, offset: 0, districts: DISTRICTS, userId: 0, matchVoteUserId: 0, settings: {}, ...item.args };
  let sqlFirst = null; let nodePg = null; let error = null;
  try { sqlFirst = await repo.searchPage(args); } catch (e) { error = `A:${String(e.message).slice(0, 80)}`; }
  try { nodePg = await searchListingsNodePg(args, { pgDriver, deps }); } catch (e) { error = `${error || ""} B:${String(e.message).slice(0, 80)}`; }

  const aIds = sqlFirst?.ids || [];
  const bIds = (nodePg?.listings || []).map((row) => Number(row.post_id));
  const aSet = new Set(aIds); const bSet = new Set(bIds);
  const aOnly = aIds.filter((id) => !bSet.has(id));
  const bOnly = bIds.filter((id) => !aSet.has(id));
  results.push({
    label: item.label,
    error,
    total: { sqlFirst: sqlFirst?.totalMatched ?? null, nodePg: nodePg?.totalMatched ?? null },
    pageIds: { sqlFirst: aIds.length, nodePg: bIds.length },
    diff: { aOnly: aOnly.length, bOnly: bOnly.length },
    samples: { aOnly: aOnly.slice(0, 4), bOnly: bOnly.slice(0, 4) },
    sameOrder: aIds.length === bIds.length && aIds.every((id, i) => id === bIds[i]),
  });
}
console.log(`AB ${JSON.stringify({ district: DISTRICTS[0], results, allTotalEqual: results.every((r) => !r.error && r.total.sqlFirst === r.total.nodePg) })}`);
await drv.pool.end();
