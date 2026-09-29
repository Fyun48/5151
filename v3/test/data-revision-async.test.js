// 變更紀錄（data revision）讀取 PG 分支的 parity（2026-09-28，第四十九批）。
//
// 涵蓋的路由：`GET /api/events/revision`。
//
// 這一包要釘住四件事：
//
//   1. **`currentRevision()` 是 `MAX(id)` 不是 `COUNT(*)`**：兩者在「有刪除或缺號」時不同
//      （本系列踩過 identity 序列落後那一類問題，`MAX` 才是「客戶端追到哪裡」的語意）。
//   2. **`changesSince()` 的界線是「嚴格大於」**（`id > ?`）：客戶端會把上次拿到的 revision
//      原封不動送回來，用 `>=` 會讓同一筆重複送。
//   3. **排序是 id ASC**（客戶端依序套用變更，順序錯了會套出不同結果）。
//   4. **上限是共用政策**（1..5000）：parity 抓不到「兩邊一起改壞」，所以要對值本身下斷言。
//
// ⚠️ 這一支的寫入端**已經是 driver-aware**（PG 模式走 `createWritePath.bumpRevision`），
// 所以這一包只補讀取；live PG 測試會一起驗「寫進去、讀得到」。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-datarev-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/dataRevision.js");
const asyncMod = await import("../src/dataRevisionAsync.js");
const dbMod = await import("../src/db.js");

// ⚠️ `data_revision` 是**延遲建立**的（`ensureDataRevisionTable()` 由 db.js 在需要時呼叫），
// 所以測試要先把表建出來，夾具才鏡射得到 DDL。
syncMod.ensureDataRevisionTable(dbMod.sqliteHandle());

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
];

const TABLES = ["data_revision"];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
  }
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    rows.rowCount = Number(mem.prepare("SELECT changes() AS n").get().n) || 0;
    return rows;
  };
  exec.raw = mem;
  return exec;
}

function clearWorld(h) {
  h.prepare("DELETE FROM data_revision WHERE id >= 900000").run();
}

// 刻意留缺號（900002 不存在）：`MAX(id)` 與 `COUNT(*)` 才分得出來。
function seedRevisions(h) {
  h.prepare("INSERT INTO data_revision(id, entity_type, entity_id, event_type, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(900001, "listing", 11, "listing_added", 1000);
  h.prepare("INSERT INTO data_revision(id, entity_type, entity_id, event_type, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(900003, "listing", 12, "listing_updated", 1001);
  h.prepare("INSERT INTO data_revision(id, entity_type, entity_id, event_type, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(900004, "wish", null, "wish_added", 1002);
}

function resetBoth(seedFn) {
  const disk = handle();
  clearWorld(disk);
  const exec = pgFixture();
  clearWorld(exec.raw);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}

const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------

test("currentRevision：是 MAX(id) 不是 COUNT(*)（有缺號時分得出來）", async () => {
  const [disk, exec] = resetBoth(seedRevisions);
  const syncRev = syncMod.currentRevision(disk);
  const asyncRev = await asyncMod.currentRevisionAsync({ ...PG, exec, strict: true });
  assert.equal(asyncRev, syncRev, "兩邊必須相同");
  assert.equal(asyncRev, 900004, "必須是最大 id（否則這條測試沒有鑑別力）");
  assert.notEqual(asyncRev, 3, "不得是筆數（缺號讓 MAX 與 COUNT 不同）");
});

test("currentRevision：空表回 0（不是 null）", async () => {
  const [, exec] = resetBoth();
  assert.equal(syncMod.currentRevision(handle()), 0);
  assert.strictEqual(await asyncMod.currentRevisionAsync({ ...PG, exec, strict: true }), 0);
});

test("changesSince：嚴格大於、id ASC、逐列逐鍵相同", async () => {
  const [disk, exec] = resetBoth(seedRevisions);
  for (const [since, why] of [[0, "從頭"], [900001, "跨過第一筆"], [900003, "只到第二筆"], [900004, "最後一筆之後"]]) {
    const syncRows = plain(syncMod.changesSince(disk, since, { limit: 500 }));
    const asyncRows = plain(await asyncMod.changesSinceAsync(since, { limit: 500 }, { ...PG, exec, strict: true }));
    assert.deepEqual(asyncRows, syncRows, `必須逐列逐鍵相同（${why}）`);
  }
  const fromFirst = plain(await asyncMod.changesSinceAsync(900001, { limit: 500 }, { ...PG, exec, strict: true }));
  assert.deepEqual(fromFirst.map((r) => r.id), [900003, 900004], "嚴格大於：第一筆不得再出現，而且由小到大");
  const all = plain(await asyncMod.changesSinceAsync(0, { limit: 500 }, { ...PG, exec, strict: true }));
  assert.deepEqual(all.map((r) => r.id), [900001, 900003, 900004], "由小到大（客戶端依序套用）");
  assert.deepEqual(
    Object.keys(all[0]).sort(),
    ["created_at", "entity_id", "entity_type", "event_type", "id"],
    "回傳的欄位必須是那五個",
  );
});

test("changesSince：上限是共用政策（1..5000）", async () => {
  // ⚠️ 共用政策的變異 parity 抓不到（兩邊一起被改壞），所以直接對值下斷言。
  assert.equal(syncMod.CHANGES_SINCE_MAX, 5000, "上限常數必須是 5000");
  const [disk, exec] = resetBoth(seedRevisions);
  // 超過上限的請求要被夾住（不是原封不動送進 SQL）。
  // ⚠️ 只看回傳列數殺不死「不夾上限」的變異（資料只有 3 筆）——要**直接看送進 SQL 的參數**。
  const seen = [];
  const spying = async (sql, params = []) => { seen.push({ sql: String(sql), params }); return exec(sql, params); };
  await asyncMod.changesSinceAsync(0, { limit: 999999 }, { ...PG, exec: spying, strict: true });
  const limitParam = seen.at(-1)?.params?.[1];
  assert.equal(limitParam, 5000, `送進 SQL 的 LIMIT 必須被夾在 5000（實際 ${limitParam}）`);
  const syncRows = plain(syncMod.changesSince(disk, 0, { limit: 999999 }));
  const asyncRows = plain(await asyncMod.changesSinceAsync(0, { limit: 999999 }, { ...PG, exec, strict: true }));
  assert.deepEqual(asyncRows, syncRows, "被夾住之後兩邊必須相同");
  assert.equal(asyncRows.length, 3, "三筆都在（上限 5000 遠大於 3）");
  // limit 0／未給 → 預設 500（三筆都在，行為相同）
  assert.deepEqual(
    plain(await asyncMod.changesSinceAsync(0, {}, { ...PG, exec, strict: true })),
    plain(syncMod.changesSince(disk, 0, {})),
    "未給 limit 時兩邊相同",
  );
});

test("非 postgres 模式必須走同步路徑（不碰傳入的 exec）", async () => {
  const [disk, exec] = resetBoth(seedRevisions);
  let touched = 0;
  const counting = async (sql, params = []) => { touched += 1; return exec(sql, params); };
  const rev = await asyncMod.currentRevisionAsync({ driver: "sqlite", exec: counting });
  const rows = await asyncMod.changesSinceAsync(0, { limit: 500 }, { driver: "sqlite", exec: counting });
  assert.equal(touched, 0, "SQLite 模式不得碰 PG runner");
  assert.equal(rev, syncMod.currentRevision(disk));
  assert.deepEqual(plain(rows), plain(syncMod.changesSince(disk, 0, { limit: 500 })));
});

// ⚠️ 這一條要放在最後：它會把本機的 `data_revision` 暫時砍掉再還原。
test("ensureDataRevisionStoreOnce：本機還沒有那張表時，仍要建出**完整欄位**（不是零欄表）", async () => {
  // 🚨 這正是 CI 拋棄式資料庫 ＋ 全新 DATA_DIR 的狀態：`data_revision` 是**延遲建立**的表，
  // 而 `ensurePgSchema()` 從「沒有那張表」的來源鏡射，會產生**零欄的
  // `CREATE TABLE IF NOT EXISTS data_revision ()`**，PostgreSQL 照收 ⇒
  // 之後每一句都變成 42703（`column "entity_type" does not exist`）而不是 42P01，
  // 極難回推。2026-09-28 在 CI 上實際中過（PR #547 第一次跑）。
  const h = handle();
  h.exec("DROP TABLE IF EXISTS data_revision");
  try {
    const ddl = [];
    const fakePg = {
      exec: async (sql) => { ddl.push(String(sql)); },
      query: async () => ({ rows: [], rowCount: 0 }),
    };
    await asyncMod.ensureDataRevisionStoreOnce(fakePg);
    const create = ddl.find((sql) => /^CREATE TABLE/i.test(sql)) || "";
    assert.ok(create, `必須送出一句 CREATE TABLE（實際：${JSON.stringify(ddl)}）`);
    for (const col of ["id", "entity_type", "entity_id", "event_type", "created_at"]) {
      assert.match(create, new RegExp(`\\b${col}\\b`), `建表語句必須包含 ${col}：${create}`);
    }
    assert.doesNotMatch(create, /\(\s*\)/, "不得是零欄表");
    // 來源（本機）那張表本身也要被補回來：同步版每個入口都會先做這件事。
    assert.equal(syncMod.currentRevision(h), 0, "補回來之後是空表，revision 應為 0");
  } finally {
    syncMod.ensureDataRevisionTable(h);
  }
});
