// Asynchronous listing-detail read (the read half of the cutover's "outer paths").
//
// db.js `getListing(postId, userId, options)` is a synchronous SQLite read: the row by id, the
// Stage 1 fixture visibility gate, the member's own flags and then the shared decorators. With
// the list served by PostgreSQL every detail surface still read the other store, so a listing
// that exists in PostgreSQL only would 404 (detail page, /go redirect from notifications,
// /api/listings/:id/history, the recheck and report-gone actions).
//
// This module runs the same three steps (visibility gate -> shared decorators) over a row read
// through the listings repository, so both drivers return the same object. With
// DB_DRIVER=sqlite it delegates to `getListing()` unchanged.
import {
  decorateRowsWithProvider,
  getListing,
  listingSearchBuildContext,
  preloadDecorationProviderAsync,
} from "./db.js";
import { LISTING_SURFACE, listingVisibleOnSurface } from "./stage1FixtureIsolation.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { createListingsRepository } from "./repository/listings.js";

// One pool for the process, shared with the list path and the write path.
import { sharedPgDriver } from "./pgSharedDriver.js";

export async function getListingAsync(postId, userId, options = {}) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return getListing(postId, userId, options);

  try {
    const id = Number(postId) || 0;
    if (!id) return undefined;
    const deps = options.deps || listingSearchBuildContext();
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    const exec = options.exec
      || ((sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows));
    const repository = options.repository
      || createListingsRepository({ driver: "postgres", pgDriver, deps, schema: options.schema || "" });
    // hydrate() is the same SELECT * the SQLite path runs (`WHERE post_id IN (...)`), so the row
    // shape the decorators see is identical.
    const [row] = await repository.hydrate([id]);
    if (!row) return row;
    const uid = deps.resolveUserId(userId);
    if (!listingVisibleOnSurface(row, { surface: LISTING_SURFACE.MEMBER_DETAIL, viewerId: uid })) {
      return undefined;
    }
    const settings = options.settings || deps.getSettings(uid);
    const sameHouse = options.sameHouse !== false;
    const matchVoteUserId = options.matchVoteUserId == null ? uid : Number(options.matchVoteUserId) || 0;
    const provider = options.decorationProvider || (await preloadDecorationProviderAsync({
      exec,
      rows: [row],
      settings,
      userId: uid,
      matchVoteUserId,
      sameHouse,
    }));
    const [decorated] = decorateRowsWithProvider([row], {
      settings,
      userId: uid,
      provider,
      sameHouse,
      matchVoteUserId,
    });
    return decorated ?? row;
  } catch (error) {
    // A detail page must not go blank because PostgreSQL hiccuped.
    if (options.strict) throw error;
    return getListing(postId, userId, options);
  }
}

