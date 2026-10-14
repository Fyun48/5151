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
  // PG 側（用記憶體 SQLite 當替身）要跑得到新的群去重口徑：`fold_component_root` 是真 PG
  // 才有的固化欄（SQLite 沒有），所以替身自己加一欄（測試自己的 schema，不是產品 DDL）。
  mem.exec("ALTER TABLE listings ADD COLUMN fold_component_root INTEGER");
  const flag = (db, postId) => db.prepare(
    "INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note, watch_group_id) VALUES (?,?,0,1,0,'','')",
  ).run(UID, postId);
  const listing = (db, postId, offline, root = null) => {
    const info = db.prepare("PRAGMA table_info(listings)").all();
    const provided = {
      post_id: postId, title: `t${postId}`, source: "591", source_key: `1|${postId}`,
      offline_confirmed: offline, listed_by_user_id: UID,
    };
    // 只有真的那一欄存在時才塞（真 SQLite 的 listings 沒有 fold_component_root）。
    if (info.some((c) => c.name === "fold_component_root")) provided.fold_component_root = root;
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
    // 三筆關注：兩筆還在（佔額度）、一筆已確認離線（不佔）。兩筆的 root 不同 ⇒ 各算一群。
    for (const postId of [920001, 920002, 920003]) flag(db, postId);
    listing(db, 920001, 0, 77001);
    listing(db, 920002, 0, 77002);
    listing(db, 920003, 1, 77003);
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

// ── Owner 2026-10-14：疑似同屋源整群算 1 次 ────────────────────────────────────
// SQLite 與 PG 兩版**同一句 SQL 文字**（`WATCHED_COUNT_SQL`）、**同一條規則**（`watchGateVerdict`）。
// 這裡用「有 `fold_component_root` 的記憶體 SQLite」當兩邊的共同靶：左邊是同步版
// （`countWatched(conn)`），右邊是 PG 版（`countWatchedAsync` ＋ 注入式 exec）。
const GROUP_UID = 900000007002;

function groupWorld() {
  const mem = new DatabaseSync(":memory:");
  mem.exec(`CREATE TABLE listings (
    post_id INTEGER PRIMARY KEY,
    offline_confirmed INTEGER NOT NULL DEFAULT 0,
    fold_component_root INTEGER
  )`);
  mem.exec(`CREATE TABLE user_listing_flags (
    user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, viewed INTEGER NOT NULL DEFAULT 0,
    watched INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
    watch_note TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, post_id)
  )`);
  const seen = [];
  const exec = async (sql, params = []) => { seen.push(sql); return mem.prepare(sql).all(...params); };
  exec.raw = mem;
  exec.seen = seen;
  return { mem, exec };
}

function seedGroupWorld(mem, uid, rows) {
  let postId = 950000;
  for (const row of rows) {
    postId += 1;
    mem.prepare("INSERT INTO user_listing_flags(user_id, post_id, viewed, watched) VALUES (?,?,?,?)")
      .run(uid, postId, row.viewed ? 1 : 0, 1);
    if (!row.orphan) {
      mem.prepare("INSERT INTO listings(post_id, offline_confirmed, fold_component_root) VALUES (?,?,?)")
        .run(postId, row.offlineConfirmed ? 1 : 0, row.root ?? null);
    }
    row.postId = postId;
  }
  return rows;
}

test("群去重口徑：同步版與 PG 版同結果（同一句 SQL 文字）", async () => {
  const { mem, exec } = groupWorld();
  const rows = seedGroupWorld(mem, GROUP_UID, [
    { root: 88001 },                    // 同群 2 筆
    { root: 88001 },
    { root: 88002 },                    // 不同群 2 筆
    { root: 88003 },
    { root: 88004, offlineConfirmed: 1 }, // 確認下架不計
    { orphan: true },                   // 孤兒旗標不計
  ]);
  const sync = limits.countWatched(mem, GROUP_UID);
  assert.equal(sync, 3, "同群 2＋不同群 2 ＝ 3 群；確認下架與孤兒不計");
  const viaAsync = await limitsAsync.countWatchedAsync(GROUP_UID, { ...PG, exec, strict: true });
  assert.equal(viaAsync, sync, "兩版必須同結果");
  assert.equal(exec.seen[0], limits.WATCHED_COUNT_SQL, "PG 版跑的必須是同一句 SQL 文字（不得另抄一份）");
  assert.match(exec.seen[0], /COUNT\(DISTINCT COALESCE\(l\.fold_component_root, f\.post_id\)\) AS n/);

  // 「這個 post 的群是否已在特別關注裡」兩版也要一致
  const sameGroup = rows[1].postId;   // root 88001，已在關注裡
  const otherGroup = rows[3].postId;  // 另一個已在關注的群
  assert.equal(limits.watchedGroupHit(mem, GROUP_UID, sameGroup), true);
  assert.equal(await limitsAsync.watchedGroupHitAsync(GROUP_UID, sameGroup, { ...PG, exec, strict: true }), true);
  assert.equal(limits.watchedGroupHit(mem, GROUP_UID, otherGroup), true);
  assert.equal(await limitsAsync.watchedGroupHitAsync(GROUP_UID, otherGroup, { ...PG, exec, strict: true }), true);
  // 沒被關注的群 ⇒ false
  mem.prepare("INSERT INTO listings(post_id, offline_confirmed, fold_component_root) VALUES (?,?,?)").run(960001, 0, 88099);
  assert.equal(limits.watchedGroupHit(mem, GROUP_UID, 960001), false);
  assert.equal(await limitsAsync.watchedGroupHitAsync(GROUP_UID, 960001, { ...PG, exec, strict: true }), false);
  // NULL root 的新列 ⇒ 自己一群 ⇒ 不算同群
  mem.prepare("INSERT INTO listings(post_id, offline_confirmed, fold_component_root) VALUES (?,?,?)").run(960002, 0, null);
  assert.equal(limits.watchedGroupHit(mem, GROUP_UID, 960002), false);
  assert.equal(await limitsAsync.watchedGroupHitAsync(GROUP_UID, 960002, { ...PG, exec, strict: true }), false);
});

test("後台會員列表的批次 SQL 也必須是群數口徑（同一份 WATCHED_COUNT_SQL 推導）", () => {
  const sql = limitsAsync.watchedCountBatchSql(3);
  assert.match(sql, /SELECT f\.user_id AS user_id, COUNT\(DISTINCT COALESCE\(l\.fold_component_root, f\.post_id\)\) AS n/);
  assert.match(sql, /f\.user_id IN \(\?,\?,\?\)/);
  assert.match(sql, /GROUP BY f\.user_id/);
  assert.match(sql, /JOIN listings l ON l\.post_id = f\.post_id/);
  assert.match(sql, /IFNULL\(l\.offline_confirmed, 0\) = 0/);
  assert.throws(() => limitsAsync.watchedCountBatchSql(0), /形狀變了/);
  // 退化版（沒有 fold_component_root 的庫）同樣由 `WATCHED_COUNT_SQL_LEGACY` 推導。
  const legacy = limitsAsync.watchedCountBatchSqlLegacy(2);
  assert.match(legacy, /SELECT f\.user_id AS user_id, COUNT\(\*\) AS n/);
  assert.match(legacy, /f\.user_id IN \(\?,\?\)/);
  assert.match(legacy, /GROUP BY f\.user_id/);
  assert.match(legacy, /EXISTS \(/);
});

test("沒有 fold_component_root 的庫（SQLite／007 之前的 PG）⇒ 退回不去重的舊口徑，不拋錯", async () => {
  const mem = new DatabaseSync(":memory:");
  mem.exec("CREATE TABLE listings (post_id INTEGER PRIMARY KEY, offline_confirmed INTEGER NOT NULL DEFAULT 0)");
  mem.exec("CREATE TABLE user_listing_flags (user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, viewed INTEGER NOT NULL DEFAULT 0, watched INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, watch_note TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, post_id))");
  const uid = 900000007003;
  for (const postId of [1, 2, 3]) {
    mem.prepare("INSERT INTO user_listing_flags(user_id, post_id, watched) VALUES (?,?,1)").run(uid, postId);
  }
  mem.prepare("INSERT INTO listings(post_id, offline_confirmed) VALUES (?,0)").run(1);
  mem.prepare("INSERT INTO listings(post_id, offline_confirmed) VALUES (?,0)").run(2);
  // post 3 ＝ 孤兒旗標（沒有 listings 列）
  const seen = [];
  const exec = async (sql, params = []) => { seen.push(sql); return mem.prepare(sql).all(...params); };
  assert.equal(await limitsAsync.countWatchedAsync(uid, { ...PG, exec, strict: true }), 2,
    "退回舊口徑：兩筆未確認下架，孤兒不計（**不得** fail-open 成 0 筆）");
  assert.equal(seen[0], limits.WATCHED_COUNT_SQL);
  assert.equal(seen[1], limits.WATCHED_COUNT_SQL_LEGACY, "第二句必須是共用常數裡的舊口徑，不是另抄的字串");
  assert.equal(await limitsAsync.watchedGroupHitAsync(uid, 1, { ...PG, exec, strict: true }), false,
    "沒有分組鍵 ⇒ 一律當新群（維持改動前的行為）");
  const batch = await limitsAsync.countWatchedBatchAsync([uid], { ...PG, exec, strict: true });
  assert.equal(batch.get(uid), 2, "批次版也要退回舊口徑，而且不拋錯");
});
