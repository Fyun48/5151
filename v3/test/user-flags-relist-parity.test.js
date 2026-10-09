// 重刊旗標複製（copyUserFlags）的 driver parity。
//
// watcher.js 在同一物件「重新刊登」時，把舊 post_id 的會員旗標（viewed／watched／hidden／
// watch_note）複製到新 post_id。原本只走 db.js copyUserFlags() → personalFlags.copyUserFlagsForRelist(db, …)，
// `db` 是節點本機 SQLite handle；正式站 DB_DRIVER=postgres 時站上讀 PG ⇒ 這筆寫入落在沒人讀的本機庫
// （無聲孤島寫入）。這裡釘住 async 入口在兩個 driver 上與同步版等價，並確認 watcher 已改呼叫 async 版。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-relist-flags-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const app = await import("../src/db.js");
const flagsAsync = await import("../src/personalFlagsAsync.js");
const { ensurePersonalSchema } = await import("../src/personalSchema.js");

const db = app.sqliteHandle();
ensurePersonalSchema(db);

const FROM_POST = 900001;
const TO_POST = 900002;

// 5 個會員：hidden＋watched、只 viewed、只 watched、只 watch_note、什麼都沒有（不複製）。
const SOURCE_ROWS = [
  [1, FROM_POST, 0, 1, 1, "hidden+watched", "2026-10-08T01:00:00.000Z", "2026-10-08T01:00:00.000Z", "2026-10-08T01:00:00.000Z"],
  [2, FROM_POST, 1, 0, 0, "", "2026-10-08T02:00:00.000Z", null, null],
  [3, FROM_POST, 0, 1, 0, "watched only", null, "2026-10-08T03:00:00.000Z", null],
  [4, FROM_POST, 0, 0, 0, "note only", null, null, null],
  [5, FROM_POST, 0, 0, 0, "", null, null, null],
];

function resetFlagsAndUsers() {
  db.prepare("DELETE FROM user_listing_flags").run();
  // db.js import 已建 admin 使用者（id 1）；這裡只「確保」id 1..5 存在（id 1 已有 → skip），
  // 不做 DELETE FROM users，否則會撞到 user_settings 的 FK（admin 有 47 筆設定列）。
  const user = db.prepare(
    "INSERT INTO users(id, email, password_hash, role, plan, created_at) VALUES (?, ?, '', 'member', 'free', ?) ON CONFLICT(id) DO NOTHING",
  );
  for (const id of [1, 2, 3, 4, 5]) user.run(id, `u${id}@relist.test`, "2026-09-01T00:00:00.000Z");
}

function seedSourceFlags() {
  resetFlagsAndUsers();
  const ins = db.prepare(
    `INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of SOURCE_ROWS) ins.run(...row);
}

// 只比較「非時間戳」欄位：複製會用 wall-clock 蓋 viewed_at／watched_at／hidden_at，
// 兩次呼叫的毫秒不同，所以不把時間戳放進 snapshot。
function snapshotTargetFlags() {
  return db
    .prepare(
      "SELECT user_id, viewed, watched, hidden, watch_note FROM user_listing_flags WHERE post_id = ? ORDER BY user_id",
    )
    .all(TO_POST)
    .map((row) => ({
      user_id: row.user_id,
      viewed: row.viewed,
      watched: row.watched,
      hidden: row.hidden,
      watch_note: row.watch_note,
    }));
}

// PG exec 的離線替身：SQL 已用 `?` 佔位（與同步版同一句文字），直接跑 SQLite。
function shim(sql, params = []) {
  const text = String(sql).replace(/\$(\d+)/g, "?");
  const st = db.prepare(text);
  const isRead = /^\s*(select|with)/i.test(text) || /returning/i.test(text);
  if (isRead) return st.all(...params);
  st.run(...params);
  return [];
}

test("sqlite 模式：async 入口與同步 copyUserFlags 結果相同", async () => {
  seedSourceFlags();
  const copiedSync = app.copyUserFlags(FROM_POST, TO_POST);
  const syncSnap = snapshotTargetFlags();

  seedSourceFlags();
  const copiedAsync = await flagsAsync.copyUserFlagsAsync(FROM_POST, TO_POST, { driver: "sqlite" });
  const asyncSnap = snapshotTargetFlags();

  assert.equal(copiedAsync, copiedSync, "複製列數要一致");
  assert.equal(copiedAsync, 4, "hidden／viewed／watched／watch_note 各一筆，空旗標那筆不複製");
  assert.deepEqual(asyncSnap, syncSnap, "非時間戳欄位要完全一致");
});

test("postgres 路徑（離線 exec 替身）與 sqlite 路徑做出同一件事", async () => {
  const pgOptions = { driver: "postgres", exec: shim, strict: true };

  seedSourceFlags();
  const copiedPg = await flagsAsync.copyUserFlagsAsync(FROM_POST, TO_POST, pgOptions);
  const pgSnap = snapshotTargetFlags();

  seedSourceFlags();
  const copiedSync = app.copyUserFlags(FROM_POST, TO_POST);
  const syncSnap = snapshotTargetFlags();

  assert.equal(copiedPg, copiedSync, "複製列數要一致");
  assert.deepEqual(pgSnap, syncSnap, "PG 路徑與 SQLite 路徑的非時間戳欄位要完全一致");
});

test("watcher 已改呼叫 async 版，且不再呼叫同步 copyUserFlags", () => {
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(watcher, /import \{ copyUserFlagsAsync \} from "\.\/personalFlagsAsync\.js";/);
  assert.match(watcher, /const copied = await copyUserFlagsAsync\(prev\.post_id, listing\.post_id\);/);
  // 反向斷言：把行註解與 block comment 剝掉後，不得再出現「同步 copyUserFlags(」的呼叫。
  // `copyUserFlagsAsync(` 不會命中 `copyUserFlags\(`（後面接的是 `A` 不是 `(`）。
  const code = watcher.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /copyUserFlags\(/, "watcher 不得再呼叫同步 copyUserFlags(");
});

test("live：PG 模式來源讀 PG、寫 PG，且不落本機 SQLite（無 PG_TEST_URL 時 skip）", async (t) => {
  const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
  if (!PG_TEST_URL) {
    t.skip("PG_TEST_URL is not set (live user flags relist copy)");
    return;
  }
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { importStore } = await import("../src/pgSchema.js");

  const LIVE_FROM = 9700001;
  const LIVE_TO = 9700002;

  // 只把「會員表」mirror 進暫存 PG schema；`user_listing_flags` 保持空的。
  // 來源那筆 hidden 旗標**只寫進 PG**，不進本機 SQLite——這樣才證明「來源讀 PG、不是偷讀本機」。
  resetFlagsAndUsers();

  const sqliteDb = app.sqliteHandle();
  const have = new Set(
    sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  const tables = ["users", "user_listing_flags"].filter((name) => have.has(name));

  const schema = `pgrelist_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 3, options: `-c search_path=${schema}`, application_name: "5151-relist-flags" },
  });
  try {
    await importStore(pgDriver, sqliteDb, { schema, tables });
    await pgDriver.query(
      `INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [1, LIVE_FROM, 0, 1, 1, "live-relist", "2026-10-08T01:00:00.000Z", "2026-10-08T01:00:00.000Z", "2026-10-08T01:00:00.000Z"],
    );

    const copied = await flagsAsync.copyUserFlagsAsync(LIVE_FROM, LIVE_TO, {
      driver: "postgres",
      pgDriver,
      strict: true,
    });
    assert.equal(copied, 1, "來源那筆 hidden 旗標要被複製（讀來源也要依 driver）");

    const readBack = await pgDriver.query(
      "SELECT user_id, viewed, watched, hidden, watch_note FROM user_listing_flags WHERE post_id = $1 ORDER BY user_id",
      [LIVE_TO],
    );
    assert.equal(readBack.rows.length, 1, "PG 要能讀回目標那筆旗標");
    assert.equal(Number(readBack.rows[0].user_id), 1);
    assert.equal(Number(readBack.rows[0].hidden), 1);
    assert.equal(Number(readBack.rows[0].viewed), 1);

    // 反向：本機 SQLite 完全沒被寫入（這正是原 bug：寫進沒人讀的本機庫）。
    const local = db
      .prepare("SELECT COUNT(*) AS n FROM user_listing_flags WHERE post_id IN (?, ?)")
      .get(LIVE_FROM, LIVE_TO);
    assert.equal(local.n, 0, "PG 模式不可寫本機 SQLite");
  } finally {
    await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pgDriver.close();
  }
});
