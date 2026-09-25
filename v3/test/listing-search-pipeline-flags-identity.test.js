import { test } from "node:test";
import assert from "node:assert/strict";
import { listingSearchBuildContext } from "../src/db.js";
import { searchListingsNodePg } from "../src/listingSearchNodePg.js";

// astra 2026-09-25 §2.2：真正走完搜尋管線的**身分**驗收。
//
// 既有的 listing-search-flags-identity.test.js 只檢查 builder 產生的 SQL／params，抓不到
// **消費端**用錯身分（HEAD 的 searchListingsNodePgInner() 曾用 `personalFlagMap(voteUid)`
// 產生清單 overlay 的 flagMap）。這裡用假 PG driver 走完 node_pg：
//   uid=101、voteUid=202，兩人對同一批物件的 watched 狀態**相反**
//   ⇒ 回傳的卡片必須反映 **101** 的狀態；若誰又把消費端改回 voteUid，這個測試會失敗。
//
// 注意：候選 SQL 由真實 builder 產生（不是手寫近似版本），只是用假 driver 取代資料來源。

const CANDIDATE_COLUMNS_FAKE = "post_id, source, source_id, url, price, price_num, offline, hidden, match_verdict, match_post_id, refresh_time";

// 完整的候選列／頁面列（照 LIST_CANDIDATE_COLUMNS：kind_name／floor_name／area_name 等都要有，
// 否則 Node 端顯示篩選會把列濾掉，測試就會誤判成「身分錯誤」）。
function listingRow(id, overrides = {}) {
  return {
    post_id: id, source: "591", source_id: String(id), source_key: "591",
    url: `https://x/${id}`, price: `${id}0000`, price_num: id * 10000,
    extra_fee: 0, extra_fees: "", extra_fee_text: "", price_contain_text: "",
    title: `測試物件 ${id}`, address: "測試路 1 號", address_norm: "測試路1號",
    area_name: "10坪", layout: "1房1廳", floor_name: "3樓", kind_name: "整層住家",
    tags: "", role_name: "", contact_name: "", contact_role: "", contact_uid: 0, agency: "",
    lat: 24.15, lng: 120.65, geo_source: "591", location_class: "city",
    match_post_id: 0, match_level: "", match_verdict: "", match_rejected: 0,
    offline: 0, offline_confirmed: 0, hidden: 0, hidden_at: null,
    last_event: "", first_seen_at: "2026-09-01T00:00:00.000Z", last_seen_at: "2026-09-20T00:00:00.000Z",
    refresh_time: `2026-09-0${id}T00:00:00.000Z`, listed_by_user_id: 0, self_status: "",
    district: "西屯區",
    ...overrides,
  };
}

function fakeDriver({ watchedBy }) {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text.slice(0, 80), params });
      // ⚠️ 順序很重要：頁面列查詢（`WHERE post_id IN (...)`)也符合「SELECT … FROM listings WHERE」，
      // 必須先判它，否則頁面 hydration 會拿到錯誤形狀的列，裝飾階段會把所有列丟掉（實測踩過）。
      if (/FROM listings\s+WHERE post_id IN/i.test(text)) {
        const ids = params.map((p) => Number(p)).filter(Boolean);
        return { rows: ids.map((id) => listingRow(id)) };
      }
      // 個人 flags：身分正確性就在這一條 —— 只依 params[0]（user_id）回傳。
      // ⚠️ 必須**錨定**成 loader 的精確語句：候選 SQL 內含 `NOT EXISTS (SELECT 1 FROM
      // user_listing_flags f …)` 子查詢，寬鬆樣式會把候選查詢也吃掉（實測踩過 ⇒ candidates 變 0）。
      if (/^\s*SELECT \* FROM user_listing_flags WHERE user_id\s*=/i.test(text)) {
        const uid = Number(params[0]) || 0;
        return { rows: watchedBy[uid] || [] };
      }
      if (/GROUP BY post_id/i.test(text)) return { rows: [] };   // loadAnyoneFlagMap
      // 候選列（真實 builder 的 SQL，只換資料來源）。
      // ⚠️ 用寬鬆樣式並放在**最後**：候選 SQL 是多行字串（SELECT 欄位清單換行）＋ builder 的
      // where 可能不含 " WHERE" 字面寫法，緊鄰樣式會漏接（實測踩過 ⇒ candidates 變 0）。
      // 頁面列與 flags 的樣式都在前面，所以不會被這裡吃掉。
      if (/FROM listings/i.test(text)) {
        return { rows: [listingRow(1), listingRow(2)] };
      }
      return { rows: [] };
    },
  };
}

const BASE_ARGS = {
  filter: "all", sort: "newest", limit: 20, offset: 0, districts: [],
  settings: {}, searchKeys: [],
};

function describeRes(res, driver = null) {
  return JSON.stringify({
    engine: res?.queryDetails?.engine,
    candidates: res?.queryDetails?.candidates,
    totalMatched: res?.totalMatched,
    returned: (res?.listings || []).length,
    sql: (driver?.queries || []).map((q) => q.sql),
  });
}

test("全管線：清單 flags 用觀看者 uid（post 1 被 101 標 watched ⇒ 對 101 不可見，對 202 可見）", async () => {
  // 101 把 post 1 標為 watched；202 把 post 2 標為 watched。
  const driver = fakeDriver({ watchedBy: { 101: [{ post_id: 1, watched: 1, hidden: 0, viewed: 0 }], 202: [{ post_id: 2, watched: 1, hidden: 0, viewed: 0 }] } });
  const res = await searchListingsNodePg(
    { ...BASE_ARGS, userId: 101, matchVoteUserId: 202 },
    { pgDriver: driver, deps: listingSearchBuildContext() },
  );
  const ids = (res.listings || []).map((row) => Number(row.post_id));
  assert.deepEqual(ids, [2], `必須以 uid=101 的狀態過濾（診斷 ${describeRes(res, driver)}）`);
  assert.equal(res.queryDetails.engine, "node_pg");
  // flags 查詢必須以 uid=101 發出（不得用 202）。
  const flagQueries = driver.queries.filter((q) => /FROM user_listing_flags/.test(q.sql));
  assert.ok(flagQueries.length > 0, "必須查過個人 flags");
  assert.ok(flagQueries.every((q) => Number(q.params[0]) === 101), `flags 查詢不得使用 voteUid：${JSON.stringify(flagQueries)}`);
});

test("全管線：同一批資料換成 uid=202 檢視 ⇒ 可見的是 post 1（對稱驗證，排除巧合）", async () => {
  const driver = fakeDriver({ watchedBy: { 101: [{ post_id: 1, watched: 1, hidden: 0, viewed: 0 }], 202: [{ post_id: 2, watched: 1, hidden: 0, viewed: 0 }] } });
  const res = await searchListingsNodePg(
    { ...BASE_ARGS, userId: 202, matchVoteUserId: 101 },
    { pgDriver: driver, deps: listingSearchBuildContext() },
  );
  const ids = (res.listings || []).map((row) => Number(row.post_id));
  assert.deepEqual(ids, [1], `必須以 uid=202 的狀態過濾（實際回傳 ${JSON.stringify(ids)}）`);
});

test("全管線：hidden 也屬 uid —— 101 隱藏 post 2 ⇒ filter=hidden 對 101 看得到、對 202 看不到", async () => {
  // filter=hidden 由 **Node 端**依 flagMap 判定（`listingMatchesListFilter`），因此不依賴假 driver
  // 模擬 SQL 層的 hidden 子句，最能單獨驗證「消費端身分」。
  const driver = fakeDriver({ watchedBy: { 101: [{ post_id: 2, watched: 0, hidden: 1, viewed: 0 }], 202: [] } });
  const forViewer = await searchListingsNodePg(
    { ...BASE_ARGS, filter: "hidden", userId: 101, matchVoteUserId: 202 },
    { pgDriver: driver, deps: listingSearchBuildContext() },
  );
  const forVoter = await searchListingsNodePg(
    { ...BASE_ARGS, filter: "hidden", userId: 202, matchVoteUserId: 101 },
    { pgDriver: driver, deps: listingSearchBuildContext() },
  );
  assert.deepEqual((forViewer.listings || []).map((r) => Number(r.post_id)), [2], `uid=101 應看到自己隱藏的 post 2（診斷 ${describeRes(forViewer, driver)}）`);
  assert.deepEqual((forVoter.listings || []).map((r) => Number(r.post_id)), [], "uid=202 沒有任何 flags ⇒ 不應看到 hidden 清單");
});

test("全管線：viewed 狀態（filter=unseen）同樣依 uid", async () => {
  const driver = fakeDriver({ watchedBy: { 101: [{ post_id: 1, watched: 0, hidden: 0, viewed: 1 }], 202: [{ post_id: 2, watched: 0, hidden: 0, viewed: 1 }] } });
  const res = await searchListingsNodePg(
    { ...BASE_ARGS, filter: "unseen", userId: 101, matchVoteUserId: 202 },
    { pgDriver: driver, deps: listingSearchBuildContext() },
  );
  const ids = (res.listings || []).map((row) => Number(row.post_id));
  assert.deepEqual(ids, [2], `unseen 必須用 uid=101 的 viewed（實際 ${JSON.stringify(ids)}）`);
});
