import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "import-data-"));

import { ensureContentDocumentSchema, getEffectiveDocument, seedDefaultDocuments, createDraft, publishDocument } from "../src/contentDocuments.js";
import { defaultLegalCopy } from "../src/legalCopy.js";
import { ensureMemberConsentSchema, listMemberConsents } from "../src/memberConsents.js";
import { countActiveMedia, ensureMemberMediaSchema } from "../src/memberMedia.js";
import { ensureSelfListingSchema, getSelfListing, publicListingView } from "../src/selfListings.js";
import {
  assertSponsorMember,
  cancelListingImport,
  confirmListingImport,
  ensureListingImportSchema,
  findActiveImportBySource,
  importMeta,
  isSponsorPlan,
  listAdminListingImports,
  publishConfirmedImport,
  reviewListingImport,
  startListingImport,
} from "../src/listingImport.js";
import { canHandleImportUrl, normalizeImportUrl } from "../src/importProviders.js";
import { parse591Listing } from "../src/import591.js";
import { parse5168Listing } from "../src/import5168.js";
import { sanitizeImportedText, sanitizeImportedTitle } from "../src/importSanitize.js";
import {
  FETCH_LIMITS,
  IMPORT_USER_AGENT,
  isBlockedHostname,
  isIpLiteral,
  isPrivateOrBlockedIPv4,
  parseHttpsUrl,
  safeFetchText,
  _setSafeFetchForTests,
} from "../src/safeFetch.js";
import { assertImportAllowed, resetAuthRateLimits } from "../src/rateLimit.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const readFix = (name) => readFileSync(path.join(dir, "fixtures", name), "utf8");
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
  seedDefaultDocuments(db, { legalCopy: defaultLegalCopy(), now: new Date("2026-01-01T00:00:00.000Z") });
  return db;
}

function addUser(db, { id, email, plan = "free", createdAt = "2026-01-01T00:00:00.000Z" }) {
  db.prepare("INSERT INTO users(id, email, plan, created_at) VALUES (?,?,?,?)").run(id, email, plan, createdAt);
}

function mockFetch(pages, images = {}) {
  return async (url, init) => {
    assert.equal(init.redirect, "manual");
    assert.match(init.headers["User-Agent"], /JibbyRentImport\/1\.0/);
    assert.doesNotMatch(init.headers["User-Agent"], /Googlebot|Mozilla\/5\.0 \(Windows NT 10\.0/);
    const href = String(url);
    if (pages[href]?.redirect) {
      return { status: 302, headers: { get: (k) => k.toLowerCase() === "location" ? pages[href].redirect : null }, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (pages[href]) {
      const body = Buffer.from(pages[href].text || "", "utf8");
      return { status: pages[href].status || 200, headers: { get: () => null }, arrayBuffer: async () => body };
    }
    if (images[href]) {
      return { status: 200, headers: { get: () => null }, arrayBuffer: async () => images[href] };
    }
    return { status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.from("not found") };
  };
}

function publicLookup() {
  return async () => [{ address: "203.0.113.10", family: 4 }];
}

async function start591(db, userId, extra = {}) {
  const html = extra.html || readFix("import-591-public.html");
  const url = extra.url || "https://rent.591.com.tw/15801234";
  return startListingImport(db, userId, { url }, {
    plan: extra.plan || "sponsor",
    processor: fakeProcessor,
    lookupImpl: publicLookup(),
    fetchImpl: mockFetch({
      [url]: { text: html, status: extra.status || 200 },
      "https://www.591.com.tw/home/housing/detail?id=15801234": { text: html, status: extra.status || 200 },
    }, {
      "https://img1.591.com.tw/house/demo-a.jpg": jpeg(),
      "https://img2.591.com.tw/house/demo-b.jpg": extra.badImage ? Buffer.from("not-an-image") : jpeg(),
    }),
  });
}

test("sponsor helper and URL allowlist", () => {
  assert.equal(isSponsorPlan("sponsor"), true);
  assert.equal(isSponsorPlan("free"), false);
  assert.throws(() => assertSponsorMember("free"), (e) => e.status === 403 && e.code === "sponsor_required");
  assert.equal(canHandleImportUrl("https://rent.591.com.tw/15801234"), true);
  assert.equal(canHandleImportUrl("https://rent.houseprice.tw/house/16705651"), true);
  assert.equal(canHandleImportUrl("https://example.com/x"), false);
  assert.equal(canHandleImportUrl("https://bff-house.591.com.tw/v2/web/rent/detail?id=1"), false);
  assert.deepEqual(normalizeImportUrl("https://rent.591.com.tw/15801234"), {
    provider: "591",
    original: "https://rent.591.com.tw/15801234",
    normalized: "https://rent.591.com.tw/15801234",
    source_listing_id: "15801234",
    pageHosts: ["rent.591.com.tw", "www.591.com.tw"],
    imageHosts: ["img1.591.com.tw", "img2.591.com.tw", "hp1.591.com.tw", "hp2.591.com.tw"],
  });
  assert.equal(normalizeImportUrl("https://rent.houseprice.tw/house/1447592_285879").provider, "5168");
  assert.throws(() => normalizeImportUrl("https://sale.591.com.tw/1"), /支援/);
  assert.throws(() => normalizeImportUrl("http://rent.591.com.tw/15801234"), /HTTPS/);
});

test("SSRF rejects localhost, private, metadata, raw IP, and bad schemes", async () => {
  const banned = [
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://10.1.2.3/x",
    "https://172.16.4.4/x",
    "https://192.168.1.9/x",
    "https://169.254.1.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal/",
    "file:///etc/passwd",
    "ftp://rent.591.com.tw/1",
    "data:text/html,hi",
    "javascript:alert(1)",
    "https://example.com/x",
  ];
  for (const url of banned) {
    assert.equal(canHandleImportUrl(url), false);
    assert.throws(() => normalizeImportUrl(url));
  }
  assert.equal(isIpLiteral("127.0.0.1"), true);
  assert.equal(isIpLiteral("::1"), true);
  assert.equal(isBlockedHostname("localhost"), true);
  assert.equal(isPrivateOrBlockedIPv4("10.0.0.1"), true);
  assert.equal(isPrivateOrBlockedIPv4("172.31.1.1"), true);
  assert.equal(isPrivateOrBlockedIPv4("192.168.0.1"), true);
  assert.equal(isPrivateOrBlockedIPv4("169.254.12.3"), true);
  assert.equal(isPrivateOrBlockedIPv4("203.0.113.10"), false);
  await assert.rejects(
    () => safeFetchText("https://rent.591.com.tw/1", {
      allowedHosts: ["rent.591.com.tw"],
      lookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchImpl: async () => { throw new Error("should not fetch"); },
    }),
    /內部位址/,
  );
  await assert.rejects(
    () => safeFetchText("https://rent.591.com.tw/1", {
      allowedHosts: ["rent.591.com.tw"],
      lookupImpl: publicLookup(),
      fetchImpl: async () => ({
        status: 302,
        headers: { get: () => "https://127.0.0.1/secret" },
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    }),
    /內部或 IP/,
  );
  assert.throws(() => parseHttpsUrl("https://8.8.8.8/"), /IP/);
});

test("591 and 5168 fixtures extract title/text/photos and strip contact", () => {
  const a = parse591Listing(readFix("import-591-public.html"), "https://rent.591.com.tw/15801234");
  assert.match(a.title, /信義安和/);
  assert.match(a.text, /近捷運/);
  assert.doesNotMatch(a.title + a.text, /0912|0988|foo@example|abc123|王先生|李小姐/);
  assert.ok(a.photos.includes("https://img1.591.com.tw/house/demo-a.jpg"));
  assert.ok(a.photos.includes("https://img2.591.com.tw/house/demo-b.jpg"));

  const b = parse5168Listing(readFix("import-5168-public.html"), "https://rent.houseprice.tw/house/16149174");
  assert.match(b.title, /設計師自住裝潢/);
  assert.match(b.text, /士林夜市/);
  assert.doesNotMatch(b.title + b.text, /02-1234|agent88|陳先生/);
  assert.ok(b.photos.includes("https://static.houseprice.tw/house/demo-1.jpg"));
  assert.equal(b.photos.some((u) => /rent_1200x628_5168/.test(u)), false);

  const dirty = sanitizeImportedTitle('<script>alert(1)</script>好房<iframe src="x">');
  assert.equal(dirty.includes("<"), false);
  assert.match(sanitizeImportedText("第一段<br>第二段\n電話 0912-345-678"), /第一段/);
  assert.doesNotMatch(sanitizeImportedText("電話 0912-345-678"), /0912/);
});

test("normal member cannot import; sponsor can", async () => {
  const db = open();
  addUser(db, { id: 1, email: "free@example.com", plan: "free" });
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  await assert.rejects(
    () => startListingImport(db, 1, { url: "https://rent.591.com.tw/15801234" }, { plan: "free" }),
    (e) => e.status === 403,
  );
  const row = await start591(db, 2);
  assert.equal(row.status, "ready_for_review");
  assert.equal(row.listing.status, "draft");
  assert.equal(row.listing.contact_name, "");
  assert.equal(row.listing.phone, "");
  assert.equal(row.listing.mobile, "");
  assert.equal(row.listing.pledged, false);
  assert.equal(row.live_sync, false);
  assert.equal(row.photos.includes("https://evil.example/steal.jpg"), false);
  db.close();
});

test("import creates draft not published listing; public view stays hidden", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  const row = await start591(db, 2);
  const mine = getSelfListing(db, row.listing_id, { viewerId: 2 });
  assert.equal(mine.status, "draft");
  assert.throws(() => getSelfListing(db, row.listing_id, { viewerId: 0 }), /關閉或隱藏|找不到/);
  const pub = publicListingView(mine, row.listing_id);
  assert.equal(pub.phone, "");
  assert.equal(pub.contact_name, "");
  db.close();
});

test("user can edit imported text and remove photos before confirmation", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  const row = await start591(db, 2);
  assert.ok(row.photos.length >= 1);
  const kept = [row.photos[0]];
  const edited = reviewListingImport(db, 2, row.id, { title: "改過的標題", body: "改過的說明要夠長才行", photos: kept });
  assert.equal(edited.imported_title, "改過的標題");
  assert.match(edited.imported_text, /改過的說明/);
  assert.deepEqual(edited.listing.photos, kept);
  db.close();
});

test("declaration required with exact id/version/hash; stale version rejected", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  const row = await start591(db, 2);
  const doc = getEffectiveDocument(db, "external_import_declaration");
  assert.throws(() => confirmListingImport(db, 2, row.id, { accept: false }), /勾選/);
  assert.throws(
    () => confirmListingImport(db, 2, row.id, {
      accept: true, document_id: doc.id, version: doc.version, content_hash: "deadbeef",
    }),
    (e) => e.status === 409 && e.code === "declaration_stale",
  );
  const next = createDraft(db, {
    document_type: "external_import_declaration",
    title: doc.title,
    body: `${doc.body}\n新增一句`,
    check_label: doc.check_label,
  });
  publishDocument(db, next.id);
  const current = getEffectiveDocument(db, "external_import_declaration");
  assert.notEqual(current.content_hash, doc.content_hash);
  assert.throws(
    () => confirmListingImport(db, 2, row.id, {
      accept: true, document_id: doc.id, version: doc.version, content_hash: doc.content_hash,
    }),
    /重新閱讀/,
  );
  const consentsBefore = listMemberConsents(db, 2);
  assert.equal(consentsBefore.some((c) => c.document_id === current.id), false);
  const ok = confirmListingImport(db, 2, row.id, {
    accept: true,
    document_id: current.id,
    version: current.version,
    content_hash: current.content_hash,
  });
  assert.equal(ok.status, "confirmed");
  assert.equal(ok.terms_document_id, current.id);
  assert.equal(ok.declaration_version, current.version);
  assert.equal(ok.declaration_content_hash, current.content_hash);
  const consents = listMemberConsents(db, 2);
  assert.equal(consents.some((c) => c.document_id === current.id && c.source === "import"), true);
  assert.equal(consents.some((c) => c.document_id === doc.id && c.content_hash === doc.content_hash), false);
  db.close();
});

test("registration consent is not treated as import confirmation", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  const row = await start591(db, 2);
  const terms = getEffectiveDocument(db, "registration_terms");
  assert.throws(
    () => confirmListingImport(db, 2, row.id, {
      accept: true, document_id: terms.id, version: terms.version, content_hash: terms.content_hash,
    }),
    /重新閱讀/,
  );
  db.close();
});

test("same active source import is reused", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  const first = await start591(db, 2);
  const second = await start591(db, 2);
  assert.equal(second.id, first.id);
  assert.equal(second.reused, true);
  assert.ok(findActiveImportBySource(db, 2, first.normalized_source_url));
  db.close();
});

test("captcha/login and unavailable pages fail truthfully without listing", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  await assert.rejects(
    () => start591(db, 2, { html: readFix("import-591-captcha.html") }),
    (e) => e.code === "FETCH_BLOCKED",
  );
  await assert.rejects(
    () => start591(db, 2, { html: readFix("import-591-gone.html"), url: "https://rent.591.com.tw/15809999" }),
    (e) => e.code === "SOURCE_UNAVAILABLE",
  );
  await assert.rejects(
    () => startListingImport(db, 2, { url: "https://rent.591.com.tw/15808888" }, {
      plan: "sponsor",
      lookupImpl: publicLookup(),
      fetchImpl: mockFetch({ "https://rent.591.com.tw/15808888": { text: "<html><body><p>hello</p></body></html>" } }),
    }),
    (e) => e.code === "PARSE_FAILED",
  );
  const mine = db.prepare("SELECT COUNT(*) n FROM listings WHERE listed_by_user_id=2").get();
  assert.equal(mine.n, 0);
  db.close();
});

test("invalid remote image rejected; partial photo failure visible", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  const row = await start591(db, 2, { badImage: true });
  assert.equal(row.status, "ready_for_review");
  assert.equal(row.failure_code, "PHOTO_IMPORT_PARTIAL");
  assert.ok(row.photo_errors.length >= 1);
  assert.ok(row.photos.length >= 1);
  db.close();
});

test("imported photos count against sponsor quota and cannot exceed it", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  const ts = new Date().toISOString();
  const ins = db.prepare("INSERT INTO member_media(user_id, storage_key, thumb_key, mime, format, created_at) VALUES (?,?,?, 'image/jpeg','jpg', ?)");
  for (let i = 0; i < 99; i++) ins.run(2, `seed-${i}.jpg`, "t.jpg", ts);
  const row = await start591(db, 2);
  assert.equal(countActiveMedia(db, 2), 100);
  assert.equal(row.photos.length, 1);
  assert.equal(row.failure_code, "PHOTO_IMPORT_PARTIAL");
  const second = await startListingImport(db, 2, { url: "https://rent.591.com.tw/15807777" }, {
    plan: "sponsor",
    processor: fakeProcessor,
    lookupImpl: publicLookup(),
    fetchImpl: mockFetch({
      "https://rent.591.com.tw/15807777": { text: readFix("import-591-public.html") },
    }, {
      "https://img1.591.com.tw/house/demo-a.jpg": jpeg(),
      "https://img2.591.com.tw/house/demo-b.jpg": jpeg(),
    }),
  });
  assert.equal(second.status, "ready_for_review");
  assert.equal(second.photos.length, 0);
  assert.equal(second.failure_code, "PHOTO_IMPORT_PARTIAL");
  assert.equal(countActiveMedia(db, 2), 100);
  db.close();
});

test("5168 fixture import + cancel cleans draft/orphan media", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  const html = readFix("import-5168-public.html");
  const row = await startListingImport(db, 2, { url: "https://rent.houseprice.tw/house/16149174" }, {
    plan: "sponsor",
    processor: fakeProcessor,
    lookupImpl: publicLookup(),
    fetchImpl: mockFetch({
      "https://rent.houseprice.tw/house/16149174": { text: html },
    }, {
      "https://static.houseprice.tw/house/demo-1.jpg": jpeg(),
      "https://rent.houseprice.tw/images/house/demo-2.jpg": jpeg(),
    }),
  });
  assert.equal(row.provider, "5168");
  assert.equal(row.listing.status, "draft");
  const before = countActiveMedia(db, 2);
  assert.ok(before >= 1);
  await cancelListingImport(db, 2, row.id);
  const after = getSelfListing(db, row.listing_id, { viewerId: 2 });
  assert.equal(after.status, "cancelled");
  assert.equal(countActiveMedia(db, 2) < before || countActiveMedia(db, 2) === 0, true);
  db.close();
});

test("publish uses remaining c5151 fields and listing pledge; import worker never publishes", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  const row = await start591(db, 2);
  const doc = getEffectiveDocument(db, "external_import_declaration");
  confirmListingImport(db, 2, row.id, {
    accept: true, document_id: doc.id, version: doc.version, content_hash: doc.content_hash,
  });
  assert.throws(
    () => publishConfirmedImport(db, 2, row.id, {
      accept_pledge: false,
      district: "1-8",
      rent: 25000,
      ping: 18,
      floor: 3,
      street: "中正路 100 號",
      body: "近捷運、可入住、有洗衣機。",
    }),
    /聲明/,
  );
  const published = publishConfirmedImport(db, 2, row.id, {
    accept_pledge: true,
    district: "1-8",
    rent: 25000,
    ping: 18,
    floor: 3,
    street: "中正路 100 號",
    body: "近捷運、可入住、有洗衣機。",
    contact_name: "林先生",
    phone: "0912345678",
  });
  assert.equal(published.status, "open");
  assert.equal(published.contact_name, "林先生");
  assert.equal(published.phone, "0912345678");
  assert.equal(published.price_num, 25000);
  db.close();
});

test("admin list and import meta expose provenance without secrets", () => {
  const db = open();
  const meta = importMeta(db, { plan: "sponsor" });
  assert.equal(meta.sponsor, true);
  assert.equal(meta.declaration.document_type, "external_import_declaration");
  assert.match(meta.check_label, /有權使用及刊登/);
  assert.equal(meta.limits.maxPhotos, FETCH_LIMITS.maxPhotos);
  assert.match(IMPORT_USER_AGENT, /JibbyRentImport\/1\.0/);
  const admin = listAdminListingImports(db);
  assert.ok(Array.isArray(admin));
  db.close();
});

test("rate limit import starts without blocking a few manual tries", () => {
  resetAuthRateLimits();
  for (let i = 0; i < 8; i++) assertImportAllowed(9, "1.1.1.1");
  assert.throws(() => assertImportAllowed(9, "1.1.1.1"), (e) => e.status === 429 && e.code === "RATE_LIMITED");
  resetAuthRateLimits();
});

test("failed fetch leaves no fake listing", async () => {
  const db = open();
  addUser(db, { id: 2, email: "vip@example.com", plan: "sponsor" });
  await assert.rejects(
    () => startListingImport(db, 2, { url: "https://rent.591.com.tw/15801234" }, {
      plan: "sponsor",
      lookupImpl: publicLookup(),
      fetchImpl: mockFetch({ "https://rent.591.com.tw/15801234": { status: 404, text: "nope" } }),
    }),
    (e) => e.code === "SOURCE_UNAVAILABLE",
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM listings").get().n, 0);
  db.close();
});

_setSafeFetchForTests({});
