// 量測：PG 列表路徑每次搜尋**實際發出幾個查詢**（③ 查詢數 ≤12 的基準）。
//
// 為什麼需要它：清點後發現查詢數**不是常數** ✗ —— 列表路徑 5 個基座查詢
//（`listingSearchNodePg.js` :49 seeds／:57 linked／:64 same-house members／:216 candidate SELECT／
//  :242 page hydration ✓）＋ `repository/decorationData.js` 的 14+ 查詢點 ✓，
// 實際數量取決於管線叫到哪些裝飾方法 ✓。
//
// 手法：用**假 pgDriver**（記錄每筆 SQL ✓、只回傳能讓管線走下去的最小資料 ✓）驅動真實
// `searchListingsNodePg` ✓ ⇒ 完全離線 ✓、可重跑 ✓、且不碰任何真 DB ✓。
//
// ⚠️ 這是**基準量測** ✓：假 driver 回傳的候選列只有 1 列，所以「裝飾階段」的查詢不會全開 ✗
// ⇒ 之後要對照真環境的查詢數時，必須以同一支測試的數字為基準 ✓（不是真環境的上限 ✓）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { listingSearchBuildContext } from "../src/db.js";

function countingDriver() {
  const queries = [];
  const CANDIDATE = {
    post_id: 1, source: "591", price: "20000元", price_num: 20000,
    area_name: "10坪", floor_name: "5/10", kind_name: "整層住家/電梯大樓",
    title: "電梯大樓 2房", address: "台中市西屯區測試路1號", tags: "[]",
    lat: 24.18, lng: 120.64, geo_source: "address", location_class: "address",
    match_post_id: 0, match_level: 0, match_verdict: "",
    offline: 0, offline_confirmed: 0, hidden: 0, hidden_at: null,
    refresh_time: "2026-09-01T00:00:00.000Z", contact_uid: 0,
  };
  const driver = {
    queries,
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      // 只讓「候選 SELECT」回一列；其餘（session／seeds／flags／prep／hydration…）一律空 ✓
      if (/^\s*SELECT\s+post_id\s*,\s*source\s*,/i.test(text) || /FROM\s+listings\s+WHERE/i.test(text)) {
        if (/\bAS\b/i.test("") === false) return { rows: [CANDIDATE] };
      }
      return { rows: [] };
    },
  };
  return driver;
}

test("量測：PG 列表路徑每次搜尋的查詢數與分佈（離線基準）", async () => {
  const mod = await import("../src/listingSearchNodePg.js");
  const runSearch = mod.searchListingsNodePg || mod.default;
  assert.equal(typeof runSearch, "function", "listingSearchNodePg.js 應匯出搜尋函式");

  const pgDriver = countingDriver();
  const args = { filter: "all", districts: [], sort: "price_asc", limit: 20, offset: 0, uid: 0, voteUid: 0, settings: {} };
  const deps = listingSearchBuildContext();
  const outcome = await runSearch(args, { pgDriver, deps })
    .catch((error) => ({ error: String(error && error.message || error) }));
  const firstRun = pgDriver.queries.length;
  // 第二次（同一 driver／同一 deps）：驗證 `search_key` 的 8 秒 memo 是否真的省下那筆全表
  // `SELECT DISTINCT search_key FROM listings` ✓。單次量測看不出來 ✗（一次請求本來就只發一次 ✓）。
  const secondOutcome = await runSearch(args, { pgDriver, deps })
    .catch((error) => ({ error: String(error && error.message || error) }));
  const secondRun = pgDriver.queries.length - firstRun;
  const secondSql = pgDriver.queries.slice(firstRun).map((q) => String(q.sql).replace(/\s+/g, " ").slice(0, 56));

  const byTable = {};
  for (const entry of pgDriver.queries.slice(0, firstRun)) {
    const match = String(entry.sql).match(/FROM\s+([a-z_]+)/i);
    const key = match ? match[1] : "other";
    byTable[key] = (byTable[key] || 0) + 1;
  }
  console.log(`QC-TOTAL ${pgDriver.queries.length}`);
  console.log(`QC-BY-TABLE ${JSON.stringify(byTable)}`);
  console.log(`QC-SQL ${JSON.stringify(pgDriver.queries.map((q) => String(q.sql).replace(/\s+/g, " ").slice(0, 56)))}`);
  console.log(`QC-OUTCOME ${JSON.stringify(outcome && outcome.error ? { error: outcome.error } : { ok: true })}`);

  assert.ok(pgDriver.queries.length > 0, "應該要發出至少一個查詢");
});
