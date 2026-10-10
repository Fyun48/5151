// fold_* 新鮮度檢查（唯讀）：比對「抽樣列的 stored fold_*」與「用最終列重算」的 fold_*。
//
// 投影已有 projection-freshness-check.mjs；fold 四欄（fold_rent_num / fold_refresh_kind /
// fold_refresh_rel_ms / fold_refresh_abs_ms）是同一種「固化欄」，也需要一支獨立的過時檢查：
// 只比「fold_* 是否全非 NULL」抓不到「主列已變、fold_* 仍舊」。這支用寫入端同一支
// computeFoldColumns() 重算抽樣列，逐欄比對 stored 值，並給 95% 置信下的推估過時筆數。
//
// 用法：PG_URL=$PG_SNAPSHOT_REPRO2_URL node v3/scripts/fold-freshness-check.mjs [樣本數]
//   - 樣本數：決定性抽樣大小（預設 200；跨全表散佈、重跑結果一致）。
// 本腳本只 SELECT、不寫任何表。
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { computeFoldColumns } from "../src/match.js";

assertPgTargetAllowed("fold-freshness-check", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const args = process.argv.slice(2);
const SAMPLE = Math.max(1, Math.min(
  Number(args.find((a) => !a.startsWith("--"))) || 200,
  200000,
));
// 這四欄是 SQL 折疊（foldRoleCte）真的會讀的固化欄；比錯任一欄都會造成 role／refresh 漂移。
const COMPARE_COLUMNS = ["fold_rent_num", "fold_refresh_kind", "fold_refresh_rel_ms", "fold_refresh_abs_ms"];

const drv = await createPostgresDriver({ env: process.env });

const counts = (await drv.pool.query("SELECT count(*) AS n FROM listings")).rows[0];
const listings = Number(counts.n) || 0;

// 決定性抽樣：與 projection-freshness-check.mjs 同一招（post_id % MOD = 0，重跑結果一致）。
const MOD = Math.max(1, Math.floor(listings / Math.max(1, SAMPLE)));
const sampleRows = (await drv.pool.query(
  `SELECT l.* FROM listings l WHERE l.post_id % $1 = 0 ORDER BY l.post_id LIMIT $2`,
  [MOD, SAMPLE],
)).rows;

const num = (v) => (v == null ? null : Number(v));
const mismatches = {};
let compared = 0;
for (const row of sampleRows) {
  const fresh = computeFoldColumns(row);
  const stored = {
    fold_rent_num: num(row.fold_rent_num),
    fold_refresh_kind: num(row.fold_refresh_kind),
    fold_refresh_rel_ms: num(row.fold_refresh_rel_ms),
    fold_refresh_abs_ms: num(row.fold_refresh_abs_ms),
  };
  compared += 1;
  for (const col of COMPARE_COLUMNS) {
    if (num(fresh[col]) !== stored[col]) mismatches[col] = (mismatches[col] || 0) + 1;
  }
}

const columnMismatch = Object.values(mismatches).reduce((s, n) => s + n, 0);

// 95% 置信推估：抽樣比例 p 的常態近似，p ± 1.96·sqrt(p(1-p)/n)，再乘以總列數。
const Z = 1.96;
function estimateColumn(mismatchCount) {
  const n = compared;
  const p = n > 0 ? mismatchCount / n : 0;
  const se = n > 0 ? Math.sqrt((p * (1 - p)) / n) : 0;
  const lo = Math.max(0, p - Z * se);
  const hi = Math.min(1, p + Z * se);
  return {
    staleRate: Number(p.toFixed(6)),
    estStale: Math.round(p * listings),
    ci95Low: Math.round(lo * listings),
    ci95High: Math.round(hi * listings),
  };
}

const perColumn = {};
for (const col of COMPARE_COLUMNS) perColumn[col] = estimateColumn(mismatches[col] || 0);

const sample = {
  readOnly: true,
  sampled: sampleRows.length,
  compared,
  listings,
  columnMismatch,
  mismatchColumns: mismatches,
  perColumn,
  pass: compared > 0 && columnMismatch === 0,
};

console.log(JSON.stringify(sample, null, 2));
await drv.pool.end();
process.exit(sample.pass ? 0 : 1);
