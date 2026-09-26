// F3（PR-B）：投影 kind_keys 欄位。
//
// 重點有兩個，都是「一旦做錯就會在正式站安靜出錯」的地方：
//   1. 既有表必須補上欄位（CREATE TABLE IF NOT EXISTS 不會補；production 已有 9 萬列）。
//   2. 欄位數、bind 值數與 SQL 佔位數必須一致，否則整批 upsert 失敗。
// 語意等價性另有真實資料證據：v3/scripts/kind-parity-probe.mjs（mismatch=0）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureListingSearchProjection, syncListingProjection, PROJECTION_TABLE } from "../src/listingSearchProjection.js";
import { listingKindKeys } from "../src/floors.js";

// F3 之前的實際表形狀（沒有 kind_keys），用來驗證 ALTER 遷移。
const LEGACY_DDL = `CREATE TABLE ${PROJECTION_TABLE} (
  post_id INTEGER PRIMARY KEY,
  district TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  rent INTEGER NOT NULL DEFAULT 0,
  total_monthly_cost INTEGER NOT NULL DEFAULT 0,
  area REAL,
  floor INTEGER,
  total_floors INTEGER,
  elevator INTEGER NOT NULL DEFAULT 0,
  parking INTEGER NOT NULL DEFAULT 0,
  rooftop INTEGER NOT NULL DEFAULT 0,
  low_floor INTEGER NOT NULL DEFAULT 0,
  lat REAL,
  lng REAL,
  location_class TEXT NOT NULL DEFAULT '',
  primary_listing_id INTEGER NOT NULL DEFAULT 0,
  offline_state INTEGER NOT NULL DEFAULT 0,
  commute_km REAL,
  updated_at INTEGER NOT NULL DEFAULT 0
)`;

test("listingKindKeys：輸出 ,key, 集合，且與 kind 顯示標籤分離", () => {
  const keys = listingKindKeys({ post_id: 1, kind_name: "整層住家", title: "整層住家" });
  assert.ok(keys.startsWith(",") && keys.endsWith(","), `格式錯誤：${keys}`);
  assert.ok(keys.includes(",whole,"), `缺 whole：${keys}`);
});

test("ensureListingSearchProjection：既有表會被補上 kind_keys（ALTER 遷移）", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(LEGACY_DDL);
  ensureListingSearchProjection(db);
  const columns = db.prepare(`PRAGMA table_info(${PROJECTION_TABLE})`).all().map((row) => row.name);
  assert.ok(columns.includes("kind_keys"), `未補上 kind_keys：${columns.join(",")}`);
});

test("ensureListingSearchProjection：可重複執行（idempotent）", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(LEGACY_DDL);
  ensureListingSearchProjection(db);
  ensureListingSearchProjection(db);
  const n = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?)`).get(PROJECTION_TABLE)?.n;
  assert.equal(Number(n), 21);
});

test("投影寫入：既有表補欄位後，upsert 的 21 個值寫得進去", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(LEGACY_DDL);
  ensureListingSearchProjection(db);
  syncListingProjection(db, { post_id: 7, kind_name: "整層住家", title: "整層住家", source: "591" });
  const row = db.prepare(`SELECT kind, kind_keys FROM ${PROJECTION_TABLE} WHERE post_id = 7`).get();
  assert.ok(row, "投影列未寫入");
  assert.ok(String(row.kind_keys).includes(",whole,"), `kind_keys 未寫入：${row.kind_keys}`);
});
