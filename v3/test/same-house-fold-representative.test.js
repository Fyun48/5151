// Owner 2026-10-12 裁示③「次卡要跟著主卡走」的非對稱驗收：
//   一般：代表列（＝主卡）自己的旗標決定整群；次卡不參與判斷（不准逐則自判）。
//   特別關注／已隱藏：群內**任一**成員被關注／被隱藏 ⇒ 該群出現，且出現的那一列是主卡。
// 並釘住「逐則取消關注」仍走既有面板按鈕與既有端點（不新增端點）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachSameHouseRoles } from "../src/db.js";
import { listingIsMainListAffiliate, listingMatchesListFilter } from "../src/personalFlags.js";
import { sameHouseBundle } from "../src/listingCompare.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-12T02:00:00.000Z");
const SRC = path.join(dir, "../src");
const readSrc = (rel) => readFileSync(path.join(SRC, rel), "utf8");

function makeProvider() {
  return {
    driver: "postgres",
    now: NOW,
    sourceEnabled: () => true,
    prep: () => null,
    groupId: () => "",
    extras: () => new Map(),
    splitPairs: () => new Set(),
    personalIndex: () => ({ size: 0, groupKey: () => "", peers: () => [], agrees: () => true }),
  };
}

function listing(post_id, { rent = 20000, ...rest } = {}) {
  return {
    post_id,
    source: "591",
    source_id: `s${post_id}`,
    url: `https://example.test/${post_id}`,
    title: `t${post_id}`,
    price: `${rent}元`,
    price_num: rent,
    extra_fee: 0,
    extra_fees: [],
    extra_fee_text: "",
    price_contain_text: "",
    refresh_time: "1 小時前",
    last_seen_at: "2026-10-01T00:00:00.000Z",
    match_post_id: null,
    match_verdict: null,
    match_level: "",
    offline: 0,
    offline_confirmed: 0,
    hidden: 0,
    viewed: 0,
    watched: 0,
    ...rest,
  };
}

/** 主卡（便宜）＋次卡（貴），邊由次卡指向主卡。回傳 attaches 過的列。 */
function pair({ primaryFlags = {}, affiliateFlags = {} } = {}) {
  const primary = listing(40001, { rent: 18000, ...primaryFlags });
  const affiliate = listing(40002, { rent: 24000, ...affiliateFlags });
  affiliate.match_post_id = primary.post_id;
  const rows = [primary, affiliate];
  attachSameHouseRoles(rows, 0, makeProvider(), NOW);
  return { primary, affiliate, rows };
}

const shown = (rows, filter) => rows.filter((row) => listingMatchesListFilter(row, filter)).map((row) => row.post_id);

test("非對稱：primary 未關注／affiliate 已關注 ⇒ 一般出現 primary、特別關注出現 primary（不是 affiliate）", () => {
  const { primary, affiliate, rows } = pair({ affiliateFlags: { watched: 1 } });
  assert.equal(primary.same_house_role, "primary");
  assert.equal(affiliate.same_house_role, "affiliate");
  // 一般：代表列（主卡）自己沒被關注 ⇒ 整群在一般清單，出現的是主卡。
  assert.deepEqual(shown(rows, "all"), [40001]);
  // 特別關注：群內任一成員被關注 ⇒ 該群出現，出現的那一列是主卡，不是那則 affiliate。
  assert.deepEqual(shown(rows, "watched"), [40001]);
  assert.equal(affiliate.same_house_group_watched, 1, "群級聚合要帶到主卡那一列");
  assert.equal(primary.same_house_group_watched, 1);
  assert.equal(listingIsMainListAffiliate(affiliate), true, "次卡仍必須被折疊");
});

test("非對稱（鏡像）：primary 已關注／affiliate 未關注 ⇒ 一般整群不在，特別關注只出現 primary", () => {
  const { rows } = pair({ primaryFlags: { watched: 1 } });
  assert.deepEqual(shown(rows, "all"), [], "主卡自己被關注 ⇒ 整群不在一般（不看次卡的旗標）");
  assert.deepEqual(shown(rows, "watched"), [40001]);
});

test("非對稱：affiliate 已隱藏 ⇒ 已隱藏清單以 primary 列示；一般清單不受次卡旗標影響", () => {
  const { rows } = pair({ affiliateFlags: { hidden: 1 } });
  assert.deepEqual(shown(rows, "hidden"), [40001]);
  assert.deepEqual(shown(rows, "all"), [40001], "代表列自己沒被隱藏 ⇒ 整群留在一般");
});

test("非對稱（鏡像）：primary 已隱藏 ⇒ 整群不在一般，已隱藏清單出現 primary", () => {
  const { rows } = pair({ primaryFlags: { hidden: 1 } });
  assert.deepEqual(shown(rows, "all"), []);
  assert.deepEqual(shown(rows, "hidden"), [40001]);
});

test("三成員群：任一成員被關注 ⇒ 只出一列主卡（不是兩列）", () => {
  const A = listing(40101, { rent: 17000 });
  const B = listing(40102, { rent: 19000 });
  const C = listing(40103, { rent: 26000, watched: 1 });
  B.match_post_id = A.post_id;
  C.match_post_id = B.post_id;
  const rows = [A, B, C];
  attachSameHouseRoles(rows, 0, makeProvider(), NOW);
  // 鏈狀：C 被關注，但整群只有 A 當主卡。
  assert.deepEqual(rows.map((r) => `${r.post_id}:${r.same_house_role}`), ["40101:primary", "40102:affiliate", "40103:affiliate"]);
  assert.deepEqual(shown(rows, "watched"), [40101]);
  assert.deepEqual(shown(rows, "all"), [40101]);
});

test("沒有折疊的單列：旗標照舊（群級聚合不影響非群組列）", () => {
  const solo = listing(40201, { watched: 1 });
  const rows = [solo];
  attachSameHouseRoles(rows, 0, makeProvider(), NOW);
  assert.equal(solo.same_house_role, undefined);
  assert.deepEqual(shown(rows, "watched"), [40201]);
  assert.deepEqual(shown(rows, "all"), []);
});

test("面板逐則取消關注：只走既有 sameHouseGoneBtn → POST /api/listings/:id/flags（不准新增端點）", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /sameHouseGoneBtn/);
  assert.match(html, /\/api\/listings\/\$\{[^}]*\}\/flags/);
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const endpoints = [...server.matchAll(/app\.(?:post|put|patch|delete)\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(endpoints.filter((p) => /\/flags/.test(p)).sort(), ["/api/listings/:id/flags"]);
});

test("listingIsMainListAffiliate：簽名沒有 filter 參數，註解不再宣稱相容保留", () => {
  // 簽名（1 個參數）與註解必須一致：拿掉 filter 參數後，`listingMatchesListFilter` 也對齊呼叫。
  assert.equal(listingIsMainListAffiliate.length, 1);
  const src = readSrc("personalFlags.js");
  assert.doesNotMatch(src, /參數保留只為呼叫端相容/);
  assert.doesNotMatch(src, /語意上已不再分支/);
  assert.match(src, /沒有 `filter` 參數/);
  assert.match(src, /listingIsMainListAffiliate\(row\)/);
  const bundle = sameHouseBundle([listing(40301), listing(40302)]);
  assert.ok(bundle === null || typeof bundle === "object", "sameHouseBundle 仍可呼叫（簽名未漂移）");
});
