// F3 端到端等價性（PG，唯讀）：用正式 builder 產生的 SQL 對真實資料，與 Node 判定比對。
// 控制組：kind="" 時 SQL 計數必須等於我用 JS 模型化的外框計數；不一致就代表模型不足，本檢查會 fail。
import { createPostgresDriver } from "/app/src/dbDriverPostgres.js";
import { buildListingSearchSql } from "./src/listingSearchSql.js";
import { matchesHousingKind } from "./src/floors.js";
import { toPostgresSql } from "./src/sqlDialect.js";

const drv = await createPostgresDriver({ env: process.env });
const deps = {
  resolveUserId: () => 0, getSettings: () => ({}), memberRegionDistrictNames: () => [],
  searchWhere: () => {}, listingVisibilityClauses: () => {},
  appendDistrictCandidates: () => {}, appendPriceCeilingCandidates: () => {},
};
const threshold = Number(process.env.THRESHOLD) || Number((await drv.query(
  `SELECT post_id FROM listing_search_projection WHERE kind_keys <> '' ORDER BY post_id OFFSET 200 LIMIT 1`)).rows[0]?.post_id) || 0;

const ARGS = { filter: "all", sources: "", q: "", sort: "newest", districts: [], allowAllDistricts: true, userId: 0, matchVoteUserId: 0, settings: {} };
const count = async (kind) => {
  const b = buildListingSearchSql({ ...ARGS, kind }, deps);
  if (!b.ok) return { ok: false, reason: b.reason };
  const sql = toPostgresSql(`${b.countQuery.sql} AND p.post_id <= ?`);
  const n = Number((await drv.query(sql, [...b.countQuery.params, threshold])).rows[0]?.n) || 0;
  return { ok: true, sql: n };
};
const rows = (await drv.query(`
  SELECT l.*, p.kind_keys, p.low_floor, p.rooftop, p.area
  FROM listings l JOIN listing_search_projection p ON p.post_id = l.post_id
  WHERE p.post_id <= $1 AND p.low_floor = 0 AND p.rooftop = 0
`, [threshold])).rows;
const envelope = rows.filter((r) => !(Number(r.offline) === 1 && Number(r.offline_confirmed) === 1) && String(r.match_verdict || "") !== "yes");

const KINDS = ["", "elevator", "apartment", "building", "suite", "whole", "shop", "suite,yafang", "apartment,building", "coliving,share", "whole,elevator", "warehouse"];
const out = {}; let ok = true;
for (const kind of KINDS) {
  const sql = await count(kind);
  const node = kind === "" ? envelope.length : envelope.filter((r) => matchesHousingKind(r, kind) === true).length;
  const same = sql.ok && sql.sql === node;
  if (!same) ok = false;
  out[kind || "(empty)"] = sql.ok ? { sql: sql.sql, node, same } : { error: sql.reason };
}
console.log(`E2E ${JSON.stringify({ threshold, rowsScanned: rows.length, envelope: envelope.length, control: out["(empty)"], results: out, ok })}`);
await drv.pool.end();
