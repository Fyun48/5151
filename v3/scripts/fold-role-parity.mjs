// 全表 same_house_role parity：讀取端 attachSameHouseRoleSteps vs SQL-sim（first-incident-edge）。
// 只連隔離庫 repro/crawl_sandbox，唯讀。不建索引、不改 DDL。
//
// 用途：
//   1. ground truth = 讀取端 attachSameHouseRoleSteps 對「全表」算出的 role。
//   2. sql-sim     = 本包 SQL 折疊的等價演算法（spec §4.1）：對每列取「src.post_id 最小」的
//                    effective 相接邊，role = 是否為 preferPrimaryListing 贏家。
//   3. 兩者全表逐列比對，輸出 一致率 + 差異分類。
//
// 用法：
//   PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-role-parity.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot, readPgRows } from "../src/pgReadSnapshot.js";
import { attachSameHouseRoles, listingSearchBuildContext, buildListRequestContextFromPg, publicSearchSettings, preloadDecorationProviderAsync } from "../src/db.js";
import { createDecorationDataLoader } from "../src/repository/decorationData.js";
import { preferPrimaryListing } from "../src/match.js";

assertPgTargetAllowed("fold-role-parity", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const drv = await createPostgresDriver({ env: process.env });
const cols = listingSearchBuildContext().candidateColumns;

const { raw, roles, primaryOffline, displayReady, now } = await withPgReadSnapshot(drv, async snapshot => {
  await snapshot.query("SET LOCAL statement_timeout = '120s'");
  const exec = (sql, params = [], { batch = false } = {}) => batch
    ? readPgRows(snapshot, toPostgresSql(sql), params)
    : snapshot.query(toPostgresSql(sql), params).then(r => r.rows);
  const ASOF = new Date().toISOString();
  const context = await buildListRequestContextFromPg(exec, { asOf: ASOF });
  const settings = publicSearchSettings({});
  const raw = await readPgRows(snapshot, toPostgresSql(`SELECT ${cols} FROM listings ORDER BY post_id`), []);
  const loader = createDecorationDataLoader({ exec, driver: "postgres" });
  const provider = await preloadDecorationProviderAsync({ exec, loader, rows: raw, settings, userId: 0, matchVoteUserId: 0, peers: false, requestContext: context });

  // ground truth
  attachSameHouseRoles(raw, 0, provider, context.now);
  const roles = new Map();
  const primaryOffline = new Map();
  for (const r of raw) {
    roles.set(Number(r.post_id), r.same_house_role || null);
    primaryOffline.set(Number(r.post_id), r.same_house_primary_offline ? 1 : 0);
  }

  // display_ready (mirror housepriceNotDisplayReady)
  const displayReady = new Map();
  for (const r of raw) {
    const source = String(r.source || "591") || "591";
    if (!provider.sourceEnabled(source)) { displayReady.set(Number(r.post_id), false); continue; }
    if (String(r.source || "") !== "houseprice") { displayReady.set(Number(r.post_id), true); continue; }
    const prep = provider.prep(Number(r.post_id));
    displayReady.set(Number(r.post_id), prep != null && Number(prep.display_ready) === 1);
  }
  return { raw, roles, primaryOffline, displayReady, now: context.now };
});

// ---- SQL-sim: first-incident-edge ----
const byId = new Map();
for (const r of raw) byId.set(Number(r.post_id), r);

const edges = [];
for (const r of raw) {
  const src = Number(r.post_id);
  const mid = Number(r.match_post_id) || 0;
  if (!mid || String(r.match_verdict || "") === "no") continue;
  const dstRow = byId.get(mid);
  if (!dstRow || String(dstRow.match_verdict || "") === "no") continue;
  if (!displayReady.get(src) || !displayReady.get(mid)) continue;
  edges.push({ src, dst: mid, order: src });
}

const incByNode = new Map();
for (const e of edges) {
  for (const x of [e.src, e.dst]) {
    const cur = incByNode.get(x);
    if (!cur || e.order < cur.order) incByNode.set(x, e);
  }
}

const sqlRole = new Map();
const sqlPrimaryOffline = new Map();
for (const x of incByNode.keys()) {
  const e = incByNode.get(x);
  const a = byId.get(e.src);
  const b = byId.get(e.dst);
  const primary = preferPrimaryListing(a, b, now);
  const primaryId = Number(primary.post_id);
  sqlRole.set(x, x === primaryId ? "primary" : "affiliate");
  sqlPrimaryOffline.set(x, Number(primary.offline) === 1 ? 1 : 0);
}
for (const r of raw) {
  const x = Number(r.post_id);
  if (!sqlRole.has(x)) { sqlRole.set(x, null); sqlPrimaryOffline.set(x, 0); }
}

// ---- compare ----
let total = 0, match = 0, mismatch = 0;
const diffs = [];
for (const x of roles.keys()) {
  total += 1;
  const gt = roles.get(x) || null;
  const sq = sqlRole.get(x) || null;
  if (gt === sq) match += 1;
  else { mismatch += 1; diffs.push({ post_id: x, gt, sq }); }
}

const buckets = {};
for (const d of diffs) {
  let k;
  if (d.gt === "affiliate" && d.sq === null) k = "sql_missed_affiliate";
  else if (d.gt === null && d.sq === "affiliate") k = "sql_extra_affiliate";
  else if (d.gt === "primary" && d.sq === "affiliate") k = "primary_flipped";
  else if (d.gt === "affiliate" && d.sq === "primary") k = "affiliate_flipped";
  else k = "other:" + d.gt + "_vs_" + d.sq;
  buckets[k] = (buckets[k] || 0) + 1;
}

console.log(JSON.stringify({
  total,
  match,
  mismatch,
  pct: (match / total * 100).toFixed(4) + "%",
  buckets,
  edges: edges.length,
  sample: diffs.slice(0, 40).map(d => {
    const r = byId.get(d.post_id);
    return { post_id: d.post_id, gt: d.gt, sq: d.sq, match_post_id: r?.match_post_id, source: r?.source };
  }),
}, null, 2));

await drv.pool.end();
