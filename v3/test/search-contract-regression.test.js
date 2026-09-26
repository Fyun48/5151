import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("K: member listListings filter contract is still the baseline file", async () => {
  const regression = readFileSync(path.join(dir, "list-query-regression.test.js"), "utf8");
  assert.match(regression, /every sorted page uses the complete filtered set/);
  assert.match(regression, /personal merge, flags and notes stay isolated/);
  assert.match(regression, /attribute filtering before route lookup/);
  assert.match(regression, /district candidates preserve legacy keys/);

  // astra 2026-09-25 §3.6：原本這裡切片比對原始碼文字（`listListings` 內須含 passesDisplayFilters…）✗
  // ⇒ 共用管線重構後就誤報。改為**行為驗證**：
  //   成員路徑：行政區來自 settings（memberRegionDistrictNames）＋ 顯示篩選確實排除不合的列。
  //   公開路徑：不需要任何使用者身分即可運作（searchWhere([])／無 defaultUserId）。
  const mod = await import("../src/db.js");
  const { buildListListingsClauses, buildListListingsRows, listPublicListings } = mod;
  assert.equal(typeof buildListListingsClauses, "function");
  assert.equal(typeof buildListListingsRows, "function");
  assert.equal(typeof listPublicListings, "function");

  // 成員：settings 的 searchUrls 會經 districtsFromSearchUrls → memberRegionDistrictNames 決定行政區
  // （用真實的 591 搜尋 URL，避免綁死行政區鍵／名稱）
  const memberSettings = {
    searchUrls: ["https://rent.591.com.tw/list?region=1&section=2%2C3%2C8%2C9&order=posttime&orderType=desc"],
    areaMax: 20,
  };
  const built = buildListListingsClauses({
    filter: "all", districts: [], settings: memberSettings, uid: 0, voteUid: 0,
  });
  assert.ok(built.districtNames.length > 0, `成員的行政區應來自 settings（實際 ${JSON.stringify(built.districtNames)}）`);

  // 成員：areaMax=20 是顯示篩選 ⇒ 40 坪的列必須被排除（行為，不看原始碼）
  const rows = [
    { post_id: 1, district: "西屯區", price_num: 10000, area_name: "10坪", kind_name: "整層住家", source: "591", match_verdict: "", offline: 0, hidden: 0 },
    { post_id: 2, district: "西屯區", price_num: 10000, area_name: "40坪", kind_name: "整層住家", source: "591", match_verdict: "", offline: 0, hidden: 0 },
  ];
  const filtered = buildListListingsRows(rows.map((r) => ({ ...r })), {
    filter: "all", kind: "", sources: "", sort: "price_asc",
    uid: 0, voteUid: 0, settings: memberSettings, districtSet: new Set(["西屯區"]), provider: null, flagMap: new Map(),
  });
  assert.deepEqual(filtered.map((r) => r.post_id), [1], "顯示篩選必須排除 40 坪的列");

  // 公開：沒有任何使用者身分的呼叫必須可以運作（不得依賴 defaultUserId／resolveUserId）
  const pub = await listPublicListings({ filter: "all", sort: "price_asc", limit: 3, offset: 0 });
  assert.ok(pub && Array.isArray(pub.listings), "公開路徑必須回傳 listings（不需要使用者身分）");
});
