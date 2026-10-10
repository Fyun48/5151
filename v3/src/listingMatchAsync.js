// 房源配對（setListingMatch）與同屋重評估（reconcileListingById）的 driver-aware 入口。
//
// sqlite   - db.js 既有的同步函式（行為完全不變）。
// postgres - 同一組語句跑在呼叫端的交易／連線上：配對欄位、群組綁定與評估列都寫 PG。
//
// 為什麼一定要有 PG 分支：站上的同屋顯示讀 PG 的 `listing_group_members`
// （repository/decorationData.js），但 watcher 的配對結果原本只寫本機 SQLite。
// 兩個 web 節點各自跑 watcher，於是各自累積出不同的群組與評估列，站上也看不到新配對。
//
// 評估的價值判斷（evaluateBlockedMatches／matchPatchFromEvaluation／hasReconcileEvidence）
// 與同步版共用同一份純函式，SQL 文字也共用 blockMatchCandidatesQuery；
// 只有「誰來跑語句」不同。
import { CONFIRM_ADMIN, CONFIRM_AUTO, CONFIRM_SUSPECTED } from "./listingGroups.js";
import {
  blockMatchCandidatesQuery,
  evaluateBlockedMatches,
  filterBlockMatchRows,
  hasReconcileEvidence,
  matchPatchFromEvaluation,
} from "./sameHouseReconcile.js";
import { bindListingsToGroup, isTrustedGroup, postConfirmationLevel, recordMatchEvaluation } from "./listingGroupsAsync.js";
import { setListingMatch as setListingMatchSync, reconcileListingById as reconcileListingByIdSync } from "./db.js";
import * as repo from "./repository/listingGroups.js";
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { bumpRevisionPgClient, bumpRevisionPgExec } from "./revisionBumpAsync.js";
import { refreshListingProjection } from "./listingSearchProjection.js";
import { refreshFoldColumns } from "./match.js";
import { bumpAnalyticsAsync } from "./rentalAnalyticsAsync.js";

function countRefreshFailure(exec, metric) {
  return bumpAnalyticsAsync(metric, new Date(), 1, { exec, driver: "postgres" }).catch(() => {});
}

async function postgresExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

async function runInTransaction(options, fn) {
  if (options.exec) return fn(options.exec, null);
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return pgDriver.withTransaction(async (client) => {
    const tx = (sql, params = []) => client.query(toPostgresSql(sql), params).then((res) => res.rows);
    return fn(tx, client);
  });
}

function one(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// PG 的 listings 是否有 fixture_namespace，只查一次（對應同步版的 PRAGMA 偵測）。
let pgListingsHasFixtureColumn = null;
async function pgFixtureColumn(exec) {
  if (pgListingsHasFixtureColumn !== null) return pgListingsHasFixtureColumn;
  try {
    const rows = await exec(
      "SELECT 1 AS present FROM information_schema.columns WHERE table_name = 'listings' AND column_name = 'fixture_namespace' LIMIT 1",
      [],
    );
    pgListingsHasFixtureColumn = Boolean(one(rows));
  } catch {
    pgListingsHasFixtureColumn = false;
  }
  return pgListingsHasFixtureColumn;
}

// db.js blockMatchCandidates() 的 PG 分支：同一段 SQL 文字、改由 PG 執行。
export async function blockMatchCandidates(exec, incoming, { limit } = {}) {
  const fixtureColumn = await pgFixtureColumn(exec);
  const { sql, params } = blockMatchCandidatesQuery(null, incoming, { limit, fixtureColumn });
  if (!sql) return [];
  const rows = await exec(sql, params);
  return filterBlockMatchRows(incoming, rows ?? []);
}

// db.js setListingMatch() 的 PG 分支。
export async function setListingMatch(exec, postId, match = {}, client = null) {
  await exec(repo.SET_LISTING_MATCH_SQL, [
    match.match_post_id || null,
    match.match_level || null,
    match.match_detail || "",
    postId,
  ]);
  if (match.match_post_id) {
    const a = one(await exec(repo.LISTING_BY_POST_SQL, [postId]));
    const b = one(await exec(repo.LISTING_BY_POST_SQL, [match.match_post_id]));
    if (a && b) {
      try {
        await bindListingsToGroup(exec, [a, b], {
          evidence: match.evidence || { detail: match.match_detail || "" },
          confidence: match.confidence ?? (match.match_level === "high" ? 0.9 : 0.7),
          confirmationLevel: match.confirmationLevel
            || (match.match_level === "high" ? CONFIRM_AUTO : CONFIRM_SUSPECTED),
          adminUserId: match.adminUserId || 0,
          allowAdminMerge: match.allowAdminMerge === true,
        });
      } catch {
        // 與同步版相同：隔離測試沒有群組表時不讓配對失敗。
      }
    }
  }
  // 配對會改 match_post_id（投影 primary_listing_id 的來源）⇒ 在同一交易內刷新投影與 fold，避免 stored 值過時。
  // best-effort：隔離夾具可能沒有投影表，失敗不擋配對（resync 工具會補齊），但失敗要計數。
  try {
    await refreshListingProjection(exec, postId);
    if (Number(match.match_post_id) > 0) await refreshListingProjection(exec, Number(match.match_post_id));
  } catch { await countRefreshFailure(exec, "projection_refresh_failed"); }
  try {
    await refreshFoldColumns(exec, postId);
    if (Number(match.match_post_id) > 0) await refreshFoldColumns(exec, Number(match.match_post_id));
  } catch { await countRefreshFailure(exec, "fold_refresh_failed"); }
  // 配對會改 match_post_id／群組（同屋摺疊的裝飾），是訪客快取回應的一部分 ⇒ bump。
  // 真交易（有 client）用 SAVEPOINT 隔離；注入式 exec（測試）無交易，直接 best-effort。
  const payload = { entityType: "listing", entityId: Number(postId) || 0, eventType: "same_house_match" };
  if (client) await bumpRevisionPgClient(client, payload);
  else await bumpRevisionPgExec(exec, payload);
  return one(await exec(repo.LISTING_BY_POST_SQL, [postId]));
}

// db.js reconcileListingById() 的 PG 分支。步驟與同步版逐條對應。
export async function reconcileListingById(exec, postId, { reason = "manual", now = new Date(), limit } = {}, client = null) {
  const listing = one(await exec(repo.LISTING_BY_POST_SQL, [Number(postId) || 0]));
  if (!listing) return { skipped: true, reason: "missing" };
  if ((await postConfirmationLevel(exec, listing.post_id)) === CONFIRM_ADMIN) {
    return { skipped: true, reason: "admin_confirmed", evaluations: [], trigger: reason };
  }
  if ((await isTrustedGroup(exec, listing.post_id)) && String(listing.match_level || "") === "high") {
    return { skipped: true, reason: "auto_confirmed", evaluations: [], trigger: reason };
  }
  if (!hasReconcileEvidence(listing)) {
    return { skipped: true, reason: "insufficient_evidence", evaluations: [], trigger: reason };
  }
  const candidates = await blockMatchCandidates(exec, listing, { limit });
  const { best, evaluations } = evaluateBlockedMatches(listing, candidates, { now });
  for (const evaluation of evaluations) {
    await recordMatchEvaluation(exec, evaluation);
  }
  const result = {
    skipped: false,
    reason: "",
    candidate_count: candidates.length,
    best,
    evaluations,
    confirmation_level: best?.level === "high" ? CONFIRM_AUTO : best?.level === "medium" ? CONFIRM_SUSPECTED : "",
  };
  result.trigger = reason;
  if (result.skipped || !result.best?.hit) return result;
  const patch = matchPatchFromEvaluation(result.best);
  if (patch?.match_post_id) {
    await setListingMatch(exec, listing.post_id, { ...patch, confirmationLevel: result.confirmation_level }, client);
    result.applied = true;
  }
  return result;
}

// ---- driver-aware 入口 ----

export async function setListingMatchAsync(postId, match, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") return setListingMatchSync(postId, match);
  return runInTransaction(options, (exec, client) => setListingMatch(exec, postId, match, client));
}

export async function reconcileListingByIdAsync(postId, { reason = "manual", ...rest } = {}, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return reconcileListingByIdSync(postId, { reason });
  }
  return runInTransaction(options, (exec, client) => reconcileListingById(exec, postId, { reason, ...rest }, client));
}
