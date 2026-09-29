// 註冊（帳號 ＋ 同意 ＋ 開通 token）的 **live PG** 驗證（2026-09-28，第七十五批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **`USER_REGISTER_INSERT_SQL` 的 `RETURNING id` 在真 PG 上真的回 id**，而且
//      `profile_privacy_at` 的 `COALESCE(NULLIF(...))` 寫得進去（同步版只寫本機）。
//   2. **同意紀錄與帳號落在同一個交易**（`pgDriver.withTransaction`）：這一條在真 PG 上才有意義。
//   3. **整條「註冊 → 點信裡的連結」在 PG 上走得完**：`issueVerifyTokenAsync()` 寫的 token
//      必須讓 `confirmVerifyTokenAsync()` 找得到——同步版寫本機，會員點連結就是 404。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-register-live-"));
process.env.DATA_DIR = dataDir;

test("live PG：註冊 → 開通信 → 點連結開通，帳號／同意／token 全部落在 PG", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const usersAsync = await import("../src/usersAsync.js");
  const verifyAsync = await import("../src/emailVerifyAsync.js");
  const docsAsync = await import("../src/contentDocumentsAsync.js");
  const { sqliteHandle } = await import("../src/db.js");
  const { verifyPassword } = await import("../src/password.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  // 匯入過資料的庫，序列常常落後 max(id) ⇒ 先對齊，否則 INSERT 會撞主鍵。
  const pk = (await query(
    `SELECT a.attname AS column FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'users'::regclass AND i.indisprimary`,
  ))[0]?.column;
  assert.ok(pk, "users 必須有主鍵（序列同步要用）");
  await query(`SELECT setval(pg_get_serial_sequence('users', $1), GREATEST((SELECT COALESCE(MAX("${pk}"),0) FROM users), 1))`, [pk]);

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 註冊文件（bootstrap 種的）——同意清單要照著目前有效版本送。
  // ⚠️ 同意列是 append-only（DDL 有 trigger 擋 DELETE）⇒ 測試資料不能靠刪除隔離，
  // 這支測試用**全新的 Email**，收尾不刪帳號（只把名字標成已刪除，避免佔用那個 Email）。
  const docs = await docsAsync.getRequiredRegistrationDocumentsAsync({ ...opts });
  assert.equal(docs.length, 2, `真 PG 上要有兩份註冊文件（實際 ${docs.length} 份）`);
  const consents = docs.map((doc) => ({
    document_type: doc.document_type, document_id: doc.id, version: doc.version, content_hash: doc.content_hash,
  }));

  const TOKEN = `livetest-register-${Date.now()}`;
  const EMAIL = `${TOKEN}@example.test`;
  // ⚠️ 收尾只能「改名字 ＋ 標記刪除」，不能刪：`member_consents` 是 append-only，
  // 帳號有同意列就刪不掉（FK）。順序也不能顛倒——連線要先關，池關掉之後 query 會直接失敗。
  t.after(async () => {
    try {
      await query("UPDATE users SET email = $1, deleted_at = $2 WHERE email = $3", [`deleted-${TOKEN}@example.test`, new Date().toISOString(), EMAIL]);
    } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  // 1) 註冊：帳號 ＋ 同意列一起落地（同一個交易）
  const user = await usersAsync.registerUserWithConsentsAsync(
    { email: EMAIL, password: "livepassword1", acceptDisclaimer: true, emailVerified: false, consents },
    { ...opts },
  );
  assert.equal(user.email, EMAIL);
  assert.equal(Number(user.email_verified), 0, "註冊後必須是未驗證（要先點信）");
  assert.equal(Number(user.signup_count), 1);
  assert.equal(user.plan, "free");
  assert.ok(verifyPassword("livepassword1", user.password_hash), "PG 上的雜湊要能驗證新密碼");
  const pgConsents = await query("SELECT document_type, content_hash, source FROM member_consents WHERE user_id = $1 ORDER BY document_type", [user.id]);
  assert.equal(pgConsents.length, 2, "兩份註冊文件都要有同意列");
  assert.ok(pgConsents.every((row) => row.source === "registration"), "來源必須是 registration");
  assert.equal(
    sqliteHandle().prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(EMAIL).n, 0,
    "PG 模式的註冊不得寫本機（否則登入讀 PG 會找不到人）",
  );

  // 2) 開通信：token 寫進 PG，而且 PG 的確認流程找得到它（同步版這裡會 404）
  const { token, expiresAt } = await verifyAsync.issueVerifyTokenAsync(user.id, {}, { ...opts });
  assert.ok(Date.parse(expiresAt) > Date.now(), "到期時間必須在未來");
  const issued = (await query("SELECT verify_token, verify_expires_at, email_verified FROM users WHERE id = $1", [user.id]))[0];
  assert.equal(issued.verify_token, token, "token 必須落在 PG");
  assert.equal(issued.verify_expires_at, expiresAt);
  assert.equal(Number(issued.email_verified), 0);
  const confirmed = await verifyAsync.confirmVerifyTokenAsync(token, {}, { ...opts });
  assert.equal(Number(confirmed.id), Number(user.id), "點連結要能開通（回同一個帳號）");

  // 3) 已開通之後再註冊同一個 Email → 409（與同步版同一個訊息）
  const again = await usersAsync.registerUserWithConsentsAsync(
    { email: EMAIL, password: "livepassword2", acceptDisclaimer: true, emailVerified: false, consents },
    { ...opts },
  ).then(() => null, (error) => error);
  assert.equal(again?.status, 409, "已註冊的 Email 必須是 409");
  assert.equal(again?.message, "這個 Email 已經註冊過了");
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM users WHERE email = $1", [EMAIL]))[0].n, 1,
    "被擋下時不得多一列",
  );
});
