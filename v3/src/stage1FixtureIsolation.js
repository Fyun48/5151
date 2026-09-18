/** Centralized Stage 1 fixture isolation policy.
 * Source of truth is stage1_fixture_registry plus nullable fixture_namespace
 * columns. Product projections must call these helpers instead of ad-hoc filters.
 */

export const STAGE1_FIXTURE_NAMESPACE = "stage1-fix";
export const STAGE1_FIXTURE_TTL_MS = 72 * 60 * 60 * 1000;

export const LISTING_SURFACE = Object.freeze({
  BROWSE: "browse",
  PUBLIC_DETAIL: "public_detail",
  MEMBER_DETAIL: "member_detail",
  SHARE_GO: "share_go",
  MAP: "map",
  STATS: "stats",
  OWNER_SELF: "owner_self",
  MATCH_CANDIDATE: "match_candidate",
  ADMIN_DEBUG: "admin_debug",
});

export const WISH_SURFACE = Object.freeze({
  PUBLIC_LIST: "wish_public_list",
  PUBLIC_DETAIL: "wish_public_detail",
  SHARE: "wish_share",
  MINE: "wish_mine",
  MATCH_CANDIDATE: "wish_match_candidate",
  AGGREGATE: "wish_aggregate",
  ADMIN_DEBUG: "wish_admin_debug",
});

const PRODUCT_LISTING_SURFACES = new Set([
  LISTING_SURFACE.BROWSE,
  LISTING_SURFACE.PUBLIC_DETAIL,
  LISTING_SURFACE.MEMBER_DETAIL,
  LISTING_SURFACE.SHARE_GO,
  LISTING_SURFACE.MAP,
  LISTING_SURFACE.STATS,
  LISTING_SURFACE.MATCH_CANDIDATE,
]);

const PRODUCT_WISH_SURFACES = new Set([
  WISH_SURFACE.PUBLIC_LIST,
  WISH_SURFACE.PUBLIC_DETAIL,
  WISH_SURFACE.SHARE,
  WISH_SURFACE.MATCH_CANDIDATE,
  WISH_SURFACE.AGGREGATE,
]);

export function fixtureNamespaceOf(row = {}) {
  return String(row?.fixture_namespace || "").trim();
}

export function isFixtureRow(row) {
  return fixtureNamespaceOf(row) !== "";
}

export function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

export function hasFixtureNamespaceColumn(db, table) {
  return tableColumns(db, table).has("fixture_namespace");
}

export function sqlExcludeFixtureRows(db, table, alias = "") {
  if (db && !hasFixtureNamespaceColumn(db, table)) {
    return { sql: "1=1", params: [] };
  }
  const col = alias ? `${alias}.fixture_namespace` : "fixture_namespace";
  return { sql: `(${col} IS NULL OR ${col} = '')`, params: [] };
}

export function sqlWishMatchesListingNamespace(db, listingNamespace, wishAlias = "p") {
  if (db && !hasFixtureNamespaceColumn(db, "demand_posts")) {
    return { sql: "1=1", params: [] };
  }
  const col = `${wishAlias}.fixture_namespace`;
  const ns = String(listingNamespace || "").trim();
  if (!ns) {
    return { sql: `(${col} IS NULL OR ${col} = '')`, params: [] };
  }
  return { sql: `${col} = ?`, params: [ns] };
}

export function applyBrowseIsolation(clauses, params, db, table = "listings", alias = "") {
  const isolation = sqlExcludeFixtureRows(db, table, alias);
  clauses.push(isolation.sql);
  params.push(...isolation.params);
  return isolation;
}

export function listingVisibleOnSurface(row, { surface, viewerId = 0 } = {}) {
  if (!row) return false;
  if (!isFixtureRow(row)) return true;
  if (surface === LISTING_SURFACE.ADMIN_DEBUG) return true;
  if (
    surface === LISTING_SURFACE.OWNER_SELF
    && Number(row.listed_by_user_id) === Number(viewerId)
    && Number(viewerId) > 0
  ) {
    return true;
  }
  if (PRODUCT_LISTING_SURFACES.has(surface)) return false;
  return false;
}

export function wishVisibleOnSurface(row, { surface, viewerId = 0 } = {}) {
  if (!row) return false;
  if (!isFixtureRow(row)) return true;
  if (surface === WISH_SURFACE.ADMIN_DEBUG) return true;
  if (
    surface === WISH_SURFACE.MINE
    && Number(row.user_id) === Number(viewerId)
    && Number(viewerId) > 0
  ) {
    return true;
  }
  if (PRODUCT_WISH_SURFACES.has(surface)) return false;
  return false;
}

export function fixtureNamespacesCompatible(listing, wish) {
  return fixtureNamespaceOf(listing) === fixtureNamespaceOf(wish);
}

export function hideFixtureListingFromProductProjection(row) {
  return isFixtureRow(row);
}
