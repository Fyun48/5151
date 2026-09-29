// 特別關注額度（`countWatchedAsync`）的 parity（2026-09-28，第五十四批）。
//
// `countWatched()` 是 **12 條路由**的卡點（後台會員列表、`/api/listings`、`/api/settings`、
// `/api/state` 的 `watchedTotal`…）。同步版讀節點本機的 `user_listing_flags` ＋ `listings`；
// PG 模式下那是別的節點的資料 ⇒ 額度會用錯的數字（會員被誤擋、或超額加入），而且是靜默的。
//
// ⚠️ 額度的定義不只是「watched = 1」：**已確認離線的物件不佔額度**（`IFNULL(offline_confirmed,0)=0`），
// 而且 `WATCHED_COUNT_SQL` 與列表頁的 `watchedTotal` 是同一句（`repository/listingStats.js`），
// 所以這一支的 PG 版也必須用同一句、經過 `toPostgresSql()` 翻譯（`IFNULL` → `COALESCE`）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-watchlimits-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const limits = await import("../src/watchLimits.js");
const limitsAsync = await import("../src/watchLimitsAsync.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const UID = 900000007001;
const TABLES = ["users", "user_listing_flags", "listings"];

function worlds() {
  const lite = handle();
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true });
  for (const table of TABLES) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  disk.close();
  const flag = (db, postId) => db.prepare(
    "INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note, watch_group_id) VALUES (?,?,0,1,0,'','')",
  ).run(UID, postId);
  const listing = (db, postId, offline) => {
    const info = db.prepare("PRAGMA table_info(listings)").all();
    const provided = {
      post_id: postId, title: `t${postId}`, source: "591", source_key: `1|${postId}`,
      offline_confirmed: offline, listed_by_user_id: UID,
    };
    const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
    const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
    db.prepare(`INSERT INTO listings(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
      .run(...names.map((n) => (n in provided ? provided[n] : (/INT|REAL|NUM/i.test(info.find((c) => c.name === n).type) ? 0 : ""))));
  };
  for (const db of [lite, mem]) {
    // `listings`／`user_listing_flags` 都有 FK 到 users ⇒ 先有一位會員。
    db.prepare(
      "INSERT OR REPLACE INTO users(id, email, role, plan, created_at) VALUES (?,?,?,?,?)",
    ).run(UID, "watch@example.test", "member", "free", "2026-01-01T00:00:00.000Z");
    db.prepare("DELETE FROM user_listing_flags WHERE user_id = ?").run(UID);
    db.prepare("DELETE FROM listings WHERE listed_by_user_id = ?").run(UID);
    // 三筆關注：兩筆還在（佔額度）、一筆已確認離線（不佔）。
    for (const postId of [920001, 920002, 920003]) flag(db, postId);
    listing(db, 920001, 0);
    listing(db, 920002, 0);
    listing(db, 920003, 1);
    // 一筆沒被關注的刊登（不得被算進去）
    listing(db, 920004, 0);
  }
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return [lite, exec];
}

test("PG 與同步版相同：已確認離線的不佔額度、沒關注的不算", async () => {
  const [lite, exec] = worlds();
  const sync = limits.countWatched(lite, UID);
  assert.equal(sync, 2, "前提：同步版算出來是 2（3 筆關注 − 1 筆已離線）");
  const viaAsync = await limitsAsync.countWatchedAsync(UID, { ...PG, exec, strict: true });
  assert.equal(viaAsync, sync, "兩邊必須相同");
  assert.equal(viaAsync, 2, "必須排除已確認離線的那一筆（否則額度會少一格）");
  // uid 0：直接回 0，不得送出查詢
  let calls = 0;
  const counting = async (sql, params = []) => { calls += 1; return exec(sql, params); };
  assert.equal(await limitsAsync.countWatchedAsync(0, { ...PG, exec: counting, strict: true }), 0);
  assert.equal(calls, 0, "uid 0 必須早退");
});

test("注入式 exec 的形狀不影響結果（裸陣列 vs { rows, rowCount }）", async () => {
  // 這一條真的抓到過：模組的 runner 約定是**裸陣列**，但 callback 一度寫成 `(...).rows`
  // ⇒ 永遠回 0（額度算成 0 筆，會員可以無限加入關注）。
  const [lite, exec] = worlds();
  const wrapped = async (sql, params = []) => {
    const rows = await exec(sql, params);
    return { rows, rowCount: Number(rows.rowCount) || 0 };
  };
  assert.equal(await limitsAsync.countWatchedAsync(UID, { ...PG, exec: wrapped, strict: true }),
    limits.countWatched(lite, UID), "兩種形狀都要吃得下");
});

test("非 postgres：走同步路徑（讀磁碟、不碰 exec）", async () => {
  const [lite, exec] = worlds();
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  assert.equal(await limitsAsync.countWatchedAsync(UID, { driver: "sqlite", exec: boom }), limits.countWatched(lite, UID));
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
});
