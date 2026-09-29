// 站內刊登的「屋主配對」讀取島嶼 parity（2026-09-29，第八十批）。
//
// 涵蓋的路由：
//   `GET /api/self-listings`                     → `listMineSelfListingsAsync`
//   `GET /api/self-listings/:id/matches/summary` → `ownerListingMatchSummaryAsync`
//
// 為什麼這一包重要：PG 模式下整條配對鏈讀的是**節點本機**——
//   - 候選許願房（`demand_posts`／`demand_match_districts`）：別的節點收到的心願完全不算，
//     「目前可能符合 N 個活躍需求」因此偏少；
//   - 自己的刊登（`listings`）：別的節點建立的刊登看不到（列表直接是空的）；
//   - 方案／角色（`listingToolsInfo` → `users`）：額度與工具開關跟著本機那一份跑。
//
// 這一包釘住：兩個 driver 的輸出**逐欄位相同**、列只放在 PG 時 PG 版照樣算得出來（同步版是空的）、
// 錯誤形狀（404 `listing_not_found`／409 `listing_not_matchable`）一致、以及路由接線。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-selfmatch80-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

const dbMod = await import("../src/db.js");
const matchAsync = await import("../src/rentalMatchAsync.js");
const selfListings = await import("../src/selfListings.js");
const demand = await import("../src/demand.js");
const catalogAsync = await import("../src/rentalCatalogAsync.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const diskPath = () => path.join(dataDir, "v3.db");
const OWNER = 800001;
const WISH_USERS = [800002, 800003, 800004];
const DISTRICT = "1-2";           // 台北市大同區
const STAMP = "2026-01-01T00:00:00.000Z";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\bAUTOINCREMENT\b/i, "syntax error at or near \"AUTOINCREMENT\""],
];
const TABLES = [
  "users", "settings", "user_settings", "listings", "demand_posts",
  "demand_match_districts", "demand_match_generation", "user_listing_flags", "demand_replies",
];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const row = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.ok(row?.sql, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(row.sql);
  }
  const copy = (table) => {
    const cols = disk.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const rows = disk.prepare(`SELECT * FROM ${table}`).all();
    const insert = mem.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const row of rows) insert.run(...cols.map((c) => row[c]));
    return rows.length;
  };
  // 順序有意義：`demand_posts` 有 FK 到 `users`（先複製 parent）。
  for (const t of ["users", "settings", "user_settings", "listings", "demand_posts", "demand_match_districts", "demand_match_generation", "user_listing_flags", "demand_replies"]) copy(t);
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

/** 用應用自己的寫入路徑種資料（列一定合法）：屋主的站內刊登 ＋ 同區許願房。 */
function seedWorld({ listings = 1, wishes = WISH_USERS.length } = {}) {
  const h = handle();
  h.prepare("DELETE FROM demand_posts").run();
  h.prepare("DELETE FROM listings WHERE COALESCE(source, '591') = 'self'").run();
  for (const uid of [OWNER, ...WISH_USERS]) {
    h.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
      .run(uid, `self${uid}@example.test`, `會員${uid}`, STAMP);
  }
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true } });
  const created = [];
  for (let i = 0; i < listings; i += 1) {
    created.push(selfListings.createSelfListing(h, OWNER, {
      district: DISTRICT, street: "民生西路 100 號", rent: 28000 + i * 1000, ping: "25", accept_pledge: true,
      body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
      floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
      title: `配對測試刊登 ${i}`, kind: "apartment", role: "owner", contact_name: "測試屋主",
    }, new Date(), { maturity: true }));
  }
  WISH_USERS.slice(0, wishes).forEach((uid, index) => {
    demand.createDemandPost(h, uid, {
      districts: [DISTRICT], rent_max: 30000 + index * 2000, layout: 2 + index,
      housing_type: "apartment", body: `配對測試需求 ${index}`,
    }, new Date(), { maturity: true });
  });
  return created;
}

test("自己的刊登：PG 版與同步版逐欄位相同（含配對摘要）", async () => {
  const created = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  dbMod.getWishConditions();
  const sync = plain(dbMod.listMineSelfListings(OWNER));
  const async_ = plain(await matchAsync.listMineSelfListingsAsync(OWNER, opts));
  assert.deepEqual(async_, sync, "自己的刊登（含 match_summary）必須逐欄位相同");
  assert.equal(async_.length, 1, "只有一則站內刊登");
  assert.equal(Number(async_[0].post_id), Number(created[0].post_id));
  assert.equal(async_[0].match_summary.enabled, true);
  assert.equal(async_[0].match_summary.count, sync[0].match_summary.count, "配對數要一致");
  assert.ok(async_[0].match_summary.count >= 1, `三則同區需求應該配得上（實際 ${async_[0].match_summary.count}）`);

  // 別人的視角：看不到（同步與 PG 版都是空陣列）
  assert.deepEqual(plain(await matchAsync.listMineSelfListingsAsync(WISH_USERS[0], opts)), []);

  // 摘要的文案（`ownerMatchSummaryFrom()` 是共用的；這一格讓「文案被拿掉」的突變殺得掉）
  assert.match(String(async_[0].match_summary.label || ""), /活躍需求/, "摘要要有可讀的文案");

  // 行政區索引被清空時要懶重建（舊資料沒有索引列）——不然帶行政區的候選查詢會是 0 筆
  exec.raw.prepare("DELETE FROM demand_match_districts").run();
  const afterRebuild = plain(await matchAsync.listMineSelfListingsAsync(OWNER, opts));
  assert.equal(
    afterRebuild[0].match_summary.count, async_[0].match_summary.count,
    "索引清空後要懶重建，配對數不得改變",
  );
  assert.ok(
    exec.raw.prepare("SELECT COUNT(DISTINCT wish_id) AS n FROM demand_match_districts").get().n > 0,
    "懶重建要真的寫回索引列",
  );
});

test("列只在 PG（別的節點建立的刊登與心願）：同步版是空的，PG 版算得出來", async () => {
  seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  dbMod.getWishConditions();
  const asyncBefore = plain(await matchAsync.listMineSelfListingsAsync(OWNER, opts));
  assert.equal(asyncBefore.length, 1);
  // 把刊登與心願都只留在 PG
  handle().prepare("DELETE FROM listings WHERE COALESCE(source, '591') = 'self'").run();
  handle().prepare("DELETE FROM demand_posts").run();
  assert.deepEqual(plain(dbMod.listMineSelfListings(OWNER)), [], "前提：同步版讀本機 ⇒ 空的");
  const asyncAfter = plain(await matchAsync.listMineSelfListingsAsync(OWNER, opts));
  assert.deepEqual(asyncAfter, asyncBefore, "PG 版必須不受本機有沒有列影響");
});

test("配對摘要：PG 版與同步版相同；別人的刊登／已關閉的刊登錯誤形狀一致", async () => {
  const created = seedWorld({ listings: 2 });
  const exec = pgFixture();
  const opts = { ...PG, exec };
  dbMod.getWishConditions();
  const postId = Number(created[0].post_id);
  const sync = plain(dbMod.ownerListingMatchSummary(postId, OWNER));
  const async_ = plain(await matchAsync.ownerListingMatchSummaryAsync(postId, OWNER, opts));
  assert.deepEqual(async_, sync, "摘要必須逐欄位相同");
  assert.ok(async_.count >= 1);

  // 別人的刊登 → 404 listing_not_found（同步與 PG 版一致）
  const otherSync = syncErrorShape(() => dbMod.ownerListingMatchSummary(postId, WISH_USERS[0]));
  const otherAsync = await errorShape(() => matchAsync.ownerListingMatchSummaryAsync(postId, WISH_USERS[0], opts));
  assert.equal(otherSync?.status, 404, "前提：同步版對別人的刊登丟 404");
  assert.deepEqual(otherAsync, otherSync, "錯誤形狀必須相同");

  // 找不到的 id → 404（同一組 code）
  const missingAsync = await errorShape(() => matchAsync.ownerListingMatchSummaryAsync(999999, OWNER, opts));
  assert.equal(missingAsync?.status, 404);
  assert.equal(missingAsync?.code, "listing_not_found");

  // 已關閉的刊登 → 409 listing_not_matchable
  handle().prepare("UPDATE listings SET self_status = 'closed' WHERE post_id = ?").run(postId);
  exec.raw.prepare("UPDATE listings SET self_status = 'closed' WHERE post_id = ?").run(postId);
  const closedSync = syncErrorShape(() => dbMod.ownerListingMatchSummary(postId, OWNER));
  const closedAsync = await errorShape(() => matchAsync.ownerListingMatchSummaryAsync(postId, OWNER, opts));
  assert.equal(closedSync?.status, 409, "前提：同步版對已關閉的刊登丟 409");
  assert.deepEqual(closedAsync, closedSync, "已關閉的錯誤形狀必須相同");
  assert.equal(closedAsync?.code, "listing_not_matchable");
});

test("工具資訊與 owner_matching：讀 PG 的方案／角色與開關（本機那一份不算）", async () => {
  seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  // 本機：member/free；PG：sponsor（模擬「方案在別的節點被改」）
  exec.raw.prepare("UPDATE users SET plan = 'sponsor' WHERE id = ?").run(OWNER);
  const syncTools = plain(dbMod.listingToolsInfo(OWNER));
  const asyncTools = plain(await matchAsync.listingToolsInfoAsync(OWNER, opts));
  // ⚠️ `listingToolsMeta()` 的輸出**不含 plan 欄位**，差別在 `description_template_limit`
  // （free 與 sponsor 不同）⇒ 要比那個數字，不要比不存在的 `plan`。
  assert.notDeepEqual(asyncTools, syncTools, "方案不同時工具資訊必須不同（證明 PG 版讀 PG）");
  assert.equal(
    asyncTools.description_template_limit, syncTools.description_template_limit_sponsor,
    "PG 版要用 PG 的 sponsor 方案",
  );
  assert.equal(
    syncTools.description_template_limit, syncTools.description_template_limit_free,
    "前提：本機那一份仍是 free",
  );

  // owner_matching：PG 的開關關掉 → PG 版要回報關閉（本機仍開著）
  await catalogAsync.saveRentalMarketplaceFlagsAsync({ wish: { owner_matching_enabled: false } }, opts);
  assert.equal((await matchAsync.rentalMatchOwnerMetaAsync(opts)).enabled, false, "PG 版要看 PG 的開關");
  assert.equal(dbMod.rentalMatchOwnerMeta().enabled, true, "前提：本機那一份仍開著");
  // 關閉時，自己的刊登不得帶配對摘要（與同步版同一個契約：`match_summary: null`）
  const listed = plain(await matchAsync.listMineSelfListingsAsync(OWNER, opts));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].match_summary, null, "配對關閉時不得附摘要");
  // ⚠️ 同步版讀的是**本機**的開關（仍開著）⇒ 它照樣回摘要；PG 版則必須 404。
  //    這一格正是「有沒有讀 PG 的開關」的鑑別力來源。
  assert.ok(
    dbMod.ownerListingMatchSummary(Number(listed[0].post_id), OWNER).count >= 0,
    "前提：同步版讀本機（仍開著）⇒ 照樣回摘要",
  );
  const closedAsync = await errorShape(() => matchAsync.ownerListingMatchSummaryAsync(Number(listed[0].post_id), OWNER, opts));
  assert.equal(closedAsync?.status, 404, "PG 版要看 PG 的開關 ⇒ 配對關閉時 404");
  assert.equal(closedAsync?.code, "owner_matching_disabled");

  // **只有 PG 關**（直接把 fixture 的設定列改成關，不動行程內快取）：PG 版必須自己去向 PG 補水；
  // 沒有補水的實作會沿用行程內那份「開」的快取而回報 enabled —— 這一格就是補水的鑑別力來源。
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true } });
  // ⚠️ `dbMod.saveRentalMarketplaceFlags()` **不會**補水到 `rentalMatchQuery` 的行程內快取，
  // 所以要用同步的 `getWishConditions()`（讀本機、會 hydrate）把快取設回「開」，
  // 這一格才驗得到「PG 版有沒有自己去向 PG 補水」。
  dbMod.getWishConditions();
  exec.raw.prepare("UPDATE settings SET value = ? WHERE key = 'rentalMarketplaceFlags'")
    .run(JSON.stringify({ wish: { owner_matching_enabled: false } }));
  assert.equal(
    (await matchAsync.rentalMatchOwnerMetaAsync(opts)).enabled, false,
    "PG 版必須向 PG 補水才看得到別的節點把開關關掉",
  );
  assert.equal(dbMod.rentalMatchOwnerMeta().enabled, true, "前提：行程內那一份仍開著");
});

test("fail-open／sqlite 模式：讀取失敗才回退，sqlite 模式不碰注入的 exec", async () => {
  seedWorld();
  dbMod.getWishConditions();
  const boom = async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); };
  await assert.rejects(
    () => matchAsync.listMineSelfListingsAsync(OWNER, { ...PG, exec: boom }),
    /ECONNREFUSED/, "strict 時要往上丟",
  );
  const fallen = plain(await matchAsync.listMineSelfListingsAsync(OWNER, { driver: "postgres", exec: boom }));
  assert.deepEqual(fallen, plain(dbMod.listMineSelfListings(OWNER)), "預設模式（讀取）允許回退同步版");

  let calls = 0;
  const spy = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const lite = plain(await matchAsync.listMineSelfListingsAsync(OWNER, { driver: "sqlite", exec: spy }));
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.deepEqual(lite, plain(dbMod.listMineSelfListings(OWNER)), "sqlite 模式走同步路徑");
});

test("路由接線：兩條站內刊登讀取路由都用 PG 島嶼", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const bodyOf = (needle) => {
    const start = server.indexOf(needle);
    assert.ok(start > 0, `找得到 ${needle}`);
    return server.slice(start, server.indexOf("\n});", start));
  };
  const list = bodyOf('app.get("/api/self-listings"');
  for (const needle of [
    "await listMineSelfListingsAsync(session.userId)",
    "await listingToolsInfoAsync(session.userId)",
    "await rentalMatchOwnerMetaAsync()",
    "await getRentalMarketplaceFlagsAsync()",
    "await getRentalCatalogAsync()",
  ]) {
    assert.ok(list.includes(needle), `自己刊登的列表要用 ${needle}`);
  }
  for (const banned of ["listMineSelfListings(session.userId)", "listingToolsInfo(session.userId)", "rentalMatchOwnerMeta()", "getRentalMarketplaceFlags()", "getRentalCatalog()"]) {
    assert.ok(!list.includes(banned), `不得再用同步的 ${banned}`);
  }
  const summary = bodyOf('app.get("/api/self-listings/:id/matches/summary"');
  assert.ok(summary.includes("await ownerListingMatchSummaryAsync(req.params.id, session.userId)"));
  assert.ok(!summary.includes("ownerListingMatchSummary(req.params.id"));
});
