// 遠端客服開關 PG 分支的 parity（2026-09-27）。
//
// 這個開關的儲存只有一個 settings 鍵（`ops_remote_cs_stop`），值是**原始字串 "1"／"0"**
// ——不是 JSON 布林。`getSiteSettingAsync` 會 JSON.parse，"1" 會變成數字 1，
// 所以讀回來要字串化再比對；寫回去也要維持 "1"／"0" 的格式，否則
// `isRemoteCsStopped()`（`String(value) === "1"`）會永遠是 false，等於這個開關失效。
//
// 判斷邏輯（env_allowed／configured／local_stopped／effective）**重用
// `remoteCsAcceptControl()` 本身**，所以這裡驗的是「餵進去的值對不對」與「落地格式對不對」。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-sitecommand-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const syncDb = await import("../src/db.js");
const asyncMod = await import("../src/siteCommandAsync.js");
const { REMOTE_CS_STOP_KEY } = await import("../src/siteCommandApply.js");

const PG = { driver: "postgres" };
const KEY = REMOTE_CS_STOP_KEY;
const diskPath = () => path.join(dataDir, "v3.db");

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown) does not exist"],
  [/COLLATE\s+NOCASE/i, 'collation "nocase" for encoding "UTF8" does not exist'],
];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'").get();
  assert.ok(ddl?.sql, "必須抓到 settings 的 DDL");
  mem.exec(ddl.sql);
  disk.close();
  const calls = [];
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    calls.push({ sql, params });
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  exec.calls = calls;
  return exec;
}

function resetBoth() {
  db.prepare("DELETE FROM settings WHERE key=?").run(KEY);
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM settings WHERE key=?").run(KEY);
  return exec;
}

const landed = (h) => h.prepare("SELECT value FROM settings WHERE key=?").get(KEY)?.value ?? null;
const reasonOf = (e) => `${e.status || "-"}/${e.message}`;

// ---------------------------------------------------------------------------

test("沒有存值：回傳與同步版逐欄相同，且兩邊都不得寫入", async () => {
  const exec = resetBoth();
  const pg = await asyncMod.getRemoteCsControlAsync({ ...PG, exec });
  const lite = syncDb.getRemoteCsControl();
  assert.deepEqual(pg, lite, "整包必須相同");
  for (const key of ["env_allowed", "configured", "local_stopped", "effective"]) {
    assert.equal(typeof pg[key], "boolean", `${key} 必須是布林（否則比對會變成兩個 undefined 相等）`);
  }
  assert.equal(pg.local_stopped, false);
  assert.equal(landed(exec.raw), null, "純讀取不得寫入");
  assert.equal(landed(db), null);
});

test("有存值（\"1\"）：local_stopped 要是 true，且與同步版相同", async () => {
  const exec = resetBoth();
  for (const h of [db, exec.raw]) h.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(KEY, "1");
  const pg = await asyncMod.getRemoteCsControlAsync({ ...PG, exec });
  const lite = syncDb.getRemoteCsControl();
  assert.deepEqual(pg, lite);
  assert.equal(pg.local_stopped, true, "存 \"1\" 就必須是停止");
  assert.equal(pg.effective, false, "本地停止時 effective 必須是 false");
});

test("存值 \"0\" 也要是 false（不是「有值就算停止」）", async () => {
  const exec = resetBoth();
  for (const h of [db, exec.raw]) h.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(KEY, "0");
  const pg = await asyncMod.getRemoteCsControlAsync({ ...PG, exec });
  assert.deepEqual(pg, syncDb.getRemoteCsControl());
  assert.equal(pg.local_stopped, false, "\"0\" 不是停止");
});

test("設定停止：落地格式必須是原始字串 \"1\"（不是 JSON 布林），回傳值與同步版相同", async () => {
  const exec = resetBoth();
  const pg = await asyncMod.setRemoteCsStopAsync(true, { ...PG, exec });
  const lite = syncDb.setRemoteCsStop(true);
  assert.deepEqual(pg, lite, "回傳的控制物件必須相同");
  assert.equal(pg.local_stopped, true);
  // 🚨 落地格式：`isRemoteCsStopped()` 是 `String(value) === "1"`。存成 `"true"`／`"\"1\""`
  // 都會讓開關永遠失效，而且不會有任何錯誤。
  assert.equal(landed(exec.raw), "1", `落地值必須是原始字串 "1"，實際 ${JSON.stringify(landed(exec.raw))}`);
  assert.equal(landed(db), "1", "同步版的落地值也一樣");

  const back = await asyncMod.setRemoteCsStopAsync(false, { ...PG, exec });
  const backLite = syncDb.setRemoteCsStop(false);
  assert.deepEqual(back, backLite);
  assert.equal(landed(exec.raw), "0");
  assert.equal(back.local_stopped, false);
});

test("非 postgres 模式必須回退同步路徑（讀寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  await asyncMod.setRemoteCsStopAsync(true, { ...PG, exec });
  assert.equal(landed(exec.raw), "1");
  const lite = await asyncMod.setRemoteCsStopAsync(false, { driver: "sqlite", exec });
  assert.equal(lite.local_stopped, false);
  assert.equal(landed(db), "0", "sqlite 模式必須寫磁碟");
  assert.equal(landed(exec.raw), "1", "sqlite 模式不得改動 PG 夾具");
  assert.deepEqual(await asyncMod.getRemoteCsControlAsync({ driver: "sqlite", exec }), syncDb.getRemoteCsControl());
});

test("strict：PG 失敗時必須往上丟，不得無聲寫進沒人讀的 SQLite", async () => {
  // 少了這一條，「寫入不再 fail-closed」的變異殺不死——其他測試都只走成功路徑。
  const exec = resetBoth();
  const broken = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(() => asyncMod.setRemoteCsStopAsync(true, { ...PG, exec: broken, strict: true }), /connection terminated/);
  await assert.rejects(() => asyncMod.setRemoteCsStopAsync(true, { ...PG, exec: broken }), /connection terminated/);
  assert.equal(landed(db), null, "寫入失敗不得回退寫 SQLite（那會是無聲的資料分歧）");
});

test("夾具本身要真的拒絕 IFNULL／COLLATE NOCASE（否則方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT IFNULL(value,'') FROM settings"), /function ifnull/);
  await assert.rejects(() => exec("SELECT key FROM settings ORDER BY key COLLATE NOCASE"), /collation "nocase"/);
  await assert.doesNotReject(() => exec("SELECT key FROM settings"), "普通查詢要放行");
});
