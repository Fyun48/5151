// 投影新鮮度檢查（唯讀）：不只比筆數，還比「一欄實際值」的抽樣一致率，並給每欄過時率＋
// 95% 置信下的推估過時筆數。
//
// 現行 `publicProjectionReady`（db.js）只查 listing_search_projection 的筆數有沒有少，
// 抓不到「筆數對、但投影欄位已過時」。這支檢查用與寫入端同一支 `computeListingProjection()`
// 重算抽樣列的投影，逐欄比對 stored 值。
//
// 用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/projection-freshness-check.mjs [樣本數] [--read-only]
//   - 樣本數：決定性抽樣大小（預設 200；跨全表散佈、重跑結果一致）。
//   - --read-only：顯式唯讀模式（本腳本本來就只 SELECT、不寫；旗標只是把契約寫成可見）。
// 只連隔離庫，唯讀（不寫 listing_search_projection）；要在正式站跑由 Owner 以
// ALLOW_PRODUCTION_PG_TARGET=1 自行授權（本腳本不寫入，仍保持唯讀）。
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { computeListingProjection } from "../src/listingSearchProjection.js";

assertPgTargetAllowed("projection-freshness-check", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const args = process.argv.slice(2);
// 本腳本只 SELECT、不寫任何表；--read-only 是顯式契約（預設即唯讀，無寫入模式）。
const READ_ONLY = true;
// 樣本數：取第一個非旗標的數字參數（預設 200）。
const SAMPLE = Math.max(1, Math.min(
  Number(args.find((a) => !a.startsWith("--")) ) || 200,
  200000,
));
// 抽樣欄位（這些是 SQL-first 熱路徑真的會 filter/sort 的投影欄位；比錯任一欄都會造成 parity 漂移）。
const COMPARE_COLUMNS = ["district", "kind", "kind_keys", "rent", "total_monthly_cost", "area", "floor", "total_floors", "elevator", "parking", "rooftop", "low_floor", "primary_listing_id", "offline_state", "updated_at"];

const drv = await createPostgresDriver({ env: process.env });

const counts = (await drv.pool.query(
  "SELECT (SELECT count(*) FROM listings) AS listings, (SELECT count(*) FROM listing_search_projection) AS projected",
)).rows[0];
const listings = Number(counts.listings) || 0;
const projected = Number(counts.projected) || 0;

// 決定性抽樣：用「post_id 對 MOD 取模＝0」跨全表散佈（不依賴 OFFSET，重跑結果一致）。
// MOD 依樣本數與總列數推算，讓候選池至少能裝下 SAMPLE 列（先前固定 MOD=997 會把抽樣數
// 卡死在總列數/997 ≈ 184，傳 1200 仍只抽到 177）。
const MOD = Math.max(1, Math.floor(listings / Math.max(1, SAMPLE)));
const sampleRows = (await drv.pool.query(
  `SELECT l.* FROM listings l
   WHERE l.post_id % $1 = 0
   ORDER BY l.post_id
   LIMIT $2`,
  [MOD, SAMPLE],
)).rows;

const storedRows = (await drv.pool.query(
  `SELECT * FROM listing_search_projection WHERE post_id = ANY($1::bigint[])`,
  [sampleRows.map((r) => Number(r.post_id))],
)).rows;
const storedById = new Map(storedRows.map((r) => [Number(r.post_id), r]));

const mismatches = {};
let compared = 0;
for (const row of sampleRows) {
  const pid = Number(row.post_id);
  const stored = storedById.get(pid);
  if (!stored) continue; // 投影缺列（應由 count 檢查抓到）
  compared += 1;
  const fresh = computeListingProjection(row);
  for (const col of COMPARE_COLUMNS) {
    const a = fresh[col];
    const b = stored[col];
    // updated_at 是 bigint ms、可能被 pg 回傳成 string；其餘都做 Number/String 正規化再比。
    const na = col === "updated_at" || col === "area" || col === "lat" || col === "lng"
      ? Number(a) : (typeof a === "number" ? a : String(a ?? ""));
    const nb = col === "updated_at" || col === "area" || col === "lat" || col === "lng"
      ? Number(b) : (typeof b === "number" ? b : String(b ?? ""));
    if (na !== nb) mismatches[col] = (mismatches[col] || 0) + 1;
  }
}

const columnMismatch = Object.values(mismatches).reduce((s, n) => s + n, 0);
const countOk = listings === projected;

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
for (const col of COMPARE_COLUMNS) {
  perColumn[col] = estimateColumn(mismatches[col] || 0);
}

const sample = {
  readOnly: READ_ONLY,
  sampled: sampleRows.length,
  compared,
  countOk,
  listings,
  projected,
  missing: Math.max(0, listings - projected),
  columnMismatch,
  mismatchColumns: mismatches,
  perColumn,
  pass: countOk && compared > 0 && columnMismatch === 0,
};

console.log(JSON.stringify(sample, null, 2));
await drv.pool.end();
process.exit(sample.pass ? 0 : 1);
