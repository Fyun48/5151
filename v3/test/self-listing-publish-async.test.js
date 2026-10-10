// 公開站內刊登草稿（`POST /api/self-listings/:id/publish`）與匯入的
// 「確認後刊登」（`POST /api/listing-imports/:id/publish`）PG 島嶼的 parity
// （2026-09-29，第八十三批）。
//
// 同步版整條讀寫節點本機：草稿列、停權／註冊時間（`users`）、同時公開數、頭像、
// 條件值（`listing_condition_values`）與配對候選。PG 模式下「別的節點建立的草稿」根本公開不了
// （404），而**站上的刊登清單讀的是 PG** ⇒ 公開動作看起來成功、刊登卻不在站上。
//
// 這一包釘住：兩個 driver 的公開結果與錯誤形狀相同、**草稿只放在 PG 時 PG 版照樣公開得出來**、
// 可刊登條件（停權／註冊未滿 24 小時／同時上限）讀 PG、素材所有權、以及兩條路由的接線。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-publish83-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

const dbMod = await import("../src/db.js");
const selfAsync = await import("../src/selfListingsAsync.js");
const selfListings = await import("../src/selfListings.js");
const importAsync = await import("../src/listingImportAsync.js");
const importSync = await import("../src/listingImport.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const diskPath = () => path.join(dataDir, "v3.db");
const OWNER = 830001;
const OTHER = 830002;
const DISTRICT = "1-2";
const STAMP = "2026-01-01T00:00:00.000Z";
const MEDIA_KEY = `${"d".repeat(32)}.jpg`;
const MEDIA_URL = `/media/lib/${MEDIA_KEY}`;
const IMPORT_ID = 830901;

// ⚠️ 不擋 `IFNULL`：配對候選的 SQL 由 `db.js:matchCandidateQuery()` 產生（兩個 driver 共用同一句），
// 真 PG 路徑靠 `toPostgresSql()` 翻成 `COALESCE`，注入式 exec 不會被翻譯 ⇒ 夾具自己翻。
const PG_ILLEGAL = [
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\bAUTOINCREMENT\b/i, "syntax error at or near \"AUTOINCREMENT\""],
];
const TABLES = [
  "users", "settings", "user_settings", "listings", "member_media", "listing_import",
  "demand_posts", "demand_match_districts", "demand_match_generation", "user_listing_flags",
];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const row = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.ok(row?.sql, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(row.sql);
  }
  for (const t of TABLES) {
    const cols = disk.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const rows = disk.prepare(`SELECT * FROM ${t}`).all();
    if (!rows.length) continue;
    const insert = mem.prepare(`INSERT INTO ${t}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const row of rows) insert.run(...cols.map((c) => row[c]));
  }
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    // 夾具同時滿足兩種 exec 慣例（裸陣列／`{rows}`）：回一個「自己是自己的 rows」的陣列。
    const text = sql.replace(/\bIFNULL\s*\(/gi, "COALESCE(");
    try {
      const rows = mem.prepare(text).all(...params);
      rows.rows = rows;
      return rows;
    } catch (error) {
      throw new Error(`夾具無法執行這句 SQL：${error.message}\n${text}`);
    }
  };
  exec.raw = mem;
  return exec;
}

const errorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, code: error.code || "", message: error.message }; }
};
const syncErrorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, code: error.code || "", message: error.message }; }
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const PUBLISH_INPUT = {
  district: DISTRICT, street: "民生西路 100 號", rent: 28000, ping: "25", accept_pledge: true,
  body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
  floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
  title: "公開測試刊登", kind: "apartment", role: "owner", contact_name: "測試屋主",
  photos: [MEDIA_URL],
};
const shapeOf = (listing) => ({
  title: listing.title,
  price: Number(listing.price) || 0,
  floor_name: listing.floor_name,
  area_name: listing.area_name,
  kind_name: listing.kind_name,
  contact_name: listing.contact_name,
  contact_uid: String(listing.contact_uid || ""),
  mobile: listing.mobile,
  photos: listing.photos,
});

/** 屋主 ＋ 一則草稿（用應用自己的寫入路徑）＋ 一張自己的素材 ＋ 一筆已確認的匯入。 */
function seedWorld({ draftTitle = "草稿刊登" } = {}) {
  const h = handle();
  h.prepare("DELETE FROM listings WHERE COALESCE(source, '591') = 'self'").run();
  h.prepare("DELETE FROM member_media").run();
  h.prepare("DELETE FROM listing_import WHERE id = ?").run(IMPORT_ID);
  for (const uid of [OWNER, OTHER]) {
    h.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
      .run(uid, `p${uid}@example.test`, `會員${uid}`, STAMP);
  }
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true } });
  h.prepare("INSERT INTO member_media(user_id, storage_key, mime, format, created_at, deleted_at) VALUES (?,?,?,?,?,NULL)")
    .run(OWNER, MEDIA_KEY, "image/jpeg", "jpg", STAMP);
  const draft = selfListings.insertSelfDraftListing(h, OWNER, {
    title: draftTitle,
    body: "草稿內容：近捷運、採光好，適合小家庭。",
    photos: [MEDIA_URL],
    rent: 0,
    address: "",
    area_name: "",
    layout: "2房1廳1衛",
    floor_name: "5F",
    kind_name: "公寓",
    role_name: "屋主",
    traits: [],
    deposit: "none",
    contact_name: "測試屋主",
    phone: "0912345678",
    line_url: "",
  });
  h.prepare(
    `INSERT INTO listing_import(id, user_id, provider, original_source_url, normalized_source_url, status, listing_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(IMPORT_ID, OWNER, "591", "https://example.com/import-publish", "https://example.com/import-publish", "confirmed", draft.post_id, STAMP);
  return { draftId: Number(draft.post_id) };
}

test("公開草稿：參數驗證的錯誤形狀與同步版逐字相同", async () => {
  const bad = [
    [{ ...PUBLISH_INPUT, accept_pledge: false }, "沒勾聲明"],
    [{ ...PUBLISH_INPUT, rent: 10 }, "租金不合理"],
    [{ ...PUBLISH_INPUT, ping: "0" }, "坪數不合理"],
    [{ ...PUBLISH_INPUT, district: "" }, "沒有行政區"],
    [{ ...PUBLISH_INPUT, body: "短" }, "說明太短"],
    [{ ...PUBLISH_INPUT, floor: 0, floor_name: "" }, "沒有樓層"],
  ];
  for (const [input, why] of bad) {
    const { draftId } = seedWorld({ draftTitle: `草稿-${why}` });
    const exec = pgFixture();
    const syncErr = syncErrorShape(() => selfListings.publishImportedDraftListing(handle(), OWNER, draftId, input, new Date()));
    const asyncErr = await errorShape(() => selfAsync.publishImportedDraftListingAsync(OWNER, draftId, input, { ...PG, exec }));
    assert.ok(syncErr, `前提：同步版要擋下（${why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${why}）`);
  }
});

test("公開草稿：PG 版與同步版的落地欄位相同（公開後狀態是 open）", async () => {
  const { draftId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  const sync = plain(selfListings.publishImportedDraftListing(handle(), OWNER, draftId, PUBLISH_INPUT, new Date()));
  // ⚠️ 鑑別力（P5a 之後）：同步版剛把本機那一列寫成 `open`，這裡先退回 `draft`，這樣
  // 「async 版有沒有碰本機」才看得出來——原本的斷言是「本機鏡射也要追上」。
  handle().prepare("UPDATE listings SET self_status = 'draft' WHERE post_id = ?").run(draftId);
  const async_ = plain(await selfAsync.publishImportedDraftListingAsync(OWNER, draftId, PUBLISH_INPUT, opts));
  assert.deepEqual(shapeOf(async_), shapeOf(sync), "公開後的落地欄位必須逐欄位相同");
  assert.equal(
    exec.raw.prepare("SELECT self_status FROM listings WHERE post_id = ?").get(draftId).self_status, "open",
    "PG 上的狀態要變成 open",
  );
  assert.equal(
    handle().prepare("SELECT self_status FROM listings WHERE post_id = ?").get(draftId).self_status, "draft",
    "本機那一列不得被 async 版公開（P5a 刪掉本機鏡射）",
  );
});

test("草稿只放在 PG 時：同步版 404，PG 版照樣公開得出來", async () => {
  const { draftId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  const before = plain(await selfAsync.publishImportedDraftListingAsync(OWNER, draftId, PUBLISH_INPUT, opts));
  // 把草稿從本機刪掉（模擬「草稿是別的節點建立的」）並把 PG 的那一列改回 draft
  handle().prepare("DELETE FROM listings WHERE post_id = ?").run(draftId);
  exec.raw.prepare("UPDATE listings SET self_status = 'draft' WHERE post_id = ?").run(draftId);
  assert.equal(
    syncErrorShape(() => selfListings.publishImportedDraftListing(handle(), OWNER, draftId, PUBLISH_INPUT, new Date()))?.status, 404,
    "前提：同步版讀本機 ⇒ 找不到草稿",
  );
  const after = plain(await selfAsync.publishImportedDraftListingAsync(OWNER, draftId, PUBLISH_INPUT, opts));
  assert.deepEqual(shapeOf(after), shapeOf(before), "PG 版必須不受本機有沒有草稿影響");
});

test("可刊登條件讀 PG：停權、註冊未滿 24 小時、同時上限都算 PG 的", async () => {
  const { draftId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  // (a) 停權中（PG 的那一列）
  exec.raw.prepare("UPDATE users SET self_ban_until = ? WHERE id = ?").run("2099-01-01T00:00:00.000Z", OWNER);
  const banned = await errorShape(() => selfAsync.publishImportedDraftListingAsync(OWNER, draftId, PUBLISH_INPUT, opts));
  assert.equal(banned?.status, 403, "PG 說停權就要 403");
  assert.match(String(banned?.message || ""), /暫停上傳/);
  assert.equal(
    syncErrorShape(() => selfListings.publishImportedDraftListing(handle(), OWNER, draftId, PUBLISH_INPUT, new Date())),
    null,
    "前提：本機那一份沒被停權 ⇒ 同步版照樣公開得出來",
  );
  exec.raw.prepare("UPDATE users SET self_ban_until = '' WHERE id = ?").run(OWNER);

  // (b) 註冊時間在 PG 是「剛剛」
  const fresh = new Date().toISOString();
  exec.raw.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(fresh, OWNER);
  const tooNew = await errorShape(() => selfAsync.publishImportedDraftListingAsync(OWNER, draftId, PUBLISH_INPUT, opts));
  assert.equal(tooNew?.status, 403);
  assert.match(String(tooNew?.message || ""), /24 小時/);
  exec.raw.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(STAMP, OWNER);

  // (c) 同時公開數：PG 上有 10 則公開中的刊登 ⇒ 擋下
  for (let i = 0; i < 10; i += 1) {
    const extra = selfListings.insertSelfDraftListing(exec.raw, OWNER, { title: `已公開 ${i}` });
    exec.raw.prepare("UPDATE listings SET self_status = 'open', self_expires_at = ? WHERE post_id = ?")
      .run("2099-01-01T00:00:00.000Z", extra.post_id);
  }
  const full = await errorShape(() => selfAsync.publishImportedDraftListingAsync(OWNER, draftId, PUBLISH_INPUT, opts));
  assert.equal(full?.status, 403, "PG 說同時上限到了就要 403");
  assert.match(String(full?.message || ""), /同時最多/);
});

test("素材所有權：只能用自己的素材（兩個 driver 相同）", async () => {
  seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  const foreign = `/media/lib/${"e".repeat(32)}.jpg`;
  exec.raw.prepare("INSERT INTO member_media(user_id, storage_key, mime, format, created_at, deleted_at) VALUES (?,?,?,?,?,NULL)")
    .run(OTHER, `${"e".repeat(32)}.jpg`, "image/jpeg", "jpg", STAMP);
  const syncErr = syncErrorShape(() => dbMod.assertOwnsMemberMediaUrls(OWNER, [foreign]));
  const asyncErr = await errorShape(() => selfAsync.assertOwnsMemberMediaUrlsAsync(OWNER, [foreign], opts));
  assert.equal(syncErr?.status, 403, "前提：同步版擋下別人的素材");
  assert.deepEqual(asyncErr, syncErr, "錯誤形狀必須相同");
  // 自己的素材（PG 有、本機沒有）也要通過
  handle().prepare("DELETE FROM member_media").run();
  assert.equal(await selfAsync.assertOwnsMemberMediaUrlsAsync(OWNER, [MEDIA_URL], opts), true, "自己的素材要通過（讀 PG）");
});

test("匯入的確認後刊登：狀態檢查與成功路徑都與同步版相同", async () => {
  const { draftId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  // 還沒確認 ⇒ 409（兩個 driver 一樣）
  exec.raw.prepare("UPDATE listing_import SET status = 'ready_for_review' WHERE id = ?").run(IMPORT_ID);
  handle().prepare("UPDATE listing_import SET status = 'ready_for_review' WHERE id = ?").run(IMPORT_ID);
  const syncErr = syncErrorShape(() => importSync.publishConfirmedImport(handle(), OWNER, IMPORT_ID, PUBLISH_INPUT, {}));
  const asyncErr = await errorShape(() => importAsync.publishConfirmedImportAsync(OWNER, IMPORT_ID, PUBLISH_INPUT, opts));
  assert.equal(syncErr?.status, 409, "前提：同步版擋下未確認的匯入");
  assert.deepEqual(asyncErr, syncErr, "錯誤形狀必須相同");

  // 確認之後：公開成功，狀態變 open
  for (const h of [handle(), exec.raw]) h.prepare("UPDATE listing_import SET status = 'confirmed' WHERE id = ?").run(IMPORT_ID);
  const published = plain(await importAsync.publishConfirmedImportAsync(OWNER, IMPORT_ID, PUBLISH_INPUT, opts));
  assert.ok(published.title, "要回公開後的刊登");
  assert.equal(exec.raw.prepare("SELECT self_status FROM listings WHERE post_id = ?").get(draftId).self_status, "open");
  // 別人的匯入 ⇒ 404
  const otherAsync = await errorShape(() => importAsync.publishConfirmedImportAsync(OTHER, IMPORT_ID, PUBLISH_INPUT, opts));
  assert.ok(otherAsync?.status === 404 || otherAsync?.status === 403, `別人的匯入要擋下（實際 ${JSON.stringify(otherAsync)}）`);
});

test("寫入是 fail-closed：strict 與預設模式都要丟，sqlite 模式不碰 exec", async () => {
  const { draftId } = seedWorld();
  const boom = async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); };
  await assert.rejects(
    () => selfAsync.publishImportedDraftListingAsync(OWNER, draftId, PUBLISH_INPUT, { ...PG, exec: boom }),
    /ECONNREFUSED/, "strict 時要往上丟",
  );
  await assert.rejects(
    () => selfAsync.publishImportedDraftListingAsync(OWNER, draftId, PUBLISH_INPUT, { driver: "postgres", exec: boom }),
    /ECONNREFUSED/, "預設模式（寫入）也不得回退本機",
  );
  let calls = 0;
  const spy = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const lite = plain(await selfAsync.publishImportedDraftListingAsync(OWNER, draftId, PUBLISH_INPUT, { driver: "sqlite", exec: spy }));
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.ok(lite.title, "sqlite 模式走同步路徑");
});

test("路由接線：兩條公開路由都用 PG 島嶼（而且真的有 import）", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const bodyOf = (needle) => {
    const start = server.indexOf(needle);
    assert.ok(start > 0, `找得到 ${needle}`);
    return server.slice(start, server.indexOf("\n});", start));
  };
  const selfPublish = bodyOf('app.post("/api/self-listings/:id/publish"');
  // R2：路由在呼叫島嶼前會先做地理編碼（`{ ...body, ...geo }`），錨點要跟著更新。
  // R3：會員自己送來的查證欄位一定要先剝掉（`stripServerVerifiedFields`），不可以原樣進島嶼。
  assert.ok(
    selfPublish.includes(
      "await publishImportedDraftListingAsync(session.userId, req.params.id, { ...stripServerVerifiedFields(body), ...geo }, {",
    ),
    "要用島嶼，而且要先剝掉會員偽造的查證欄位",
  );
  assert.ok(!selfPublish.includes("{ ...body, ...geo }"), "不得把會員的原始 body 直接送進島嶼");
  assert.ok(selfPublish.includes("await assertOwnsMemberMediaUrlsAsync(session.userId, media)"), "素材所有權要用島嶼版");
  const importPublish = bodyOf('app.post("/api/listing-imports/:id/publish"');
  assert.ok(importPublish.includes("await publishConfirmedImportAsync(session.userId, req.params.id, body, {"), "要用島嶼");
  for (const banned of ["publishOwnedDraftFor(", "publishConfirmedImportFor(", "assertOwnsMemberMediaUrls(session.userId"]) {
    assert.ok(!selfPublish.includes(banned) && !importPublish.includes(banned), `不得再用同步的 ${banned}`);
  }
  // ⚠️ 尺規的假綠風險（§82.4）：島嶼名稱必須真的被 import 進來
  for (const needle of [
    "import { publishConfirmedImportAsync } from \"./listingImportAsync.js\";",
    "import { matchCandidatesAsync } from \"./crawlerReads.js\";",
    "assertOwnsMemberMediaUrlsAsync,",
    "publishImportedDraftListingAsync,",
  ]) {
    assert.ok(server.includes(needle), `必須有 ${needle}`);
  }
});
