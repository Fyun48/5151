// 後台會員管理（列表／停權／復原／改方案）的 driver-aware 入口（PG 島嶼，2026-09-28，第五十四批）。
//
// 涵蓋的路由：
//   GET   /api/admin/members            列表（含每個人的關注數／刊登數／通知間隔）
//   POST  /api/admin/members/:id/delete 停權（管理員）
//   POST  /api/admin/members/:id/restore 復原
//   PATCH /api/admin/members/:id        改方案／通知間隔
//   POST  /api/account/delete           會員自己刪帳號
//
// 這一叢的同步版會讀**三份本機資料**才算得出一列會員：`users`、該會員的 `settings`
// （通知間隔）、`user_listing_flags` ＋ `listings`（關注數／刊登數）。PG 模式下那是
// 別的節點的資料 ⇒ 後台看到的「關注 0 筆、刊登 0 筆、間隔是預設值」，而且不會報錯。
//
// 規則全部沿用既有模組（`resolveDeleteReason`／`adminMemberView`／`planIntervalMinutes`），
// 這一支只負責「把值從 PG 拿回來」。
import { resolveDbDriver } from "./dbDriver.js";
import {
  countOpenSelfListings as countOpenSelfListingsSync,
  getSettings as getSettingsSync,
  listAdminMembers as listAdminMembersSync,
  sqliteHandle,
} from "./db.js";
import { adminMemberView } from "./adminMemberView.js";
import { resolveDeleteReason } from "./members.js";
import { countWatched as countWatchedSync } from "./watchLimits.js";
import { expireOpenSelfListingsAsync } from "./selfListingsAsync.js";
import { countWatchedAsync } from "./watchLimitsAsync.js";
import { getSettingsAsync, saveSettingsAsync } from "./settingsAsync.js";
import { deleteUserAsync, getUserByIdAsync, listUsersAsync, restoreUserAsync, setUserPlanAsync } from "./usersAsync.js";
import { planIntervalMinutes } from "./settingsState.js";

export const OPEN_SELF_LISTINGS_COUNT_SQL = `SELECT COUNT(*) AS n FROM listings
   WHERE listed_by_user_id = ?
     AND COALESCE(source, '591') = 'self'
     AND COALESCE(self_status, 'open') = 'open'`;

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

async function execFor(options) {
  if (options.exec) return async (sql, params = []) => rowsOf(await options.exec(sql, params));
  // ⚠️ 一定要 `await`：`sharedPgDriver()` 是 async，少一個 await 會拿到 Promise，
  // 之後 `pgDriver.query(...)` 就是 `is not a function`（第五十四批就是這樣寫的，
  // 只有**沒有注入 exec／pgDriver** 的真實路徑才會踩到，離線與 live 測試都注入驅動 ⇒ 一路綠）。
  const pgDriver = options.pgDriver || (await (await import("./pgSharedDriver.js")).sharedPgDriver());
  const { toPostgresSql } = await import("./sqlDialect.js");
  return async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
}

// `db.js countOpenSelfListings()` 的 PG 版：先讓過期的自主刊登變成 expired（與同步版同義），
// 再數「還開著」的。`expireOpenSelfListingsAsync()` 會吞掉錯誤回 0，所以不必再包 try。
export async function countOpenSelfListingsAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  if (!isPg(options)) return countOpenSelfListingsSync(uid);
  const exec = await execFor(options);
  await expireOpenSelfListingsAsync(exec, new Date());
  return Number(one(await exec(OPEN_SELF_LISTINGS_COUNT_SQL, [uid]))?.n) || 0;
}

// `db.js publicAdminMember()` 的 PG 版：三個值都從 PG 拿，投影本身共用同一份純函式。
export async function adminMemberViewAsync(user, options = {}) {
  if (!user) return null;
  if (!isPg(options)) {
    return adminMemberView(user, {
      settings: getSettingsSync(user.id),
      watchCount: countWatchedSync(sqliteHandle(), user.id),
      listingCount: countOpenSelfListingsSync(user.id),
    });
  }
  const [settings, watchCount, listingCount] = await Promise.all([
    getSettingsAsync(user.id, options),
    countWatchedAsync(user.id, options),
    countOpenSelfListingsAsync(user.id, options),
  ]);
  return adminMemberView(user, { settings, watchCount, listingCount });
}

// `db.js listAdminMembers()` 的 PG 版。
export async function listAdminMembersAsync(query = {}, options = {}) {
  if (!isPg(options)) return listAdminMembersSync(query);
  const users = await listUsersAsync(query, options);
  return Promise.all(users.map((user) => adminMemberViewAsync(user, options)));
}

// `db.js adminDeleteMember()`：理由代碼 → 文字（純函式）→ 停權 → 投影。
export async function adminDeleteMemberAsync(userId, { reasonCode, reasonText } = {}, options = {}) {
  const resolved = resolveDeleteReason(reasonCode, reasonText);
  const user = await deleteUserAsync(userId, { by: "admin", reason: resolved.text, reasonCode: resolved.code }, options);
  return { member: await adminMemberViewAsync(user, options), reason: resolved };
}

export async function adminRestoreMemberAsync(userId, options = {}) {
  return adminMemberViewAsync(await restoreUserAsync(userId, options), options);
}

export async function deleteOwnAccountAsync(userId, reason = "", options = {}) {
  const user = await deleteUserAsync(
    userId,
    { by: "self", reason: String(reason || "").trim().slice(0, 2000), reasonCode: "self" },
    options,
  );
  return adminMemberViewAsync(user, options);
}

// `db.js adminPatchMember()`：改方案（`setUserPlanAsync`）→ 必要時改通知間隔
// （`intervalAdminSet` 的兩種情況與同步版逐條對應）→ 回新的投影。
export async function adminPatchMemberAsync(userId, patch = {}, options = {}) {
  const uid = Number(userId) || 0;
  const user = await getUserByIdAsync(uid, options);
  if (!user) {
    const err = new Error("找不到這位會員");
    err.status = 404;
    throw err;
  }
  const body = patch && typeof patch === "object" ? patch : {};
  if (body.plan === "free" || body.plan === "sponsor") {
    await setUserPlanAsync(uid, body.plan, options);
  }
  const fresh = await getUserByIdAsync(uid, options);
  const settingsPatch = {};
  if (body.intervalMinutes != null && body.intervalMinutes !== "") {
    settingsPatch.intervalMinutes = Number(body.intervalMinutes);
    settingsPatch.intervalAdminSet = true;
  } else if ((body.plan === "free" || body.plan === "sponsor") && fresh?.role !== "admin") {
    settingsPatch.intervalMinutes = planIntervalMinutes(fresh.plan);
    settingsPatch.intervalAdminSet = false;
  }
  if (Object.keys(settingsPatch).length) {
    await saveSettingsAsync(settingsPatch, uid, { ...options, forceAdmin: true });
  }
  return adminMemberViewAsync(await getUserByIdAsync(uid, options), options);
}
