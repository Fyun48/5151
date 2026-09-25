// 正式入口測試（astra 2026-09-25 裁決 §2.2）。
//
// 為什麼需要：`pg-provider-canaries.test.js` 直接呼叫 `searchListingsNodePg()` 並**自行帶入 deps** ✗
// ⇒ 它繞過了正式入口，因此**不能證明正式路徑的候選欄位與回傳內容** ✓。
// 本測試改為從 **`searchListingsAsync()`** 進入、且**完全不注入 `deps`** ✓
// ⇒ 走 `listingSearchBuildContext()` 的正式預設（寬候選欄位 ✓），並檢查**實際送出的 SELECT** ✓。
//
// 另外守住裁決 §2.1 的回歸 ✓：正式候選欄位清單**必須含 `first_seen_at`**
//（`listingEffectiveUpdatedAt()` 在相對時間時要讀它 ✓，缺了會改變 `newest` 排序 ✗）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchListingsAsync } from "../src/listingSearchAsync.js";

function officialCandidateColumns() {
  const source = readFileSync(new URL("../src/db.js", import.meta.url), "utf8");
  const match = source.match(/const LIST_CANDIDATE_COLUMNS = `([\s\S]*?)`;/);
  assert.ok(match, "應能找到 LIST_CANDIDATE_COLUMNS");
  return match[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

const CANDIDATE = {
  post_id: 1, source: "591", source_id: "8", source_key: "1|8||台中市西屯區測試路1號",
  url: "https://example.test/1", price: "20000元", price_num: 20000,
  extra_fee: 1000, extra_fees: "[]", extra_fee_text: "管理費1000元", price_contain_text: "",
  title: "電梯大樓 2房", address: "台中市西屯區測試路1號", address_norm: "台中市西屯區測試路1號",
  area_name: "10坪", layout: "2房1廳", floor_name: "5/10", kind_name: "整層住家/電梯大樓",
  tags: "[]", role_name: "", contact_name: "", contact_role: "", contact_uid: 0, agency: "",
  lat: 24.18, lng: 120.64, geo_source: "address", location_class: "address",
  match_post_id: 0, match_level: 0, match_verdict: "", match_rejected: 0,
  offline: 0, offline_confirmed: 0, hidden: 0, hidden_at: null, last_event: "",
  first_seen_at: "2026-09-01T00:00:00.000Z", last_seen_at: "2026-09-20T00:00:00.000Z",
  // 相對時間 ⇒ effective updated at 會回讀 first_seen_at ✓（裁決 §2.1 的反例條件 ✓）
  refresh_time: "1小時前", listed_by_user_id: 0, self_status: "",
};

function recordingDriver() {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/FROM\s+listings\s+WHERE\s+post_id\s+IN/i.test(text)) return { rows: [{ ...CANDIDATE }] };
      if (/^\s*SELECT\s+post_id\s*,/i.test(text) && /FROM\s+listings/i.test(text)) {
        return { rows: [{ ...CANDIDATE }] };
      }
      return { rows: [] };
    },
  };
}

test("正式入口：searchListingsAsync（不注入 deps）送出的候選 SELECT 必須用官方寬欄位", async () => {
  const pgDriver = recordingDriver();
  const result = await searchListingsAsync(
    {
      filter: "all", districts: [], sort: "newest", limit: 20, offset: 0,
      userId: 0, matchVoteUserId: 0, settings: {},
    },
    // ⚠️ 只給 driver ✗ 不給 deps ✓ ⇒ 正式預設路徑 ✓（裁決 §2.2 的要求 ✓）
    { driver: "postgres", pgDriver },
  );

  const candidate = pgDriver.queries.find((q) => /^\s*SELECT\s+post_id\s*,/i.test(String(q.sql)) && /FROM\s+listings/i.test(String(q.sql)));
  assert.ok(candidate, `應送出候選 SELECT；實際送出的查詢：${JSON.stringify(pgDriver.queries.map((q) => String(q.sql).slice(0, 60)))}`);

  const official = officialCandidateColumns();
  for (const column of official) {
    assert.match(String(candidate.sql), new RegExp(`\\b${column}\\b`),
      `正式候選 SELECT 必須含 ${column}`);
  }
  // 裁決 §2.1 的回歸護欄（入口層 ✓）
  for (const required of ["first_seen_at", "last_seen_at", "source_id", "url"]) {
    assert.match(String(candidate.sql), new RegExp(`\\b${required}\\b`),
      `正式候選 SELECT 必須含 ${required}（排序／tie-break 需要）`);
  }
  assert.ok(result, "正式入口必須回傳結果");
});
