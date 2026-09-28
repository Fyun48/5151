// 許願房提案（wish offers）**讀取** PG 分支的 parity（2026-09-28）。
//
// 覆蓋 `GET /api/wish-offers/:offerRef`（可見性＋投影）、`/inbox`、`/owner`（列表分頁）。
//
// 為什麼用**真實 schema** 當夾具來源：`wishOffers.js` 讀的表橫跨 demand／selfListings／
// userBlocks 三個模組（`listings` 有 80+ 欄），手寫 DDL 很容易與本尊不同步。
// 這裡改成「開一個真的 DATA_DIR 讓 `db.js` 建完整 schema，再把用到的表複製進記憶體夾具」，
// 夾具與本尊因此不可能漂移。
//
// ⚠️ `strict: true` 是必需品：讀取路徑 fail-open，PG 分支丟錯時會靜默回 SQLite 的答案，
// 那樣 parity 永遠是綠的（上一批就是這樣白測了一整輪）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-offers-async-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const demand = await import("../src/demand.js");
const selfListings = await import("../src/selfListings.js");
const offers = await import("../src/wishOffers.js");
const queries = await import("../src/wishOfferQueries.js");
const offerAsync = await import("../src/wishOffersAsync.js");
const transitions = await import("../src/wishOfferTransitions.js");
const { defaultCatalog } = await import("../src/rentalCatalog.js");

const FLAGS_ON = {
  rental_catalog_v2: { enabled: true },
  wish: { lifecycle_enabled: true, owner_matching_enabled: true, offer_enabled: true },
};
const PG = { driver: "postgres" };
const NOW = "2026-09-28T00:00:00.000Z";

const handle = () => dbMod.sqliteHandle();
const FIXTURE_TABLES = [
  "users", "listings", "demand_posts", "demand_replies", "wish_offers", "wish_offer_events",
  "user_blocks", "user_listing_flags", "demand_match_districts", "wish_room_example",
  // ⚠️ 提案建立會寫 `wish_offer_idempotency`（idempotency key 的重放保護）；
  // 少了它，夾具會在 `createWishOffer` 期間丟出 SQLite 錯誤（第一版就是這樣紅的）。
  "wish_offer_idempotency",
];

function hydrate() {
  demand.setRentalMarketplaceFlags(FLAGS_ON);
  demand.setRentalCatalogCache(defaultCatalog());
  selfListings.setSelfListingCatalog(defaultCatalog(), FLAGS_ON);
  offers.setWishOfferHydrate(defaultCatalog(), FLAGS_ON);
}

// 把磁碟上的表 DDL ＋ 資料複製進記憶體夾具（夾具因此與本尊同一個 schema）。
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

// 夾具當 PG 替身。回 { rows, rowCount }（與 crmOutboxAsync 同形狀）。
function pgExec(mem) {
  return async (sql, params = []) => {
    if (typeof sql !== "string") throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
}

// 每次測試都回到乾淨起點：清掉領域資料、重建使用者、再把磁碟鏡射進夾具。
function resetWorld() {
  const db = handle();
  for (const table of ["wish_offer_events", "wish_offers", "user_blocks", "demand_replies", "demand_posts", "wish_room_example", "user_listing_flags"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM listings WHERE COALESCE(source,'591') = 'self'").run();
  for (const id of [1, 2, 3]) {
    db.prepare(
      "INSERT OR REPLACE INTO users(id, email, nickname, role, plan, created_at, last_login_at, self_ban_until) VALUES (?,?,?,'member','free',?,NULL,NULL)",
    ).run(id, `offer${id}@example.com`, `會員${id}`, "2026-01-01T00:00:00.000Z");
  }
  hydrate();
  queries.resetWishOfferQueryCursors();
  const mem = mirrorFixture();
  copyRows(db, mem);
  return [db, mem, pgExec(mem)];
}

// 種一組「刊登 ＋ 許願房 ＋ 提案」的完整配對（用真實的領域函式，不用手寫 INSERT）。
// ⚠️ idempotency key 的格式是 `/^[A-Za-z0-9._:-]{8,128}$/`（至少 8 個字元）——
// 短鍵會在建立提案時直接 400（第一版就是這樣整排紅的）。
let keySeq = 0;
const nextKey = (prefix = "test") => `${prefix}-${String(keySeq += 1).padStart(8, "0")}`;

// 角色模型（`wishOffers.js` 的規則，roles 由資料本身決定，不是參數）：
//   - **屋主**：刊登 `listings` 的人（`listingRow.listed_by_user_id`）＝ `wish_offers.owner_user_id`
//   - **房客**：開許願房的人（`wishRow.user_id`）＝ `wish_offers.tenant_user_id`
//   - `createWishOffer(db, ownerUserId, listingRef, wishRef)` 的第二個參數是**屋主**，
//     `assertCreateOfferGates()` 會驗 `listingRow.listed_by_user_id === ownerUserId`。
// 所以：屋主刊登、房客開許願房、屋主對那則許願房提案。
// 第一版把刊登與許願房都掛在同一個人身上，就紅在「找不到這則站內刊登」。
function seedPairWithOffer(db, { listingOwnerId = 2, tenantId = 1, key = nextKey() } = {}) {
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
  // 許願房要掛在**房客**身上（`tenant_user_id` 就是這裡來的）。
  const wish = demand.createDemandPost(db, tenantId, {
    districts: ["1-8"], rent_max: 30000, housing_type: "apartment", mrt_walk: true, body: "找士林兩房",
  });
  const offer = offers.createWishOffer(db, listingOwnerId, listing.post_id, wish.public_token, { idempotencyKey: key });
  return { listing, wish, offer };
}

// ---------------------------------------------------------------------------

test("詳情：投影與同步版逐鍵相同（tenant 視角）", async () => {
  const [db, mem, exec] = resetWorld();
  const { offer } = seedPairWithOffer(db);
  copyRows(db, mem);

  // 診斷：夾具與磁碟上那筆刊登必須都在
  const listingId = offer.listing_id;
  assert.ok(mem.prepare("SELECT post_id FROM listings WHERE post_id = ?").get(listingId), `夾具必須有刊登 ${listingId}`);
  assert.ok(db.prepare("SELECT post_id FROM listings WHERE post_id = ?").get(listingId), `磁碟必須有刊登 ${listingId}`);
  // 診斷：PG 版的刊登列讀取（必經 getSelfRowAsync）必須拿得到同一列
  const selfAsync = await import("../src/selfListingsAsync.js");
  const rowFromPg = await selfAsync.getSelfRowAsync(listingId, { driver: "postgres", exec });
  assert.ok(rowFromPg, "PG loader 必須從夾具取到刊登列");
  assert.equal(Number(rowFromPg.post_id), Number(listingId));
  const syncView = offers.publicOfferView(db, offers.loadVisibleOffer(db, offer.public_token, 1), 1);
  const asyncView = await offerAsync.publicOfferViewAsync(offer, 1, {}, { ...PG, exec, strict: true });
  assert.deepEqual(asyncView, syncView, "投影必須逐鍵相同");
  assert.equal(asyncView.offer_ref, offer.public_token, "必須真的投影到（否則這條沒鑑別力）");
  assert.equal(asyncView.viewer_role, "tenant");
  assert.equal("wish_id" in asyncView, false, "不得外洩 wish_id");
});

test("詳情：owner 視角與 accepted 狀態的 actions 兩邊一致", async () => {
  const [db, mem, exec] = resetWorld();
  const { offer } = seedPairWithOffer(db);
  const accepted = transitions.acceptWishOffer(db, 1, offer.public_token, { actorKey: "tenant:1" });
  copyRows(db, mem);

  const syncOwner = offers.publicOfferView(db, accepted, 2);
  const asyncOwner = await offerAsync.publicOfferViewAsync(accepted, 2, {}, { ...PG, exec, strict: true });
  assert.deepEqual(asyncOwner, syncOwner, "owner 視角必須相同");
  assert.equal(asyncOwner.viewer_role, "owner");
  assert.equal(asyncOwner.actions.contact, true, "accepted 且未封鎖 ⇒ 可以看聯絡方式");

  const syncTenant = offers.publicOfferView(db, accepted, 1);
  const asyncTenant = await offerAsync.publicOfferViewAsync(accepted, 1, {}, { ...PG, exec, strict: true });
  assert.deepEqual(asyncTenant, syncTenant, "tenant 視角必須相同");
});

test("可見性：非當事人／不存在的 ref 必須回 null，兩邊一致", async () => {
  const [db, mem, exec] = resetWorld();
  const { offer } = seedPairWithOffer(db);
  copyRows(db, mem);
  for (const [ref, uid, why] of [
    [offer.public_token, 3, "第三人"],
    ["does-not-exist", 1, "不存在的 token"],
    ["", 1, "空字串"],
  ]) {
    const sync = offers.loadVisibleOffer(db, ref, uid);
    const async = await offerAsync.loadVisibleOfferAsync(ref, uid, { ...PG, exec, strict: true });
    assert.equal(async, sync, `可見性判斷必須相同（${why}）`);
    assert.equal(async, null, `應該是 null（${why}）`);
  }
});

test("載入：loadFreshOffer 用 id 查，兩邊一致", async () => {
  const [db, mem, exec] = resetWorld();
  const { offer } = seedPairWithOffer(db);
  copyRows(db, mem);
  const sync = offers.loadFreshOffer(db, offer.id);
  const async = await offerAsync.loadFreshOfferAsync(offer.id, { ...PG, exec, strict: true });
  assert.deepEqual(async, sync, "loadFreshOffer 必須相同");
  assert.equal(Number(async.id), Number(offer.id));
  assert.equal(await offerAsync.loadFreshOfferAsync(999999, { ...PG, exec, strict: true }), null, "不存在要回 null");
});

test("列表：inbox 與 owner 的分頁、統計、游標兩邊一致", async () => {
  const [db, mem, exec] = resetWorld();
  // 兩組獨立的配對（各自刊登／許願房／提案都自洽）：tenant 1→owner 2、tenant 3→owner 2。
  // `assertCreateOfferGates()` 要求「許願房的屋主」＝「刊登的屋主」＝ `ownerUserId`，
  // 所以每組的刊登與許願房一定要同一個人；而「同一人同一筆刊登＋同一則許願房只能有一筆
  // pending」，所以兩組要用**不同的刊登**，owner 2 才會有兩筆提案（`limit: 1` 才有第二頁
  // ——否則「LIMIT 少 1」的變異殺不掉）。
  seedPairWithOffer(db, { tenantId: 1, listingOwnerId: 2 });
  seedPairWithOffer(db, { tenantId: 3, listingOwnerId: 2 });
  copyRows(db, mem);

  // ⚠️ `next_cursor` 是**加密後**的字串（每次產生都不同 IV），所以不能直接比字串；
  // 要比的是「專案內容」與「照著各自的游標能不能走到同一頁」（同步版自己的游標走同步版、
  // PG 版走 PG 版，最後比每一頁的專案）。
  const withoutCursor = ({ next_cursor, ...rest }) => rest;
  const syncInbox = await queries.listTenantWishOffers(db, 1, { limit: 20 });
  const asyncInbox = await offerAsync.listTenantWishOffersAsync(1, { limit: 20 }, { ...PG, exec, strict: true });
  assert.deepEqual(withoutCursor(asyncInbox), withoutCursor(syncInbox), "inbox 必須逐鍵相同（游標除外）");
  assert.equal(asyncInbox.items[0].viewer_role, "tenant");
  assert.equal(asyncInbox.pending_count, syncInbox.pending_count, "pending_count 必須相同");

  const syncOwner = await queries.listOwnerWishOffers(db, 2, { limit: 20 });
  const asyncOwner = await offerAsync.listOwnerWishOffersAsync(2, { limit: 20 }, { ...PG, exec, strict: true });
  assert.deepEqual(withoutCursor(asyncOwner), withoutCursor(syncOwner), "owner 列表必須逐鍵相同（游標除外）");
  assert.equal(asyncOwner.items[0].viewer_role, "owner");
  assert.ok(asyncOwner.total >= 1, "owner 至少要有一筆（否則沒鑑別力）");

  // 游標分頁：limit 1 之後要用 next_cursor 拿下一頁，且兩邊一致
  const syncPage1 = await queries.listOwnerWishOffers(db, 2, { limit: 1 });
  const asyncPage1 = await offerAsync.listOwnerWishOffersAsync(2, { limit: 1 }, { ...PG, exec, strict: true });
  assert.deepEqual(withoutCursor(asyncPage1), withoutCursor(syncPage1), "第一頁必須相同（游標除外）");
  assert.ok(syncPage1.total >= 2, "owner 2 必須有兩筆以上，分頁才有鑑別力");
  assert.ok(syncPage1.next_cursor, "必須有 next_cursor（否則下一頁測不到）");
  const syncPage2 = await queries.listOwnerWishOffers(db, 2, { limit: 1, cursor: syncPage1.next_cursor });
  const asyncPage2 = await offerAsync.listOwnerWishOffersAsync(2, { limit: 1, cursor: asyncPage1.next_cursor }, { ...PG, exec, strict: true });
  assert.deepEqual(withoutCursor(asyncPage2), withoutCursor(syncPage2), "第二頁必須相同（各自用自己的游標）");
  assert.deepEqual(
    asyncPage2.items.map((i) => i.offer_ref),
    syncPage2.items.map((i) => i.offer_ref),
    "第二頁的專案必須相同（游標語意一致）",
  );
});

test("列表：status 篩選與空集合都要一致", async () => {
  const [db, mem, exec] = resetWorld();
  const { offer } = seedPairWithOffer(db, { tenantId: 1, listingOwnerId: 2 });
  transitions.acceptWishOffer(db, 1, offer.public_token, { actorKey: "tenant:1" });
  copyRows(db, mem);
  for (const opts of [{ status: "pending" }, { status: "accepted" }, { status: "declined" }, {}]) {
    const sync = await queries.listOwnerWishOffers(db, 2, { limit: 20, ...opts });
    const async = await offerAsync.listOwnerWishOffersAsync(2, { limit: 20, ...opts }, { ...PG, exec, strict: true });
    assert.deepEqual(async, sync, `status 篩選必須相同（${JSON.stringify(opts)}）`);
  }
  const emptySync = await queries.listTenantWishOffers(db, 3, { limit: 20 });
  const emptyAsync = await offerAsync.listTenantWishOffersAsync(3, { limit: 20 }, { ...PG, exec, strict: true });
  assert.deepEqual(emptyAsync, emptySync, "空集合必須相同");
  assert.equal(emptyAsync.items.length, 0);
  assert.equal(emptyAsync.total, 0);
});

test("寫入失敗時 fail-closed：PG 丟錯就往上丟，不得靜默回退 SQLite", async () => {
  resetWorld();
  // 一律回傳 rejected promise，且每個呼叫端都必須 await，否則會變成
  // unhandledRejection 並在下一個測試才爆（第一版就是這樣）。
  const bad = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    () => offerAsync.loadVisibleOfferAsync("tok", 1, { ...PG, exec: bad, strict: true }),
    /connection terminated/,
  );
  await assert.rejects(
    () => offerAsync.listTenantWishOffersAsync(1, { limit: 5 }, { ...PG, exec: bad, strict: true }),
    /connection terminated/,
  );
});

test("非 postgres 必須回退同步路徑（讀磁碟，而且完全不碰傳入的 exec）", async () => {
  const [db, mem, exec] = resetWorld();
  const { offer } = seedPairWithOffer(db);
  copyRows(db, mem);
  // ⚠️ 這一條一定要用「會丟錯的 exec」，否則測不出回退：夾具剛好也有同一筆資料，
  // 就算程式真的去讀夾具，回傳值也一模一樣（第一版的變異測試就是這樣 SURVIVED 的）。
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const view = await offerAsync.publicOfferViewAsync(offer, 1, {}, { driver: "sqlite", exec: boom });
  assert.equal(view.offer_ref, offer.public_token, "sqlite 模式必須讀磁碟");
  assert.equal(view.viewer_role, "tenant");
  const inbox = await offerAsync.listTenantWishOffersAsync(1, { limit: 5 }, { driver: "sqlite", exec: boom });
  assert.equal(inbox.items.length, 1, "sqlite 模式的列表必須讀磁碟");
  assert.equal(inbox.pending_count, 1, "sqlite 模式的 pending_count 必須來自磁碟");
  // ⚠️ 這一條才是真正的守衛：磁碟與夾具的資料**一模一樣**，所以只比回傳值的話，
  // 「不回退、直接走 PG 分支讀夾具」也會通過（變異測試就是這樣抓到的）。
  // 呼叫次數為 0 才證明 sqlite 模式真的沒有碰 PG runner。
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner（呼叫了就會丟錯）");
});
