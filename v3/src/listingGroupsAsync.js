// 同物件群組與配對評估的 driver-aware 寫入入口。
//
// sqlite   - listingGroups.js 既有的同步函式（行為完全不變）。
// postgres - repository/listingGroups.js 的同一份語句文字，跑在呼叫端的交易裡。
//
// 為什麼一定要有 PG 分支：站上的同屋顯示讀的是 PG 的 `listing_group_members`
// （repository/decorationData.js），但寫入原本只到本機 SQLite，所以新配對在站上永遠看不到，
// 兩台節點也會各自累積出不同的群組與評估。這裡讓「讀哪裡、寫哪裡」回到同一個 store。
//
// exec 的形狀統一為 `async (sql, params) => rows[]`（SELECT 回列、寫入回空陣列），
// 與 pgSharedDriver／scheduleTransaction 的既有約定相同。
import {
  CONFIRM_ADMIN,
  CONFIRM_AUTO,
  CONFIRM_SUSPECTED,
  bindListingsToGroup as bindListingsToGroupSync,
  makeGroupId,
  recordMatchEvaluation as recordMatchEvaluationSync,
  unbindListingFromGroup as unbindListingFromGroupSync,
  writeGroupAudit as writeGroupAuditSync,
} from "./listingGroups.js";
import { sortGroupListings } from "./match.js";
import * as repo from "./repository/listingGroups.js";
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteHandle } from "./db.js";

async function postgresExec(options = {}) {
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

function stamp(now) {
  return (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
}

function one(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ---- 讀取（PG 分支；SQLite 分支由 listingGroups.js 的同步函式負責）----

export async function groupIdForPost(exec, postId) {
  const row = one(await exec(repo.GROUP_ID_FOR_POST_SQL, [Number(postId)]));
  return row?.group_id || "";
}

export async function groupRecord(exec, groupId) {
  if (!groupId) return null;
  try {
    return one(await exec(repo.GROUP_RECORD_SQL, [groupId])) || null;
  } catch {
    return null;
  }
}

export async function groupConfirmationLevel(exec, groupId) {
  return String((await groupRecord(exec, groupId))?.confirmation_level || "") || CONFIRM_AUTO;
}

export async function postConfirmationLevel(exec, postId) {
  const gid = await groupIdForPost(exec, postId);
  return gid ? groupConfirmationLevel(exec, gid) : "";
}

export async function isAdminConfirmedGroup(exec, groupId) {
  return (await groupConfirmationLevel(exec, groupId)) === CONFIRM_ADMIN;
}

export async function isTrustedGroup(exec, postId) {
  const level = await postConfirmationLevel(exec, postId);
  return level === CONFIRM_ADMIN || level === CONFIRM_AUTO;
}

export async function pickCanonicalGroupId(exec, groupIds) {
  const ids = [...new Set((groupIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length <= 1) return ids[0] || "";
  const rows = await exec(repo.pickCanonicalGroupIdSql(ids.length), ids);
  const createdAt = new Map((rows || []).map((row) => [row.group_id, String(row.created_at || "")]));
  return ids.slice().sort((a, b) => {
    const ca = createdAt.get(a) || "";
    const cb = createdAt.get(b) || "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a < b ? -1 : 1;
  })[0];
}

export async function listGroupMembers(exec, groupId) {
  if (!groupId) return [];
  return (await exec(repo.LIST_GROUP_MEMBERS_SQL, [groupId])) || [];
}

export async function refreshGroupPrimary(exec, groupId, now = new Date()) {
  const members = await listGroupMembers(exec, groupId);
  if (!members.length) return null;
  const primary = sortGroupListings(members, now instanceof Date ? now.getTime() : Number(now) || Date.now())[0];
  await exec(repo.SET_PRIMARY_SQL, [Number(primary.post_id), stamp(now), groupId]);
  return primary;
}

async function migrateGroupBindings(exec, loserIds, winnerId) {
  const losers = [...new Set((loserIds || []).filter((id) => id && id !== winnerId))];
  if (!winnerId || !losers.length) return;
  await exec(repo.migrateWatchFlagsSql(losers.length), [winnerId, ...losers]);
  await exec(repo.migrateUserEventsSql(losers.length), [winnerId, ...losers]);
}

export async function writeGroupAudit(exec, {
  action,
  adminUserId = 0,
  postIds = [],
  previousGroupIds = [],
  resultingGroupId = "",
  now = new Date(),
} = {}) {
  await exec(repo.GROUP_AUDIT_INSERT_SQL, [
    String(action || ""),
    Number(adminUserId) || null,
    JSON.stringify((postIds || []).map(Number).filter((id) => id > 0)),
    JSON.stringify((previousGroupIds || []).filter(Boolean)),
    String(resultingGroupId || ""),
    stamp(now),
  ]);
}

export async function recordMatchEvaluation(exec, evaluation) {
  if (!evaluation) return;
  await exec(repo.MATCH_EVALUATION_INSERT_SQL, [
    Number(evaluation.incoming_post_id) || 0,
    Number(evaluation.candidate_post_id) || null,
    String(evaluation.candidate_source || ""),
    Number(evaluation.confidence) || 0,
    String(evaluation.level || ""),
    JSON.stringify(evaluation.signals || []),
    JSON.stringify(evaluation.veto_reasons || []),
    String(evaluation.matcher_version || ""),
    String(evaluation.evaluated_at || new Date().toISOString()),
  ]);
}

// ---- 寫入（與 listingGroups.bindListingsToGroup 逐條對應）----

export async function bindListingsToGroup(exec, listings, {
  evidence = {},
  confidence = 0.8,
  now = new Date(),
  confirmationLevel = CONFIRM_AUTO,
  adminUserId = 0,
  allowAdminMerge = false,
} = {}) {
  const rows = (listings || []).filter((row) => Number(row?.post_id));
  if (rows.length < 2) return null;

  const existing = [];
  for (const row of rows) {
    const gid = await groupIdForPost(exec, row.post_id);
    if (gid) existing.push(gid);
  }
  const unique = [...new Set(existing)];
  const adminGroups = [];
  for (const id of unique) {
    if (await isAdminConfirmedGroup(exec, id)) adminGroups.push(id);
  }
  const created = stamp(now);
  const ev = JSON.stringify(evidence || {});

  if (adminGroups.length && !allowAdminMerge) {
    const adminId = (await pickCanonicalGroupId(exec, adminGroups)) || adminGroups[0];
    for (const row of rows) {
      const current = await groupIdForPost(exec, row.post_id);
      if (current && current !== adminId) continue;
      await exec(repo.INSERT_GROUP_MEMBER_SQL, [
        Number(row.post_id), adminId, String(row.source || ""), confidence, ev, created,
      ]);
    }
    await exec(repo.TOUCH_GROUP_SQL, [created, adminId]);
    await refreshGroupPrimary(exec, adminId, now);
    return adminId;
  }

  const groupId = (await pickCanonicalGroupId(exec, unique))
    || makeGroupId(rows.map((r) => Number(r.post_id)).sort((a, b) => a - b).join(":"));
  const nextLevel = confirmationLevel || CONFIRM_AUTO;
  await exec(repo.insertGroupSql({
    confirmAdmin: CONFIRM_ADMIN,
    confirmAuto: CONFIRM_AUTO,
    confirmSuspected: CONFIRM_SUSPECTED,
  }), [
    groupId,
    Number(rows[0].post_id),
    created,
    created,
    nextLevel,
    nextLevel === CONFIRM_ADMIN ? (Number(adminUserId) || null) : null,
    nextLevel === CONFIRM_ADMIN ? created : null,
  ]);
  for (const row of rows) {
    await exec(repo.INSERT_GROUP_MEMBER_SQL, [
      Number(row.post_id), groupId, String(row.source || ""), confidence, ev, created,
    ]);
  }
  if (unique.length > 1) {
    const losers = unique.filter((id) => id !== groupId);
    for (const old of losers) {
      await exec(repo.MOVE_GROUP_MEMBERS_SQL, [groupId, old]);
    }
    await migrateGroupBindings(exec, losers, groupId);
    for (const old of losers) {
      await exec(repo.DELETE_GROUP_SQL, [old]);
    }
  }
  await refreshGroupPrimary(exec, groupId, now);
  return groupId;
}

export async function unbindListingFromGroup(exec, postId, { now = new Date() } = {}) {
  const pid = Number(postId) || 0;
  if (!pid) return "";
  const gid = await groupIdForPost(exec, pid);
  if (!gid) return "";
  await exec(repo.DELETE_MEMBER_SQL, [pid]);
  const left = Number(one(await exec(repo.COUNT_GROUP_MEMBERS_SQL, [gid]))?.n) || 0;
  if (!left) {
    await exec(repo.DELETE_GROUP_SQL, [gid]);
    return "";
  }
  if (left === 1) {
    await exec(repo.DELETE_GROUP_MEMBERS_SQL, [gid]);
    await exec(repo.DELETE_GROUP_SQL, [gid]);
    return "";
  }
  await refreshGroupPrimary(exec, gid, now);
  return gid;
}

// ---- driver-aware 入口 ----

export async function bindListingsToGroupAsync(listings, opts = {}, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return bindListingsToGroupSync(sqliteHandle(), listings, opts);
  }
  return runInTransaction(options, (exec) => bindListingsToGroup(exec, listings, opts));
}

export async function unbindListingFromGroupAsync(postId, { now = new Date() } = {}, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return unbindListingFromGroupSync(sqliteHandle(), postId, { now });
  }
  return runInTransaction(options, (exec) => unbindListingFromGroup(exec, postId, { now }));
}

export async function recordMatchEvaluationAsync(evaluation, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return recordMatchEvaluationSync(sqliteHandle(), evaluation);
  }
  const exec = await postgresExec(options);
  return recordMatchEvaluation(exec, evaluation);
}

export async function writeGroupAuditAsync(entry = {}, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return writeGroupAuditSync(sqliteHandle(), entry);
  }
  const exec = await postgresExec(options);
  return writeGroupAudit(exec, entry);
}
