import {
  buildListRequestContextFromPg, buildPublicListingsClauses, buildPublicListingsRowsAsync,
  decoratePublicListingsPage, GUEST_MAX_DISTRICTS, listingSearchBuildContext,
  listPublicListingsFast, preloadDecorationProviderAsync, publicSearchSettings,
} from "./db.js";
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { withPgReadSnapshot, readPgRows } from "./pgReadSnapshot.js";
import { listingRequestTime } from "./listingRequestTime.js";
import { toPostgresSql } from "./sqlDialect.js";
import { PUBLIC_LISTING_CANDIDATE_COLUMNS } from "./listingCandidateRow.js";
// closure 的進程內 TTL 記憶（策略 H-A）：與會員路徑**共用同一個實例**（鍵含 userId／relatedOnly，
// 訪客一律 userId: 0，不會與會員的鍵互串）。見 `listingClosureMemo.js` 的檔頭開關。
import { districtClosureIdsMemoized } from "./listingSearchNodePg.js";
import { createDecorationDataLoader } from "./repository/decorationData.js";
import { buildPublicListingsFoldSql } from "./listingSearchSql.js";
import { normalizeCrawlSources } from "./crawlSources.js";
import { ListingSearchUnavailableError, isListingSearchUnavailable } from "./listingSearchAsync.js";
import { foldSqlGateReady } from "./foldComponentRoot.js";

// 訪客 SQL-first 折疊（PUBLIC_LISTINGS_SQL_FIRST=1 才啟用，預設 off）。回傳完整結果或 null（外框外）。
//
// 閘門語意（Owner 2026-10-12 R3，fail-closed）：
//   • 關閘（預設）＝這裡第一行就 return null，**不碰任何折疊程式碼** ⇒ 新路徑壞掉不影響舊路徑。
//   • 開閘（`PUBLIC_LISTINGS_SQL_FIRST=1`）＝先做開閘前檢（`foldSqlGateReady`，跑在**本請求自己的
//     snapshot 連線**上）：欄位不存在或回填未驗證零差 ⇒ **丟 `ListingSearchUnavailableError`
//     （HTTP 503，code=SEARCH_UNAVAILABLE）並告警，絕不退回 Node 路徑**。
//   • 只有「外框外」（kind／sort／settings 表達不了）才是合法的 null ⇒ 走 Node 路徑。
async function tryPublicListingsSqlFirst({ exec, args, settings, districts, districtIds, context, loader }) {
  if (process.env.PUBLIC_LISTINGS_SQL_FIRST !== "1") return null;
  const gate = await foldSqlGateReady(exec);
  if (!gate.ok) {
    // 告警（結構化一行，便於日誌檢索）＋ 503。不是降級：降級會讓「清單看到的資料」與
    // 「固化欄的真相」無聲分裂，且讓依賴缺失永遠不會被發現（F2 的同一條原則）。
    console.error(`[fold-gate] PUBLIC_LISTINGS_SQL_FIRST=1 但依賴未就緒 ⇒ 503（不降級）: reason=${gate.reason} detail=${JSON.stringify(gate.detail)}`);
    throw new ListingSearchUnavailableError(`fold sql-first gate closed: ${gate.reason}`);
  }
  const enabledSources = normalizeCrawlSources(context.crawlSources.items).filter(x => x.enabled).map(x => x.id);
  const deps = { ...listingSearchBuildContext({ asOf: args.asOf }), resolveUserId: () => 0, visibilityContext: context };
  const built = buildPublicListingsFoldSql(
    { kind: args.kind || "", sources: args.sources || "", q: args.q || "", districts, districtIds: districtIds ?? null,
      sort: args.sort || "newest", settings, enabledSources, now: context.now },
    deps,
  );
  if (!built.ok) return null;
  const limit = Math.max(1, Math.min(Number(args.limit) || 40, 50));
  const start = Math.max(0, Number(args.offset) || 0);
  // 折疊查詢會做多次 hash/sort（cand UNION extras、edges self-join、winner 的 row_number），
  // 預設 work_mem(4MB) 會頻繁 spill 到 disk；提高到此交易內 64MB，避免 spill（repro 實測快 ~150ms）。
  await exec("SET LOCAL work_mem = '64MB'");
  // 單趟折疊：fold_role 標 MATERIALIZED、再物化 matched，count 用 scalar subquery 讀同一個
  // matched（fold 只跑一次），total 從該 subquery 取。
  const plan = built.pageWithCountQuery({ limit, offset: start });
  const rawPage = await exec(plan.sql, plan.params);
  const totalMatched = Number(rawPage[0]?.total_count) || 0;
  // 去掉 count 專用欄位，避免 total_count 經 decorateListingLite 的 `...row` 外洩到回應。
  const page = rawPage.map(({ total_count, ...row }) => row);
  const ids = page.map(row => Number(row.post_id));
  const fullRows = ids.length ? await exec("SELECT * FROM listings WHERE post_id = ANY(?::bigint[])", [ids]) : [];
  const pageProvider = await preloadDecorationProviderAsync({ exec, loader, rows: page, settings,
    userId: 0, matchVoteUserId: 0, requestContext: context });
  const listings = decoratePublicListingsPage(page, fullRows, { settings, provider: pageProvider,
    now: context.now, requireProvider: true });
  return { listings, totalMatched, hasMore: start + limit < totalMatched,
    nextOffset: start + limit, queryVersion: 2, guest: true,
    queryDetails: { engine: "sql_fold_pg", asOf: context.asOf, candidates: null } };
}

// Guest identity is always zero. Member flags, watch notes and supplied user IDs
// are never inputs to this pipeline, including when the caller has a session.
export async function searchPublicListingsAsync(input = {}, options = {}) {
  const args = { ...input, ...listingRequestTime(input.asOf) };
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return listPublicListingsFast(args);
  try {
    const pg = options.pgDriver || await sharedPgDriver();
    return await withPgReadSnapshot(pg, async snapshot => {
      const exec = (sql, params = [], {batch = false} = {}) => batch
        ? readPgRows(snapshot, toPostgresSql(sql), params)
        : snapshot.query(toPostgresSql(sql), params).then(r => r.rows);
      // 訪客路徑不建 searchKeys：searchWhere([]) 根本用不到（#694 加速包），
      // resolvedSearchKeys=[] 讓 buildSearchKeysFromPg 跳過 `SELECT DISTINCT search_key FROM listings`
      // 的全表掃描（~1s）。
      const context = await buildListRequestContextFromPg(exec, { asOf: args.asOf, resolvedSearchKeys: [] });
      const settings = args.settings || publicSearchSettings(args);
      const districts = (Array.isArray(args.districts) ? args.districts : String(args.districts || "").split(","))
        .map(x => String(x).trim()).filter(Boolean).slice(0, GUEST_MAX_DISTRICTS);
      const districtIds = await districtClosureIdsMemoized(exec, { districtNames: districts, userId: 0 });
      const loader = createDecorationDataLoader({ exec, driver: "postgres" });
      // SQL-first 折疊（預設 off；外框外回 null → 走 Node 路徑）。
      const sqlFirst = await tryPublicListingsSqlFirst({ exec, args, settings, districts, districtIds, context, loader });
      if (sqlFirst) return sqlFirst;
      const built = buildPublicListingsClauses({ districts, settings, q: args.q, context, districtIds }, { sqliteDb: null });
      const raw = await readPgRows(snapshot, toPostgresSql(`SELECT ${PUBLIC_LISTING_CANDIDATE_COLUMNS} FROM listings ${built.where} ORDER BY post_id`), built.params);
      const provider = await preloadDecorationProviderAsync({ exec, loader, rows: raw, settings,
        userId: 0, matchVoteUserId: 0, peers: false, foldGroups: true, requestContext: context });
      const rows = await buildPublicListingsRowsAsync(raw, { settings, kind: args.kind, sources: args.sources,
        sort: args.sort, districtSet: built.districtSet, provider, now: context.now, requireProvider: true });
      const limit = Math.max(1, Math.min(Number(args.limit) || 40, 50));
      const start = Math.max(0, Number(args.offset) || 0);
      const page = rows.slice(start, start + limit);
      const fullRows = page.length ? await exec("SELECT * FROM listings WHERE post_id = ANY(?::bigint[])", [page.map(row => row.post_id)]) : [];
      const pageProvider = await preloadDecorationProviderAsync({ exec, loader, rows: page, settings,
        userId: 0, matchVoteUserId: 0, requestContext: context });
      const listings = decoratePublicListingsPage(page, fullRows, { settings, provider: pageProvider,
        now: context.now, requireProvider: true });
      return { listings, totalMatched: rows.length, hasMore: start + limit < rows.length,
        nextOffset: start + limit, queryVersion: 2, guest: true,
        queryDetails: { engine: "node_pg", asOf: context.asOf, candidates: raw.length } };
    });
  } catch (error) {
    if (isListingSearchUnavailable(error)) throw error;
    throw new ListingSearchUnavailableError(error);
  }
}
