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
import { getWishConditionsAsync } from "./rentalCatalogAsync.js";
import {
  MATCH_CANDIDATE_CHUNK,
  applyMatchCursor,
  clampLimit,
  expireMatchPageCursor,
  isListingMatchable,
  isWishMatchable,
  listingMatchSnapshot,
  readOpaqueMatchCursor,
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
  ownerPublicMatchItem,
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
import { attachOfferCtasAsync } from "./wishOffersAsync.js";

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

const placeholders = (list) => list.map(() => "?").join(",");

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
    // ⚠️ 佔位符寫 `?`：島嶼的 runner 在真 PG 路徑會過 `toPostgresSql()` 轉成 `$n`，
    // 但**注入式 exec（測試夾具）不會被翻譯** ⇒ 寫死 `$n` 會讓那些查詢整個失敗
    // （`try/catch` 吞掉之後變成「活動資料永遠是空的」，第八十一批實測中過）。
    const marks = placeholders(chunk);
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

// ---- `GET /api/self-listings/:id/matches`（配對清單）------------------------------------

/** `rentalMatchQuery.js:loadWishLifecycleByTokens()` 的 PG 版（游標頁的生命週期守衛用）。 */
export async function loadWishLifecycleByTokensAsync(run, tokens, { chunkSize = 400 } = {}) {
  const map = new Map();
  const list = [...new Set((tokens || []).map((token) => String(token || "")).filter(Boolean))];
  for (const chunk of chunkIds(list, chunkSize)) {
    const marks = placeholders(chunk);
    try {
      const rows = rowsOf(await run(
        `SELECT public_token, status, lifecycle FROM demand_posts WHERE public_token IN (${marks})`,
        chunk,
      ));
      for (const row of rows) map.set(String(row.public_token), row);
    } catch { /* 隔離測試可能沒有 public_token 欄 */ }
  }
  return map;
}

/** `rentalMatchQuery.js:assertUpcomingCursorWishesMatchable()` 的 PG 版。 */
export async function assertUpcomingCursorWishesMatchableAsync(run, stored, cursor, limit) {
  const size = clampLimit(limit);
  const start = Math.max(0, Number(stored.afterIndex) || 0);
  const upcoming = (stored.items || []).slice(start, start + size);
  const tokens = upcoming.map((row) => row.wish_ref || row.public_token).filter(Boolean);
  if (!tokens.length) return 0;
  const live = await loadWishLifecycleByTokensAsync(run, tokens);
  for (const token of tokens) {
    const row = live.get(token);
    if (!row || !isWishMatchable(row)) {
      expireMatchPageCursor(cursor);
      throw Object.assign(new Error("分頁已過期，請重新查詢"), { status: 400, code: "cursor_expired" });
    }
  }
  return tokens.length;
}

/** `rentalMatchQuery.js:ownerListingMatches()` 的 PG 版（配對清單，含游標分頁）。 */
export async function ownerListingMatchesAsync(postId, userId, options = {}) {
  const { limit, cursor } = options;
  const now = nowOf(options);
  if (!isPg(options)) {
    const { ownerListingMatches } = await import("./db.js");
    return ownerListingMatches(postId, userId, { limit, cursor });
  }
  try {
    await getWishConditionsAsync(options);
    const run = await pgRunner(options);
    const { listing } = await loadOwnedMatchListingAsync(run, postId, userId, now);
    await expireOpenPostsAsync(run, now);
    const at = now.getTime();
    const epoch = await wishGenerationAsync(run);
    const flags = currentMatchFlags();
    if (cursor) {
      const stored = readOpaqueMatchCursor(cursor, at);
      if (!stored) throw Object.assign(new Error("分頁已過期，請重新查詢"), { status: 400, code: "cursor_expired" });
      if (listing.id && stored.listingId && String(stored.listingId) !== String(listing.id)) {
        throw Object.assign(new Error("分頁游標不正確"), { status: 400, code: "bad_cursor" });
      }
      if (stored.epoch && String(stored.epoch) !== String(epoch)) {
        expireMatchPageCursor(cursor);
        throw Object.assign(new Error("分頁已過期，請重新查詢"), { status: 400, code: "cursor_expired" });
      }
      await assertUpcomingCursorWishesMatchableAsync(run, stored, cursor, limit);
      const page = applyMatchCursor(null, cursor, limit, { listingId: listing.id, now: at, epoch });
      const items = page.items.map(ownerPublicMatchItem);
      return {
        listing_id: listing.id,
        total: page.total,
        limit: clampLimit(limit),
        cursor: String(cursor),
        next_cursor: page.next_cursor,
        items: await attachOfferCtasAsync(items, {
          listingId: listing.id,
          ownerUserId: userId,
          now,
          flags,
          ...options,
        }),
      };
    }
    const snapshot = await computeListingMatchesAsync(run, listing, { ...options, now });
    let page;
    try {
      page = applyMatchCursor(snapshot.items, "", limit, { listingId: listing.id, now: at, epoch });
    } catch (error) {
      if (error.code === "match_snapshot_too_large") {
        error.total = snapshot.total;
        throw error;
      }
      throw error;
    }
    const items = page.items.map(ownerPublicMatchItem);
    return {
      listing_id: listing.id,
      total: snapshot.total,
      limit: clampLimit(limit),
      cursor: "",
      next_cursor: page.next_cursor,
      items: await attachOfferCtasAsync(items, {
        listingId: listing.id,
        ownerUserId: userId,
        now,
        flags,
        ...options,
      }),
    };
  } catch (error) {
    if (error?.status) throw error;
    if (!sqliteFallbackAllowed(options, {})) throw error;
    const { ownerListingMatches } = await import("./db.js");
    return ownerListingMatches(postId, userId, { limit, cursor });
  }
}
