import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bestMatch, listingTotalCost, preferPrimaryListing, scoreMatch } from "../src/match.js";

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
    layout: "3房1廳",
    source_key: "3|50||淡水區淡金路二段|11F|15.5|3房1廳",
    community_id: 0,
  };
  const previous = { ...base, viewed: 1, role_name: "湯小姐", source_key: "other-key" };
  const hit = scoreMatch(incoming, previous);
  assert.ok(hit);
  assert.match(hit.detail, /已瀏覽/);
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
  assert.match(dbSrc, /source_label: selfSourceLabel\(source\)/);
  assert.match(dbSrc, /const primary = preferPrimaryListing\(listing, peer\)/);
  assert.match(dbSrc, /hidden = 1/);
  const suspected = dbSrc.slice(dbSrc.indexOf('if (filter === "suspected")'), dbSrc.indexOf('} else if (filter === "offline")'));
  assert.match(suspected, /match_verdict/);
});
