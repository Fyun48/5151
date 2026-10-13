// route_cache 讀取的**鍵清單分批**護欄（2026-10-13，會員列表剩餘成本歸因的「一刀」）。
//
// 為什麼要這支離線測試：分批的收益要在真 PG 上才看得到（計畫從 59MB 平行 Seq Scan 變成
// `Bitmap Index Scan on route_cache_pkey`，見 v3/scripts/route-cache-chunk-probe.mjs），
// 但**分批的契約**不需要 PG 就能鎖住：
//   • 每一條送出的語句，鍵數不得超過 `MAX_KEYS_PER_STATEMENT`
//   • 全部鍵仍然都要被查到（不得因為分批而漏 key／漏列）
//   • 回傳值逐列與「不分批的參考實作」相同（同一組 key、同一組列、缺列不回）
//   • PG 端每條語句仍然只有一個陣列參數（不是把鍵展開成 N 個參數）
//
// ⚠️ 這支測試在改動前會紅（3000 個鍵只送出一條語句）——先紅後綠是這一包的驗收之一。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRouteCacheEntries } from "../src/repository/decorationData.js";

// 契約上界（**刻意寫死在測試裡**）：`v3/src/repository/decorationData.js` 的
// `MAX_KEYS_PER_STATEMENT` 必須 ≤ 這個值。它不只是「整數」——實測 1280 仍走索引、1536 起
// PG 會翻成 59MB 表的平行 Seq Scan（見 v3/scripts/route-cache-chunk-probe.mjs），
// 所以調高它會讓這一刀失效；調低只是多幾個來回。
const MAX_KEYS_PER_STATEMENT = 1024;

/** 假 exec：記下每一條語句的鍵清單，並只回有值的 key（模擬「缺列不回」）。 */
function recordingExec(rowsByKey) {
  const seen = [];
  const exec = async (sql, params = []) => {
    const keys = Array.isArray(params[0]) ? params[0] : params;
    seen.push({ sql: String(sql), params, keys: [...keys] });
    return keys.filter((key) => rowsByKey.has(key)).map((key) => ({
      route_key: key, distances: "[]", min_km: rowsByKey.get(key), min_m: 100, rush_am_min: 1, rush_pm_min: 2, rush_updated_at: "t",
    }));
  };
  return { exec, seen };
}

const KEYS = Array.from({ length: 3000 }, (_, i) => `v2:to_work:scooter:${i},0>1,1`);
const ROWS = new Map(KEYS.map((key, i) => [key, i % 7 === 0 ? null : i + 0.5]).filter(([, v]) => v !== null));

test("route_cache 讀取：鍵清單分批，每批不超過 MAX_KEYS_PER_STATEMENT", async () => {
  const { exec, seen } = recordingExec(ROWS);
  const map = await loadRouteCacheEntries(exec, KEYS, "postgres");

  assert.equal(ROWS.size, 3000 - Math.ceil(3000 / 7), "夾具自我檢查：確實有缺列");
  assert.ok(seen.length >= 2, `3000 個鍵必須分批送出（實際只有 ${seen.length} 條語句）`);
  for (const call of seen) {
    assert.ok(call.keys.length <= MAX_KEYS_PER_STATEMENT,
      `單一語句的鍵數 ${call.keys.length} 不得超過上限 ${MAX_KEYS_PER_STATEMENT}`);
    assert.ok(call.keys.length > 0, "不得送出空批");
  }
  assert.equal(seen.reduce((sum, call) => sum + call.keys.length, 0), KEYS.length, "所有鍵都必須被查到（不重不漏）");
  // 分批不得改變「查到什麼」：有列的每一列都在，值逐列相同；缺列不進 Map。
  assert.equal(map.size, ROWS.size);
  for (const [key, value] of ROWS) assert.equal(map.get(key).min_km, value, `${key} 的值必須逐列相同`);
});

test("route_cache 讀取：PG 每條語句仍只綁一個陣列參數（不隨鍵數展開）", async () => {
  const { exec, seen } = recordingExec(ROWS);
  await loadRouteCacheEntries(exec, KEYS, "postgres");
  for (const call of seen) {
    assert.match(call.sql, /WHERE route_key = ANY\(\?::text\[\]\)/, "述詞形狀必須逐字不變");
    assert.equal(call.params.length, 1, "PG 端必須維持單一陣列參數");
    assert.ok(Array.isArray(call.params[0]));
  }
});

test("route_cache 讀取：SQLite 端分批後仍是 IN (?,…) 形式，且單句變數數下降", async () => {
  const { exec, seen } = recordingExec(ROWS);
  const map = await loadRouteCacheEntries(exec, KEYS.slice(0, 1500), "sqlite");
  assert.ok(seen.length >= 2);
  for (const call of seen) {
    assert.match(call.sql, /WHERE route_key IN \(\?(,\?)*\)/);
    assert.equal(call.params.length, call.keys.length, "SQLite 端仍是每個鍵一個參數");
    assert.ok(call.params.length <= MAX_KEYS_PER_STATEMENT, "單句變數數必須下降");
  }
  assert.equal(map.size, [...new Set(KEYS.slice(0, 1500))].filter((k) => ROWS.has(k)).length);
});

test("route_cache 讀取：空清單不送任何語句；鍵會先去重", async () => {
  const { exec, seen } = recordingExec(ROWS);
  assert.equal((await loadRouteCacheEntries(exec, [], "postgres")).size, 0);
  assert.equal(seen.length, 0);
  await loadRouteCacheEntries(exec, [KEYS[0], KEYS[0], KEYS[1]], "postgres");
  assert.deepEqual(seen[0].keys, [KEYS[0], KEYS[1]]);
});
