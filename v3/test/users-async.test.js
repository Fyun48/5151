// `getUserByIdAsync()` 的 parity（2026-09-28）。
//
// 這一支本身不難，但它是「缺口頭號卡點（25 條路由）」的第一步，所以要把**形狀**釘死：
// 呼叫端（`adminPatchMember`、`getSettings`、`saveSettings`…）都是靠 `user?.role`／`user?.plan`
// 做判斷，而「查不到人」必須回 **null**（不是 undefined、不是空物件），
// 否則那些 `if (!user)` 的守衛會失效。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-users-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const usersAsync = await import("../src/usersAsync.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const UID = 900000001001;
const ADMIN = 900000001002;

function fixture() {
  const mem = new DatabaseSync(":memory:");
  const ddl = handle().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  assert.ok(ddl?.sql, "必須抓到 users 的 DDL");
  mem.exec(ddl.sql);
  const exec = async (sql, params = []) => {
    const rows = mem.prepare(sql).all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
  exec.raw = mem;
  return exec;
}

function resetWorld() {
  const db = handle();
  db.prepare("DELETE FROM users WHERE id >= 900000000000").run();
  for (const [id, email, role, plan] of [[UID, "u1@example.com", "member", "pro"], [ADMIN, "u2@example.com", "admin", "free"]]) {
    db.prepare(
      "INSERT INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'?','?','2026-01-01T00:00:00.000Z')"
        .replace("'?'", "?").replace("'?'", "?"),
    ).run(id, email, `n${id}`, role, plan);
  }
  const exec = fixture();
  for (const row of db.prepare("SELECT * FROM users").all()) {
    const cols = Object.keys(row);
    exec.raw.prepare(`INSERT INTO users(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .run(...cols.map((c) => row[c]));
  }
  return [db, exec];
}

// ---------------------------------------------------------------------------

test("查得到人：role／plan 與同步版相同（呼叫端靠這兩個欄位）", async () => {
  const [db, exec] = resetWorld();
  const sync = dbMod.getUserById(UID);
  const asyncUser = await usersAsync.getUserByIdAsync(UID, { ...PG, exec, strict: true });
  assert.equal(asyncUser.id, sync.id);
  assert.equal(asyncUser.role, sync.role, "role 必須相同");
  assert.equal(asyncUser.plan, sync.plan, "plan 必須相同");
  assert.equal(asyncUser.email, sync.email);
  assert.equal(asyncUser.role, "member");
  assert.equal(asyncUser.plan, "pro", "必須真的讀到非預設值（否則這條沒鑑別力）");
});

test("查不到人：必須回 null（不是 undefined、不是空物件）", async () => {
  const [, exec] = resetWorld();
  const missing = await usersAsync.getUserByIdAsync(999999999, { ...PG, exec, strict: true });
  // ⚠️ 一定要用**嚴格**比較：`assert.equal(undefined, null)` 是通過的，
  // 所以「回 undefined 而不是 null」的變異原本殺不死（變異測試抓到的）。
  assert.strictEqual(missing, null, "查不到必須是 null（不是 undefined）");
  assert.strictEqual(dbMod.getUserById(999999999), null, "同步版也是 null（兩邊形狀一致）");
  // 0／非數字：同步版直接回 null，PG 版必須一樣（不要送出一句 id = 0 的查詢）
  for (const bad of [0, null, undefined, "abc", ""]) {
    assert.strictEqual(
      await usersAsync.getUserByIdAsync(bad, { ...PG, exec, strict: true }), null,
      `uid=${String(bad)} 必須是 null（嚴格比較）`,
    );
  }
  // 而且**不得**真的送出查詢（送出去就代表守衛被拿掉了）
  let calls = 0;
  const counting = async (sql, params = []) => {
    calls += 1;
    const rows = exec.raw.prepare(sql).all(...params);
    return { rows, rowCount: rows.length };
  };
  counting.raw = exec.raw;
  await usersAsync.getUserByIdAsync(0, { ...PG, exec: counting, strict: true });
  assert.equal(calls, 0, "uid 0 時不得送出查詢（守衛必須在呼叫前就早退）");
});

test("admin 的 role 要正確（權限判斷的來源）", async () => {
  const [db, exec] = resetWorld();
  assert.equal(dbMod.getUserById(ADMIN).role, "admin");
  const asyncAdmin = await usersAsync.getUserByIdAsync(ADMIN, { ...PG, exec, strict: true });
  assert.equal(asyncAdmin.role, "admin");
  assert.equal(asyncAdmin.role, dbMod.getUserById(ADMIN).role);
});

test("寫入失敗時 fail-closed：PG 丟錯就往上丟，不得靜默回退 SQLite", async () => {
  resetWorld();
  const bad = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    () => usersAsync.getUserByIdAsync(UID, { ...PG, exec: bad, strict: true }),
    /connection terminated/,
  );
});

test("非 postgres 必須回退同步路徑（讀磁碟，完全不碰傳入的 exec）", async () => {
  const [db, exec] = resetWorld();
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const user = await usersAsync.getUserByIdAsync(UID, { driver: "sqlite", exec: boom });
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.equal(user.id, dbMod.getUserById(UID).id, "sqlite 模式必須讀磁碟");
});

// ---- 第五十二批：會員帳號的讀寫 ---------------------------------------------
//
// 這一組的核心風險是「**寫進沒人讀的 store**」與「**拿錯 store 的 id**」：
// 同步版 `defaultUserId()` 在第一次呼叫時會在本機 INSERT 一個 admin，並回傳**本機 id**；
// PG 模式下那個 id 拿去讀 PG 設定就會錯位。下面每一條都刻意讓「只在 PG 存在」的資料
// 成為唯一來源，這樣少讀／讀錯 store 都會當場變紅。

const MEMBER = { id: 900000002001, email: "member@example.test" };

const passwordMod = await import("../src/password.js");

function seedWorld() {
  const [db, exec] = resetWorld();
  const now = "2026-01-01T00:00:00.000Z";
  // 刻意讓密碼雜湊兩個 store 相同（比對成功與失敗才有鑑別力）。
  const hash = passwordMod.hashPassword("oldpassword1");
  db.prepare("INSERT INTO users(id, email, role, plan, created_at, password_hash) VALUES (?,?,?,?,?,?)")
    .run(MEMBER.id, MEMBER.email, "member", "free", now, hash);
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(MEMBER.id);
  const cols = Object.keys(row);
  exec.raw.prepare(`INSERT INTO users(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map((c) => (c === "password_hash" ? hash : row[c])));
  return [db, exec];
}

test("findUserByEmail：PG 與同步版逐欄相同（含大小寫正規化）", async () => {
  const [db, exec] = await seedWorld();
  const sync = dbMod.findUserByEmail(MEMBER.email);
  for (const probe of [MEMBER.email, MEMBER.email.toUpperCase(), `  ${MEMBER.email}  `]) {
    const got = await usersAsync.findUserByEmailAsync(probe, { ...PG, exec, strict: true });
    assert.ok(got, `必須查得到（${probe}）`);
    assert.equal(got.id, sync.id, "id 必須相同");
    assert.equal(got.email, sync.email, "email 必須相同");
    assert.equal(got.role, "member");
  }
  assert.strictEqual(await usersAsync.findUserByEmailAsync("nobody@example.test", { ...PG, exec, strict: true }), null,
    "查不到必須是 null（嚴格比較）");
  assert.strictEqual(await usersAsync.findUserByEmailAsync("", { ...PG, exec, strict: true }), null, "空字串直接回 null");
});

test("verifyUserPassword：對的密碼回那一列、錯的與已刪除都回 null", async () => {
  const [db, exec] = await seedWorld();
  const ok = await usersAsync.verifyUserPasswordAsync(MEMBER.email, "oldpassword1", { ...PG, exec, strict: true });
  assert.ok(ok, "密碼正確要回使用者");
  assert.equal(ok.id, MEMBER.id);
  assert.strictEqual(await usersAsync.verifyUserPasswordAsync(MEMBER.email, "wrongpassword", { ...PG, exec, strict: true }), null,
    "密碼錯誤必須回 null");
  assert.strictEqual(dbMod.verifyUserPassword(MEMBER.email, "wrongpassword"), null, "同步版同義");
  // 已刪除的帳號不得登入（兩邊都要）
  db.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").run("2026-02-01T00:00:00.000Z", MEMBER.id);
  exec.raw.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").run("2026-02-01T00:00:00.000Z", MEMBER.id);
  assert.strictEqual(await usersAsync.verifyUserPasswordAsync(MEMBER.email, "oldpassword1", { ...PG, exec, strict: true }), null,
    "已刪除的帳號不得通過驗證");
});

test("setUserPassword：PG 換掉雜湊，且新密碼可通過驗證、舊密碼失效", async () => {
  const [db, exec] = await seedWorld();
  await usersAsync.setUserPasswordAsync(MEMBER.id, "newpassword1", { ...PG, exec, strict: true });
  const pgHash = exec.raw.prepare("SELECT password_hash FROM users WHERE id = ?").get(MEMBER.id).password_hash;
  assert.notEqual(pgHash, db.prepare("SELECT password_hash FROM users WHERE id = ?").get(MEMBER.id).password_hash,
    "PG 的雜湊必須真的被換掉（不是只回傳成功）");
  assert.ok(await usersAsync.verifyUserPasswordAsync(MEMBER.email, "newpassword1", { ...PG, exec, strict: true }),
    "新密碼要能通過驗證");
  assert.strictEqual(await usersAsync.verifyUserPasswordAsync(MEMBER.email, "oldpassword1", { ...PG, exec, strict: true }), null,
    "舊密碼要失效");
  // 密碼政策兩邊共用（太短要丟錯，而不是靜默寫入）
  await assert.rejects(() => usersAsync.setUserPasswordAsync(MEMBER.id, "short", { ...PG, exec, strict: true }),
    /密碼|至少/);
});

test("ensureUser：不存在就建、存在就回原本的 id（role 決定 admin／member）", async () => {
  const [db, exec] = await seedWorld();
  const created = await usersAsync.ensureUserAsync("brand-new@example.test", {}, { ...PG, exec, strict: true });
  assert.ok(created > 0, "要回一個 id");
  const row = exec.raw.prepare("SELECT * FROM users WHERE id = ?").get(created);
  assert.equal(row.email, "brand-new@example.test");
  assert.equal(row.role, "member", "預設是 member");
  assert.equal(row.plan, "free");
  // 再叫一次不得多一列
  const again = await usersAsync.ensureUserAsync("brand-new@example.test", {}, { ...PG, exec, strict: true });
  assert.equal(again, created, "第二次必須回同一個 id");
  assert.equal(Number(exec.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get("brand-new@example.test").n), 1);
  // admin 由 role 指定（`AUTH_EMAIL` 的人也一律 admin）
  const admin = await usersAsync.ensureUserAsync("ops@example.test", { role: "admin" }, { ...PG, exec, strict: true });
  assert.equal(exec.raw.prepare("SELECT role FROM users WHERE id = ?").get(admin).role, "admin");
  assert.equal(await usersAsync.ensureUserAsync("", {}, { ...PG, exec, strict: true }), 0, "空字串回 0");
});

test("defaultUserIdAsync：必須在 PG 建帳號並回 PG 的 id（不是本機的）", async () => {
  const [db, exec] = await seedWorld();
  // 把 PG 夾具清空：這樣「回本機 id」與「回 PG id」一定不同，
  // 而且本機的快取（bootstrap 建過 admin）也掩蓋不了——突變才殺得死。
  exec.raw.exec("DELETE FROM users");
  const localBefore = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const uid = await usersAsync.defaultUserIdAsync({ ...PG, exec, strict: true });
  assert.ok(uid > 0, "要回一個 id");
  const pgRow = exec.raw.prepare("SELECT email, role FROM users WHERE id = ?").get(uid);
  assert.ok(pgRow, `PG 必須有這個 id（實際 ${uid}）`);
  assert.equal(pgRow.role, "admin", "預設帳號是 admin");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, localBefore,
    "PG 模式不得在本機多建帳號（同步版會，那正是這一支要修掉的）");
  // 第二次要回同一個 id（同名帳號只有一筆）
  assert.equal(await usersAsync.defaultUserIdAsync({ ...PG, exec, strict: true }), uid, "第二次必須回同一個 id");
});

test("touchLastLogin：寫入 PG、minIntervalMs 之內不重寫、PG 壞掉時吞掉回 false", async () => {
  const [db, exec] = await seedWorld();
  const t1 = Date.parse("2026-03-01T00:00:00.000Z");
  assert.equal(await usersAsync.touchLastLoginAsync(MEMBER.id, { now: t1 }, { ...PG, exec, strict: true }), true);
  assert.equal(exec.raw.prepare("SELECT last_login_at FROM users WHERE id = ?").get(MEMBER.id).last_login_at,
    new Date(t1).toISOString(), "PG 必須寫入時間");
  // 兩小時內不重寫（同步版同義）
  assert.equal(await usersAsync.touchLastLoginAsync(MEMBER.id, { now: t1 + 60 * 60 * 1000, minIntervalMs: 12 * 60 * 60 * 1000 },
    { ...PG, exec, strict: true }), false, "間隔內不得重寫");
  assert.equal(exec.raw.prepare("SELECT last_login_at FROM users WHERE id = ?").get(MEMBER.id).last_login_at,
    new Date(t1).toISOString(), "時間不得被改掉");
  // best-effort：PG 壞掉時回 false，不往上丟
  const bad = async () => { throw new Error("boom"); };
  assert.equal(await usersAsync.touchLastLoginAsync(MEMBER.id, { now: t1 }, { ...PG, exec: bad, strict: true }), false,
    "寫不進去不該擋住登入（同步版也吞掉）");
  assert.equal(await usersAsync.touchLastLoginAsync(0, {}, { ...PG, exec, strict: true }), false, "id 0 直接回 false");
});

test("resumeIdleIfNeededAsync：暫停中的會員會被恢復（設定讀寫都走 PG）", async () => {
  const [db, exec] = await seedWorld();
  // 這個測試要動設定：把 `settings`／`user_settings` 的 DDL 也鏡射進夾具（夾具不自己寫定義）。
  for (const table of ["settings", "user_settings"]) {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    exec.raw.exec(ddl.sql);
  }
  const settings = await import("../src/settingsAsync.js");
  const rows = await settings.getSettingsAsync(MEMBER.id, { ...PG, exec, strict: true });
  assert.equal(Boolean(rows?.inactivityPaused), false, "前提：預設不是暫停中");
  // 走完整條：先標記暫停 → resume → 必須恢復
  const saved = await settings.saveSettingsAsync({ inactivityPaused: true, notificationsPaused: true }, MEMBER.id,
    { ...PG, exec, strict: true });
  assert.equal(saved.inactivityPaused, true, "前提：暫停旗標要寫得進去");
  const out = await usersAsync.resumeIdleIfNeededAsync(MEMBER.id, { ...PG, exec, strict: true });
  assert.equal(out.resumed, true, "暫停中的會員必須被恢復");
  const after = await settings.getSettingsAsync(MEMBER.id, { ...PG, exec, strict: true });
  assert.equal(Boolean(after.inactivityPaused), false, "PG 的那一份要真的被改掉");
});

test("非 postgres：新入口全部走同步路徑（完全不碰 exec）", async () => {
  const [db, exec] = await seedWorld();
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const sqlite = { driver: "sqlite", exec: boom };
  const syncBefore = dbMod.findUserByEmail(MEMBER.email);
  assert.equal((await usersAsync.findUserByEmailAsync(MEMBER.email, sqlite)).id, syncBefore.id);
  assert.equal((await usersAsync.verifyUserPasswordAsync(MEMBER.email, "oldpassword1", sqlite)).id, MEMBER.id);
  assert.ok(await usersAsync.ensureUserAsync(MEMBER.email, {}, sqlite) > 0);
  const hashBefore = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(MEMBER.id).password_hash;
  await usersAsync.setUserPasswordAsync(MEMBER.id, "anotherpass1", sqlite);
  assert.notEqual(db.prepare("SELECT password_hash FROM users WHERE id = ?").get(MEMBER.id).password_hash, hashBefore,
    "sqlite 模式要真的改本機的雜湊");
  assert.equal(await usersAsync.touchLastLoginAsync(MEMBER.id, {}, sqlite), true);
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
});

// ---------------------------------------------------------------------------
// 第七十批：`changeUserPasswordAsync()`（`POST /api/change-password`）。
// PG 模式下這一條原本只寫本機 SQLite，而登入讀的是 PG ⇒ 使用者改了密碼卻只能用舊密碼登入。
// ---------------------------------------------------------------------------

const NEW_PASSWORD = "newpass1234";
const OLD_PASSWORD = "oldpass1234";

test("改密碼：PG 分支驗的是 PG 的雜湊（本機那一份不同也不影響）", async () => {
  const [db, exec] = resetWorld();
  const password = await import("../src/password.js");
  const goodHash = password.hashPassword(OLD_PASSWORD);
  // PG 上是真正的舊密碼；本機刻意放**不同**的雜湊（PG 模式的實況：本機是舊資料）。
  exec.raw.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(goodHash, UID);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(password.hashPassword("something-else"), UID);

  const result = await usersAsync.changeUserPasswordAsync(UID, OLD_PASSWORD, NEW_PASSWORD, { ...PG, exec, strict: true });
  assert.equal(result?.id, UID, "成功時要回 publicUser（與同步版同形狀）");
  const pgHash = exec.raw.prepare("SELECT password_hash FROM users WHERE id = ?").get(UID).password_hash;
  assert.equal(password.verifyPassword(NEW_PASSWORD, pgHash), true, "PG 上的雜湊必須換成新密碼");
  assert.equal(password.verifyPassword(OLD_PASSWORD, pgHash), false, "舊密碼必須失效");
  const localHash = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(UID).password_hash;
  assert.equal(password.verifyPassword(NEW_PASSWORD, localHash), false, "PG 模式不得改動本機那一份（那是無聲的分歧）");
});

test("改密碼：錯誤情境的訊息與狀態碼都與同步版相同", async () => {
  const [db, exec] = resetWorld();
  const password = await import("../src/password.js");
  const hash = password.hashPassword(OLD_PASSWORD);
  for (const h of [db, exec.raw]) h.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, UID);

  const cases = [
    [UID, "wrong-password", NEW_PASSWORD],
    [UID, OLD_PASSWORD, OLD_PASSWORD],
    [UID, OLD_PASSWORD, "short"],
    [UID + 999, OLD_PASSWORD, NEW_PASSWORD],
  ];
  for (const [uid, current, next] of cases) {
    let syncErr = null;
    try { dbMod.changeUserPassword(uid, current, next); } catch (e) { syncErr = e; }
    assert.ok(syncErr, `同步版必須擋下：${current} → ${next}`);
    await assert.rejects(
      () => usersAsync.changeUserPasswordAsync(uid, current, next, { ...PG, exec, strict: true }),
      (e) => e.message === syncErr.message && e.status === syncErr.status,
      `PG 版必須丟同一個錯誤：${syncErr.message}`,
    );
  }
  assert.equal(password.verifyPassword(OLD_PASSWORD, exec.raw.prepare("SELECT password_hash FROM users WHERE id = ?").get(UID).password_hash),
    true, "被擋下時不得改動雜湊");
});

test("改密碼：sqlite 模式回退同步版，且不碰 PG 夾具", async () => {
  const [db, exec] = resetWorld();
  const password = await import("../src/password.js");
  const hash = password.hashPassword(OLD_PASSWORD);
  for (const h of [db, exec.raw]) h.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, UID);
  const pgBefore = exec.raw.prepare("SELECT password_hash FROM users WHERE id = ?").get(UID).password_hash;

  const result = await usersAsync.changeUserPasswordAsync(UID, OLD_PASSWORD, NEW_PASSWORD, { driver: "sqlite", exec });
  assert.equal(result?.id, UID);
  assert.equal(password.verifyPassword(NEW_PASSWORD, db.prepare("SELECT password_hash FROM users WHERE id = ?").get(UID).password_hash), true,
    "sqlite 模式要寫本機那一份");
  assert.equal(exec.raw.prepare("SELECT password_hash FROM users WHERE id = ?").get(UID).password_hash, pgBefore,
    "sqlite 模式不得碰 PG 夾具");
});
