// 「清除物件紀錄／清除全部資料」PG 分支的 parity（2026-09-29 第七十三批）。
//
// 這一組最在意的是**刪到哪一個 store**：同步版把 DELETE 全下在本機 SQLite，PG 模式下站上
// （讀 PG）什麼都沒清掉、畫面卻回「已清除」。所以每一條都把「PG 夾具」與「本機」分開看。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-sitereset-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const resetAsync = await import("../src/siteResetAsync.js");
const PG = { driver: "postgres" };

// `saveSettingsAsync()` 會連帶寫 `user_search_profiles`（搜尋設定檔），所以夾具也要有那張表。
const TABLES = [
  "users", "events", "user_events", "user_listing_flags", "user_settings", "crawl_covers",
  "listings", "settings", "geo_cache", "route_cache", "community_cache", "user_search_profiles",
];
const UID = 900000007001;

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true });
  for (const table of TABLES) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  disk.close();
  const exec = async (sql, params = []) => mem.prepare(String(sql)).all(...params);
  exec.raw = mem;
  return exec;
}

// 「有資料」的種子：每一張會被刪的表都放一列（`listings` 是寬表，用 PRAGMA 補必要欄位）。
function seedRows(handle) {
  handle.prepare("INSERT OR REPLACE INTO users(id, email, role, plan, created_at) VALUES (?,?,?,?,?)")
    .run(UID, "reset@example.test", "admin", "free", "2026-01-01T00:00:00.000Z");
  // `events` 是站台層級的活動列（沒有 user_id）；`user_events` 才是有 user_id 的那張。
  handle.prepare("INSERT INTO events(post_id, source_key, type, title, created_at) VALUES (?,?,?,?,?)")
    .run(970001, "1|8|970001", "new", "t", "2026-01-01T00:00:00.000Z");
  handle.prepare("INSERT INTO user_events(user_id, post_id, type, title, created_at) VALUES (?,?,?,?,?)")
    .run(UID, 970001, "new", "t", "2026-01-01T00:00:00.000Z");
  handle.prepare("INSERT INTO user_listing_flags(user_id, post_id) VALUES (?,?)").run(UID, 970001);
  handle.prepare("INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?)")
    .run(UID, "intervalMinutes", JSON.stringify(30));
  // 另一個會員的設定列：`reset-all` 之後**不得**還在（補丁只會寫回預設使用者自己的鍵）。
  handle.prepare("INSERT OR REPLACE INTO users(id, email, role, plan, created_at) VALUES (?,?,?,?,?)")
    .run(UID + 1, "reset-other@example.test", "member", "free", "2026-01-01T00:00:00.000Z");
  handle.prepare("INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?)")
    .run(UID + 1, "otherKey", JSON.stringify(1));
  handle.prepare("INSERT INTO crawl_covers(region_id, section_ids, created_at) VALUES (?,?,?)")
    .run(1, JSON.stringify([8]), "2026-01-01T00:00:00.000Z");
  // 每一條測試都重新種；`settings` 可能已被前一條測試寫過 ⇒ 用 upsert（`hasBaseline` 是主鍵）。
  handle.prepare("INSERT INTO settings(key, value) VALUES ('hasBaseline', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  handle.prepare("INSERT INTO geo_cache(address, lat, lng, updated_at) VALUES ('台北市', 25, 121, '2026-01-01T00:00:00.000Z')").run();
  handle.prepare("INSERT INTO route_cache(route_key, distances, min_km, updated_at) VALUES ('k', '[]', 1, '2026-01-01T00:00:00.000Z')").run();
  handle.prepare("INSERT INTO community_cache(community_id, updated_at) VALUES (1, '2026-01-01T00:00:00.000Z')").run();
  const info = handle.prepare("PRAGMA table_info(listings)").all();
  const provided = { post_id: 970001, source: "591", title: "t" };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO listings(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => (n in provided ? provided[n] : (/INT|REAL|NUM/i.test(info.find((c) => c.name === n).type) ? 0 : ""))));
}

const countOf = (handle, table) => Number(handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) || 0;

function resetBoth() {
  const disk = dbMod.sqliteHandle();
  for (const table of ["listings", "user_events", "events", "user_listing_flags", "user_settings", "crawl_covers", "community_cache", "route_cache", "geo_cache"]) {
    disk.prepare(`DELETE FROM ${table}`).run();
  }
  seedRows(disk);
  const exec = pgFixture();
  seedRows(exec.raw);
  return [disk, exec];
}

test("清除物件紀錄：PG 分支刪的是 PG 的表（本機不動），並寫回 hasBaseline", async () => {
  const [disk, exec] = resetBoth();
  const settings = await resetAsync.resetListingsAsync({ ...PG, exec, strict: true });
  assert.equal(settings?.hasBaseline, false, "回傳的設定要帶 hasBaseline:false（與同步版相同）");
  for (const table of ["events", "user_events", "user_listing_flags", "listings"]) {
    assert.equal(countOf(exec.raw, table), 0, `PG 的 ${table} 要被清空`);
  }
  assert.equal(countOf(disk, "listings"), 1, "PG 模式不得動到本機那一份");
  // 會員本身不能被刪（清除物件紀錄不是清會員）。⚠️ 列數可能 >1：`saveSettingsAsync()` 會透過
  // `defaultUserIdAsync()` 確保預設管理員存在（與同步版的 `defaultUserId()` 同義）。
  assert.equal(exec.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(UID).n, 1, "原本的會員要留著");
  assert.equal(countOf(exec.raw, "settings") >= 1, true, "設定要留著（只有 hasBaseline 被改寫）");
});

test("清除全部資料：PG 分支十張表全清，並把設定寫回預設值", async () => {
  const [disk, exec] = resetBoth();
  const settings = await resetAsync.resetAllDataAsync({ ...PG, exec, strict: true });
  for (const table of ["events", "user_events", "user_listing_flags", "crawl_covers", "listings", "geo_cache", "route_cache", "community_cache"]) {
    assert.equal(countOf(exec.raw, table), 0, `PG 的 ${table} 要被清空`);
  }
  // `user_settings` 會被清空**再寫回補丁**（預設使用者那幾鍵）；其他會員的列必須不見。
  assert.equal(exec.raw.prepare("SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?").get(UID + 1).n, 0,
    "其他會員的設定列要被清掉（補丁只會寫回預設使用者）");
  assert.equal(countOf(exec.raw, "user_settings") > 0, true, "補丁要把預設使用者的設定寫回來");
  // `settings` 先被清空、再寫回補丁（所以不是 0 列，而是補丁那幾列）。
  const siteRows = new Map(exec.raw.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  assert.equal(JSON.parse(siteRows.get("hasBaseline")), false, "站台層級的 hasBaseline 要寫回 false");
  assert.equal(siteRows.has("dataEpoch"), true, "dataEpoch 要寫回（前端靠它判斷要不要重載）");
  // 會員層級的鍵（`commuteKm`…）走 `user_settings`——`saveSettings()` 就是這樣分流的。
  const userCommute = exec.raw.prepare("SELECT value FROM user_settings WHERE key = 'commuteKm'").get();
  assert.ok(userCommute, "補丁的會員層級鍵要寫回 user_settings");
  assert.equal(JSON.parse(userCommute.value), 0);
  assert.equal(settings?.hasBaseline, false);
  assert.equal(countOf(disk, "listings"), 1, "PG 模式不得動到本機那一份");
  assert.equal(exec.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(UID).n, 1, "會員不得被刪");
});

test("非 postgres 模式：兩支都回退同步版（寫本機、不碰 PG 夾具）", async () => {
  const [disk, exec] = resetBoth();
  await resetAsync.resetListingsAsync({ driver: "sqlite", exec });
  assert.equal(countOf(disk, "listings"), 0, "sqlite 模式要清本機");
  assert.equal(countOf(exec.raw, "listings"), 1, "sqlite 模式不得碰 PG 夾具");
  // reset-all 也一樣
  await resetAsync.resetAllDataAsync({ driver: "sqlite", exec });
  assert.equal(countOf(disk, "user_events"), 0);
  assert.equal(countOf(exec.raw, "user_events"), 1);
});

test("兩條路由都用 PG 島嶼（同步版不得再出現）", () => {
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  for (const [route, needle, sync] of [
    ['app.post("/api/reset-listings"', "await resetListingsAsync()", "resetListings("],
    ['app.post("/api/reset-all"', "await resetAllDataAsync()", "resetAllData("],
  ]) {
    const start = src.indexOf(route);
    assert.ok(start > 0, `找不到 ${route}`);
    const end = src.indexOf("\n});", start);
    const body = src.slice(start, end === -1 ? undefined : end + 4);
    assert.ok(body.includes(needle), `${route} 必須用 ${needle}`);
    assert.ok(!body.includes(sync), `${route} 不得再用同步的 ${sync}`);
  }
});

// ---------------------------------------------------------------------------
// live PG：在**拋棄式 schema** 內真的清空（`PG_TEST_URL` 由 CI 的 PG job 提供；本機指向影子站，
// 所以這裡絕不碰 public schema 的表）。
// ---------------------------------------------------------------------------
const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skipLive = PG_TEST_URL ? false : "PG_TEST_URL is not set (live site reset)";

test("live PostgreSQL：清除全部資料真的清空該 schema（且不動別的 schema）", { skip: skipLive }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { importStore } = await import("../src/pgSchema.js");
  const disk = dbMod.sqliteHandle();
  const schema = `pgreset_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 3, options: `-c search_path=${schema}`, application_name: "5151-site-reset" },
  });
  t.after(async () => {
    try { await pgDriver.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  const have = new Set(disk.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  const tables = TABLES.filter((name) => have.has(name));
  await importStore(pgDriver, disk, { schema, tables });
  const count = async (table) => Number((await pgDriver.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n) || 0;
  // 拋棄式 schema 是空的 ⇒ 先種一列（settings 一定有；listings 用 upsert 太麻煩，跳過它）。
  await pgDriver.query("INSERT INTO settings(key, value) VALUES ('hasBaseline', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  assert.equal(await count("settings") >= 1, true, "前置條件：schema 內有設定列");

  await resetAsync.resetAllDataAsync({ driver: "postgres", pgDriver, strict: true });
  for (const table of ["events", "user_events", "user_listing_flags", "crawl_covers", "geo_cache", "route_cache", "community_cache"]) {
    assert.equal(await count(table), 0, `${table} 要被清空`);
  }
  const site = new Map((await pgDriver.query("SELECT key, value FROM settings")).rows.map((row) => [row.key, row.value]));
  assert.equal(JSON.parse(site.get("hasBaseline")), false, "補丁要寫回 hasBaseline:false");
  // 別的 schema（public）不受影響：用一個只存在於 public 的系統目錄當對照。
  const publicTables = await pgDriver.query("SELECT COUNT(*) AS n FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(Number(publicTables.rows[0].n) > 0, true, "public schema 的表要還在（只清自己的 schema）");
});
