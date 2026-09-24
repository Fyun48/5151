// 會員設定／搜尋設定檔的 driver parity（2026-09-24，PG 島嶼移植）。
//
// 背景：`getSettings／saveSettings／saveAsProfile／loadProfile／deleteProfile` 原本只有同步 SQLite
// 版本，PG 模式下「儲存設定」會寫進該節點自己的 SQLite（公開站輪流到 web-A／web-B 時設定不一致）。
// settingsAsync.js 讓 PG 分支跑 repository/memberSettings.js 的同一組語句。
//
// 離線：用 SQLite fixture 當 PG 替身（語句共通），釘住「寫哪裡」與「讀回來一樣」。
// live：PG_TEST_URL 有設才跑（沒設會 skip）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSettingsAsync, saveAsProfileAsync, saveSettingsAsync } from "../src/settingsAsync.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-settings-parity-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the file locked
  }
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
const skip = PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL settings parity)";
const UID = 710001;

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE user_settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'member',
      plan TEXT NOT NULL DEFAULT 'free', deleted_at TEXT);
    CREATE TABLE user_search_profiles (id TEXT NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY (user_id, id));
  `);
  db.prepare("INSERT INTO users(id, email, role, plan) VALUES (?, ?, ?, ?)").run(UID, "fixture@jibby.test", "member", "free");
  db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("dataEpoch", JSON.stringify(3));
  db.prepare("INSERT INTO user_settings(user_id, key, value) VALUES (?, ?, ?)").run(UID, "watchDistricts", JSON.stringify(["士林"]));
  return db;
}

// 注入式 exec 收到的是 `?` 風格的語句（與其它島嶼一致：呼叫端負責轉方言），所以這裡轉一次。
function pgExec(pgDriver) {
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// 把 PG 的 $n 佔位符轉回 ?，讓 fixture（SQLite）當 PG 替身；SELECT 回 rows、寫入回 []。
function sqliteExec(db) {
  return async (sql, params = []) => {
    const text = String(sql).replace(/\$(\d+)/g, "?");
    const stmt = db.prepare(text);
    if (/^\s*select/i.test(text)) return stmt.all(...params);
    stmt.run(...params);
    return [];
  };
}

const options = (db) => ({ driver: "postgres", exec: sqliteExec(db) });

test("PG 分支：儲存設定寫進 user_settings，且讀回來與寫入相符", async () => {
  const db = fixture();
  const opts = options(db);
  const saved = await saveSettingsAsync({ watchDistricts: ["1-8", "1-9"] }, UID, opts);
  assert.deepEqual(saved.watchDistricts, ["1-8", "1-9"]);

  const stored = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").get(UID, "watchDistricts");
  assert.equal(stored.value, JSON.stringify(["1-8", "1-9"]), "寫入必須落在 user_settings（PG 分支）");

  const reread = await getSettingsAsync(UID, opts);
  assert.deepEqual(reread.watchDistricts, ["1-8", "1-9"]);
  // 非管理員的 intervalMinutes 由 applySettingPatch 鎖成現值（與 SQLite 分支同一條規則）
  assert.equal(reread.intervalMinutes, saved.intervalMinutes);
  // 存 PROFILE_FIELDS 時會啟用（或建立）目前搜尋設定檔
  const live = db.prepare("SELECT active FROM user_search_profiles WHERE user_id = ? AND id = ?").get(UID, "live");
  assert.equal(Number(live?.active), 1, "存搜尋條件要啟用 active 設定檔");

  const unknown = await saveSettingsAsync({ watchDistricts: ["999-999"] }, UID, opts);
  assert.deepEqual(unknown.watchDistricts, [], "不在 DISTRICT_INDEX 的鍵要被濾掉（與 SQLite 分支一致）");
});

test("PG 分支：site 層鍵寫進 settings、跳過的鍵不寫（與 SQLite 分支同一份規則）", async () => {
  const db = fixture();
  const opts = options(db);
  await saveSettingsAsync({ crawlSources: ["591"], brandMascot: "x" }, UID, opts);
  const site = db.prepare("SELECT value FROM settings WHERE key = ?").get("crawlSources");
  assert.equal(site.value, JSON.stringify(["591"]), "site 層鍵要寫進 settings");
  const skipped = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").get(UID, "brandMascot");
  assert.equal(skipped, undefined, "brandMascot 由專用函式寫，不該落在 user_settings");
});

test("PG 分支：儲存設定會啟用對應的搜尋設定檔，換一個會把舊的關掉", async () => {
  const db = fixture();
  const opts = options(db);
  const saved = await saveSettingsAsync({ settingProfiles: [{ id: "p-a", name: "台北" }], activeProfileId: "p-a" }, UID, opts);
  const row = db.prepare("SELECT * FROM user_search_profiles WHERE user_id = ? AND id = ?").get(UID, "p-a");
  assert.ok(row, "要在 user_search_profiles 建立／啟用設定檔");
  assert.equal(Number(row.active), 1);
  assert.equal(row.name, "台北");
  assert.deepEqual(JSON.parse(row.data_json).watchDistricts, saved.watchDistricts);

  await saveSettingsAsync(
    { settingProfiles: [{ id: "p-a", name: "台北" }, { id: "p-b", name: "新北" }], activeProfileId: "p-b" },
    UID,
    opts,
  );
  const oldRow = db.prepare("SELECT active FROM user_search_profiles WHERE user_id = ? AND id = ?").get(UID, "p-a");
  const newRow = db.prepare("SELECT active FROM user_search_profiles WHERE user_id = ? AND id = ?").get(UID, "p-b");
  assert.equal(Number(oldRow.active), 0, "舊的 active 要被關掉（與 SQLite 版一致）");
  assert.equal(Number(newRow.active), 1);
});

test("PG 分支：saveAsProfileAsync 建立設定檔並排下次抓取時間", async () => {
  const db = fixture();
  const settings = await saveAsProfileAsync("我的最愛", undefined, UID, options(db));
  const profiles = settings.settingProfiles || [];
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "我的最愛");
  const due = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").get(UID, "memberFetchDueAt");
  assert.ok(due?.value, "memberFetchDueAt 應被寫入（armMemberExternalFetchAsync）");
});

test("live：PG 上的設定寫入可被讀回（PG_TEST_URL）", { skip }, async () => {
  const pgDriver = await createPostgresDriver({ connectionString: PG_TEST_URL });
  try {
    const exec = pgExec(pgDriver);
    const uid = 710002;
    await exec("DELETE FROM user_settings WHERE user_id = $1", [uid]);
    await exec("DELETE FROM user_search_profiles WHERE user_id = $1", [uid]);
    // users 的 id / email / created_at 是 NOT NULL 且沒有 default
    await exec(
      `INSERT INTO users(id, email, role, plan, created_at) VALUES ($1, $2, 'member', 'free', $3)
       ON CONFLICT (id) DO NOTHING`,
      [uid, "live-fixture@jibby.test", new Date().toISOString()],
    );

    const opts = { driver: "postgres", exec };
    const saved = await saveSettingsAsync({ watchDistricts: ["1-8"], intervalMinutes: 11 }, uid, opts);
    assert.deepEqual(saved.watchDistricts, ["1-8"]);
    const reread = await getSettingsAsync(uid, opts);
    assert.deepEqual(reread.watchDistricts, ["1-8"]);
    const stored = await exec("SELECT value FROM user_settings WHERE user_id = $1 AND key = 'watchDistricts'", [uid]);
    assert.equal(stored[0]?.value, JSON.stringify(["1-8"]), "live PG 的 user_settings 要有剛剛存的值");
    const profile = await exec("SELECT active FROM user_search_profiles WHERE user_id = $1", [uid]);
    assert.equal(profile.length, 1, "存設定要在 PG 啟用一筆搜尋設定檔");
    assert.equal(Number(profile[0].active), 1);
  } finally {
    await pgDriver.close();
  }
});
