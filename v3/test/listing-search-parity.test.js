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

// ✗ 裁決 §3（結果契約）：**移除「任何回傳形狀都容忍、缺值就 []」的輔助函式** ✗
// ⇒ 只認正式 envelope ✓：`listings` 必須是陣列 ✓、`totalMatched` 必須是有效整數 ✓
//（label 預設空字串 ⇒ 既有呼叫端不必改 ✓）。
function listingsOf(result, label = "") {
  assert.ok(Array.isArray(result?.listings), `${label}：listings 必須是陣列（實際 ${typeof result?.listings}）`);
  return result.listings;
}
function idsOf(result, label = "") {
  return listingsOf(result, label).map((row) => Number(row.post_id));
}
function totalOf(result, label = "") {
  const value = result?.totalMatched;
  assert.ok(Number.isInteger(value), `${label}：totalMatched 必須是有效整數（實際 ${JSON.stringify(value)}）`);
  return value;
}
function rolesOf(result, label = "") {
  return listingsOf(result, label).map((row) => String(row?.same_house_role ?? ""));
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
  // ✗ 裁決 §3（測試連線）：driver 必須吃**測試連線本身**的 URL ✓
  //（原本 `env: process.env` ✗ ⇒ skip 判斷用 `PG_TEST_URL`、實連卻讀一般環境 ⇒ 兩者不同就會連錯目標 ✗）。
  const pgDriver = await createPostgresDriver({ connectionString: PG_URL });
  const sqliteDb = app.sqliteHandle();
  const SEED = 900300001;

  // ✗ 關鍵前提（§3o）：SQLite 的鍵集來自**它自己 DB 的 settings**，不是 `args.settings` ✗
  // ⇒ 兩邊必須種**同一組 `settings.searchUrls`** ✓，否則匹配列不同、集合永遠不等 ✗。
  const URL_591 = "https://rent.591.com.tw/list?region=1&section=2%2C3&order=posttime&orderType=desc";
  // ✗ 裁決 §3（時間）：**固定 fixture 時間 ＋ 同一 `asOf`** ✓（不得以每次 `new Date()` 充當決定性驗證 ✗）。
  const FIXED_ISO = "2026-09-01T00:00:00.000Z";
  const AS_OF = "2026-09-26T00:00:00.000Z";
  // ✗ 裁決 §3（有效案例）：三列 ＋ `limit: 20` ⇒ 第二頁**必為空** ⇒ 分頁永遠「通過」✗
  //   ⇒ 改 `limit: 2` ✓（第二頁必須有 1 列 ✓）。
  const args = { ...ARGS, limit: 2, settings: { searchUrls: [URL_591] }, asOf: AS_OF };

  // ✗ 裁決 §3（schema 順序）：**先備妥所有必要 schema，再 seed** ✓
  //（原本先 INSERT settings、後 ensure settings ⇒ **錯序** ✗ ⇒ CI 拋棄式 PG 沒有 `settings` 表 ✓）。
  const { ensurePgSchema } = await import("../src/pgSchema.js");
  await ensurePgSchema(pgDriver, sqliteDb, { tables: ["settings"] });
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  // ✗ 必修 #1：context 內部的 SQL 用 `?` 佔位符 ⇒ **必須過 `toPostgresSql()`** 才能給 PG ✗
  //（CI 實測：`syntax error at or near ")"` / code 42601，堆疊指向 `db.js:4087` 的 `safeExecFactory` ✓）。
  const pgExec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  // ✓ 兩引擎吃**同一組** settings ✓（同一字串值 ✓，避免殘留 users／settings 改變 searchKeys ✗）。
  sqliteDb.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run("searchUrls", JSON.stringify([URL_591]));
  await pgDriver.query(
    "INSERT INTO settings (key, value) VALUES ('searchUrls', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [JSON.stringify([URL_591])],
  );

  // 讀回**展開後的 stored keys** ✓（`searchKeys` ✓；不必猜 URL 格式 ✓）⇒ 取第一個當 fixture 鍵 ✓
  const pgContext = await app.buildListRequestContextFromPg(pgExec);
  const key = (pgContext?.searchKeys || [])[0];
  console.log(`PARITY-CONTEXT ${JSON.stringify({ pgKeys: (pgContext?.searchKeys || []).length, key })}`);
  assert.ok(key, "必須取得一個展開後的 search_key（否則無法建立兩引擎可達 fixture）");

  const iso = FIXED_ISO;
  // ✗ 根因（CI 實證 `PARITY-IDS-* []` ✗、`candidates: 3` ✓）：`db.js:6615-6616` 會用
  //   `districtsFromSearchUrls(settings.searchUrls)`（`db.js:4036`）產生的 `districtSet` **過濾列** ✗
  //   —— 我的 URL 帶 `section` ⇒ 集合非空 ⇒ **沒有 district 的列全被丟掉** ✗。
  //   ⇒ 依 §3「依已知 URL 的區域建立有效的 district／地址及顯示所需欄位」✓：
  //     **執行時推導**該 URL 的行政區 ✓（不猜行政區名 ✗），取成員填入兩引擎 fixture ✓。
  const { districtsFromSearchUrls } = await import("../src/regions.js");
  const allowedDistricts = districtsFromSearchUrls([URL_591]);
  // ✗ 已由 CI 錯誤原文證明：`listings` **沒有 `district` 欄**（`table listings has no column named district` ✗）。
  //   ✓ 正解（`regions.js:52-63`）：`districtNameFromListing` **先**用 `regionid/sectionid`，
  //     再用 **`source_key` 以 `|` 切出的前兩段** 推導行政區 ✓
  //   ⇒ 把 `source_key` 設成 `<regionid>|<sectionid>` ✓ 即命中 `districtSet` ✓
  //（不新增欄位 ✗、不猜行政區 ✗；代碼直接由 URL 推導的 `allowedDistricts` 切出 ✓）。
  const [regionId, sectionId] = String(allowedDistricts[0] || "").split("-");
  console.log(`PARITY-DISTRICTS ${JSON.stringify({ allowedDistricts, regionId, sectionId })}`);
  assert.ok(regionId && sectionId, "必須由 URL 推導出 region｜section（否則 districtSet 條件無法成立）");
  const sourceKey = `${regionId}|${sectionId}`;
  const seeds = [0, 1, 2].map((i) => ({
    post_id: SEED + i, source: "591", source_key: sourceKey, search_key: key,
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
  // ✗ 根因（裁決 §2）：每列只用 6 個參數，卻把 `source_key` 與 `search_key` **都綁到 $2** ✗
  // ⇒ `$2` 的值是搜尋網址 ⇒ PG 的 `source_key` 不是 `parity|…` ⇒ 前綴計數自然是 0 ✗
  //（**不能**據此推論 insert 沒落地／寫錯 database／ON CONFLICT 跳過 ✗ —— 我先前正是這樣誤判 ✗）。
  // 修法：每列改 7 個參數 ✓，欄位順序 post_id, source, source_key, search_key, title, url,
  // first_seen_at, last_seen_at, offline = $1,'591',$2,$3,$4,$5,$6,$7,0 ✓。
  const insertColumns = "post_id, source, source_key, search_key, title, url, first_seen_at, last_seen_at, offline";
  const insertValues = seeds.map((_, i) => {
    const n = i * 7;
    return `($${n + 1}, '591', $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, 0)`;
  }).join(",");
  const insertParams = seeds.flatMap((r) => [
    r.post_id, r.source_key, r.search_key, r.title, r.url, r.first_seen_at, r.last_seen_at,
  ]);
  const seedRes = await pgDriver.query(
    `INSERT INTO listings (${insertColumns}) VALUES ${insertValues}
     ON CONFLICT (post_id) DO UPDATE SET
       source_key = excluded.source_key, search_key = excluded.search_key, title = excluded.title,
       url = excluded.url, first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at,
       offline = excluded.offline`,
    insertParams,
  );
  const whereAmI = (await pgDriver.query(
    "SELECT current_database() AS db, current_schema() AS schema, to_regclass('listings')::text AS rel",
  )).rows[0];
  console.log(`PARITY-PG-TARGET ${JSON.stringify({ rowCount: seedRes.rowCount, ...whereAmI })}`);

  // ✗ 依裁決 §2：**按本次 seed 的確切 post_id 逐欄讀回比對** ✓（prefix count **不能**取代 ✓）。
  const seedIds = seeds.map((r) => r.post_id);
  const canonical = (rows) => rows.map((row) => [Number(row.post_id), String(row.source_key), String(row.search_key)]);
  const expected = seeds.map((r) => [r.post_id, r.source_key, r.search_key]);
  const pgRows = (await pgDriver.query(
    "SELECT post_id, source_key, search_key FROM listings WHERE post_id = ANY($1::bigint[]) ORDER BY post_id",
    [seedIds],
  )).rows;
  const sqliteRows = sqliteDb.prepare(
    `SELECT post_id, source_key, search_key FROM listings WHERE post_id IN (${seedIds.map(() => "?").join(",")}) ORDER BY post_id`,
  ).all(...seedIds);
  console.log(`PARITY-FIXTURE-CHECK ${JSON.stringify({ pg: pgRows, sqlite: sqliteRows })}`);
  assert.deepEqual(canonical(pgRows), expected, "PG 三列每欄都必須與 canonical fixture 相同");
  assert.deepEqual(canonical(sqliteRows), expected, "SQLite 三列每欄都必須與 canonical fixture 相同");

  try {
    const viaPg = await searchListingsAsync({ ...args }, { driver: "postgres", pgDriver });
    // ✗ B4 決定性 ✓：呼叫端固定的 `asOf` 必須**貫穿**到 PG 的 `queryDetails.asOf` ✓
    //（先前 CI 實證為 wall clock ✗ ⇒ `args.asOf` 被忽略 ✗；現在必須相等 ✓）。
    assert.equal(viaPg?.queryDetails?.asOf, AS_OF, "呼叫端固定的 asOf 必須貫穿到 PG queryDetails");
    // ✗ 裁決 §4（核心語意 parity）：SQLite **Node 參考** `listListings` ✓ 對 PG **正式入口** ✓
    //（PG 端不覆寫 deps／candidateColumns／decorator ✓、不繞過正式 context 與單一快照 ✓）。
    const viaSqlite = app.listListings({ ...args });
    // ✓ §4（入口相容性單獨驗證）：正式 SQLite dispatcher 若實際走 SQL-first 必須**標示引擎** ✓；
    //   其已知配對語意差異須**記錄 ＋ 正確回歸案例**，不得以 skip／改名當已解決 ✗。
    const viaSqliteDispatch = await searchListingsAsync({ ...args }, { driver: "sqlite" });
    console.log(`PARITY-ENGINES ${JSON.stringify({
      pg: viaPg?.queryDetails?.engine ?? null,
      sqliteRef: "node",
      sqliteDispatch: viaSqliteDispatch?.queryDetails?.engine ?? null,
      sqliteDispatchSqlFirst: viaSqliteDispatch?.sql_first ?? null,
    })}`);

    console.log(`PARITY-KEYS-PG ${JSON.stringify(Object.keys(viaPg || {}))}`);
    console.log(`PARITY-KEYS-SQLITE ${JSON.stringify(Object.keys(viaSqlite || {}))}`);
    console.log(`PARITY-IDS-PG ${JSON.stringify(idsOf(viaPg).slice(0, 10))}`);
    console.log(`PARITY-IDS-SQLITE ${JSON.stringify(idsOf(viaSqlite).slice(0, 10))}`);

    // ✗ 診斷必須放在斷言**之前** ✓（否則一失敗就看不到 —— A/B 教過的教訓 ✓）。
    // `queryDetails` 由 envelope 回傳 ✓（含候選數／階段耗時／降級清單 ✓）⇒ 用它分辨
    // 「fixture 沒種到」✗ 與「前置條件把它濾掉」✗。
    console.log(`PARITY-DETAILS-PG ${JSON.stringify(viaPg?.queryDetails ?? null)}`);
    console.log(`PARITY-DETAILS-SQLITE ${JSON.stringify(viaSqlite?.queryDetails ?? null)}`);
    // ✗ 已失效診斷（`source_key` 改為 `1|2` ⇒ `LIKE 'parity|%'` 恆為 0 ✗，只會誤導 ✓）⇒ 移除 ✓；
    //   fixture 在位與否已由上面的 `PARITY-FIXTURE-CHECK`（逐欄讀回 ✓）證明 ✓。

    assert.ok(idsOf(viaPg).length > 0, `PG 結果不得為空（實際 ${JSON.stringify(idsOf(viaPg))}）`);
    assert.ok(idsOf(viaSqlite).length > 0, `SQLite 結果不得為空（實際 ${JSON.stringify(idsOf(viaSqlite))}）`);
    // ① 集合與順序 ✓
    assert.deepEqual(idsOf(viaPg), idsOf(viaSqlite), "id 集合與順序必須一致");
    // ② 總數 ✓
    assert.equal(totalOf(viaPg), totalOf(viaSqlite), "totalMatched 必須一致");
    // ③ same-house 角色／個人狀態 ✓
    assert.deepEqual(rolesOf(viaPg), rolesOf(viaSqlite), "same-house 角色必須一致");
    // ④ 分頁 ✓（offset 一頁）
    // ④ 分頁 ✓（offset 一頁；`limit: 2` ＋ 三列 ⇒ 第二頁**必須有 1 列** ✓）
    // ✗ CI 實證：`第二頁必須一致 + [900300003] - []` ⇒ PG 正確 ✓、SQLite dispatcher 回空 ✗。
    //   原因＝正式 dispatcher 走 **SQL-first**（CI 日誌：`listing_search_projection 已與 listings 對齊，
    //   訪客搜尋使用 SQL-first` ✗），而本 fixture 只寫 `listings` ✗ -> 投影路徑取不到列 ✗。
    // ✓ 裁決 §4：核心語意 parity 用 SQLite **Node 參考** ✓；正式 dispatcher 的差異**單獨記錄** ✓
    //   （不混入語意比對 ✗，也不以 skip／改名掩蓋 ✗）。
    const nextPg = await searchListingsAsync({ ...args, offset: args.limit }, { driver: "postgres", pgDriver });
    const nextSqliteRef = app.listListings({ ...args, offset: args.limit });
    const nextSqliteDispatch = await searchListingsAsync({ ...args, offset: args.limit }, { driver: "sqlite" });
    console.log(`PARITY-PAGE2 ${JSON.stringify({
      pg: idsOf(nextPg), sqliteRef: idsOf(nextSqliteRef), sqliteDispatch: idsOf(nextSqliteDispatch),
    })}`);
    assert.deepEqual(idsOf(nextPg), idsOf(nextSqliteRef), "第二頁必須一致（PG 正式入口 vs SQLite Node 參考）");
    assert.deepEqual(idsOf(nextPg), [SEED + 2], "第二頁必須是第三列（三列、limit=2 ⇒ 不得為空 ✗）");
  } finally {
    // ✓ 裁決 §3（fixture 隔離）：失敗也要**清理自己建立的資料** ✓
    //（只刪自己那三列 ✓，不清空共享／正式資料 ✗；連線一律釋放 ✓，斷線不影響原本的失敗訊息 ✓）。
    try {
      await pgDriver.query("DELETE FROM listings WHERE post_id = ANY($1::bigint[])", [seedIds]);
    } catch {
      /* 已斷線或非 PG 失敗路徑：不覆蓋真正的原因 */
    }
    try {
      sqliteDb.prepare(`DELETE FROM listings WHERE post_id IN (${seedIds.map(() => "?").join(",")})`).run(...seedIds);
    } catch {
      /* 同上 */
    }
    if (typeof pgDriver?.close === "function") await pgDriver.close();
  }
});
