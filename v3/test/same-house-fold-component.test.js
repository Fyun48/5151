// 「一群一主」驗收：連通分量（match 邊 ∪ listing_group_members 群組 ∪ 個人併組）內
// **恰好一個** primary，比較式沿用 match.js 的 sortGroupListings／preferPrimaryListing。
//
// 舊版是「first-incident-edge 成對」（db.js 的 assignRole 先到先贏），鏈狀 A–B–C 會出現
// 兩個 primary；這個檔案就是釘住「不可能再出現兩個 primary」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachSameHouseRoles } from "../src/db.js";
import { sortGroupListings } from "../src/match.js";
import { listingIsMainListAffiliate, listingMatchesListFilter } from "../src/personalFlags.js";
import { sameHouseBundle } from "../src/listingCompare.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-12T02:00:00.000Z");

/** 最小可用的裝飾來源：driver='postgres' ⇒ sourceEnabled 走 provider，不碰 SQLite 的全域設定。 */
function makeProvider({ groupIds = {}, extras = [], personalGroups = {}, splits = [] } = {}) {
  const extraById = new Map(extras.map((row) => [Number(row.post_id), row]));
  const peersByKey = new Map();
  for (const [key, ids] of Object.entries(personalGroups)) peersByKey.set(key, ids);
  const keyByPost = new Map();
  for (const [key, ids] of Object.entries(personalGroups)) for (const id of ids) keyByPost.set(Number(id), key);
  return {
    driver: "postgres",
    now: NOW,
    sourceEnabled: () => true,
    prep: () => null,
    groupId: (postId) => String(groupIds[Number(postId)] || ""),
    extras: (ids) => new Map(ids.filter((id) => extraById.has(Number(id))).map((id) => [Number(id), extraById.get(Number(id))])),
    splitPairs: () => new Set(splits),
    personalIndex: () => ({
      size: keyByPost.size,
      groupKey: (postId) => keyByPost.get(Number(postId)) || "",
      peers: (postId) => (peersByKey.get(keyByPost.get(Number(postId))) || []).filter((id) => Number(id) !== Number(postId)),
      agrees: () => true,
    }),
  };
}

function listing(post_id, { rent = 20000, extra = 0, refresh = "1 小時前", ...rest } = {}) {
  return {
    post_id,
    source: "591",
    source_id: `s${post_id}`,
    url: `https://example.test/${post_id}`,
    title: `t${post_id}`,
    price: `${rent}元`,
    price_num: rent,
    extra_fee: extra,
    extra_fees: extra ? [{ name: "管理費", value: "另計", amount: extra }] : [],
    extra_fee_text: "",
    price_contain_text: "",
    refresh_time: refresh,
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

const rolesOf = (rows) => rows.map((row) => `${row.post_id}:${row.same_house_role || "-"}`).sort();

// ① 鏈狀邊 A–B、B–C（A 與 C 無直接邊）⇒ 恰好 1 個 primary，且是總月費最低者。
test("chain A-B, B-C folds to exactly one primary (cheapest total monthly cost)", () => {
  const A = listing(30001, { rent: 20000 });
  const B = listing(30002, { rent: 18000 });
  const C = listing(30003, { rent: 22000 });
  A.match_post_id = B.post_id;
  B.match_post_id = C.post_id;
  const rows = [A, B, C];
  attachSameHouseRoles(rows, 0, makeProvider(), NOW);
  assert.equal(rows.filter((row) => row.same_house_role === "primary").length, 1, "恰好一個 primary");
  assert.deepEqual(rolesOf(rows), ["30001:affiliate", "30002:primary", "30003:affiliate"]);
  assert.equal(rows.find((row) => row.same_house_role === "affiliate").same_house_primary_id, 30002);
});

// ① 同價 ⇒ refresh 最新者當 primary（比較式第 2 層）。
test("chain tie on cost picks the newest refresh as the single primary", () => {
  const A = listing(31001, { rent: 20000, refresh: "3 天前" });
  const B = listing(31002, { rent: 20000, refresh: "剛剛" });
  const C = listing(31003, { rent: 20000, refresh: "5 小時前" });
  A.match_post_id = B.post_id;
  B.match_post_id = C.post_id;
  attachSameHouseRoles([A, B, C], 0, makeProvider(), NOW);
  assert.equal([A, B, C].filter((row) => row.same_house_role === "primary").length, 1);
  assert.equal(B.same_house_role, "primary");
});

// ② 只在 listing_group_members、兩端都沒有 match 邊的成員 ⇒ 同一群、只出一列。
test("group-table-only members (no match edges) fold into one component", () => {
  const X = listing(32001, { rent: 30000 });
  const Y = listing(32002, { rent: 26000 });
  const Z = listing(32003, { rent: 28000 });
  const provider = makeProvider({ groupIds: { 32001: "lg_a", 32002: "lg_a", 32003: "lg_a" } });
  attachSameHouseRoles([X, Y, Z], 0, provider, NOW);
  assert.equal([X, Y, Z].filter((row) => row.same_house_role === "primary").length, 1, "群組只出一列");
  assert.equal(Y.same_house_role, "primary");
  assert.deepEqual(rolesOf([X, Y, Z]), ["32001:affiliate", "32002:primary", "32003:affiliate"]);
  // 主列表：只有 primary 會留著（affiliate 被折疊）。
  assert.equal(listingMatchesListFilter(X, "all"), false);
  assert.equal(listingMatchesListFilter(Y, "all"), true);
});

// ② 兩端都沒有 match 邊、且「只有自己在群組裡」（單成員分量）⇒ 不指派 role，留在主列表。
test("a group with a single member in scope keeps no role", () => {
  const solo = listing(33001, { rent: 21000 });
  const provider = makeProvider({ groupIds: { 33001: "lg_solo" } });
  attachSameHouseRoles([solo], 0, provider, NOW);
  assert.equal(solo.same_house_role || "", "");
  assert.equal(listingMatchesListFilter(solo, "all"), true);
});

// ④ 補償條款：primary 已下架（offline）而 affiliate 還在 ⇒ affiliate 仍留列表。
test("compensation clause keeps the live affiliate when the primary is offline", () => {
  const gone = listing(34001, { rent: 15000, offline: 1 });
  const live = listing(34002, { rent: 19000 });
  gone.match_post_id = live.post_id;
  attachSameHouseRoles([gone, live], 0, makeProvider(), NOW);
  assert.equal(gone.same_house_role, "primary");
  assert.equal(live.same_house_role, "affiliate");
  assert.equal(live.same_house_primary_offline, true);
  assert.equal(listingIsMainListAffiliate(live, "all"), false, "affiliate 仍留列表");
  assert.equal(listingMatchesListFilter(live, "all"), true);
  assert.equal(listingMatchesListFilter(gone, "all"), true, "可能空號（offline=1 未確認）維持顯示");
});

// Owner ③：確認下架（offline_confirmed=1）不參與選主、三個清單都 0 列。
test("offline_confirmed rows are never primary and never listed", () => {
  const cheapConfirmed = listing(35001, { rent: 9000, offline: 1, offline_confirmed: 1 });
  const pricey = listing(35002, { rent: 25000 });
  cheapConfirmed.match_post_id = pricey.post_id;
  attachSameHouseRoles([cheapConfirmed, pricey], 0, makeProvider(), NOW);
  assert.equal(pricey.same_house_role, "primary", "最便宜的確認下架列不得當 primary");
  assert.equal(cheapConfirmed.same_house_role, "affiliate");
  for (const filter of ["all", "watched", "hidden"]) {
    assert.equal(listingMatchesListFilter({ ...cheapConfirmed, watched: 1, hidden: 1 }, filter), false, filter);
  }
});

// Owner ①：特別關注清單不再豁免折疊（同一連通群只出一列）。
test("watched list folds affiliates exactly like the general list", () => {
  const primary = { same_house_role: "primary", watched: 1, hidden: 0, offline: 0, match_verdict: "" };
  const affiliate = { same_house_role: "affiliate", watched: 1, hidden: 0, offline: 0, match_verdict: "" };
  assert.equal(listingIsMainListAffiliate(affiliate), true);
  assert.equal(listingMatchesListFilter(affiliate, "watched"), false, "watched 不再豁免");
  assert.equal(listingMatchesListFilter(affiliate, "hidden"), false, "hidden 不再豁免");
  assert.equal(listingMatchesListFilter(primary, "watched"), true);
});

// Owner ②：一般清單排除 watched ∪ hidden；解除後該列回到一般清單。
test("general list excludes watched and hidden rows until they are cleared", () => {
  const base = { offline: 0, offline_confirmed: 0, match_verdict: "", match_level: "", last_event: "", viewed: 0 };
  const plain = { ...base, watched: 0, hidden: 0 };
  assert.equal(listingMatchesListFilter(plain, "all"), true);
  assert.equal(listingMatchesListFilter({ ...plain, watched: 1 }, "all"), false);
  assert.equal(listingMatchesListFilter({ ...plain, hidden: 1 }, "all"), false);
  // 解除關注／解除隱藏後回到一般清單。
  assert.equal(listingMatchesListFilter({ ...plain, watched: 0 }, "all"), true);
  assert.equal(listingMatchesListFilter({ ...plain, hidden: 0 }, "all"), true);
});

// ④ 「共 N 則」＝群組真實大小（4 則的群要顯示 4，不是伺服器回傳的截斷值 3）。
test("bundle exposes the true group size for the 共 N 則 label", () => {
  const mine = listing(36001, { rent: 30000 });
  const peers = [listing(36002, { rent: 26000 }), listing(36003, { rent: 28000 }), listing(36004, { rent: 32000 })];
  const bundle = sameHouseBundle(mine, peers, NOW);
  assert.equal(bundle.peer_count, 3, "真實群組大小 −1");
  assert.equal(bundle.peer_count + 1, 4, "共 N 則 = 4");
  assert.equal(bundle.peers.length, 2, "列出幾則仍是上限 2（只有「共 N 則」不准截斷）");
  assert.equal(bundle.is_primary, false);
  assert.equal(bundle.primary_id, 36002);
});

// ④ 前端必須用 peer_count 組「共 N 則」（不准再用 peers.length）。
test("frontend renders 共 N 則 from the true group size", () => {
  const html = readFileSync(path.join(dir, "..", "public", "index.html"), "utf8");
  assert.match(html, /const count = Number\(house\.peer_count \|\| 0\) \+ 1;/);
  assert.ok(!/const count = entries\.length;/.test(html), "不得再用截斷後的 entries.length");
});

// Owner ⑤：篩選按鈕文案「全部」→「一般」。
test("general filter chip is labelled 一般", () => {
  const html = readFileSync(path.join(dir, "..", "public", "index.html"), "utf8");
  assert.match(html, /<button class="chip on" data-filter="all">一般<\/button>/);
});

// Owner ①／配套：展開面板對群內每一則提供逐則取消關注／解除隱藏，且沿用既有端點（不新增端點）。
test("same-house panel offers per-post unwatch/unhide through the existing flags endpoint", () => {
  const html = readFileSync(path.join(dir, "..", "public", "index.html"), "utf8");
  assert.match(html, /data-peer-flag="unwatch" data-peer-post="\$\{id\}"/);
  assert.match(html, /data-peer-flag="unhide" data-peer-post="\$\{id\}"/);
  assert.match(html, /fetch\(`\/api\/listings\/\$\{pid\}\/flags`/);
  assert.match(html, /kind === "unwatch" \? \{ watched: false \} : \{ hidden: false \}/);
});

// 選主比較式本身不准被改（回歸釘）：一群一主必須等於 sortGroupListings 的第一位。
test("component primary equals sortGroupListings(...)[0] (single comparison rule)", () => {
  const A = listing(37001, { rent: 20000, extra: 1000 });
  const B = listing(37002, { rent: 19500, extra: 2000 });
  const C = listing(37003, { rent: 19900, extra: 0 });
  A.match_post_id = B.post_id;
  B.match_post_id = C.post_id;
  attachSameHouseRoles([A, B, C], 0, makeProvider(), NOW);
  const expected = Number(sortGroupListings([A, B, C], NOW)[0].post_id);
  const actual = [A, B, C].find((row) => row.same_house_role === "primary");
  assert.equal(Number(actual.post_id), expected);
});
