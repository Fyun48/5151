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
import { districtClosureIds } from "./listingSearchNodePg.js";
import { createDecorationDataLoader } from "./repository/decorationData.js";
import { buildPublicListingsFoldSql } from "./listingSearchSql.js";
import { normalizeCrawlSources } from "./crawlSources.js";
import { ListingSearchUnavailableError, isListingSearchUnavailable } from "./listingSearchAsync.js";

// 訪客 SQL-first 折疊（PUBLIC_LISTINGS_SQL_FIRST=1 才啟用，預設 off）。回傳完整結果或 null（外框外）。
async function tryPublicListingsSqlFirst({ exec, args, settings, districts, districtIds, context, loader }) {
  if (process.env.PUBLIC_LISTINGS_SQL_FIRST !== "1") return null;
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
      const districtIds = await districtClosureIds(exec, { districtNames: districts, userId: 0 });
      const loader = createDecorationDataLoader({ exec, driver: "postgres" });
      // SQL-first 折疊（預設 off；外框外回 null → 走 Node 路徑）。
      const sqlFirst = await tryPublicListingsSqlFirst({ exec, args, settings, districts, districtIds, context, loader });
      if (sqlFirst) return sqlFirst;
      const built = buildPublicListingsClauses({ districts, settings, q: args.q, context, districtIds }, { sqliteDb: null });
      const raw = await readPgRows(snapshot, toPostgresSql(`SELECT ${PUBLIC_LISTING_CANDIDATE_COLUMNS} FROM listings ${built.where} ORDER BY post_id`), built.params);
      const provider = await preloadDecorationProviderAsync({ exec, loader, rows: raw, settings,
        userId: 0, matchVoteUserId: 0, peers: false, requestContext: context });
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
