// 使用者讀取的 driver-aware 入口（PG 島嶼，2026-09-28）。
//
// 為什麼挑 `getUserById()`：它是目前缺口的**頭號卡點（25 條路由）**。它本身只是一句
// `SELECT * FROM users WHERE id = ?`，但 `db.js` 裡有 8 處私有呼叫，而且那些呼叫端
// 幾乎都是同步函式——所以這一支是「成組批次」的第一步（見計畫文件第三十八批）。
//
// ⚠️ `users` 是**已經在 PG 上的表**（`ensurePgSchema` 早就鏡射過：`users` 在主鍵、
// `idx_*` 上都有索引，且 `getSelfRowAsync`／`readSessionAsync` 都在讀它），
// 所以這裡不需要新的 schema 工作，也不需要補建索引。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import {
  assertMemberDeletable,
  assertMemberRestorable,
  deleteUser as deleteUserSync,
  findUserByEmail as findUserByEmailSync,
  getUserById as getUserByIdSync,
  isUserDeleted,
  listUsers as listUsersSync,
  restoreUser as restoreUserSync,
  setUserPassword as setUserPasswordSync,
  setUserPlan as setUserPlanSync,
  touchLastLogin as touchLastLoginSync,
} from "./members.js";
import { ensureUser as ensureUserSync, adminEmailForUser } from "./personalFlags.js";
import { publicUser } from "./members.js";
import { hashPassword, normalizeEmail, validatePassword, verifyPassword } from "./password.js";
import { defaultUserId as defaultUserIdSync, resumeIdleIfNeeded as resumeIdleIfNeededSync } from "./db.js";
import { applyIdleResumeAsync } from "./idlePause.js";

export const USER_BY_ID_SQL = "SELECT * FROM users WHERE id = ?";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
// `one()` **保證**查不到時回 `null`（不是 `undefined`）⇒ 外面不需要再 `|| null`。
// 那一句原本存在，但拿掉它測試照樣過（等價變異），所以移除以免留下「看起來有守衛、
// 其實沒有作用」的程式碼。
const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

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
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return runSqlite();
  }
}

// `getUserById(userId)`（db.js 的包裝）的 PG 版。
// 沒有這個 id 時回 null（同步版同義），不是 undefined——`adminPatchMember` 那類呼叫端
// 靠 `if (!user)` 判斷，回傳形狀不能變。
export async function getUserByIdAsync(userId, options = {}) {
  const id = Number(userId) || 0;
  if (!id) return null;
  return run(options, async (exec) => one((await exec(USER_BY_ID_SQL, [id])).rows),
    () => getUserByIdSync(sqliteHandle(), id) || null);
}

// ---- 會員帳號的讀寫（2026-09-28，第五十二批）---------------------------------
//
// 這一組是「會員／後台那一叢」的地基：`findUserByEmail`（登入、忘記密碼、驗證信）、
// `ensureUser`／`defaultUserId`（`actorUserId()` 在沒有 session 時的身分來源）、
// `setUserPassword`／`touchLastLogin`（登入流程的副作用）。
//
// 🚨 `defaultUserId()` 是**模組層級以外的 lazy 寫入**：它會在第一次被呼叫時
// `INSERT` 一個管理員帳號到**節點本機**的 SQLite。PG 模式下那筆寫入「沒有人讀」，
// 而且回傳的 id 是**本機**的 id——`ensureWorkCoords()` 就拿這個 id 去 `getSettingsAsync()`
// 讀 PG（跨店錯位的經典形狀）。所以 `defaultUserIdAsync()` 是必要的，不是為了量尺。

export const USER_BY_EMAIL_SQL = "SELECT * FROM users WHERE email = ?";
export const USER_INSERT_SQL =
  "INSERT INTO users(email, password_hash, role, plan, created_at) VALUES (?, '', ?, 'free', ?) RETURNING id";
export const USER_SET_PASSWORD_SQL = "UPDATE users SET password_hash = ? WHERE id = ?";
export const USER_LAST_LOGIN_SQL = "UPDATE users SET last_login_at = ? WHERE id = ?";
export const USER_LAST_LOGIN_READ_SQL = "SELECT last_login_at FROM users WHERE id = ?";

// `members.js::findUserByEmail()` 的 PG 版（空字串要先短路，同步版就是這樣）。
export async function findUserByEmailAsync(email, options = {}) {
  const key = normalizeEmail(email);
  if (!key) return null;
  return run(options, async (exec) => one((await exec(USER_BY_EMAIL_SQL, [key])).rows),
    () => findUserByEmailSync(sqliteHandle(), email) || null);
}

// `personalFlags.js::ensureUser()` 的 PG 版：不存在就建（`role` 決定 admin／member）。
// PG 沒有「INSERT OR IGNORE」，所以先查再寫；同時建立時撞唯一鍵就重讀一次。
export async function ensureUserAsync(email, { role } = {}, options = {}) {
  const key = String(email || "").trim().toLowerCase();
  if (!key) return 0;
  return run(options, async (exec) => {
    const existing = one((await exec(USER_BY_EMAIL_SQL, [key])).rows);
    if (existing) return Number(existing.id);
    const isAdmin = role === "admin" || key === adminEmailForUser();
    try {
      const row = one((await exec(USER_INSERT_SQL, [key, isAdmin ? "admin" : "member", new Date().toISOString()])).rows);
      return Number(row?.id) || 0;
    } catch (error) {
      const again = one((await exec(USER_BY_EMAIL_SQL, [key])).rows);
      if (again) return Number(again.id);
      throw error;
    }
  }, () => ensureUserSync(sqliteHandle(), email, { role }));
}

// `db.js::defaultUserId()` 的 PG 版。**刻意不快取**：同步版用模組層級的快取，
// 那在測試裡會讓不同夾具互相污染；這裡每次只多一句 SELECT，換來可預測的行為。
export async function defaultUserIdAsync(options = {}) {
  return ensureUserAsync(adminEmailForUser(), { role: "admin" }, options);
}

// `members.js::verifyUserPassword()`：查人 → 已刪除不算 → 比對雜湊（純判斷兩邊共用）。
export async function verifyUserPasswordAsync(email, password, options = {}) {
  const user = await findUserByEmailAsync(email, options);
  if (!user || isUserDeleted(user)) return null;
  if (user.password_hash && verifyPassword(password, user.password_hash)) return user;
  return null;
}

// `members.js::setUserPassword()`：驗證政策與雜湊都在 `password.js`（兩邊共用同一份）。
export async function setUserPasswordAsync(userId, password, options = {}) {
  const id = Number(userId) || 0;
  if (!id) return;
  return run(options, async (exec) => {
    await exec(USER_SET_PASSWORD_SQL, [hashPassword(validatePassword(password)), id]);
  }, () => setUserPasswordSync(sqliteHandle(), id, password));
}

// 直接寫入「已經算好的」雜湊（`forgotPassword.js` 寄信失敗時要把舊雜湊寫回去）。
// 這一支**不**做 validate／hash——那不是它的工作，拿 `setUserPasswordAsync()` 代替會改變語意。
export async function setPasswordHashAsync(userId, hash, options = {}) {
  const id = Number(userId) || 0;
  if (!id) return;
  return run(options, async (exec) => {
    await exec(USER_SET_PASSWORD_SQL, [String(hash || ""), id]);
  }, () => {
    sqliteHandle().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(String(hash || ""), id);
  });
}

// `members.js::touchLastLogin()`：best-effort（同步版把任何錯誤吞掉回 false），
// `minIntervalMs` 之內不重寫。PG 版照抄同樣的語意。
export async function touchLastLoginAsync(userId, { now = Date.now(), minIntervalMs = 0 } = {}, options = {}) {
  const id = Number(userId) || 0;
  if (!id) return false;
  if (!isPg(options)) return touchLastLoginSync(sqliteHandle(), id, { now, minIntervalMs });
  try {
    return await run(options, async (exec) => {
      if (minIntervalMs > 0) {
        const row = one((await exec(USER_LAST_LOGIN_READ_SQL, [id])).rows);
        const prev = row?.last_login_at ? Date.parse(row.last_login_at) : 0;
        if (Number.isFinite(prev) && prev > 0 && now - prev < minIntervalMs) return false;
      }
      await exec(USER_LAST_LOGIN_SQL, [new Date(now).toISOString(), id]);
      return true;
    }, () => touchLastLoginSync(sqliteHandle(), id, { now, minIntervalMs }));
  } catch {
    return false; // 與同步版同義：登入時間寫不進去不該擋住登入
  }
}

// `db.js::resumeIdleIfNeeded()` 的 PG 版：規則在 `idlePause.js`（兩邊共用同一份）。
export async function resumeIdleIfNeededAsync(userId, options = {}) {
  if (!isPg(options)) return resumeIdleIfNeededSync(userId);
  return applyIdleResumeAsync(userId, {
    getSettings: (uid) => getSettingsAsync(uid, options),
    saveSettings: (uid, patch) => saveSettingsAsync(patch, uid, options),
    armFetch: (uid) => armMemberExternalFetchAsync(uid, {}, options),
  });
}

// ⚠️ `settingsAsync.js` 反過來會匯入 `db.js`（而 `db.js` 匯入 `members.js`），
// 靜態匯入會形成循環；這一支只在 `resumeIdleIfNeededAsync()` 內用到，所以用動態匯入。
const { getSettingsAsync, saveSettingsAsync, armMemberExternalFetchAsync } =
  await import("./settingsAsync.js");

// ---- 後台會員管理用到的使用者表讀寫（第五十四批）-------------------------------

export const USERS_LIST_SQL = `SELECT id, email, role, plan, created_at, accepted_disclaimer_at, disclaimer_version,
            signup_count, deleted_at, deleted_by, deleted_reason, deleted_reason_code, last_login_at
     FROM users ORDER BY %SORT% %DIR%, id %DIR%`;
export const USER_SET_PLAN_SQL = "UPDATE users SET plan = ? WHERE id = ?";
export const USER_DELETE_SQL =
  `UPDATE users SET deleted_at = ?, deleted_by = ?, deleted_reason = ?, deleted_reason_code = ? WHERE id = ?`;
export const USER_RESTORE_SQL =
  "UPDATE users SET deleted_at = NULL, deleted_by = '', deleted_reason = '', deleted_reason_code = '' WHERE id = ?";

// `members.js::listUsers()` 的 PG 版（排序與過濾都在 JS，與同步版逐字對應：
// `sort` 只認 `created_at`，其餘一律用 `id`；`q` 是 email 的子字串、大小寫無關）。
export async function listUsersAsync({ includeDeleted = true, sort = "id", order = "asc", q = "" } = {}, options = {}) {
  const dir = String(order).toLowerCase() === "desc" ? "DESC" : "ASC";
  const sortKey = String(sort) === "created_at" ? "created_at" : "id";
  const sql = USERS_LIST_SQL.replaceAll("%SORT%", sortKey).replaceAll("%DIR%", dir);
  const rows = await run(options, async (exec) => (await exec(sql, [])).rows, () => listUsersSync(sqliteHandle(), { includeDeleted, sort, order, q }));
  const needle = String(q || "").trim().toLowerCase();
  return rows.filter((row) => {
    if (!includeDeleted && isUserDeleted(row)) return false;
    if (!needle) return true;
    return String(row.email || "").toLowerCase().includes(needle);
  });
}

// `members.js::setUserPlan()`：只認 `sponsor`，其餘一律 `free`；回傳更新後的那一列。
export async function setUserPlanAsync(userId, plan, options = {}) {
  const id = Number(userId) || 0;
  if (!id) return null;
  const next = plan === "sponsor" ? "sponsor" : "free";
  await run(options, async (exec) => { await exec(USER_SET_PLAN_SQL, [next, id]); },
    () => setUserPlanSync(sqliteHandle(), id, plan));
  const row = await getUserByIdAsync(id, options);
  return row ? publicUser(row) : null;
}

// `members.js::deleteUser()`：守衛（找不到／管理員／已刪除）與同步版共用同一組訊息。
export async function deleteUserAsync(userId, { by = "self", reason = "", reasonCode = "" } = {}, options = {}) {
  const id = Number(userId) || 0;
  // SQLite 站直接走同步版（連守衛與 UPDATE 都是同一條路，不必自己重寫一遍）。
  if (!isPg(options)) return deleteUserSync(sqliteHandle(), id, { by, reason, reasonCode });
  const user = await getUserByIdAsync(id, options);
  assertMemberDeletable(user);
  const now = new Date().toISOString();
  const who = by === "admin" ? "admin" : "self";
  await run(options, async (exec) => {
    await exec(USER_DELETE_SQL, [now, who, String(reason || "").slice(0, 2000), String(reasonCode || "").slice(0, 40), id]);
  }, () => deleteUserSync(sqliteHandle(), id, { by, reason, reasonCode }));
  return getUserByIdAsync(id, options);
}

// `members.js::restoreUser()`。
export async function restoreUserAsync(userId, options = {}) {
  const id = Number(userId) || 0;
  if (!isPg(options)) return restoreUserSync(sqliteHandle(), id);
  const user = await getUserByIdAsync(id, options);
  assertMemberRestorable(user);
  await run(options, async (exec) => { await exec(USER_RESTORE_SQL, [id]); }, () => restoreUserSync(sqliteHandle(), id));
  return getUserByIdAsync(id, options);
}
