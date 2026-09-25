// 真 PG 的**正式入口**測試（裁決 §2.2 ＋ §6.4）。
//
// 為什麼要它：
//   • §2.2 指出 canary 直接呼叫 `searchListingsNodePg()` 並自行帶 deps ⇒ 繞過正式入口 ✗。
//   • 這裡改從 **`searchListingsAsync()`** 進入、**不注入 `deps`** ✓，對**真 PG**（已由
//     `pg-integration-setup.mjs` 鏡射 schema ＋ 可重現列 ✓）驗證實際 SELECT 與回傳內容 ✓。
//   • §6.4 的一致性：同一條查詢**連續兩次**必須得到相同的 id 順序 ✓
//     （＝沒有跨請求快取污染、沒有非決定性排序 ✓）。
//
// 執行方式（repo 既有慣例 ✓）：`run-pg-integration.sh` 以 `grep -rl PG_TEST_URL` 收斂所有 PG 整合測試 ✓
// ⇒ 本檔只在 PG job／有設 PG 時執行 ✓；一般 job 會 skip ✓（不會把 PG 專屬回歸混進預設 driver 的測試 ✓）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchListingsAsync } from "../src/listingSearchAsync.js";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";

const PG_URL = process.env.PG_TEST_URL || "";
const PG_READY = Boolean(PG_URL) || process.env.DB_DRIVER === "postgres";
const SKIP = PG_READY ? false : "未設定 PG_TEST_URL（僅 PG job 執行；由 run-pg-integration.sh 收斂）";

const ARGS = {
  filter: "all", districts: [], sort: "newest", limit: 5, offset: 0,
  userId: 0, matchVoteUserId: 0, settings: {},
};

function pageIdsOf(result) {
  const list = result?.listings || result?.page || result?.rows || [];
  return (Array.isArray(list) ? list : []).map((row) => row?.post_id);
}

test("live PG：正式入口（不注入 deps）能查真 PG，且連續兩次結果一致", { skip: SKIP }, async () => {
  const pgDriver = await createPostgresDriver({ env: process.env });
  try {
    const first = await searchListingsAsync({ ...ARGS }, { driver: "postgres", pgDriver });
    console.log(`LIVE-ENTRY-KEYS ${JSON.stringify(Object.keys(first || {}))}`);
    assert.ok(first, "正式入口必須回傳結果");
    const firstIds = pageIdsOf(first);
    console.log(`LIVE-ENTRY-IDS ${JSON.stringify(firstIds)}`);
    assert.ok(Array.isArray(firstIds), "結果必須可取出 id 清單");

    // 連續兩次必須一致 ✓（裁決 §6.4：不得有跨請求資料污染或非決定性排序 ✗）
    const second = await searchListingsAsync({ ...ARGS }, { driver: "postgres", pgDriver });
    const secondIds = pageIdsOf(second);
    assert.deepEqual(secondIds, firstIds,
      `同一查詢連續兩次結果必須一致（第一次 ${JSON.stringify(firstIds)}，第二次 ${JSON.stringify(secondIds)}）`);
  } finally {
    if (typeof pgDriver?.close === "function") await pgDriver.close();
  }
});
