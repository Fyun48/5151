// 歷史 reconciliation 進度狀態的 PG 分支 parity（2026-09-27）。
//
// `sameHouseBackfillStatus()` 只讀兩個 settings 鍵，但**兩個的編碼方式不同**：
//   * `BACKFILL_SETTING_KEY` ← `writeSettingKey(key, String(cursor))` ⇒ 落地是 `"12"`（JSON 字串）
//   * `BACKFILL_STATUS_KEY`  ← `writeSettingKey(key, JSON.stringify(obj))` ⇒ 落地是**再包一層**的字串
// 所以兩邊都還要在讀到之後**再 parse 一次**。這一檔就是釘住這件事：
// 少了它，「有沒有用對鍵」「有沒有再 parse」都不會有人發現。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-shbackfill-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const syncDb = await import("../src/db.js");
const asyncMod = await import("../src/sameHouseAsync.js");
const { BACKFILL_SETTING_KEY } = await import("../src/sameHouseReconcile.js");
const { BACKFILL_STATUS_KEY } = await import("../src/db.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'").get();
  assert.ok(ddl?.sql, "必須抓到 settings 的 DDL");
  mem.exec(ddl.sql);
  disk.close();
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

function resetBoth() {
  for (const h of [db]) h.prepare("DELETE FROM settings WHERE key IN (?,?)").run(BACKFILL_SETTING_KEY, BACKFILL_STATUS_KEY);
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM settings WHERE key IN (?,?)").run(BACKFILL_SETTING_KEY, BACKFILL_STATUS_KEY);
  return exec;
}

// 完全照 db.js 的寫法落地（`writeSettingKey` 會再 JSON.stringify 一次）。
function seed(h, cursor, statusObj) {
  if (cursor != null) h.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(BACKFILL_SETTING_KEY, JSON.stringify(String(cursor)));
  if (statusObj != null) h.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(BACKFILL_STATUS_KEY, JSON.stringify(JSON.stringify(statusObj)));
}

test("沒有存值：cursor 0、last 空物件，與同步版相同", async () => {
  const exec = resetBoth();
  const pg = await asyncMod.sameHouseBackfillStatusAsync({ ...PG, exec });
  const lite = syncDb.sameHouseBackfillStatus();
  assert.deepEqual(pg, lite, "整包必須相同");
  assert.equal(pg.cursor, 0);
  assert.deepEqual(pg.last, {});
  assert.ok(pg.batch > 0, "batch 不得是 0（否則比對沒有鑑別力）");
});

test("有存值：cursor 與 last 都要正確解出來（兩層編碼都要處理）", async () => {
  const exec = resetBoth();
  seed(db, 120, { at: "2026-09-01T00:00:00.000Z", processed: 500 });
  seed(exec.raw, 120, { at: "2026-09-01T00:00:00.000Z", processed: 500 });
  const pg = await asyncMod.sameHouseBackfillStatusAsync({ ...PG, exec });
  const lite = syncDb.sameHouseBackfillStatus();
  assert.deepEqual(pg, lite, "整包必須相同");
  assert.equal(pg.cursor, 120, "cursor 必須從 JSON 字串解出來（不是 NaN）");
  assert.equal(pg.last.processed, 500, "last 必須是物件（不是字串）");
  assert.equal(pg.last.at, "2026-09-01T00:00:00.000Z");
});

test("last 壞掉時回空物件，但 cursor 仍要讀出來", async () => {
  const exec = resetBoth();
  seed(db, 7, null);
  seed(exec.raw, 7, null);
  for (const h of [db, exec.raw]) h.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(BACKFILL_STATUS_KEY, JSON.stringify("{壞掉的"));
  const pg = await asyncMod.sameHouseBackfillStatusAsync({ ...PG, exec });
  const lite = syncDb.sameHouseBackfillStatus();
  assert.deepEqual(pg, lite);
  assert.equal(pg.cursor, 7, "cursor 不受 last 壞掉影響");
  assert.deepEqual(pg.last, {});
});

test("非 postgres 模式必須回退同步路徑（讀磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  seed(exec.raw, 999, { marker: "fixture" });
  assert.equal((await asyncMod.sameHouseBackfillStatusAsync({ ...PG, exec })).cursor, 999, "PG 分支讀夾具");
  const lite = await asyncMod.sameHouseBackfillStatusAsync({ driver: "sqlite", exec });
  assert.deepEqual(lite, syncDb.sameHouseBackfillStatus());
  assert.equal(lite.cursor, 0, "sqlite 模式讀磁碟（磁碟沒有存值 ⇒ 0）");
});
