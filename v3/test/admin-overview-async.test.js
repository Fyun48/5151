// 後台總覽：來源健康度的 PG 分支 parity（2026-09-27）。
//
// 背景：`sourceListingStats()` 是 `adminOverview.js` 裡對 `listings` 的**原始 db.prepare**，
// 所以 `/api/admin/crawl-sources` 即使設定讀寫搬到 PG，仍會從節點本機 SQLite 讀健康度。
// 這是在對照表上那兩條一直停在 MIXED 的原因。
//
// 兩個聚合查詢的 SQL 與同步版逐字相同，回傳形狀也相同（Map<source, ...>）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-admin-overview-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const { sourceListingStats } = await import("../src/adminOverview.js");
const { sourceListingStatsAsync } = await import("../src/adminOverviewAsync.js");

const PG = { driver: "postgres" };

// 最後一列的 first_seen_at 用「現在」，todayNew 才會有資料——
// 第一版全部放在過去，於是 todayNew 永遠是空的，斷言 typeof === 'number' 就失敗了。
const ROWS = [
  { post_id: 1, source: "591", last_seen_at: "2026-09-27T01:00:00.000Z", first_seen_at: "2026-09-01T00:00:00.000Z" },
  { post_id: 2, source: "591", last_seen_at: "2026-09-26T01:00:00.000Z", first_seen_at: "2026-09-20T00:00:00.000Z" },
  { post_id: 3, source: "sinyi", last_seen_at: "2026-09-25T01:00:00.000Z", first_seen_at: "2026-09-26T00:00:00.000Z" },
  { post_id: 4, source: "591", last_seen_at: new Date().toISOString(), first_seen_at: new Date().toISOString() },
];

function pgFixture(rows = ROWS) {
  const mem = new DatabaseSync(":memory:");
  mem.exec("CREATE TABLE listings (post_id INTEGER PRIMARY KEY, source TEXT, last_seen_at TEXT, first_seen_at TEXT)");
  const ins = mem.prepare("INSERT INTO listings(post_id,source,last_seen_at,first_seen_at) VALUES (?,?,?,?)");
  for (const r of rows) ins.run(r.post_id, r.source, r.last_seen_at, r.first_seen_at);
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

test("PG 分支要依 source 分組算出 lastSeen 與 todayNew", async () => {
  const exec = pgFixture();
  const { lastSeen, todayNew } = await sourceListingStatsAsync({ ...PG, exec });
  // 期望值從資料推導，不要硬編——第一版硬編了字串，後來加一列資料就失效了。
  const maxFor = (src) => ROWS.filter((r) => r.source === src).map((r) => r.last_seen_at).sort().pop();
  assert.equal(lastSeen.get("591"), maxFor("591"), "591 的 lastSeen 應取最大值");
  assert.equal(lastSeen.get("sinyi"), maxFor("sinyi"));
  assert.ok(todayNew instanceof Map, "todayNew 必須是 Map（與同步版形狀相同）");
  assert.equal(todayNew.get("591"), 1, "今天首次看到的 591 房源應計為 1");
  assert.equal(todayNew.get("sinyi"), undefined, "沒有新進的 sinyi 房源");
});

test("parity：與同步版在相同資料上必須得到相同的 lastSeen 與 todayNew", async () => {
  const exec = pgFixture();
  // 把同一批資料寫進真正的 SQLite（listings 由 db.js 開機時建立）
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"));
  const cols = disk.prepare("PRAGMA table_info(listings)").all().map((c) => c.name);
  assert.ok(cols.includes("source") && cols.includes("last_seen_at") && cols.includes("first_seen_at"),
    "listings 必須有這三個欄位，否則這個 parity 測試沒有意義");
  disk.prepare("DELETE FROM listings").run();
  // listings 還有其他 NOT NULL 且沒有預設值的欄位（例如 source_key），
  // 所以不能只寫四個欄位——動態把它們補成 0 或空字串。
  const info = disk.prepare("PRAGMA table_info(listings)").all();
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const provided = new Set(["post_id", "source", "last_seen_at", "first_seen_at"]);
  const names = info.map((c) => c.name).filter((n) => provided.has(n) || required.some((c) => c.name === n));
  const stmt = disk.prepare(`INSERT INTO listings(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`);
  for (const r of ROWS) {
    stmt.run(...names.map((n) => {
      if (provided.has(n)) return r[n];
      const col = info.find((c) => c.name === n);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
  }
  disk.close();

  const sync = sourceListingStats();
  const asyncOut = await sourceListingStatsAsync({ ...PG, exec });
  assert.deepEqual([...asyncOut.lastSeen.entries()].sort(), [...sync.lastSeen.entries()].sort(), "lastSeen 必須相同");
  assert.deepEqual([...asyncOut.todayNew.entries()].sort(), [...sync.todayNew.entries()].sort(), "todayNew 必須相同");
});

test("讀不到資料時要吞掉錯誤並回空 Map（與同步版相同的容忍度）", async () => {
  const exec = async () => { throw new Error("listings 沒有那個欄位"); };
  const { lastSeen, todayNew } = await sourceListingStatsAsync({ ...PG, exec });
  assert.equal(lastSeen.size, 0);
  assert.equal(todayNew.size, 0);
});

// SQLite 退場 P2：後台總覽的 PG 路徑帶 `strict: true`——同一個函式不可以再把失敗吞成空的 Map
// （空 Map ⇒ 每個來源的 todayNew 顯示 0，那正是「靜默顯示 0」的缺陷）。
test("strict: true 時 PG 讀不到要把錯誤往上丟，不可以回空 Map", async () => {
  const exec = async () => { throw new Error("PG 讀不到 listings"); };
  await assert.rejects(
    () => sourceListingStatsAsync({ ...PG, exec, strict: true }),
    /PG 讀不到 listings/,
  );
});
