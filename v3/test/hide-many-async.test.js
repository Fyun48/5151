// hideMany 的 PG 分支（2026-09-27，PG 島嶼批次 1）。
//
// 背景：`POST /api/listings/hide-many` 原本只呼叫 `db.js` 的同步 `hideMany()`，所以會員
// 「勾選多筆隱藏」寫進的是**回答他那台節點的本機 SQLite**。實測（2026-09-27 05:17Z）：
// user 2 隱藏 listing 22075980，只寫進 CasaOS 的檔案，另一台看不到——公開站經 HAProxy
// 兩台輪流，所以隱藏可能失效。這是活的正确性問題，不只是收尾債。
//
// 這個檔要釘住的是**新行為**，不是重測 setFlags：
//   1. driver 不是 postgres 時走同步分支，不得碰 PG。
//   2. 多筆寫入必須在**同一個交易**內（與同步版的 BEGIN…COMMIT 對應），
//      而不是每筆各開一個交易。
//   3. id 正規化：去重、濾掉 <= 0 與非數字。
//
// ⚠️ 這裡**沒有**測試 setFlags 本身的寫入內容——那個函式目前仍然沒有專屬測試，
//    是已知缺口，已在文件中記錄，不假裝這裡涵蓋了。
import test from "node:test";
import assert from "node:assert/strict";

import { hideMany, hideManyAsync, normalizeHideIds } from "../src/personalFlagsAsync.js";

// 假的 pgDriver：同時提供 query（給 setFlags／stats 用）與 withTransaction（用來數交易次數）。
function fakePgDriver() {
  const state = { transactions: 0, queries: [] };
  const query = async (sql, params) => {
    state.queries.push({ sql: String(sql), params });
    return { rows: [] };
  };
  return {
    state,
    query,
    async withTransaction(fn) {
      state.transactions += 1;
      return fn({ query });
    },
  };
}

// getListingAsync 接受注入 repository，這是唯一需要假造房源的接縫。
//
// ⚠️ 第一版這裡回傳 null（找不到房源），結果 setFlags() 提早 return、**根本沒開交易**，
// 於是「只開一個交易」的斷言在「每筆各開一個交易」的變異下**照樣通過**——是一個空測試。
// 變異測試抓到了這點。現在回傳一個 truthy 的空物件，讓流程真的走到交易。
const foundRepo = { hydrate: async ([id]) => [{ post_id: id, offline: 0, hidden: 0, source: "591", title: "t", price_num: 1 }] };
const emptyRepo = { hydrate: async () => [] };

test("driver 不是 postgres 時必須走同步分支，不得碰 PG", async () => {
  let pgUsed = 0;
  const pgDriver = { query: async () => { pgUsed += 1; return { rows: [] }; }, withTransaction: async () => { pgUsed += 1; } };
  // 同步分支會碰到真的 SQLite（測試環境是暫存 DATA_DIR），但**不該**碰到這個 pgDriver。
  await hideManyAsync([], 1, { driver: "sqlite", pgDriver });
  assert.equal(pgUsed, 0, "driver=sqlite 時不得使用 PG driver");
});

test("多筆寫入必須在單一交易內，不是每筆各開一個", async () => {
  const pgDriver = fakePgDriver();
  const ids = [11, 12, 13, 14, 15];
  // 最後的 stats 階段需要完整的 listings 夾具，這個測試不建它，所以預期會在那裡失敗。
  // 重點是：交易必須在 stats 之前就已經只開了一次。
  await hideMany(ids, 1, { driver: "postgres", pgDriver, repository: foundRepo }).catch(() => {});
  assert.equal(
    pgDriver.state.transactions,
    1,
    `5 筆應該只開 1 個交易（與同步版的 BEGIN…COMMIT 對應），實際開了 ${pgDriver.state.transactions} 個`,
  );
});

test("id 正規化：去重、濾掉 0／負數／非數字", () => {
  assert.deepEqual(normalizeHideIds([0, -1, 5, 5, "7", "abc", null]), [5, 7]);
  assert.deepEqual(normalizeHideIds([]), []);
  assert.deepEqual(normalizeHideIds(undefined), []);
  assert.deepEqual(normalizeHideIds([3.9]), [3.9], "維持原值，不在這裡做整數化");
});

test("全部無效時不得發出任何寫入，但仍走同一個交易路徑", async () => {
  const pgDriver = fakePgDriver();
  await hideMany([0, -3, "x"], 1, { driver: "postgres", pgDriver, repository: foundRepo }).catch(() => {});
  assert.equal(pgDriver.state.transactions, 1, "空清單仍走同一個交易路徑（與同步版一致）");
  const writes = pgDriver.state.queries.filter((q) => /insert into user_listing_flags/i.test(q.sql));
  assert.equal(writes.length, 0, "沒有有效 id 就不該有任何旗標寫入");
});

test("回傳形狀必須與同步版一致（count 與 stats 兩個欄位）——用可完成的 stats 夾具", async () => {
  const pgDriver = fakePgDriver();
  const out = await hideMany([21], 1, {
    driver: "postgres",
    pgDriver,
    repository: emptyRepo,
    // 跳過 loadPgListingStatsInputs（它需要完整 listings 夾具），直接餵最小輸入。
    preloadedStatsInputs: {
      rows: [], flagMap: new Map(), uid: 1, settings: {}, statusCounts: {},
      watchedTotal: 0, failedRouteJobs: 0, dbTotal: 0,
    },
    decorationProvider: { personalFlags: () => new Map() },
  });
  assert.deepEqual(Object.keys(out).sort(), ["count", "stats"], "回傳鍵必須是 count 與 stats");
  assert.equal(out.count, 1);
});
