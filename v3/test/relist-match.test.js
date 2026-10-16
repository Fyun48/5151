import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bestMatch, listingTotalCost, matchVeto, preferPrimaryListing, scoreMatch } from "../src/match.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

const base = {
  post_id: 1001,
  address: "新北市淡水區淡金路二段173號",
  floor_name: "11F/14F",
  area_name: "15.5坪",
  layout: "2房1廳",
  role_name: "湯小姐",
  cover: "https://img.example/a.jpg!800x600",
  community_id: 101675,
  source_key: "3|50|c101675|新北市淡水區淡金路二段173號|11F|15.5|2房1廳",
};

test("offline re-upload on same street/floor/area is same source even without cover match", () => {
  const incoming = {
    ...base,
    post_id: 2002,
    cover: "https://img.example/brand-new-photo.jpg",
    source_key: "3|50||淡水區淡金路二段173號|11F|15.5|2房1廳",
    community_id: 0,
  };
  const previous = { ...base, offline: 1 };
  const hit = scoreMatch(incoming, previous);
  assert.ok(hit);
  assert.equal(hit.level, "high");
  assert.match(hit.detail, /下架後重刊|先前 #1001/);
});

test("viewed previous listing also matches soft relist fingerprint", () => {
  const incoming = {
    ...base,
    post_id: 3003,
    cover: "https://cdn/other.png",
    role_name: "別人",
    layout: "2房1廳",
    source_key: "3|50||淡水區淡金路二段|11F|15.5|2房1廳",
    community_id: 0,
  };
  const previous = { ...base, viewed: 1, role_name: "湯小姐", source_key: "other-key" };
  const hit = scoreMatch(incoming, previous);
  assert.ok(hit);
  assert.match(hit.detail, /同門牌樓層|已瀏覽|先前 #1001/);
  assert.ok(hit.evidence?.signals?.length);
  assert.ok(hit.confidence >= 0.6);
});

test("street-only vs alley does not auto high-match without extra evidence", () => {
  const incoming = {
    post_id: 501,
    address: "台北市士林區天玉街9巷",
    floor_name: "4/4",
    area_name: "19坪",
    layout: "1房1廳1衛",
    role_name: "仲介",
    cover: "https://img.example/a.jpg",
  };
  const previous = {
    post_id: 502,
    address: "台北市士林區天玉街",
    floor_name: "4/4",
    area_name: "19坪",
    layout: "1房1廳1衛",
    role_name: "仲介",
    cover: "https://img.example/b.jpg",
  };
  const hit = scoreMatch(incoming, previous);
  if (hit) assert.equal(hit.level, "medium");
});

test("different layout / house number / floor must not merge", () => {
  const previous = { ...base };
  assert.equal(scoreMatch({ ...base, post_id: 9, layout: "3房1廳", source_key: "x" }, previous), null);
  assert.equal(scoreMatch({
    ...base,
    post_id: 10,
    address: "新北市淡水區淡金路二段175號",
    source_key: "y",
  }, previous), null);
  assert.equal(scoreMatch({
    ...base,
    post_id: 11,
    floor_name: "8F/14F",
    source_key: "z",
  }, previous), null);
});

test("invalid rent cannot beat a comparable rent when choosing primary", () => {
  const priced = { post_id: 1, price_num: 20000, refresh_time: "3天前" };
  const broken = { post_id: 2, price_num: 0, price: "面議", refresh_time: "剛剛" };
  assert.equal(preferPrimaryListing(priced, broken).post_id, 1);
  assert.equal(preferPrimaryListing(broken, priced).post_id, 1);
});

test("same rent and refresh uses deterministic tie-break", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const a = { post_id: 30, source: "591", source_id: "b", price_num: 20000, refresh_time: "剛剛" };
  const b = { post_id: 20, source: "591", source_id: "a", price_num: 20000, refresh_time: "剛剛" };
  assert.equal(preferPrimaryListing(a, b, now).post_id, preferPrimaryListing(b, a, now).post_id);
  assert.equal(preferPrimaryListing(a, b, now).post_id, 20);
});

// Owner 2026-10-16 的「有 591 就用 591」層：位置在 last_seen_at 層之後、tie-break key 層之前。
// 註：本專案現行來源（591／hbhousing／sinyi／houseprice／ddroom／housefun／self）的第一個字元
// 都排在 '5' 之後，所以這一層對現行來源通常與 tie-break 同向（正式庫 2026-10-16 實測 0 群由
// tie-break 決定勝負 ⇒ 行為中性）；要單獨釘住這一層的位置，只能用排在最前面的合成來源。
test("591 platform preference sits between last_seen_at and the tie-break key", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const shared = { price_num: 20000, refresh_time: "剛剛", last_seen_at: "2026-08-31T11:00:00.000Z" };
  const p591 = { ...shared, post_id: 50, source: "591", source_id: "z" };
  // '0zzz' 的 key（'0zzz:a:801'）字典序在 '591:z:50' 之前 ⇒ 若少了 591 層，合成的 0zzz 會贏。
  const earlierKey = { ...shared, post_id: 801, source: "0zzz", source_id: "a" };
  assert.equal(preferPrimaryListing(earlierKey, p591, now).post_id, 50, "有 591 就用 591");
  assert.equal(preferPrimaryListing(p591, earlierKey, now).post_id, 50, "順序無關（同一贏家）");
  // 空字串 source 正規化成 '591'（與 SQL 的 COALESCE(NULLIF(source,''),'591') 同一條，spec §6.10）。
  const blank = { ...shared, post_id: 802, source: "", source_id: "a" };
  assert.equal(preferPrimaryListing(blank, earlierKey, now).post_id, 802, "空字串 source 視為 591");
  // last_seen_at 層在前：另一邊 last_seen_at 較大時，即使它是別家來源也先贏。
  const newerOther = { ...shared, post_id: 803, source: "hbhousing", source_id: "a", last_seen_at: "2026-08-31T11:30:00.000Z" };
  assert.equal(preferPrimaryListing(newerOther, p591, now).post_id, 803);
  // 兩邊都不是 591 ⇒ 回到固定序（tie-break key 較小者贏），不得引入隨機。
  const h1 = { ...shared, post_id: 804, source: "hbhousing", source_id: "a" };
  const h2 = { ...shared, post_id: 805, source: "sinyi", source_id: "b" };
  assert.equal(preferPrimaryListing(h1, h2, now).post_id, preferPrimaryListing(h2, h1, now).post_id);
  assert.equal(preferPrimaryListing(h1, h2, now).post_id, 804);
});

test("cross-source community_id numbers do not veto", () => {
  const incoming = {
    ...base,
    post_id: 91001,
    source: "sinyi",
    community_id: 555,
    source_key: "3|50|c555|新北市淡水區淡金路二段173號|11F|15.5|2房1廳",
  };
  const previous = { ...base, source: "591", community_id: 101675 };
  assert.equal(matchVeto(incoming, previous).includes("community_id_mismatch"), false);
  const hit = scoreMatch(incoming, previous);
  assert.ok(hit);
});

test("same-source different community_id still vetoes", () => {
  const incoming = { ...base, post_id: 91002, source: "591", community_id: 222, source_key: "x" };
  const previous = { ...base, source: "591", community_id: 101675 };
  assert.ok(matchVeto(incoming, previous).includes("community_id_mismatch"));
  assert.equal(scoreMatch(incoming, previous), null);
});

test("cross-source listings can still be suspected same house", () => {
  const incoming = {
    ...base,
    post_id: 2400000001,
    source: "houseprice",
    cover: "https://image.houseprice.tw/a.jpg",
    source_key: "3|50||新北市淡水區淡金路二段173號|11F|15.5|2房1廳",
  };
  const previous = { ...base, source: "591", offline: 1 };
  const hit = scoreMatch(incoming, previous);
  assert.ok(hit);
  assert.equal(hit.level, "high");
});

test("unrelated live listing without shared fingerprint does not match", () => {
  const incoming = {
    ...base,
    post_id: 4004,
    cover: "https://cdn/x.png",
    layout: "3房2廳",
    role_name: "王先生",
    source_key: "incoming-key",
    community_id: 0,
  };
  const previous = {
    ...base,
    offline: 0,
    hidden: 0,
    viewed: 0,
    source_key: "previous-key",
    community_id: 0,
  };
  assert.equal(scoreMatch(incoming, previous), null);
});

test("bestMatch prefers high-confidence offline sibling", () => {
  const incoming = {
    ...base,
    post_id: 5005,
    cover: "https://cdn/new.png",
    source_key: "incoming-key",
    community_id: 0,
  };
  const hit = bestMatch(incoming, [
    {
      ...base,
      post_id: 11,
      offline: 0,
      viewed: 0,
      hidden: 0,
      floor_name: "3F/5F",
      source_key: "a",
      community_id: 0,
    },
    { ...base, post_id: 22, offline: 1, source_key: "b", community_id: 0 },
  ]);
  assert.equal(hit.listing.post_id, 22);
  assert.equal(hit.level, "high");
});

test("confirm same listing keeps the cheaper post as primary", () => {
  const cheap = { post_id: 1, price_num: 18000, refresh_time: "3天前", last_seen_at: "2026-01-01T00:00:00.000Z" };
  const pricey = { post_id: 2, price_num: 22000, refresh_time: "剛剛", last_seen_at: "2026-08-31T00:00:00.000Z" };
  assert.equal(preferPrimaryListing(cheap, pricey).post_id, 1);
  assert.equal(preferPrimaryListing(pricey, cheap).post_id, 1);
});

test("cheaper includes extra_fee when choosing the primary listing", () => {
  const lowRentHighExtra = { post_id: 1, price_num: 18000, extra_fee: 5000, refresh_time: "剛剛" };
  const higherRentNoExtra = { post_id: 2, price_num: 20000, extra_fee: 0, refresh_time: "3天前" };
  assert.equal(preferPrimaryListing(lowRentHighExtra, higherRentNoExtra).post_id, 2);
  assert.equal(listingTotalCost(lowRentHighExtra), 23000);
});

test("extra_fees rows count when extra_fee column is empty", () => {
  const withRows = { post_id: 1, price_num: 18000, extra_fee: 0, extra_fees: [{ amount: 4000 }] };
  const cheaper = { post_id: 2, price_num: 19000, extra_fee: 0 };
  assert.equal(listingTotalCost(withRows), 22000);
  assert.equal(preferPrimaryListing(withRows, cheaper).post_id, 2);
});

test("same price keeps the listing updated more recently", () => {
  const older = { post_id: 1, price_num: 20000, refresh_time: "3天前" };
  const newer = { post_id: 2, price_num: 20000, refresh_time: "2小時前" };
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  assert.equal(preferPrimaryListing(older, newer, now).post_id, 2);
  assert.equal(preferPrimaryListing(newer, older, now).post_id, 2);
});

test("same price without refresh_time uses last_seen_at", () => {
  const older = { post_id: 1, price_num: 20000, last_seen_at: "2026-08-01T00:00:00.000Z" };
  const newer = { post_id: 2, price_num: 20000, last_seen_at: "2026-08-31T00:00:00.000Z" };
  assert.equal(preferPrimaryListing(older, newer).post_id, 2);
});

test("suspected peer payload includes source and confirm keeps cheaper listing", () => {
  const dbSrc = readFileSync(path.join(dir, "../src/db.js"), "utf8");
  assert.match(dbSrc, /sameHouseBundle/);
  assert.match(dbSrc, /cost_change: costChangePayload\(row\)/);
  assert.match(dbSrc, /idx_listings_match_peer/);
  const matchFns = dbSrc.slice(dbSrc.indexOf("export function findBySourceKey"), dbSrc.indexOf("export function setListingMatch"));
  assert.match(matchFns, /overlayPersonal/);
  assert.doesNotMatch(matchFns, /decorateListing\(/);
  assert.match(dbSrc, /source_label: selfSourceLabel\(source\)/);
  // 2026-10-12「一群一主」：先建連通分量（union-find），再用唯一比較式
  // sortGroupListings(...)[0] 選出恰好一個 primary。舊的成對 assignRole 先到先贏已移除。
  assert.match(dbSrc, /sortGroupListings\(eligible\.map\(\(m\) => m\.row\), now\)\[0\]/);
  // 2026-10-12 (B) 方案：union-find 只有一份（foldComponentRoot.js），讀取端以 `yield*` 呼叫它，
  // 邊規則仍釘在同一個 regex 上；db.js 不准再長出第二份分量演算法。
  const rootSrc = readFileSync(path.join(dir, "../src/foldComponentRoot.js"), "utf8");
  assert.match(rootSrc, /compUnion\(Number\(row\.post_id\), mid\)/);
  assert.match(dbSrc, /yield\* buildSameHouseComponents\(/);
  assert.doesNotMatch(dbSrc, /compUnion\(/);
  assert.doesNotMatch(dbSrc, /const primary = preferPrimaryListing\(row, peer, now\)/);
  assert.match(dbSrc, /hidden = 1/);
  const suspected = dbSrc.slice(dbSrc.indexOf('if (filter === "suspected")'), dbSrc.indexOf('} else if (filter === "offline")'));
  assert.match(suspected, /match_verdict/);
});
