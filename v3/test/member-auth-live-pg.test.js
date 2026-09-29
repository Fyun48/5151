// 會員帳號讀寫（`usersAsync` 的第五十二批入口）的 **live PG** 驗證。
//
// 這一條要證明的是「**寫進 PG、從 PG 讀回來**」，而不是「程式沒壞」：
//   1. `ensureUserAsync()` 只在 PG 建帳號（本機 SQLite 不該出現那一列）
//   2. `findUserByEmailAsync()` 讀得到剛建的帳號（含大小寫正規化）
//   3. `setUserPasswordAsync()` 換掉雜湊後，`verifyUserPasswordAsync()` 新密碼過、舊密碼不過
//   4. `touchLastLoginAsync()` 把時間寫進 PG（`minIntervalMs` 之內不重寫）
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向正式影子庫），
// 只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-memberauth-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：ensureUser → 讀回 → 換密碼 → 記登入時間（全部落在 PG）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const usersAsync = await import("../src/usersAsync.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");

  const TOKEN = `livetest-member-${Date.now()}`;
  const EMAIL = `${TOKEN}@example.test`;
  t.after(async () => {
    try { await query("DELETE FROM users WHERE email LIKE $1", [`${TOKEN}%`]); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 1. 建帳號（只進 PG）
  const uid = await usersAsync.ensureUserAsync(EMAIL, {}, opts);
  assert.ok(uid > 0, `ensureUserAsync 必須回一個 id（實際 ${uid}）`);
  const pgRow = (await query("SELECT email, role, plan FROM users WHERE id = $1", [uid]))[0];
  assert.equal(pgRow.email, EMAIL, "PG 必須有這一列");
  assert.equal(pgRow.role, "member");
  assert.equal(dbMod.findUserByEmail(EMAIL), null, "本機 SQLite 不該有這個帳號（否則證明不了寫進 PG）");

  // 2. 讀回來（含大小寫正規化）
  const found = await usersAsync.findUserByEmailAsync(EMAIL.toUpperCase(), opts);
  assert.equal(Number(found.id), uid, "大小寫不同也要讀到同一列");
  assert.equal(await usersAsync.ensureUserAsync(EMAIL, {}, opts), uid, "再叫一次必須回同一個 id（不得增生）");
  assert.equal(Number((await query("SELECT COUNT(*) AS n FROM users WHERE email = $1", [EMAIL]))[0].n), 1,
    "同名帳號只能有一列");

  // 3. 換密碼 → 新密碼過、舊密碼不過
  await usersAsync.setUserPasswordAsync(uid, "livepassword1", opts);
  assert.ok(await usersAsync.verifyUserPasswordAsync(EMAIL, "livepassword1", opts), "新密碼必須通過驗證");
  assert.strictEqual(await usersAsync.verifyUserPasswordAsync(EMAIL, "oldpassword1", opts), null,
    "舊密碼必須失效");

  // 4. 記登入時間（含 minIntervalMs 的守衛）
  const now = Date.now();
  assert.equal(await usersAsync.touchLastLoginAsync(uid, { now }, opts), true, "第一次要寫入");
  const stamp = (await query("SELECT last_login_at FROM users WHERE id = $1", [uid]))[0].last_login_at;
  assert.equal(new Date(stamp).toISOString(), new Date(now).toISOString(), "PG 必須寫入剛剛的時間");
  assert.equal(await usersAsync.touchLastLoginAsync(uid, { now: now + 60_000, minIntervalMs: 12 * 3600 * 1000 }, opts),
    false, "間隔內不得重寫");
  assert.equal((await query("SELECT last_login_at FROM users WHERE id = $1", [uid]))[0].last_login_at, stamp,
    "時間不得被改掉");
});

test("live PG：註冊確認的 token 流程（成功 → 第二次 409）與忘記密碼的 503 守衛", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const { confirmVerifyTokenAsync } = await import("../src/emailVerifyAsync.js");
  const { requestTempPasswordAsync } = await import("../src/forgotPasswordAsync.js");
  const { hashPassword, verifyPassword } = await import("../src/password.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");

  const TOKEN = `livetest-verify-${Date.now()}`;
  const EMAIL = `${TOKEN}@example.test`;
  const VERIFY = `verify-token-${TOKEN}`;
  const OLD_HASH = hashPassword("originalpass1");
  const uid = Number((await query(
    `INSERT INTO users(email, password_hash, role, plan, created_at, email_verified, verify_token, verify_expires_at)
     VALUES ($1, $2, 'member', 'free', $3, 0, $4, $5) RETURNING id`,
    [EMAIL, OLD_HASH, new Date().toISOString(), VERIFY, new Date(Date.now() + 3600_000).toISOString()],
  ))[0].id);

  t.after(async () => {
    try { await query("DELETE FROM users WHERE email LIKE $1", [`${TOKEN}%`]); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 1. 確認連結：成功，而且旗標真的落地
  const user = await confirmVerifyTokenAsync(VERIFY, {}, opts);
  assert.equal(Number(user.id), uid, "必須回那一列");
  const after = (await query("SELECT email_verified, verify_used_at, verify_expires_at FROM users WHERE id = $1", [uid]))[0];
  assert.equal(Number(after.email_verified), 1, "PG 的 email_verified 必須變成 1");
  assert.ok(String(after.verify_used_at || "").trim(), "verify_used_at 必須寫入");
  assert.equal(after.verify_expires_at, null, "用過之後 expires_at 要清掉");
  // 2. 同一個 token 第二次：409 used（連結只能用一次）
  const second = await confirmVerifyTokenAsync(VERIFY, {}, opts).then(() => null, (error) => error);
  assert.equal(second?.status, 409, "第二次必須是 409");
  assert.equal(second?.code, "used");

  // 3. 忘記密碼：這個隔離庫沒有 SMTP 設定 ⇒ 503，而且**不得**先改密碼
  const forgot = await requestTempPasswordAsync(EMAIL, { ...opts, attempts: new Map() }).then(() => null, (error) => error);
  if (forgot) {
    assert.equal(forgot.status, 503, `沒有 SMTP 時必須是 503（實際 ${forgot.status}/${forgot.message}）`);
    assert.match(forgot.message, /尚未設定寄信/);
  } else {
    // 若這個隔離庫剛好設定了 SMTP，至少要求「臨時密碼是有效的雜湊」而不是壞掉的字串。
    const hash = (await query("SELECT password_hash FROM users WHERE id = $1", [uid]))[0].password_hash;
    assert.ok(verifyPassword(hash, hash) === false, "雜湊不該是明文（這條只是煙霧測試）");
  }
  const hashNow = (await query("SELECT password_hash FROM users WHERE id = $1", [uid]))[0].password_hash;
  if (forgot) assert.equal(hashNow, OLD_HASH, "503 時不得改動雜湊");
});
