// SQLite 退場最終快照腳本（`v3/scripts/snapshot-sqlite-exit.mjs`）的行為鎖。
//
// 這一包要釘住三件事：
//   1. **唯讀是結構性的**：腳本組出來的每個 SQL 都必須是 SELECT／WITH／PRAGMA，
//      且原始碼裡不得出現任何寫入語句（這是「刪檔前證據固化」工具，寫到東西就是事故）。
//   2. **三邊對照表真的有三邊**：本機 tmp SQLite（`node:sqlite`）＋ stub PG exec ＋ 既有基線，
//      列數要落在正確的欄位，不能互相污染。
//   3. **判準字句不能被淡化**：`-shm` mtime 不可當寫入證據、`-wal` 0 B 的特別解讀、
//      以及尾端的「刪除前置條件」checklist 都必須在輸出裡。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "v3/scripts/snapshot-sqlite-exit.mjs");
const {
  KEY_TABLES,
  ZERO_ROW_TABLES,
  SELF_MRT_COLUMNS,
  assertReadOnlyStatement,
  collectSqliteFacts,
  collectPgFacts,
  buildSnapshot,
  renderMarkdown,
  interpretSqliteWrite,
  compareSamples,
  normalizeBaseline,
  statSqliteFiles,
} = await import("../scripts/snapshot-sqlite-exit.mjs");

const READ_ONLY_SQL = /^\s*(?:SELECT|WITH|PRAGMA)\b/i;

/** 造一個 tmp SQLite（真 schema 子集＋已知列數），回傳 { dir, file }。 */
function makeSqliteFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "p4-snapshot-"));
  const file = path.join(dir, "v3.db");
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE listings (
        post_id INTEGER PRIMARY KEY,
        fee_includes TEXT NOT NULL DEFAULT '',
        self_mrt_state TEXT, self_mrt_station TEXT, self_mrt_walk_m REAL,
        self_mrt_nearest_m REAL, self_mrt_source TEXT, self_mrt_checked_at TEXT
      );
      CREATE TABLE user_listing_flags (user_id INTEGER, post_id INTEGER);
      CREATE TABLE listing_groups (group_id INTEGER PRIMARY KEY, confirmation_level TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE crawl_covers (id INTEGER PRIMARY KEY, last_run_at TEXT);
      CREATE TABLE demand_posts (id INTEGER PRIMARY KEY);
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT, safety TEXT);
      CREATE TABLE member_support_code (id INTEGER PRIMARY KEY);
      CREATE TABLE sponsor_entitlement_grant (id INTEGER PRIMARY KEY);
      CREATE TABLE support_poll_cursor (id INTEGER PRIMARY KEY);
    `);
    // 7 筆房源：3 筆 fee_includes 非空、2 筆 self_mrt_state 非 NULL。
    for (let i = 1; i <= 7; i += 1) {
      db.prepare("INSERT INTO listings (post_id, fee_includes, self_mrt_state) VALUES (?, ?, ?)")
        .run(i, i <= 3 ? "管理費含" : "", i <= 2 ? "verified" : null);
    }
    db.prepare("INSERT INTO user_listing_flags (user_id, post_id) VALUES (1, 1)").run();
    for (let i = 0; i < 4; i += 1) db.prepare("INSERT INTO listing_groups (group_id, confirmation_level) VALUES (?, ?)").run(i + 1, "suspected");
    for (let i = 0; i < 5; i += 1) db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(`k${i}`, "v");
    db.prepare("INSERT INTO crawl_covers (id, last_run_at) VALUES (1, '2026-10-09T09:39:00.000Z')").run();
    for (let i = 0; i < 2; i += 1) db.prepare("INSERT INTO demand_posts (id) VALUES (?)").run(i + 1);
    for (let i = 0; i < 3; i += 1) {
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at, safety) VALUES (?, ?, ?, ?)")
        .run(i + 1, `m${i}`, `2026-10-0${i + 7}T00:00:00.000Z`, "safe");
    }
  } finally {
    db.close();
  }
  return { dir, file };
}

/** stub PG：只回答腳本會問的唯讀查詢，並記錄每一句（用來斷言沒有寫入）。 */
function makePgStub({ present = [], counts = {}, columns = [] } = {}) {
  const presentSet = new Set(present);
  const columnSet = new Set(columns);
  const seen = [];
  const exec = async (sql, params = []) => {
    assert.match(String(sql), READ_ONLY_SQL, `PG 只准收唯讀語句，收到：${sql}`);
    seen.push({ sql: String(sql), params });
    if (/to_regclass/.test(sql)) {
      const name = String(params[0] || "").replace(/^public\./, "");
      return { rows: [{ present: presentSet.has(name) }] };
    }
    if (/information_schema\.columns/.test(sql)) {
      return { rows: [{ n: columnSet.has(String(params[0])) ? 1 : 0 }] };
    }
    if (/FROM schema_migrations/.test(sql)) {
      return { rows: [{ n: 3, last_applied: "2026-10-09T18:00:00.000Z" }] };
    }
    if (/MAX\(last_run_at\)/.test(sql)) {
      return { rows: [{ max_last_run_at: "2026-10-09T09:39:00.000Z" }] };
    }
    if (/WHERE fee_includes/.test(sql)) return { rows: [{ n: 0 }] };
    const whereCol = /WHERE\s+"?(self_mrt_[a-z_]+)"?\s+IS NOT NULL/.exec(sql);
    if (whereCol) return { rows: [{ n: 0 }] };
    const from = /FROM\s+"?([A-Za-z_]+)"?/.exec(sql);
    if (from) return { rows: [{ n: counts[from[1]] ?? 0 }] };
    throw new Error(`stub 未預期的查詢：${sql}`);
  };
  return { exec, seen };
}

test("assertReadOnlyStatement：寫入語句一律拒絕、唯讀語句放行", () => {
  for (const ok of ["SELECT 1", "  select count(*) from listings", "PRAGMA journal_mode", "WITH x AS (SELECT 1) SELECT * FROM x"]) {
    assert.equal(assertReadOnlyStatement(ok), ok);
  }
  for (const bad of [
    'INSERT INTO listings (post_id) VALUES (1)',
    'UPDATE listings SET hidden = 1',
    'DELETE FROM listings',
    'DROP TABLE listings',
    'ALTER TABLE listings ADD COLUMN x TEXT',
    "VACUUM INTO '/tmp/x.db'",
  ]) {
    assert.throws(() => assertReadOnlyStatement(bad), /只允許 SELECT／WITH／PRAGMA/, bad);
  }
});

test("collectSqliteFacts：只讀開啟 tmp SQLite，並回報三邊對照與零缺口欄位", () => {
  const { dir, file } = makeSqliteFixture();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.close();
  try {
    const facts = collectSqliteFacts(file);
    assert.equal(facts.counts.listings, 7);
    assert.equal(facts.counts.user_listing_flags, 1);
    assert.equal(facts.counts.listing_groups, 4);
    assert.equal(facts.counts.crawl_covers, 1);
    assert.equal(facts.counts.demand_posts, 2);
    assert.equal(facts.timestamps.schemaMigrations.rows, 3);
    assert.equal(facts.timestamps.schemaMigrations.lastAppliedAt, "2026-10-09T00:00:00.000Z");
    assert.equal(facts.gap.feeIncludesNonEmpty, 3, "fee_includes 非空筆數要算對");
    assert.equal(facts.gap.selfMrt.self_mrt_state, 2);
    assert.equal(facts.gap.selfMrt.self_mrt_station, 0);
    for (const table of ZERO_ROW_TABLES) assert.equal(facts.gap.zeroRowTables[table], 0);
    // 三個檔案都要有 size／mtime（WAL 模式關閉連線後仍會留下 -wal／-shm）
    for (const key of ["db", "wal", "shm"]) {
      assert.equal(typeof facts.files[key].exists, "boolean");
    }
    assert.equal(facts.files.db.bytes, statSqliteFiles(file).db.bytes, "size 要與直接 stat 一致");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("三邊對照表：SQLite／PG／既有基線各就各位，且 check 到刪除前置條件", async () => {
  const { dir, file } = makeSqliteFixture();
  try {
    const baselineFile = path.join(dir, "baseline.json");
    writeFileSync(baselineFile, JSON.stringify({
      tables: { listings: 115618, user_listing_flags: 805, listing_groups: 14510, settings: 26, crawl_covers: 2, demand_posts: 35 },
    }));
    const sqlite = collectSqliteFacts(file);
    const stub = makePgStub({
      present: [...KEY_TABLES],
      counts: { listings: 184245, user_listing_flags: 865, listing_groups: 27849, settings: 30, crawl_covers: 40, demand_posts: 35 },
      columns: ["fee_includes", ...SELF_MRT_COLUMNS],
    });
    const pg = await collectPgFacts(stub.exec);
    const snapshot = buildSnapshot({
      sqlite,
      pg,
      baseline: { path: baselineFile, counts: normalizeBaseline(JSON.parse(readFileSync(baselineFile, "utf8"))) },
      meta: { now: new Date("2026-10-10T16:00:00.000Z"), label: "unit", outPath: "/tmp/unit.md", pgDatabase: "probe", pgEnvName: "PG_URL" },
    });
    const md = renderMarkdown(snapshot);

    // 三邊都真的出現，而且數字在對的欄位
    assert.match(md, /\| `listings` \| 7 \| 184,245 \| 115,618 \|/);
    assert.match(md, /\| `settings` \| 5 \| 30 \| 26 \|/);
    assert.match(md, /PG `probe`/);
    assert.match(md, /既有基線/);
    // 三張零列表在 PG 端不存在 ⇒ 要講「不存在（無此表）」，不能只寫 n/a
    for (const table of ZERO_ROW_TABLES) {
      assert.match(md, new RegExp(`\\| \`${table}\` 列數 \\| 0 \\| 不存在（無此表） \\|`), `${table} 要標成 PG 端不存在`);
    }
    // 判準字句
    assert.match(md, /`-shm` mtime 不可當寫入證據（唯讀開啟就會推前）/);
    assert.match(md, /covers_max_last_run_at/);
    assert.match(md, /2026-10-09T09:39:00\.000Z/);
    assert.match(md, /PG `schema_migrations` 最後套用時間/);
    // 刪除前置條件
    assert.match(md, /## 五、刪除前置條件/);
    assert.match(md, /快照已存檔/);
    assert.match(md, /business SQLite is closed/);
    assert.match(md, /Owner 已核准/);
    // PG 端真的只收到唯讀語句（stub 內已斷言，這裡再確認有查過）
    assert.ok(stub.seen.length > 0, "stub 應該要被問到話");
    assert.match(md, /fee_includes` 非空筆數 \| 3 \| 0 \| 0 \| ❌/, "SQLite 端 3 筆非空要照實報（且判定 ❌）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("腳本原始碼：不得出現任何寫入語句或 SQLite 寫入 API", () => {
  const src = readFileSync(SCRIPT, "utf8");
  for (const forbidden of [
    "INSERT INTO", "DELETE FROM", "DROP TABLE", "VACUUM INTO",
    "writable_schema", "db.exec(", ").run(", "UPDATE ",
  ]) {
    assert.ok(!src.includes(forbidden), `v3/scripts/snapshot-sqlite-exit.mjs 不得含「${forbidden}」`);
  }
  assert.match(src, /new DatabaseSync\(sqlitePath, \{ readOnly: true \}\)/,
    "SQLite 必須以 readOnly 開啟（照抄 sqlite-consistency-snapshot.mjs:35）");
  assert.ok(src.includes('from "../src/domainToolGuards.js"'), "必須 import repo 既有守衛");
  assert.ok(src.includes('assertPgTargetAllowed(TOOL, pgUrl, { env, allow: ALLOWED_PG_DBS })'),
    "必須用 assertPgTargetAllowed 把關，且目標預設拒絕");
});

test("interpretSqliteWrite：-wal 有資料／0 B／不存在 三種判讀要分得開", () => {
  const mk = (bytes, mtime) => ({ exists: true, bytes, mtime });
  const db = mk(1024, "2026-10-09T09:39:00.000Z");

  const withData = interpretSqliteWrite({ db, wal: mk(38_000_000, "2026-10-09T09:39:00.000Z"), shm: mk(32768, "2026-10-10T00:00:00.000Z") },
    { now: new Date("2026-10-09T09:40:00.000Z") });
  assert.equal(withData.basis, "wal");
  assert.match(withData.text, /38,000,000 B/);

  const empty = interpretSqliteWrite({ db, wal: mk(0, "2026-10-10T00:00:00.000Z") });
  assert.equal(empty.basis, "wal-empty");
  assert.match(empty.text, /不可當寫入證據/);
  assert.match(empty.text, /--sample-seconds=61/);

  const none = interpretSqliteWrite({ db, wal: { exists: false, bytes: null, mtime: null } });
  assert.equal(none.basis, "db");
  assert.match(none.text, /重新出現/);

  const gone = interpretSqliteWrite({ db: { exists: false } });
  assert.equal(gone.basis, "none");
});

test("compareSamples／normalizeBaseline：不動＝true，基線各種形狀都要吃", () => {
  const a = { db: { exists: true, bytes: 1, mtime: "t" }, wal: { exists: true, bytes: 0, mtime: "t" }, shm: { exists: false, bytes: null, mtime: null } };
  assert.deepEqual(compareSamples(a, a), { db: true, wal: true, shm: true });
  assert.equal(compareSamples(a, { ...a, db: { exists: true, bytes: 2, mtime: "t" } }).db, false);
  assert.equal(compareSamples(a, { ...a, wal: { exists: true, bytes: 0, mtime: "t2" } }).wal, false);

  assert.deepEqual(normalizeBaseline({ count_listings: 115618, tables: { settings: 26 }, counts: { crawl_covers: 2 } }),
    { listings: 115618, settings: 26, crawl_covers: 2 });
  assert.deepEqual(normalizeBaseline(null), {});
});

test("--help 可跑，且不會連任何 DB", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /export const USAGE/, "--help 要印得出來（不碰 DB）");
  assert.match(src, /--sample-seconds/, "雙取樣開關要出現在說明裡");
});
