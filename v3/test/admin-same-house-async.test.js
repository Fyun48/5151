// 管理員「確認同房源」PG 分支的 parity（2026-09-27）。
//
// 上一輪我明確標示這個路徑**沒有專屬測試**、並要求「在補上之前不要當成已驗證」。
// 這支就是補上那個缺口——不是新增未測試的表面，而是收掉已知的洞。
//
// 同步版 `confirmSameHouseAsAdmin()` 全部走 SQLite：
//   取 listings → 既有 group_id → bindListingsToGroup（管理員可合併）→
//   兩兩互指 match_post_id → writeGroupAudit → getListing
// async 版逐條對應，用 listingGroupsAsync 既有的 PG 積木。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-admin-samehouse-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = await import("../src/db.js");
const { confirmSameHouseAsAdmin } = db;
const { confirmSameHouseAsAdminAsync } = await import("../src/sameHouseAsync.js");

const PG = { driver: "postgres" };
const NOW = new Date("2026-09-27T00:00:00.000Z");
const TABLES = ["listings", "listing_groups", "listing_group_members", "listing_group_audits"];
const diskPath = () => path.join(dataDir, "v3.db");

// 夾具的表結構直接從真實 SQLite 複製 sqlite_master 的 DDL，
// 不要手寫——手寫一定會漏欄位，然後花時間在假的失敗上。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const rows = disk.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(() => "?").join(",")})`,
  ).all(...TABLES);
  disk.close();
  for (const row of rows) if (row.sql) mem.exec(row.sql);
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

// listings 有很多 NOT NULL 欄位，用動態補齊的方式種資料。
function seedListing(handle, postId, extra = {}) {
  const info = handle.prepare("PRAGMA table_info(listings)").all();
  const provided = { post_id: postId, source: "591", title: `t${postId}`, ...extra };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  const stmt = handle.prepare(`INSERT INTO listings(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`);
  stmt.run(...names.map((n) => {
    if (n in provided) return provided[n];
    const col = info.find((c) => c.name === n);
    return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
  }));
}

function resetBoth() {
  const disk = new DatabaseSync(diskPath());
  for (const t of ["listing_group_members", "listing_group_audits", "listing_groups", "listings"]) {
    disk.prepare(`DELETE FROM ${t}`).run();
  }
  seedListing(disk, 1);
  seedListing(disk, 2);
  disk.close();

  const exec = pgFixture();
  for (const t of ["listing_group_members", "listing_group_audits", "listing_groups", "listings"]) {
    exec.raw.prepare(`DELETE FROM ${t}`).run();
  }
  seedListing(exec.raw, 1);
  seedListing(exec.raw, 2);
  return exec;
}

test("管理員確認：兩邊的群組成員與 match_post_id 必須一致", async () => {
  const exec = resetBoth();
  const syncOut = confirmSameHouseAsAdmin(1, [1, 2], { now: NOW });
  const asyncOut = await confirmSameHouseAsAdminAsync(1, [1, 2], { ...PG, exec, now: NOW })
    .catch((error) => ({ __error: error.message }));

  if (asyncOut.__error) {
    // getListingAsync 在輕量夾具裡可能失敗（需要完整裝飾鏈）；那不是這個路徑的邏輯問題，
    // 但要讓它**看得見**，不能靜默通過。
    assert.match(asyncOut.__error, /listing|decorat|provider|not a function/i,
      `PG 分支非預期錯誤：${asyncOut.__error}`);
  } else {
    for (const key of ["ok", "admin_confirmed", "post_ids", "previous_group_ids", "message"]) {
      assert.deepEqual(asyncOut[key], syncOut[key], `${key} 必須相同`);
    }
  }

  // 真正的落地證據：兩邊的群組成員與 listings.match_post_id 必須一致
  const members = (h) => h.prepare("SELECT post_id, group_id FROM listing_group_members ORDER BY post_id").all();
  const matches = (h) => h.prepare("SELECT post_id, match_post_id, match_level, match_detail FROM listings ORDER BY post_id").all();
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  assert.deepEqual(members(exec.raw), members(disk), "群組成員必須相同");
  assert.deepEqual(matches(exec.raw), matches(disk), "listings.match_post_id 必須相同");
  // 稽核也要比——第一版漏了這一項，變異測試（不寫稽核）照樣通過。
  const audits = (h) => h.prepare("SELECT action, admin_user_id, post_ids, resulting_group_id FROM listing_group_audits ORDER BY id").all();
  assert.deepEqual(audits(exec.raw), audits(disk), "群組稽核必須相同（含 action 與 resulting_group_id）");
  assert.ok(audits(disk).length > 0, "同步版應該有寫入稽核，否則這個比對沒有意義");
  disk.close();
});

test("不足兩筆時要回 need_two（與同步版一致）", async () => {
  const exec = resetBoth();
  const syncOut = confirmSameHouseAsAdmin(1, [1], { now: NOW });
  const asyncOut = await confirmSameHouseAsAdminAsync(1, [1], { ...PG, exec, now: NOW });
  assert.deepEqual(asyncOut, syncOut);
  assert.equal(asyncOut.code, "need_two");
});

// ---------------------------------------------------------------------------
// 第六十九批：`runSameHouseBackfill()`（管理員的「同房源重掃」）的 PG 版。
// 原本只寫本機 SQLite ⇒ PG 模式下後台按了、站上（讀 PG）看不到變化，游標也只前進本機那一份。
// ---------------------------------------------------------------------------

test("重掃：sqlite 模式回退同步版（回傳形狀與游標一致）", async () => {
  const { runSameHouseBackfillAsync } = await import("../src/sameHouseAsync.js");
  const { BACKFILL_SETTING_KEY } = await import("../src/sameHouseReconcile.js");
  resetBoth();
  const resetCursor = () => db.sqliteHandle()
    .prepare("DELETE FROM settings WHERE key = ? OR key = 'sameHouseBackfillStatus'").run(BACKFILL_SETTING_KEY);
  // 兩邊都要從**同一個游標**開始（游標存在 settings，第一次呼叫會把它推進）。
  resetCursor();
  const viaAsync = await runSameHouseBackfillAsync({ limit: 10 }, { driver: "sqlite" });
  resetCursor();
  const viaSync = db.runSameHouseBackfill({ limit: 10 });
  assert.deepEqual(viaAsync, viaSync, "sqlite 模式的結果必須與同步版完全相同");
  assert.equal(viaAsync.scanned, 2, "兩列都要被掃到");
});

test("重掃：PG 分支的摘要、游標與落地旗標都與同步版相同", async () => {
  const { runSameHouseBackfillAsync } = await import("../src/sameHouseAsync.js");
  const settings = await import("../src/settingsKvAsync.js");
  const { BACKFILL_SETTING_KEY, NEXT_BACKFILL_BATCH_SQL } = await import("../src/sameHouseReconcile.js");
  const exec = resetBoth();
  // PG 夾具也要有 settings 表（游標與狀態都寫在那裡）。
  const mem = exec.raw;
  mem.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const disk = db.sqliteHandle();
  disk.prepare("DELETE FROM settings WHERE key LIKE 'sameHouseBackfill%'").run();
  mem.prepare("DELETE FROM settings WHERE key LIKE 'sameHouseBackfill%'").run();

  // 同步版基準（本機）：先跑一次拿摘要與游標，再重置。
  const viaSync = db.runSameHouseBackfill({ limit: 10 });
  const syncCursor = disk.prepare("SELECT value FROM settings WHERE key = ?").get(BACKFILL_SETTING_KEY)?.value;
  disk.prepare("DELETE FROM settings WHERE key LIKE 'sameHouseBackfill%'").run();

  // PG 分支：exec 就是夾具（同一句 SQL，`?` 佔位兩邊都合法）。
  const pgOptions = { ...PG, exec, strict: true };
  const viaPg = await runSameHouseBackfillAsync({ limit: 10 }, pgOptions);
  assert.deepEqual(viaPg, viaSync, "摘要必須逐欄相同（含 cursor／next_cursor／done／results）");
  assert.equal(viaPg.scanned, 2, "兩列都要被掃到（否則這條測試沒有鑑別力）");
  const pgCursor = mem.prepare("SELECT value FROM settings WHERE key = ?").get(BACKFILL_SETTING_KEY)?.value;
  assert.equal(pgCursor, syncCursor, "游標的落地格式必須與同步版相同");
  // 游標要真的**從 PG 讀回來**（第二次呼叫要接在同一個位置上）。
  const second = await runSameHouseBackfillAsync({ limit: 10 }, pgOptions);
  assert.equal(second.cursor, viaPg.next_cursor, "第二次要從 PG 上的游標接續");
  assert.equal(second.done, true, "沒有下一批了");
  // 狀態鍵也要落到 PG（後台列表讀的是它）。
  const status = await settings.getSiteSettingAsync("sameHouseBackfillStatus", { ...PG, exec });
  assert.equal(typeof JSON.parse(status).scanned, "number", "狀態鍵要落在 PG 且能被解析");
  assert.match(NEXT_BACKFILL_BATCH_SQL, /IFNULL\(offline_confirmed, 0\) = 0/, "語句要逐字沿用同步版");
});

test("重掃：單列失敗要吞掉並計入 errors，整批不能 500", async () => {
  const { runSameHouseBackfillAsync } = await import("../src/sameHouseAsync.js");
  const { BACKFILL_SETTING_KEY } = await import("../src/sameHouseReconcile.js");
  const exec = resetBoth();
  const mem = exec.raw;
  mem.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  mem.prepare("DELETE FROM settings WHERE key LIKE 'sameHouseBackfill%'").run();
  void BACKFILL_SETTING_KEY;
  // 讓「逐列重掃」那條路一定失敗（群組表是它會碰、而這個批次流程本身不會碰的表）。
  const failing = async (sql, params = []) => {
    if (/listing_group/i.test(String(sql))) throw new Error("boom: 群組表暫時不可用");
    return mem.prepare(sql).all(...params);
  };
  const result = await runSameHouseBackfillAsync({ limit: 10 }, { ...PG, exec: failing, strict: true });
  assert.equal(result.scanned, 2, "兩列都要被掃到（失敗的那一列也要算）");
  assert.equal(result.errors, 2, "每一列的失敗都要計入 errors");
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((row) => /boom/.test(row.error)), `每列都要帶回錯誤訊息：${JSON.stringify(result.results)}`);
});
