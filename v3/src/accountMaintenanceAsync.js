// 帳號維護（過期驗證碼清理、閒置會員暫停）的 driver-aware 入口。
//
// sqlite   - emailVerify.expireStaleVerifyTokens()／members.listIdleMemberIds() 的同步版本
//            ＋ idlePause 的暫停規則（行為完全不變）。
// postgres - 同一組語句文字與同一組純規則，改由 PG 執行。
//
// 為什麼需要：`server.js` 的維護 tick 在 PG 模式下仍呼叫 db.js 的同步版本，於是
// 「哪個會員被標記過期、哪個會員被暫停」只寫進回答那台節點的本機 SQLite。另一個節點讀不到，
// 就會重複處理或永遠不處理，`user_settings`／`users` 也就各自分歧（2026-09-26 實測
// users 28／27／27、user_settings 233／186／186）。
//
// 純規則沿用 idlePause.js（shouldSkipIdlePause／idlePauseFlags）與 members.IDLE_PAUSE_MS，
// 不另外複製一份。
import { expireStaleVerifyTokens as expireStaleVerifyTokensSync } from "./emailVerify.js";
import { IDLE_PAUSE_MS, listIdleMemberIds as listIdleMemberIdsSync } from "./members.js";
import { idlePauseFlags, shouldSkipIdlePause } from "./idlePause.js";
import { getSettingsAsync, saveSettingsAsync } from "./settingsAsync.js";
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteHandle } from "./db.js";

// 語句文字與 emailVerify.expireStaleVerifyTokens()／members.listIdleMemberIds() 逐字相同。
const STALE_VERIFY_SQL = `SELECT * FROM users
     WHERE IFNULL(email_verified, 1) = 0
       AND IFNULL(verify_token, '') != ''
       AND verify_expires_at IS NOT NULL
       AND verify_expires_at <= ?
       AND IFNULL(verify_expire_notified, 0) = 0`;

const CLEAR_STALE_VERIFY_SQL =
  "UPDATE users SET verify_token = NULL, verify_expire_notified = 1 WHERE id = ?";

const IDLE_MEMBER_SQL = `SELECT id FROM users
       WHERE IFNULL(role, 'member') != 'admin'
         AND IFNULL(deleted_at, '') = ''
         AND IFNULL(email_verified, 1) != 0
         AND COALESCE(last_login_at, created_at) <= ?`;

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

async function runInTransaction(options, fn) {
  if (options.exec) return fn(options.exec);
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return pgDriver.withTransaction(async (client) => {
    const tx = (sql, params = []) => client.query(toPostgresSql(sql), params).then((res) => res.rows);
    return fn(tx);
  });
}

export async function expireStaleVerifyTokensAsync({ now = Date.now(), onExpire } = {}, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return expireStaleVerifyTokensSync(sqliteHandle(), { now, onExpire });
  }
  return runInTransaction(options, async (exec) => {
    const iso = new Date(now).toISOString();
    const stale = (await exec(STALE_VERIFY_SQL, [iso])) || [];
    let n = 0;
    for (const user of stale) {
      await exec(CLEAR_STALE_VERIFY_SQL, [user.id]);
      if (typeof onExpire === "function") await onExpire(user);
      n += 1;
    }
    return n;
  });
}

export async function listIdleMemberIdsAsync({ now = Date.now(), idleMs = IDLE_PAUSE_MS } = {}, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return listIdleMemberIdsSync(sqliteHandle(), { now, idleMs });
  }
  const exec = await pgExec(options);
  const cutoff = new Date(now - idleMs).toISOString();
  try {
    const rows = await exec(IDLE_MEMBER_SQL, [cutoff]);
    return (rows || []).map((row) => Number(row.id));
  } catch {
    // 與 members.listIdleMemberIds() 相同：查詢失敗回空陣列，不讓維護 tick 掛掉。
    return [];
  }
}

// db.js pauseIdleMembers()：與同步版同一條規則（已暫停者跳過，其餘寫入暫停旗標）。
export async function pauseIdleMembersAsync({ now = Date.now() } = {}, options = {}) {
  const ids = await listIdleMemberIdsAsync({ now }, options);
  let n = 0;
  for (const id of ids) {
    const settings = await getSettingsAsync(id, options);
    if (shouldSkipIdlePause(settings)) continue;
    await saveSettingsAsync(idlePauseFlags(), id, options);
    n += 1;
  }
  return n;
}
