// 物件內頁改版 Phase 2（`/p/:id`）公開資料投影＋相似物件＋contact 遮蔽。
// 覆蓋：訪客 vs 會員 contact、404（不存在／hidden／站內關閉）、similar 租金範圍與排除自身／同屋源、
// `/p/:id` OG 字串斷言，以及 similar 的 SQLite↔注入 exec parity（無 PG 照樣綠）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  buildPublicListingDetailResponse,
  isPublicListingDetail,
  publicListingContact,
  publicListingDetailView,
  similarPublicListings,
  similarPublicListingsAsync,
} from "../src/listingDetailPublic.js";

const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

function decoratedListing(overrides = {}) {
  return {
    post_id: 5001,
    source: "591",
    title: "大安區兩房近捷運",
    price: "30000",
    price_num: 30000,
    address: "台北市大安區復興南路一段 1 號",
    area_name: "30坪",
    layout: "2房1廳1衛",
    floor_name: "5F/12F",
    kind_name: "整層住家",
    role_name: "屋主",
    cover: "https://cdn.example.com/cover.jpg",
    tags: JSON.stringify(["近捷運", "可養寵物"]),
    community_name: "復興社區",
    district: "大安區",
    furnish_items: JSON.stringify(["冷氣", "冰箱", "洗衣機"]),
    price_contain_text: "含管理費",
    extra_fees: JSON.stringify([{ name: "押金", value: "2個月" }]),
    extra_fee: 0,
    extra_fee_text: "",
    phone: "0912345678",
    mobile: "",
    line_url: "https://line.me/R/ti/p/abc",
    contact_name: "王小姐",
    self_status: null,
    hidden: 0,
    offline: 0,
    offline_confirmed: 0,
    mrt_station: "忠孝復興",
    mrt_walk_m: 450,
    photos: ["https://cdn.example.com/cover.jpg"],
    last_seen_at: "2026-10-06T10:00:00.000Z",
    refresh_time: "",
    first_seen_at: "2026-10-01T10:00:00.000Z",
    self_body: "",
    body: null,
    ...overrides,
  };
}

// ---- contact 遮蔽（D6 收斂） ----

test("publicListingContact：訪客遮蔽、登入會員才露電話／LINE／暱稱", () => {
  const listing = decoratedListing();
  const guest = publicListingContact(listing, { loggedIn: false });
  assert.deepEqual(guest, {
    masked: true, phone: null, line: null, lineUrl: null, hint: "登入會員後顯示聯絡方式",
  });

  const member = publicListingContact(listing, { loggedIn: true });
  assert.equal(member.masked, false);
  assert.equal(member.phone, "0912345678");
  assert.equal(member.lineUrl, "https://line.me/R/ti/p/abc");
  assert.equal(member.ownerNick, "王小姐");
  assert.equal(member.line, null, "外部物件沒有獨立 LINE ID 欄位，line 應為 null");
});

test("publicListingDetailView：訪客 contact 遮蔽、會員露聯絡，欄位以實際資料為準", () => {
  const guest = publicListingDetailView(decoratedListing(), 5001, { loggedIn: false });
  assert.equal(guest.contact.masked, true);
  assert.equal(guest.contact.phone, null);

  const member = publicListingDetailView(decoratedListing(), 5001, { loggedIn: true });
  assert.equal(member.contact.masked, false);
  assert.equal(member.contact.phone, "0912345678");

  // 實際拿得到的欄位
  assert.equal(member.listingId, 5001);
  assert.equal(member.source, "591");
  assert.equal(member.rent, 30000);
  assert.deepEqual(member.layout, { rooms: 2, halls: 1, baths: 1 });
  assert.equal(member.areaPing, 30);
  assert.equal(member.floor, 5);
  assert.equal(member.floorsTotal, 12);
  assert.equal(member.district, "大安區");
  assert.equal(member.community, "復興社區");
  assert.deepEqual(member.mrt, { station: "忠孝復興", walkMinutes: 6 });
  assert.deepEqual(member.photos, [{ url: "https://cdn.example.com/cover.jpg" }]);
  assert.deepEqual(member.equipment, ["冷氣", "冰箱", "洗衣機"]);
  assert.equal(member.deposit, "2個月");
  assert.ok(member.rentIncludes.includes("含管理費"));
  assert.equal(member.status, "刊登中");
  assert.equal(member.share.enabled, true);
});

test("publicListingDetailView：拿不到的欄位給 null／空陣列，不編造", () => {
  const sparse = publicListingDetailView(decoratedListing({
    title: "",
    price: "",
    price_num: 0,
    area_name: "",
    floor_name: "",
    layout: "",
    community_name: "",
    mrt_station: "",
    furnish_items: "[]",
    extra_fees: "[]",
    price_contain_text: "",
    phone: "",
    line_url: "",
    contact_name: "",
  }), 5001, { loggedIn: true });
  assert.equal(sparse.title, null);
  assert.equal(sparse.rent, null);
  assert.equal(sparse.areaPing, null);
  assert.equal(sparse.floor, null);
  assert.equal(sparse.floorsTotal, null);
  assert.equal(sparse.community, null);
  assert.equal(sparse.mrt, null);
  assert.deepEqual(sparse.equipment, []);
  assert.deepEqual(sparse.rentIncludes, []);
  assert.equal(sparse.deposit, null);
  assert.equal(sparse.contact.phone, null);
});

// ---- 404（不存在／hidden／站內關閉） ----

test("buildPublicListingDetailResponse：不存在／hidden／站內關閉回 404", () => {
  const missing = buildPublicListingDetailResponse(null, 9999);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "listing_not_found");

  const hidden = buildPublicListingDetailResponse(decoratedListing({ hidden: 1 }), 5001);
  assert.equal(hidden.status, 404);

  const selfClosed = buildPublicListingDetailResponse(decoratedListing({
    post_id: 2100000001, source: "self", self_status: "closed",
  }), 2100000001);
  assert.equal(selfClosed.status, 404);

  const selfOpen = buildPublicListingDetailResponse(decoratedListing({
    post_id: 2100000001, source: "self", self_status: "open",
  }), 2100000001);
  assert.equal(selfOpen.status, 200);

  const ok = buildPublicListingDetailResponse(decoratedListing(), 5001, { loggedIn: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.contact.masked, true);
});

// ---- similar：租金範圍、排除自身與同屋源 ----

function similarFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      source TEXT NOT NULL DEFAULT '591',
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      price TEXT,
      price_num INTEGER,
      area_name TEXT,
      cover TEXT,
      floor_name TEXT,
      layout TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      self_status TEXT,
      offline INTEGER NOT NULL DEFAULT 0,
      offline_confirmed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE listing_search_projection (
      post_id INTEGER PRIMARY KEY,
      district TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE listing_group_members (
      post_id INTEGER PRIMARY KEY,
      group_id TEXT NOT NULL
    );
  `);
  const put = (postId, { source = "591", priceNum, district = "", groupId = null, hidden = 0, selfStatus = null, title = "", cover = "", layout = "", updatedAt = 0 } = {}) => {
    db.prepare("INSERT INTO listings(post_id, source, title, url, price_num, price, area_name, cover, floor_name, layout, hidden, self_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(postId, source, title, "https://example.com", priceNum, String(priceNum), "30坪", cover, "5F/12F", layout, hidden, selfStatus);
    db.prepare("INSERT INTO listing_search_projection(post_id, district, updated_at) VALUES (?,?,?)")
      .run(postId, district, updatedAt);
    if (groupId) db.prepare("INSERT INTO listing_group_members(post_id, group_id) VALUES (?,?)").run(postId, groupId);
  };
  return { db, put };
}

test("similarPublicListings：同行政區＋租金 ±20%＋排除自身與同屋源、更新時間倒序", () => {
  const { db, put } = similarFixture();
  put(100, { priceNum: 30000, district: "大安區", title: "源物件", updatedAt: 10 });
  put(101, { priceNum: 30000, district: "大安區", title: "同區同價", updatedAt: 20 });
  put(102, { priceNum: 50000, district: "大安區", title: "超出範圍", updatedAt: 30 });
  put(103, { priceNum: 30000, district: "中正區", title: "不同區", updatedAt: 40 });
  put(104, { priceNum: 25000, district: "大安區", title: "同屋源", groupId: "g1", updatedAt: 50 });
  put(105, { priceNum: 32000, district: "大安區", title: "範圍內", updatedAt: 60 });

  // 源物件也在 g1，讓 104 與源物件同組而被排除。
  db.prepare("INSERT INTO listing_group_members(post_id, group_id) VALUES (?,?)").run(100, "g1");

  const items = similarPublicListings(db, { postId: 100, district: "大安區", rent: 30000, limit: 4 });
  const ids = items.map((item) => item.listingId);
  assert.deepEqual(ids, [105, 101], "租金範圍內、同區、非同屋源，依更新時間倒序");
  assert.ok(!ids.includes(100), "排除自身");
  assert.ok(!ids.includes(102), "租金 +66% 應排除");
  assert.ok(!ids.includes(103), "不同行政區應排除");
  assert.ok(!ids.includes(104), "同屋源群應排除");
  assert.equal(items[0].url, "/p/105");
  assert.equal(items[0].photoUrl, "");
});

test("similarPublicListings：無行政區／無租金回空陣列；查詢失敗 fail-soft 回空陣列", () => {
  const { db, put } = similarFixture();
  put(100, { priceNum: 30000, district: "大安區" });
  assert.deepEqual(similarPublicListings(db, { postId: 100, district: "", rent: 30000 }), []);
  assert.deepEqual(similarPublicListings(db, { postId: 100, district: "大安區", rent: 0 }), []);
  // 缺 table（listing_search_projection 不存在）→ 回空陣列，不拋錯
  const bare = new DatabaseSync(":memory:");
  bare.exec("CREATE TABLE listings (post_id INTEGER PRIMARY KEY, source TEXT, title TEXT, price_num INTEGER, hidden INTEGER DEFAULT 0)");
  assert.deepEqual(similarPublicListings(bare, { postId: 1, district: "大安區", rent: 30000 }), []);
});

test("similarListingsAsync：注入 exec 的 parity（SQLite 當替身，無 PG 照樣綠）", async () => {
  const { db, put } = similarFixture();
  put(100, { priceNum: 30000, district: "大安區", updatedAt: 10 });
  put(101, { priceNum: 30000, district: "大安區", updatedAt: 20 });
  db.prepare("INSERT INTO listing_group_members(post_id, group_id) VALUES (?,?)").run(100, "g1");

  const sync = similarPublicListings(db, { postId: 100, district: "大安區", rent: 30000, limit: 4 });
  const exec = async (sql, params = []) => db.prepare(sql).all(...params);
  const asyncItems = await similarPublicListingsAsync(
    { postId: 100, district: "大安區", rent: 30000, limit: 4 },
    { driver: "postgres", exec, strict: true },
  );
  assert.deepEqual(asyncItems, sync, "注入 exec 與同步版回傳逐欄相同");
  assert.deepEqual(asyncItems.map((i) => i.listingId), [101]);
});

// ---- /p/:id OG 字串斷言（照 listing-share-og.test.js 形狀） ----

test("server.js：/p/:id 讀 detail.html 快取並注入 OG meta（fail-soft 回退 listing.html）", () => {
  assert.match(server, /app\.get\("\/p\/:id", async \(req, res\)/);
  assert.match(server, /LISTING_DETAIL_TEMPLATE/);
  assert.match(server, /const template = LISTING_DETAIL_TEMPLATE \|\| LISTING_SHARE_TEMPLATE/);
  assert.match(server, /buildListingShareOgMeta\(\{ title, description, image, url: `\$\{base\}\/p\/\$\{id\}` \}\)/);
  assert.match(server, /injectListingShareMeta\(template, meta, title\)/);
  assert.match(server, /firstListingShareImage\(listing, base\)/);
});

test("server.js：/api/public/listings/:id/detail 與 /similar 已註冊、公開路徑放行 /p/", () => {
  assert.match(server, /app\.get\("\/api\/public\/listings\/:id\/detail"/);
  assert.match(server, /app\.get\("\/api\/public\/listings\/:id\/similar"/);
  const auth = readFileSync(new URL("../src/auth.js", import.meta.url), "utf8");
  assert.match(auth, /p\.startsWith\("\/p\/"\)/);
});
