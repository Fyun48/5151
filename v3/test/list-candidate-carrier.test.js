// 會員列表「候選載體」不變量測試（裁決 §4.3 要求的三條）。
//
// 這個檔案存在的理由：這一包把候選載體換成「投影預篩 ＋ 共用列集合」，最容易犯的錯是
//   (a) 為了變快而偷偷加 LIMIT（`totalMatched` 就不再來自完整候選集），
//   (b) 為了變窄而少取某道過濾／排序真正會讀的欄位（astra §2.1 待過的坑：窄欄位實驗撤回）。
// 這裡把三條都固定成可重跑的斷言。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LIST_CANDIDATE_COLUMNS, LIST_CANDIDATE_KEYS,
  MEMBER_LIST_CANDIDATE_COLUMNS, MEMBER_LIST_CANDIDATE_KEYS, MEMBER_LIST_REQUIRED_COLUMNS, missingMemberListColumns,
} from "../src/listingCandidateRow.js";
import { buildListListingsClauses } from "../src/db.js";

// 每一道會員候選階段的過濾／排序 → 它真正會讀到的欄位（以碼為準，檔:行）。
// 這張表就是「窄化到什麼程度才算安全」的判準：任何被列到的欄位都**不准**從載體移除。
const REQUIREMENT_TABLE = Object.freeze({
  "post_id": "識別／排序鍵／同戶群組比對（db.js buildListListingsSteps、paginateListListingsRowsAsync）",
  "source": "listingTieBreakKey / matchesListingSources（floors.js:229）",
  "source_id": "listingTieBreakKey（match.js comparableRent 的穩定 tie-break）",
  "source_key": "districtNameFromListing 的第一來源（regions.js:52）、行政區前綴",
  "url": "listingExtrasSnapshot（repository/decorationData.js）",
  "price": "rentAmount（listingCost.js:209）、租金排序",
  "price_num": "rentAmount、listingFitFields",
  "extra_fee": "extraMonthlyAmount（listingCost.js:209）",
  "extra_fees": "extraMonthlyAmount、comparableRent",
  "extra_fee_text": "extraMonthlyAmount",
  "price_contain_text": "rentAmount 的「含」字樣判定",
  "title": "listingFilterHay、districtNameFromListing 的 address/title fallback（regions.js:52）",
  "address": "listingFilterHay、districtNameFromListing fallback",
  "address_norm": "overlayRowsPersonal（personalFlags.js:276 帶出的個人旗標列）",
  "area_name": "areaNum（match.js:45）",
  "layout": "candidateRowWithPersonal（listingCandidateRow.js）逐欄複製",
  "floor_name": "buildingTotalFloors／passesDisplayFilters（floors.js:383/398）",
  "kind_name": "matchesHousingKind（floors.js:322）",
  "tags": "listingFilterHay、rentAmount 的額外費用字樣",
  "role_name": "card 裝飾與來源角色",
  "contact_name": "排除業務／代理人規則（applyListingFilter）",
  "contact_role": "排除業務規則",
  "contact_uid": "排除業務規則（contact_uid 白名單）",
  "agency": "排除房仲（agency 比對）",
  "lat": "通勤／直線距離（applyCachedCoords、passesGeoFilters）",
  "lng": "通勤／直線距離",
  "geo_source": "isTrustedGeoSource、resolveLocationClass",
  "location_class": "clearanceEffectiveLocationClass（floors.js:505）",
  "match_post_id": "同戶配對（attachSameHouseRoleSteps、provider.splitPairs）",
  "match_level": "filter=suspected 的 SQL 子句與角色判定",
  "match_verdict": "listingMatchesListFilter、same_house 判定（db.js:3778）",
  "match_rejected": "same_house 判定（db.js:3778 `Number(row.match_rejected) === 1`）",
  "offline": "listingMatchesListFilter、offline 篩選",
  "offline_confirmed": "offline 篩選",
  "hidden": "listingMatchesListFilter、個人旗標 overlay",
  "hidden_at": "overlayPersonal 的 hidden_at 合成（personalFlags.js:276 `row.hidden_at`）",
  "last_event": "candidateRowWithPersonal 逐欄複製＋filter=same_source 契約",
  "first_seen_at": "listingEffectiveUpdatedAt／refresh 判定",
  "last_seen_at": "listingRefreshAt（match.js）",
  "refresh_time": "listingEffectiveUpdatedAt",
  "listed_by_user_id": "keepSelfListingForViewer／isSelfListingRow（selfListings.js）",
  "self_status": "keepSelfListingForViewer（selfListings.js:522 契約）",
  "source_published_at": "newest 排序的 listingEffectiveUpdatedAt（db.js，發佈日為第二順位時間來源）＋列表卡「發佈」列（index.html formatListingPublished）",
});

test("(a) 候選 SELECT 不含 LIMIT：載體由完整候選集合決定", () => {
  const source = readFileSync(new URL("../src/listingSearchNodePg.js", import.meta.url), "utf8");
  // loadSearchCandidateRows 內的三段候選 SQL 都不得出現 LIMIT／FETCH FIRST。
  const body = source.slice(source.indexOf("export async function loadSearchCandidateRows"),
    source.indexOf("async function searchListingsNodePgInner"));
  assert.ok(body.length > 0, "找不到 loadSearchCandidateRows");
  assert.doesNotMatch(body, /\bLIMIT\b/i, "候選載體不得出現 LIMIT");
  assert.doesNotMatch(body, /\bFETCH\s+FIRST\b/i, "候選載體不得出現 FETCH FIRST");
  // 而且建構出的 where 片段本身也不含 LIMIT。
  const built = buildListListingsClauses({
    filter: "all", kind: "", sources: "", districts: [], uid: 1, voteUid: 1,
    settings: {}, context: fakeContext(),
  }, { sqliteDb: null });
  assert.doesNotMatch(built.where, /\bLIMIT\b/i);
});

test("(b) totalMatched 由完整候選集合推導（paginate 的輸入等於完整集合長度）", async () => {
  const { paginateListListingsRowsAsync } = await import("../src/db.js");
  const rows = Array.from({ length: 137 }, (_, i) => ({ post_id: i + 1, price_num: 1000 + i, last_seen_at: "2026-01-01T00:00:00.000Z" }));
  const page = await paginateListListingsRowsAsync(rows, { sort: "price_asc", filter: "all", settings: {}, limit: 20, offset: 0 });
  assert.equal(page.totalMatched, rows.length, "totalMatched 必須等於完整集合長度");
  assert.equal(page.page.length, 20);
  assert.equal(page.hasMore, true);
  const tail = await paginateListListingsRowsAsync(rows, { sort: "price_asc", filter: "all", settings: {}, limit: 20, offset: 120 });
  assert.equal(tail.totalMatched, rows.length, "換頁不得改變 totalMatched");
  assert.equal(tail.page.length, 17);
});

test("(c) 窄化欄位不足以支撐任一排序鍵／判定時必須失敗", () => {
  // 需求表與實際載體必須一致：每個被讀到的欄位都在載體裡。
  for (const column of Object.keys(REQUIREMENT_TABLE)) {
    assert.ok(MEMBER_LIST_CANDIDATE_KEYS.includes(column),
      `載體缺少 ${column}（${REQUIREMENT_TABLE[column]}）`);
  }
  assert.deepEqual([...MEMBER_LIST_REQUIRED_COLUMNS].sort(), Object.keys(REQUIREMENT_TABLE).sort(),
    "需求表與 MEMBER_LIST_REQUIRED_COLUMNS 必須逐欄一致");
  // 反例（astra §2.1 的坑）：拿掉通勤／距離排序真正會讀的 lat/lng 必須被判定為不合法。
  const narrowed = MEMBER_LIST_CANDIDATE_KEYS.filter((c) => c !== "lat" && c !== "lng");
  const missing = MEMBER_LIST_REQUIRED_COLUMNS.filter((c) => !narrowed.includes(c));
  assert.deepEqual(missing, ["lat", "lng"], "少了 lat/lng 一定要被驗證器抓到");
  const withoutAddress = MEMBER_LIST_CANDIDATE_KEYS.filter((c) => c !== "address" && c !== "title");
  assert.deepEqual(
    MEMBER_LIST_REQUIRED_COLUMNS.filter((c) => !withoutAddress.includes(c)).sort(),
    ["address", "title"], "少了 address/title 一定要被驗證器抓到（關鍵字與行政區 fallback）");
});

test("候選載體是 43 欄全集的子集，且與 PG 路徑用的是同一份定義", () => {
  const full = new Set(LIST_CANDIDATE_KEYS);
  assert.equal(full.size, 43, "canonical candidate 仍為 43 欄（2026-10-12 起：42 ＋ source_published_at）");
  for (const column of MEMBER_LIST_CANDIDATE_KEYS) {
    assert.ok(full.has(column), `${column} 必須是 43 欄全集的子集`);
  }
  // 逐欄查證（2026-10-11）：42 欄**全部**都有候選階段的讀取點 ⇒ 本包不做欄位級瘦身，
  // 只做「集合級」縮窄（投影預篩）。這條斷言把「不得無證據瘦身」固定住。
  // 2026-10-12 追加 source_published_at（讀取點：newest 排序的 listingEffectiveUpdatedAt、
  // 列表卡的「發佈」列）⇒ 43 欄，REQUIREMENT_TABLE 同步補上。
  assert.equal(MEMBER_LIST_CANDIDATE_KEYS.length, 43,
    "目前沒有任何欄位有『候選階段不讀』的證據；若未來要瘦身，必須先更新 REQUIREMENT_TABLE 並附 parity");
  assert.equal(MEMBER_LIST_CANDIDATE_COLUMNS, LIST_CANDIDATE_COLUMNS);
});

// 假 context：只要滿足 buildListListingsClauses 的 PG 前提即可（不觸及任何 SQLite）。
function fakeContext() {
  return {
    isolation: { sql: "1 = 1", params: [] },
    searchKeys: [],
    crawlSources: { items: [] },
    systemCrawl: { isSystemCrawlSource: () => false },
    now: Date.now(),
    asOf: null,
    degraded: [],
  };
}
