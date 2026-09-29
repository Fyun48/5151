// 註冊信箱確認（verify-email）的 driver-aware 入口（PG 島嶼，2026-09-28，第五十三批）。
//
// 涵蓋的路由：`GET /verify-email`。
//
// 為什麼要移植：這一條是**註冊流程的必經之路**（沒點連結不能登入）。同步版在 PG 模式下
// 讀寫的是節點本機的 `users` ⇒ 別的管理節點建立的新帳號，點了信裡的連結會拿到
// 「找不到這個開通連結」——使用者看到的是「連結壞了」，而真正的原因是讀錯 store。
//
// 三段語意（與 `emailVerify.js` 逐條對應，順序不可以換）：
//   1. token 空／查不到 → 404 `missing`
//   2. 已用過（`verify_used_at` 有值）或 `email_verified = 1` → 409 `used`
//   3. 過期（`verify_expires_at <= now`）→ 410 `expired`
// 通過之後才 UPDATE（`email_verified = 1`、`verify_expires_at = NULL`）。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import {
  confirmVerifyToken as confirmVerifyTokenSync,
  issueVerifyToken as issueVerifyTokenSync,
  newVerifyToken,
} from "./emailVerify.js";
import { findUserByEmailAsync } from "./usersAsync.js";

export const USER_BY_VERIFY_TOKEN_SQL = "SELECT * FROM users WHERE verify_token = ?";
// `issueVerifyTokenAsync()` 用的 UPDATE：與 `emailVerify.js:issueVerifyToken` 逐字對應
// （`email_verified = 0` 一併歸零，重寄開通信等於把已驗證狀態退回未驗證）。
export const USER_ISSUE_VERIFY_SQL =
  "UPDATE users SET email_verified = 0, verify_token = ?, verify_expires_at = ?, verify_expire_notified = 0, verify_used_at = NULL WHERE id = ?";

export const USER_CONFIRM_VERIFY_SQL =
  "UPDATE users SET email_verified = 1, verify_used_at = ?, verify_expires_at = NULL, verify_expire_notified = 0 WHERE id = ?";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

async function run(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return runSqlite();
  }
}

// `emailVerify.confirmVerifyToken(db, token, {now})` 的 PG 版。
// ⚠️ 三種錯誤要用**丟的**（呼叫端靠 `error.code` 決定導到哪個提示），所以錯誤要在
// `run()` 的 try 之外組；寫入失敗則 fail-closed（這是「連結只能用一次」的守衛）。
export async function confirmVerifyTokenAsync(token, { now = Date.now() } = {}, options = {}) {
  if (!isPg(options)) return confirmVerifyTokenSync(sqliteHandle(), token, { now });
  const key = String(token || "").trim();
  if (!key) throw httpError("找不到這個開通連結", 404, "missing");

  const row = await run(options, async (exec) => one((await exec(USER_BY_VERIFY_TOKEN_SQL, [key])).rows),
    () => null);
  if (!row) throw httpError("找不到這個開通連結", 404, "missing");
  if (String(row.verify_used_at || "").trim() || Number(row.email_verified) === 1) {
    throw httpError("這個開通連結已經使用過", 409, "used");
  }
  const exp = Date.parse(String(row.verify_expires_at || ""));
  if (Number.isFinite(exp) && exp <= now) {
    throw httpError("確認連結已失效，請重新註冊或等系統補寄說明信", 410, "expired");
  }
  const usedAt = new Date(now).toISOString();
  await run(options, async (exec) => {
    await exec(USER_CONFIRM_VERIFY_SQL, [usedAt, Number(row.id) || 0]);
  }, () => {
    confirmVerifyTokenSync(sqliteHandle(), token, { now });
  });
  return (await findUserByEmailAsync(row.email, options)) || row;
}

// `emailVerify.issueVerifyToken(db, userId, {now})` 的 PG 版（第七十五批，`POST /api/register` 用）。
// 同步版在 PG 模式下把 token 寫進**節點本機**的 `users`：會員收到的連結在真正讀取（PG）的
// 那一邊查不到，等於**註冊完就卡死**。這裡改成寫 PG，並且與同步版共用 `newVerifyToken()`。
export async function issueVerifyTokenAsync(userId, { now = Date.now() } = {}, options = {}) {
  const id = Number(userId) || 0;
  if (!isPg(options)) return issueVerifyTokenSync(sqliteHandle(), id, { now });
  const issued = newVerifyToken({ now });
  return run(options, async (exec) => {
    await exec(USER_ISSUE_VERIFY_SQL, [issued.token, issued.expiresAt, id]);
    return issued;
  }, () => issueVerifyTokenSync(sqliteHandle(), id, { now }));
}
