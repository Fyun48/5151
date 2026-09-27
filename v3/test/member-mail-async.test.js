// 會員郵件設定 PG 分支的行為與 parity 回歸（2026-09-27）。
//
// 背景：`getMemberMailSettings／saveMemberMailSettings／getMemberMailBundle` 原本只有同步 SQLite
// 版本，所以公開站「通知設定 → 自己的郵件 SMTP」讀寫的是**回答那台節點自己的 SQLite**。
// 實測同一台生產、同一個使用者：web-A 回 host 空的、web-B 回 host 有值——公開站經 HAProxy
// 在兩台之間輪流，同一頁重新整理就會看到不同結果；watcher 寄送通知時也吃同一個 bundle。
//
// 這個檔同時釘住兩件事：
//   1. PG 分支的讀寫與值格式（JSON.stringify，與 db.js 相同）
//   2. **與同步版 parity**：同一組資料餵給 SQLite（db.js）與 PG（注入 exec），兩邊結果必須相等
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-member-mail-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
});

const { getMemberMailBundle, getMemberMailSettings, saveMemberMailSettings } = await import("../src/db.js");
const {
  getMemberMailBundleAsync,
  getMemberMailSettingsAsync,
  saveMemberMailSettingsAsync,
} = await import("../src/memberMailAsync.js");

const PG = { driver: "postgres" };

// 以 in-memory SQLite 當 PG 替身；注入式 exec 收到 `?` 風格語句，與其它島嶼一致。
function pgFixture(seed = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("CREATE TABLE user_settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key))");
  for (const [key, value] of Object.entries(seed.userSettings || {})) {
    db.prepare("INSERT INTO user_settings(user_id, key, value) VALUES (?, ?, ?)").run(seed.userId ?? 1, key, JSON.stringify(value));
  }
  for (const [key, value] of Object.entries(seed.settings || {})) {
    db.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  }
  const exec = async (sql, params = []) => {
    const statement = db.prepare(sql);
    const rows = statement.all(...params);
    return rows;
  };
  exec.raw = db;
  return exec;
}

function rowsOf(exec, sql, params = []) {
  return exec.raw.prepare(sql).all(...params);
}

test("PG 分支可讀出 memberSmtp／範本／preset 的公開形狀", async () => {
  const exec = pgFixture({
    userSettings: {
      memberSmtp: { host: "smtp.gmail.com", port: 587, user: "a@example.com", pass: "secret", from: "a@example.com" },
      memberMailTemplates: { listing_notify: "主旨 A" },
      mailPreset: "concise",
    },
  });
  const out = await getMemberMailSettingsAsync(1, { ...PG, exec });
  assert.ok(out && typeof out === "object");
  assert.equal(out.smtp?.host, "smtp.gmail.com");
  assert.equal(out.smtp?.pass, undefined, "對外結果不得回傳密碼");
  assert.equal(out.preset, "concise");
});

test("PG 分支寫入的值必須是 JSON 字串（與 db.js 的格式一致）", async () => {
  const exec = pgFixture({});
  await saveMemberMailSettingsAsync(1, {
    smtp: { host: "smtp.gmail.com", port: 587, user: "a@example.com", pass: "pw", from: "a@example.com" },
  }, { ...PG, exec });
  const row = rowsOf(exec, "SELECT value FROM user_settings WHERE user_id=1 AND key='memberSmtp'")[0];
  assert.ok(row, "memberSmtp 必須被寫入");
  const parsed = JSON.parse(row.value);
  assert.equal(parsed.host, "smtp.gmail.com");
  assert.equal(parsed.pass, "pw", "密碼必須真的存進去（否則寄信會失敗）");
});

test("preset 寫入時，若沒帶 templates 也要一併把該 preset 寫進 memberMailTemplates", async () => {
  const exec = pgFixture({});
  await saveMemberMailSettingsAsync(1, { preset: "concise" }, { ...PG, exec });
  const keys = rowsOf(exec, "SELECT key FROM user_settings WHERE user_id=1 ORDER BY key").map((r) => r.key);
  assert.deepEqual(keys, ["mailPreset", "memberMailTemplates"]);
});

test("getMemberMailBundleAsync：smtp 未設定時 configured=false 且 smtp=null", async () => {
  const exec = pgFixture({ userSettings: { memberSmtp: { host: "", port: 587 } } });
  const bundle = await getMemberMailBundleAsync(1, { ...PG, exec });
  assert.equal(bundle.configured, false);
  assert.equal(bundle.smtp, null);
});

test("getMemberMailBundleAsync：設定完整時 configured=true 且帶出 smtp", async () => {
  // 注意：`templates.listing_notify || siteTemplates.listing_notify` 這條站台後備在**同步版就是死碼**，
  // 因為 normalizeMemberMailTemplates() 一定會把預設值填滿、永遠是 truthy。PG 分支忠實 mirror 這個行為，
  // 所以這裡不斷言站台範本會浮出來（那會是錯的期待）。
  const exec = pgFixture({
    userSettings: { memberSmtp: { host: "smtp.gmail.com", port: 587, user: "a@example.com", pass: "pw", from: "a@example.com" } },
    settings: { mailTemplates: { listing_notify: { subject: "站台預設主旨 {{title}}", text: "站台預設內文" } } },
  });
  const bundle = await getMemberMailBundleAsync(1, { ...PG, exec });
  assert.equal(bundle.configured, true);
  assert.equal(bundle.smtp?.host, "smtp.gmail.com");
  assert.ok(bundle.templates.listing_notify?.subject, "listing_notify 必須有主旨");
});

test("parity：getMemberMailBundle 在 SQLite 與 PG 必須得到相同結果", async () => {
  saveMemberMailSettings(1, {
    smtp: { host: "smtp.gmail.com", port: 587, user: "bundle@example.com", pass: "pw", from: "bundle@example.com" },
  });
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true });
  const rows = disk.prepare("SELECT key, value FROM user_settings WHERE user_id=1").all();
  disk.close();

  const exec = pgFixture({});
  for (const row of rows) {
    exec.raw.prepare("INSERT INTO user_settings(user_id, key, value) VALUES (1, ?, ?)").run(row.key, row.value);
  }
  assert.deepEqual(
    await getMemberMailBundleAsync(1, { ...PG, exec }),
    getMemberMailBundle(1),
  );
});

test("未登入（uid=0）時寫入必須丟 401，且不得寫任何東西", async () => {
  const exec = pgFixture({});
  await assert.rejects(
    () => saveMemberMailSettingsAsync(0, { smtp: { host: "x" } }, { ...PG, exec }),
    (error) => error.status === 401,
  );
  assert.equal(rowsOf(exec, "SELECT * FROM user_settings").length, 0);
});

test("非 postgres driver 走同步分支（不得動用注入的 PG exec）", async () => {
  const exec = pgFixture({});
  let called = 0;
  const spy = async (...args) => { called += 1; return exec(...args); };
  spy.raw = exec.raw;
  await getMemberMailSettingsAsync(1, { driver: "sqlite", exec: spy });
  assert.equal(called, 0, "driver 不是 postgres 時不應該碰 PG exec");
});

test("parity：同一組資料在 SQLite（db.js）與 PG（注入 exec）必須得到相同結果", async () => {
  // 用同步版寫進真正的 SQLite，再把同一批資料鏡射到 PG 替身。
  const input = {
    smtp: { host: "smtp.gmail.com", port: 587, user: "parity@example.com", pass: "pw", from: "parity@example.com", fromName: "測試" },
  };
  const syncOut = saveMemberMailSettings(1, input);

  const file = path.join(dataDir, "v3.db");
  const disk = new DatabaseSync(file, { readOnly: true });
  const rows = disk.prepare("SELECT key, value FROM user_settings WHERE user_id=1").all();
  disk.close();
  assert.ok(rows.length > 0, "同步版應該要把設定寫進 SQLite");

  const exec = pgFixture({});
  for (const row of rows) {
    exec.raw.prepare("INSERT INTO user_settings(user_id, key, value) VALUES (1, ?, ?)").run(row.key, row.value);
  }
  const asyncOut = await getMemberMailSettingsAsync(1, { ...PG, exec });

  assert.deepEqual(asyncOut, syncOut, "PG 分支與 SQLite 分支的輸出必須逐欄相同");
  assert.deepEqual(asyncOut, getMemberMailSettings(1));
});
