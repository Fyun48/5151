import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { listingInMemberScope } from "../src/covering.js";
import {
  closeSelfListing,
  createSelfListing,
  ensureSelfListingSchema,
  isSelfListingId,
  keepSelfListingForViewer,
  listMineSelfListings,
  reportSelfListing,
  SELF_LEGAL,
  SELF_POST_ID_BASE,
  selfListingMeta,
} from "../src/selfListings.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const OLD = "2026-01-01T00:00:00.000Z";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL DEFAULT '',
      search_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      price TEXT,
      price_num INTEGER,
      extra_fee INTEGER NOT NULL DEFAULT 0,
      extra_fee_text TEXT,
      price_contain_text TEXT,
      extra_fees TEXT,
      extra_fees_fetched INTEGER NOT NULL DEFAULT 0,
      address TEXT,
      area_name TEXT,
      layout TEXT,
      floor_name TEXT,
      kind_name TEXT,
      role_name TEXT,
      cover TEXT,
      tags TEXT,
      refresh_time TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_event TEXT NOT NULL DEFAULT 'new',
      viewed INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      hidden_at TEXT,
      match_post_id INTEGER,
      match_level TEXT,
      match_detail TEXT,
      match_rejected INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '591',
      source_id TEXT,
      model_score REAL,
      listed_by_user_id INTEGER,
      self_status TEXT,
      self_expires_at TEXT,
      self_body TEXT,
      contact_name TEXT,
      contact_role TEXT,
      mobile TEXT,
      phone TEXT,
      line_url TEXT,
      contact_fetched INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureSelfListingSchema(db);
  return db;
}

function addUser(db, { id, email, createdAt }) {
  db.prepare("INSERT INTO users(id, email, created_at) VALUES (?, ?, ?)").run(id, email, createdAt);
}

function sampleInput(extra = {}) {
  return {
    district: "1-8",
    rent: 25000,
    ping: 18,
    kind: "whole",
    role: "owner",
    floor: 3,
    total_floors: 5,
    rooms: 2,
    living: 1,
    bath: 1,
    contact_name: "林先生",
    address: "台北市士林區中正路100號",
    phone: "0912345678",
    body: "近捷運、可入住、有洗衣機。",
    ...extra,
  };
}

test("self listing ids stay above the reserved range and require login", () => {
  assert.equal(isSelfListingId(15801234), false);
  assert.equal(isSelfListingId(SELF_POST_ID_BASE + 1), true);
  assert.equal(isSelfListingId(2_200_000_000), false);
  assert.match(SELF_LEGAL, /不是仲介/);
  assert.match(selfListingMeta().legal, /不經手金錢/);
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  assert.throws(() => createSelfListing(db, 0, sampleInput()), /請先登入/);
  const row = createSelfListing(db, 1, sampleInput());
  assert.ok(row.post_id > SELF_POST_ID_BASE);
  assert.equal(row.source, "self");
  assert.equal(row.source_label, "站內刊登");
  assert.deepEqual(row.photos, []);
  assert.equal(row.kind_name, "整層住家");
  assert.match(row.search_key || db.prepare("SELECT search_key FROM listings WHERE post_id = ?").get(row.post_id).search_key, /region=1/);
  db.close();
});

test("open quota, new-account wait, close and report hide", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  addUser(db, { id: 2, email: "new@example.com", createdAt: new Date().toISOString() });
  addUser(db, { id: 3, email: "b@example.com", createdAt: OLD });
  addUser(db, { id: 4, email: "c@example.com", createdAt: OLD });
  createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路101號" }));
  createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路102號" }));
  createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路103號" }));
  assert.throws(
    () => createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路104號" })),
    /最多 3 則/,
  );
  assert.throws(
    () => createSelfListing(db, 2, sampleInput()),
    /24 小時/,
  );
  const mine = listMineSelfListings(db, 1);
  assert.equal(mine.length, 3);
  closeSelfListing(db, 1, mine[0].post_id);
  const afterClose = createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路105號" }));
  assert.equal(listMineSelfListings(db, 1).filter((row) => row.status === "open").length, 3);
  reportSelfListing(db, 3, afterClose.post_id, "廣告");
  const second = reportSelfListing(db, 4, afterClose.post_id, "廣告");
  assert.equal(second.hidden, true);
  db.close();
});

test("rejects unsafe photo url and matches an existing 591 listing", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  assert.throws(
    () => createSelfListing(db, 1, sampleInput({ cover: "javascript:alert(1)" })),
    /封面/,
  );
  assert.throws(
    () => createSelfListing(db, 1, sampleInput({ cover: "/media/self/../secret.jpg" })),
    /封面/,
  );
  const uploaded = createSelfListing(db, 1, sampleInput({
    address: "台北市士林區中正路199號",
    photos: ["/media/self/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg"],
  }));
  assert.equal(uploaded.cover, "/media/self/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg");
  assert.deepEqual(uploaded.photos, ["/media/self/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg"]);
  db.prepare(`
    INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num, address, area_name,
      layout, floor_name, kind_name, role_name, cover, first_seen_at, last_seen_at, last_event,
      viewed, watched, source, source_id
    ) VALUES (
      15801234, '1|8||台北市士林區中正路100號|3F|18|2房1廳1衛', '', '591 物件',
      'https://rent.591.com.tw/15801234', '25000', 25000, '台北市士林區中正路100號', '18坪',
      '2房1廳1衛', '3F/5F', '整層住家', '林先生', '', ?, ?, 'new', 0, 0, '591', '15801234'
    )
  `).run(OLD, OLD);
  const row = createSelfListing(db, 1, sampleInput(), new Date(), {
    matchCandidates: (listing) => db.prepare("SELECT * FROM listings WHERE post_id != ?").all(listing.post_id),
  });
  assert.ok(row.match_level);
  assert.match(row.match_detail || "", /先前 #15801234/);
  db.close();
});

test("self listings stay in member district scope", () => {
  const listing = {
    source: "self",
    source_key: "1|8||台北市士林區中正路100號|3F|18|2房1廳",
    price_num: 25000,
    listed_by_user_id: 9,
  };
  const settings = { watchDistricts: ["1-8"], priceMax: 30000 };
  assert.equal(listingInMemberScope(listing, settings), true);
  assert.equal(listingInMemberScope(listing, { watchDistricts: ["3-43"] }), false);
  assert.equal(keepSelfListingForViewer(listing, 1, settings, listingInMemberScope), true);
  assert.equal(keepSelfListingForViewer(listing, 1, { watchDistricts: ["3-43"] }, listingInMemberScope), false);
  assert.equal(keepSelfListingForViewer(listing, 9, { watchDistricts: ["3-43"] }, listingInMemberScope), true);
});

test("index, server and admin expose self listing surfaces", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const admin = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  assert.match(html, /id="selfListingForm"/);
  assert.match(html, /id="selfListingPanel"/);
  assert.match(html, /\/api\/self-listings/);
  assert.match(html, /站內刊登/);
  assert.match(html, /id="selfPhotos"/);
  assert.match(html, /\/api\/self-listings\/photos/);
  assert.match(html, /item\.source === "self"/);
  assert.match(html, /id="selfListingOverlay"/);
  assert.match(server, /app\.post\("\/api\/self-listings"/);
  assert.match(server, /app\.post\("\/api\/self-listings\/photos"/);
  assert.match(server, /app\.get\("\/media\/self\/:file"/);
  assert.match(server, /listingRedirectTarget/);
  assert.match(admin, /站內自行刊登/);
  assert.match(admin, /列表「較適合」依會員租金、樓層與通勤估算/);
});
