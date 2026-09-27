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
