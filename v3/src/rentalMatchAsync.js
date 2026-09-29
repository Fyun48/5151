// 站內刊登的「屋主配對」讀取島嶼（PG 島嶼，2026-09-29，第八十批）。
//
// 涵蓋的路由：
//   `GET /api/self-listings`                     → `listMineSelfListingsAsync`（＋配對摘要）
//   `GET /api/self-listings/:id/matches/summary` → `ownerListingMatchSummaryAsync`
//
// 為什麼要移植：整條配對鏈在 PG 模式下讀的是**節點本機**——
//
//   - 候選許願房（`demand_posts`／`demand_match_districts`）：別的節點收到的心願完全不算，
//     「目前可能符合 N 個活躍需求」因此偏少或掛掉；
//   - 自己的刊登（`listings`）：別的節點建立的刊登看不到；
//   - 會員方案／角色（`listingToolsInfo` → `users`）：額度與工具開關跟著本機那一份跑。
//
// 做法與其他島嶼相同：**重用同步版的純函式**，只把「誰去撈列」換成 PG——
// `candidateSql()`（同一句 SQL、同一個分塊大小）、`activityMapFrom()`（活動資料的組裝）、
// `computeListingMatchesFrom()`（快取 ＋ 評分 ＋ 快照）、`ownerMatchSummaryFrom()`（摘要外型）。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { idPlaceholders } from "./repository/listings.js";
import { getWishConditionsAsync } from "./rentalCatalogAsync.js";
import {
  MATCH_CANDIDATE_CHUNK,
  isListingMatchable,
  listingMatchSnapshot,
} from "./rentalMatch.js";
import {
  activityMapFrom,
  assertMatchingEnabled,
  attachOwnerMatchSummaries as attachOwnerMatchSummariesSync,
  candidateSql,
  computeListingMatchesFrom,
  currentMatchCatalog,
  currentMatchFlags,
  loadOwnedMatchListing as loadOwnedMatchListingSync,
  ownerListingMatchSummary as ownerListingMatchSummarySync,
  ownerMatchSummaryFrom,
  ownerMatchingMeta,
  unavailableSummary,
} from "./rentalMatchQuery.js";
import {
  demandMatchDistrictIndexCountAsync,
  rebuildDemandMatchDistrictsAsync,
  expireOpenPostsAsync,
} from "./demandAsync.js";
import { getSelfRowAsync, expireOpenSelfListingsAsync } from "./selfListingsAsync.js";
import { SELF_LISTINGS_BY_OWNER_SQL, decorateSelfListing } from "./selfListings.js";
import { getUserByIdAsync } from "./usersAsync.js";
import { listingToolsMeta } from "./listingTools.js";
import { DEMAND_MATCH_GENERATION_SQL } from "./demand.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const nowOf = (options) => (options.now ? new Date(options.now) : new Date());
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

async function pgRunner(options = {}) {
  if (options.exec) {
    const injected = options.exec;
    return async (sql, params = []) => {
      const raw = await injected(sql, params);
      return Array.isArray(raw) ? { rows: raw } : raw;
    };
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params);
}

const chunkIds = (ids, size = 400) => {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
};

/** `demand.js:readDemandMatchGeneration()` 的 PG 版（表不存在時 0，與同步版同義）。 */
export async function wishGenerationAsync(run) {
  try {
    const row = rowsOf(await run(DEMAND_MATCH_GENERATION_SQL, []))[0];
    return Number(row?.generation) || 0;
  } catch {
    return 0;
  }
}

/** `rentalMatchQuery.js:queryAllCandidateWishes()` 的 PG 版（同一句 SQL、同一個分塊）。 */
export async function queryAllCandidateWishesAsync(run, listing, options = {}) {
  // 帶行政區的候選查詢靠 `demand_match_districts`：索引為空時要補（與同步版
  // `ensureRentalMatchIndexes()` 的懶重建同一條規則，第七十九批修過同一個坑）。
  if ((listing?.districts || []).length && (await demandMatchDistrictIndexCountAsync(run)) === 0) {
    await rebuildDemandMatchDistrictsAsync(run);
  }
  const rows = [];
  let afterId = 0;
  for (;;) {
    const { sql, params } = candidateSql(listing, { afterId, limit: MATCH_CANDIDATE_CHUNK, db: null });
    const chunk = rowsOf(await run(sql, params));
    if (!chunk.length) break;
    rows.push(...chunk);
    afterId = Number(chunk[chunk.length - 1].id) || afterId;
    if (chunk.length < MATCH_CANDIDATE_CHUNK) break;
  }
  void options;
  return rows;
}

/** `rentalMatchQuery.js:preloadActivityByUser()` 的 PG 版（兩句查詢 ＋ 同一份純組裝）。 */
export async function preloadActivityByUserAsync(run, rows, now, { chunkSize = 400 } = {}) {
  const ids = [...new Set((rows || []).map((row) => Number(row.user_id)).filter(Boolean))];
  const logins = new Map();
  const flags = new Map();
  for (const chunk of chunkIds(ids, chunkSize)) {
    const marks = idPlaceholders(chunk, "postgres");
    try {
      const users = rowsOf(await run(`SELECT id, last_login_at FROM users WHERE id IN (${marks})`, chunk));
      for (const user of users) if (user.last_login_at) logins.set(Number(user.id), user.last_login_at);
    } catch { /* last_login_at 可能不存在（舊庫） */ }
    try {
      const flagRows = rowsOf(await run(
        `SELECT user_id, MAX(viewed_at) AS viewed_at, MAX(watched_at) AS watched_at
         FROM user_listing_flags WHERE user_id IN (${marks})
         GROUP BY user_id`,
        chunk,
      ));
      for (const flag of flagRows) flags.set(Number(flag.user_id), flag);
    } catch { /* flags 表可能不存在 */ }
  }
  return activityMapFrom(rows, logins, flags, now);
}

/** `rentalMatchQuery.js:computeListingMatches()` 的 PG 版。 */
export async function computeListingMatchesAsync(run, listing, options = {}) {
  const now = nowOf(options);
  await expireOpenPostsAsync(run, now);
  const generation = await wishGenerationAsync(run);
  const candidates = options.rows || await queryAllCandidateWishesAsync(run, listing, options);
  const activity = options.activityByUser || await preloadActivityByUserAsync(run, candidates, now);
  return computeListingMatchesFrom({ listing, candidates, activityByUser: activity, now, generation });
}

/** `rentalMatchQuery.js:loadOwnedMatchListing()` 的 PG 版。 */
export async function loadOwnedMatchListingAsync(run, postId, userId, now = new Date()) {
  assertMatchingEnabled();
  await expireOpenSelfListingsAsync(run, now);
  const row = await getSelfRowAsync(postId, { exec: run, driver: "postgres" });
  if (!row) throw Object.assign(new Error("找不到這則站內刊登"), { status: 404, code: "listing_not_found" });
  if (Number(row.listed_by_user_id) !== Number(userId)) {
    throw Object.assign(new Error("找不到這則站內刊登"), { status: 404, code: "listing_not_found" });
  }
  const listing = listingMatchSnapshot(row, { catalog: currentMatchCatalog() });
  if (!isListingMatchable(listing, now)) {
    throw Object.assign(new Error("這則刊登目前不能配對"), { status: 409, code: "listing_not_matchable" });
  }
  return { row, listing };
}

/** `rentalMatchQuery.js:ownerListingMatchSummary()` 的 PG 版。 */
export async function ownerListingMatchSummaryAsync(postId, userId, options = {}) {
  const now = nowOf(options);
  if (!isPg(options)) return ownerListingMatchSummarySync(sqliteHandle(), postId, userId, now);
  try {
    await getWishConditionsAsync(options);
    const run = await pgRunner(options);
    const { listing } = await loadOwnedMatchListingAsync(run, postId, userId, now);
    const snapshot = await computeListingMatchesAsync(run, listing, { ...options, now });
    return ownerMatchSummaryFrom(listing.id, snapshot);
  } catch (error) {
    if (error?.status) throw error;
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return ownerListingMatchSummarySync(sqliteHandle(), postId, userId, now);
  }
}

/** `rentalMatchQuery.js:attachOwnerMatchSummaries()` 的 PG 版（逐刊登摘要，共用一批候選）。 */
export async function attachOwnerMatchSummariesAsync(listings, userId, options = {}) {
  const now = nowOf(options);
  if (!isPg(options)) return attachOwnerMatchSummariesSync(sqliteHandle(), listings, userId, now);
  const list = Array.isArray(listings) ? listings : [];
  if (!list.length) return list;
  try {
    await getWishConditionsAsync(options);
    const run = await pgRunner(options);
    if (!(currentMatchFlags()?.wish?.owner_matching_enabled === true)) {
      return list.map((row) => ({ ...row, match_summary: null }));
    }
    const catalog = currentMatchCatalog();
    const closed = new Map();
    const open = [];
    for (const row of list) {
      if (String(row.status || "") !== "open") {
        closed.set(Number(row.post_id), {
          count: 0,
          enabled: true,
          unavailable: false,
          empty: true,
          label: "已關閉的刊登不參與配對",
        });
      } else {
        open.push(row);
      }
    }
    const snaps = open.map((row) => listingMatchSnapshot(row, { catalog }));
    // 同一批候選：與同步版的 `computeListingMatchesBatch()` 同義（依 fixture 命名空間分組）。
    const groups = new Map();
    for (const listing of snaps) {
      const key = String(listing.fixture_namespace || "");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(listing);
    }
    await expireOpenPostsAsync(run, now);
    const generation = await wishGenerationAsync(run);
    for (const group of groups.values()) {
      const districts = [...new Set(group.flatMap((row) => row.districts || []))];
      const rents = group.map((row) => Number(row.rent) || 0).filter((n) => n > 0);
      const rows = await queryAllCandidateWishesAsync(run, {
        districts,
        rent: rents.length ? Math.min(...rents) : 0,
        fixture_namespace: group[0].fixture_namespace || "",
      }, options);
      const activityByUser = await preloadActivityByUserAsync(run, rows, now);
      for (const listing of group) {
        await computeListingMatchesAsync(run, listing, { ...options, now, rows, activityByUser });
      }
    }
    const out = [];
    for (const row of list) {
      const postId = Number(row.post_id);
      if (closed.has(postId)) {
        out.push({ ...row, match_summary: closed.get(postId) });
        continue;
      }
      try {
        const summary = await ownerListingMatchSummaryAsync(postId, userId, { ...options, now });
        out.push({ ...row, match_summary: summary });
      } catch {
        out.push({ ...row, match_summary: unavailableSummary(postId) });
      }
    }
    return out;
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return attachOwnerMatchSummariesSync(sqliteHandle(), listings, userId, now);
  }
}

/** `db.js:listMineSelfListings()` 的 PG 版（自己的站內刊登 ＋ 配對摘要）。 */
export async function listMineSelfListingsAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  if (!isPg(options)) {
    const { listMineSelfListings } = await import("./db.js");
    return listMineSelfListings(uid);
  }
  try {
    const run = await pgRunner(options);
    await expireOpenSelfListingsAsync(run, nowOf(options));
    const rows = rowsOf(await run(SELF_LISTINGS_BY_OWNER_SQL, [uid]))
      .map((row) => decorateSelfListing(row, { viewerId: uid }));
    return await attachOwnerMatchSummariesAsync(rows, uid, options);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    const { listMineSelfListings } = await import("./db.js");
    return listMineSelfListings(uid);
  }
}

/** `db.js:listingToolsInfo()` 的 PG 版：方案／角色讀 PG（額度與工具開關跟著站上那一份）。 */
export async function listingToolsInfoAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  const user = uid ? await getUserByIdAsync(uid, options) : null;
  return listingToolsMeta({ plan: user?.plan, role: user?.role });
}

/** `db.js:rentalMatchOwnerMeta()` 的 PG 版：先補水（PG 的開關），再跑同一份純函式。 */
export async function rentalMatchOwnerMetaAsync(options = {}) {
  await getWishConditionsAsync(options);
  return ownerMatchingMeta();
}
