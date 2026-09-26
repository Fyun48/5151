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
import { districtClosureIds } from "./listingSearchNodePg.js";
import { createDecorationDataLoader } from "./repository/decorationData.js";
import { ListingSearchUnavailableError, isListingSearchUnavailable } from "./listingSearchAsync.js";

// Guest identity is always zero. Member flags, watch notes and supplied user IDs
// are never inputs to this pipeline, including when the caller has a session.
export async function searchPublicListingsAsync(input = {}, options = {}) {
  const args = { ...input, ...listingRequestTime(input.asOf) };
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return listPublicListingsFast(args);
  try {
    const pg = options.pgDriver || await sharedPgDriver();
    return await withPgReadSnapshot(pg, async snapshot => {
      const exec = (sql, params = []) => snapshot.query(toPostgresSql(sql), params).then(r => r.rows);
      const context = await buildListRequestContextFromPg(exec, { asOf: args.asOf });
      const settings = args.settings || publicSearchSettings(args);
      const districts = (Array.isArray(args.districts) ? args.districts : String(args.districts || "").split(","))
        .map(x => String(x).trim()).filter(Boolean).slice(0, GUEST_MAX_DISTRICTS);
      const districtIds = await districtClosureIds(exec, { districtNames: districts, userId: 0 });
      const built = buildPublicListingsClauses({ districts, settings, q: args.q, context, districtIds }, { sqliteDb: null });
      const raw = await readPgRows(snapshot, toPostgresSql(`SELECT ${listingSearchBuildContext().candidateColumns} FROM listings ${built.where} ORDER BY post_id`), built.params);
      const loader = createDecorationDataLoader({ exec, driver: "postgres" });
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
