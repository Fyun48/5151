// 許願房提案**建立**（`POST /api/self-listings/:id/matches/:wishRef/offers`）PG 分支的 parity
// （2026-09-29，第八十七批）。這是缺口歸零的最後一條。
//
// 為什麼這一包重要：同步版 `db.js:createWishOfferFor()` → `wishOffers.js:createWishOffer()` 把
// 刊登列（`getSelfRow`）、許願房、封鎖名單、每日上限、既有提案、冪等鍵與事件全部讀寫**節點本機**
// ⇒ PG 模式下「別的節點看得到的刊登／許願房」一律查不到（亂噴 409／429），而且提案寫進本機後
// 站上（讀 PG）看不到。
//
// 這一包釘住八件事：
//
//   1. **建立落地與投影與同步版逐鍵相同**（`publicOfferView` 那一份共用投影），而且本機不寫。
//   2. **事件與冪等鍵落地**：`wish_offer_events` 有 `offer_created`、`wish_offer_idempotency` 一列。
//   3. **冪等鍵重放回同一筆**；換目標則 409 `IDEMPOTENCY_CONFLICT`。
//   4. **已有 pending 時回既有那筆**（部分唯一索引擋併發，語意與同步版 catch UNIQUE 相同）。
//   5. **閘門**：不是自己的刊登 404 `listing_not_found`。
//   6. **每日上限讀 PG 的計數**（owner cap）。
//   7. **寫入 fail-closed**：PG 連線失敗不得回退本機。
//   8. **路由接線**：島嶼真的被 import（只刪 import 會讓量尺誤判成 PG）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-offercreate-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const demand = await import("../src/demand.js");
const selfListings = await import("../src/selfListings.js");
const offers = await import("../src/wishOffers.js");
const queries = await import("../src/wishOfferQueries.js");
const offerAsync = await import("../src/wishOffersAsync.js");
const { defaultCatalog } = await import("../src/rentalCatalog.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const FLAGS_ON = {
  rental_catalog_v2: { enabled: true },
  wish: { lifecycle_enabled: true, owner_matching_enabled: true, offer_enabled: true },
};
const PG = { driver: "postgres" };
const NOW = new Date("2026-09-29T00:00:00.000Z");
const STAMP = "2026-01-01T00:00:00.000Z";
const handle = () => dbMod.sqliteHandle();

// 夾具的表清單：`settings` 是這一包多出來的（PG 版建立提案前要先讀 PG 的旗標／目錄／
// 許願條件收斂行程內快取，＝ `db.js:hydrateRentalMarketplace()`）。
const FIXTURE_TABLES = [
  "users", "listings", "demand_posts", "demand_replies", "wish_offers", "wish_offer_events",
  "user_blocks", "user_listing_flags", "demand_match_districts", "wish_room_example",
  "wish_offer_idempotency", "wish_offer_reports", "settings",
];

function mirrorFixture() {
  const mem = new DatabaseSync(":memory:");
  const ro = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true });
  for (const table of FIXTURE_TABLES) {
    const ddl = ro.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(ddl.sql);
  }
  ro.close();
  return mem;
}

function copyRows(from, to) {
  for (const table of FIXTURE_TABLES) {
    to.prepare(`DELETE FROM ${table}`).run();
    for (const row of from.prepare(`SELECT * FROM ${table}`).all()) {
      const cols = Object.keys(row);
      to.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
        .run(...cols.map((c) => row[c]));
    }
  }
}

function pgExec(mem) {
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string") throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
  exec.raw = mem;
  return exec;
}

function resetWorld() {
  const db = handle();
  for (const table of [
    "wish_offer_reports", "wish_offer_idempotency", "wish_offer_events", "wish_offers",
    "user_blocks", "demand_replies", "demand_posts", "wish_room_example", "user_listing_flags",
  ]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* 表還不存在就算了 */ }
  }
  db.prepare("DELETE FROM listings WHERE COALESCE(source,'591') = 'self'").run();
  for (const id of [1, 2, 3]) {
    db.prepare(
      "INSERT OR REPLACE INTO users(id, email, nickname, role, plan, created_at, last_login_at, self_ban_until) VALUES (?,?,?,'member','free',?,NULL,NULL)",
    ).run(id, `offercreate${id}@example.com`, `會員${id}`, STAMP);
  }
  // 旗標要**寫進 settings**（PG 版建立時從 PG 讀）：只設行程內快取的話，
  // `getRentalCatalogAsync()` 讀到空的 setting 會把快取換成「全關」。
  dbMod.saveRentalMarketplaceFlags(FLAGS_ON);
  // ⚠️ `saveRentalMarketplaceFlags()` 只換 `setSelfListingHydrate`，**不會**動提案／目錄快取
  // （同步版的 `hydrateRentalMarketplace()` 才會六個快取一起換）⇒ 這裡要把提案快取補上，
  // 否則 `assertWishOfferEnabled()` 會直接丟「房源提案尚未開放」。
  demand.setRentalMarketplaceFlags(FLAGS_ON);
  demand.setRentalCatalogCache(defaultCatalog());
  selfListings.setSelfListingCatalog(defaultCatalog(), FLAGS_ON);
  offers.setWishOfferHydrate(defaultCatalog(), FLAGS_ON);
  queries.resetWishOfferQueryCursors();
  // 節流器是行程內記憶體：不重設的話前一個測試會把同一個 actor 的額度用完。
  offers.resetWishOfferRateLimits();
  const mem = mirrorFixture();
  copyRows(db, mem);
  return [db, mem, pgExec(mem)];
}

let keySeq = 0;
const nextKey = (prefix = "create") => `${prefix}-${String(keySeq += 1).padStart(8, "0")}`;

/** 屋主（2）刊登、房客（1）開許願房；提案由屋主發起。 */
function seedPair(db, { listingOwnerId = 2, tenantId = 1, extraListings = 0 } = {}) {
  selfListings.ensureSelfListingSchema(db);
  demand.ensureDemandSchema(db);
  offers.ensureWishOfferSchema(db);
  const listing = selfListings.createSelfListing(db, listingOwnerId, {
    district: "1-8", rent: 22000, ping: 18, kind: "whole", role: "owner", floor: 3, total_floors: 5,
    rooms: 2, living: 1, bath: 1, contact_name: "林先生", address: "中正路100號",
    phone: "0912345678", title: "士林整層可看屋", body: "近捷運、可入住、有洗衣機。",
    accept_pledge: true, traits: ["pet", "cook", "elevator"],
    listing_values: { need_pet: "allowed", need_cook: "allowed", elevator: "present" },
  });
  const others = [];
  for (let i = 0; i < extraListings; i += 1) {
    others.push(selfListings.createSelfListing(db, listingOwnerId, {
      district: "1-8", rent: 21000 + i * 100, ping: 16, kind: "whole", role: "owner", floor: 2, total_floors: 5,
      rooms: 1, living: 1, bath: 1, contact_name: "林先生", address: `中正路${200 + i}號`,
      phone: "0912345678", title: `士林第${i + 2}間`, body: "近捷運、可入住、有洗衣機。",
      accept_pledge: true, traits: ["pet", "cook", "elevator"],
      listing_values: { need_pet: "allowed", need_cook: "allowed", elevator: "present" },
    }));
  }
  const wish = demand.createDemandPost(db, tenantId, {
    districts: ["1-8"], rent_max: 30000, housing_type: "apartment", mrt_walk: true, body: "找士林兩房",
  });
  return { listing, others, wish };
}

const codeOf = async (fn) => {
  try {
    await fn();
    return "";
  } catch (e) {
    return e.code || "";
  }
};
const statusOf = async (fn) => {
  try {
    await fn();
    return 0;
  } catch (e) {
    return e.status || 0;
  }
};
const viewOf = (v) => ({ ...v, offer_ref: null });

test("PG 建立：落地與投影與同步版逐鍵相同，而且本機沒有被寫", async () => {
  const [db, mem, exec] = resetWorld();
  const { listing, wish } = seedPair(db);
  copyRows(db, mem);

  const asyncView = await offerAsync.createWishOfferAsync(2, listing.post_id, wish.public_token,
    { idempotencyKey: nextKey(), now: NOW }, { ...PG, exec, strict: true });

  // PG（夾具）落地
  const rows = mem.prepare("SELECT * FROM wish_offers").all();
  assert.equal(rows.length, 1, "PG 要有一筆提案");
  assert.equal(rows[0].status, "pending");
  assert.equal(Number(rows[0].owner_user_id), 2);
  assert.equal(Number(rows[0].tenant_user_id), 1, "tenant 要是許願房的主人");
  assert.equal(Number(rows[0].listing_id), Number(listing.post_id));
  assert.equal(Number(rows[0].wish_id), Number(wish.id));
  const events = mem.prepare("SELECT event_type FROM wish_offer_events").all().map((r) => r.event_type);
  assert.deepEqual(events, ["offer_created"]);
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offer_idempotency").get().n, 1, "冪等鍵要落地");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 0, "PG 模式不得寫本機");

  // 同步版在同一個 now 之下的投影（同步寫本機、PG 寫夾具，兩邊互不干擾）
  const syncOffer = offers.createWishOffer(db, 2, listing.post_id, wish.public_token,
    { idempotencyKey: nextKey(), now: NOW });
  const syncView = offers.publicOfferView(db, syncOffer, 2);
  assert.deepEqual(viewOf(asyncView), viewOf(syncView), "投影必須逐鍵相同（offer_ref 是隨機 token，只投影掉它）");
  assert.equal(asyncView.status, "pending");
  assert.equal(asyncView.viewer_role, "owner");
  assert.equal(asyncView.actions.withdraw, true);
  assert.equal("wish_id" in asyncView, false);
});

test("冪等鍵重放：回同一筆，PG 不長第二列", async () => {
  const [db, mem, exec] = resetWorld();
  const { listing, wish } = seedPair(db);
  copyRows(db, mem);
  const key = nextKey();

  const first = await offerAsync.createWishOfferAsync(2, listing.post_id, wish.public_token,
    { idempotencyKey: key, now: NOW }, { ...PG, exec, strict: true });
  const again = await offerAsync.createWishOfferAsync(2, listing.post_id, wish.public_token,
    { idempotencyKey: key, now: NOW }, { ...PG, exec, strict: true });

  assert.equal(again.offer_ref, first.offer_ref, "同鍵要回同一筆（同一個 public_token）");
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 1);
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offer_events").get().n, 1, "重放不得再寫事件");
});

test("冪等鍵換目標 → 409 IDEMPOTENCY_CONFLICT", async () => {
  const [db, mem, exec] = resetWorld();
  const { listing, others, wish } = seedPair(db, { extraListings: 1 });
  // ⚠️ 許願房是「一人同時只能有一則公開的」⇒ 第二則要掛在**別的房客**身上（3 號）。
  const otherWish = demand.createDemandPost(db, 3, {
    districts: ["1-8"], rent_max: 26000, housing_type: "apartment", mrt_walk: true, body: "另一則需求內容",
  });
  copyRows(db, mem);
  const key = nextKey();

  await offerAsync.createWishOfferAsync(2, listing.post_id, wish.public_token,
    { idempotencyKey: key, now: NOW }, { ...PG, exec, strict: true });
  assert.equal(await codeOf(() => offerAsync.createWishOfferAsync(2, others[0].post_id, wish.public_token,
    { idempotencyKey: key, now: NOW }, { ...PG, exec, strict: true })), "IDEMPOTENCY_CONFLICT", "換刊登要衝突");
  assert.equal(await codeOf(() => offerAsync.createWishOfferAsync(2, listing.post_id, otherWish.public_token,
    { idempotencyKey: key, now: NOW }, { ...PG, exec, strict: true })), "IDEMPOTENCY_CONFLICT", "換許願房要衝突");
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 1);
});

test("已有 pending → 回既有那筆（PG 不多一筆提案）", async () => {
  const [db, mem, exec] = resetWorld();
  const { listing, wish } = seedPair(db);
  const existing = offers.createWishOffer(db, 2, listing.post_id, wish.public_token,
    { idempotencyKey: nextKey(), now: NOW });
  copyRows(db, mem);
  const eventsBefore = mem.prepare("SELECT COUNT(*) AS n FROM wish_offer_events").get().n;

  const again = await offerAsync.createWishOfferAsync(2, listing.post_id, wish.public_token,
    { idempotencyKey: nextKey(), now: NOW }, { ...PG, exec, strict: true });

  assert.equal(again.offer_ref, existing.public_token, "要回既有那一筆");
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 1, "不得多一筆提案");
  // ⚠️ 事件**會**多一筆：同步版在「回既有那筆」的分支之後也是無條件寫 `offer_created`，
  // 島嶼版刻意不擅自改成「只有新建才寫」（parity 優先）。這裡驗的是「多一筆事件、零筆提案」。
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offer_events").get().n, eventsBefore + 1);
});

test("閘門：不是自己的刊登 → 404 listing_not_found（PG 不落列）", async () => {
  const [db, mem, exec] = resetWorld();
  const { listing, wish } = seedPair(db);
  copyRows(db, mem);
  // 1 號會員不是這則刊登的屋主
  assert.equal(await statusOf(() => offerAsync.createWishOfferAsync(1, listing.post_id, wish.public_token,
    { idempotencyKey: nextKey(), now: NOW }, { ...PG, exec, strict: true })), 404);
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 0);

  // 許願房 token 不存在時是 409 match_no_longer_eligible（同步版同一條）
  assert.equal(await codeOf(() => offerAsync.createWishOfferAsync(2, listing.post_id, "missingwishtoken",
    { idempotencyKey: nextKey(), now: NOW }, { ...PG, exec, strict: true })), "match_no_longer_eligible");
});

test("閘門：屋主被停權 → 409 offer_unavailable（PG 不落列）", async () => {
  const [db, mem, exec] = resetWorld();
  const { listing, wish } = seedPair(db);
  // 停權時間讀的是 PG 的 `users.self_ban_until`（同步版讀本機那份）。
  const future = "2099-01-01T00:00:00.000Z";
  db.prepare("UPDATE users SET self_ban_until = ? WHERE id = 2").run(future);
  copyRows(db, mem);
  mem.prepare("UPDATE users SET self_ban_until = ? WHERE id = 2").run(future);

  assert.equal(await codeOf(() => offerAsync.createWishOfferAsync(2, listing.post_id, wish.public_token,
    { idempotencyKey: nextKey(), now: NOW }, { ...PG, exec, strict: true })), "offer_unavailable");
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 0);
});

test("閘門：刊登已下架 → 409 match_no_longer_eligible（PG 不落列）", async () => {
  const [db, mem, exec] = resetWorld();
  const { listing, wish } = seedPair(db);
  copyRows(db, mem);
  // 只把 PG（夾具）那一份改成已下架：PG 讀得到、本機那份還是 open
  // ⇒「配對資格讀 PG」才驗得出來。
  mem.prepare("UPDATE listings SET self_status = 'closed' WHERE post_id = ?").run(listing.post_id);
  assert.equal(mem.prepare("SELECT self_status FROM listings WHERE post_id = ?").get(listing.post_id).self_status, "closed");

  assert.equal(await codeOf(() => offerAsync.createWishOfferAsync(2, listing.post_id, wish.public_token,
    { idempotencyKey: nextKey(), now: NOW }, { ...PG, exec, strict: true })), "match_no_longer_eligible");
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 0);
});

test("建立前會把 PG 的旗標／目錄收斂進行程內快取（不拿本機過期的那一份判斷）", async () => {
  const [db, mem, exec] = resetWorld();
  const { listing, wish } = seedPair(db);
  copyRows(db, mem);
  // PG settings 是 `FLAGS_ON`（`resetWorld()` 寫的）；行程內刻意留一組**可辨識的舊值**。
  // ⚠️ `saveRentalMarketplaceFlags()` 只換 self-listing 快取，所以這裡直接把提案快取
  // 換成舊值——正是「PG 站重啟後行程內快取還沒收斂」的那個狀態。
  const STALE = { ...FLAGS_ON, wish: { ...FLAGS_ON.wish, digest_enabled: true, public_share_v2_enabled: true } };
  demand.setRentalMarketplaceFlags(STALE);
  offers.setWishOfferHydrate(defaultCatalog(), STALE);
  assert.equal(offers.currentOfferFlags().wish.digest_enabled, true, "前提：行程內快取是舊的");

  await offerAsync.createWishOfferAsync(2, listing.post_id, wish.public_token,
    { idempotencyKey: nextKey(), now: NOW }, { ...PG, exec, strict: true });

  assert.equal(offers.currentOfferFlags().wish.digest_enabled, false,
    "PG 的旗標要蓋掉行程內那一份（沒收斂的話這裡還是舊值 true）");
  assert.equal(demand.currentRentalMarketplaceFlags().wish.public_share_v2_enabled, false, "市場旗標也要收斂");
});

test("每日上限讀 PG 的計數：屋主上限 → 429 RATE_LIMITED", async () => {
  const [db, mem, exec] = resetWorld();
  const { listing } = seedPair(db);
  // 直接在磁碟種 8 筆（＝ OFFER_OWNER_DAILY_CAP）別筆提案，再鏡射進夾具。
  const extraListings = [];
  for (let i = 0; i < offers.OFFER_OWNER_DAILY_CAP; i += 1) {
    const tenantId = 10 + i;
    db.prepare("INSERT OR REPLACE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
      .run(tenantId, `captenant${i}@example.com`, `房客${i}`, STAMP);
    const wish = demand.createDemandPost(db, tenantId, {
      districts: ["1-8"], rent_max: 30000, housing_type: "apartment", mrt_walk: true, body: `找房需求內容${i}`,
    });
    const other = selfListings.createSelfListing(db, 2, {
      district: "1-8", rent: 20000 + i, ping: 15, kind: "whole", role: "owner", floor: 2, total_floors: 5,
      rooms: 1, living: 1, bath: 1, contact_name: "林先生", address: `上限路${i}號`,
      phone: "0912345678", title: `上限測試房${i}`, body: "近捷運、可入住、有洗衣機。",
      accept_pledge: true, traits: ["pet", "cook", "elevator"],
      listing_values: { need_pet: "allowed", need_cook: "allowed", elevator: "present" },
    });
    extraListings.push(other);
    offers.createWishOffer(db, 2, other.post_id, wish.public_token, { idempotencyKey: nextKey(), now: NOW });
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wish_offers WHERE owner_user_id = 2").get().n,
    offers.OFFER_OWNER_DAILY_CAP, "前提：磁碟上剛好到達上限");
  db.prepare("INSERT OR REPLACE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
    .run(99, "capping@example.com", "上限房客", STAMP);
  const freshWish = demand.createDemandPost(db, 99, {
    districts: ["1-8"], rent_max: 30000, housing_type: "apartment", mrt_walk: true, body: "最後一則需求內容",
  });
  copyRows(db, mem);

  const err = await codeOf(() => offerAsync.createWishOfferAsync(2, listing.post_id, freshWish.public_token,
    { idempotencyKey: nextKey(), now: NOW }, { ...PG, exec, strict: true }));
  assert.equal(err, "RATE_LIMITED", "上限要讀 PG 的計數（讀本機替身才對的話這條會過，讀不到就會建出第 9 筆）");
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offers WHERE owner_user_id = 2").get().n,
    offers.OFFER_OWNER_DAILY_CAP, "PG 不得多出第 9 筆");
});

test("寫入 fail-closed：PG 連線失敗不得回退本機", async () => {
  const [db, mem, exec] = resetWorld();
  const { listing, wish } = seedPair(db);
  copyRows(db, mem);
  const boom = async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); };
  await assert.rejects(
    () => offerAsync.createWishOfferAsync(2, listing.post_id, wish.public_token,
      { idempotencyKey: nextKey(), now: NOW }, { ...PG, exec: boom, strict: true }),
    /ECONNREFUSED/, "strict 時要往上丟",
  );
  await assert.rejects(
    () => offerAsync.createWishOfferAsync(2, listing.post_id, wish.public_token,
      { idempotencyKey: nextKey(), now: NOW }, { driver: "postgres", exec: boom }),
    /ECONNREFUSED/, "預設模式（寫入）也不得回退本機",
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 0, "本機不得留下提案");
  assert.equal(mem.prepare("SELECT COUNT(*) AS n FROM wish_offers").get().n, 0);
});

test("路由接線：提案路由改走 PG 島嶼（而且島嶼真的有 import）", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const start = server.indexOf('app.post("/api/self-listings/:id/matches/:wishRef/offers"');
  assert.ok(start > 0, "找得到提案路由");
  const body = server.slice(start, server.indexOf('app.get("/api/rental-notify/prefs"', start));
  assert.ok(body.includes("await createWishOfferAsync(session.userId, req.params.id, req.params.wishRef, {"), "要用島嶼版");
  assert.ok(body.includes('await attributeShareAsync(req, session.userId, "offer")'), "分享歸因要用 async 版");
  assert.ok(!body.includes("createWishOfferFor("), "不得再用同步的 createWishOfferFor");
  assert.ok(!body.includes("attributeShare(req,"), "不得再用同步的 attributeShare");
  const importBlock = server.slice(
    Math.max(0, server.lastIndexOf('} from "./wishOffersAsync.js";') - 500),
    server.lastIndexOf('} from "./wishOffersAsync.js";'),
  );
  assert.ok(importBlock.includes("createWishOfferAsync"), "createWishOfferAsync 必須真的被 import");
  assert.ok(!server.includes("  createWishOfferFor,\n"), "同步的 createWishOfferFor 不該再被 import");
});
