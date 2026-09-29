// 註冊信箱確認（`confirmVerifyTokenAsync`）的 parity（2026-09-28，第五十三批）。
//
// 這一條是註冊流程的必經之路（沒點連結不能登入）。同步版在 PG 模式下讀寫節點本機的 `users`
// ⇒ 別的管理節點建立的新帳號，點信裡的連結會拿到「找不到這個開通連結」——
// 使用者看到的是「連結壞了」，真正的原因是讀錯 store。
//
// 三段語意（順序不可換）：找不到 → 404 `missing`；已用過 → 409 `used`；過期 → 410 `expired`。
// 通過之後才 UPDATE，而且**連結只能用一次**（第二次必須變成 `used`）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-verify-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const emailVerify = await import("../src/emailVerify.js");
const verifyAsync = await import("../src/emailVerifyAsync.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const UID = 900000004001;
const TOKEN = "verify-token-abcdef123456";
const NOW = Date.parse("2026-09-18T00:00:00.000Z");
const FUTURE = "2026-09-20T00:00:00.000Z";
const PAST = "2026-09-01T00:00:00.000Z";

const USERS_DDL = () => handle().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql;

// 兩個 store：本機（同步版用）與 PG 替身（async 版用），種一樣的列。
function worlds({ usedAt = null, expiresAt = FUTURE, emailVerified = 0 } = {}) {
  const lite = handle();
  lite.prepare("DELETE FROM users WHERE id = ?").run(UID);
  const insert = (db) => db.prepare(
    `INSERT INTO users(id, email, role, plan, created_at, email_verified, verify_token, verify_expires_at, verify_used_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(UID, "verify@example.test", "member", "free", "2026-01-01T00:00:00.000Z", emailVerified, TOKEN, expiresAt, usedAt);
  insert(lite);
  const mem = new DatabaseSync(":memory:");
  mem.exec(USERS_DDL());
  insert(mem);
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  const row = () => mem.prepare("SELECT email_verified, verify_used_at, verify_expires_at FROM users WHERE id = ?").get(UID);
  return [lite, mem, exec, row];
}

const errorOf = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

test("成功：回那一列、PG 的旗標被改掉、而且只能用一次（第二次 409 used）", async () => {
  const [lite, , exec, row] = worlds();
  const syncUser = emailVerify.confirmVerifyToken(lite, TOKEN, { now: NOW });
  const syncRow = lite.prepare("SELECT email_verified, verify_used_at, verify_expires_at FROM users WHERE id = ?").get(UID);
  assert.equal(Number(syncRow.email_verified), 1, "前提：同步版真的把旗標設起來");

  // 重新種一次（同步版剛剛已經用掉了那個 token）
  const [, mem2, exec2, row2] = worlds();
  const user = await verifyAsync.confirmVerifyTokenAsync(TOKEN, { now: NOW }, { ...PG, exec: exec2, strict: true });
  assert.equal(user.id, UID, "必須回那一列");
  assert.equal(user.email, "verify@example.test");
  assert.equal(Number(row2().email_verified), 1, "PG 的 email_verified 必須變成 1");
  assert.equal(row2().verify_expires_at, null, "用過之後 expires_at 要清掉");
  assert.ok(String(row2().verify_used_at || "").trim(), "verify_used_at 必須寫入");
  assert.deepEqual(
    { email_verified: Number(row2().email_verified), verify_used_at: Boolean(row2().verify_used_at), verify_expires_at: row2().verify_expires_at },
    { email_verified: Number(syncRow.email_verified), verify_used_at: Boolean(syncRow.verify_used_at), verify_expires_at: syncRow.verify_expires_at },
    "落地的三個欄位必須與同步版相同",
  );
  // 同一個 token 第二次：409 used（兩邊一致）
  const second = await errorOf(() => verifyAsync.confirmVerifyTokenAsync(TOKEN, { now: NOW }, { ...PG, exec: exec2, strict: true }));
  // 對照組要在**同一個 store 的同一份狀態**上跑：`mem2` 就是 async 版剛剛用掉 token 的那一份。
  const syncSecond = await errorOf(() => Promise.resolve(emailVerify.confirmVerifyToken(mem2, TOKEN, { now: NOW })));
  assert.equal(second?.status, 409);
  assert.equal(second?.code, "used");
  assert.equal(second?.message, syncSecond?.message, "訊息必須與同步版相同");
});

test("已用過／已驗證：409 used；過期：410 expired；找不到：404 missing", async () => {
  const cases = [
    [{ usedAt: "2026-09-10T00:00:00.000Z", emailVerified: 0 }, 409, "used"],
    [{ usedAt: null, emailVerified: 1 }, 409, "used"],
    [{ expiresAt: PAST }, 410, "expired"],
  ];
  for (const [seed, status, code] of cases) {
    const [lite, , exec] = worlds(seed);
    const syncError = (() => { try { emailVerify.confirmVerifyToken(lite, TOKEN, { now: NOW }); return null; } catch (e) { return e; } })();
    const asyncError = await errorOf(() => verifyAsync.confirmVerifyTokenAsync(TOKEN, { now: NOW }, { ...PG, exec, strict: true }));
    assert.equal(syncError?.status, status, `前提：同步版的 status 是 ${status}`);
    assert.equal(asyncError?.status, status, `async 版的 status 必須是 ${status}`);
    assert.equal(asyncError?.code, code);
    assert.equal(asyncError?.message, syncError?.message, "訊息必須相同");
  }
  const [, , exec] = worlds();
  for (const bad of ["", "   ", "no-such-token"]) {
    const error = await errorOf(() => verifyAsync.confirmVerifyTokenAsync(bad, { now: NOW }, { ...PG, exec, strict: true }));
    assert.equal(error?.status, 404, `token="${bad}" 必須是 404`);
    assert.equal(error?.code, "missing");
  }
});

test("非 postgres：走同步路徑（讀本機、不碰傳入的 exec）", async () => {
  const [lite] = worlds();
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const user = await verifyAsync.confirmVerifyTokenAsync(TOKEN, { now: NOW }, { driver: "sqlite", exec: boom });
  assert.equal(user.id, UID, "sqlite 模式必須讀本機");
  assert.equal(Number(lite.prepare("SELECT email_verified FROM users WHERE id = ?").get(UID).email_verified), 1);
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
});
