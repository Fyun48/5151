// OAuth callback 的 **live PG** 驗證（2026-09-29，第八十五批）。
//
// 離線 parity 用的是注入式 runner，證明不了三件事：
//
//   1. **綁定欄位真的寫進 PG**：同步版寫的是節點本機 SQLite，PG 模式沒有人讀得到，
//      而且同步版的 try/catch 會把它吞掉（靜默失效）。
//   2. **登入讀得到**：`findUserByEmailAsync()`（登入／忘記密碼／驗證信都走它）要能在 PG
//      看到同一組 provider／subject——否則會員換節點登入就失去社群綁定。
//   3. **本機沒有被寫**：PG 模式下島嶼版不該在本機 `users` 留下這一列（那正是「跨店錯位」的來源）。
//
// 另外釘住 callback 暱稱分支用的 `updateUserProfileWithLegalAsync()`：它在真 PG 上要寫得進去，
// 而且 `getLegalCopyAsync()` 讀的是 PG 的法律文案（同步版讀節點本機那一份）。
//
// ⚠️ 安全設計照抄 `member-consents-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-oauthcb-live-"));
process.env.DATA_DIR = dataDir;
const MARK = `livetest-oauthcb-${Date.now()}`;
const STAMP = "2026-01-01T00:00:00.000Z";
const EMAIL = `${MARK}@example.test`;

test("live PG：社群綁定寫進 PG、登入讀得到、本機不被寫，暱稱更新也落在 PG", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const usersAsync = await import("../src/usersAsync.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  const opts = { driver: "postgres", pgDriver, exec, strict: true };
  const local = dbMod.sqliteHandle();
  let userId = 0;

  t.after(async () => {
    if (userId) {
      try { await query("DELETE FROM users WHERE id = $1", [userId]); } catch { /* 盡力而為 */ }
    }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  await query("SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM users), 1))");
  userId = Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'PG 社群會員','member','free',$2) RETURNING id",
    [EMAIL, STAMP],
  ))[0].id);

  // 前提：本機真的沒有這個帳號，否則「本機沒被寫」證明不了任何事。
  assert.equal(dbMod.findUserByEmail(EMAIL), null, "前提：本機 SQLite 不該有這個帳號");

  const provider = "p".repeat(60);
  const subject = "s".repeat(200);
  await usersAsync.linkOauthIdentityAsync(userId, { provider, subject }, opts);

  // 1＋2：PG 讀得到（截斷規則與同步版一致：40／120）。
  const pgRow = (await query("SELECT oauth_provider, oauth_subject FROM users WHERE id = $1", [userId]))[0];
  assert.equal(pgRow.oauth_provider, provider.slice(0, 40), "PG 要拿到截斷後的 provider");
  assert.equal(pgRow.oauth_subject, subject.slice(0, 120), "PG 要拿到截斷後的 subject");
  const viaLoginPath = await usersAsync.findUserByEmailAsync(EMAIL, opts);
  assert.equal(viaLoginPath.oauth_provider, provider.slice(0, 40), "登入讀的 findUserByEmailAsync 要看得到綁定");
  assert.equal(viaLoginPath.oauth_subject, subject.slice(0, 120));

  // 3：本機沒有被寫。
  assert.equal(dbMod.findUserByEmail(EMAIL), null, "PG 模式不得在本機留下這一列");

  // callback 暱稱分支：真 PG 上寫得進去，而且讀回來的列帶著新暱稱。
  const nick = "社群暱稱測試"; // 暱稱規則 2～20 字，`MARK` 太長
  const updated = await usersAsync.updateUserProfileWithLegalAsync(userId, { nickname: nick }, opts);
  assert.equal(updated.nickname, nick, "PG 的暱稱要更新");
  assert.equal((await query("SELECT nickname FROM users WHERE id = $1", [userId]))[0].nickname, nick);
  assert.ok(String(updated.privacy_text || "").length > 0, "法律文案要從 PG 讀到（不是節點本機那一份）");
});
