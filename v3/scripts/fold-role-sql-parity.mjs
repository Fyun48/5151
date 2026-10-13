// 驗證「SQL 折疊（讀 fold_component_root ＋ 分量內排名）」與讀取端逐位元一致。
//
// 演算法本體只有一份：SQL 用 listingSearchSql.js 的 `foldRoleCte()`（不是這裡另抄一份）。
// 兩種 root 來源（依 L-0506：repro 與正式庫兩邊都要跑）：
//   --roots=column （預設）讀實體欄 `listings.fold_component_root`；需要先跑過
//                  v3/scripts/fold-root-backfill.mjs（repro 等可寫隔離庫）。
//   --roots=param  正式庫唯讀用：不碰任何 DDL／TEMP 表，用 `unnest($1::bigint[],$2::bigint[])`
//                  把 Node 算出的 root 當參數餵進去（正式庫在 Owner 跑 DDL 之前也能量）。
//
// 用法：
//   PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-role-sql-parity.mjs
//   PG_URL=$PG_URL node v3/scripts/fold-role-sql-parity.mjs --roots=param --label=prod-readonly
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot, readPgRows } from "../src/pgReadSnapshot.js";
import { attachSameHouseRoles, listingSearchBuildContext, buildListRequestContextFromPg, publicSearchSettings, preloadDecorationProviderAsync } from "../src/db.js";
import { createDecorationDataLoader } from "../src/repository/decorationData.js";
import { foldRoleCte } from "../src/listingSearchSql.js";
import { componentRootMap, enabledSourcesFromPg } from "../src/foldComponentRoot.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const rootsMode = flag("roots", "column");
const label = flag("label", process.env.PG_URL || "");
const rootsByParam = rootsMode === "param";
// `--roots=param` 是唯讀量測（正式庫）：不建 TEMP 表、不 DDL，寫入白名單也不適用。
// `--roots=column` 會讀/寫隔離庫的 fold 欄，必須過 assertPgTargetAllowed。
if (!rootsByParam) assertPgTargetAllowed("fold-role-sql-parity", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const drv = await createPostgresDriver({ env: process.env });
// 正式庫唯讀的硬保證：--roots=param 配 --require-readonly 時，先確認這個 session 是唯讀，
// 不是唯讀就直接退出（寧可拿不到數字，也不要對正式庫送寫入）。
if (args.includes("--require-readonly")) {
  const ro = (await drv.pool.query("SELECT current_setting('default_transaction_read_only') AS ro")).rows[0]?.ro;
  if (String(ro) !== "on") {
    console.error(`--require-readonly：session 不是唯讀（default_transaction_read_only=${ro}）⇒ 中止`);
    await drv.pool.end();
    process.exit(2);
  }
  console.log("read-only session confirmed:", ro);
}

// 1) ground truth role = attachSameHouseRoles（讀取端，全表當候選集）
const { raw, gtRole, gtPrimaryOffline, enabledSources, now } = await withPgReadSnapshot(drv, async (snapshot) => {
  await snapshot.query("SET LOCAL statement_timeout = '300s'");
  const exec = (sql, params = []) => readPgRows(snapshot, toPostgresSql(sql), params);
  const cols = listingSearchBuildContext().candidateColumns;
  const ASOF = new Date().toISOString();
  const context = await buildListRequestContextFromPg(exec, { asOf: ASOF });
  const settings = publicSearchSettings({});
  const raw = await readPgRows(snapshot, toPostgresSql(`SELECT ${cols} FROM listings ORDER BY post_id`), []);
  const loader = createDecorationDataLoader({ exec, driver: "postgres" });
  const provider = await preloadDecorationProviderAsync({ exec, loader, rows: raw, settings, userId: 0, matchVoteUserId: 0, peers: false, foldGroups: true, requestContext: context });
  attachSameHouseRoles(raw, 0, provider, context.now);
  const gtRole = new Map();
  const gtPrimaryOffline = new Map();
  for (const r of raw) {
    gtRole.set(Number(r.post_id), r.same_house_role || null);
    gtPrimaryOffline.set(Number(r.post_id), r.same_house_primary_offline ? 1 : 0);
  }
  const enabledSources = normalizeCrawlSources(context.crawlSources.items).filter((x) => x.enabled).map((x) => x.id);
  return { raw, gtRole, gtPrimaryOffline, enabledSources, now: context.now };
});

// 2) SQL 端：foldRoleCte（同一份實作）＋ root 來源
let sql;
if (rootsByParam) {
  // root 由 Node 端同一支計算器算出後當參數帶進去（正式庫唯讀；沒有 fold_component_root 欄也能量）。
  const enabled = await enabledSourcesFromPg((s, p = []) => drv.pool.query(toPostgresSql(s), p).then((r) => r.rows));
  const prepRows = new Map();
  for (const row of (await drv.pool.query("SELECT post_id, COALESCE(display_ready, 0) AS display_ready FROM listing_prep")).rows) {
    prepRows.set(Number(row.post_id), Number(row.display_ready) === 1);
  }
  const gidOf = new Map();
  for (const row of (await drv.pool.query("SELECT post_id, group_id FROM listing_group_members ORDER BY post_id, group_id")).rows) {
    gidOf.set(Number(row.post_id), String(row.group_id || ""));
  }
  const isNotDisplayReady = (row) => {
    const source = String(row?.source || "591") || "591";
    if (!enabled.has(source)) return true;
    if (source !== "houseprice") return false;
    return prepRows.get(Number(row?.post_id)) !== true;
  };
  const rootMap = componentRootMap({ rows: raw, groupIdOf: (pid) => gidOf.get(Number(pid)) || "", splits: new Set(), isNotDisplayReady });
  const rootIds = [];
  const rootVals = [];
  for (const row of raw) {
    const pid = Number(row.post_id);
    rootIds.push(pid);
    const root = rootMap.get(pid) == null ? null : Number(rootMap.get(pid));
    rootVals.push(root);
  }
  const cte = foldRoleCte("", { rootSource: "unnest(?::bigint[], ?::bigint[]) AS t(post_id, fold_component_root)" })
    + "\nSELECT post_id, role, primary_offline, primary_id FROM fold_role";
  sql = await drv.pool.query(toPostgresSql(cte), [rootIds, rootVals, enabledSources, now]);
} else {
  const cte = foldRoleCte("") + "\nSELECT post_id, role, primary_offline, primary_id FROM fold_role";
  sql = await drv.pool.query(toPostgresSql(cte), [enabledSources, now]);
}

const sqlRole = new Map();
const sqlPrimaryOffline = new Map();
const sqlPrimaryId = new Map();
for (const r of sql.rows) {
  sqlRole.set(Number(r.post_id), r.role || null);
  sqlPrimaryOffline.set(Number(r.post_id), Number(r.primary_offline) === 1 ? 1 : 0);
  if (r.primary_id != null) sqlPrimaryId.set(Number(r.post_id), Number(r.primary_id));
}

const gtById = new Map(raw.map((r) => [Number(r.post_id), r]));
// 3) 逐列比對（role／primary_offline／primary_id）
let total = 0, roleMatch = 0, roleMismatch = 0, offlineMismatch = 0, primaryIdMismatch = 0;
const roleDiffs = [];
const offlineDiffs = [];
for (const x of gtRole.keys()) {
  const gt = gtRole.get(x) || null;
  const sq = sqlRole.get(x) || null;
  total += 1;
  if (gt === sq) roleMatch += 1;
  else {
    roleMismatch += 1;
    const gtRow = gtById.get(x);
    roleDiffs.push({
      post_id: x,
      gt,
      sq,
      gt_primary: gtRow ? Number(gtRow.same_house_primary_id) || null : null,
      sq_primary: sqlPrimaryId.has(x) ? sqlPrimaryId.get(x) : null,
    });
  }
  const gto = gtPrimaryOffline.get(x);
  const sqo = sqlPrimaryOffline.has(x) ? sqlPrimaryOffline.get(x) : 0;
  if (gto !== sqo && gt !== null) { offlineMismatch += 1; if (offlineDiffs.length < 10) offlineDiffs.push({ post_id: x, gt: gto, sq: sqo }); }
  const gtRow = gtById.get(x);
  const gtPrimary = gtRow && gtRow.same_house_primary_id ? Number(gtRow.same_house_primary_id) : null;
  if (gtPrimary != null && sqlPrimaryId.has(x) && sqlPrimaryId.get(x) !== gtPrimary) primaryIdMismatch += 1;
}

const buckets = {};
for (const d of roleDiffs) {
  let k;
  if (d.gt === "affiliate" && d.sq === null) k = "sql_missed_affiliate";
  else if (d.gt === null && d.sq === "affiliate") k = "sql_extra_affiliate";
  else if (d.gt === "primary" && d.sq === "affiliate") k = "primary_flipped";
  else if (d.gt === "affiliate" && d.sq === "primary") k = "affiliate_flipped";
  else k = "other:" + d.gt + "_vs_" + d.sq;
  buckets[k] = (buckets[k] || 0) + 1;
}

console.log(JSON.stringify({
  label,
  roots: rootsMode,
  total,
  roleMatch,
  roleMismatch,
  pct: (roleMatch / total * 100).toFixed(4) + "%",
  offlineMismatch,
  primaryIdMismatch,
  buckets,
  enabledSources,
  now,
  offlineSample: offlineDiffs,
  sample: roleDiffs.slice(0, 20),
}, null, 2));

await drv.pool.end();
