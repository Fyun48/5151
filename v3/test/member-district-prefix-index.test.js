// 行政區前綴索引（`v3/migrations/004_member_listing_stats_indexes.sql`）的**離線**守門測試。
//
// 第 3 顆索引是部分索引，謂詞裡**逐字烘進** `regions.js` 展開後的 367 個行政區鍵
// （`WHERE NOT ((<prefix>) = ANY('{...}'::text[]))`），而且順序必須與 `districtKeyLists([])`
// 相同，planner 才會採用（它用常數陣列相等判斷蘊含）。
//
// `regions.js` 一旦變動而遷移檔沒跟著重生成，索引就只是**不再被採用**（結果仍然正確，
// 因為 planner 證明不了蘊含時不會用它、程式端的述詞照舊），但 `prepare` 會悄悄退化為全表掃描。
// 這一條測試就是用來擋住那種「沒人發現的效能退化」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { districtKeyLists } from "../src/listDistrictSql.js";

const MIGRATION = new URL("../migrations/004_member_listing_stats_indexes.sql", import.meta.url);

test("遷移檔烘進的行政區鍵陣列與 regions.js 一致（含順序）", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const all = sql.match(/'\{([0-9|,]+)\}'::text\[\]/g) || [];
  assert.equal(all.length, 1, "遷移檔應恰好有一個烘進的行政區鍵陣列");
  const baked = all[0].slice(2, -"}'::text[]".length);
  assert.equal(baked, districtKeyLists([]).allKeys.join(","),
    "陣列不一致 ⇒ 部分索引不會被採用（prepare 會退回全表掃描）；請重跑 "
    + "`node v3/scripts/member-district-prefix-index.mjs --print` 更新遷移檔");
});

test("三顆索引都以 CONCURRENTLY IF NOT EXISTS 建立（可在連線中的庫上重跑）", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  for (const name of ["idx_listings_district_prefix_pg", "idx_route_jobs_failed", "idx_listings_unknown_district_prefix_pg"]) {
    assert.match(sql, new RegExp(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}\\b`), `${name} 應以 CONCURRENTLY IF NOT EXISTS 建立`);
  }
  assert.equal(/BEGIN|COMMIT/i.test(sql.replace(/^--.*$/gm, "")), false, "CONCURRENTLY 不能在交易區塊內");
});
