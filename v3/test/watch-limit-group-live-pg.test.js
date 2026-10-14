// 特別關注使用量的「疑似同屋源整群算 1 次」（Owner 2026-10-14）：**live PG** 驗證。
//
// 為什麼一定要 live（離線夾具證明不了的事）：
//   1. `fold_component_root` 是**只有 PG 才有**的固化欄（SQLite 一向沒有，db.js:3696）⇒
//      離線的 SQLite 替身跑的是「自己加的欄」，證明不了真 PG 上的欄位型別／`COUNT(DISTINCT
//      COALESCE(...))` 的實際結果（bigint vs text、NULL 的 coalesce 行為）。
//   2. `?` → `$n` 的轉譯＋`IFNULL` → `COALESCE` 的翻譯只有真 PG 會執行；這一句與
//      `repository/listingStats.js` 的 `watchedTotal`、後台批次版共用同一份文字。
//   3. 「同群不增量」的判定（`WATCHED_GROUP_HIT_SQL`）在同一張表上自 JOIN，必須在真 PG 上
//      證明它不會把「不同群」誤判成同群、也不會把 NULL root 的孤列算進任何群。
//
// ⚠️ 安全設計照抄 `listing-totals-counter-live-pg.test.js`（L-0863）：
//    • **不吃 `PG_TEST_URL`**（本機那個可能指向正式庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名
//      要在允許清單內。（本檔出現 `PG_TEST_URL` 這個字串是為了讓 `run-pg-integration.sh` 的
//      收檔 `grep -rl PG_TEST_URL` 把這支收進 PG 整合測試——那是既有慣例，不是真的讀它。）
//    • 自己建隔離資料庫 `sw1_wg_<pid>`，收尾 `DROP DATABASE … WITH (FORCE)`；
//      **不對共用庫的任何既有物件做 DROP／TRUNCATE／ALTER**。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫一律拒絕）`
    : false;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-watchgroup-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

const DB_NAME = `sw1_wg_${process.pid}`;
const withDatabase = (url, name) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
// 自癒路徑（`defaultPrimaryDriver()`）走 `PG_URL` ⇒ 這裡也把它指到自建庫，
// 否則測試會去打共用庫的 `public`（那正是要避免的事）。
if (RAW && !REFUSED) process.env.PG_URL = withDatabase(RAW, DB_NAME);

// 這一組 id 只給這個檔案用（其他 live 測試用的是 7xxxxx／9xxxxx 區段，這裡刻意錯開）。
const UIDS = [976901, 976902, 976903, 976904];
const POST_BASE = 976000;

let pgDriver = null;
let adminDriver = null;
let sqliteHandle = null;

after(async () => {
  if (pgDriver) await pgDriver.close().catch(() => {});
  try {
    const { closeSharedPgDriver } = await import("../src/pgSharedDriver.js");
    await closeSharedPgDriver();
  } catch { /* 沒建過就沒事 */ }
  if (adminDriver) {
    try { await adminDriver.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`); } catch { /* 已經收掉 */ }
    await adminDriver.close().catch(() => {});
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function connect() {
  if (pgDriver) return pgDriver;
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { ensurePgSchema } = await import("../src/pgSchema.js");
  const dbMod = await import("../src/db.js");
  sqliteHandle = dbMod.sqliteHandle;
  adminDriver = await createPostgresDriver({ connectionString: RAW });
  const who = (await adminDriver.query("SELECT current_database() AS db")).rows[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");
  await adminDriver.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await adminDriver.query(`CREATE DATABASE ${DB_NAME}`);
  pgDriver = await createPostgresDriver({ connectionString: withDatabase(RAW, DB_NAME) });
  const mine = (await pgDriver.query("SELECT current_database() AS db")).rows[0];
  assert.equal(mine.db, DB_NAME, "這一支必須跑在自己的資料庫（不動共用靶）");
  // schema 由 SQLite 鏡射；`fold_component_root` 是真 PG 才有的固化欄（migration 007 走
  // CONCURRENTLY、不在鏡射裡）⇒ 這裡自己補上，**只在自己的隔離庫**。
  await ensurePgSchema(pgDriver, sqliteHandle(), { schema: "", tables: ["users", "listings", "user_listing_flags"], indexes: false });
  const has = (await pgDriver.query(
    "SELECT 1 AS present FROM pg_attribute WHERE attrelid = to_regclass('listings') AND attname = 'fold_component_root' AND attnum > 0 AND NOT attisdropped LIMIT 1",
  )).rows;
  if (!has.length) await pgDriver.query("ALTER TABLE listings ADD COLUMN fold_component_root bigint");
  return pgDriver;
}

// 由 SQLite 的 DDL 推出「必填欄位」（NOT NULL 且沒有 default、不是 pk）——與同步版
// `watch-limits-async.test.js` 的夾具同一招，只是這裡寫進真 PG。
function requiredColumns(handle, table) {
  return handle.prepare(`PRAGMA table_info(${table})`).all()
    .filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
}

async function insertRow(table, values) {
  const cols = Object.keys(values);
  await pgDriver.query(
    `INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
    cols.map((c) => values[c]),
  );
}

async function seedUser(uid) {
  const filler = (type) => (/INT|REAL|NUM/i.test(String(type)) ? 0 : "");
  const required = requiredColumns(sqliteHandle(), "users");
  const values = { id: uid };
  for (const c of required) if (!(c.name in values)) values[c.name] = filler(c.type);
  values.email = values.email || `wg-${uid}@example.test`;
  values.role = "member";
  values.plan = "free";
  await insertRow("users", values);
}

async function seedWatch(uid, postId) {
  const filler = (type) => (/INT|REAL|NUM/i.test(String(type)) ? 0 : "");
  const required = requiredColumns(sqliteHandle(), "user_listing_flags");
  const values = { user_id: uid, post_id: postId, watched: 1 };
  for (const c of required) if (!(c.name in values)) values[c.name] = filler(c.type);
  await insertRow("user_listing_flags", values);
}

async function seedListing(postId, { root = null, offlineConfirmed = 0, uid } = {}) {
  const filler = (type) => (/INT|REAL|NUM/i.test(String(type)) ? 0 : "");
  const required = requiredColumns(sqliteHandle(), "listings");
  const values = { post_id: postId, fold_component_root: root };
  for (const c of required) if (!(c.name in values)) values[c.name] = filler(c.type);
  if (uid != null && "listed_by_user_id" in values) values.listed_by_user_id = uid;
  values.offline_confirmed = offlineConfirmed;
  await insertRow("listings", values);
}

// `{ root: [88001, 88001] }` 這種形狀的夾具：`orphan: true` ＝ 只有旗標沒有 listings 列。
async function seedWorld(uid, rows) {
  await seedUser(uid);
  let n = 0;
  for (const row of rows) {
    const postId = POST_BASE + uid % 1000 * 100 + (n += 1);
    await seedWatch(uid, postId);
    if (!row.orphan) await seedListing(postId, { root: row.root ?? null, offlineConfirmed: row.offlineConfirmed ? 1 : 0, uid });
    row.postId = postId;
  }
  return rows;
}

// 同一份夾具的 SQLite 版（用來證明「兩版同結果」）。
function sqliteWorld(rows) {
  const mem = new DatabaseSync(":memory:");
  mem.exec("CREATE TABLE listings (post_id INTEGER PRIMARY KEY, offline_confirmed INTEGER NOT NULL DEFAULT 0, fold_component_root INTEGER)");
  mem.exec("CREATE TABLE user_listing_flags (user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, viewed INTEGER NOT NULL DEFAULT 0, watched INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, watch_note TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, post_id))");
  for (const [uid, userRows] of rows) {
    for (const row of userRows) {
      mem.prepare("INSERT INTO user_listing_flags(user_id, post_id, viewed, watched) VALUES (?,?,0,1)").run(uid, row.postId);
      if (!row.orphan) {
        mem.prepare("INSERT INTO listings(post_id, offline_confirmed, fold_component_root) VALUES (?,?,?)")
          .run(row.postId, row.offlineConfirmed ? 1 : 0, row.root ?? null);
      }
    }
  }
  return mem;
}

test("live PG：特別關注使用量按疑似同屋源整群去重（含 SQLite/PG parity、canAddWatch 邊界）", { skip }, async () => {
  await connect();
  const limits = await import("../src/watchLimits.js");
  const limitsAsync = await import("../src/watchLimitsAsync.js");
  const opts = { driver: "postgres", pgDriver, strict: true };

  // ── 夾具 ──────────────────────────────────────────────────────────────
  // U1：同群 2 筆＋不同群 2 筆＋確認下架 1 筆＋孤兒 1 筆 ⇒ 3 格
  const u1 = await seedWorld(UIDS[0], [{ root: 88001 }, { root: 88001 }, { root: 88002 }, { root: 88003 }, { root: 88004, offlineConfirmed: 1 }, { orphan: true }]);
  // U2：六個不同的群 ⇒ 6 格（滿）
  const u2rows = [];
  for (let i = 0; i < 6; i += 1) u2rows.push({ root: 88100 + i });
  const u2 = await seedWorld(UIDS[1], u2rows);
  // U3：同群 2 筆、其中一筆確認下架 ⇒ 1 格
  const u3 = await seedWorld(UIDS[2], [{ root: 88200 }, { root: 88200, offlineConfirmed: 1 }]);
  // U4：兩筆都是孤兒旗標 ⇒ 0 格
  await seedWorld(UIDS[3], [{ orphan: true }, { orphan: true }]);
  const sqlite = sqliteWorld([[UIDS[0], u1], [UIDS[1], u2], [UIDS[2], u3]]);

  // ── ① 群數口徑（真 PG）＋ SQLite/PG parity ─────────────────────────────
  const expectations = [[UIDS[0], 3], [UIDS[1], 6], [UIDS[2], 1], [UIDS[3], 0]];
  for (const [uid, expected] of expectations) {
    const viaPg = await limitsAsync.countWatchedAsync(uid, opts);
    assert.equal(viaPg, expected, `PG 的群數口徑（uid ${uid}）`);
    if (uid !== UIDS[3]) {
      assert.equal(limits.countWatched(sqlite, uid), expected, `SQLite 同結果（uid ${uid}）`);
      assert.equal(viaPg, limits.countWatched(sqlite, uid), "兩版必須逐位相同");
    }
  }
  // 真 SQL 文字的翻譯：IFNULL 必須被換成 COALESCE，且不得留下 IFNULL。
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const translated = toPostgresSql(limits.WATCHED_COUNT_SQL);
  assert.match(translated, /COUNT\(DISTINCT COALESCE\(l\.fold_component_root, f\.post_id\)\) AS n/);
  assert.match(translated, /COALESCE\(l\.offline_confirmed, 0\) = 0/);
  assert.doesNotMatch(translated, /IFNULL/i);

  // ── ② 後台批次口徑＝逐人版 ────────────────────────────────────────────
  const batch = await limitsAsync.countWatchedBatchAsync(UIDS, opts);
  for (const [uid, expected] of expectations) {
    assert.equal(batch.get(uid), expected, `後台批次版的群數（uid ${uid}）`);
    if (uid !== UIDS[3]) assert.equal(batch.get(uid), limits.countWatched(sqlite, uid), "批次版與 SQLite 同口徑");
  }

  // ── ③ 「這個 post 的群是否已在關注裡」（真 PG） ────────────────────────
  assert.equal(await limitsAsync.watchedGroupHitAsync(UIDS[1], u2[0].postId, opts), true, "已關注的群要命中");
  assert.equal(await limitsAsync.watchedGroupHitAsync(UIDS[1], u2[5].postId, opts), true);
  await seedListing(999901, { root: 88999, uid: UIDS[1] });
  assert.equal(await limitsAsync.watchedGroupHitAsync(UIDS[1], 999901, opts), false, "沒被關注的群不得命中");
  await seedListing(999902, { root: null, uid: UIDS[1] });
  assert.equal(await limitsAsync.watchedGroupHitAsync(UIDS[1], 999902, opts), false, "NULL root 的孤列自己一群");
  // 確認下架的那一筆（U1 的第五筆）不得讓它的群命中
  assert.equal(await limitsAsync.watchedGroupHitAsync(UIDS[0], u1[4].postId, opts), false, "確認下架不佔配額，也不算已關注");

  // ── ④ canAddWatch 邊界：滿 6 群 ⇒ 同群 ok、新群擋（兩版同一個 verdict） ──
  // 兩邊的靶要對稱：PG 與 SQLite 都要有這兩個「要被判斷的新列」。
  const addLitePost = (postId, root) => sqlite
    .prepare("INSERT INTO listings(post_id, offline_confirmed, fold_component_root) VALUES (?,0,?)")
    .run(postId, root);
  await seedListing(999903, { root: 88100, uid: UIDS[1] }); // 與 u2[0] 同群
  addLitePost(999901, 88999);
  addLitePost(999903, 88100);
  const pgSame = limits.watchGateVerdict({
    limit: 6,
    count: await limitsAsync.countWatchedAsync(UIDS[1], opts),
    alreadyWatched: false,
    groupHit: await limitsAsync.watchedGroupHitAsync(UIDS[1], 999903, opts),
  });
  const liteSame = limits.canAddWatch(sqlite, UIDS[1], { role: "member", plan: "free" }, { postId: 999903 });
  assert.equal(pgSame.ok, true, "滿 6 群時加同群成員要放行（不增量）");
  assert.equal(pgSame.count, 6);
  assert.deepEqual(liteSame, pgSame, "SQLite 與 PG 的 verdict 必須一致（同一條規則）");

  const pgNew = limits.watchGateVerdict({
    limit: 6,
    count: await limitsAsync.countWatchedAsync(UIDS[1], opts),
    alreadyWatched: false,
    groupHit: await limitsAsync.watchedGroupHitAsync(UIDS[1], 999901, opts),
  });
  const liteNew = limits.canAddWatch(sqlite, UIDS[1], { role: "member", plan: "free" }, { postId: 999901 });
  assert.equal(pgNew.ok, false, "滿 6 群時加新群要被擋");
  assert.match(pgNew.error, /6 筆/);
  assert.deepEqual(liteNew, pgNew, "SQLite 與 PG 的 verdict 必須一致（同一條規則）");

  // ── ⑤ 欄位未部署的真 PG（CI 的拋棄式 PG、007 之前的正式庫）────────────────
  // 2026-10-14 的 CI 紅燈：群口徑那一句在**交易內**失敗 ⇒ `current transaction is aborted`，
  // catch 之後再送舊口徑也一樣炸，還連坐同一交易裡後面所有語句。所以產品碼改成「先探測欄位
  // 在不在，再決定送哪一句」。這裡就照那個失敗形狀驗一次：把自己的欄位拿掉（**只動這個
  // 隔離庫**，收尾整庫 DROP），在一個交易裡跑完整條路徑，再送第二句證明交易還活著。
  await pgDriver.query("ALTER TABLE listings DROP COLUMN fold_component_root");
  limits.resetFoldColumnProbe();
  const legacyCount = await pgDriver.withTransaction(async (client) => {
    const tx = async (sql, params = []) => (await client.query(toPostgresSql(sql), params)).rows;
    const n = await limitsAsync.countWatchedAsync(UIDS[0], { driver: "postgres", exec: tx, strict: true });
    // 若前一句把交易 abort 了，這一句會丟 `current transaction is aborted`
    await client.query("SELECT 1 AS still_alive");
    return n;
  });
  assert.equal(legacyCount, 4, "沒有分組鍵 ⇒ 舊口徑：U1 的 4 筆未確認下架（同群那兩筆各算一次）");
  assert.equal(await limitsAsync.watchedGroupHitAsync(UIDS[1], u2[0].postId, opts), false,
    "欄位不在 ⇒ 沒有分組鍵 ⇒ 一律當新群（維持改動前的行為）");
  const legacyBatch = await limitsAsync.countWatchedBatchAsync([UIDS[0], UIDS[1]], opts);
  assert.equal(legacyBatch.get(UIDS[0]), 4, "批次版同一口徑");
  assert.equal(legacyBatch.get(UIDS[1]), 6, "批次版同一口徑（U2 六筆各自一群）");

  // 收尾自我檢查：這一支只碰自己的資料庫。
  const who = (await pgDriver.query("SELECT current_database() AS db")).rows[0];
  assert.equal(who.db, DB_NAME);
  assert.ok(sqliteHandle(), "SQLite 只是 DDL 來源，不改它");
});
