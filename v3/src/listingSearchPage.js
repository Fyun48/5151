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

// ── 計時口徑（2026-10-12 拆歸因；教訓 L-0731／L-0859／L-0745）──────────────────────────────
// 這一版把 `stats;dur` 的**歸因**修對：只改計時包裝，不動任何查詢、篩選語意或回傳結構。
//
// 問題：`statsPrepareMs` 的窗從 `prepareOnePassScan()` 的第一個 await 走到
// `loadPgListingStatsInputs()` 結束，而那個窗的**中段**夾著 list 側的前置工作
// `prepareListScope()`（行政區閉包／種子述詞）。於是 `stats_ms = statsPrepareMs + 收尾`
// 報出來的數字有一部分不是 stats 自己的成本，優化照著打會打錯地方。
//
// 拆完之後，每個欄位各含什麼（跨版本對帳時必須連欄位定義一起引用，數字才有意義）：
//   * `list;dur`（＝`query_ms`）＝ **list 側的總成本**：`prepareListScope()` ＋
//     `searchListingsAsync()` 整條 list 管線（`prepare`／`cand`／`filter`／`rows` 在
//     `timing.stages` 裡逐段可讀）。本版起它比舊版**多含** `list_prepare_ms`——那段時間在舊版
//     兩邊都沒被算到（漏帳），現在補回它該在的一側；`list` 這個名字與子階段鍵都不變。
//   * `stats;dur`（＝`stats_ms`）＝ **只含 stats 自己的工作**：stats 側 scope 準備＋一趟掃描
//     （`scan_ms`）＋ `listingStatsAsync()` 的計數收尾。**不含** `prepareListScope()`。
//     ⚠️ 口徑變更：`STATS_MS_TARGET_MS`（800ms；D-0036 的「stats ≤ 1.0s」同理）從本版起一律指
//     **這個拆乾淨後的 stats**；拿舊版的 `stats;dur` 去比會誤判成退步（L-0745）。
//   * `stats_prepare;dur`（＝`stats_stages.inputs_ms`）＝ 那個「準備窗」的**總長度**（含
//     `scan_ms` 與 list 側前置，因為它是窗的長度、不是某人自己的成本）。這一格刻意不變：
//     既有量測腳本與前端讀的就是它，改掉會讓歷史對帳全亂。
//   * `scan;dur`（＝`stats_stages.scan_ms`）＝ `runScopeScan()` 那一趟共趟掃描，**仍含在
//     `stats_prepare` 的窗裡**，且刻意不從任何 metric 扣除（當時的契約，見 listingStageTiming.js）。
//   * `stats_stages.list_prepare_ms`（＝**本版新增**的鍵）＝ `prepareListScope()` 自己的耗時。
//     它同時被 `list;dur` 收進去，所以沒有任何時間消失；現身後才看得見「list 側前置多少 ms」
//     與「stats 自己多少 ms」。⚠️ 它**只**出現在 payload 的 `timing.stats_stages`
//     （窗口量測腳本讀的就是這一層）；`Server-Timing` 的 metric 名對照表在
//     `listingStageTiming.js`，該檔屬於另一包的範圍 ⇒ 本包不新增 `list_prepare;dur` 這個標頭度量。
// 不變量：`list_ms + stats_ms` 在改動前後**逐字相同**（`attributeListingTiming()` 的契約）；
// 本版**只有** `stats;dur` 與 `list;dur` 兩個數字的歸屬改變，其餘每一個欄位逐字不變。
//
// 要拆得乾淨，進 `stats_ms` 的準備量必須是「只屬 stats 的窗」⇒ `prepareOnePassScan()` 回報
// `statsOwnMs`（stats scope 準備＋共趟掃描）與 `listPrepareMs`（list 側前置），呼叫端再加上
// 載入 stats 輸入那一段；`list_prepare_ms` 因此不會再被算進 stats。

/** `stats;dur` 的目標值（毫秒）；本版起指**拆乾淨後**的 stats 自己（不含 list 側前置）。 */
const STATS_MS_TARGET_MS = 800;

/**
 * 把一個請求的計時**拆對**（純函式、可注入時序 ⇒ 測試不必靠真 DB 的噪音）。
 *
 * 輸入全部是「已經量好的毫秒數」：
 *   * `statsPrepareMs`：**舊口徑**的準備窗長度（stats scope ＋ `prepareListScope` ＋ 掃描 ＋ 載入）。
 *   * `listPrepareMs`：上述窗裡屬於 list 側的 `prepareListScope()`（`null`／`undefined`／非數值＝沒有）。
 *   * `listElapsedMs`：扣掉整個準備窗之後、list 管線（`searchListingsAsync`）的耗時。
 *   * `statsElapsedMs`：`listingStatsAsync()` 的收尾耗時。
 *
 * 契約：`queryMs + statsMs === (statsPrepareMs + listElapsedMs + statsElapsedMs)`——與舊口徑
 * 的 `query_ms + stats_ms` **逐字相同**。差別只在歸屬：`prepareListScope()` 從 stats 搬到 list。
 */
export function attributeListingTiming({statsPrepareMs = 0, listPrepareMs = 0, listElapsedMs = 0, statsElapsedMs = 0} = {}) {
  const listPrepare = numOr(listPrepareMs);
  return {
    listPrepareMs: listPrepare,
    // stats 自己＝準備窗扣掉 list 側前置（負值不可能發生，夾 0 以免 header 說謊）。
    // ⚠️ 減法要在 `numOr()` **之前**做：`numOr()` 會把負數夾成 0，先夾就等於沒扣到。
    statsMs: Math.max(0, numOr(statsPrepareMs) - listPrepare) + numOr(statsElapsedMs),
    // list 側總成本＝list 管線 ＋ list 側前置。
    queryMs: numOr(listElapsedMs) + listPrepare,
  };
}

function numOr(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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
  // 逐段記時（2026-10-12 拆歸因）：這裡的三段成本**不同人**，呼叫端要用它們把窗分乾淨：
  //   `statsOwnMs`    → stats 自己（stats scope ＋ 共趟掃描）→ 進 `stats;dur`
  //   `listPrepareMs` → list 側前置 → 搬到 `list;dur`，並以新鍵 `list_prepare_ms` 現身
  //   `windowMs`      → 整個準備窗的長度 → 這是 `stats_prepare;dur`（`inputs_ms`）的舊口徑，
  //                     必須逐字不變（runbook member-listing-onepass-and-window-queries.md §2
  //                     記的就是這個窗），所以它是**另外量**的，不是拿上面兩段湊。
  let statsOwnMs = 0;
  let listPrepareMs = 0;
  const windowStarted = performance.now();
  const statsScopeStarted = windowStarted;
  const statsScope = await prepareStatsScope(listingStatsBuildContext(), {
    searchKeys: statsArgs.searchKeys, settings, requestContext, run: exec,
  });
  statsOwnMs += performance.now() - statsScopeStarted;
  const listPrepareStarted = performance.now();
  const listScope = await prepareListScope(exec, args, {settings, context: requestContext, uid, voteUid});
  listPrepareMs = performance.now() - listPrepareStarted;
  // 新 stage：`prepareListScope()`（list 側前置）自己的耗時。同 `scan_ms` 的形狀——只新增鍵、
  // 不從任何既有 metric 扣除；缺鍵比寫 0 誠實（沒跑到就沒有這一段）。
  if (statsArgs.diagnostics) {
    statsArgs.diagnostics.list_prepare_ms = Math.round(listPrepareMs);
  }
  // B（2026-10-12）：共趟掃描的時間**另外**記成一個新鍵 `scan_ms`（→ `Server-Timing` 的
  // `scan;dur`），並留在 stats 自己那一側（掃描是 stats 候選的來源）。
  // ⚠️ 這裡**只新增鍵**：`stats_prepare;dur`（`inputs_ms`）仍是整個準備窗的長度，數字不動。
  const scanStarted = performance.now();
  const scanned = await runScopeScan(pgDriver, {
    candidateColumns: listingStatsBuildContext().candidateColumns,
    statsScope: {clauses: statsScope.clauses, params: statsScope.params},
    listScope: {clauses: listScope.built.clauses, params: listScope.built.params},
  });
  statsOwnMs += performance.now() - scanStarted;
  const windowMs = performance.now() - windowStarted;
  // 掃不到（述詞不共用前綴 ⇒ 呼叫端走原本兩趟）時不記：那時沒有「共趟掃描」，記 0 會說謊。
  if (scanned && statsArgs.diagnostics) {
    statsArgs.diagnostics.scan_ms = Math.round(performance.now() - scanStarted);
  }
  if (!scanned) return null;
  // `windowMs`＝整個準備窗（→ `stats_prepare;dur`／`inputs_ms`，數字與舊版逐字相同）；
  // `statsOwnMs`＝**只屬 stats** 的兩段（scope 準備＋共趟掃描）；`listPrepareMs`＝list 側前置。
  // 載入 stats 輸入（呼叫端那一段）不在此函式內，由呼叫端自行計時並歸到 stats 自己。
  return {statsScope, statsRows: scanned.statsRows, listScope, listRows: scanned.listRows, statsOwnMs, listPrepareMs, windowMs};
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
    // 準備窗裡**只屬 stats 自己**的量（stats scope 準備＋共趟掃描＋載入 stats 輸入）。
    // `stats_ms` 用它；它與 `listPrepareMs` 互斥，兩者相加＝舊準備窗（帳不會漏）。
    let statsOwnMs=0;
    // list 側前置（＝`prepareOnePassScan()` 裡的 `prepareListScope()`）；沒跑到就是 0。
    let listPrepareMs=0;
    if(driver==='postgres') {
      if (onePassEnabled()) {
        // A 方案（2026-10-11 第二刀）：先備好 list／stats 兩份範圍，再用**同一趟掃描**取候選，
        // 一列同時帶 `in_list_scope`／`in_stats_scope` 兩個旗標，兩邊各自只取自己那一側。
        // 掃不到（述詞不共用前綴）就回 null，下面走原本的兩趟（語意逐字不變）。
        const before=performance.now();
        const onePass = await prepareOnePassScan({args, statsArgs, common, pgDriver});
        if (onePass) {
          common.scope = onePass.listScope;
          common.candidates = onePass.listRows;
          // list 側前置現身（上面已寫進 `statsDetails.list_prepare_ms`）。
          listPrepareMs = onePass.listPrepareMs;
          statsOwnMs = onePass.statsOwnMs;
          const loadStarted=performance.now();
          common.preloadedStatsInputs = await loadPgListingStatsInputs(statsArgs, {
            ...common, scope: onePass.statsScope, scopeRows: onePass.statsRows,
          });
          // 載入 stats 輸入是 stats 自己的工作 ⇒ 留在 stats 這一側（舊 `statsPrepareMs` 也含它）。
          statsOwnMs += performance.now()-loadStarted;
        }
        // 窗的長度（`stats_prepare;dur`／`inputs_ms`）＝呼叫端自己量，與舊版逐字相同。
        statsPrepareMs=performance.now()-before;
        // 兩趟退回路徑沒有 list 側前置（`prepareListScope` 沒跑到）⇒ 整個窗都算 stats 自己。
        if (!onePass) statsOwnMs = statsPrepareMs;
      }
      if (!common.preloadedStatsInputs) {
        common.preloadedStatsInputs=await loadPgListingStatsInputs(statsArgs,common);
        common.reusableCandidates=common.preloadedStatsInputs.rows;
      }
      statsDetails.inputs_ms=Math.round(statsPrepareMs);
    }
    const listed = await searchListingsAsync(args, common);
    // 扣掉整個準備窗＝list 管線的耗時（舊口徑的 `query_ms` 就是這樣算的）。
    const listElapsedMs = performance.now()-started-statsPrepareMs;
    const statsStarted=performance.now();
    const stats=await listingStatsAsync(statsArgs,common);
    // 歸因（見檔頭「計時口徑」）：`stats_ms` 只含 stats 自己（扣掉 list 側前置），
    // `query_ms`（＝`list;dur`）把那段前置收進去 ⇒ 兩者相加與舊口徑逐字相同。
    const attributed = attributeListingTiming({
      statsPrepareMs: driver==='postgres' ? statsOwnMs : statsPrepareMs,
      listPrepareMs,
      listElapsedMs,
      statsElapsedMs: performance.now()-statsStarted,
    });
    return {
      // 通勤計數與 list 同一個請求快照（`listed.queryDetails`），零額外查詢：讓使用者看得懂
      // 「為什麼這個行政區是 0 筆」——不是沒有資料，而是被通勤條件擋掉（Owner 裁決 2026-10-12）。
      stats:{...stats,matched:listed.totalMatched,
        excludedByCommute:Number(listed.queryDetails?.commute_excluded)||0,
        commutePending:Number(listed.queryDetails?.commute_pending)||0},listings:listed.listings,
      hasMore:listed.hasMore===true,nextOffset:listed.nextOffset||0,
      nextCursor:listed.nextCursor||null,queryVersion:listed.queryVersion||2,
      timing:{query_ms:attributed.queryMs,stats_ms:attributed.statsMs,total_ms:performance.now()-started,
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
