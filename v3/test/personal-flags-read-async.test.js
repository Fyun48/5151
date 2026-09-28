// `loadFlagsAsync()`／`loadFlagMapAsync()` 的 parity（2026-09-28）。
//
// 為什麼挑這兩支：它們各自只是一個 SELECT，卻是 **13 條缺口路由**的共同卡點
// （`loadFlags` 9 條、`loadFlagMap` 8 條，重疊後 13 條）。
//
// 要釘住的形狀：
//   1. **查不到時回 `emptyFlags()`**（不是 undefined／null）——`overlayPersonal()` 那類呼叫端
//      會直接讀欄位，形狀不對就會出現 undefined 而不是 0。
//   2. **`loadFlagMap()` 回 `Map`**，鍵是**數字** `post_id`（`overlayRowsPersonal()` 用
//      `flagMap?.get(Number(row.post_id))` 查，鍵型別錯了就永遠查不到）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-pflags-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const syncMod = await import("../src/personalFlags.js");
const asyncMod = await import("../src/personalFlagsAsync.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const UID = 900000001101;
const OTHER = 900000001102;
const TABLE = "user_listing_flags";

function fixture() {
  const mem = new DatabaseSync(":memory:");
  // `users` 也要：`user_listing_flags` 的 FK 指向它，夾具少了它會 `no such table: main.users`。
  for (const t of ["users", TABLE]) {
    const ddl = handle().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.ok(ddl?.sql, `必須抓到 ${t} 的 DDL`);
    mem.exec(ddl.sql);
  }
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

function seed(h, rows) {
  for (const [user_id, post_id, watched, hidden, note] of rows) {
    h.prepare(
      `INSERT INTO ${TABLE}(user_id, post_id, viewed, watched, hidden, watch_note) VALUES (?, ?, 1, ?, ?, ?)`,
    ).run(user_id, post_id, watched, hidden, note || "");
  }
}

function resetWorld(rows = []) {
  const db = handle();
  db.prepare(`DELETE FROM ${TABLE}`).run();
  // ⚠️ `user_listing_flags` 有 FK 到 `users`（夾具開了 foreign_keys）⇒ 測試使用者要先存在，
  // 否則會是 `FOREIGN KEY constraint failed`（第一版就是這樣整排紅的）。
  for (const id of [UID, OTHER]) {
    db.prepare(
      "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free','2026-01-01T00:00:00.000Z')",
    ).run(id, `pf${id}@example.com`, `u${id}`);
  }
  seed(db, rows);
  const exec = fixture();
  for (const t of ["users", TABLE]) {
    for (const row of db.prepare(`SELECT * FROM ${t}`).all()) {
      const cols = Object.keys(row);
      exec.raw.prepare(`INSERT INTO ${t}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
        .run(...cols.map((c) => row[c]));
    }
  }
  return [db, exec];
}

// ---------------------------------------------------------------------------

test("loadFlags：查得到時逐鍵相同（含 watched／hidden／watch_note）", async () => {
  const [db, exec] = resetWorld([[UID, 501, 1, 0, "等屋主回覆"]]);
  const sync = syncMod.loadFlags(db, UID, 501);
  const asyncFlags = await asyncMod.loadFlagsAsync(UID, 501, { ...PG, exec, strict: true });
  assert.deepEqual(asyncFlags, sync, "有資料時必須逐鍵相同");
  assert.equal(Number(asyncFlags.watched), 1, "watched 必須真的讀到（否則這條沒鑑別力）");
  assert.equal(asyncFlags.watch_note, "等屋主回覆");
});

test("loadFlags：查不到時回 emptyFlags() 的形狀（不是 undefined／null）", async () => {
  const [db, exec] = resetWorld([[UID, 501, 1, 0, ""]]);
  const empty = await asyncMod.loadFlagsAsync(UID, 999, { ...PG, exec, strict: true });
  assert.deepEqual(empty, syncMod.emptyFlags(), "查不到必須回 emptyFlags()");
  assert.deepEqual(empty, syncMod.loadFlags(db, UID, 999), "與同步版同形狀");
  // 呼叫端（overlayPersonal）會直接讀欄位 ⇒ 每個鍵都要在
  for (const key of ["viewed", "watched", "hidden", "watch_note", "viewed_at", "watched_at", "hidden_at"]) {
    assert.ok(key in empty, `emptyFlags() 必須有 ${key}`);
  }
  // uid／pid 為 0 時也要回空旗標（而且不送查詢）
  let calls = 0;
  const counting = async (sql, params = []) => { calls += 1; return exec(sql, params); };
  for (const [u, p] of [[0, 501], [UID, 0], [0, 0]]) {
    assert.deepEqual(await asyncMod.loadFlagsAsync(u, p, { ...PG, exec: counting, strict: true }), syncMod.emptyFlags());
  }
  assert.equal(calls, 0, "uid／pid 為 0 時不得送出查詢");
});

test("loadFlags：別人的旗標不得被讀到（只看自己的）", async () => {
  const [db, exec] = resetWorld([[UID, 501, 1, 0, "mine"], [OTHER, 501, 0, 1, "theirs"]]);
  const mine = await asyncMod.loadFlagsAsync(UID, 501, { ...PG, exec, strict: true });
  assert.equal(mine.watch_note, "mine", "必須只讀自己的那一列");
  assert.equal(Number(mine.hidden), 0);
  assert.deepEqual(mine, syncMod.loadFlags(db, UID, 501));
});

test("loadFlagMap：回 Map 且鍵是數字 post_id，內容與同步版相同", async () => {
  const [db, exec] = resetWorld([[UID, 501, 1, 0, "a"], [UID, 502, 0, 1, "b"], [OTHER, 503, 1, 0, "c"]]);
  const syncMap = syncMod.loadFlagMap(db, UID);
  const asyncMap = await asyncMod.loadFlagMapAsync(UID, { ...PG, exec, strict: true });
  assert.ok(asyncMap instanceof Map, "必須是 Map");
  assert.equal(asyncMap.size, syncMap.size, "大小必須相同");
  assert.equal(asyncMap.size, 2, "只算自己的兩筆");
  for (const [k, v] of syncMap) {
    assert.ok(asyncMap.has(k), `必須有鍵 ${k}`);
    assert.deepEqual(asyncMap.get(k), v, `鍵 ${k} 的內容必須相同`);
  }
  // 鍵必須是**數字**（呼叫端用 Number(row.post_id) 查）
  assert.ok(asyncMap.has(501), "鍵 501 必須是數字鍵");
  assert.equal(typeof [...asyncMap.keys()][0], "number", "鍵的型別必須是 number");
  assert.equal(asyncMap.has(503), false, "別人的不得進來");
});

test("loadFlagMap：沒有旗標與 uid 0 都回空 Map", async () => {
  const [db, exec] = resetWorld([[OTHER, 503, 1, 0, ""]]);
  assert.equal((await asyncMod.loadFlagMapAsync(UID, { ...PG, exec, strict: true })).size, 0, "沒有旗標應為空");
  assert.equal((await asyncMod.loadFlagMapAsync(0, { ...PG, exec, strict: true })).size, 0, "uid 0 應為空");
  assert.equal(syncMod.loadFlagMap(db, UID).size, 0, "同步版也是空（對照組）");
});

test("寫入失敗時 fail-closed：PG 丟錯就往上丟（strict），不得靜默回退", async () => {
  resetWorld([[UID, 501, 1, 0, ""]]);
  const bad = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    () => asyncMod.loadFlagsAsync(UID, 501, { ...PG, exec: bad, strict: true }),
    /connection terminated/,
  );
  await assert.rejects(
    () => asyncMod.loadFlagMapAsync(UID, { ...PG, exec: bad, strict: true }),
    /connection terminated/,
  );
});

test("非 postgres 必須回退同步路徑（讀磁碟，完全不碰傳入的 exec）", async () => {
  const [db, exec] = resetWorld([[UID, 501, 1, 0, "disk"]]);
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const flags = await asyncMod.loadFlagsAsync(UID, 501, { driver: "sqlite", exec: boom });
  const map = await asyncMod.loadFlagMapAsync(UID, { driver: "sqlite", exec: boom });
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.deepEqual(flags, syncMod.loadFlags(db, UID, 501), "sqlite 模式必須讀磁碟");
  assert.equal(map.size, syncMod.loadFlagMap(db, UID).size);
});
