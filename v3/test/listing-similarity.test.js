import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureBudgetSchema,
  saveProviderConfig,
} from "../src/budgetGuard.js";
import {
  flipHexBits,
  hammingDistance,
  hashesAreSimilar,
  hexHashFromBits,
  isAllowedImageUrl,
  pairwiseSimilarHashes,
} from "../src/phash.js";
import {
  enqueueListingSimilarity,
  ensureListingSimilaritySchema,
  hardVetoReasons,
  isPhashEnabled,
  listSimilaritySuggestions,
  reviewSimilarity,
  savePhashSettings,
  shouldAskLlm,
} from "../src/listingSimilarity.js";
import {
  assertSafeLlmPayload,
  listingLlmSlice,
  sanitizeSameHousePayload,
} from "../src/providers/llm.js";
import {
  ensureUserSameHouseSchema,
  loadPersonalSameHouseIds,
  mergePersonalSameHouse,
  splitPersonalSameHouse,
} from "../src/userSameHouse.js";
import { scoreMatch } from "../src/match.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const adminHtml = readFileSync(path.join(dir, "../public/admin.html"), "utf8");

const BASE_HASH = hexHashFromBits(Array.from({ length: 64 }, (_, i) => (i % 2)));

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS listings (
      post_id INTEGER PRIMARY KEY,
      title TEXT,
      address TEXT,
      floor_name TEXT,
      area_name TEXT,
      layout TEXT,
      cover TEXT,
      tags TEXT,
      extra_fee_text TEXT,
      source_key TEXT
    );
    INSERT INTO users(id) VALUES (1);
  `);
  ensureBudgetSchema(db);
  ensureListingSimilaritySchema(db);
  ensureUserSameHouseSchema(db);
  return db;
}

function insertListing(db, row) {
  db.prepare(`
    INSERT INTO listings(post_id, title, address, floor_name, area_name, layout, cover, tags, extra_fee_text, source_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.post_id,
    row.title || `物件 ${row.post_id}`,
    row.address || "台北市士林區福華路141巷",
    row.floor_name || "3F/4F",
    row.area_name || "17坪",
    row.layout || "2房1廳",
    row.cover || `https://img.example/${row.post_id}.jpg`,
    row.tags || "[]",
    row.extra_fee_text || "",
    row.source_key || `k${row.post_id}`,
  );
  return db.prepare("SELECT * FROM listings WHERE post_id = ?").get(row.post_id);
}

test("hamming distance counts flipped bits and rejects chaining far pairs", () => {
  const near = flipHexBits(BASE_HASH, [0, 1, 2]);
  const mid = flipHexBits(BASE_HASH, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(hammingDistance(BASE_HASH, near), 3);
  assert.equal(hashesAreSimilar(BASE_HASH, near), true);
  assert.equal(hashesAreSimilar(BASE_HASH, mid), false);
  const pairs = pairwiseSimilarHashes([
    { post_id: 1, phash: BASE_HASH },
    { post_id: 2, phash: near },
    { post_id: 3, phash: mid },
  ]);
  assert.deepEqual(pairs.map((row) => `${row.listing_a}-${row.listing_b}`), ["1-2"]);
});

test("A≈B and B≈C do not create A=C suggestion", async () => {
  const db = open();
  savePhashSettings(db, { enabled: true });
  const hashA = BASE_HASH;
  const hashB = flipHexBits(BASE_HASH, [0, 1, 2, 3, 4, 5, 6, 7]);
  const hashC = flipHexBits(hashB, [20, 21, 22, 23, 24, 25, 26, 27]);
  assert.ok(hammingDistance(hashA, hashB) <= 10);
  assert.ok(hammingDistance(hashB, hashC) <= 10);
  assert.ok(hammingDistance(hashA, hashC) > 10);

  const a = insertListing(db, { post_id: 11, cover: "https://cdn.example/a.jpg" });
  const b = insertListing(db, { post_id: 22, cover: "https://cdn.example/b.jpg" });
  const c = insertListing(db, { post_id: 33, cover: "https://cdn.example/c.jpg" });
  await enqueueListingSimilarity(db, a, { phashHex: hashA });
  await enqueueListingSimilarity(db, b, { phashHex: hashB });
  await enqueueListingSimilarity(db, c, { phashHex: hashC });
  const pending = listSimilaritySuggestions(db, { review_state: "pending" });
  const keys = pending.map((row) => `${row.listing_a}-${row.listing_b}`).sort();
  assert.deepEqual(keys, ["11-22", "22-33"]);
  assert.equal(keys.includes("11-33"), false);
  db.close();
});

test("reliable floor or house conflict is never overridden by similar hash or LLM same", async () => {
  const db = open();
  savePhashSettings(db, { enabled: true });
  saveProviderConfig(db, {
    category: "llm",
    provider_code: "stub_paid",
    is_enabled: true,
    daily_budget_twd: 20,
    ceiling_twd: 1,
  });
  const a = insertListing(db, {
    post_id: 41,
    address: "台北市士林區福華路141巷1號",
    floor_name: "3F/4F",
    cover: "https://cdn.example/same.jpg",
  });
  const b = insertListing(db, {
    post_id: 42,
    address: "台北市士林區福華路141巷9號",
    floor_name: "8F/8F",
    cover: "https://cdn.example/same.jpg?x=1",
  });
  const veto = hardVetoReasons(a, b);
  assert.ok(veto.includes("house_number_mismatch"));
  assert.ok(veto.includes("floor_mismatch"));
  assert.equal(shouldAskLlm({ hamming: 0, veto, matchHit: null }), false);
  assert.equal(scoreMatch(a, b), null);
  let llmCalls = 0;
  const out = await enqueueListingSimilarity(db, a, {
    phashHex: BASE_HASH,
    llmCompare: async () => {
      llmCalls += 1;
      return { verdict: "same", confidence: 0.99 };
    },
  });
  await enqueueListingSimilarity(db, b, {
    phashHex: BASE_HASH,
    llmCompare: async () => {
      llmCalls += 1;
      return { verdict: "same", confidence: 0.99 };
    },
  });
  assert.equal(llmCalls, 0);
  const row = listSimilaritySuggestions(db)[0];
  assert.ok(row.blocked_by_veto.length);
  assert.equal(row.llm, null);
  assert.equal(scoreMatch(a, b), null);
  assert.ok(out.suggestions.length === 0 || out.suggestions[0].blocked_by_veto.length);
  db.close();
});

test("phash and LLM off leave the old match.js path unchanged", async () => {
  const db = open();
  const incoming = {
    post_id: 2002,
    address: "新北市淡水區淡金路二段173號",
    floor_name: "11F/14F",
    area_name: "15.5坪",
    layout: "2房1廳",
    role_name: "湯小姐",
    cover: "https://img.example/brand-new-photo.jpg",
    community_id: 0,
    source_key: "3|50||淡水區淡金路二段173號|11F|15.5|2房1廳",
  };
  const previous = {
    post_id: 1001,
    address: "新北市淡水區淡金路二段173號",
    floor_name: "11F/14F",
    area_name: "15.5坪",
    layout: "2房1廳",
    role_name: "湯小姐",
    cover: "https://img.example/a.jpg!800x600",
    community_id: 101675,
    source_key: "3|50|c101675|新北市淡水區淡金路二段173號|11F|15.5|2房1廳",
    offline: 1,
  };
  assert.equal(isPhashEnabled(db), false);
  const before = scoreMatch(incoming, previous);
  const out = await enqueueListingSimilarity(db, incoming, { phashHex: BASE_HASH });
  assert.equal(out.skipped, "disabled");
  assert.equal(listSimilaritySuggestions(db).length, 0);
  const after = scoreMatch(incoming, previous);
  assert.deepEqual(after, before);
  assert.equal(after.level, "high");
  db.close();
});

test("accepting or rejecting a suggestion does not overwrite manual merge or split", async () => {
  const db = open();
  savePhashSettings(db, { enabled: true });
  const a = insertListing(db, { post_id: 71, title: "芝山 A" });
  const b = insertListing(db, { post_id: 72, title: "芝山 B" });
  await enqueueListingSimilarity(db, a, { phashHex: BASE_HASH });
  await enqueueListingSimilarity(db, b, { phashHex: BASE_HASH });
  const merged = mergePersonalSameHouse(db, 1, [a, b]);
  assert.equal(merged.ok, true);
  assert.deepEqual(loadPersonalSameHouseIds(db, 1, 71), [72]);
  const suggestion = listSimilaritySuggestions(db)[0];
  reviewSimilarity(db, suggestion.id, { review_state: "accepted" }, 1);
  assert.deepEqual(loadPersonalSameHouseIds(db, 1, 71), [72]);
  reviewSimilarity(db, suggestion.id, { review_state: "rejected" }, 1);
  assert.deepEqual(loadPersonalSameHouseIds(db, 1, 71), [72]);
  splitPersonalSameHouse(db, 1, 71, 72);
  assert.deepEqual(loadPersonalSameHouseIds(db, 1, 71), []);
  assert.equal(listSimilaritySuggestions(db, { review_state: "rejected" })[0].review_state, "rejected");
  db.close();
});

test("llm payload only sends title, fuzzy address, tags and unstructured note", () => {
  const payload = sanitizeSameHousePayload({
    title: "<b>芝山兩房</b>",
    address: "台北市士林區福華路141巷12號",
    extra_fee_text: "管理費 2000，聯絡 0911222333 與 agent@example.com",
    tags: '["近捷運","可寵"]',
    self_body: "<html><p>頂樓加蓋</p></html>",
  }, {
    title: "芝山兩房採光",
    address: "台北市士林區福華路141巷8號",
    tags: [],
  });
  assert.equal(payload.a.title, "芝山兩房");
  assert.match(payload.a.fuzzy_address, /福華路/);
  assert.doesNotMatch(payload.a.fuzzy_address, /12號/);
  assert.doesNotMatch(payload.a.note, /0911222333|@example.com|<html/);
  assert.deepEqual(payload.a.tags, ["近捷運", "可寵"]);
  assert.doesNotMatch(JSON.stringify(payload), /<html|0911222333|@example.com/);
  assertSafeLlmPayload(payload);
  assert.throws(() => assertSafeLlmPayload({ note: "<html>secret</html>" }), /unsafe llm payload/);
  const intl = sanitizeSameHousePayload({
    title: "測試",
    extra_fee_text: "請加 LINE 或 +886912345678 / agent @ mail.com",
  }, { title: "B" });
  assert.doesNotMatch(JSON.stringify(intl), /\+886|912345678|mail\.com/);
});

test("llm and crawl insight are independent switches", async () => {
  const db = open();
  savePhashSettings(db, { enabled: true });
  saveProviderConfig(db, {
    category: "llm",
    provider_code: "stub_paid",
    is_enabled: true,
    daily_budget_twd: 20,
    ceiling_twd: 1,
  });
  const a = insertListing(db, {
    post_id: 81,
    address: "台北市士林區福華路",
    floor_name: "3F/4F",
    extra_fee_text: "含管理費",
  });
  const b = insertListing(db, {
    post_id: 82,
    address: "新北市淡水區中山路",
    floor_name: "3F/4F",
    extra_fee_text: "含管理費",
  });
  let compareCalls = 0;
  let insightCalls = 0;
  await enqueueListingSimilarity(db, a, {
    phashHex: BASE_HASH,
    llmCompare: async () => {
      compareCalls += 1;
      return { verdict: "uncertain", confidence: 0.2 };
    },
    llmInsight: async () => {
      insightCalls += 1;
      return { floor: "3F", confidence: 0.9 };
    },
  });
  await enqueueListingSimilarity(db, b, {
    phashHex: BASE_HASH,
    llmCompare: async () => {
      compareCalls += 1;
      return { verdict: "uncertain", confidence: 0.2 };
    },
    llmInsight: async () => {
      insightCalls += 1;
      return { floor: "3F", confidence: 0.9 };
    },
  });
  assert.ok(compareCalls >= 1);
  assert.equal(insightCalls, 0);
  const insights = db.prepare("SELECT COUNT(*) AS n FROM listing_crawl_insight").get();
  assert.equal(insights.n, 0);

  saveProviderConfig(db, {
    category: "llm",
    provider_code: "stub_paid",
    is_enabled: false,
    daily_budget_twd: 20,
    ceiling_twd: 1,
  });
  saveProviderConfig(db, {
    category: "llm_crawl_insight",
    provider_code: "stub_paid",
    is_enabled: true,
    daily_budget_twd: 20,
    ceiling_twd: 1,
  });
  compareCalls = 0;
  insightCalls = 0;
  await enqueueListingSimilarity(db, a, {
    phashHex: BASE_HASH,
    llmCompare: async () => {
      compareCalls += 1;
      return { verdict: "same", confidence: 0.9 };
    },
    llmInsight: async () => {
      insightCalls += 1;
      return { floor: "3F", parking: "無", rooftop: "", fees: "管理費", confidence: 0.9 };
    },
  });
  assert.equal(compareCalls, 0);
  assert.equal(insightCalls, 1);
  const stored = db.prepare("SELECT apply_state, hints_json FROM listing_crawl_insight WHERE post_id = 81").get();
  assert.equal(stored.apply_state, "hint_only");
  assert.match(stored.hints_json, /管理費/);
  assert.equal(db.prepare("SELECT floor_name FROM listings WHERE post_id = 81").get().floor_name, "3F/4F");
  db.close();
});

test("crawl insight never overwrites an existing structured floor", async () => {
  const db = open();
  savePhashSettings(db, { insight_apply_enabled: true });
  saveProviderConfig(db, {
    category: "llm_crawl_insight",
    provider_code: "stub_paid",
    is_enabled: true,
    daily_budget_twd: 20,
    ceiling_twd: 1,
  });
  const listing = insertListing(db, { post_id: 91, floor_name: "5F/7F" });
  await enqueueListingSimilarity(db, listing, {
    llmInsight: async () => ({ floor: "12F", confidence: 0.99 }),
  });
  assert.equal(db.prepare("SELECT floor_name FROM listings WHERE post_id = 91").get().floor_name, "5F/7F");
  assert.equal(db.prepare("SELECT apply_state FROM listing_crawl_insight WHERE post_id = 91").get().apply_state, "hint_only");
  db.close();
});

test("disallowed image urls are skipped", () => {
  assert.equal(isAllowedImageUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedImageUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedImageUrl("http://127.0.0.1/x.jpg"), false);
  assert.equal(isAllowedImageUrl("https://192.168.0.10/x.jpg"), false);
  assert.equal(isAllowedImageUrl("https://169.254.169.254/latest/meta-data/"), false);
  assert.equal(isAllowedImageUrl("http://img.591.com.tw/a.jpg"), false);
  assert.equal(isAllowedImageUrl("https://img.591.com.tw/a.jpg"), true);
});

test("listing slice strips html and pii", () => {
  const slice = listingLlmSlice({
    title: "文林苑",
    address: "台北市士林區文林路100號",
    extra_fee_text: "請電 02-28881234",
  });
  assert.equal(slice.fuzzy_address.includes("號"), false);
  assert.doesNotMatch(slice.note, /28881234/);
});

test("admin plugins surface keeps review table and no stub-only copy", () => {
  assert.match(adminHtml, /id="phashForm"/);
  assert.match(adminHtml, /id="similarityRows"/);
  assert.match(adminHtml, /人工判定優先/);
  assert.doesNotMatch(adminHtml, /第 7 包才接 LLM/);
});
