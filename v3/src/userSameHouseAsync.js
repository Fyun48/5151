// 個人同房源合併的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼優先做這個：`mergeSameHouseForUser()`（db.js）→ `mergePersonalSameHouse()` 是
// `/api/listings/:id/{reject,confirm}-match` 與 `/api/listings/merge-same-house` 的後端，
// 而這條路徑**現在還在寫節點本機 SQLite**——實測 2026-09-27 02:04 產生的新群組
// `lg_bd21f312958ba02f1cf5` 只存在於 CasaOS 的檔案，PG 沒有。
//
// ⚠️ 一個必須自己處理的方言差異：同步版的 upsert 用了
//      system_agrees = MIN(user_same_house_members.system_agrees, excluded.system_agrees)
//    SQLite 的 `MIN(a, b)` 是**純量**函式；PostgreSQL 的 `MIN()` 是**聚合函式**，
//    在這種位置會直接報錯。PG 要用 `LEAST(a, b)`。`toPostgresSql` 不會轉譯這個
//    （它只處理 IFNULL／GROUP_CONCAT／instr 與參數佔位），所以這裡必須寫對的方言。
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import {
  judgeMergeSet,
  newGroupKey,
  normalizeMergeIds,
} from "./userSameHouse.js";

const GROUP_KEY_BY_POST_SQL =
  "SELECT group_key FROM user_same_house_members WHERE user_id = ? AND post_id = ?";
const POSTS_BY_GROUP_SQL =
  "SELECT post_id FROM user_same_house_members WHERE user_id = ? AND group_key = ?";
// splitPersonalSameHouse() 的三句（與 userSameHouse.js 逐字相同）。
const DELETE_PAIR_SQL =
  "DELETE FROM user_same_house_members WHERE user_id = ? AND post_id IN (?, ?)";
const DELETE_ONE_SQL =
  "DELETE FROM user_same_house_members WHERE user_id = ? AND post_id = ?";
const REGROUP_ONE_SQL =
  "UPDATE user_same_house_members SET group_key = ?, created_at = ? WHERE user_id = ? AND post_id = ?";
const MOVE_GROUP_SQL =
  "UPDATE user_same_house_members SET group_key = ? WHERE user_id = ? AND group_key = ?";
// PG 的 ON CONFLICT 目標 (user_id, post_id) 對應 PG 上的主鍵，已查證存在。
// MIN → LEAST 是**必要**的方言轉換，不是風格選擇。
const UPSERT_SQL = `INSERT INTO user_same_house_members (user_id, group_key, post_id, system_agrees, created_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(user_id, post_id) DO UPDATE SET
     group_key = excluded.group_key,
     system_agrees = LEAST(user_same_house_members.system_agrees, excluded.system_agrees),
     created_at = user_same_house_members.created_at`;

export async function pgExec(options = {}) {
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

// userSameHouse.js personalGroupKeyFor() 的 PG 分支（同步版把例外吞掉回空字串，這裡照抄）。
async function personalGroupKeyForAsync(exec, uid, postId) {
  if (!uid || !postId) return "";
  try {
    const rows = await exec(GROUP_KEY_BY_POST_SQL, [uid, postId]);
    return String(rows[0]?.group_key || "");
  } catch {
    return "";
  }
}

// userSameHouse.js splitPersonalSameHouse() 的 PG 分支。
// 語句與同步版逐字對應；這裡沒有任何需要轉方言的運算（沒有純量 MIN(a,b)、沒有 LIMIT -1）。
// 刻意**不**包交易：同步版也沒有 BEGIN，每一句各自 autocommit，這裡照抄同樣的原子性。
export async function splitPersonalSameHouseAsync(exec, userId, postId, peerId) {
  const uid = Number(userId) || 0;
  const a = Number(postId) || 0;
  const b = Number(peerId) || 0;
  if (!uid || !a || !b) return false;
  const keyA = await personalGroupKeyForAsync(exec, uid, a);
  const keyB = await personalGroupKeyForAsync(exec, uid, b);
  if (!keyA || keyA !== keyB) return false;
  const now = new Date().toISOString();
  const members = (await exec(POSTS_BY_GROUP_SQL, [uid, keyA])).map((row) => Number(row.post_id));
  await exec(DELETE_PAIR_SQL, [uid, a, b]);
  const remain = members.filter((id) => id !== a && id !== b);
  if (remain.length === 1) {
    await exec(DELETE_ONE_SQL, [uid, remain[0]]);
  } else if (remain.length > 1) {
    const next = newGroupKey();
    for (const id of remain) {
      await exec(REGROUP_ONE_SQL, [next, now, uid, id]);
    }
  }
  return true;
}

// userSameHouse.js mergePersonalSameHouse() 的 PG 分支。步驟與同步版逐條對應，
// 回傳形狀與訊息文字完全相同。
export async function mergePersonalSameHouse(userId, listings, { now = new Date(), ...options } = {}) {
  const uid = Number(userId) || 0;
  const rows = (listings || []).filter((row) => Number(row?.post_id) > 0);
  const ids = normalizeMergeIds(rows.map((row) => row.post_id));
  if (!uid) {
    return { ok: false, code: "guest", error: "請先登入才能併入同房源", systemAgrees: false };
  }
  if (ids.length < 2) {
    return { ok: false, code: "need_two", error: "請至少選 2 筆才能併入同房源", systemAgrees: false };
  }
  const judge = judgeMergeSet(rows);
  const stamp = now instanceof Date ? now.toISOString() : String(now);
  const exec = await pgExec(options);
  const keys = [...new Set((await Promise.all(ids.map((id) => personalGroupKeyForAsync(exec, uid, id)))).filter(Boolean))];
  const groupKey = keys[0] || newGroupKey(now instanceof Date ? now : new Date(stamp));
  const extraIds = [];
  for (const key of keys) {
    const found = await exec(POSTS_BY_GROUP_SQL, [uid, key]);
    extraIds.push(...found.map((row) => Number(row.post_id)));
  }
  const allIds = normalizeMergeIds([...ids, ...extraIds]);
  const agrees = judge.systemAgrees ? 1 : 0;
  await runInTransaction(options, async (tx) => {
    // keys.slice(1) 併入 keys[0]：與同步版相同，把其他群組的成員搬到第一個群組。
    for (const key of keys.slice(1)) {
      await tx(MOVE_GROUP_SQL, [groupKey, uid, key]);
    }
    for (const id of allIds) {
      await tx(UPSERT_SQL, [uid, groupKey, id, agrees, stamp]);
    }
  });
  return {
    ok: true,
    personal: true,
    shared: false,
    post_ids: allIds,
    group_key: groupKey,
    systemAgrees: judge.systemAgrees,
    message: judge.systemAgrees
      ? `已為你併入 ${allIds.length} 筆同房源（只改你的列表）`
      : `已為你併入 ${allIds.length} 筆同房源。系統判定不是同屋源，此筆記錄只留在你的帳號，不會分享給其他使用者。`,
  };
}

// 註（2026-09-27 更新）：driver-aware 的包裝最後放在 **sameHouseAsync.js**，不是 db.js——
// 它需要 `getListingAsync`（listingDetailAsync.js），而 listingDetailAsync.js 會匯入 db.js，
// 放進 db.js 會形成循環匯入。模組分工：
//   - 本檔：`mergePersonalSameHouse()`／`splitPersonalSameHouseAsync()` 的 PG 語句層
//   - sameHouseAsync.js：`mergeSameHouseForUserAsync()`／`confirmSuspectedMatchAsync()`／
//     `rejectSuspectedMatchAsync()` 的 driver-aware 入口（非 postgres 一律回退同步路徑）

// 同步版用 `db.prepare("SELECT * FROM listings WHERE post_id = ?").get(id)` 取原始資料列
// （不是裝飾後的 listing），再交給 judgeMergeSet。這裡照抄同一個查詢與順序。
const RAW_LISTING_SQL = "SELECT * FROM listings WHERE post_id = ?";

export async function loadRawListingsAsync(ids, options = {}) {
  const exec = await pgExec(options);
  const out = [];
  for (const id of ids || []) {
    const rows = await exec(RAW_LISTING_SQL, [Number(id) || 0]);
    if (rows[0]) out.push(rows[0]);
  }
  return out;
}
