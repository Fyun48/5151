// 通用設定鍵存取器的 parity（2026-09-27）。
//
// 背景：`settingKey`／`writeSettingKey`／`userSettingKey`／`writeUserSettingKey` 原本只在
// db.js（同步 SQLite），PG 沒有通用存取器，導致每一處都要手寫 UPSERT SQL。對照表顯示
// 94 處 SQLite 路由用到 settings、16 處用到 user_settings——先收起這個洞，後續轉換才機械化。
//
// 這個檔釘住兩件事：
//   1. PG 分支的讀寫與值格式（JSON.stringify，與 db.js 相同）
//   2. **與同步版 parity**：同一組資料餵 SQLite（db.js 真檔）與 PG（注入 exec）必須一致
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-settings-kv-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = await import("../src/db.js");
const {
  getSiteSettingAsync, setSiteSettingAsync, getUserSettingAsync, setUserSettingAsync,
} = await import("../src/settingsKvAsync.js");

const PG = { driver: "postgres" };

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  mem.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  mem.exec("CREATE TABLE user_settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))");
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

test("站台設定的 PG 寫入格式必須是 JSON（與 db.js 相同）", async () => {
  const exec = pgFixture();
  await setSiteSettingAsync("probeKey", { a: 1, b: [2, 3] }, { ...PG, exec });
  const row = exec.raw.prepare("SELECT value FROM settings WHERE key='probeKey'").get();
  assert.equal(row.value, JSON.stringify({ a: 1, b: [2, 3] }));
  assert.deepEqual(await getSiteSettingAsync("probeKey", { ...PG, exec }), { a: 1, b: [2, 3] });
});

test("會員設定的 PG 讀寫", async () => {
  const exec = pgFixture();
  await setUserSettingAsync(7, "someKey", { ok: true }, { ...PG, exec });
  assert.deepEqual(await getUserSettingAsync(7, "someKey", { ...PG, exec }), { ok: true });
  // 別人不該讀到
  assert.equal(await getUserSettingAsync(8, "someKey", { ...PG, exec }), undefined);
});

test("不存在的鍵回傳 undefined（與同步版一致）", async () => {
  const exec = pgFixture();
  assert.equal(await getSiteSettingAsync("nope", { ...PG, exec }), undefined);
  assert.equal(await getUserSettingAsync(1, "nope", { ...PG, exec }), undefined);
});

test("壞掉的 JSON 要當作沒有值，不得拋錯（與同步版一致）", async () => {
  const exec = pgFixture();
  exec.raw.prepare("INSERT INTO settings(key,value) VALUES('broken','{not json')").run();
  assert.equal(await getSiteSettingAsync("broken", { ...PG, exec }), undefined);
});

test("非 postgres driver 走同步分支，不得動用注入的 PG exec", async () => {
  let used = 0;
  const exec = async () => { used += 1; return []; };
  await getSiteSettingAsync("whatever", { driver: "sqlite", exec });
  await getUserSettingAsync(1, "whatever", { driver: "sqlite", exec });
  assert.equal(used, 0, "driver=sqlite 時不得碰 PG exec");
});

test("parity：同一組資料在 SQLite 與 PG 必須讀到相同結果", async () => {
  const payload = { mixed: [1, "two", null, { three: 3 }] };
  db.writeSettingKey("paritySiteKey", payload);
  db.writeUserSettingKey(1, "parityUserKey", payload);

  const exec = pgFixture();
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true });
  const siteRows = disk.prepare("SELECT key, value FROM settings WHERE key='paritySiteKey'").all();
  const userRows = disk.prepare("SELECT key, value FROM user_settings WHERE user_id=1 AND key='parityUserKey'").all();
  disk.close();
  for (const r of siteRows) exec.raw.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(r.key, r.value);
  for (const r of userRows) exec.raw.prepare("INSERT INTO user_settings(user_id,key,value) VALUES(1,?,?)").run(r.key, r.value);

  assert.deepEqual(await getSiteSettingAsync("paritySiteKey", { ...PG, exec }), db.settingKey("paritySiteKey"));
  assert.deepEqual(await getUserSettingAsync(1, "parityUserKey", { ...PG, exec }), db.userSettingKey(1, "parityUserKey"));
});
