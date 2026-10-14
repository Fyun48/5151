// Listing-stats repository (PostgreSQL hot path, the cutover blocker of the switch plan).
//
// db.js `stats()` answers the list-page counters by scanning the member's candidate rows
// through SQLite. With DB_DRIVER=postgres that produced a page with items and counters that
// said zero, because the counters still described the (empty) SQLite store
// (v3/evidence/pg-rw-drill-20260921/README.md, gap 1). The counters therefore have to be read
// from the same store the list itself reads.
//
// This module restates the reads that make up those counters against an injected
// `exec(sql, params, { one })` executor (which translates `?` -> `$n`, exactly like the
// listings repository does). Every statement fragment comes from the dependency bundle
// db.js publishes as `listingStatsBuildContext()`: the clause builders are the ones the
// search path already uses and the row pipeline is the pure half of `stats()`, so a filter
// or a counter can never drift between the list and its counters.
import { runStepsAsync, transformChunks } from "../cooperative.js";
import { numberFromPg } from "../dbDriverPostgres.js";
import { toPostgresSql } from "../sqlDialect.js";
import { buildListRequestContextFromPg } from "../db.js";
import { appendDistrictProjectedCandidates } from "../listDistrictSql.js";
import { loadDistrictPrefilterIds } from "../listingDistrictPrefilter.js";
import { listingTotalsOrNull } from "../listingTotalsPgCounter.js";
import { WATCHED_COUNT_SQL, WATCHED_COUNT_SQL_LEGACY } from "../watchLimits.js";
import { loadPersonalFlagMap } from "./decorationData.js";
import { LIST_CANDIDATE_COLUMNS } from "../listingCandidateRow.js";

// SQLite hands these back as numbers, node-postgres as strings (int8). The stats pipeline
// compares them numerically or truthily (`!row.viewed`, `row.offline`, `row.hidden`), so they
// are normalised at the boundary - the same treatment repository/decorationData.js gives cards.
export const STATS_CANDIDATE_NUMERIC_KEYS = [
  "post_id",
  "price_num",
  "extra_fee",
  "hidden",
  "offline",
  "offline_confirmed",
  "match_post_id",
  "match_rejected",
  "contact_uid",
  "listed_by_user_id",
];

const REQUIRED_DEPS = [
  "resolveUserId",
  "getSettings",
  "searchWhere",
  "listingVisibilityClauses",
  "appendDistrictCandidates",
  "appendPriceCeilingCandidates",
  "memberRegionDistrictNames",
  "candidateColumns",
  "buildListingStatsRows",
  "summarizeListingStats",
];

export function assertListingStatsDeps(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (deps[name] == null || deps[name] === "") {
      throw new Error(`createListingStatsRepository requires deps.${name}`);
    }
  }
  return true;
}

export function normalizeStatsCandidateRow(row) {
  if (!row) return row;
  // Fixed property reads keep the common already-numeric PG shape monomorphic.
  // Preserve missing/inherited fields and the original conversion for text schemas.
  if (row.post_id != null && typeof row.post_id !== "number" && Object.hasOwn(row, "post_id")) row.post_id = numberFromPg(row.post_id);
  if (row.price_num != null && typeof row.price_num !== "number" && Object.hasOwn(row, "price_num")) row.price_num = numberFromPg(row.price_num);
  if (row.extra_fee != null && typeof row.extra_fee !== "number" && Object.hasOwn(row, "extra_fee")) row.extra_fee = numberFromPg(row.extra_fee);
  if (row.hidden != null && typeof row.hidden !== "number" && Object.hasOwn(row, "hidden")) row.hidden = numberFromPg(row.hidden);
  if (row.offline != null && typeof row.offline !== "number" && Object.hasOwn(row, "offline")) row.offline = numberFromPg(row.offline);
  if (row.offline_confirmed != null && typeof row.offline_confirmed !== "number" && Object.hasOwn(row, "offline_confirmed")) row.offline_confirmed = numberFromPg(row.offline_confirmed);
  if (row.match_post_id != null && typeof row.match_post_id !== "number" && Object.hasOwn(row, "match_post_id")) row.match_post_id = numberFromPg(row.match_post_id);
  if (row.match_rejected != null && typeof row.match_rejected !== "number" && Object.hasOwn(row, "match_rejected")) row.match_rejected = numberFromPg(row.match_rejected);
  if (row.contact_uid != null && typeof row.contact_uid !== "number" && Object.hasOwn(row, "contact_uid")) row.contact_uid = numberFromPg(row.contact_uid);
  if (row.listed_by_user_id != null && typeof row.listed_by_user_id !== "number" && Object.hasOwn(row, "listed_by_user_id")) row.listed_by_user_id = numberFromPg(row.listed_by_user_id);
  return row;
}

// watchLimits.countWatched() through the executor (the `IFNULL` is translated for PostgreSQL).
//
// Owner 2026-10-14：使用量改成「疑似同屋源的群整群算 1 次」，分組鍵是 `listings.fold_component_root`
// ——那一欄只跟著 migration 007（PG；SQLite 一向沒有）⇒ 欄位還沒部署的庫跑新口徑會丟 42703。
// 這時退回改動前那一句（`WATCHED_COUNT_SQL_LEGACY`，同樣只算未確認下架、孤兒不計），
// 而不是讓列表頁的 `watchedTotal` 直接爆掉。
async function countWatchedListings(runOne, uid) {
  const id = Number(uid) || 0;
  if (!id) return 0;
  try {
    const row = await runOne(WATCHED_COUNT_SQL, [id]);
    return Number(row?.n) || 0;
  } catch {
    const row = await runOne(WATCHED_COUNT_SQL_LEGACY, [id]);
    return Number(row?.n) || 0;
  }
}

// db.js productListingCount() (P1-18: member-visible totals never reveal a Stage 1 fixture).
//
// 這一支原本是**每個請求**一次 `COUNT(*) FROM listings WHERE <isolation>`：正式庫實測 418ms，
// 而且它與候選查詢無關（只取決於隔離條件與資料版本）。改用既有的 **data_revision 版本化**
// 手法（同 v3/src/db.js 的 `storedSearchKeysFromPg`）：`MAX(data_revision.id)` 換代才重算。
//
// fail-soft 契約與 db.js 同款：`data_revision` 不存在、是空表（MAX(id) IS NULL）或查詢失敗時
// **一律不緩存**、每次現讀 —— 沒有可靠版本號就不做跨請求快取，避免把第一個請求的答案沿用下去。
//
// ⚠️ 2026-10-11 第三刀（P2）評估過 planner 的 (c)「≤60 秒 TTL」並**實作後撤回**：
//   `v3/test/listing-stats-product-count.test.js:61`（「同一個 data_revision 只 COUNT 一次，
//   換代後重算」）明確要求「revision 換代就必須重算」，而正式庫的爬蟲讓 revision **每個請求都在
//   前進** ⇒ 任何 TTL 都會讓「換代就重算」失效。放寬這條契約屬於產品決策（見證據包 §4 待裁決點 2），
//   不是實作細節，所以在拿到裁決前維持原本的版本號語意。
let pgProductCountCache = { revision: null, isolation: null, count: null };

/** 測試／寫入端需要主動失效時用（與 db.js 的 resetStoredSearchKeysFromPg 同形狀）。 */
export function resetPgProductCountCache() {
  pgProductCountCache = { revision: null, isolation: null, count: null };
}

async function currentDataRevision(runOne) {
  try {
    const hasTable = await runOne("SELECT to_regclass('data_revision') IS NOT NULL AS has_table");
    if (!hasTable?.has_table) return null;
    const row = await runOne("SELECT MAX(id) AS n FROM data_revision");
    if (row?.n == null) return null;
    const revision = Number(row.n);
    return Number.isFinite(revision) ? revision : null;
  } catch {
    return null;
  }
}

/**
 * `dbTotal` 的來源（三層，依序）：
 *
 *   ① **同交易維護的精準計數器**（`listing_totals_counter`，寫入端在入庫的同一個交易維護；
 *      見 `listingTotalsPgCounter.js`／`listingTotalsPgWrite.js`）——正式站單請求窗口實測
 *      這條 COUNT 每個請求 1 次／99.6–215.2ms，而`data_revision` 被爬蟲推著每秒換代，
 *      版本化快取從未命中，所以計數器才是這條熱路徑的解。
 *   ② 舊的 `data_revision` 版本化快取（計數器不可用時的**第一層**退化，行為逐字不變）。
 *   ③ 每次現讀的真 `COUNT(*)`（最終 fail-safe）。
 *
 * 任一層回不出「可信的精準值」就往下退——**讀取路徑永遠要能回正確數字**。
 * 計數器只可能因為「可用旗標為 0／列不存在／查詢失敗／述詞不支援」而不可用；
 * 這些情形一律當成「不可信」，不會拿殘值湊答案。
 */
async function countProductListings(runOne, requestContext, { runRows = null, diagnostics = null } = {}) {
  const isolation = requestContext?.isolation;
  if (!isolation) throw new Error("PG stats require isolation context");
  const started = performance.now();
  const markTotal = () => {
    if (diagnostics) diagnostics.db_total_ms = Math.round(performance.now() - started);
  };
  // ① 同交易維護的精準計數器（讀在**同一條快照**上；對帳由行程背景負責，不在這裡）。
  const counted = await listingTotalsOrNull({ exec: runRows || runOne, isolation, onDiagnostics: diagnostics });
  if (counted != null) {
    markTotal();
    return counted;
  }
  // ② 舊的 data_revision 版本化快取（計數器不可用時的第一層退化，行為逐字不變）。
  const revision = await currentDataRevision(runOne);
  if (revision != null && pgProductCountCache.revision === revision && pgProductCountCache.isolation === isolation.sql) {
    if (diagnostics && diagnostics.db_total_source == null) diagnostics.db_total_source = "revision-cache";
    markTotal();
    return pgProductCountCache.count;
  }
  // ③ 最終 fail-safe：每次現讀的真 COUNT。
  if (diagnostics && diagnostics.db_total_source == null) diagnostics.db_total_source = "count";
  const row = await runOne(`SELECT COUNT(*) AS n FROM listings WHERE ${isolation.sql}`, isolation.params);
  const count = Number(row?.n) || 0;
  if (revision != null) pgProductCountCache = { revision, isolation: isolation.sql, count };
  markTotal();
  return count;
}

/**
 * 本請求的「stats 範圍」準備（**述詞與順序與 `loadInputs` 內逐字相同**）。
 *
 * 為什麼要抽出來（2026-10-11 第二刀・A 方案）：`computeListingPage` 必須在**掃描之前**同時
 * 拿到 list 與 stats 兩份 WHERE，才能用同一趟掃描 `(stats_where) OR (list_where)` ＋
 * `in_list_scope` 旗標，取代「stats 掃一次寬候選 → list 再下一次 id-only」的兩趟。
 *
 * `baseClauses`／`baseParams` 是**行政區與價格天花板之前**的那兩條（`searchWhere` ＋
 * `listingVisibilityClauses`）——`statusCounts` 那條聚合查詢用的正是它們（不得被縮窄）。
 */
export async function prepareStatsScope(context, { searchKeys, settings, requestContext, run } = {}) {
  const baseClauses = [];
  const baseParams = [];
  context.searchWhere(searchKeys, baseClauses, baseParams, requestContext);
  context.listingVisibilityClauses(baseClauses, baseParams, requestContext, { sqliteDb: null });
  const clauses = [...baseClauses];
  const params = [...baseParams];
  // 行政區投影預篩（與會員列表同一條）：`memberRegionDistrictNames` 是同一份清單，
  // 拿得到投影就用 `post_id = ANY(...)`，拿不到就退回 `split_part` 表達式（不得靜默少算）。
  const districtNames = context.memberRegionDistrictNames(settings);
  const districtPrefilter = await loadDistrictPrefilterIds(run, { districtNames });
  const projectedDistrictHandled = appendDistrictProjectedCandidates(
    districtNames, clauses, params,
    { driver: "postgres", projectedIds: districtPrefilter ? districtPrefilter.postIds : null },
  );
  if (!projectedDistrictHandled) {
    context.appendDistrictCandidates(districtNames, clauses, params, { driver: "postgres" });
  }
  context.appendPriceCeilingCandidates(settings, clauses, params, { driver: "postgres" });
  return {
    baseClauses, baseParams, clauses, params,
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    districtNames, districtPrefilter,
  };
}

export function createListingStatsRepository({
  driver = "postgres",
  pgDriver = null,
  exec = null,
  deps = null,
} = {}) {
  assertListingStatsDeps(deps || {});
  const context = deps;
  const run = exec || (async (sql, params = [], { one = false } = {}) => {
    if (!pgDriver) throw new Error("createListingStatsRepository(postgres) requires pgDriver or exec");
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return one ? res.rows[0] ?? null : res.rows;
  });
  // An injected `exec` follows the convention of the other repositories (it resolves to the row
  // array), so a single-row read has to unwrap here rather than relying on the third argument.
  const runOne = async (sql, params = []) => {
    const res = await run(sql, params, { one: true });
    return Array.isArray(res) ? res[0] ?? null : res ?? null;
  };
  // 同一支執行器（＝同一條快照連線／同一組參數轉譯）的「回列陣列」版本：`dbTotal` 的計數器
  // 要跟候選列來自**同一個 snapshot**，所以它讀的是這一個，而不是另外開一條連線。
  const runRows = async (sql, params = []) => {
    const res = await run(sql, params);
    return Array.isArray(res) ? res : (res?.rows || []);
  };

  return {
    driver,
    /**
     * Reads every input `summarizeListingStats()` needs: the candidate rows (with the personal
     * flag map they get overlaid with), the offline counters, the watch quota, the
     * product-visible total and the failed route jobs.
     */
    async loadInputs({ searchKeys, userId, settings: settingsOverride, diagnostics, requestContext: providedContext = null, asOf = null, scope: providedScope = null, scopeRows = null, loader = null } = {}) {
      let stageStarted = performance.now();
      const markStage = name => {
        const now = performance.now();
        if (diagnostics) diagnostics[name] = Math.round(now - stageStarted);
        stageStarted = now;
      };
      const requestContext = providedContext || await buildListRequestContextFromPg(run, {asOf,resolvedSearchKeys:searchKeys});
      const uid = Number(userId) || 0;
      const settings = settingsOverride || requestContext.settingsForUser(uid);
      // A 方案：呼叫端已經用同一趟掃描算好 stats 範圍與該範圍的列時，沿用同一份述詞與結果
      // （`prepareStatsScope` 與下面那一段是逐字相同的順序與述詞）。
      const scope = providedScope || await prepareStatsScope(context, { searchKeys, settings, requestContext, run });
      const clauses = scope.baseClauses;
      const params = scope.baseParams;
      // Same order and the same statements as db.js stats(): the offline counters describe the
      // shared search pool (districts/price not narrowed yet), the candidates get everything.
      const statusWhere = `WHERE ${[...clauses, "COALESCE(offline, 0) != 0"].join(" AND ")}`;
      const statusRow = await runOne(
        `SELECT
    SUM(CASE WHEN COALESCE(offline, 0) != 0 AND COALESCE(offline_confirmed, 0) = 0 THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN COALESCE(offline, 0) != 0 AND COALESCE(offline_confirmed, 0) != 0 THEN 1 ELSE 0 END) AS confirmed
    FROM listings ${statusWhere}`,
        params,
      );
      markStage("status_ms");
      markStage("district_ms");
      const raw = Array.isArray(scopeRows)
        ? scopeRows
        : await run(`SELECT ${context.candidateColumns} FROM listings ${scope.where}`, scope.params, {batch: true, arrayRows: true});
      markStage("candidates_ms");
      const rows = await runStepsAsync(transformChunks(raw || [], chunk => chunk.map(normalizeStatsCandidateRow)), {label:"stats.normalize"});
      markStage("normalize_ms");
      // 第三刀（2026-10-11）：同一個請求的 list 管線已經載過同一份個人旗標時沿用它的載入器
      //（同一條 SQL、同一組參數、同一個請求）⇒ 這一段不再多一次往返。沒有共用載入器時
      // 逐字走原本的 `loadPersonalFlagMap`。
      const flagMap = loader ? await loader.personalFlagMap(uid) : await loadPersonalFlagMap(run, uid);
      const watchedTotal = await countWatchedListings(runOne, uid);
      const dbTotal = await countProductListings(runOne, requestContext, { runRows, diagnostics });
      const failedRouteJobs = new Set(
        (await run("SELECT job_key FROM route_jobs WHERE job_state = 'failed'")).map((row) => row.job_key),
      );
      markStage("auxiliary_ms");
      if (diagnostics) {
        diagnostics.driver = "postgres";
        diagnostics.candidates = rows.length;
      }
      return { uid, settings, rows, flagMap, requestContext, statusCounts: statusRow || {}, watchedTotal, dbTotal, failedRouteJobs,
        candidateShape: context.candidateColumns === LIST_CANDIDATE_COLUMNS };
    },
  };
}
