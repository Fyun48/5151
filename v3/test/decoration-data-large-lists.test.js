import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadGroupIds,
  loadListingExtras,
  loadListingPrepMap,
  loadPeerRows,
} from "../src/repository/decorationData.js";

// astra 2026-09-25 §5.1／§5.2：`= ANY(?::bigint[])` 的修正必須有「真的跑到四個 loader」的大清單測試，
// 而且要用**真正的 params.length／placeholder 數**說話（PG 16 的上限是 **65,535**，不是 32,767 ✗）。
//
// 這裡用假 exec 記錄實際送出的 SQL 與參數：
//   • PG：不論 N 多大，參數**永遠只有 1 個**（陣列綁定）⇒ 結構上不可能再撞參數上限 ✓
//   • SQLite：維持 IN (?,?…)（N 個參數）—— 這是既有行為，但 SQLite 也有變數上限，
//     列為後續觀察項（本檔只鎖住「PG 不再隨 N 成長」）。
const SIZES = [1, 1000, 32768, 65536, 200000];

function recordingExec(rowsFor) {
  const calls = [];
  const exec = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    const ids = Array.isArray(params[0]) ? params[0] : params;
    return (rowsFor ? rowsFor(ids, text) : ids.map((id) => ({ post_id: Number(id) })));
  };
  return { exec, calls };
}

const LOADERS = [
  { name: "loadGroupIds", run: (exec, ids) => loadGroupIds(exec, ids, "postgres") },
  { name: "loadListingPrepMap", run: (exec, ids) => loadListingPrepMap(exec, ids, "postgres") },
  { name: "loadListingExtras", run: (exec, ids) => loadListingExtras(exec, ids, "postgres") },
  { name: "loadPeerRows", run: (exec, ids) => loadPeerRows(exec, ids, "postgres") },
];

for (const loader of LOADERS) {
  for (const size of SIZES) {
    test(`${loader.name}：PG 在 ${size} 個 id 時只綁 1 個陣列參數（不隨 N 成長）`, async () => {
      const ids = Array.from({ length: size }, (_, i) => i + 1);
      const { exec, calls } = recordingExec(null);
      await loader.run(exec, ids);
      assert.ok(calls.length >= 1, "必須真的送出查詢");
      for (const call of calls) {
        assert.match(call.sql, /=\s*ANY\(\?::bigint\[\]\)/i, `PG 必須用 ANY 陣列綁定：${call.sql.slice(0, 120)}`);
        // loadPeerRows 有兩個 ANY 子句（post_id／match_post_id）⇒ 常數級（≤2）而非固定 1。
        assert.ok(call.params.length <= 2, `參數數量必須是常數級（實際 ${call.params.length}）`);
        assert.ok(call.params.every((p) => Array.isArray(p)), "每個參數都必須是陣列（不得回退成純量清單）");
        for (const param of call.params) {
          assert.equal(param.length, ids.length, "陣列內容必須是完整 id 清單");
        }
        // SQL 文字本身不得隨 N 成長（否則就是又回到上萬個 placeholder）
        assert.ok(call.sql.length < 600, `SQL 長度不應隨 N 成長（實際 ${call.sql.length}）`);
        assert.equal((call.sql.match(/\?/g) || []).length <= 3, true, "placeholder 數量必須是常數級");
      }
    });
  }
}

test("大型清單的回讀集合完整（不得因綁定方式而漏列）", async () => {
  const size = 70000;   // > 65,535，遠超任何「單句參數」上限
  const ids = Array.from({ length: size }, (_, i) => i + 1);
  const { exec } = recordingExec((bound) => bound
    .filter((id) => id % 7 === 0)               // 只回一部分列
    .map((id) => ({ post_id: id, group_id: `g${id}` })));
  const map = await loadGroupIds(exec, ids, "postgres");
  const expected = ids.filter((id) => id % 7 === 0).length;
  assert.equal(map.size, expected, `回讀必須完整（期望 ${expected}，實際 ${map.size}）`);
  assert.equal(map.get(7), "g7");
});

test("SQLite 路徑維持原本的 IN (?,?…)（本檔僅記錄現狀，不改行為）", async () => {
  const ids = [1, 2, 3];
  const { exec, calls } = recordingExec(null);
  await loadListingPrepMap(exec, ids, "sqlite");
  assert.match(calls[0].sql, /IN \(\?,\?,\?\)/);
  assert.equal(calls[0].params.length, 3, "SQLite 仍是 N 個純量參數");
});

test("空清單不送出查詢（四個 loader 皆同）", async () => {
  for (const loader of LOADERS) {
    const { exec, calls } = recordingExec(null);
    await loader.run(exec, []);
    assert.equal(calls.length, 0, `${loader.name} 不應為空清單送出查詢`);
  }
});
