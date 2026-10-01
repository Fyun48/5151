// 建立並公開站內刊登（`POST /api/self-listings`）PG 島嶼的 parity（2026-09-29，第八十四批）。
//
// 同步版整條讀寫節點本機：可刊登條件（`users`）、同時公開數、草稿列、夾具 registry、
// 頭像／條件值與配對候選 ⇒ PG 模式下新刊登落在這台節點，而**站上的清單讀 PG ⇒
// 剛刊登的物件不在站上**（而且停權／註冊時間讀的是本機那一份）。
//
// 這一包釘住：兩個 driver 的落地欄位與錯誤形狀相同、**可刊登條件讀 PG**（PG 停權時同步版照樣
// 建立得出來）、冪等鍵（同鍵同內容回同一則、同鍵不同內容 409）、以及路由接線。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-create84-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

const dbMod = await import("../src/db.js");
const selfAsync = await import("../src/selfListingsAsync.js");
const selfListings = await import("../src/selfListings.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const diskPath = () => path.join(dataDir, "v3.db");
const OWNER = 840001;
const DISTRICT = "1-2";
const STAMP = "2026-01-01T00:00:00.000Z";
const MEDIA_KEY = `${"1".repeat(32)}.jpg`;
const MEDIA_URL = `/media/lib/${MEDIA_KEY}`;

const PG_ILLEGAL = [
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\bAUTOINCREMENT\b/i, "syntax error at or near \"AUTOINCREMENT\""],
];
const TABLES = [
  "users", "settings", "user_settings", "listings", "member_media", "demand_posts",
  "demand_match_districts", "demand_match_generation", "user_listing_flags",
  "self_listing_create_idempotency", "stage1_fixture_registry",
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
    const text = sql.replace(/\bIFNULL\s*\(/gi, "COALESCE(");
    try {
      // 同時滿足兩種 exec 慣例（裸陣列／`{rows}`）
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
const INPUT = {
  district: DISTRICT, street: "民生西路 100 號", rent: 28000, ping: "25", accept_pledge: true,
  body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
  floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
  title: "建立測試刊登", kind: "apartment", role: "owner", contact_name: "測試屋主",
  photos: [MEDIA_URL],
};
const shapeOf = (listing) => ({
  title: listing.title,
  price: Number(listing.price) || 0,
  price_num: Number(listing.price_num) || 0,
  floor_name: listing.floor_name,
  area_name: listing.area_name,
  kind_name: listing.kind_name,
  role_name: listing.role_name,
  contact_name: listing.contact_name,
  mobile: listing.mobile,
  self_body: listing.self_body,
  self_photos: listing.self_photos,
  self_status: listing.self_status,
  source: listing.source,
  fixture_namespace: listing.fixture_namespace,
});

function seedWorld() {
  const h = handle();
  h.prepare("DELETE FROM listings WHERE COALESCE(source, '591') = 'self'").run();
  h.prepare("DELETE FROM self_listing_create_idempotency").run();
  h.prepare("DELETE FROM member_media").run();
  h.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
    .run(OWNER, `c${OWNER}@example.test`, `會員${OWNER}`, STAMP);
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true } });
  h.prepare("INSERT INTO member_media(user_id, storage_key, mime, format, created_at, deleted_at) VALUES (?,?,?,?,?,NULL)")
    .run(OWNER, MEDIA_KEY, "image/jpeg", "jpg", STAMP);
  return { h };
}

test("建立：PG 版與同步版的落地欄位相同（狀態 open、到期日在未來）", async () => {
  seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  const sync = plain(selfListings.createSelfListing(handle(), OWNER, INPUT, new Date(), { matchCandidates: () => [] }));
  const async_ = plain(await selfAsync.createSelfListingAsync(OWNER, INPUT, opts));
  assert.deepEqual(shapeOf(async_), shapeOf(sync), "建立後的落地欄位必須逐欄位相同");
  // ⚠️ `getSelfListing()` 回的是裝飾過的視圖（不含 `self_status`）⇒ 直接查 PG 那一列。
  const row = exec.raw.prepare("SELECT self_status, self_expires_at, fixture_namespace FROM listings WHERE post_id = ?").get(async_.post_id);
  assert.equal(row.self_status, "open", "建立後就是公開狀態");
  assert.ok(Date.parse(row.self_expires_at) > Date.now(), "PG 上要有未來的到期日");
  assert.ok(!String(row.fixture_namespace || "").trim(), "一般建立不得帶夾具命名空間");
  // 本機鏡射也要有那一列（還沒搬完的讀取看的是它）
  assert.ok(handle().prepare("SELECT 1 AS n FROM listings WHERE post_id = ?").get(async_.post_id), "本機要鏡射");
});

test("參數驗證：六種錯誤的形狀與同步版逐字相同", async () => {
  const cases = [
    [{ ...INPUT, accept_pledge: false }, "沒勾聲明"],
    [{ ...INPUT, rent: 10 }, "租金不合理"],
    [{ ...INPUT, ping: "0" }, "坪數不合理"],
    [{ ...INPUT, district: "" }, "沒有行政區"],
    [{ ...INPUT, body: "短" }, "說明太短"],
    [{ ...INPUT, title: "短" }, "標題太短"],
    [{ ...INPUT, floor: 0, floor_name: "" }, "沒有樓層"],
  ];
  for (const [input, why] of cases) {
    seedWorld();
    const exec = pgFixture();
    const syncErr = syncErrorShape(() => selfListings.createSelfListing(handle(), OWNER, input, new Date(), { matchCandidates: () => [] }));
    const asyncErr = await errorShape(() => selfAsync.createSelfListingAsync(OWNER, input, { ...PG, exec }));
    assert.ok(syncErr, `前提：同步版要擋下（${why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${why}）`);
  }
});

test("可刊登條件讀 PG：PG 說停權就要 403，即使本機沒停權", async () => {
  seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  exec.raw.prepare("UPDATE users SET self_ban_until = ? WHERE id = ?").run("2099-01-01T00:00:00.000Z", OWNER);
  const asyncErr = await errorShape(() => selfAsync.createSelfListingAsync(OWNER, INPUT, opts));
  assert.equal(asyncErr?.status, 403, "PG 停權時必須 403");
  assert.match(String(asyncErr?.message || ""), /暫停上傳/);
  const sync = plain(selfListings.createSelfListing(handle(), OWNER, INPUT, new Date(), { matchCandidates: () => [] }));
  assert.ok(sync.post_id, "前提：本機沒停權 ⇒ 同步版照樣建立得出來");

  // 同時上限也要算 PG 的：把 PG 塞滿 10 則公開刊登
  exec.raw.prepare("UPDATE users SET self_ban_until = '' WHERE id = ?").run(OWNER);
  for (let i = 0; i < 10; i += 1) {
    const extra = selfListings.insertSelfDraftListing(exec.raw, OWNER, { title: `已公開 ${i}` });
    exec.raw.prepare("UPDATE listings SET self_status = 'open', self_expires_at = ? WHERE post_id = ?")
      .run("2099-01-01T00:00:00.000Z", extra.post_id);
  }
  const full = await errorShape(() => selfAsync.createSelfListingAsync(OWNER, { ...INPUT, title: "第九九九則" }, opts));
  assert.equal(full?.status, 403);
  assert.match(String(full?.message || ""), /同時最多/);
});

test("冪等鍵：同鍵同內容回同一則、同鍵不同內容 409（兩個 driver 相同）", async () => {
  seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  const key = `create-${Date.now()}`;
  const first = plain(await selfAsync.createSelfListingAsync(OWNER, { ...INPUT, idempotency_key: key }, opts));
  const again = plain(await selfAsync.createSelfListingAsync(OWNER, { ...INPUT, idempotency_key: key }, opts));
  assert.equal(Number(again.post_id), Number(first.post_id), "同鍵同內容要回同一則");
  assert.equal(
    exec.raw.prepare("SELECT COUNT(*) AS n FROM listings WHERE listed_by_user_id = ? AND self_status = 'open'").get(OWNER).n, 1,
    "PG 上不得多出第二則",
  );
  const conflict = await errorShape(() => selfAsync.createSelfListingAsync(OWNER, { ...INPUT, title: "換個標題", idempotency_key: key }, opts));
  assert.equal(conflict?.status, 409, "同鍵不同內容要 409");
  assert.equal(conflict?.code, "IDEMPOTENCY_CONFLICT");
  // 同步基準（本機自己的一份，同一組語意）
  const syncKey = `${key}-sync`;
  const syncFirst = plain(selfListings.createSelfListing(handle(), OWNER, { ...INPUT, title: "同步測試一", idempotency_key: syncKey }, new Date(), { matchCandidates: () => [] }));
  const syncAgain = plain(selfListings.createSelfListing(handle(), OWNER, { ...INPUT, title: "同步測試一", idempotency_key: syncKey }, new Date(), { matchCandidates: () => [] }));
  assert.equal(Number(syncAgain.post_id), Number(syncFirst.post_id), "前提：同步版也是同鍵回同一則");
  const syncConflict = syncErrorShape(() => selfListings.createSelfListing(handle(), OWNER, { ...INPUT, title: "同步測試二", idempotency_key: syncKey }, new Date(), { matchCandidates: () => [] }));
  assert.equal(syncConflict?.status, 409, "前提：同步版同鍵不同內容也是 409");
});

test("寫入是 fail-closed：strict 與預設模式都要丟，sqlite 模式不碰 exec", async () => {
  seedWorld();
  const boom = async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); };
  await assert.rejects(
    () => selfAsync.createSelfListingAsync(OWNER, INPUT, { ...PG, exec: boom }),
    /ECONNREFUSED/, "strict 時要往上丟",
  );
  await assert.rejects(
    () => selfAsync.createSelfListingAsync(OWNER, INPUT, { driver: "postgres", exec: boom }),
    /ECONNREFUSED/, "預設模式（寫入）也不得回退本機",
  );
  let calls = 0;
  const spy = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const lite = plain(await selfAsync.createSelfListingAsync(OWNER, INPUT, { driver: "sqlite", exec: spy }));
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.ok(lite.post_id, "sqlite 模式走同步路徑");
});

test("路由接線：建立路由用 PG 島嶼（而且真的有 import）", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const start = server.indexOf('app.post("/api/self-listings",');
  assert.ok(start > 0, "找得到建立路由");
  const body = server.slice(start, server.indexOf("\n});", start));
  // R2：路由在呼叫島嶼前會先做地理編碼（`{ ...body, ...geo }`），錨點要跟著更新。
  assert.ok(body.includes("await createSelfListingAsync(session.userId, { ...body, ...geo }, {"), "要用島嶼");
  assert.ok(body.includes("await assertOwnsMemberMediaUrlsAsync(session.userId, media)"), "素材所有權要用島嶼版");
  assert.ok(body.includes("await attributeShareAsync(req, session.userId, \"listing\")"), "分享歸因要用 async 版");
  for (const banned of ["createSelfListing(session.userId", "assertOwnsMemberMediaUrls(session.userId", "attributeShare(req,"]) {
    assert.ok(!body.includes(banned), `不得再用同步的 ${banned}`);
  }
  const importBlock = server.slice(
    Math.max(0, server.indexOf('} from "./selfListingsAsync.js";') - 500),
    server.indexOf('} from "./selfListingsAsync.js";'),
  );
  assert.ok(importBlock.includes("createSelfListingAsync"), "createSelfListingAsync 必須真的被 import");
});
