import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import {
  closeDemandPost,
  createDemandPost,
  DEMAND_MAX_OPEN,
  demandMeta,
  deleteWishExample,
  ensureDemandSchema,
  getDemandPost,
  getWishExample,
  listingCompatibilityForWish,
  listDemandPosts,
  publicWishRoomView,
  publishWishRoom,
  reopenWishRoom,
  saveWishExample,
  updateWishRoom,
  WISH_CONDITIONS,
  WISH_FORBIDDEN_CONDITION_IDS,
  WISH_PRODUCT_NAME,
  wishRoomOwnerSummary,
} from "../src/demand.js";
import { ensureListingToolsSchema, createContactProfile } from "../src/listingTools.js";
import { DOC_TYPES, ensureContentDocumentSchema, getEffectiveDocument, seedDefaultDocuments } from "../src/contentDocuments.js";
import { defaultLegalCopy } from "../src/legalCopy.js";

const OLD = "2026-01-01T00:00:00.000Z";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureDemandSchema(db);
  ensureListingToolsSchema(db);
  return db;
}

function addUser(db, { id, email, createdAt = OLD, nickname = "" }) {
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (?, ?, ?, ?)").run(id, email, nickname, createdAt);
}

function sample(extra = {}) {
  return {
    districts: ["1-8"],
    city: "台北市",
    rent_min: 18000,
    rent_max: 28000,
    includes_management: true,
    housing_type: "whole",
    ping_min: 12,
    layout: "2",
    move_in_date: "2026-10-01",
    lease_duration: "year",
    transit_note: "劍潭站",
    destination_note: "天母辦公室",
    commute_minutes: 25,
    must_have: ["need_cook", "elevator"],
    nice_to_have: ["parcel"],
    avoid: ["parking_car"],
    body: "希望士林可開伙兩房，不要車位費用。",
    contact_name: "小陳",
    phone: "0912345678",
    ...extra,
  };
}

test("user-facing product name is 許願房 and CMS type is wish_room_rules", () => {
  assert.equal(WISH_PRODUCT_NAME, "許願房");
  assert.equal(demandMeta().product, "許願房");
  assert.equal(demandMeta().rules_type, "wish_room_rules");
  assert.equal(DOC_TYPES.wish_room_rules.id, "wish_room_rules");
  assert.match(DOC_TYPES.wish_room_rules.label, /許願房規則/);
  assert.doesNotMatch(DOC_TYPES.wish_room_rules.label, /尚未開通/);
  const db = new DatabaseSync(":memory:");
  ensureContentDocumentSchema(db);
  seedDefaultDocuments(db, { legalCopy: defaultLegalCopy(), now: new Date("2026-09-08T00:00:00.000Z") });
  assert.equal(getEffectiveDocument(db, "wish_room_rules")?.document_type, "wish_room_rules");
  db.close();
});

test("legacy two-open demands collapse to one active Wish Room without deleting", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, created_at TEXT);
    CREATE TABLE demand_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      districts TEXT NOT NULL DEFAULT '[]',
      rent_max INTEGER NOT NULL DEFAULT 0,
      housing_type TEXT NOT NULL DEFAULT 'any',
      mrt_walk INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      closed_at TEXT
    );
  `);
  db.prepare("INSERT INTO users(id, email, created_at) VALUES (1, 'a@example.com', ?)").run(OLD);
  db.prepare(`INSERT INTO demand_posts(user_id, districts, rent_max, body, status, created_at, expires_at)
    VALUES (1, '["1-8"]', 20000, '舊需求一', 'open', ?, '9999-12-31T00:00:00.000Z')`).run(OLD);
  db.prepare(`INSERT INTO demand_posts(user_id, districts, rent_max, body, status, created_at, expires_at)
    VALUES (1, '["1-9"]', 22000, '舊需求二', 'open', ?, '9999-12-31T00:00:00.000Z')`).run(OLD);
  ensureDemandSchema(db);
  const rows = db.prepare("SELECT id, status, body FROM demand_posts ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "closed");
  assert.equal(rows[1].status, "open");
  assert.equal(rows[0].body, "舊需求一");
  const listed = listDemandPosts(db);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, rows[1].id);
  const historical = getDemandPost(db, rows[0].id, { viewerId: 1 });
  assert.equal(historical.status, "closed");
  assert.equal(historical.body, "舊需求一");
  db.close();
});

test("member can create one active Wish Room and persist core fields", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const post = createDemandPost(db, 1, sample());
  assert.equal(post.status, "open");
  assert.equal(post.city, "台北市");
  assert.deepEqual(post.districts, ["1-8"]);
  assert.equal(post.rent_min, 18000);
  assert.equal(post.rent_max, 28000);
  assert.equal(post.includes_management, true);
  assert.equal(post.housing_type, "whole");
  assert.equal(post.ping_min, 12);
  assert.equal(post.layout, "2");
  assert.equal(post.move_in_date, "2026-10-01");
  assert.equal(post.lease_duration, "year");
  assert.deepEqual(post.must_have, ["need_cook", "elevator"]);
  assert.deepEqual(post.nice_to_have, ["parcel"]);
  assert.deepEqual(post.avoid, ["parking_car"]);
  assert.equal(post.contact.phone, "0912345678");
  assert.equal(DEMAND_MAX_OPEN, 1);
  db.close();
});

test("same member cannot create a second active Wish Room; another member can", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  addUser(db, { id: 2, email: "b@example.com" });
  createDemandPost(db, 1, sample({ body: "甲的許願房內容夠長" }));
  assert.throws(() => createDemandPost(db, 1, sample({ districts: ["1-9"], body: "甲想再登一則" })), (e) => e.status === 409);
  const other = createDemandPost(db, 2, sample({ districts: ["1-5"], body: "乙也可以有自己的一則" }));
  assert.equal(other.status, "open");
  assert.equal(listDemandPosts(db).length, 2);
  db.close();
});

test("concurrent activation cannot create two active Wish Rooms", async () => {
  const file = path.join(os.tmpdir(), `wish-room-${process.pid}-${Date.now()}.db`);
  const seed = new DatabaseSync(file);
  seed.exec("PRAGMA journal_mode=WAL");
  seed.exec("PRAGMA busy_timeout=5000");
  seed.exec("PRAGMA foreign_keys = ON");
  seed.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, created_at TEXT);`);
  seed.prepare("INSERT INTO users(id, email, created_at) VALUES (1, 'a@example.com', ?)").run(OLD);
  ensureDemandSchema(seed);
  seed.close();

  const a = new DatabaseSync(file);
  const b = new DatabaseSync(file);
  a.exec("PRAGMA busy_timeout=5000");
  b.exec("PRAGMA busy_timeout=5000");
  const results = await Promise.allSettled([
    Promise.resolve().then(() => createDemandPost(a, 1, sample({ body: "併發甲要公開第一則" }))),
    Promise.resolve().then(() => createDemandPost(b, 1, sample({ body: "併發甲要公開第二則" }))),
  ]);
  const ok = results.filter((row) => row.status === "fulfilled");
  const rejected = results.filter((row) => row.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(rejected.length, 1);
  const check = new DatabaseSync(file);
  assert.equal(check.prepare("SELECT COUNT(*) n FROM demand_posts WHERE status='open' AND user_id=1").get().n, 1);
  a.close();
  b.close();
  check.close();
});

test("owner can edit active Wish Room in place; others cannot", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  addUser(db, { id: 2, email: "b@example.com" });
  const post = createDemandPost(db, 1, sample());
  const edited = updateWishRoom(db, 1, post.id, { rent_max: 30000, body: "改過預算與說明文字" });
  assert.equal(edited.id, post.id);
  assert.equal(edited.rent_max, 30000);
  assert.equal(edited.status, "open");
  assert.equal(listDemandPosts(db).length, 1);
  assert.throws(() => updateWishRoom(db, 2, post.id, { body: "偷改別人的許願房" }), (e) => e.status === 403);
  db.close();
});

test("close hides from public list and reopen works only without another active", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const post = createDemandPost(db, 1, sample());
  closeDemandPost(db, 1, post.id);
  assert.equal(listDemandPosts(db).length, 0);
  assert.throws(() => getDemandPost(db, post.id, { viewerId: 0 }), /找不到/);
  const mine = getDemandPost(db, post.id, { viewerId: 1 });
  assert.equal(mine.status, "closed");
  const reopened = reopenWishRoom(db, 1, post.id);
  assert.equal(reopened.status, "open");
  assert.equal(listDemandPosts(db).length, 1);
  const draft = createDemandPost(db, 1, { ...sample({ body: "這是草稿不會公開" }), draft: true });
  assert.equal(draft.status, "draft");
  assert.throws(() => publishWishRoom(db, 1, draft.id), /一則公開/);
  closeDemandPost(db, 1, reopened.id);
  const publishedDraft = publishWishRoom(db, 1, draft.id);
  assert.equal(publishedDraft.status, "open");
  db.close();
});

test("saved example is private, unique, replaceable, and does not publish", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  addUser(db, { id: 2, email: "b@example.com" });
  const saved = saveWishExample(db, 1, sample({ body: "範例說明不要公開" }));
  assert.match(saved.body, /範例說明/);
  assert.equal(listDemandPosts(db).length, 0);
  assert.equal(wishRoomOwnerSummary(db, 1).has_example, true);
  const again = saveWishExample(db, 1, sample({ body: "覆蓋後的範例說明", rent_max: 24000 }));
  assert.equal(again.rent_max, 24000);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM wish_room_example WHERE user_id=1").get().n, 1);
  assert.equal(getWishExample(db, 2), null);
  deleteWishExample(db, 1);
  assert.equal(getWishExample(db, 1), null);
  db.close();
});

test("budget validates min <= max and public payload stays private", () => {
  const db = open();
  addUser(db, { id: 1, email: "owner@example.com", nickname: "阿花" });
  assert.throws(() => createDemandPost(db, 1, sample({ rent_min: 40000, rent_max: 20000 })), /最低預算/);
  const post = createDemandPost(db, 1, sample({ body: "<script>alert(1)</script>士林兩房可開伙" }));
  assert.doesNotMatch(post.body, /<script>/);
  assert.match(post.body, /士林兩房/);
  const pub = listDemandPosts(db)[0];
  assert.equal(pub.author, "阿花");
  assert.equal("user_id" in pub, false);
  assert.equal("email" in pub, false);
  assert.equal("contact_profile_id" in pub, false);
  assert.doesNotMatch(JSON.stringify(pub), /owner@example.com/);
  const view = publicWishRoomView(getDemandPost(db, post.id, { viewerId: 1 }));
  assert.equal("user_id" in view, false);
  db.close();
});

test("#190 negative listing traits do not invert Wish Room renter intent", () => {
  const compat = listingCompatibilityForWish(["need_cook", "need_pet", "need_tax"]);
  assert.deepEqual(compat.listing_incompatible.sort(), ["nocook", "nopet", "notax"].sort());
  assert.ok(!compat.listing_compatible.includes("nocook"));
  assert.ok(!compat.listing_compatible.includes("nopet"));
  assert.ok(compat.listing_compatible.includes("cook"));
  assert.ok(WISH_CONDITIONS.every((row) => !["nocook", "nopet", "notax"].includes(row.id)));
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const post = createDemandPost(db, 1, sample({
    must_have: ["need_cook", "nocook", "female", "適合對象"],
    body: "只要可開伙不要反轉",
  }));
  assert.deepEqual(post.must_have, ["need_cook"]);
  assert.ok(!post.must_have.includes("nocook"));
  db.close();
});

test("no discriminatory structured fields or 適合對象", () => {
  const ids = WISH_CONDITIONS.map((row) => row.id);
  for (const bad of WISH_FORBIDDEN_CONDITION_IDS) assert.ok(!ids.includes(bad));
  assert.ok(!demandMeta().conditions.some((row) => /適合對象|限女|限男|國籍/.test(row.label)));
  assert.ok(demandMeta().forbidden_fields.includes("適合對象"));
});

test("contact snapshot publishes; later profile edit does not mutate Wish Room", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const profile = createContactProfile(db, 1, {
    label: "本人",
    contact_name: "林先生",
    phone: "0911111111",
    line_url: "https://line.me/ti/p/abc",
  });
  const post = createDemandPost(db, 1, sample({
    contact_name: "",
    phone: "",
    line_url: "",
    contact_profile_id: profile.id,
    body: "用快選聯絡人刊登",
  }));
  assert.equal(post.contact.contact_name, "林先生");
  assert.equal(post.contact.phone, "0911111111");
  const pub = listDemandPosts(db)[0];
  assert.equal(pub.contact.phone, "0911111111");
  assert.equal("contact_profile_id" in pub, false);
  db.prepare("UPDATE listing_contact_profile SET phone='0988888888' WHERE id=?").run(profile.id);
  const still = getDemandPost(db, post.id, { viewerId: 1 });
  assert.equal(still.contact.phone, "0911111111");
  db.close();
});

test("public list is active-only and deterministic by recency then id", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  addUser(db, { id: 2, email: "b@example.com" });
  const older = createDemandPost(db, 1, sample({ body: "較早公開的許願房" }), new Date("2026-09-01T00:00:00.000Z"));
  const newer = createDemandPost(db, 2, sample({ districts: ["1-9"], body: "較晚公開的許願房" }), new Date("2026-09-02T00:00:00.000Z"));
  closeDemandPost(db, 1, older.id);
  const listed = listDemandPosts(db);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, newer.id);
  createDemandPost(db, 1, sample({ body: "甲重開後的新許願房" }), new Date("2026-09-03T00:00:00.000Z"));
  const again = listDemandPosts(db);
  assert.equal(again.length, 2);
  assert.ok(again[0].updated_at >= again[1].updated_at);
  assert.deepEqual(again.map((row) => row.id), [...again].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return b.updated_at.localeCompare(a.updated_at);
    return b.id - a.id;
  }).map((row) => row.id));
  const filtered = listDemandPosts(db, { city: "台北市", housing_type: "whole", rent_min: 20000, rent_max: 30000 });
  assert.ok(filtered.length >= 1);
  db.close();
});
