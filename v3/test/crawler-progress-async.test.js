// 爬蟲進度狀態（樂屋游標）與 source-kit 重試的 driver parity（2026-09-26 上線收尾）。
//
// 背景：`getRakuyaPageCursors／saveRakuyaPageCursors／markSourceKitRetry` 原本只有同步 SQLite 版本，
// PG 模式下兩個 web 節點各自在自己的 SQLite 累積抓取進度與重試排程——A 抓完的頁碼 B 讀不到，
// 造成重抓或跳頁。crawlerProgressAsync.js／crawlerWrites.js 讓 PG 分支走同一組語句。
//
// 另外釘住「PG 模式不回退 SQLite」：抓取游標是業務進度，回退會拿到別台節點的舊值。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getRakuyaPageCursorsAsync,
  mergeRakuyaPageCursors,
  parseRakuyaPageCursors,
  saveRakuyaPageCursorsAsync,
} from "../src/crawlerProgressAsync.js";
import { markSourceKitRetryAsync } from "../src/crawlerWrites.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-crawler-progress-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the file locked
  }
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE listings (post_id INTEGER PRIMARY KEY, kit_error TEXT, kit_next_retry_at TEXT);
  `);
  db.prepare("INSERT INTO listings(post_id) VALUES (?)").run(900300001);
  return db;
}

// 把 PG 的 $n 佔位符轉回 ?，讓 fixture（SQLite）當 PG 替身；SELECT 回 rows、寫入回 []。
function sqliteExec(db) {
  return async (sql, params = []) => {
    const text = String(sql).replace(/\$(\d+)/g, "?");
    const stmt = db.prepare(text);
    if (/^\s*select/i.test(text)) return stmt.all(...params);
    stmt.run(...params);
    return [];
  };
}

const options = (db) => ({ driver: "postgres", exec: sqliteExec(db) });

test("merge 規則與 db.js 相同：只收 regionId>0 且 nextPage 有限，下限夾到 2", () => {
  const merged = mergeRakuyaPageCursors({ 1: 5 }, [
    { regionId: 1, nextPage: 9 },
    { regionId: 2, nextPage: 1 },
    { regionId: 3, nextPage: 4.7 },
    { regionId: 0, nextPage: 8 },
    { regionId: 4, nextPage: "abc" },
    { regionId: 5, nextPage: Number.POSITIVE_INFINITY },
  ]);
  assert.deepEqual(merged, { 1: 9, 2: 2, 3: 4 });
});

test("壞掉的 settings 值回空物件，不讓整個抓取週期中斷", () => {
  assert.deepEqual(parseRakuyaPageCursors(undefined), {});
  assert.deepEqual(parseRakuyaPageCursors("{not json"), {});
  assert.deepEqual(parseRakuyaPageCursors('{"3":7}'), { 3: 7 });
  // 與 db.js settingKey() 相同：JSON 能解析就照原樣回傳（陣列也一樣），只有解析失敗才回空物件。
  // 不改寫這個邊界行為，兩個 driver 才會得到同一個結果。
  assert.deepEqual(parseRakuyaPageCursors("[1,2]"), [1, 2]);
});

test("PG 分支：游標讀-改-寫只更新指到的 region，其他 region 不被覆蓋", async () => {
  const db = fixture();
  const opts = options(db);
  db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("rakuyaPageCursors", JSON.stringify({ 1: 5, 2: 8 }));

  await saveRakuyaPageCursorsAsync([{ regionId: 2, nextPage: 11 }], opts);

  const stored = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = ?").get("rakuyaPageCursors").value);
  assert.deepEqual(stored, { 1: 5, 2: 11 }, "未指到的 region 必須保留（並行寫入不能被舊整份值蓋掉）");
  assert.deepEqual(await getRakuyaPageCursorsAsync(opts), { 1: 5, 2: 11 }, "讀回來要與寫入一致");
});

test("PG 分支：第一次寫入時沒有既有鍵也能建立", async () => {
  const db = fixture();
  const opts = options(db);
  await saveRakuyaPageCursorsAsync([{ regionId: 1, nextPage: 3 }], opts);
  const stored = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = ?").get("rakuyaPageCursors").value);
  assert.deepEqual(stored, { 1: 3 });
});

test("PG 模式不回退本機 SQLite：寫入失敗要往上丟，不能靜默寫別的地方", async () => {
  const failing = { driver: "postgres", exec: async () => { throw new Error("pg down"); } };
  await assert.rejects(
    () => saveRakuyaPageCursorsAsync([{ regionId: 1, nextPage: 3 }], failing),
    /pg down/,
    "抓取游標寫入失敗必須 fail-closed",
  );
  await assert.rejects(() => getRakuyaPageCursorsAsync(failing), /pg down/, "讀取失敗不得回退本機 SQLite");
});

test("PG 分支：source-kit 重試排程寫進 listings，錯誤碼截斷到 200 字元", async () => {
  const db = fixture();
  const opts = options(db);
  const longError = "x".repeat(500);
  await markSourceKitRetryAsync(900300001, { error: longError, delayMs: 60_000 }, opts);

  const row = db.prepare("SELECT kit_error, kit_next_retry_at FROM listings WHERE post_id = ?").get(900300001);
  assert.equal(row.kit_error.length, 200, "kit_error 要與 db.js 一樣截到 200 字元");
  assert.ok(Number.isFinite(Date.parse(row.kit_next_retry_at)), "kit_next_retry_at 要是可解析的時間");
  assert.ok(Date.parse(row.kit_next_retry_at) > Date.now(), "重試時間必須在未來");
});

test("PG 分支：source-kit 重試失敗也要 fail-closed", async () => {
  const failing = { driver: "postgres", exec: async () => { throw new Error("pg down"); } };
  await assert.rejects(() => markSourceKitRetryAsync(900300001, {}, failing), /pg down/);
});
