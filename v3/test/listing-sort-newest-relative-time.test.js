// 反例回歸測試（astra 2026-09-25 裁決 §2.1）：**窄候選欄位會改變 `newest` 排序** ✗。
//
// 為什麼一定要有這支測試：`listingEffectiveUpdatedAt()` 在 `refresh_time` 是相對時間
//（「1小時前」等 ✓）或缺少可解析絕對時間時，會**回讀 `first_seen_at`** ✓。
// 若候選欄位少了它 ⇒ 兩列的 effective updated at 都塌成同一個值 ⇒ 排序改變 ✗。
// 這是**分頁前的排序**，頁面 hydration 救不回來 ✗（會選錯頁 ✓）。
//
// 附帶護欄 ✓：真正使用的寬候選欄位清單**必須含** `first_seen_at`、`last_seen_at`、
// `source_id`、`url`（後三者是 `preferPrimaryListing()` 的 tie-break ✓）—— 哪天有人再縮欄位，
// 這裡會先紅 ✗，而不是等到線上排序錯亂 ✓。
import { test } from "node:test";
import assert from "node:assert/strict";
import { listingSearchBuildContext } from "../src/db.js";
import {
  buildListListingsRows,
  paginateListListingsRows,
} from "../src/db.js";

function spyProvider() {
  const emptyIndex = { groupKey: () => "", peers: () => [], agrees: () => true, size: 0 };
  const value = {
    driver: "sqlite",
    userId: 0,
    personalIndex: () => emptyIndex,
    personalGroupAgrees: () => true,
    splitPairs: () => new Set(),
    prep: () => null,
    groupId: () => "",
    groupMemberRows: () => [],
    peerRows: () => [],
    extras: () => new Map(),
    personalFlags: () => null,
  };
  return new Proxy(value, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => null;
    },
  });
}

const ROWS = [
  {
    post_id: 1, source: "591", source_id: "8", url: "https://example.test/1",
    price: "20000元", price_num: 20000, area_name: "10坪", floor_name: "5/10",
    kind_name: "整層住家", match_verdict: "", offline: 0, hidden: 0,
    // refresh_time 是**相對時間** ⇒ effective updated at 會落回 first_seen_at ✓
    refresh_time: "1小時前", last_seen_at: "2026-09-01T00:00:00.000Z",
    first_seen_at: "2026-09-01T00:00:00.000Z",
  },
  {
    post_id: 2, source: "591", source_id: "9", url: "https://example.test/2",
    price: "20000元", price_num: 20000, area_name: "10坪", floor_name: "5/10",
    kind_name: "整層住家", match_verdict: "", offline: 0, hidden: 0,
    refresh_time: "1小時前", last_seen_at: "2026-09-20T00:00:00.000Z",
    first_seen_at: "2026-09-20T00:00:00.000Z",
  },
];

test("回歸：相對 refresh_time 時 newest 排序必須依 first_seen_at（寬欄位基準）", () => {
  const provider = spyProvider();
  const filtered = buildListListingsRows(ROWS.map((row) => ({ ...row })), {
    filter: "all", kind: "", sources: "", sort: "newest",
    uid: 0, voteUid: 0, settings: {}, districtSet: new Set(), provider, flagMap: new Map(),
  });
  const page = paginateListListingsRows(filtered, {
    sort: "newest", filter: "all", settings: {}, limit: 10, offset: 0,
  });
  const list = Array.isArray(page)
    ? page
    : (page?.listings || page?.rows || page?.items || page?.page || []);
  console.log(`SORT-PAGE-KEYS ${JSON.stringify(Object.keys(page || {}))}`);
  const order = list.map((row) => row.post_id);
  console.log(`SORT-NEWEST-ORDER ${JSON.stringify(order)}`);
  // 較新的 first_seen_at（post 2）必須在前 ✓
  assert.deepEqual(order, [2, 1], `newest 排序應為 [2,1]，實際 ${JSON.stringify(order)}`);
});

test("護欄：寬候選欄位清單必須保留排序／tie-break 需要的欄位", () => {
  const candidateColumns = listingSearchBuildContext().candidateColumns;
  assert.ok(candidateColumns, "正式 builder 必須提供完整候選欄位");
  const columns = new Set(candidateColumns.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
  for (const required of ["first_seen_at", "last_seen_at", "source_id", "url"]) {
    assert.ok(columns.has(required), `LIST_CANDIDATE_COLUMNS 必須含 ${required}（排序／tie-break 需要）`);
  }
});
