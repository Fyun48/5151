// 後台郵件／OAuth 設定寫入的 **live PG** 驗證（2026-09-28，第五十五批）。
//
// Owner 的決定是「移植」：設定進 PG（所有節點與讀者才看得到），`auth.env` 仍留節點本機。
// 這一條要證明的是**兩個 store 都真的被寫**，而且讀回來的是剛寫的那一份：
//   1. `settings.smtp` / `settings.mailTemplates` / `settings.oauth` 在真 PG 上落地
//   2. `getAdminMailSettingsAsync()` / `getAdminOauthSettingsAsync()` 讀得到（公開形狀不含密碼）
//   3. 本機的同步讀者（`getStoredSmtp()` / `getStoredOauth()`）也看到同一份（本機鏡射）
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
// 🚨 會動到三個正式設定的鍵，所以**先快照、結束後還原**。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-adminsettings-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：郵件與 OAuth 設定寫進 PG、讀回來，且本機同步讀者也看得到", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const adminAsync = await import("../src/adminSettingsAsync.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");

  const KEYS = ["smtp", "mailTemplates", "oauth"];
  const snapshot = new Map();
  for (const key of KEYS) {
    const row = (await query("SELECT value FROM settings WHERE key = $1", [key]))[0];
    snapshot.set(key, row ? row.value : null);
  }
  t.after(async () => {
    for (const key of KEYS) {
      const value = snapshot.get(key);
      try {
        if (value == null) await query("DELETE FROM settings WHERE key = $1", [key]);
        else await query("UPDATE settings SET value = $1 WHERE key = $2", [value, key]);
      } catch { /* 盡力而為 */ }
    }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };
  const readKey = async (key) => JSON.parse((await query("SELECT value FROM settings WHERE key = $1", [key]))[0].value);

  // 1. 郵件設定
  const saved = await adminAsync.saveAdminMailSettingsAsync({
    smtp: { host: "live-smtp.example.test", port: 2525, user: "live-mailer", pass: "live-secret", from: "live@example.test" },
    templates: { welcome: { subject: "live 主旨", text: "live 內容" } },
  }, opts);
  assert.equal(saved.smtp.host, "live-smtp.example.test");
  assert.equal(saved.smtp.pass, undefined, "公開形狀不得帶出密碼");
  assert.equal(saved.configured, true);
  const pgSmtp = await readKey("smtp");
  assert.equal(pgSmtp.host, "live-smtp.example.test", "PG 的 settings.smtp 必須落地");
  assert.equal(pgSmtp.pass, "live-secret", "PG 存的是完整設定（含密碼）");
  const pgTemplates = await readKey("mailTemplates");
  assert.equal(pgTemplates.welcome.subject, "live 主旨", "PG 的 settings.mailTemplates 必須落地");
  // 讀回來（PG）與本機鏡射
  const reread = await adminAsync.getAdminMailSettingsAsync(opts);
  assert.equal(reread.smtp.host, "live-smtp.example.test");
  assert.equal(reread.templates.welcome.subject, "live 主旨");
  assert.equal(dbMod.getStoredSmtp().host, "live-smtp.example.test", "本機同步讀者也要看到同一份");
  assert.equal(dbMod.getMailTemplates().welcome.subject, "live 主旨");

  // 2. OAuth 設定
  const oauthSaved = await adminAsync.saveAdminOauthSettingsAsync({
    oauth: { google: { enabled: true, clientId: "live-gid", clientSecret: "live-gsecret" } },
  }, opts);
  assert.equal(oauthSaved.oauth.google.clientId, "live-gid");
  assert.equal(oauthSaved.oauth.google.clientSecret, undefined, "公開形狀不得帶出 secret");
  const pgOauth = await readKey("oauth");
  assert.equal(pgOauth.google.clientSecret, "live-gsecret", "PG 的 settings.oauth 必須存完整設定");
  assert.equal((await adminAsync.getStoredOauthAsync(opts)).google.clientId, "live-gid", "讀回來要一致");
  assert.equal(dbMod.getStoredOauth().google.clientId, "live-gid", "本機同步讀者也要看到同一份");
});
