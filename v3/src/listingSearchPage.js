import { buildListRequestContextFromPg, listingStatsBuildContext } from './db.js';
import { resolveDbDriver } from './dbDriver.js';
import { sharedPgDriver } from './pgSharedDriver.js';
import { toPostgresSql } from './sqlDialect.js';
import { withPgReadSnapshot, readPgRows, isReadOnlySnapshotViolation } from './pgReadSnapshot.js';
import { listingRequestTime } from './listingRequestTime.js';
import { searchListingsAsync, ListingSearchUnavailableError, isListingSearchUnavailable } from './listingSearchAsync.js';
import { listingStatsAsync, loadPgListingStatsInputs } from './listingStatsAsync.js';
import { prepareStatsScope } from './repository/listingStats.js';
import { prepareListScope } from './listingSearchNodePg.js';
import { runScopeScan } from './listingScopeScan.js';
import { createDecorationDataLoader } from './repository/decorationData.js';
import { loadMemberListingPage, memberListingCacheEnabled } from './memberListingCachePg.js';

/** 一趟掃描（A 方案）的開關；`MEMBER_LIST_ONEPASS=0` 可完全關掉（等價／A-B 證據用）。 */
export function onePassEnabled() {
  const raw = process.env.MEMBER_LIST_ONEPASS;
  if (raw == null || raw === "") return true;
  return !["0", "false", "off", "no"].includes(String(raw).trim().toLowerCase());
}

// The page and its counters share one clock, connection, settings and snapshot.
// This is also the benchmark entry: all DB/Node work and the public envelope.
export async function loadListingPage(input = {}, options = {}) {
  const driver = options.driver || resolveDbDriver();
  const args = {...input, ...listingRequestTime(input.asOf)};
  // 版本化快取（memberListingCachePg.js）：**預設關閉**（`MEMBER_LISTING_CACHE=1` 才開），
  // 而且只在 postgres driver 上生效。沒開閘／非 PG 時走的是同一條 computeListingPage，
  // 回傳值與加這一層之前逐字相同。
  if (driver !== 'postgres' || !memberListingCacheEnabled()) {
    return computeListingPage(args, driver, options);
  }
  const pgDriver = options.pgDriver || await sharedPgDriverOrUnavailable();
  return loadMemberListingPage({
    pgDriver,
    args,
    load: () => computeListingPage(args, driver, {...options, pgDriver}),
    // 呼叫端**明確**傳進來的 asOf 會改變結果 ⇒ 進 key；`listingRequestTime()` 自動產生的
    // 那一個時鐘不進（每個請求都不同，進去等於永遠不命中）。
    deps: { explicitAsOf: input.asOf ?? null },
  });
}

// 取共用 pool。失敗要維持原本的契約（穩定的 SEARCH_UNAVAILABLE），
// 不能因為搬到快取層之前就讓原始錯誤直接漏出去。
async function sharedPgDriverOrUnavailable() {
  try {
    return await sharedPgDriver();
  } catch (error) {
    if (isListingSearchUnavailable(error)) throw error;
    throw new ListingSearchUnavailableError(error);
  }
}

// 沒有快取時的那條路（＝這支模組原本的內容，逐字保留）。
/**
 * A 方案：備好兩份範圍並跑**一趟**掃描。
 *
 * 回傳 `{statsScope, statsRows, listScope, listRows}`，或 `null`（不能共用時由呼叫端走兩趟）。
 * 這裡只建述詞與跑一次掃描，**不改變任何一邊的述詞**：
 *   stats 側＝`prepareStatsScope()`（與 `loadInputs` 內逐字相同的順序與述詞）
 *   list  側＝`prepareListScope()`（與 `searchListingsNodePgInner` 內逐字相同）
 */
async function prepareOnePassScan({args, statsArgs, common, pgDriver}) {
  const {requestContext} = common;
  const exec = (sql, params = [], {batch = false, arrayRows = false} = {}) => batch
    ? readPgRows(pgDriver, toPostgresSql(sql), params, {arrayRows})
    : pgDriver.query(toPostgresSql(sql), params).then(r => r.rows);
  const uid = Number(args.userId) || 0;
  const voteUid = args.matchVoteUserId == null ? uid : Number(args.matchVoteUserId) || 0;
  const settings = statsArgs.settings || requestContext.settingsForUser(uid);
  const statsScope = await prepareStatsScope(listingStatsBuildContext(), {
    searchKeys: statsArgs.searchKeys, settings, requestContext, run: exec,
  });
  const listScope = await prepareListScope(exec, args, {settings, context: requestContext, uid, voteUid});
  // B（2026-10-12）：共趟掃描的時間**另外**記成一個新鍵 `scan_ms`（→ `Server-Timing` 的
  // `scan;dur`）。它先前只以「總和」的形式躲在 `statsPrepareMs`（scope 準備 ＋ 共趟掃描）裡，
  // 讓 `stats;dur` 看起來像大頭；實際上掃描才是（見 listingStageTiming.js 的契約註解）。
  // ⚠️ 這裡**只新增鍵**：`statsPrepareMs`／`stats_ms`／`query_ms` 的算式與數字都不動
  // （測試 v3/test/listing-server-timing.test.js 逐項固定住這件事）。
  const scanStarted = performance.now();
  const scanned = await runScopeScan(pgDriver, {
    candidateColumns: listingStatsBuildContext().candidateColumns,
    statsScope: {clauses: statsScope.clauses, params: statsScope.params},
    listScope: {clauses: listScope.built.clauses, params: listScope.built.params},
  });
  // 掃不到（述詞不共用前綴 ⇒ 呼叫端走原本兩趟）時不記：那時沒有「共趟掃描」，記 0 會說謊。
  if (scanned && statsArgs.diagnostics) {
    statsArgs.diagnostics.scan_ms = Math.round(performance.now() - scanStarted);
  }
  if (!scanned) return null;
  return {statsScope, statsRows: scanned.statsRows, listScope, listRows: scanned.listRows};
}

async function computeListingPage(args = {}, driver = 'sqlite', options = {}) {
  const started = performance.now();
  const run = async (pgDriver = null) => {
    const requestContext = driver === 'postgres'
      ? await buildListRequestContextFromPg((sql,params=[])=>pgDriver.query(toPostgresSql(sql),params).then(r=>r.rows),{asOf:args.asOf,resolvedSearchKeys:args.searchKeys})
      : null;
    const common = {driver, pgDriver, requestContext};
    // 第三刀（2026-10-11）：**一個請求一個裝飾資料載入器**。list 與 stats 兩條管線原本各自
    // 建立自己的 loader ⇒ 個人旗標／路由快取／MRT／listing_prep 等輔助讀取同一份資料查兩次
    //（同一條 SQL、同一組參數）。共用之後由 loader 的 per-id／per-key 快取吸收重疊集合，
    // 回傳值逐字相同（同一份述詞與同一份列），只是少掉重複的往返。
    const decorationLoader = driver === 'postgres'
      ? createDecorationDataLoader({
        exec: (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then(r => r.rows),
        driver: 'postgres',
      })
      : null;
    if (decorationLoader) common.decorationLoader = decorationLoader;
    const statsDetails={};
    const statsArgs={searchKeys:args.searchKeys,userId:args.userId,
      settings:args.settings,asOf:args.asOf,diagnostics:statsDetails};
    let statsPrepareMs=0;
    if(driver==='postgres') {
      const before=performance.now();
      if (onePassEnabled()) {
        // A 方案（2026-10-11 第二刀）：先備好 list／stats 兩份範圍，再用**同一趟掃描**取候選，
        // 一列同時帶 `in_list_scope`／`in_stats_scope` 兩個旗標，兩邊各自只取自己那一側。
        // 掃不到（述詞不共用前綴）就回 null，下面走原本的兩趟（語意逐字不變）。
        const onePass = await prepareOnePassScan({args, statsArgs, common, pgDriver});
        if (onePass) {
          common.scope = onePass.listScope;
          common.candidates = onePass.listRows;
          common.preloadedStatsInputs = await loadPgListingStatsInputs(statsArgs, {
            ...common, scope: onePass.statsScope, scopeRows: onePass.statsRows,
          });
        }
      }
      if (!common.preloadedStatsInputs) {
        common.preloadedStatsInputs=await loadPgListingStatsInputs(statsArgs,common);
        common.reusableCandidates=common.preloadedStatsInputs.rows;
      }
      statsPrepareMs=performance.now()-before;
      statsDetails.inputs_ms=Math.round(statsPrepareMs);
    }
    const listed = await searchListingsAsync(args, common);
    const queryMs = performance.now()-started-statsPrepareMs;
    const statsStarted=performance.now();
    const stats=await listingStatsAsync(statsArgs,common);
    return {
      // 通勤計數與 list 同一個請求快照（`listed.queryDetails`），零額外查詢：讓使用者看得懂
      // 「為什麼這個行政區是 0 筆」——不是沒有資料，而是被通勤條件擋掉（Owner 裁決 2026-10-12）。
      stats:{...stats,matched:listed.totalMatched,
        excludedByCommute:Number(listed.queryDetails?.commute_excluded)||0,
        commutePending:Number(listed.queryDetails?.commute_pending)||0},listings:listed.listings,
      hasMore:listed.hasMore===true,nextOffset:listed.nextOffset||0,
      nextCursor:listed.nextCursor||null,queryVersion:listed.queryVersion||2,
      timing:{query_ms:queryMs,stats_ms:statsPrepareMs+performance.now()-statsStarted,total_ms:performance.now()-started,
        dataset:listed.totalMatched,stages:listed.queryDetails,stats_stages:statsDetails},
    };
  };
  if(driver!=='postgres') return run();
  try {
    const pgDriver=options.pgDriver || await sharedPgDriver();
    // 會員列表的**唯讀快照**：`PG_RO_URL` 有值且該會員最近沒有寫入時走待機節點；未設則走原路。
    // 這是唯一一條允許 `PG_RO_URL` 的路（見 v3/src/pgReadReplica.js 的契約註解）。
    return await withPgReadSnapshot(pgDriver, run, {
      memberReadSnapshot: true,
      userId: Number(args.userId) || 0,
    });
  } catch(error) {
    // 唯讀快照的寫入守門要**原樣**往外丟：包成 SEARCH_UNAVAILABLE 會把可判讀的訊息埋掉。
    if(isReadOnlySnapshotViolation(error)) throw error;
    if(isListingSearchUnavailable(error)) throw error;
    throw new ListingSearchUnavailableError(error);
  }
}
