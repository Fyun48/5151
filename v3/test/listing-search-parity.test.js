// 列表搜尋的「同 fixture 雙向 parity」（astra 2026-09-25 裁決 §6.4；§3l 盤點出的**唯一缺口** ✓）。
//
// 為什麼要它：倉庫已有 11 個 `PG_TEST_URL` parity 檔 ✓（budget／crawler-reads／crm／decoration-data／
// job-queue／listing-detail／listing-enrich／listing-fields／listing-similarity-admin／
// listing-state-writes／listing-stats-parity ✓），但**沒有 list search** 的雙向比對 ✗。
//
// 本檔（草稿 ✓，尚未提交 ✗）：同一組 args 下比對 SQLite 與 PG 的
//   集合／`totalMatched`／順序／same-house 角色／個人狀態／分頁 ✓
//
// 待辦（明示 ✗，不假裝完成）：
//   • **B4**：裁決要求把同一 `asOf` 真正傳到相對時間／primary 比較與排序 ✓ —— 目前只放
//     `sort:"newest"` 等固定 args ✗，`asOf` 的參數名與傳遞路徑尚未確認 ✗。
//   • **fail-closed**：缺 provider／缺必要 PG 資料時必須**失敗**而非回空 ✓ —— 尚未實作 ✗。
//   • 回傳 envelope 的鍵以 `SEARCH-KEYS` 輸出實測為準 ✓（容忍多種形狀 ✓，先記錄再收斂 ✓）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchListingsAsync } from "../src/listingSearchAsync.js";

const PG_URL = process.env.PG_TEST_URL || "";
const SKIP = PG_URL ? false : "未設定 PG_TEST_URL（僅 PG job 執行；由 run-pg-integration.sh 收斂）";

const ARGS = {
  filter: "all", districts: [], sort: "newest", limit: 20, offset: 0,
  userId: 0, matchVoteUserId: 0, settings: {},
};

function pageOf(result) {
  const list = result?.listings || result?.page || result?.rows || result?.items || [];
  return Array.isArray(list) ? list : [];
}
function idsOf(result) {
  return pageOf(result).map((row) => row?.post_id);
}
function totalOf(result) {
  const value = result?.totalMatched ?? result?.total ?? result?.count;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}
function rolesOf(result) {
  return pageOf(result).map((row) => String(row?.same_house_role ?? row?.self_role ?? ""));
}

// ✗ 目前**暫時 skip**（明確標示未完成 ✗，不以 skip 冒充通過 ✓）：
//   `74e7800` 的 PG job 已實測紅過 ✓ —— `error: 'PG 結果不得為空（實際 []）'` ✓，
//   即 CI 鏡射 fixture 對這組 args 回**空集合** ⇒ 兩引擎都空 ⇒ 只會「空洞通過」✗。
//   要真的通過，必須**兩邊自建 fixture** ✓（SQLite 用 `app.sqliteHandle()` ✓、PG 用 driver ✓），
//   且鍵必須與**請求 context 的 search-key 展開**相符 ✓（`WHERE search_key IN (…)` ✓，
//   鍵集來自 settings／searchUrls 展開 ✓ ⇒ 需先摸清其形狀 ✓）。
//   ⇒ 接通後再把 skip 拿掉 ✓（列為開放項 ✗）。
test("live PG：列表搜尋雙向 parity（SQLite vs PG）", { skip: SKIP || "尚未接通兩邊自建 fixture（見檔頭待辦）⇒ 目前只會空洞通過，故暫緩" }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const pgDriver = await createPostgresDriver({ env: process.env });
  try {
    const viaPg = await searchListingsAsync({ ...ARGS }, { driver: "postgres", pgDriver });
    const viaSqlite = await searchListingsAsync({ ...ARGS }, { driver: "sqlite" });

    console.log(`PARITY-KEYS-PG ${JSON.stringify(Object.keys(viaPg || {}))}`);
    console.log(`PARITY-KEYS-SQLITE ${JSON.stringify(Object.keys(viaSqlite || {}))}`);
    console.log(`PARITY-IDS-PG ${JSON.stringify(idsOf(viaPg).slice(0, 10))}`);
    console.log(`PARITY-IDS-SQLITE ${JSON.stringify(idsOf(viaSqlite).slice(0, 10))}`);

    // ✗ 禁止「空洞通過」✓：先前兩邊都是 `[]` 也能 deepEqual 通過 ✗ ⇒ 先驗證受測資料前提 ✓
    // （與 `COLAB-INVALID` 同一原則：**受測查詢必須真的回資料** ✓）。
    assert.ok(idsOf(viaPg).length > 0, `PG 結果不得為空（實際 ${JSON.stringify(idsOf(viaPg))}）`);
    assert.ok(idsOf(viaSqlite).length > 0, `SQLite 結果不得為空（實際 ${JSON.stringify(idsOf(viaSqlite))}）`);
    // ① 集合與順序 ✓
    assert.deepEqual(idsOf(viaPg), idsOf(viaSqlite), "id 集合與順序必須一致");
    // ② 總數 ✓
    assert.equal(totalOf(viaPg), totalOf(viaSqlite), "totalMatched 必須一致");
    // ③ same-house 角色／個人狀態 ✓
    assert.deepEqual(rolesOf(viaPg), rolesOf(viaSqlite), "same-house 角色必須一致");
    // ④ 分頁 ✓（offset 一頁）
    const nextPg = await searchListingsAsync({ ...ARGS, offset: ARGS.limit }, { driver: "postgres", pgDriver });
    const nextSqlite = await searchListingsAsync({ ...ARGS, offset: ARGS.limit }, { driver: "sqlite" });
    assert.deepEqual(idsOf(nextPg), idsOf(nextSqlite), "第二頁必須一致");
  } finally {
    if (typeof pgDriver?.close === "function") await pgDriver.close();
  }
});
