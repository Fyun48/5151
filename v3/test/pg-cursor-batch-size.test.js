// 快照游標批次大小的契約測試（本包第 4 步：`FETCH FORWARD 1024` 的成本）。
//
// 正式站 `pg_stat_statements` 實測：`FETCH FORWARD 1024 FROM listing_read_N` 4,123 calls／
// avg 73ms／合計 301s。那個 1024 來自 `pgReadSnapshot.js` 的批次上限，而該上限對**窄讀取**
// （`SELECT post_id` 這類 1–3 欄）而言等於丟掉既有的 cell 預算，讓每次 id 掃描要多跑十幾趟。
//
// 契約：**cell 預算不變**（512 列 × 42 欄 ＝ 21,504）。寬讀取逐字不變；只有窄讀取放大。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cursorFetchBatchSize } from "../src/pgReadSnapshot.js";

const CELL_BUDGET = 512 * 42;

test("寬讀取的批次大小逐字不變（42 欄＝512、36 欄＝597、20 欄＝1,075）", () => {
  assert.equal(cursorFetchBatchSize(42), 512, "canonical 42 欄候選列不得改變");
  assert.equal(cursorFetchBatchSize(36), 597, "公開候選 36 欄不得改變");
  assert.equal(cursorFetchBatchSize(21), 1024, "20 欄以上仍是原本的上限值");
  assert.equal(cursorFetchBatchSize(20), 1075, "20 欄原本就低於舊上限（1,024 → 1,075 只多 51 列）");
});

test("窄讀取放大到 8,192 列，但 cell 數仍遠低於預算", () => {
  assert.equal(cursorFetchBatchSize(1), 8192, "id-only 掃描");
  assert.equal(cursorFetchBatchSize(2), 8192);
  assert.equal(cursorFetchBatchSize(3), 7168);
  for (const fields of [1, 2, 3, 5, 10, 20]) {
    const size = cursorFetchBatchSize(fields);
    assert.ok(size >= 512, "不得低於 512");
    assert.ok(size <= 8192, "不得超過 8,192 列");
    assert.ok(size * fields <= CELL_BUDGET, `${fields} 欄 × ${size} 列超出 cell 預算`);
  }
});

test("id-only 掃描的來回趟數：12,712 列從 13 趟降到 3 趟", () => {
  const rows = 12712;
  const fetches = (size) => {
    let remaining = rows; let trips = 1; let batch = 512; // 第一趟固定 512（暖身）
    remaining -= 512;
    while (remaining > 0) { batch = Math.min(size, remaining); trips += 1; remaining -= batch; }
    return trips;
  };
  assert.equal(fetches(1024), 13);
  assert.equal(fetches(cursorFetchBatchSize(1)), 3);
});

test("pgReadSnapshot 必須使用這支函式（不得又出現硬編的上限）", () => {
  const source = readFileSync(new URL("../src/pgReadSnapshot.js", import.meta.url), "utf8");
  assert.match(source, /batchSize = cursorFetchBatchSize\(batch\.fields\.length\)/);
  assert.equal(/Math\.min\(1024,/.test(source), false, "不得再出現硬編的 1024 上限");
});
