// 投影新鮮度檢查（repro 唯讀）：不只比筆數，還比「一欄實際值」的抽樣一致率。
//
// 現行 `publicProjectionReady`（db.js）只查 listing_search_projection 的筆數有沒有少，
// 抓不到「筆數對、但投影欄位已過時」（round 1 實例：kind 差 2,412 筆，筆數仍相等）。
// 這支檢查用與寫入端同一支 `computeListingProjection()` 重算抽樣列的投影，逐欄比對
// stored 值，報出抽樣一致率與哪幾欄有落差。
//
// 用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/projection-freshness-check.mjs [樣本數]
// 只連隔離庫，唯讀（不寫 listing_search_projection）。
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { computeListingProjection } from "../src/listingSearchProjection.js";

assertPgTargetAllowed("projection-freshness-check", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const SAMPLE = Math.max(1, Math.min(Number(process.argv[2]) || 200, 2000));
// 抽樣欄位（這些是 SQL-first 熱路徑真的會 filter/sort 的投影欄位；比錯任一欄都會造成 parity 漂移）。
const COMPARE_COLUMNS = ["district", "kind", "kind_keys", "rent", "total_monthly_cost", "area", "floor", "total_floors", "elevator", "parking", "rooftop", "low_floor", "primary_listing_id", "offline_state", "updated_at"];

const drv = await createPostgresDriver({ env: process.env });

const counts = (await drv.pool.query(
  "SELECT (SELECT count(*) FROM listings) AS listings, (SELECT count(*) FROM listing_search_projection) AS projected",
)).rows[0];
const listings = Number(counts.listings) || 0;
const projected = Number(counts.projected) || 0;

// 決定性抽樣：用 post_id 對質數取模，跨全表散佈（不依賴 OFFSET，重跑結果一致）。
const MOD = 997;
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
let columnMismatch = 0;
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
    if (na !== nb) {
      mismatches[col] = (mismatches[col] || 0) + 1;
      columnMismatch += 1;
    }
  }
}

const countOk = listings === projected;
const sample = {
  sampled: sampleRows.length,
  compared,
  countOk,
  listings,
  projected,
  missing: Math.max(0, listings - projected),
  columnMismatch,
  mismatchColumns: mismatches,
  pass: countOk && compared > 0 && columnMismatch === 0,
};

console.log(JSON.stringify(sample, null, 2));
await drv.pool.end();
process.exit(sample.pass ? 0 : 1);
