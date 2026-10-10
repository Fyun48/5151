// fold 刷新臨界點測試：寫入後「立刻讀 stored fold_*」必須等於「用最終列重算」的 fold_*。
//
// 覆蓋兩條漏斗：
//   - refreshFoldColumnsSync（SQLite better-sqlite3 handle）
//   - refreshFoldColumns（async exec，PG 島嶼的 (sql, params) => rows 形狀）
// 兩者都用同一支 computeFoldColumns 決定值，這裡只驗證「寫入 → 立刻讀 → 等於重算」，
// 以及「fold 欄缺失時錯誤向上拋（不准被吞）」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { computeFoldColumns, refreshFoldColumns, refreshFoldColumnsSync } from "../src/match.js";

function memDb({ withFoldColumns = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      price TEXT, price_num INTEGER, extra_fee INTEGER, extra_fees TEXT,
      extra_fee_text TEXT, tags TEXT, refresh_time TEXT, last_seen_at TEXT
      ${withFoldColumns ? ", fold_rent_num REAL, fold_refresh_kind INTEGER, fold_refresh_rel_ms INTEGER, fold_refresh_abs_ms INTEGER" : ""}
    )`);
  return db;
}

const ROW = {
  post_id: 12345,
  price: "25000元",
  price_num: 25000,
  extra_fee: 2000,
  extra_fees: "[]",
  extra_fee_text: "管理費2000元",
  tags: "[]",
  refresh_time: "3小時前",
  last_seen_at: "2026-09-01T00:00:00.000Z",
};

function insertListing(db, row) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => "?").join(", ");
  db.prepare(`INSERT INTO listings (${cols.join(", ")}) VALUES (${placeholders})`)
    .run(...cols.map((c) => row[c]));
}

function storedFold(db, postId) {
  return db.prepare(
    "SELECT fold_rent_num, fold_refresh_kind, fold_refresh_rel_ms, fold_refresh_abs_ms FROM listings WHERE post_id = ?",
  ).get(postId);
}

function assertFoldMatchesRecomputed(db, postId) {
  const row = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(postId);
  const fresh = computeFoldColumns(row);
  const stored = storedFold(db, postId);
  assert.ok(stored, "fold 列應存在");
  assert.equal(stored.fold_rent_num == null ? null : Number(stored.fold_rent_num), fresh.fold_rent_num, "fold_rent_num");
  assert.equal(Number(stored.fold_refresh_kind), Number(fresh.fold_refresh_kind), "fold_refresh_kind");
  assert.equal(stored.fold_refresh_rel_ms == null ? null : Number(stored.fold_refresh_rel_ms), fresh.fold_refresh_rel_ms, "fold_refresh_rel_ms");
  assert.equal(stored.fold_refresh_abs_ms == null ? null : Number(stored.fold_refresh_abs_ms), fresh.fold_refresh_abs_ms, "fold_refresh_abs_ms");
}

test("refreshFoldColumnsSync：extra_fees 變動後立刻讀，fold_rent_num 等於重算", () => {
  const db = memDb();
  insertListing(db, ROW);
  refreshFoldColumnsSync(db, 12345);
  assertFoldMatchesRecomputed(db, 12345);
  const before = storedFold(db, 12345).fold_rent_num;

  // 額外費用從 2000 變成 8000 ⇒ comparableRent（含額外費）應改變。
  db.prepare("UPDATE listings SET extra_fee = ?, extra_fee_text = ? WHERE post_id = ?").run(8000, "管理費8000元", 12345);
  refreshFoldColumnsSync(db, 12345);

  assert.notEqual(Number(storedFold(db, 12345).fold_rent_num), Number(before), "fold_rent_num 應隨 extra_fees 變動");
  assertFoldMatchesRecomputed(db, 12345);
  db.close();
});

test("refreshFoldColumnsSync：refresh_time 變動後立刻讀，fold_refresh_* 等於重算", () => {
  const db = memDb();
  insertListing(db, ROW);
  refreshFoldColumnsSync(db, 12345);
  assert.equal(Number(storedFold(db, 12345).fold_refresh_kind), 1, "相對時間 → kind=1");

  // 相對時間改成絕對時間 ⇒ kind 應變為 2、rel_ms 變 NULL、abs_ms 有值。
  db.prepare("UPDATE listings SET refresh_time = ? WHERE post_id = ?").run("2026-08-01T00:00:00.000Z", 12345);
  refreshFoldColumnsSync(db, 12345);

  assert.equal(Number(storedFold(db, 12345).fold_refresh_kind), 2, "絕對時間 → kind=2");
  assertFoldMatchesRecomputed(db, 12345);
  db.close();
});

test("refreshFoldColumns（async exec）：改完立刻讀，stored 等於重算", async () => {
  const db = memDb();
  insertListing(db, ROW);

  // PG 島嶼的 exec 形狀：async (sql, params) => rows[]。用同一顆 SQLite 當後端即可測真路徑。
  const exec = async (sql, params = []) => db.prepare(sql).all(...params);

  db.prepare("UPDATE listings SET price_num = ?, price = ? WHERE post_id = ?").run(18000, "18000元", 12345);
  const ok = await refreshFoldColumns(exec, 12345);

  assert.equal(ok, true);
  assertFoldMatchesRecomputed(db, 12345);
  db.close();
});

test("refreshFoldColumnsSync：fold 欄缺失時錯誤向上拋（由呼叫端決定 best-effort）", () => {
  const db = memDb({ withFoldColumns: false });
  insertListing(db, ROW);
  // UPDATE 提到不存在的 fold_rent_num ⇒ better-sqlite3 拋錯，不得被吞。
  assert.throws(() => refreshFoldColumnsSync(db, 12345), /no such column: fold_rent_num/);
  db.close();
});

test("refreshFoldColumns：fold 欄缺失時錯誤向上拋（由呼叫端決定 best-effort）", async () => {
  const db = memDb({ withFoldColumns: false });
  insertListing(db, ROW);
  const exec = async (sql, params = []) => db.prepare(sql).all(...params);
  await assert.rejects(() => refreshFoldColumns(exec, 12345), /no such column: fold_rent_num/);
  db.close();
});
