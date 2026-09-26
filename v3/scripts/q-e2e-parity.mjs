// F3 端到端等價性：q（關鍵字）——正式 builder SQL × 真實 PG 資料 vs Node 判定。
//
// 自我驗證：先用 q="" 當控制組，確認我模型化的外框（顯示篩選＋可見性）等同 SQL 外框；
// 一致才比較各種關鍵字。watch_note 也納入模型（uid=0 的 flag 列可能非空）。
import { createPostgresDriver } from "/app/src/dbDriverPostgres.js";
import { buildListingSearchSql } from "./src/listingSearchSql.js";
import { toPostgresSql } from "./src/sqlDialect.js";

const drv = await createPostgresDriver({ env: process.env });
const deps = {
  resolveUserId: () => 0, getSettings: () => ({}), memberRegionDistrictNames: () => [],
  searchWhere: () => {}, listingVisibilityClauses: () => {},
  appendDistrictCandidates: () => {}, appendPriceCeilingCandidates: () => {},
};
const threshold = Number(process.env.THRESHOLD) || Number((await drv.query(
  `SELECT post_id FROM listing_search_projection WHERE kind_keys <> '' ORDER BY post_id OFFSET 200 LIMIT 1`)).rows[0]?.post_id) || 0;

const ARGS = { filter: "all", sources: "", kind: "", sort: "newest", districts: [], allowAllDistricts: true, userId: 0, matchVoteUserId: 0, settings: {} };
const sqlCount = async (q) => {
  const b = buildListingSearchSql({ ...ARGS, q }, deps);
  if (!b.ok) return { ok: false, reason: b.reason };
  const sql = toPostgresSql(`${b.countQuery.sql} AND p.post_id <= ?`);
  return { ok: true, n: Number((await drv.query(sql, [...b.countQuery.params, threshold])).rows[0]?.n) || 0 };
};

// 控制組用的外框（顯示篩選＋可見性），與 kind-e2e-parity 相同模型
const rows = (await drv.query(`
  SELECT l.post_id, l.title, l.address, l.offline, l.offline_confirmed, l.match_verdict,
         (SELECT f.watch_note FROM user_listing_flags f WHERE f.post_id = l.post_id AND f.user_id = 0) AS watch_note
  FROM listings l JOIN listing_search_projection p ON p.post_id = l.post_id
  WHERE p.post_id <= $1 AND p.low_floor = 0 AND p.rooftop = 0
`, [threshold])).rows;
const envelope = rows.filter((r) => !(Number(r.offline) === 1 && Number(r.offline_confirmed) === 1) && String(r.match_verdict || "") !== "yes");

const hit = (row, q) => {
  const needle = String(q).toLowerCase();
  const has = (v) => String(v ?? "").toLowerCase().includes(needle);
  return has(row.title) || has(row.address) || has(row.post_id) || has(row.watch_note);
};

const QUERIES = ["", "電梯", "電梯大樓", "park", "PARK", "捷運", "中山", "套房", "no-such-keyword-xyz"];
const out = {}; let ok = true;
for (const q of QUERIES) {
  const sql = await sqlCount(q);
  const node = q === "" ? envelope.length : envelope.filter((r) => hit(r, q)).length;
  const same = sql.ok && sql.n === node;
  if (!same) ok = false;
  out[q || "(empty)"] = sql.ok ? { sql: sql.n, node, same } : { error: sql.reason };
}
console.log(`QE2E ${JSON.stringify({ threshold, rowsScanned: rows.length, envelope: envelope.length, control: out["(empty)"], results: out, ok })}`);
await drv.pool.end();
