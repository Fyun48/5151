// 產生 `v3/migrations/004_member_listing_stats_indexes.sql` 裡第 3 顆（部分索引）需要烘進
// 謂詞的行政區鍵陣列。
//
// 為什麼要有這支腳本：那顆索引的謂詞是
//   `WHERE NOT ((<district prefix>) = ANY('{...}'::text[]))`
// 而 `allKeys` 來自 `v3/src/regions.js`。planner 用「常數陣列相等」判斷能不能採用部分索引，
// 所以**順序也要相同**（`districtKeyLists([])` 的順序＝`CITIES` 展開順序）。
//
// 用法：
//   node v3/scripts/member-district-prefix-index.mjs --print        # 印出可直接貼進遷移的 SQL
//   node v3/scripts/member-district-prefix-index.mjs --json         # 只印陣列
//   node v3/scripts/member-district-prefix-index.mjs --check <sql檔> # 比對遷移檔內的陣列（CI／測試用）
//
// `--check` 在陣列不一致時 exit 1（給 `v3/test/member-district-prefix-index.test.js` 用）。
import { readFileSync } from "node:fs";
import { districtKeyLists, districtKeyPrefixExpression } from "../src/listDistrictSql.js";

const { allKeys } = districtKeyLists([]);
const prefix = districtKeyPrefixExpression("pg");
const arrayLiteral = `'{${allKeys.join(",")}}'::text[]`;

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);

if (has("check")) {
  const file = argv[argv.indexOf("--check") + 1];
  if (!file) { console.error("usage: --check <sql-file>"); process.exit(2); }
  const text = readFileSync(file, "utf8");
  const found = text.match(/'\{([0-9|,]+)\}'::text\[\]/);
  const expected = allKeys.join(",");
  if (!found) { console.error("migration 內找不到烘進的行政區鍵陣列"); process.exit(1); }
  if (found[1] !== expected) {
    console.error("行政區鍵陣列與 regions.js 不一致（索引將不再被採用，需重新產生）：");
    console.error(`  migration: ${found[1].slice(0, 120)}...`);
    console.error(`  expected : ${expected.slice(0, 120)}...`);
    process.exit(1);
  }
  console.log(`ok: ${allKeys.length} 個行政區鍵與 regions.js 一致`);
  process.exit(0);
}

if (has("json")) { console.log(JSON.stringify(allKeys)); process.exit(0); }

console.log(`-- 第 3 顆索引（部分索引）用的行政區鍵清單：${allKeys.length} 個，順序＝CITIES 展開順序。`);
console.log("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_unknown_district_prefix_pg");
console.log(`  ON listings ((${prefix}))`);
console.log(`  WHERE NOT ((${prefix}) = ANY(${arrayLiteral}));`);
