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
import { countWatchedAsync, countWatchedBatchAsync } from "./watchLimitsAsync.js";
import { getSettingsAsync, getSettingsBatchAsync, saveSettingsAsync } from "./settingsAsync.js";
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
  // 批次預取（2026-10-11 後台會員列表事故）：整頁的「開放中自主刊登數」已經由
  // `loadAdminMemberBatchAsync()` 一次算好（含先清過期），這裡直接取用、不再一個人發兩條。
  const prefetched = options.memberBatch?.listingCount?.get(uid);
  if (prefetched !== undefined) return prefetched;
  if (!isPg(options)) return countOpenSelfListingsSync(uid);
  const exec = await execFor(options);
  await expireOpenSelfListingsAsync(exec, new Date());
  return Number(one(await exec(OPEN_SELF_LISTINGS_COUNT_SQL, [uid]))?.n) || 0;
}

// ---------------------------------------------------------------------------
// 批次讀取（2026-10-11 事故的修正核心）
//
// 事故：`listAdminMembersAsync()` 原本是 `Promise.all(users.map(adminMemberViewAsync))`，
// 每位會員各發 3 條並發查詢（28 人 ⇒ 84 條同時打出去），app 端 PG 連線池拿不到連線，
// 5 秒後整頁變成 `timeout exceeded when trying to connect`（PG 本身沒爆，max_connections=100、實測只用 21 條）。
//
// 修正：整頁先各抓一次 —— ①過期自主刊登清一次（1 條 UPDATE）②設定（2～3 條）③關注數（1 條）
// ④開放中自主刊登數（1 條）—— 再逐列投影（0 條）。查詢數與人數**脫鉤**。
//
// ⚠️ 批次 SQL 由**同一份**單人版文字推導（`OPEN_SELF_LISTINGS_COUNT_SQL`），不另抄一份：
// 抄一份就會漂移。`?` 佔位符由 runner 的 `toPostgresSql()` 轉 `$n`（SQLite 也吃同一句），
// 而且 `listed_by_user_id IN (…)` 一樣吃得到 `idx_listings_listed_by_user_id`
// （partial index 的 `IS NOT NULL` 由這個等值集合蘊含）。
const marks = (count) => Array.from({ length: count }, () => "?").join(",");
const OPEN_SELF_COUNT_ONE_SELECT = "SELECT COUNT(*) AS n FROM listings";
const OPEN_SELF_COUNT_ONE_WHERE = "listed_by_user_id = ?";

export function openSelfListingsCountBatchSql(count) {
  const size = Math.max(0, Number(count) || 0);
  if (!size || !OPEN_SELF_LISTINGS_COUNT_SQL.includes(OPEN_SELF_COUNT_ONE_SELECT)
    || !OPEN_SELF_LISTINGS_COUNT_SQL.includes(OPEN_SELF_COUNT_ONE_WHERE)) {
    throw new Error("openSelfListingsCountBatchSql：OPEN_SELF_LISTINGS_COUNT_SQL 的形狀變了，批次版必須跟著改");
  }
  return `${OPEN_SELF_LISTINGS_COUNT_SQL
    .replace(OPEN_SELF_COUNT_ONE_SELECT, "SELECT listed_by_user_id AS user_id, COUNT(*) AS n FROM listings")
    .replace(OPEN_SELF_COUNT_ONE_WHERE, `listed_by_user_id IN (${marks(size)})`)}
 GROUP BY listed_by_user_id`;
}

// 回傳 `{ settings, watchCount, listingCount }` 三張 `Map<userId, value>`；把它塞進
// `options.memberBatch` 之後，`adminMemberViewAsync()` 的三個值全部命中，每人 0 條查詢。
// 只做**這一頁**（呼叫端傳進來的 users 列）的批次，不是全庫。
export async function loadAdminMemberBatchAsync(users, options = {}) {
  const rows = Array.isArray(users) ? users : [];
  const ids = [...new Set(rows.map((user) => Number(user?.id) || 0).filter(Boolean))];
  const batch = { settings: new Map(), watchCount: new Map(), listingCount: new Map() };
  if (!ids.length) return batch;
  const exec = await execFor(options);
  // ① 過期清理：單人版是「每位會員各清一次」的同一句 UPDATE，這裡整頁只發一條（語意相同）。
  await expireOpenSelfListingsAsync(exec, new Date());
  const [settings, watchCount, listingRows] = await Promise.all([
    // 呼叫端手上已經有這一頁的 users 列 ⇒ 直接把 role／plan 帶進去，省掉一條查詢。
    getSettingsBatchAsync(ids, { ...options, users: rows }),
    countWatchedBatchAsync(ids, options),
    exec(openSelfListingsCountBatchSql(ids.length), ids),
  ]);
  batch.settings = settings;
  batch.watchCount = watchCount;
  for (const row of listingRows) batch.listingCount.set(Number(row.user_id), Number(row.n) || 0);
  // 0 筆的人也要**明確**留在 Map 裡（預取端以 `undefined` 表示「沒有預取」；漏掉就會退回一人一條）。
  for (const id of ids) {
    batch.listingCount.set(id, batch.listingCount.get(id) || 0);
  }
  return batch;
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
// 2026-10-11：這裡原本一位會員 3 條並發查詢（= 3N 條）⇒ 28 人就把連線池抽乾。
// 現在同一頁先批次抓齊（常數條），再逐列投影；`adminMemberViewAsync()` 的輸出形狀與欄位語意不變
// （它以 `options.memberBatch` 取用批次值；沒有批次時仍是一人一條的舊行為）。
export async function listAdminMembersAsync(query = {}, options = {}) {
  if (!isPg(options)) return listAdminMembersSync(query);
  const users = await listUsersAsync(query, options);
  const memberBatch = await loadAdminMemberBatchAsync(users, options);
  return Promise.all(users.map((user) => adminMemberViewAsync(user, { ...options, memberBatch })));
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
