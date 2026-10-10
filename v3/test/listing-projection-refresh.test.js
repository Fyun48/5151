// 投影刷新臨界點測試（D）：寫入後「立刻讀 stored 投影」必須等於「用最終列重算」的投影。
//
// 覆蓋兩條漏斗：
//   - refreshListingProjectionSync（SQLite better-sqlite3 handle）
//   - refreshListingProjection（async exec，PG 島嶼的 (sql, params) => rows 形狀）
// 兩者都用同一支 computeListingProjection 決定值，這裡只驗證「寫入 → 立刻讀 → 等於重算」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureListingSearchProjection,
  computeListingProjection,
  syncListingProjection,
  refreshListingProjection,
  refreshListingProjectionSync,
  PROJECTION_TABLE,
} from "../src/listingSearchProjection.js";

function memDb() {
  const db = new DatabaseSync(":memory:");
  ensureListingSearchProjection(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      post_id INTEGER PRIMARY KEY,
      source TEXT, source_key TEXT, title TEXT, price TEXT, price_num INTEGER,
      extra_fee INTEGER, extra_fees TEXT, extra_fee_text TEXT, address TEXT,
      area_name TEXT, floor_name TEXT, kind_name TEXT, tags TEXT,
      lat REAL, lng REAL, location_class TEXT, match_post_id INTEGER,
      offline INTEGER, commute_km REAL, route_km REAL,
      source_updated_at TEXT, source_published_at TEXT, refresh_time TEXT,
      first_seen_at TEXT, last_seen_at TEXT
    )`);
  return db;
}

const ROW = {
  post_id: 12345,
  source: "591",
  source_key: "1|8||台北市士林區測試路1號",
  title: "電梯大樓 含車位 2房",
  price: "25000元",
  price_num: 25000,
  extra_fee: 2000,
  extra_fees: "[]",
  extra_fee_text: "管理費2000元",
  address: "台北市士林區測試路1號",
  area_name: "25坪",
  floor_name: "5/12",
  kind_name: "整層住家/電梯大樓",
  tags: "[]",
  lat: 25.09,
  lng: 121.51,
  location_class: "address",
  match_post_id: 0,
  offline: 0,
  commute_km: null,
  route_km: null,
  source_updated_at: null,
  source_published_at: null,
  refresh_time: "2026-09-01T00:00:00.000Z",
  first_seen_at: "2026-09-01T00:00:00.000Z",
  last_seen_at: "2026-09-01T00:00:00.000Z",
};

function insertListing(db, row) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => "?").join(", ");
  db.prepare(`INSERT INTO listings (${cols.join(", ")}) VALUES (${placeholders})`)
    .run(...cols.map((c) => row[c]));
}

function storedProjection(db, postId) {
  return db.prepare(`SELECT * FROM ${PROJECTION_TABLE} WHERE post_id = ?`).get(postId);
}

function assertStoredMatchesRecomputed(db, postId) {
  const row = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(postId);
  const fresh = computeListingProjection(row);
  const stored = storedProjection(db, postId);
  assert.ok(stored, "投影列應存在");
  for (const col of ["district", "kind", "kind_keys", "rent", "total_monthly_cost", "area", "floor", "total_floors", "elevator", "parking", "rooftop", "low_floor", "primary_listing_id", "offline_state", "updated_at"]) {
    assert.equal(String(stored[col] ?? ""), String(fresh[col] ?? ""), `欄位 ${col} stored=${stored[col]} 應等於重算=${fresh[col]}`);
  }
}

test("refreshListingProjectionSync：match_post_id 改完立刻讀，primary_listing_id 等於重算", () => {
  const db = memDb();
  insertListing(db, ROW);
  syncListingProjection(db, ROW);
  assert.equal(storedProjection(db, 12345).primary_listing_id, 0);

  db.prepare("UPDATE listings SET match_post_id = ? WHERE post_id = ?").run(88888, 12345);
  refreshListingProjectionSync(db, 12345);

  assert.equal(storedProjection(db, 12345).primary_listing_id, 88888);
  assertStoredMatchesRecomputed(db, 12345);
  db.close();
});

test("refreshListingProjectionSync：floor_name 改完立刻讀，floor/total_floors 等於重算", () => {
  const db = memDb();
  insertListing(db, ROW);
  syncListingProjection(db, ROW);
  assert.equal(storedProjection(db, 12345).floor, 5);
  assert.equal(storedProjection(db, 12345).total_floors, 12);

  db.prepare("UPDATE listings SET floor_name = ? WHERE post_id = ?").run("3/8", 12345);
  refreshListingProjectionSync(db, 12345);

  assert.equal(storedProjection(db, 12345).floor, 3);
  assert.equal(storedProjection(db, 12345).total_floors, 8);
  assertStoredMatchesRecomputed(db, 12345);
  db.close();
});

test("refreshListingProjection（async exec）：改完立刻讀，stored 等於重算", async () => {
  const db = memDb();
  insertListing(db, ROW);
  syncListingProjection(db, ROW);

  // PG 島嶼的 exec 形狀：async (sql, params) => rows[]。用同一顆 SQLite 當後端即可測真路徑。
  const exec = async (sql, params = []) => db.prepare(sql).all(...params);

  db.prepare("UPDATE listings SET match_post_id = ? WHERE post_id = ?").run(77777, 12345);
  const ok = await refreshListingProjection(exec, 12345);

  assert.equal(ok, true);
  assert.equal(storedProjection(db, 12345).primary_listing_id, 77777);
  assertStoredMatchesRecomputed(db, 12345);
  db.close();
});

test("refreshListingProjection：投影表不存在時錯誤向上拋（由呼叫端決定 best-effort）", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE listings (post_id INTEGER PRIMARY KEY, match_post_id INTEGER, title TEXT)");
  db.prepare("INSERT INTO listings (post_id, match_post_id, title) VALUES (?, ?, ?)").run(1, 0, "x");
  const exec = async (sql, params = []) => {
    if (/listing_search_projection/.test(sql)) throw new Error("no such table: listing_search_projection");
    return db.prepare(sql).all(...params);
  };
  // SELECT * FROM listings 成功、投影 upsert 拋錯 → helper 不吞錯，交由呼叫端 try/catch（best-effort）。
  await assert.rejects(async () => refreshListingProjection(exec, 1), /no such table/);
  db.close();
});
