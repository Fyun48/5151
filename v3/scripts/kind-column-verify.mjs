// F3（PR-B）：驗證 PG 投影的 kind_keys 欄位內容 == listingKindKeys(同一列)（抽樣、唯讀）。
//
// 為什麼要這一支：單元測試驗的是「程式碼結構」，探針驗的是「述詞等價」，而這一支驗的是
// 「**生產 PG 資料**的內容是否真的由同一支函式產生」——三者合起來才算 kind 可上線。
//
// 用法（容器內，唯讀）：cd /tmp/kk && node --input-type=module < kind-column-verify.mjs
//   環境變數：LIMIT（抽樣列數，預設 5000）
import { createPostgresDriver } from "/app/src/dbDriverPostgres.js";
import { listingKindKeys } from "./src/floors.js";

const drv = await createPostgresDriver({ env: process.env });
const LIMIT = Math.max(1, Number(process.env.LIMIT) || 5000);

const rows = (await drv.query(`
  SELECT l.*, p.kind_keys AS proj_kind_keys
  FROM listings l
  JOIN listing_search_projection p ON p.post_id = l.post_id
  WHERE p.kind_keys <> ''
  ORDER BY l.post_id
  LIMIT $1
`, [LIMIT])).rows;

let same = 0;
let diff = 0;
const samples = [];
for (const row of rows) {
  const computed = listingKindKeys(row);
  if (computed === String(row.proj_kind_keys || "")) {
    same += 1;
  } else {
    diff += 1;
    if (samples.length < 5) {
      samples.push({ post_id: row.post_id, computed, stored: row.proj_kind_keys });
    }
  }
}

const emptyRemaining = Number((await drv.query(
  `SELECT COUNT(*)::int AS n FROM listing_search_projection WHERE kind_keys = ''`,
)).rows[0]?.n ?? -1);
const filled = Number((await drv.query(
  `SELECT COUNT(*)::int AS n FROM listing_search_projection WHERE kind_keys <> ''`,
)).rows[0]?.n ?? -1);

console.log(JSON.stringify({
  checked: rows.length,
  same,
  diff,
  ok: diff === 0 && rows.length > 0,
  filled,
  emptyRemaining,
  samples,
}, null, 2));
await drv.pool.end();
