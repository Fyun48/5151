// 站台設定的讀取（系統爬蟲設定＋目錄快照）與兩個後台／公開讀取的 PG parity
// （2026-09-28，第四十四批）。
//
// 涵蓋的四條路由：
//   `GET  /api/public/wish-room/:id`      → `sharePageExtrasAsync`
//   `GET  /api/admin/system-crawl`        → `getSystemCrawlAsync` ＋ `refreshSiteCatalogStatsAsync`
//   `PUT  /api/admin/system-crawl`        → `saveSystemCrawlAsync`
//   `GET  /api/admin/listings/search`     → `searchAdminListingsAsync`
//
// 這一包要釘住五件事：
//
//   1. **只套用有給的欄位**：`PUT /api/admin/system-crawl` 的 partial patch 規則（五個鍵各自
//      判斷）最容易被寫成「整包覆蓋」——那會讓後台只切一個開關就把其他設定洗掉。
//   2. **後台改完要對爬蟲生效**：`systemCrawlFromRows()` 還有**同步**讀者
//      （爬蟲角色的 `crawlIntervalMinutes()`、`getSettings()` 的 system 區塊）。
//      ⚠️ SQLite 退場 P3（2026-10-10）：本來「PG 寫完本機也要寫同一組值」，但開閘
//      （`PG_NO_SQLITE_OPEN=1`）時那句鏡射會直接拋錯 ⇒ PG 已寫成功、使用者收到失敗。
//      鏡射已移除，PG 是唯一權威來源；本機的會員設定記憶體快取（`forgetSettings()`）仍然要清。
//   3. **目錄快照兩個 driver 要一致**：`buildSiteCatalogSnapshot()` 是共用的純函式，
//      但「列出」的來源不同（PG vs 本機）。快照原本也鏡射進本機 `settings.siteCatalogStats`
//      （同步的 `readSiteCatalogStats()` 在用），P3 一併移除；那個同步讀者由另一包改成 PG async 讀。
//   4. **`IFNULL` 是 SQLite 專屬**：後台刊登搜尋的 LIKE 那一段原本用 `IFNULL(address, '')`，
//      PG 沒有這個函式 ⇒ 共用常數改成 `COALESCE`（兩邊都有、行為相同）。
//   5. **旗標來源**：分享頁的 extras 是純函式，但旗標要來自 PG 的 settings。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-syscrawl-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const syncMod = await import("../src/adminOverview.js");
const asyncAdmin = await import("../src/adminOverviewAsync.js");
const asyncContent = await import("../src/siteContentAsync.js");
const asyncShare = await import("../src/rentalShareGrowthAsync.js");
const shareMod = await import("../src/rentalShareGrowth.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const OLD = "2026-01-01T00:00:00.000Z";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
];

const TABLES = ["users", "settings", "listings"];

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
  h.prepare("DELETE FROM settings WHERE key LIKE 'system%' OR key = 'siteCatalogStats' OR key = 'rentalMarketplaceFlags'").run();
  h.prepare("DELETE FROM listings WHERE post_id >= 800000").run();
  h.prepare("DELETE FROM users WHERE email LIKE 'syscrawl%@example.com'").run();
}

function seedUsers(h) {
  h.prepare(
    "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (1, 'syscrawl1@example.com', '管理員', 'admin', 'free', ?)",
  ).run(OLD);
  h.prepare("UPDATE users SET created_at = ? WHERE id = 1").run(OLD);
}

// `source_key` 的前兩段就是行政區鍵（`1-5` ＝ 台北市大安區），
// 所以用 `source_key` 就能控制「這筆刊登算不算在監看區裡」。
function seedListing(h, { id, source = "591", sourceKey = "1-5", address = "台北市大安區某路", title = "測試刊登" }) {
  h.prepare(
    `INSERT INTO listings(post_id, source_key, title, url, source, address, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sourceKey, title, `https://example.com/${id}`, source, address, OLD, OLD);
}

function setSetting(h, key, value) {
  h.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

const settingValue = (h, key) => h.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;

function resetBoth(seedFn) {
  const disk = handle();
  clearWorld(disk);
  seedUsers(disk);
  const exec = pgFixture();
  clearWorld(exec.raw);
  seedUsers(exec.raw);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}

const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------

test("分享頁 extras：純函式的結果要跟 PG 的旗標，而不是本機的", async () => {
  const [disk, exec] = resetBoth((h) => {
    setSetting(h, "rentalMarketplaceFlags", { wish: { public_share_v2_enabled: true, lifecycle_enabled: true } });
  });
  // 本機刻意寫成「分享 v2 關閉」：PG 版若讀本機旗標就會回 share_v2:false
  setSetting(disk, "rentalMarketplaceFlags", { wish: { public_share_v2_enabled: false } });

  const asyncExtras = await asyncShare.sharePageExtrasAsync({ ...PG, exec, strict: true });
  assert.deepEqual(
    asyncExtras,
    plain(shareMod.sharePageExtras({ wish: { public_share_v2_enabled: true, lifecycle_enabled: true } })),
    "PG 版必須用 PG 的旗標算出 extras",
  );
  assert.equal(asyncExtras.share_v2, true, "PG 說開啟就必須是開啟");
  assert.equal(asyncExtras.owner_cta_href, "/login?next=%2F%23post");
});

test("後台刊登搜尋：id／關鍵字／空字串／上限，兩個 driver 逐列相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedListing(h, { id: 800001, title: "總覽測試 101", source: "591" });
    seedListing(h, { id: 800002, title: "總覽測試 202", source: "self", sourceKey: "1-7" });
    // `address` 是 NULL：同步版原本用 `IFNULL(address,'')`，PG 版要用 `COALESCE` 才等價
    seedListing(h, { id: 800003, title: "沒有地址的刊登", address: null });
  });
  const cases = [
    { q: "800001", limit: 20, why: "用 post_id 查" },
    { q: "總覽測試", limit: 20, why: "關鍵字查標題" },
    { q: "沒有地址", limit: 20, why: "address 是 NULL 也不能爆" },
    { q: "", limit: 20, why: "空字串回空陣列" },
    { q: "總覽測試", limit: 1000, why: "上限被夾住" },
    { q: "總覽測試", limit: 0, why: "limit 0 用預設" },
  ];
  for (const c of cases) {
    const syncRows = plain(syncMod.searchAdminListings(c.q, c.limit).filter((row) => Number(row.post_id) >= 800000));
    const asyncRows = plain(await asyncAdmin.searchAdminListingsAsync(c.q, c.limit, { ...PG, exec, strict: true }));
    assert.deepEqual(asyncRows, syncRows, `結果必須逐列相同（${c.why}）`);
  }
  const capped = await asyncAdmin.searchAdminListingsAsync("總覽測試", 1000, { ...PG, exec, strict: true });
  assert.equal(capped.length, 2, "上限 40 之內符合的有 2 筆（否則這條測試沒有鑑別力）");
  // ⚠️ 上限是**共用政策**（`adminSearchNeedle()`），parity 比對抓不到「兩邊一起被改壞」，
  // 所以這裡直接對值本身下斷言。
  assert.equal(syncMod.adminSearchNeedle("x", 1000).cap, 40, "上限必須夾在 40");
  assert.equal(syncMod.adminSearchNeedle("x", 0).cap, 20, "limit 0 要用預設 20");
  assert.equal(syncMod.adminSearchNeedle("  ", 20).needle, "", "空白要 trim 成空字串");
});

test("系統爬蟲設定：讀取（預設值／已存值）兩個 driver 相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    setSetting(h, "systemWatchDistricts", ["1-5"]);
    setSetting(h, "systemCrawlIntervalMinutes", 45);
    setSetting(h, "systemOfflineConfirmDays", 7);
    setSetting(h, "systemShowMrt", false);
    setSetting(h, "systemShowListRefreshBar", true);
  });
  const syncView = plain(dbMod.getSystemCrawl());
  const asyncView = plain(await asyncContent.getSystemCrawlAsync({ ...PG, exec, strict: true }));
  assert.deepEqual(asyncView, syncView, "整包設定必須逐鍵相同");
  assert.deepEqual(asyncView.watchDistricts, ["1-5"]);
  assert.equal(asyncView.intervalMinutes, 45);
  assert.equal(asyncView.showMrt, false);
  assert.equal(asyncView.showListRefreshBar, true);
  assert.ok(Array.isArray(asyncView.cities), "cities 也要在（後台下拉選單用）");
});

test("系統爬蟲設定：partial patch 只覆蓋有給的鍵；只寫 PG（不再鏡射本機）", async () => {
  const [disk, exec] = resetBoth((h) => {
    setSetting(h, "systemWatchDistricts", ["1-5"]);
    setSetting(h, "systemCrawlIntervalMinutes", 45);
    setSetting(h, "systemShowMrt", true);
  });
  seedListing(disk, { id: 800010, sourceKey: "1-5" });
  seedListing(exec.raw, { id: 800010, sourceKey: "1-5" });
  // SQLite 退場 P3：本機那一組值**不得再被鏡射寫入**，所以先記下來、之後逐鍵比對沒被動到。
  const localKeys = ["systemCrawlIntervalMinutes", "systemWatchDistricts", "systemShowMrt", "siteCatalogStats"];
  const localBefore = Object.fromEntries(localKeys.map((key) => [key, settingValue(disk, key)]));

  // 只改一個鍵
  const asyncView = plain(await asyncContent.saveSystemCrawlAsync({ intervalMinutes: 90 }, { ...PG, exec, strict: true }));
  assert.equal(asyncView.intervalMinutes, 90, "給的鍵要生效");
  assert.deepEqual(asyncView.watchDistricts, ["1-5"], "沒給的鍵不得被洗掉");
  assert.equal(asyncView.showMrt, true, "沒給的布林鍵也不得被洗掉");
  for (const [key, expected] of [["systemCrawlIntervalMinutes", 90], ["systemWatchDistricts", ["1-5"]], ["systemShowMrt", true]]) {
    assert.equal(settingValue(exec.raw, key), JSON.stringify(expected), `PG 的 ${key} 必須是 ${JSON.stringify(expected)}`);
  }
  // 原本這裡斷言「本機的 ${key} 必須追上」（PG 寫完再 upsert 一次節點本機的 `settings`）。
  // 正式站三隻都開著 `PG_NO_SQLITE_OPEN=1` ⇒ 那句鏡射會直接拋錯（PG 已寫成功、呼叫端卻收到失敗）。
  // 方向是 PG 唯一權威來源，所以改斷言本機那一組值**不得被動到**。
  for (const key of localKeys) {
    assert.equal(settingValue(disk, key), localBefore[key], `本機的 ${key} 不得再被鏡射寫入`);
  }
  assert.equal(localBefore.systemCrawlIntervalMinutes, "45", "種子值是 45：若本機被鏡射就會變 90，這條才有鑑別力");
  // 目錄快照只寫 PG
  const pgSnap = JSON.parse(settingValue(exec.raw, "siteCatalogStats"));
  assert.ok(pgSnap && typeof pgSnap.total === "number", "PG 上必須有目錄快照");
  assert.deepEqual(plain(asyncView.catalog), pgSnap, "回傳的 catalog 必須就是落地的那一份");
  assert.equal(settingValue(disk, "siteCatalogStats"), undefined, "本機不得再寫目錄快照");
  // 布林鍵也要能單獨關掉（`showMrt:false` 是「有給」而不是「沒給」）
  const off = plain(await asyncContent.saveSystemCrawlAsync({ showMrt: false }, { ...PG, exec, strict: true }));
  assert.equal(off.showMrt, false, "明確給 false 要生效（不能被當成沒給）");
  assert.equal(settingValue(exec.raw, "systemShowMrt"), "false");
  assert.equal(settingValue(disk, "systemShowMrt"), localBefore.systemShowMrt, "本機的 showMrt 也不得被動到");
});

test("目錄快照：只算監看區裡的刊登，來源分佈與標籤都要相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    setSetting(h, "systemWatchDistricts", ["1-5"]);
    seedListing(h, { id: 800020, source: "591", sourceKey: "1-5" });
    seedListing(h, { id: 800021, source: "self", sourceKey: "1-5" });
    // ⚠️ 不在監看區的那一筆，**地址也要換一個行政區**：`listingMatchesDistrictKeys()` 在
    // `source_key` 不匹配時會退回「用地址裡的行政區名比對」，地址沒換就還是會被算進來
    // （第一版就是這樣，total 變成 3）。
    seedListing(h, { id: 800022, source: "591", sourceKey: "1-7", address: "台北市信義區某路" });
  });
  const syncSnap = plain(dbMod.refreshSiteCatalogStats());
  const asyncSnap = plain(await asyncContent.refreshSiteCatalogStatsAsync({ ...PG, exec, strict: true }));
  // `at` 是「跑快照的當下」，兩個 driver 不可能同毫秒 ⇒ 比對前遮罩，另外確認它是 ISO 字串。
  const maskAt = (snap) => ({ ...snap, at: "«t»" });
  assert.deepEqual(maskAt(asyncSnap), maskAt(syncSnap), "快照必須逐鍵相同");
  assert.match(asyncSnap.at, /^\d{4}-\d{2}-\d{2}T/, "at 必須是 ISO 時間字串");
  assert.equal(asyncSnap.total, 2, "只有監看區裡的那兩筆算數（否則這條測試沒有鑑別力）");
  assert.equal(asyncSnap.self, 1);
  assert.equal(asyncSnap.sources, 1);
  assert.equal(asyncSnap.districtCount, 1);
  assert.equal(asyncSnap.bySourceLabels["吉比本站"], 1, "來源標籤要用 selfSourceLabel 的顯示名");
  assert.equal(settingValue(exec.raw, "siteCatalogStats"), JSON.stringify(asyncSnap), "PG 上必須寫入同一份快照");
});

test("非 postgres 模式必須走同步路徑（不碰傳入的 exec）", async () => {
  const [disk, exec] = resetBoth((h) => setSetting(h, "systemWatchDistricts", ["1-5"]));
  let touched = 0;
  const counting = async (sql, params = []) => { touched += 1; return exec(sql, params); };
  const view = await asyncContent.getSystemCrawlAsync({ driver: "sqlite", exec: counting });
  const search = await asyncAdmin.searchAdminListingsAsync("總覽", 20, { driver: "sqlite", exec: counting });
  assert.equal(touched, 0, "SQLite 模式不得碰 PG runner");
  assert.deepEqual(plain(view), plain(dbMod.getSystemCrawl()));
  assert.deepEqual(plain(search), plain(syncMod.searchAdminListings("總覽", 20).filter((row) => Number(row.post_id) >= 800000)));
  void disk;
});
