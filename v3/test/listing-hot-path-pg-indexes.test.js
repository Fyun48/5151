// listings hot path 索引（PG 側缺席補建）＋ loose index scan fallback 的守門測試。
//
// 背景（2026-10-12 唯讀實測正式庫 casa `5151-postgres-A`／DB `5151_shadow`）：
//   • `to_regclass('idx_listings_search')` → NULL；`pg_indexes` 上 listings 的 12 條索引裡
//     **沒有任何一條**是 db.js 宣告的名字 ⇒ #730 的 loose index scan 每請求都退回 DISTINCT
//     （正式庫 EXPLAIN 225ms／次、`pg_stat_statements` 累計 2,244 次）。
//   • 沒有索引時走 loose scan 是災難：同一條 recursive SQL 正式庫實測 15,217ms（差 67 倍）。
///    ⇒ 所以「有索引才走 loose、沒有就退回 DISTINCT」這個 fallback 是**保命設計**，
//      本檔就是要把它釘住，順便證明新補的啟動確保是冪等且 fail-soft。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { buildListRequestContextFromPg, resetStoredSearchKeysFromPg } from "../src/db.js";
import {
  listingHotPathIndexStatements,
  listingHotPathIndexNames,
  dropListingHotPathIndexStatements,
} from "../src/listingHotPathPgIndexes.js";
import { ensureListingHotPathIndexesForTest } from "../src/db.js";

// 與 data-revision-pg-native.test.js 同形的 fake PG driver：只記錄送出什麼 SQL。
function fakePgDriver({ failOn } = {}) {
  const exec = [];
  const query = [];
  return {
    exec: async (sql) => {
      const text = String(sql);
      exec.push(text);
      if (failOn && text.includes(failOn)) throw new Error(`boom: ${failOn}`);
    },
    query: async (sql, _params = []) => {
      query.push(String(sql));
      return { rows: [] };
    },
    _exec: exec,
    _query: query,
  };
}

// `storedSearchKeysFromPg` 有一個行程內、以 data_revision 版本號為 key 的快取（模組層級）。
// 每個測試都在同一行程裡跑，不清掉的話前一個測試的結果會被下一個沿用，
// 「有索引 vs 無索引」的對照就量不到真正發出的 SQL。用 repo 既有的 reset 入口清乾淨。
beforeEach(() => {
  resetStoredSearchKeysFromPg();
});

// 假的請求 context exec：只回答「探測什麼索引在不在」，其餘一律回空。
// 模仿 buildSearchKeysFromPg 會發出的查詢形狀（settings／user_settings／users／crawl_covers）。
function contextExec({ hasIndex = false, hasTable = true, seen = [] } = {}) {
  return async (sql) => {
    const text = String(sql);
    seen.push(text);
    // #730 的單一探測：同時問 data_revision 表與 idx_listings_search 索引。
    if (/to_regclass\('data_revision'\)/.test(text)) {
      return [{ has_table: hasTable, has_index: hasIndex }];
    }
    // legacy 探測形狀（只有表）：視為有表、無索引。
    if (/to_regclass\('data_revision'\) IS NOT NULL AS has_table/.test(text)) {
      return [{ has_table: hasTable }];
    }
    // 真正的 catalog 讀取：這兩個一定要**先於**下面的 MAX(id) 判斷，
    // 否則 recursive／DISTINCT SQL 會被誤攔成 revision 查詢、回錯形狀。
    if (/WITH RECURSIVE t\(k\)/.test(text)) return [{ search_key: "loose-result" }];
    if (/DISTINCT\s+search_key\s+FROM\s+listings/i.test(text)) return [{ search_key: "distinct-result" }];
    if (/MAX\(id\)/.test(text)) return [{ n: 1 }];
    if (/FROM crawl_covers/.test(text)) return [];
    if (/FROM user_settings/.test(text)) return [];
    if (/FROM users/.test(text)) return [];
    if (/FROM settings/.test(text)) return [];
    return [];
  };
}

// ── 1. fallback：探不到 idx_listings_search ⇒ 必須發 DISTINCT，且**不得**發 recursive SQL ──
test("fallback：探不到 idx_listings_search 時走 DISTINCT search_key，不得發 recursive loose scan", async () => {
  const seen = [];
  await buildListRequestContextFromPg(contextExec({ hasIndex: false, seen }));

  const distinct = seen.filter((sql) => /DISTINCT\s+search_key\s+FROM\s+listings/i.test(sql));
  const loose = seen.filter((sql) => /WITH RECURSIVE t\(k\)/.test(sql));

  assert.equal(distinct.length, 1, "應發一次 SELECT DISTINCT search_key FROM listings");
  assert.equal(loose.length, 0, "無索引時絕對不得走 recursive loose scan（實測慢 67 倍、15,217ms）");
});

// ── 2. 有索引時走 loose（對照組：證明探測真的有分流效果，不是永遠走 DISTINCT）──
test("有索引：探測到 idx_listings_search 時改走 recursive loose scan，且不發 DISTINCT", async () => {
  const seen = [];
  await buildListRequestContextFromPg(contextExec({ hasIndex: true, seen }));

  const distinct = seen.filter((sql) => /DISTINCT\s+search_key\s+FROM\s+listings/i.test(sql));
  const loose = seen.filter((sql) => /WITH RECURSIVE t\(k\)/.test(sql));

  assert.equal(loose.length, 1, "有索引時應走 recursive loose scan");
  assert.equal(distinct.length, 0, "有索引時不應再發全表 DISTINCT");
});

// ── 3. 探測本身失敗（throw）時也要保守退回 DISTINCT，不得放出 loose scan ──
test("fallback：探測查詢丟錯時保守退回 DISTINCT（fail-closed，不放 loose scan）", async () => {
  const seen = [];
  const exec = async (sql) => {
    const text = String(sql);
    seen.push(text);
    if (/to_regclass/.test(text)) throw new Error("探測失敗");
    return [];
  };
  await buildListRequestContextFromPg(exec);

  const loose = seen.filter((sql) => /WITH RECURSIVE t\(k\)/.test(sql));
  assert.equal(loose.length, 0, "探測失敗時不得走 loose scan");
});

// ── 4. 啟動確保冪等：跑兩次不報錯、DDL 只送一輪 ──
test("啟動確保冪等：ensureListingHotPathIndexesForTest 跑兩次只發一輪 DDL", async () => {
  const fake = fakePgDriver();
  await ensureListingHotPathIndexesForTest(fake);
  const afterFirst = fake._exec.length;
  assert.ok(afterFirst > 0, "第一次應發出 CREATE INDEX DDL");

  await ensureListingHotPathIndexesForTest(fake);
  assert.equal(fake._exec.length, afterFirst, "第二次不得再發 DDL（WeakSet 已記住）");
});

// ── 5. fail-soft：DDL 失敗不得外拋（索引缺席時服務仍要以 DISTINCT 跑下去）──
test("fail-soft：CREATE INDEX 失敗時不外拋，只記 warn", async () => {
  const fake = fakePgDriver({ failOn: "CREATE INDEX" });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await assert.doesNotReject(
      ensureListingHotPathIndexesForTest(fake),
      "索引確保失敗不得讓呼叫端失敗（否則服務起不來）",
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((line) => /hot path 索引確保失敗/.test(line)),
    "應留下 warn 痕跡，否則失敗會變成靜默",
  );
});

// ── 6. fail-soft 之後必須「還會再試」：不把失敗記進 WeakSet ──
test("fail-soft：失敗不進 WeakSet，下一個請求仍會重試確保", async () => {
  const fake = fakePgDriver({ failOn: "CREATE INDEX" });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await ensureListingHotPathIndexesForTest(fake);
    const firstAttempts = fake._exec.length;
    await ensureListingHotPathIndexesForTest(fake);
    assert.equal(fake._exec.length, firstAttempts + 1, "失敗後應再試一次（每次一輪）");
  } finally {
    console.warn = originalWarn;
  }
});

// ── 7. DDL 形狀：必須是冪等的 IF NOT EXISTS、非 CONCURRENTLY、且含 idx_listings_search ──
test("DDL 形狀：CREATE INDEX IF NOT EXISTS、不含 CONCURRENTLY、含 idx_listings_search", () => {
  const statements = listingHotPathIndexStatements();
  assert.ok(statements.length > 0, "至少要有一條 hot path 索引");
  // quoteIdent 對安全識別字不加引號，所以實際形狀是未加引號的版本。
  assert.equal(
    statements[0],
    "CREATE INDEX IF NOT EXISTS idx_listings_search ON listings (search_key)",
    "必須是 idx_listings_search ON listings(search_key)",
  );
  for (const sql of statements) {
    assert.match(sql, /CREATE INDEX IF NOT EXISTS/, `每條都要冪等：${sql}`);
    assert.doesNotMatch(sql, /CONCURRENTLY/i, `不得用 CONCURRENTLY（不能跑在交易內、中斷留 INVALID 殘骸）：${sql}`);
  }
  assert.deepEqual(listingHotPathIndexNames(), ["idx_listings_search"]);
});

// ── 8. 回退方法存在且可執行（PR 描述要能照抄）──
test("回退：dropListingHotPathIndexStatements 產生 DROP INDEX IF EXISTS", () => {
  const drops = dropListingHotPathIndexStatements();
  assert.deepEqual(drops, ["DROP INDEX IF EXISTS idx_listings_search"]);
});
