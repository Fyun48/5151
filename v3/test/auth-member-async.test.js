// 登入（`verifyLoginAsync`）讀 PG 的 parity（2026-09-28，第五十二批）。
//
// 這一條的關鍵不是「函式回傳什麼」，而是**它讀哪一個 store**：
// 同步版 `verifyLogin()` 讀節點本機的 `users` ⇒ PG 模式下只有「剛好在本機建過帳號」的人
// 登得進去，別的管理節點建立的成員一律回「帳號或密碼不正確」，而且**沒有任何錯誤訊息**
// 指向真正的原因。所以每個測試都刻意讓「只在 PG 存在」的帳號成為唯一來源。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-authmember-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const password = await import("../src/password.js");
const auth = await import("../src/auth.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const UID = 900000003001;
const EMAIL = "pg-only@example.test";
const PASS = "pgpassword1";

function fixture() {
  const mem = new DatabaseSync(":memory:");
  const ddl = handle().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  assert.ok(ddl?.sql, "必須抓到 users 的 DDL");
  mem.exec(ddl.sql);
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

// 只把帳號放進 **PG**（本機刻意沒有）——這才是 PG 站的真實情況。
function pgOnlyWorld({ emailVerified = 1 } = {}) {
  const exec = fixture();
  exec.raw.prepare(
    `INSERT INTO users(id, email, nickname, role, plan, created_at, password_hash, email_verified)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(UID, EMAIL, "pg", "member", "free", "2026-01-01T00:00:00.000Z", password.hashPassword(PASS), emailVerified);
  return exec;
}

const noEnvAdmin = () => {
  const saved = { email: process.env.AUTH_EMAIL, password: process.env.AUTH_PASSWORD };
  delete process.env.AUTH_EMAIL;
  delete process.env.AUTH_PASSWORD;
  return () => {
    if (saved.email === undefined) delete process.env.AUTH_EMAIL; else process.env.AUTH_EMAIL = saved.email;
    if (saved.password === undefined) delete process.env.AUTH_PASSWORD; else process.env.AUTH_PASSWORD = saved.password;
  };
};

test("密碼正確：PG 才有的帳號也登得進去（同步版讀本機會說密碼錯誤）", async () => {
  const restore = noEnvAdmin();
  try {
    const exec = pgOnlyWorld();
    assert.strictEqual(dbMod.findUserByEmail(EMAIL), null, "前提：本機真的沒有這個帳號");
    const user = await auth.verifyLoginAsync(EMAIL, PASS, { ...PG, exec, strict: true });
    assert.equal(user.id, UID, "必須回 PG 那一列");
    assert.equal(user.email, EMAIL);
    assert.equal(user.role, "member");
    assert.ok(!("password_hash" in user), "回傳必須是 publicUser（不得帶出雜湊）");
  } finally { restore(); }
});

test("密碼錯誤／查無此人：401，且訊息與同步版相同", async () => {
  const restore = noEnvAdmin();
  try {
    const exec = pgOnlyWorld();
    for (const [email, pass] of [[EMAIL, "wrongpassword"], ["nobody@example.test", PASS]]) {
      await assert.rejects(
        () => auth.verifyLoginAsync(email, pass, { ...PG, exec, strict: true }),
        (error) => error.status === 401 && /帳號或密碼不正確/.test(error.message),
        `${email} 應該被擋下`,
      );
    }
  } finally { restore(); }
});

test("未驗證信箱：403（PG 的 email_verified = 0 也要擋）", async () => {
  const restore = noEnvAdmin();
  try {
    const exec = pgOnlyWorld({ emailVerified: 0 });
    await assert.rejects(
      () => auth.verifyLoginAsync(EMAIL, PASS, { ...PG, exec, strict: true }),
      (error) => error.status === 403 && /確認連結/.test(error.message),
      "未驗證的帳號不得登入",
    );
  } finally { restore(); }
});

test("env 管理員後備：PG 沒有那一列時回 admin 形狀，且不回退本機", async () => {
  const saved = { email: process.env.AUTH_EMAIL, password: process.env.AUTH_PASSWORD };
  process.env.AUTH_EMAIL = "envadmin@example.test";
  process.env.AUTH_PASSWORD = "envadminpass1";
  try {
    const exec = fixture(); // PG 完全沒有這個帳號
    const user = await auth.verifyLoginAsync("envadmin@example.test", "envadminpass1", { ...PG, exec, strict: true });
    assert.equal(user.role, "admin", "env 管理員必須以 admin 身分登入");
    assert.equal(user.email, "envadmin@example.test");
    assert.equal(user.id, 0, "PG 沒有那一列時 id 是 0（與同步版同義）");
  } finally {
    if (saved.email === undefined) delete process.env.AUTH_EMAIL; else process.env.AUTH_EMAIL = saved.email;
    if (saved.password === undefined) delete process.env.AUTH_PASSWORD; else process.env.AUTH_PASSWORD = saved.password;
  }
});

test("非 postgres：直接走同步版（完全不碰傳入的 exec）", async () => {
  const restore = noEnvAdmin();
  try {
    const hash = password.hashPassword(PASS);
    handle().prepare(
      `INSERT OR REPLACE INTO users(id, email, role, plan, created_at, password_hash, email_verified)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(UID + 1, "local-only@example.test", "member", "free", "2026-01-01T00:00:00.000Z", hash, 1);
    let calls = 0;
    const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
    const user = await auth.verifyLoginAsync("local-only@example.test", PASS, { driver: "sqlite", exec: boom });
    assert.equal(user.id, UID + 1, "sqlite 模式必須讀本機");
    assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
    handle().prepare("DELETE FROM users WHERE id = ?").run(UID + 1);
  } finally { restore(); }
});

test("wiring：/api/login 必須用 verifyLoginAsync 並 awaited 之後才 setSession", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(path.join(import.meta.dirname, "../src/server.js"), "utf8");
  const handler = src.slice(src.indexOf('app.post("/api/login"'), src.indexOf("function queueSystemMail"));
  assert.match(handler, /await verifyLoginAsync\(/, "/api/login 要走 PG 島嶼入口");
  assert.match(handler, /await afterMemberSessionAsync\(user\)/,
    "登入後的副作用（記登入時間、恢復閒置）也要走 PG 版");
  assert.match(handler, /async \(req, res\)/, "handler 必須是 async");
  assert.doesNotMatch(handler, /verifyLogin\(req\.body/, "不得再呼叫同步版");
});
