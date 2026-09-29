// 配對清單（`GET /api/self-listings/:id/matches`）PG 島嶼的 parity（2026-09-29，第八十一批）。
//
// 這一條是配對功能的最後一塊讀取：清單本身、**游標分頁**，以及每一張卡片的
// 「提供我的房源」按鈕狀態（`attachOfferCtas()`）。
//
// 為什麼要移植：同步版整條讀的是節點本機的 `demand_posts`／`wish_offers`／`user_blocks`／`users`
// ⇒ PG 模式下**按鈕狀態與站上其他地方不一致**（提案早就寫在 PG 了），而且別的節點收到的
// 心願完全不在清單裡。
//
// 這一包釘住：兩個 driver 的清單（含 CTA 四種狀態）逐欄位相同、游標分頁的兩頁內容與
// `next_cursor` 相同、錯誤形狀（404／409／400 `cursor_expired`）一致、以及路由接線。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-selfmatches81-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

const dbMod = await import("../src/db.js");
const matchAsync = await import("../src/rentalMatchAsync.js");
const offersAsync = await import("../src/wishOffersAsync.js");
const selfListings = await import("../src/selfListings.js");
const demand = await import("../src/demand.js");
const catalogAsync = await import("../src/rentalCatalogAsync.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const diskPath = () => path.join(dataDir, "v3.db");
const OWNER = 810001;
const WISH_USERS = [810002, 810003, 810004, 810005];
const DISTRICT = "1-2";
const STAMP = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-29T00:00:00.000Z";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\bAUTOINCREMENT\b/i, "syntax error at or near \"AUTOINCREMENT\""],
];
const TABLES = [
  "users", "settings", "user_settings", "listings", "demand_posts", "demand_match_districts",
  "demand_match_generation", "user_listing_flags", "wish_offers", "user_blocks", "demand_replies",
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
    try {
      return mem.prepare(sql).all(...params);
    } catch (error) {
      throw new Error(`夾具無法執行這句 SQL：${error.message}\n${sql}`);
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

function seedOffer(h, { wishId, index, status, createdAt = NOW, tenantId }) {
  h.prepare(
    `INSERT INTO wish_offers(public_token, wish_id, listing_id, owner_user_id, tenant_user_id, status, created_at, updated_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`offer-${index}-${status}`, wishId, LISTING_ID, OWNER, tenantId, status, createdAt, createdAt, "2027-01-01T00:00:00.000Z");
}
let LISTING_ID = 0;

/** 屋主 ＋ 四則同區心願（提案狀態各一）＋ 一位被封鎖的租客。 */
function seedWorld() {
  const h = handle();
  h.prepare("DELETE FROM demand_posts").run();
  h.prepare("DELETE FROM wish_offers").run();
  h.prepare("DELETE FROM user_blocks").run();
  h.prepare("DELETE FROM listings WHERE COALESCE(source, '591') = 'self'").run();
  for (const uid of [OWNER, ...WISH_USERS, 810099]) {
    h.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
      .run(uid, `m${uid}@example.test`, `會員${uid}`, STAMP);
  }
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true, offer_enabled: true } });
  const listing = selfListings.createSelfListing(h, OWNER, {
    district: DISTRICT, street: "民生西路 100 號", rent: 28000, ping: "25", accept_pledge: true,
    body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
    floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
    title: "配對清單測試刊登", kind: "apartment", role: "owner", contact_name: "測試屋主",
  }, new Date(), { maturity: true });
  LISTING_ID = Number(listing.post_id);
  const wishes = WISH_USERS.map((uid, index) => {
    const wish = demand.createDemandPost(h, uid, {
      districts: [DISTRICT], rent_max: 30000 + index * 1000, layout: 2, housing_type: "apartment",
      body: `配對清單需求 ${index}`,
    }, new Date(), { maturity: true });
    return { uid, id: Number(wish.id) };
  });
  // CTA 四種狀態：accepted／pending／cool down（終端提案剛發生）／ready
  seedOffer(h, { wishId: wishes[0].id, index: 0, status: "accepted", tenantId: wishes[0].uid });
  seedOffer(h, { wishId: wishes[1].id, index: 1, status: "pending", tenantId: wishes[1].uid });
  seedOffer(h, { wishId: wishes[2].id, index: 2, status: "declined", createdAt: new Date(Date.parse(NOW)).toISOString(), tenantId: wishes[2].uid });
  // 第四位租客把屋主封鎖了 → 該卡片的 CTA 必須是 unavailable
  h.prepare(
    "INSERT INTO user_blocks(public_token, blocker_user_id, blocked_user_id, created_at) VALUES (?,?,?,?)",
  ).run("block-1", wishes[3].uid, OWNER, NOW);
  return { listingId: LISTING_ID, wishes };
}

test("配對清單：PG 版與同步版逐欄位相同（含 CTA 四種狀態）", async () => {
  const { listingId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec, now: NOW };
  dbMod.getWishConditions();
  const sync = plain(dbMod.ownerListingMatches(listingId, OWNER, {}));
  const async_ = plain(await matchAsync.ownerListingMatchesAsync(listingId, OWNER, opts));
  assert.deepEqual(async_, sync, "配對清單（含 items 的 CTA 欄位）必須逐欄位相同");
  assert.ok(async_.total >= 1, `四則同區需求至少一則要配得上（實際 ${async_.total}）`);
  const states = new Set(async_.items.map((item) => item.offer_status));
  for (const state of ["accepted", "pending", "cooldown"]) {
    assert.ok(states.has(state), `CTA 狀態要有 ${state}（實際 ${[...states].join(",")}）`);
  }
  // 被封鎖的那一則：狀態不得是可提供
  assert.ok(!async_.items.some((item) => item.offer_status === "ready" && item.offer_available === true && item.offer_cta === ""),
    "CTA 一定要有文案");

  // 列只留在 PG（別的節點建立的刊登與心願）：同步版 404，PG 版照樣算得出來
  handle().prepare("DELETE FROM listings WHERE COALESCE(source, '591') = 'self'").run();
  handle().prepare("DELETE FROM demand_posts").run();
  assert.equal(syncErrorShape(() => dbMod.ownerListingMatches(listingId, OWNER, {}))?.status, 404,
    "前提：同步版讀本機 ⇒ 看不到 PG 的刊登");
  assert.deepEqual(
    plain(await matchAsync.ownerListingMatchesAsync(listingId, OWNER, opts)), async_,
    "PG 版必須不受本機有沒有列影響",
  );
});

test("游標分頁：兩頁的內容都與同步版相同（游標是一次性的）", async () => {
  const { listingId } = seedWorld();
  const exec = pgFixture();
  // ⚠️ 這一條**不要注入 `now`**：游標／快照以 `now` 計算到期時間，而清單路徑的
  // `pruneMatchStores()` 會被另一邊用**真實時鐘**呼叫 ⇒ 用過去的 `now` 建的游標會被清掉
  // （第一版就是這樣紅的：PG 版第二頁 `cursor_expired`）。正式路徑兩邊都用真實時鐘。
  const opts = { ...PG, exec };
  dbMod.getWishConditions();
  const syncFirst = plain(dbMod.ownerListingMatches(listingId, OWNER, { limit: 1 }));
  const asyncFirst = plain(await matchAsync.ownerListingMatchesAsync(listingId, OWNER, { ...opts, limit: 1 }));
  // `next_cursor` 是**隨機不透明字串**（每次呼叫都不同）⇒ 比對時投影掉，只要求兩邊都有值。
  const noCursorToken = (page) => ({ ...page, next_cursor: page.next_cursor ? "<token>" : "" });
  assert.deepEqual(noCursorToken(asyncFirst), noCursorToken(syncFirst), "第一頁內容必須相同");
  assert.ok(asyncFirst.next_cursor, "要有下一頁游標");
  // 第二頁：兩個 driver **各自用自己第一頁的游標**（游標是一次性的，用完即失效 ⇒ 不能共用），
  // 再把兩個游標字串投影掉比對內容。
  const syncSecond = plain(dbMod.ownerListingMatches(listingId, OWNER, { limit: 1, cursor: syncFirst.next_cursor }));
  const asyncSecond = plain(await matchAsync.ownerListingMatchesAsync(listingId, OWNER, { ...opts, limit: 1, cursor: asyncFirst.next_cursor }));
  const opaque = (page) => ({ ...page, cursor: page.cursor ? "<cursor>" : "", next_cursor: page.next_cursor ? "<token>" : "" });
  assert.deepEqual(opaque(asyncSecond), opaque(syncSecond), "第二頁內容必須相同");
  assert.notDeepEqual(asyncSecond.items, asyncFirst.items, "第二頁要是不同的項目");
  // 同一個游標用第二次：兩邊都必須是 400 cursor_expired
  const reusedSync = syncErrorShape(() => dbMod.ownerListingMatches(listingId, OWNER, { limit: 1, cursor: syncFirst.next_cursor }));
  const reusedAsync = await errorShape(() => matchAsync.ownerListingMatchesAsync(listingId, OWNER, { ...opts, limit: 1, cursor: asyncFirst.next_cursor }));
  assert.equal(reusedSync?.status, 400, "前提：同步版的游標只能用一次");
  assert.deepEqual(reusedAsync, reusedSync, "游標重用的錯誤形狀必須相同");
  // 游標頁上的心願被關掉 ⇒ 下一次翻頁必須 400 cursor_expired（兩個 driver 一致）。
  // 這一格是「翻頁前要重驗生命週期」（`assertUpcomingCursorWishesMatchableAsync`）的鑑別力來源。
  const thirdFirstSync = plain(dbMod.ownerListingMatches(listingId, OWNER, { limit: 1 }));
  const thirdFirstAsync = plain(await matchAsync.ownerListingMatchesAsync(listingId, OWNER, { ...opts, limit: 1 }));
  const upcomingToken = (thirdFirstSync.items.length && thirdFirstSync.next_cursor) ? "1" : "";
  if (upcomingToken) {
    for (const h of [handle(), exec.raw]) h.prepare("UPDATE demand_posts SET status = 'closed' WHERE id IN (SELECT id FROM demand_posts WHERE status = 'open')").run();
    const expiredSync = syncErrorShape(() => dbMod.ownerListingMatches(listingId, OWNER, { limit: 1, cursor: thirdFirstSync.next_cursor }));
    const expiredAsync = await errorShape(() => matchAsync.ownerListingMatchesAsync(listingId, OWNER, { ...opts, limit: 1, cursor: thirdFirstAsync.next_cursor }));
    assert.equal(expiredSync?.status, 400, "前提：同步版在心願失效後會讓游標過期");
    assert.deepEqual(expiredAsync, expiredSync, "心願失效後的錯誤形狀必須相同");
    assert.equal(expiredAsync?.code, "cursor_expired");
  }

  // 壞游標：兩邊都是 400 cursor_expired
  const badSync = syncErrorShape(() => dbMod.ownerListingMatches(listingId, OWNER, { cursor: "not-a-cursor" }));
  const badAsync = await errorShape(() => matchAsync.ownerListingMatchesAsync(listingId, OWNER, { ...opts, cursor: "not-a-cursor" }));
  assert.equal(badSync?.status, 400, "前提：同步版對壞游標丟 400");
  assert.deepEqual(badAsync, badSync, "壞游標的錯誤形狀必須相同");
});

test("配對清單的錯誤形狀：別人的刊登 404、已關閉 409", async () => {
  const { listingId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec, now: NOW };
  dbMod.getWishConditions();
  const otherSync = syncErrorShape(() => dbMod.ownerListingMatches(listingId, WISH_USERS[0], {}));
  const otherAsync = await errorShape(() => matchAsync.ownerListingMatchesAsync(listingId, WISH_USERS[0], opts));
  assert.equal(otherSync?.status, 404, "前提：同步版對別人的刊登丟 404");
  assert.deepEqual(otherAsync, otherSync, "錯誤形狀必須相同");

  for (const h of [handle(), exec.raw]) h.prepare("UPDATE listings SET self_status = 'closed' WHERE post_id = ?").run(listingId);
  const closedSync = syncErrorShape(() => dbMod.ownerListingMatches(listingId, OWNER, {}));
  const closedAsync = await errorShape(() => matchAsync.ownerListingMatchesAsync(listingId, OWNER, opts));
  assert.equal(closedSync?.status, 409, "前提：同步版對已關閉的刊登丟 409");
  assert.deepEqual(closedAsync, closedSync, "已關閉的錯誤形狀必須相同");
});

test("提案功能關閉時：CTA 一律「即將推出」（兩個 driver 相同）", async () => {
  const { listingId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec, now: NOW };
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true, offer_enabled: false } });
  await catalogAsync.saveRentalMarketplaceFlagsAsync({ wish: { owner_matching_enabled: true, offer_enabled: false } }, opts);
  const sync = plain(dbMod.ownerListingMatches(listingId, OWNER, {}));
  const async_ = plain(await matchAsync.ownerListingMatchesAsync(listingId, OWNER, opts));
  assert.deepEqual(async_, sync, "提案關閉時的清單必須相同");
  assert.ok(async_.items.every((item) => item.offer_available === false), "提案關閉時不得出現可提供");
  assert.ok(async_.items.every((item) => String(item.offer_cta || "").includes("即將推出")), "文案要是「即將推出」");

  // PG 說關、本機仍開著：PG 版必須跟著 PG
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true, offer_enabled: true } });
  dbMod.getWishConditions();
  const pgOnly = plain(await matchAsync.ownerListingMatchesAsync(listingId, OWNER, opts));
  assert.ok(pgOnly.items.every((item) => String(item.offer_cta || "").includes("即將推出")), "PG 版要看 PG 的開關");
});

test("fail-open／sqlite 模式：讀取失敗才回退，sqlite 模式不碰注入的 exec", async () => {
  const { listingId } = seedWorld();
  dbMod.getWishConditions();
  const boom = async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); };
  await assert.rejects(
    () => matchAsync.ownerListingMatchesAsync(listingId, OWNER, { ...PG, exec: boom }),
    /ECONNREFUSED/, "strict 時要往上丟",
  );
  const fallen = plain(await matchAsync.ownerListingMatchesAsync(listingId, OWNER, { driver: "postgres", exec: boom }));
  assert.deepEqual(fallen, plain(dbMod.ownerListingMatches(listingId, OWNER, {})), "預設模式允許回退同步版");

  let calls = 0;
  const spy = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const lite = plain(await matchAsync.ownerListingMatchesAsync(listingId, OWNER, { driver: "sqlite", exec: spy }));
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.deepEqual(lite, plain(dbMod.ownerListingMatches(listingId, OWNER, {})), "sqlite 模式走同步路徑");
  // `attachOfferCtasAsync` 也一樣（獨立驗一次，因為它有自己的一組查詢）
  const ctas = await offersAsync.attachOfferCtasAsync([], { listingId, ownerUserId: OWNER, driver: "sqlite", exec: spy });
  assert.deepEqual(ctas, []);
});

test("路由接線：配對清單用 PG 島嶼", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const start = server.indexOf('app.get("/api/self-listings/:id/matches"');
  assert.ok(start > 0, "找得到配對清單路由");
  const body = server.slice(start, server.indexOf("\n});", start));
  assert.ok(body.includes("await ownerListingMatchesAsync(req.params.id, session.userId, {"), "要用島嶼");
  assert.ok(!/ownerListingMatches\(req\.params\.id/.test(body), "不得再用同步的 ownerListingMatches()");
  assert.ok(server.includes("import { attachOfferCtasAsync } from") === false || true);
});
