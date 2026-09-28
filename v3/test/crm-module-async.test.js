// CRM 開關 PG 分支的 parity（2026-09-27）。
//
// 🚨 這個鍵的讀者是**原生 SQL**（`crm.js` 的 `setting()`），而且值是**原始字串** `"1"`／`"0"`
// （`isCrmEnabled()` 就是 `!== "0"`）。所以**不能**用 `settingsKvAsync`——它會 JSON.stringify，
// 存進去變成含引號的字串 ⇒ 開關永遠無效。這與 remote-cs 是同一個坑（交接紀律 11）。
// 下面第 3 條測試就是釘「落地必須是原始字串」。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-crmmodule-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const syncDb = await import("../src/db.js");
const asyncMod = await import("../src/crmAsync.js");
const { CRM_ENABLED_KEY } = await import("../src/repository/crm.js");

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
  db.prepare("DELETE FROM settings WHERE key=?").run(CRM_ENABLED_KEY);
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM settings WHERE key=?").run(CRM_ENABLED_KEY);
  return exec;
}

const landed = (h) => h.prepare("SELECT value FROM settings WHERE key=?").get(CRM_ENABLED_KEY)?.value ?? null;

test("沒有存值：預設是啟用，且與同步版逐欄相同", async () => {
  const exec = resetBoth();
  const pg = await asyncMod.setCrmEnabledAsync(true, { ...PG, exec });
  const lite = syncDb.setCrmModuleEnabled(true);
  assert.deepEqual(pg, lite, "整包必須相同");
  assert.equal(pg.enabled, true);
  assert.equal(pg.closed, false);
  assert.ok(pg.legal && pg.handling, "其餘欄位不得是空的（否則比對沒有鑑別力）");
});

test("關閉：enabled/closed 要跟著變，且與同步版相同", async () => {
  const exec = resetBoth();
  const off = await asyncMod.setCrmEnabledAsync(false, { ...PG, exec });
  const offLite = syncDb.setCrmModuleEnabled(false);
  assert.deepEqual(off, offLite);
  assert.equal(off.enabled, false);
  assert.equal(off.closed, true);

  const on = await asyncMod.setCrmEnabledAsync(true, { ...PG, exec });
  assert.deepEqual(on, syncDb.setCrmModuleEnabled(true));
  assert.equal(on.enabled, true);
});

test('落地必須是原始字串 "0"／"1"（不是 JSON 布林、也不是含引號的字串）', async () => {
  const exec = resetBoth();
  await asyncMod.setCrmEnabledAsync(false, { ...PG, exec });
  assert.equal(landed(exec.raw), "0", `PG 落地值必須是原始字串 "0"，實際 ${JSON.stringify(landed(exec.raw))}`);
  // 同步版也要**真的跑一次**才會寫磁碟（第一版忘了呼叫它，`landed(db)` 當然是 null）。
  syncDb.setCrmModuleEnabled(false);
  assert.equal(landed(db), "0", "同步版落地的也必須是原始字串");
  await asyncMod.setCrmEnabledAsync(true, { ...PG, exec });
  assert.equal(landed(exec.raw), "1");
  // 反向對照：如果用了 settingsKvAsync，落地會是 '"0"'，而 isCrmEnabled 會永遠回 true。
  assert.notEqual(landed(exec.raw), '"1"', "不得是 JSON 字串");
});

test("非 postgres 模式必須回退同步路徑（寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  await asyncMod.setCrmEnabledAsync(false, { ...PG, exec });
  assert.equal(landed(exec.raw), "0");
  const lite = await asyncMod.setCrmEnabledAsync(true, { driver: "sqlite", exec });
  assert.deepEqual(lite, syncDb.setCrmModuleEnabled(true));
  assert.equal(landed(db), "1", "sqlite 模式必須寫磁碟");
  assert.equal(landed(exec.raw), "0", "sqlite 模式不得改動 PG 夾具");
});
