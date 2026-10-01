import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { listingInMemberScope } from "../src/covering.js";
import {
  closeSelfListing,
  composeSelfAddress,
  createImportedDraftListing,
  createSelfListing,
  ensureSelfListingSchema,
  getSelfListing,
  publishImportedDraftListing,
  setSelfListingCatalog,
  isSelfListingId,
  keepSelfListingForViewer,
  listMineSelfListings,
  publicListingView,
  reportSelfListing,
  SELF_BODY_MAX,
  SELF_LEGAL,
  SELF_POST_ID_BASE,
  selfListingMeta,
  selfSourceLabel,
} from "../src/selfListings.js";
import { SELF_TRAIT_GROUPS, selfTraitLabels } from "../src/selfTraits.js";
import { lookupDistrict } from "../src/regions.js";
import { defaultCatalog, deleteOrDisableCondition, upsertCategory, upsertCondition } from "../src/rentalCatalog.js";
import { setRentalMarketplaceFlags } from "../src/demand.js";

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
      lat REAL,
      lng REAL,
      geo_source TEXT,
      fee_includes TEXT NOT NULL DEFAULT '',
      self_mrt_station TEXT,
      self_mrt_walk_m REAL,
      self_mrt_source TEXT,
      self_mrt_checked_at TEXT,
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
    title: "士林整層可看屋",
    body: "近捷運、可入住、有洗衣機。",
    accept_pledge: true,
    ...extra,
  };
}

test("self listing ids stay above the reserved range and require login", () => {
  assert.equal(isSelfListingId(15801234), false);
  assert.equal(isSelfListingId(SELF_POST_ID_BASE + 1), true);
  assert.equal(isSelfListingId(2_200_000_000), false);
  assert.match(SELF_LEGAL, /不是仲介/);
  assert.match(selfListingMeta().legal, /不經手金錢/);
  assert.match(selfListingMeta().audit, /14 天/);
  assert.equal(selfListingMeta().photos.max_count, 100);
  assert.equal(SELF_BODY_MAX, 500);
  assert.equal(selfListingMeta().body_max, 500);
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  assert.throws(() => createSelfListing(db, 0, sampleInput()), /請先登入/);
  const row = createSelfListing(db, 1, sampleInput());
  assert.equal(row.title, "士林整層可看屋");
  assert.throws(
    () => createSelfListing(db, 1, sampleInput({ title: "短標", address: "台北市士林區中正路102號" })),
    /標題至少/,
  );
  assert.ok(row.post_id > SELF_POST_ID_BASE);
  assert.equal(row.source, "self");
  assert.equal(row.source_label, "吉比本站");
  assert.deepEqual(row.photos, []);
  assert.equal(row.kind_name, "整層住家");
  assert.match(row.search_key || db.prepare("SELECT search_key FROM listings WHERE post_id = ?").get(row.post_id).search_key, /region=1/);
  db.close();
});

test("selfSourceLabel marks 591 and 吉比本站", () => {
  assert.equal(selfSourceLabel("591"), "591");
  assert.equal(selfSourceLabel(""), "591");
  assert.equal(selfSourceLabel(undefined), "591");
  assert.equal(selfSourceLabel("self"), "吉比本站");
  assert.equal(selfSourceLabel("hbhousing"), "住商");
});

test("open quota, new-account wait, close and report hide", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  addUser(db, { id: 2, email: "new@example.com", createdAt: new Date().toISOString() });
  addUser(db, { id: 3, email: "b@example.com", createdAt: OLD });
  addUser(db, { id: 4, email: "c@example.com", createdAt: OLD });
  for (let i = 1; i <= 10; i++) {
    createSelfListing(db, 1, sampleInput({ address: `台北市士林區中正路${100 + i}號` }));
  }
  assert.throws(
    () => createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路199號" })),
    /最多 10 則/,
  );
  assert.throws(
    () => createSelfListing(db, 2, sampleInput()),
    /24 小時/,
  );
  const mine = listMineSelfListings(db, 1);
  assert.equal(mine.length, 10);
  closeSelfListing(db, 1, mine[0].post_id);
  const afterClose = createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路198號" }));
  assert.equal(listMineSelfListings(db, 1).filter((row) => row.status === "open").length, 10);
  reportSelfListing(db, 3, afterClose.post_id, "廣告");
  const second = reportSelfListing(db, 4, afterClose.post_id, "廣告");
  assert.equal(second.hidden, true);
  assert.throws(
    () => createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路199號" })),
    /暫停上傳/,
  );
  db.close();
});

test("self listing needs street name and owner pledge, phone is optional", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  const district = lookupDistrict("1-8");
  assert.equal(composeSelfAddress(district, "中正路100號"), "台北市士林區中正路100號");
  assert.throws(() => composeSelfAddress(district, "100號"), /路名/);
  assert.throws(() => createSelfListing(db, 1, sampleInput({ accept_pledge: false })), /聲明/);
  const row = createSelfListing(db, 1, sampleInput({
    phone: "",
    line_url: "",
    street: "中正路88號",
    traits: ["elevator", "community", "courtyard", "balcony", "ac"],
    deposit: "one",
  }));
  assert.equal(row.address, "台北市士林區中正路88號");
  assert.equal(row.phone, "");
  assert.deepEqual(row.traits, ["elevator", "community", "courtyard", "balcony", "ac"]);
  assert.ok(row.trait_labels.includes("電梯大樓"));
  assert.ok(row.trait_labels.includes("有中庭"));
  assert.ok(row.trait_labels.includes("有陽台"));
  assert.equal(row.pledged, true);
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
  assert.match(html, /id="notifyInbox"/);
  assert.match(html, /id="profileForm"/);
  assert.match(html, /id="ownerFab"/);
  assert.match(html, /id="selfTraitGroups"/);
  assert.match(html, /id="selfPledge"/);
  assert.match(html, /id="selfCity"/);
  assert.match(html, /data-nav="post"/);
  assert.match(html, /有房刊登/);
  assert.match(html, /pledge-row/);
  assert.doesNotMatch(html, /id="meFilterBtn"/);
  assert.match(html, /id: "courtyard"/);
  assert.match(html, /paintSelfTraits\(Array\.isArray\(data\.traits\)/);
  assert.match(html, /data-listing-polar/);
  assert.match(html, /listing_values: collectedListingValues\(\)/);
  assert.match(html, /id: "balcony"/);
  assert.match(html, /電梯大樓/);
  assert.match(html, /有中庭/);
  assert.match(html, /selfRichHint/);
  assert.match(html, /刊登者自行聲明為屋主／代理人/);
  assert.match(html, /maxlength="500"/);
  assert.match(server, /app\.post\("\/api\/self-listings"/);
  assert.match(server, /app\.post\("\/api\/self-listings\/photos"/);
  assert.match(server, /app\.get\("\/media\/self\/:file"/);
  assert.match(server, /listingRedirectTarget/);
  assert.match(admin, /站內自行刊登/);
  assert.match(admin, /列表「較適合」依會員租金、樓層與通勤估算/);
  assert.match(html, /href="\/l\/\$\{encodeURIComponent\(item\.post_id\)\}"/);
});

test("public share view strips private fields; closed listings 404 for guests", () => {
  const db = open();
  addUser(db, { id: 1, email: "owner@example.com", createdAt: OLD });
  const row = createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路101號" }));
  const guest = getSelfListing(db, row.post_id, { viewerId: 0 });
  assert.equal(guest.mine, false);
  assert.equal(guest.phone, "0912345678");
  const view = publicListingView(guest, row.post_id);
  assert.equal(view.id, row.post_id);
  assert.equal(view.title, guest.title);
  assert.equal(view.phone, "0912345678");
  assert.equal(view.contact_name, "林先生");
  assert.equal("mine" in view, false);
  assert.equal("status" in view, false);
  assert.equal("pledged" in view, false);
  assert.equal("expires_at" in view, false);
  assert.equal("match_level" in view, false);
  assert.equal("match_detail" in view, false);
  assert.equal("match_post_id" in view, false);
  assert.equal("email" in view, false);
  assert.equal("listed_by_user_id" in view, false);
  const leaked = publicListingView({
    ...guest,
    email: "owner@example.com",
    listed_by_user_id: 1,
    password: "secret",
    self_ban_until: "2099-01-01",
  }, row.post_id);
  assert.equal("email" in leaked, false);
  assert.equal("password" in leaked, false);
  assert.equal("listed_by_user_id" in leaked, false);
  assert.equal("self_ban_until" in leaked, false);

  closeSelfListing(db, 1, row.post_id);
  assert.throws(() => getSelfListing(db, row.post_id, { viewerId: 0 }), (e) => e.status === 404);
  const owner = getSelfListing(db, row.post_id, { viewerId: 1 });
  assert.equal(owner.status, "closed");
  db.close();
});

test("catalog-only listing trait survives create, publish-update and read-back", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  const catalog = upsertCondition(defaultCatalog(), { label: "烘衣機", category_id: "appliance" });
  const dryer = catalog.conditions.find((row) => row.label === "烘衣機");
  setRentalMarketplaceFlags({ rental_catalog_v2: { enabled: true } });
  setSelfListingCatalog(catalog, { rental_catalog_v2: { enabled: true } });
  const created = createSelfListing(db, 1, sampleInput({ traits: ["elevator", dryer.id] }));
  assert.ok(created.traits.includes(dryer.id));
  assert.ok(created.trait_labels.includes("烘衣機"));
  const read = getSelfListing(db, created.post_id, { viewerId: 1 });
  assert.ok(read.traits.includes(dryer.id));
  const draft = createImportedDraftListing(db, 1, { title: "士林整層可看屋草稿標題", body: "近捷運、可入住、有洗衣機。" });
  const published = publishImportedDraftListing(db, 1, draft.post_id, sampleInput({
    address: "台北市士林區中正路166號",
    traits: [dryer.id, "fridge"],
  }));
  assert.ok(published.traits.includes(dryer.id));
  assert.ok(published.traits.includes("fridge"));
  setRentalMarketplaceFlags({});
  setSelfListingCatalog(null, { rental_catalog_v2: { enabled: false } });
  const dropped = createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路167號", traits: [dryer.id, "elevator"] }));
  assert.ok(!dropped.traits.includes(dryer.id));
  assert.ok(dropped.traits.includes("elevator"));
  db.close();
});

test("disabled catalog-only listing trait survives reload and republish", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  const catalog = upsertCondition(defaultCatalog(), { label: "烘衣機", category_id: "appliance" });
  const dryer = catalog.conditions.find((row) => row.label === "烘衣機");
  setRentalMarketplaceFlags({ rental_catalog_v2: { enabled: true } });
  setSelfListingCatalog(catalog, { rental_catalog_v2: { enabled: true } });
  const created = createSelfListing(db, 1, sampleInput({ traits: ["elevator", dryer.id] }));
  const disabled = deleteOrDisableCondition(catalog, dryer.id, { listing: 1 });
  setSelfListingCatalog(disabled.catalog, { rental_catalog_v2: { enabled: true } });
  const reloaded = getSelfListing(db, created.post_id, { viewerId: 1 });
  assert.ok(reloaded.traits.includes(dryer.id));
  assert.ok(reloaded.trait_labels.includes("烘衣機"));
  const draft = createImportedDraftListing(db, 1, { title: "士林整層可看屋草稿標題", body: "近捷運、可入住、有洗衣機。" });
  db.prepare("UPDATE listings SET self_traits = ? WHERE post_id = ?").run(JSON.stringify([dryer.id, "elevator"]), draft.post_id);
  const published = publishImportedDraftListing(db, 1, draft.post_id, sampleInput({
    address: "台北市士林區中正路188號",
    traits: ["fridge"],
  }));
  assert.ok(published.traits.includes(dryer.id));
  assert.ok(published.trait_labels.includes("烘衣機"));
  setRentalMarketplaceFlags({});
  setSelfListingCatalog(null, { rental_catalog_v2: { enabled: false } });
  db.close();
});

test("listing polarity can store allowed without treating unchecked as allowed", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  setRentalMarketplaceFlags({ rental_catalog_v2: { enabled: true } });
  setSelfListingCatalog(defaultCatalog(), { rental_catalog_v2: { enabled: true } });
  const blank = createSelfListing(db, 1, sampleInput({ address: "台北市士林區中正路201號", traits: ["elevator"] }));
  assert.equal(blank.listing_values.need_pet, undefined);
  const allowed = createSelfListing(db, 1, sampleInput({
    address: "台北市士林區中正路202號",
    traits: ["elevator"],
    listing_values: { need_pet: "allowed", need_cook: "not_allowed" },
  }));
  assert.equal(allowed.listing_values.need_pet, "allowed");
  assert.equal(allowed.listing_values.need_cook, "not_allowed");
  assert.ok(allowed.traits.includes("pet"));
  assert.ok(allowed.traits.includes("nocook"));
  const read = getSelfListing(db, allowed.post_id, { viewerId: 1 });
  assert.equal(read.listing_values.need_pet, "allowed");
  assert.equal(read.listing_values.need_cook, "not_allowed");
  const meta = selfListingMeta({ catalog: defaultCatalog() });
  assert.ok(meta.traits.flatMap((group) => group.items).some((item) => item.input === "polarity" && item.id === "need_pet"));
  setRentalMarketplaceFlags({});
  setSelfListingCatalog(null, { rental_catalog_v2: { enabled: false } });
  db.close();
});

test("disabled category new listing input is dropped; historical fridge is kept", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  const catalog = defaultCatalog();
  setRentalMarketplaceFlags({ rental_catalog_v2: { enabled: true } });
  setSelfListingCatalog(catalog, { rental_catalog_v2: { enabled: true } });
  const created = createSelfListing(db, 1, sampleInput({
    address: "台北市士林區中正路210號",
    traits: ["elevator", "fridge"],
  }));
  assert.ok(created.traits.includes("fridge"));
  const disabled = upsertCategory(catalog, { id: "appliance", label: "家電", enabled: false });
  setSelfListingCatalog(disabled, { rental_catalog_v2: { enabled: true } });
  const rejected = createSelfListing(db, 1, sampleInput({
    address: "台北市士林區中正路211號",
    traits: ["elevator", "fridge"],
    listing_values: { fridge: "present" },
  }));
  assert.ok(!rejected.traits.includes("fridge"));
  assert.equal(rejected.listing_values.fridge, undefined);
  const draft = createImportedDraftListing(db, 1, { title: "士林整層可看屋草稿標題", body: "近捷運、可入住、有洗衣機。" });
  db.prepare("UPDATE listings SET self_traits = ?, listing_condition_values = ? WHERE post_id = ?").run(
    JSON.stringify(["fridge", "elevator"]),
    JSON.stringify({ fridge: "present" }),
    draft.post_id,
  );
  const published = publishImportedDraftListing(db, 1, draft.post_id, sampleInput({
    address: "台北市士林區中正路212號",
    traits: ["elevator"],
  }));
  assert.ok(published.traits.includes("fridge"));
  const reloaded = getSelfListing(db, created.post_id, { viewerId: 1 });
  assert.ok(reloaded.traits.includes("fridge"));
  setRentalMarketplaceFlags({});
  setSelfListingCatalog(null, { rental_catalog_v2: { enabled: false } });
  db.close();
});


test("A3：後台改名後，前台顯示名稱要跟著目錄走（即使 v2 旗標沒開）", async () => {
  const { defaultCatalog, upsertCondition } = await import("../src/rentalCatalog.js");
  const { catalogTraitLabelMap, overlayTraitLabels, setSelfListingCatalog } = await import("../src/selfListings.js");
  const renamed = upsertCondition(defaultCatalog(), { id: "elevator", label: "華廈/公寓電梯" });

  // 1) 標籤表不受 v2 旗標影響：旗標關著也要拿得到目錄上的名稱
  setRentalMarketplaceFlags({});
  setSelfListingCatalog(renamed, { rental_catalog_v2: { enabled: false } });
  const labels = catalogTraitLabelMap(renamed);
  assert.equal(labels.elevator, "華廈/公寓電梯");

  // 2) 刊登表單：結構走靜態表時，顯示名稱仍被覆蓋；**id 與其他欄位完全不動**
  const metaOff = selfListingMeta({ catalog: null, catalogLabels: labels });
  const offItem = metaOff.traits.flatMap((g) => g.items).find((i) => i.id === "elevator");
  assert.equal(offItem.label, "華廈/公寓電梯");
  const staticItem = SELF_TRAIT_GROUPS.flatMap((g) => g.items).find((i) => i.id === "elevator");
  assert.equal(offItem.input, staticItem.input);
  assert.notEqual(staticItem.label, offItem.label, "靜態表本身不可以被就地改寫");
  // 通則：目錄有的 id ⇒ 用目錄的名稱；目錄沒有的 id ⇒ 保持靜態名稱（歷史／其他條件不受影響）
  const staticFlat = SELF_TRAIT_GROUPS.flatMap((g) => g.items);
  const overlaidFlat = metaOff.traits.flatMap((g) => g.items);
  let fromCatalog = 0;
  for (const item of staticFlat) {
    const got = overlaidFlat.find((i) => i.id === item.id)?.label;
    if (labels[item.id]) { assert.equal(got, labels[item.id], `${item.id} 應採用目錄名稱`); fromCatalog += 1; }
    else { assert.equal(got, item.label, `${item.id} 目錄沒有，應保持靜態名稱`); }
  }
  assert.ok(fromCatalog > 10, "應該有多數條件對得上目錄");
  // 目錄整份缺失時要安全落回靜態名稱（不可以用空目錄把標籤清成 undefined）
  assert.deepEqual(catalogTraitLabelMap({ categories: [], conditions: [] }), {});
  assert.deepEqual(catalogTraitLabelMap(null), {});
  const emptyOverlay = overlayTraitLabels(SELF_TRAIT_GROUPS, {});
  assert.equal(emptyOverlay.flatMap((g) => g.items).find((i) => i.id === "elevator").label, staticItem.label);

  // 3) 我的刊登卡片／公開分享頁的標籤也吃同一份目錄
  assert.deepEqual(selfTraitLabels(["elevator"], labels), ["華廈/公寓電梯"]);

  // 4) overlay 不會改到原陣列（純函式）
  const groups = [{ id: "building", label: "建物", items: [{ id: "elevator", label: "電梯" }] }];
  const overlaid = overlayTraitLabels(groups, { elevator: "華廈/公寓電梯" });
  assert.equal(overlaid[0].items[0].label, "華廈/公寓電梯");
  assert.equal(groups[0].items[0].label, "電梯");
  assert.deepEqual(overlayTraitLabels(groups, {}), groups);

  setRentalMarketplaceFlags({});
  setSelfListingCatalog(null, { rental_catalog_v2: { enabled: false } });
});

test("R2：費用三態與座標／捷運查證會綁在房源上，重新編輯可以還原", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  setRentalMarketplaceFlags({});
  setSelfListingCatalog(null, { rental_catalog_v2: { enabled: false } });
  const post = createSelfListing(db, 1, sampleInput({
    fee_includes: { utilities: "included", management: "extra", internet: "unknown" },
    lat: 25.033,
    lng: 121.565,
    geo_source: "self",
    mrt_station: "台北101/世貿",
    mrt_walk_m: 330.4,
    mrt_source: "osrm-foot:v1",
    mrt_checked_at: "2026-10-01T00:00:00.000Z",
  }), new Date("2026-10-01T00:00:00.000Z"));
  const row = db.prepare("SELECT * FROM listings WHERE post_id=?").get(post.post_id);
  // 明確填的兩項寫入；「未確認」不會被寫成一個值
  assert.deepEqual(JSON.parse(row.fee_includes), { utilities: "included", management: "extra" });
  assert.equal(row.lat, 25.033);
  assert.equal(row.geo_source, "self");
  assert.equal(row.self_mrt_station, "台北101/世貿");
  assert.equal(row.self_mrt_walk_m, 330.4);
  assert.equal(row.self_mrt_source, "osrm-foot:v1");
  // 讀回來可以還原（重新編輯）
  const read = getSelfListing(db, post.post_id, { viewerId: 1 });
  assert.deepEqual(read.fee_includes, { utilities: "included", management: "extra" });
  assert.deepEqual(read.fee_include_labels, ["租金含水電"]);
  assert.equal(read.mrt_walk_m, 330.4);
  db.close();
});

test("R2：編輯時沒提到費用就沿用舊值；地址變了但定位不到 ⇒ 清掉舊座標與舊查證", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  setRentalMarketplaceFlags({});
  setSelfListingCatalog(null, { rental_catalog_v2: { enabled: false } });
  const post = createSelfListing(db, 1, sampleInput({
    fee_includes: { utilities: "included" },
    lat: 25.033, lng: 121.565, geo_source: "self",
    mrt_station: "台北101/世貿", mrt_walk_m: 330, mrt_source: "osrm-foot:v1",
  }), new Date("2026-10-01T00:00:00.000Z"));
  // 這一則要先變成「待刊登草稿」才走得到 publish 路徑（與使用者的實際流程一致）。
  db.prepare("UPDATE listings SET self_status='draft' WHERE post_id=?").run(post.post_id);

  // 1) 發布草稿時沒帶 fee_includes／座標 ⇒ 全部沿用
  publishImportedDraftListing(db, 1, post.post_id, sampleInput({
    rent: 30000, ping: 20, accept_pledge: true,
  }), new Date("2026-10-01T01:00:00.000Z"));
  const row1 = db.prepare("SELECT * FROM listings WHERE post_id=?").get(post.post_id);
  assert.deepEqual(JSON.parse(row1.fee_includes), { utilities: "included" });
  assert.equal(row1.lat, 25.033);
  assert.equal(row1.self_mrt_walk_m, 330);

  // 2) 地址換了而且沒有新的定位結果 ⇒ 舊座標與舊查證都要失效
  db.prepare("UPDATE listings SET self_status='draft' WHERE post_id=?").run(post.post_id);
  publishImportedDraftListing(db, 1, post.post_id, sampleInput({
    district: "1-9", rent: 30000, ping: 20, address: "台北市信義區松高路 11 號", accept_pledge: true,
  }), new Date("2026-10-01T02:00:00.000Z"));
  const row2 = db.prepare("SELECT * FROM listings WHERE post_id=?").get(post.post_id);
  assert.equal(row2.lat, null, "舊座標必須失效");
  assert.equal(row2.lng, null);
  assert.equal(row2.geo_source, "");
  assert.equal(row2.self_mrt_walk_m, null, "舊地址的步行查證不可以留著");
  assert.equal(row2.self_mrt_station, null);
  // 費用是與地址無關的資料 ⇒ 仍然保留
  assert.deepEqual(JSON.parse(row2.fee_includes), { utilities: "included" });
  db.close();
});
