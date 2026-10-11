// 讀取路徑的 `mrt_cache` contract 升級必須以「**行程內穩定的身分**」記憶（修 lock convoy）。
//
// 根因：`mrtCacheSchema.ensureMrtCacheContractForRead()` 原本以 `exec` 的**函式身分**做 WeakMap
// key，但讀取路徑的 `exec` 是**每個請求新建的閉包**（`listingDetailAsync.js`：
// `const exec = options.exec || ((sql, params = []) => pgDriver.query(...))`），
// driver 才是行程內單例（`pgSharedDriver.js`）。⇒ memo 永不命中 ⇒ 每個詳情／通勤／診斷頁請求
// 都送 4 條 `ALTER TABLE mrt_cache ADD COLUMN IF NOT EXISTS`。正式站 `mrt_cache` 有 42,664 列、
// 那 4 欄（`source`／`checked`／`walk_m`／`searched_m`）全都已存在 ⇒ 4 條全是 no-op，
// 但**每條都要取 `ACCESS EXCLUSIVE` 鎖**，與爬蟲／enrich 寫入互相排隊。
//
// 這一支是**迴數斷言**：注入計數用的假 `exec`（**每個請求一個新的閉包**，照 production 的形狀），
// 跑 N 次詳情頁讀取路徑，斷言那 4 條 DDL 只被送**一輪**。
// 修前：5 次請求 ⇒ 20 條 ALTER；修後：5 次請求 ⇒ 4 條（＝1 輪）。
//
// 這支測試**刻意離線**（不碰真 PG、檔內不得出現 PG 連線字串）——它是這個修正的核心交付。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR 必須在 import db.js 之前就位（db.js 在模組頂層決定資料檔位置）。
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "v3-mrt-read-memo-"));

const { getListingAsync } = await import("../src/listingDetailAsync.js");
const { ensureMrtCacheContractForRead, MRT_CACHE_PG_COLUMNS } = await import("../src/mrtCacheSchema.js");

const COLUMNS = MRT_CACHE_PG_COLUMNS.length; // 4
const DDL_RE = /ALTER TABLE mrt_cache/i;
const REQUESTS = 5;

const ROW = { post_id: 424242, source: "591", title: "合成住宅", price: 25000, listed_by_user_id: 1 };
const SETTINGS = { showMrt: false, systemCrawl: () => ({ showMrt: false }) };

// 一個「每次呼叫都新建」的注入式 exec——就是 production 每個請求都新建的那個閉包。
// 只計數 DDL，其餘一律回空陣列（裝飾資料的 SELECT 在離線夾具裡不需要真資料）。
function countingExec(seen) {
  const exec = async (sql) => {
    if (DDL_RE.test(String(sql))) seen.push(String(sql));
    return [];
  };
  return exec;
}

const fakeDriver = () => ({ query: async () => ({ rows: [] }), exec: async () => {} });

const detailOptions = (exec, pgDriver) => ({
  driver: "postgres",
  pgDriver,
  exec,
  settings: SETTINGS,
  repository: { hydrate: async () => [ROW] },
  deps: { resolveUserId: () => 1, getSettings: () => SETTINGS },
  sameHouse: false,
});

test(`詳情頁 ${REQUESTS} 次讀取（同一個 pgDriver、每次新建 exec 閉包）⇒ ALTER 只送一輪`, async () => {
  const pgDriver = fakeDriver(); // 行程內穩定的身分（production 是 sharedPgDriver() 的單例）
  const ddl = [];
  for (let i = 0; i < REQUESTS; i += 1) {
    const out = await getListingAsync(ROW.post_id, 1, detailOptions(countingExec(ddl), pgDriver));
    assert.equal(out?.post_id, ROW.post_id, `第 ${i + 1} 次詳情讀取要正常回傳（不能被 short-circuit 成假的綠）`);
  }
  const rounds = ddl.filter((sql) => /ADD COLUMN IF NOT EXISTS source/.test(sql)).length;
  assert.equal(
    ddl.length,
    COLUMNS,
    `${REQUESTS} 次詳情讀取只該送一輪 DDL（${COLUMNS} 條），實際 ${ddl.length} 條`
      + `（修前＝每個請求各一輪＝${REQUESTS * COLUMNS} 條）`,
  );
  assert.equal(rounds, 1, `ALTER TABLE mrt_cache 的升級輪數必須是 1，實際 ${rounds}`);
  assert.deepEqual(ddl, MRT_CACHE_PG_COLUMNS, "送出的 4 條 DDL 要逐字等於 MRT_CACHE_PG_COLUMNS（一條都不准少）");
});

test("多 driver 實例：每個實例各自一輪（不是每個請求一輪）", async () => {
  const ddl = [];
  const first = fakeDriver();
  const second = fakeDriver();
  for (let i = 0; i < 3; i += 1) await ensureMrtCacheContractForRead(countingExec(ddl), first);
  for (let i = 0; i < 3; i += 1) await ensureMrtCacheContractForRead(countingExec(ddl), second);
  assert.equal(
    ddl.length,
    2 * COLUMNS,
    `兩個 driver 實例各一輪（${2 * COLUMNS} 條），實際 ${ddl.length} 條`
      + `（修前：6 個 exec 各一輪＝${6 * COLUMNS} 條）`,
  );
});

test("只注入假 exec、完全沒有 driver 身分：整個行程仍然最多一輪", async () => {
  const ddl = [];
  for (let i = 0; i < REQUESTS; i += 1) await ensureMrtCacheContractForRead(countingExec(ddl));
  assert.equal(
    ddl.length,
    COLUMNS,
    `沒有 driver 身分時退回模組級單飛 ⇒ ${REQUESTS} 個假 exec 也只跑一輪，實際 ${ddl.length} 條`
      + `（修前：每個假 exec 各一輪＝${REQUESTS * COLUMNS} 條）`,
  );
});

test("通勤快照路徑（listingCommuteAsync）5 次讀取 ⇒ 一樣只送一輪（同一條根因的另一個入口）", async () => {
  const { listingCommutePatchesAsync } = await import("../src/listingCommuteAsync.js");
  const pgDriver = fakeDriver();
  const ddl = [];
  for (let i = 0; i < REQUESTS; i += 1) {
    // 每個請求一個新的 exec 閉包（照 production 的形狀）：只有 listings 那一句回得出列，
    // 其餘裝飾資料的 SELECT 在離線夾具裡回空。
    const exec = async (sql) => {
      const text = String(sql);
      if (DDL_RE.test(text)) {
        ddl.push(text);
        return [];
      }
      if (/FROM listings/i.test(text)) return [ROW];
      return [];
    };
    const patches = await listingCommutePatchesAsync([ROW.post_id], 1, {
      driver: "postgres",
      pgDriver,
      exec,
      settings: SETTINGS,
    });
    assert.equal(patches.length, 1, `第 ${i + 1} 次通勤讀取要回得出那一筆（不能被 short-circuit 成假的綠）`);
  }
  assert.equal(
    ddl.length,
    COLUMNS,
    `通勤路徑 ${REQUESTS} 次讀取也只該送一輪 DDL（${COLUMNS} 條），實際 ${ddl.length} 條`,
  );
});

test("升級失敗不快取：下一次讀取會再試（既有容錯語意不變弱）", async () => {
  const pgDriver = fakeDriver();
  let attempts = 0;
  const refusingExec = async (sql) => {
    if (DDL_RE.test(String(sql))) {
      attempts += 1;
      // 離線夾具的 exec 收到不認識的 DDL 會丟：升級失敗**不得**讓讀取整批掛掉，也不得被快取。
      throw new Error("離線夾具拒絕 DDL");
    }
    return [];
  };
  for (let i = 0; i < REQUESTS; i += 1) {
    const out = await getListingAsync(ROW.post_id, 1, detailOptions(refusingExec, pgDriver));
    assert.equal(out?.post_id, ROW.post_id, "升級失敗時讀取本身仍要正常（best-effort，交給後面的 SELECT 用 42703 明講）");
  }
  assert.equal(attempts, REQUESTS, `失敗不快取 ⇒ ${REQUESTS} 次讀取各再試一次，實際 ${attempts} 次`);
});
