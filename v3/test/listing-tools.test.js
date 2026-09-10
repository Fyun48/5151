import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "os";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "listing-tools-"));

import { ensureContentDocumentSchema, seedDefaultDocuments } from "../src/contentDocuments.js";
import { defaultLegalCopy } from "../src/legalCopy.js";
import { ensureMemberConsentSchema } from "../src/memberConsents.js";
import { countActiveMedia, ensureMemberMediaSchema, saveMemberMedia } from "../src/memberMedia.js";
import { ensureListingImportSchema } from "../src/listingImport.js";
import {
  createImportedDraftListing,
  createSelfListing,
  updateImportedDraftListing,
  ensureSelfListingSchema,
  getSelfListing,
  publicListingView,
} from "../src/selfListings.js";
import {
  CONTACT_PROFILE_LIMIT,
  COPYABLE_FIELDS,
  DESCRIPTION_TEMPLATE_LIMIT,
  DESCRIPTION_TEMPLATE_LIMIT_SPONSOR,
  descriptionTemplateLimit,
  copyOwnListing,
  createContactProfile,
  createDescriptionTemplate,
  deleteContactProfile,
  deleteDescriptionTemplate,
  ensureAccountContactProfile,
  ensureListingToolsSchema,
  getOwnedContactProfile,
  getOwnedDescriptionTemplate,
  listContactProfiles,
  listDescriptionTemplates,
  listingToolsMeta,
  updateContactProfile,
  updateDescriptionTemplate,
} from "../src/listingTools.js";
import { publishOwnedDraftListing } from "../src/selfListings.js";

const OLD = "2026-01-01T00:00:00.000Z";
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd8]), Buffer.alloc(32, 7)]);
const fakeProcessor = async (buf) => ({
  format: "jpg",
  mime: "image/jpeg",
  digest: "d" + (buf?.length || 0),
  main: { buffer: Buffer.from("main-bytes"), width: 800, height: 600, bytes: 10 },
  thumb: { buffer: Buffer.from("thumb"), bytes: 5 },
});

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      nickname TEXT,
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
      listed_by_user_id INTEGER,
      self_status TEXT,
      self_expires_at TEXT,
      self_body TEXT,
      self_photos TEXT,
      self_traits TEXT,
      self_pledge_at TEXT,
      self_deposit TEXT,
      contact_name TEXT,
      contact_role TEXT,
      mobile TEXT,
      phone TEXT,
      line_url TEXT,
      contact_fetched INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureSelfListingSchema(db);
  ensureMemberMediaSchema(db);
  ensureContentDocumentSchema(db);
  ensureMemberConsentSchema(db);
  ensureListingImportSchema(db);
  ensureListingToolsSchema(db);
  seedDefaultDocuments(db, { legalCopy: defaultLegalCopy(), now: new Date(OLD) });
  return db;
}

function addUser(db, { id, email, plan = "free", createdAt = OLD, nickname = "暱稱" }) {
  db.prepare("INSERT INTO users(id, email, plan, created_at, nickname) VALUES (?,?,?,?,?)").run(id, email, plan, createdAt, nickname);
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
    street: "中正路 100 號",
    phone: "0912345678",
    line_url: "https://line.me/ti/p/abc",
    title: "士林整層可看屋",
    body: "近捷運、可入住、有洗衣機。",
    traits: ["washer", "net"],
    deposit: "one",
    accept_pledge: true,
    ...extra,
  };
}

test("centralized listing tool limits", () => {
  const meta = listingToolsMeta();
  assert.equal(meta.description_template_limit, 2);
  assert.equal(meta.description_template_limit_sponsor, 5);
  assert.equal(meta.contact_profile_limit, 2);
  assert.equal(DESCRIPTION_TEMPLATE_LIMIT, 2);
  assert.equal(descriptionTemplateLimit({ plan: "sponsor" }), DESCRIPTION_TEMPLATE_LIMIT_SPONSOR);
  assert.equal(descriptionTemplateLimit({ role: "admin" }), 5);
  assert.equal(CONTACT_PROFILE_LIMIT, 2);
  assert.ok(COPYABLE_FIELDS.includes("title"));
  assert.ok(!COPYABLE_FIELDS.includes("self_pledge_at"));
  assert.ok(!COPYABLE_FIELDS.includes("viewed"));
});

test("member can copy own listing into a new unpublished draft", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const original = createSelfListing(db, 1, sampleInput());
  db.prepare("UPDATE listings SET viewed=9, watched=4 WHERE post_id=?").run(original.post_id);
  const raw = db.prepare("SELECT * FROM listings WHERE post_id=?").get(original.post_id);
  assert.ok(raw.self_pledge_at);

  const copied = copyOwnListing(db, 1, original.post_id);
  assert.notEqual(copied.listing.post_id, original.post_id);
  assert.equal(copied.listing.status, "draft");
  assert.equal(copied.unpublished, true);
  assert.equal(copied.listing.title, original.title);
  assert.equal(copied.listing.body, original.body);
  assert.equal(copied.listing.price_num, 25000);
  assert.match(copied.listing.address, /士林區/);
  assert.deepEqual(copied.listing.traits, ["washer", "net"]);
  assert.equal(copied.listing.contact_name, "林先生");
  assert.equal(copied.listing.pledged, false);
  assert.equal(copied.inherited_import, false);
  assert.equal(copied.form.district, "1-8");
  assert.match(copied.form.street, /中正路/);

  const after = db.prepare("SELECT * FROM listings WHERE post_id=?").get(original.post_id);
  assert.equal(after.viewed, 9);
  assert.equal(after.watched, 4);
  assert.equal(after.self_status, "open");
  assert.equal(after.self_pledge_at, raw.self_pledge_at);
  assert.equal(after.title, original.title);

  const draftRaw = db.prepare("SELECT * FROM listings WHERE post_id=?").get(copied.listing.post_id);
  assert.equal(draftRaw.viewed, 0);
  assert.equal(draftRaw.watched, 0);
  assert.equal(draftRaw.self_pledge_at, null);
  assert.match(String(draftRaw.source_id), /^copy:1:/);
  assert.equal(publicListingView(copied.listing).contact_name, "林先生");
  db.close();
});

test("member cannot copy another member's listing", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  addUser(db, { id: 2, email: "b@example.com" });
  const original = createSelfListing(db, 1, sampleInput());
  assert.throws(() => copyOwnListing(db, 2, original.post_id), (e) => e.status === 403 && e.code === "not_owner");
  db.close();
});

test("copy does not clone import provenance or old import confirmation", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const imported = createImportedDraftListing(db, 1, {
    title: "匯入套房",
    body: "匯入說明近捷運。",
    photos: [],
  });
  db.prepare(`
    INSERT INTO listing_import(user_id, provider, original_source_url, normalized_source_url, source_listing_id,
      status, listing_id, terms_document_id, declaration_version, declaration_content_hash, created_at, confirmed_at)
    VALUES (1,'591','https://rent.591.com.tw/1','https://rent.591.com.tw/1','1','confirmed',?,?,1,'hash',?,?)
  `).run(imported.post_id, 9, OLD, OLD);
  const copied = copyOwnListing(db, 1, imported.post_id);
  const imports = db.prepare("SELECT * FROM listing_import").all();
  assert.equal(imports.length, 1);
  assert.equal(imports[0].listing_id, imported.post_id);
  assert.notEqual(copied.listing.post_id, imported.post_id);
  assert.equal(copied.inherited_import, false);
  assert.match(db.prepare("SELECT source_id FROM listings WHERE post_id=?").get(copied.listing.post_id).source_id, /^copy:/);
  db.close();
});

test("imported draft body is sanitized on update and display", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const imported = createImportedDraftListing(db, 1, {
    title: "匯入套房",
    body: "匯入說明近捷運採光佳。",
    photos: [],
  });
  const dirty = updateImportedDraftListing(db, 1, imported.post_id, {
    body: '<b>乾淨</b><script>alert(1)</script><a href="https://evil.test">連</a>近捷運採光',
  });
  assert.match(dirty.body, /<b>乾淨<\/b>/);
  assert.doesNotMatch(dirty.body, /script|href|evil/i);
  const pub = publicListingView(dirty);
  assert.doesNotMatch(pub.body || "", /script|href|evil/i);
  db.close();
});

test("owned media references are reused without consuming quota; foreign media is dropped", async () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  addUser(db, { id: 2, email: "b@example.com" });
  const mine = await saveMemberMedia(db, 1, jpeg(), { plan: "free", processor: fakeProcessor, originalName: "a.jpg" });
  const theirs = await saveMemberMedia(db, 2, jpeg(), { plan: "free", processor: fakeProcessor, originalName: "b.jpg" });
  const original = createSelfListing(db, 1, sampleInput({ photos: [mine.url] }));
  db.prepare("UPDATE listings SET self_photos=? WHERE post_id=?").run(JSON.stringify([mine.url, theirs.url]), original.post_id);
  const usedBefore = countActiveMedia(db, 1);
  const copied = copyOwnListing(db, 1, original.post_id);
  assert.deepEqual(copied.listing.photos, [mine.url]);
  assert.equal(countActiveMedia(db, 1), usedBefore);
  assert.equal(copied.listing.photos.includes(theirs.url), false);
  db.close();
});

test("double copy with the same idempotency key reuses one draft", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const original = createSelfListing(db, 1, sampleInput());
  const a = copyOwnListing(db, 1, original.post_id, { idempotency_key: "click-1" });
  const b = copyOwnListing(db, 1, original.post_id, { idempotency_key: "click-1" });
  assert.equal(a.listing.post_id, b.listing.post_id);
  assert.equal(b.reused, true);
  const drafts = db.prepare("SELECT COUNT(*) n FROM listings WHERE listed_by_user_id=1 AND self_status='draft'").get();
  assert.equal(drafts.n, 1);
  db.close();
});

test("copied draft publishes through normal pledge flow without changing the original", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const original = createSelfListing(db, 1, sampleInput({ title: "原來的刊登標題" }));
  const copied = copyOwnListing(db, 1, original.post_id);
  const published = publishOwnedDraftListing(db, 1, copied.listing.post_id, {
    ...sampleInput({ title: "複製後刊登草稿", phone: "0987654321" }),
  });
  assert.equal(published.status, "open");
  assert.equal(published.title, "複製後刊登草稿");
  assert.equal(published.phone, "0987654321");
  assert.equal(getSelfListing(db, original.post_id, { viewerId: 1 }).title, "原來的刊登標題");
  assert.equal(getSelfListing(db, original.post_id, { viewerId: 1 }).phone, "0912345678");
  db.close();
});

test("description templates: free limit 2, sponsor 5, ownership, sanitization, concurrent create", async () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  addUser(db, { id: 2, email: "b@example.com" });
  const one = createDescriptionTemplate(db, 1, { name: "家庭", body: "採光佳，近市場。" });
  const overwritten = createDescriptionTemplate(db, 1, { name: "家庭", body: "覆蓋後的家庭說明內容。" });
  assert.equal(overwritten.id, one.id);
  assert.match(overwritten.body, /覆蓋後的家庭說明內容/);
  assert.equal(listDescriptionTemplates(db, 1).length, 1);
  createDescriptionTemplate(db, 1, { name: "套房", body: "獨立衛浴。" });
  assert.throws(() => createDescriptionTemplate(db, 1, { name: "雅房", body: "公共衛浴。" }), (e) => e.status === 409);
  const sponsorDb = open();
  addUser(sponsorDb, { id: 3, email: "s@example.com", plan: "sponsor" });
  for (let i = 1; i <= 5; i += 1) {
    createDescriptionTemplate(sponsorDb, 3, { name: `範本${i}`, body: `說明內容${i}一二三` }, new Date(), { plan: "sponsor" });
  }
  assert.throws(
    () => createDescriptionTemplate(sponsorDb, 3, { name: "第六", body: "不行一二三" }, new Date(), { plan: "sponsor" }),
    (e) => e.status === 409,
  );
  sponsorDb.close();
  const dirty = updateDescriptionTemplate(db, 1, one.id, { body: '<script>alert(1)</script>乾淨說明' });
  assert.doesNotMatch(dirty.body, /<script>/);
  assert.match(dirty.body, /乾淨說明/);
  assert.throws(() => getOwnedDescriptionTemplate(db, 2, one.id), (e) => e.status === 403);
  assert.throws(() => updateDescriptionTemplate(db, 2, one.id, { name: "偷" }), (e) => e.status === 403);
  deleteDescriptionTemplate(db, 1, one.id);
  assert.equal(listDescriptionTemplates(db, 1).length, 1);

  const db2 = open();
  addUser(db2, { id: 1, email: "a@example.com" });
  const results = await Promise.allSettled([
    Promise.resolve().then(() => createDescriptionTemplate(db2, 1, { name: "A", body: "aaaaaaa1" })),
    Promise.resolve().then(() => createDescriptionTemplate(db2, 1, { name: "B", body: "bbbbbbb2" })),
    Promise.resolve().then(() => createDescriptionTemplate(db2, 1, { name: "C", body: "ccccccc3" })),
    Promise.resolve().then(() => createDescriptionTemplate(db2, 1, { name: "D", body: "ddddddd4" })),
  ]);
  const ok = results.filter((row) => row.status === "fulfilled");
  const rejected = results.filter((row) => row.status === "rejected");
  assert.equal(ok.length, 2);
  assert.equal(rejected.length, 2);
  assert.equal(listDescriptionTemplates(db2, 1).length, 2);
  db.close();
  db2.close();
});

test("schema dedupes leftover account contacts then creates the unique index", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", nickname: "吉比" });
  db.exec("DROP INDEX IF EXISTS idx_listing_contact_one_account");
  const stamp = OLD;
  db.prepare(
    `INSERT INTO listing_contact_profile(user_id, label, contact_name, phone, line_url, is_account, created_at, updated_at)
     VALUES (1,'舊一','甲','0911111111','',1,?,?)`,
  ).run(stamp, stamp);
  db.prepare(
    `INSERT INTO listing_contact_profile(user_id, label, contact_name, phone, line_url, is_account, created_at, updated_at)
     VALUES (1,'舊二','乙','0922222222','',1,?,?)`,
  ).run(stamp, stamp);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listing_contact_profile WHERE user_id=1 AND is_account=1").get().n, 2);
  ensureListingToolsSchema(db);
  const left = db.prepare("SELECT * FROM listing_contact_profile WHERE user_id=1 AND is_account=1 ORDER BY id").all();
  assert.equal(left.length, 1);
  assert.equal(left[0].label, "舊一");
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_listing_contact_one_account'").get();
  assert.equal(idx?.name, "idx_listing_contact_one_account");
  const keepId = left[0].id;
  ensureListingToolsSchema(db);
  assert.equal(db.prepare("SELECT id FROM listing_contact_profile WHERE user_id=1 AND is_account=1").get().id, keepId);
  assert.throws(() => {
    db.prepare(
      `INSERT INTO listing_contact_profile(user_id, label, contact_name, phone, line_url, is_account, created_at, updated_at)
       VALUES (1,'再插','丙','0933333333','',1,?,?)`,
    ).run(stamp, stamp);
  });
  db.close();
});

test("account contact stays unique under concurrent ensure", async () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", nickname: "吉比" });
  const results = await Promise.all([
    Promise.resolve().then(() => ensureAccountContactProfile(db, 1)),
    Promise.resolve().then(() => ensureAccountContactProfile(db, 1)),
    Promise.resolve().then(() => listContactProfiles(db, 1)),
  ]);
  const accounts = listContactProfiles(db, 1).filter((row) => row.is_account);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].label, "吉比");
  assert.doesNotMatch(accounts[0].label, /不可刪/);
  assert.equal(results.filter(Boolean).length, 3);
  const noNick = open();
  addUser(noNick, { id: 2, email: "nonick@example.com", nickname: "" });
  const fallback = listContactProfiles(noNick, 2).find((row) => row.is_account);
  assert.equal(fallback.label, "此帳號");
  noNick.close();
  db.close();
});

test("contact profiles: limit 2, private, snapshot on listing, delete does not mutate listing", async () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  addUser(db, { id: 2, email: "b@example.com" });
  const a = createContactProfile(db, 1, { label: "本人", contact_name: "林先生", phone: "0911111111", line_url: "https://line.me/ti/p/x" });
  createContactProfile(db, 1, { label: "代理人", contact_name: "陳小姐", phone: "0922222222" });
  assert.throws(() => createContactProfile(db, 1, { label: "第三", contact_name: "x", phone: "0933333333" }), (e) => e.status === 409);
  assert.throws(() => getOwnedContactProfile(db, 2, a.id), (e) => e.status === 403);

  const listing = createSelfListing(db, 1, sampleInput({
    contact_name: a.contact_name,
    phone: a.phone,
    line_url: a.line_url,
  }));
  updateContactProfile(db, 1, a.id, { contact_name: "改過的名字", phone: "0988888888" });
  deleteContactProfile(db, 1, a.id);
  const still = getSelfListing(db, listing.post_id, { viewerId: 1 });
  assert.equal(still.contact_name, "林先生");
  assert.equal(still.phone, "0911111111");
  const pub = publicListingView(still);
  assert.equal(pub.contact_name, "林先生");
  assert.equal(Object.hasOwn(pub, "contact_profile_id"), false);
  const left = listContactProfiles(db, 1);
  assert.equal(left.filter((row) => !row.is_account).length, 1);
  assert.equal(left.some((row) => row.is_account && row.locked), true);
  assert.throws(() => deleteContactProfile(db, 1, left.find((row) => row.is_account).id), (e) => e.code === "account_contact_locked");

  const db2 = open();
  addUser(db2, { id: 1, email: "a@example.com" });
  const raced = await Promise.allSettled([
    Promise.resolve().then(() => createContactProfile(db2, 1, { label: "A", contact_name: "甲", phone: "0911111111" })),
    Promise.resolve().then(() => createContactProfile(db2, 1, { label: "B", contact_name: "乙", phone: "0922222222" })),
    Promise.resolve().then(() => createContactProfile(db2, 1, { label: "C", contact_name: "丙", phone: "0933333333" })),
  ]);
  assert.equal(raced.filter((row) => row.status === "fulfilled").length, 2);
  assert.equal(listContactProfiles(db2, 1).filter((row) => !row.is_account).length, 2);
  db.close();
  db2.close();
});
