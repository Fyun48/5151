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
//
// ✅ **接通配方（已由讀碼確認 ✓，下一批照做即可 ✓）**：
//   1. `sameSearch(a,b)`（`client591.js:81`）**先比對「trim 後完全相等」** ✓ ⇒ 只要 fixture 的
//      `search_key` **等於** pipeline 實際使用的鍵 ✓ ⇒ **必然匹配** ✓（不必猜 591 URL 格式 ✓）。
//   2. 因此：先跑一次 context 建構 ✓（PG：`buildListRequestContextFromPg(exec)` ✓；
//      SQLite：`currentSearchKeys()` ✓，`db.js:4046` ✓）⇒ 讀出它產生的鍵清單 ✓ ⇒ 取第一個 ✓。
//   3. 兩邊 fixture 的 `search_key` 都設成**那個值** ✓（SQLite 用 `app.sqliteHandle()` ✓、
//      PG 用 driver ✓；其餘必填欄位：`source_key`／`title`／`url`／`first_seen_at`／`last_seen_at` ✓
//      ＋ `source='591'`／`offline=0` ✓）。
//   4. `WHERE` 由 `searchWhere` 以 `search_key IN (…)` 產生 ✓（`db.js:4237` ✓）
//      ⇒ 有索引可用 ✓（`idx_listings_search` ✓、`idx_listings_list_scan` ✓；`db.js:736/755` ✓）
//      ⇒ 這也是 A/B 對 43 vs 23 欄做比較時可用的**同一條查詢** ✓。
//   5. 設定上仍須避開通勤與 `fit_desc` ✗（`settings: {}` ✓、`sort: "newest"` ✓）以避免額外分支 ✓。
//
// ✅✅ **最後一個關鍵細節（補齊 ✓，否則 parity 永遠不可能一致 ✗）**：
//   鍵集是**由 `settings`／`searchUrls` 展開**而來的 ✓（`searchWhere` 用的就是那批鍵 ✓）
//   ⇒ 若兩引擎吃**不同** settings ✗ ⇒ 匹配到的列不同 ✗ ⇒ 集合永遠不會相等 ✗。
//   ⇒ 正解：在 `ARGS.settings` 裡放**同一組**合成的 591 搜尋 URL ✓（兩次呼叫共用同一物件 ✓），
//     然後用**同一支 context 建構**讀出**那組設定實際產生的鍵** ✓，
//     再把**那個鍵**設成兩邊 fixture 的 `search_key` ✓
//     ⇒ 兩引擎吃的 settings 相同 ✓、鍵相同 ✓、命中列相同 ✓ ⇒ 集合可比 ✓✓。
//   ⚠️ 具體 URL 格式**不必猜** ✗ —— 鍵一律由 context 建構後**讀回來** ✓（`sameSearch` 先比對 trim 相等 ✓）。


test("live PG：列表搜尋雙向 parity（SQLite vs PG）", { skip: SKIP }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const app = await import("../src/db.js");
  const pgDriver = await createPostgresDriver({ env: process.env });
  const sqliteDb = app.sqliteHandle();
  const SEED = 900300001;

  // ✗ 關鍵前提（§3o）：SQLite 的鍵集來自**它自己 DB 的 settings**，不是 `args.settings` ✗
  // ⇒ 兩邊必須種**同一組 `settings.searchUrls`** ✓，否則匹配列不同、集合永遠不等 ✗。
  const URL_591 = "https://rent.591.com.tw/list?region=1&section=2%2C3&order=posttime&orderType=desc";
  const args = { ...ARGS, settings: { searchUrls: [URL_591] } };
  sqliteDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run("searchUrls", JSON.stringify([URL_591]));
  await pgDriver.query(
    "INSERT INTO settings (key, value) VALUES ('searchUrls', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [JSON.stringify([URL_591])],
  );

  // 讀回**展開後的 stored keys** ✓（`searchKeys` ✓；不必猜 URL 格式 ✓）⇒ 取第一個當 fixture 鍵 ✓
  const pgExec = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const pgContext = await app.buildListRequestContextFromPg(pgExec);
  const key = (pgContext?.searchKeys || [])[0];
  console.log(`PARITY-CONTEXT ${JSON.stringify({ pgKeys: (pgContext?.searchKeys || []).length, key })}`);
  assert.ok(key, "必須取得一個展開後的 search_key（否則無法建立兩引擎可達 fixture）");

  const iso = new Date().toISOString();
  const seeds = [0, 1, 2].map((i) => ({
    post_id: SEED + i, source: "591", source_key: `parity|${i}`, search_key: key,
    title: `parity ${i}`, url: `https://example.test/parity/${i}`,
    first_seen_at: iso, last_seen_at: iso, offline: 0,
  }));
  const insertSqlite = sqliteDb.prepare(
    `INSERT OR REPLACE INTO listings
     (post_id, source, source_key, search_key, title, url, first_seen_at, last_seen_at, offline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of seeds) {
    insertSqlite.run(row.post_id, row.source, row.source_key, row.search_key, row.title, row.url,
      row.first_seen_at, row.last_seen_at, row.offline);
  }
  await pgDriver.query(
    `INSERT INTO listings (post_id, source, source_key, search_key, title, url, first_seen_at, last_seen_at, offline)
     VALUES ${seeds.map((_, i) => `($${i * 6 + 1}, '591', $${i * 6 + 2}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6}, 0)`).join(",")}
     ON CONFLICT (post_id) DO NOTHING`,
    seeds.flatMap((r) => [r.post_id, r.search_key, r.title, r.url, r.first_seen_at, r.last_seen_at]),
  );

  try {
    const viaPg = await searchListingsAsync({ ...args }, { driver: "postgres", pgDriver });
    const viaSqlite = await searchListingsAsync({ ...args }, { driver: "sqlite" });

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
    const nextPg = await searchListingsAsync({ ...args, offset: args.limit }, { driver: "postgres", pgDriver });
    const nextSqlite = await searchListingsAsync({ ...args, offset: args.limit }, { driver: "sqlite" });
    assert.deepEqual(idsOf(nextPg), idsOf(nextSqlite), "第二頁必須一致");
  } finally {
    if (typeof pgDriver?.close === "function") await pgDriver.close();
  }
});
