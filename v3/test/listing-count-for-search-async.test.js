// listingCountForSearch 的 driver-aware 非同步入口（2026-10-09，sqlite-exit batch A）。
//
// 背景：watcher.js 落地階段逐批呼叫 db.js 的同步 `listingCountForSearch(batch.searchUrl)`
// 來判斷「這一組搜尋是不是基線（第一次出現）」，結果寫進 searchReports[].baseline 並
// 控制通知佇列。DB_DRIVER=postgres 時，persistListing() 已經寫進 PostgreSQL，但這個讀取
// 仍走同步 SQLite handle —— 開閘（PG_NO_SQLITE_OPEN=1）時在 db.js storedSearchKeys() 的
// prepare 直接炸（`business SQLite is closed`）。crawlerReads.listingCountForSearchAsync()
// 是這條同步路徑的 PG 對應：PG 讀同一組 DISTINCT + COUNT、跑同一支純展開
// expandSearchKeysAgainst()，零語意漂移；SQLite 模式逐字委託原同步函式。
//
// 本檔釘住的是**新行為**，不是重測同步版：
//   1. PG 路徑只用 pgDriver（記錄到的 SQL 只有 DISTINCT + COUNT 兩條），不碰 SQLite。
//   2. 回傳的是真實計數——把 DISTINCT 回傳空、或 COUNT 回傳 0 的「假綠」會被抓到。
//   3. SQLite 模式委託原同步函式（結果與 db.js 同步版相同）。
//   4. 兩 driver 在同一份資料上同值（parity）。
import test from "node:test";
import assert from "node:assert/strict";
import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// db.js 在 import 時就初始化 SQLite（DATA_DIR），所以先指向獨立暫存目錄再 import。
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-lcfs-"));
process.env.DATA_DIR = dataDir;
delete process.env.PG_NO_SQLITE_OPEN;
process.env.DB_DRIVER = "sqlite";
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const crawlerReads = await import("../src/crawlerReads.js");
const dbjs = await import("../src/db.js");

const K1 = "https://rent.591.com.tw/?regionid=1&section=3";
const K1_ALIAS = "https://rent.591.com.tw/?regionid=1&section=3&kind=2"; // sameSearch(K1, K1_ALIAS) === true

// 資料驅動的 fake pgDriver：DISTINCT 回傳 listings 裡去重後的 search_key，COUNT 回傳
// params（展開後的 keys）命中的列數。記錄每一條 SQL 與 params，供斷言「只碰 PG、展開正確」。
function fakePgDriverFromListings(listings) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params: [...params] });
      if (/DISTINCT\s+search_key/i.test(String(sql))) {
        const distinct = [...new Set(listings.map((l) => l.search_key))];
        return { rows: distinct.map((search_key) => ({ search_key })) };
      }
      if (/COUNT\(\*\)/i.test(String(sql))) {
        const n = listings.filter((l) => params.includes(l.search_key)).length;
        return { rows: [{ n: String(n) }] };
      }
      return { rows: [] };
    },
  };
}

function seedSqlite(pairs) {
  let id = 500000;
  const stamp = "2026-10-01T00:00:00.000Z";
  for (const [searchKey, count] of pairs) {
    for (let i = 0; i < count; i += 1) {
      id += 1;
      dbjs.upsertListing({
        post_id: id,
        source: "591",
        source_id: String(id),
        source_key: `1|8|${id}`,
        search_key: searchKey,
        title: `合成住宅 ${id}`,
        url: `https://example.test/listing/${id}`,
        price: "25000元",
        price_num: 25000,
        extra_fee: 0,
        extra_fees: [],
        cover: "https://example.test/cover.png",
        tags: "[]",
        address: "台北市士林區測試路",
        area_name: "20坪",
        layout: "2房1廳1衛",
        floor_name: "5/12",
        kind_name: "整層住家/電梯大樓",
        role_name: "",
        refresh_time: stamp,
        first_seen_at: stamp,
        last_seen_at: stamp,
        last_event: "new",
        lat: 25.11,
        lng: 121.52,
      });
    }
  }
}

test("PG 路徑只發 DISTINCT + COUNT 兩條 PG 查詢、跑同支純展開，且回傳真實計數（假綠會被抓到）", async () => {
  crawlerReads.resetSearchKeyCountMemoForTest();
  // listings 有 7 筆，分散在 K1 與其 same-search 別名 K1_ALIAS 下。
  const listings = [
    { search_key: K1 }, { search_key: K1 }, { search_key: K1 },
    { search_key: K1_ALIAS }, { search_key: K1_ALIAS }, { search_key: K1_ALIAS }, { search_key: K1_ALIAS },
  ];
  const fake = fakePgDriverFromListings(listings);

  const result = await crawlerReads.listingCountForSearchAsync(K1, { driver: "postgres", pgDriver: fake });

  // 回傳空陣列 / 回傳 0 的「假綠」會被這裡抓到：正確答案是 7（K1 3 筆 + 別名 4 筆）。
  assert.equal(result, 7, "PG 路徑要回傳真實計數，不是空陣列或 0");

  // 只碰 PG：只有 DISTINCT 與 COUNT 兩條查詢，且都打在 pgDriver 上。
  assert.equal(fake.calls.length, 2, "PG 路徑只該發兩條查詢");
  assert.match(fake.calls[0].sql, /DISTINCT\s+search_key/i, "第一條是 DISTINCT search_key");
  assert.match(fake.calls[1].sql, /COUNT\(\*\)/i, "第二條是 COUNT(*)");

  // 展開正確：DISTINCT 回傳 K1_ALIAS，與輸入 K1 是 same-search，所以 COUNT 的 IN 清單要含兩者。
  assert.equal(fake.calls[1].params.length, 2, "展開後 IN 清單應有輸入鍵 + 別名共 2 個");
  assert.ok(fake.calls[1].params.includes(K1), "IN 清單要含輸入鍵");
  assert.ok(fake.calls[1].params.includes(K1_ALIAS), "IN 清單要含 same-search 別名");
});

test("SQLite 模式逐字委託同步 listingCountForSearch（結果與 db.js 同步版相同）", async () => {
  seedSqlite([[K1, 3], [K1_ALIAS, 4]]);
  const syncResult = dbjs.listingCountForSearch(K1);
  const asyncResult = await crawlerReads.listingCountForSearchAsync(K1, { driver: "sqlite" });
  assert.equal(asyncResult, syncResult, "SQLite 模式要委託同步版、同值");
  assert.equal(syncResult, 7, "同步版展開後計數為 7（3 + 4）");
});

test("parity：同一份資料上 PG 路徑與 SQLite 同步版同值", async () => {
  crawlerReads.resetSearchKeyCountMemoForTest();
  seedSqlite([[K1, 3], [K1_ALIAS, 4]]);
  const listings = [
    { search_key: K1 }, { search_key: K1 }, { search_key: K1 },
    { search_key: K1_ALIAS }, { search_key: K1_ALIAS }, { search_key: K1_ALIAS }, { search_key: K1_ALIAS },
  ];
  const fake = fakePgDriverFromListings(listings);
  const syncResult = dbjs.listingCountForSearch(K1);
  const pgResult = await crawlerReads.listingCountForSearchAsync(K1, { driver: "postgres", pgDriver: fake });
  assert.equal(pgResult, syncResult, "PG 與 SQLite 在同資料上要同值");
  assert.equal(pgResult, 7, "兩邊都該回 7");
});
