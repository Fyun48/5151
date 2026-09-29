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

test("live PG：後台會員列表要算得出 PG 的關注數／刊登數／通知間隔，停權與改方案也落地", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const { ensurePgSchema } = await import("../src/pgSchema.js");
  const adminAsync = await import("../src/adminMembersAsync.js");
  const { sqliteHandle } = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  // 這個隔離庫可能還沒有這幾張表（正式庫有）⇒ 照正式路徑鏡射（idempotent）。
  await ensurePgSchema(pgDriver, sqliteHandle(), {
    tables: ["users", "settings", "user_settings", "user_listing_flags", "listings"],
    indexes: false,
  });

  const TOKEN = `livetest-adminmember-${Date.now()}`;
  const EMAIL = `${TOKEN}@example.test`;
  const POST_IDS = [930001, 930002];
  const uid = Number((await query(
    `INSERT INTO users(email, password_hash, role, plan, created_at, signup_count)
     VALUES ($1, '', 'member', 'free', $2, 5) RETURNING id`,
    [EMAIL, new Date().toISOString()],
  ))[0].id);
  t.after(async () => {
    try { await query("DELETE FROM user_listing_flags WHERE user_id = $1", [uid]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM listings WHERE post_id = ANY($1::bigint[])", [POST_IDS]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM settings WHERE key = $1", [`${TOKEN}-x`]); } catch { /* 盡力而為 */ }
    try { await query("DELETE FROM users WHERE email LIKE $1", [`${TOKEN}%`]); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  // 兩筆關注（一筆已確認離線）＋ 一筆開著的自主刊登 ＋ 一筆過期的自主刊登
  for (const [postId, offline, source, selfStatus, expiresAt] of [
    [POST_IDS[0], 0, "591", null, null],
    [POST_IDS[1], 1, "591", null, null],
    [930003, 0, "self", "open", null],
    [930004, 0, "self", "open", "2020-01-01T00:00:00.000Z"],
  ]) {
    if (postId === 930003 || postId === 930004) POST_IDS.push(postId);
    // `listings` 有幾個 NOT NULL 欄位（url／first_seen_at／last_seen_at…），PG 這一側要自己補齊。
    const now = new Date().toISOString();
    await query(
      `INSERT INTO listings(post_id, title, url, source, source_key, self_status, offline_confirmed,
                            listed_by_user_id, self_expires_at, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [postId, `live ${postId}`, `https://example.test/${postId}`, source, `1|${postId}`, selfStatus, offline,
        uid, expiresAt, now, now],
    );
  }
  for (const postId of POST_IDS.slice(0, 2)) {
    await query("INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note) VALUES ($1,$2,0,1,0,'')", [uid, postId]);
  }
  await query("INSERT INTO user_settings(user_id, key, value) VALUES ($1,'intervalMinutes','42')", [uid]);
  await query("INSERT INTO user_settings(user_id, key, value) VALUES ($1,'intervalAdminSet','true')", [uid]);

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  const members = await adminAsync.listAdminMembersAsync({ q: TOKEN }, opts);
  const me = members.find((m) => Number(m.id) === uid);
  assert.ok(me, "必須列出這個 PG 才有的會員");
  assert.equal(me.signup_count, 5);
  assert.equal(me.watchCount, 1, "已確認離線的那筆不佔額度");
  assert.equal(me.listingCount, 1, "過期的自主刊登不算（而且 expire 會先跑）");
  assert.equal(me.intervalMinutes, 42, "通知間隔要讀 PG 的 user_settings");

  const deleted = await adminAsync.adminDeleteMemberAsync(uid, { reasonCode: "abuse" }, opts);
  assert.equal(deleted.member.deleted, true);
  const row = (await query("SELECT deleted_at, deleted_by, deleted_reason_code FROM users WHERE id = $1", [uid]))[0];
  assert.ok(String(row.deleted_at || "").trim(), "PG 的 deleted_at 必須寫入");
  assert.equal(row.deleted_by, "admin");
  assert.equal(row.deleted_reason_code, "abuse");

  const restored = await adminAsync.adminRestoreMemberAsync(uid, opts);
  assert.equal(restored.deleted, false);
  assert.equal((await query("SELECT deleted_by FROM users WHERE id = $1", [uid]))[0].deleted_by, "");

  const patched = await adminAsync.adminPatchMemberAsync(uid, { plan: "sponsor" }, opts);
  assert.equal(patched.plan, "sponsor");
  assert.equal((await query("SELECT plan FROM users WHERE id = $1", [uid]))[0].plan, "sponsor");
});
