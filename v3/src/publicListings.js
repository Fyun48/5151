/** Cheap guest listing cache. Identical queries reuse a short-lived payload. */

const TTL_MS = 45_000;
const MAX_ENTRIES = 200;
const cache = new Map();

export function normalizePublicQuery(query = {}) {
  const districts = (Array.isArray(query.districts) ? query.districts : String(query.districts || "").split(","))
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .sort();
  return JSON.stringify({
    districts,
    kind: String(query.kind || ""),
    sources: String(query.sources || ""),
    q: String(query.q || "").trim(),
    sort: String(query.sort || "newest"),
    limit: Math.max(1, Math.min(Number(query.limit) || 40, 50)),
    offset: Math.max(0, Number(query.offset) || 0),
    priceMin: Number(query.priceMin) || 0,
    priceMax: Number(query.priceMax) || 0,
    priceMaxIncludesExtras: query.priceMaxIncludesExtras === true || query.priceMaxIncludesExtras === "1",
    areaMax: Number(query.areaMax) || 0,
    excludeRooftop: query.excludeRooftop !== "0" && query.excludeRooftop !== false,
    excludeLowFloors: query.excludeLowFloors !== "0" && query.excludeLowFloors !== false,
    minBuildingFloors: Number(query.minBuildingFloors) || 0,
    wholeFloorOnly: query.wholeFloorOnly === true || query.wholeFloorOnly === "1",
    hasParking: query.hasParking === true || query.hasParking === "1",
    workAddress: String(query.workAddress || "").trim().slice(0, 120),
    commuteKm: Number(query.commuteKm) || 0,
    workLat: Number.isFinite(Number(query.workLat)) ? Number(query.workLat) : null,
    workLng: Number.isFinite(Number(query.workLng)) ? Number(query.workLng) : null,
  });
}

export function resetPublicListingsCache() {
  cache.clear();
}

export function publicListingsCacheSize() {
  return cache.size;
}

export function getCachedPublicListings(query, load, { namespace = "sqlite:guest:v2" } = {}) {
  // `namespace: null` means "never hit, never write" (fail-closed) — the caller
  // must still serve the freshly-loaded payload. PostgreSQL resolves a real
  // generation (pg:guest:v${revision}) via resolveGuestCacheNamespace(); when the
  // revision cannot be read the caller passes null here.
  const key = namespace == null ? null : `${namespace}:${normalizePublicQuery(query)}`;
  const now = Date.now();
  const hit = key == null ? null : cache.get(key);
  if (hit && now - hit.at < TTL_MS) {
    return {
      ...hit.payload,
      cache_hit: true,
      cache_age_ms: now - hit.at,
    };
  }
  const remember = payload => {
    if (key != null) {
      cache.set(key, { at: Date.now(), payload });
      if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    }
    return { ...payload, cache_hit: false, cache_age_ms: 0 };
  };
  const result = load();
  // Cache only resolved success. A rejected request must remain an error and
  // must not leave a Promise or an empty result in the public cache.
  return result && typeof result.then === "function" ? result.then(remember) : remember(result);
}

/**
 * Guest-cache namespace (generation). In SQLite the namespace is the long-lived
 * `sqlite:guest:v2` (verbatim, #674). In PostgreSQL the durable `data_revision`
 * change-log is the generation: `pg:guest:v${MAX(id)}`. When a write bumps the
 * revision the namespace changes, so the next guest request is a guaranteed miss
 * against the previous generation's entries.
 *
 * A `null` namespace means "never hit, never write" (fail-closed) — the caller
 * must still serve the freshly-loaded payload.
 */
export function guestCacheNamespace({ driver = "sqlite", revision = null } = {}) {
  if (driver === "postgres") {
    if (revision == null) return null;
    const n = Number(revision);
    if (!Number.isFinite(n)) return null;
    return `pg:guest:v${n}`;
  }
  return "sqlite:guest:v2";
}

/**
 * Resolve the guest-cache namespace for the current driver. PostgreSQL reads
 * `MAX(id)` from `data_revision` (native PG read, no SQLite mirror) and uses it
 * as the generation; any failure to read the revision is fail-closed to `null`
 * (miss + no write) instead of serving a stale or empty payload.
 *
 * The heavy PG modules are loaded lazily so the pure cache module (and its unit
 * tests) stays free of a `db.js` import at module-load time.
 */
export async function resolveGuestCacheNamespace({ driver = "sqlite", readRevision = null } = {}) {
  if (driver !== "postgres") return "sqlite:guest:v2";
  let revision;
  try {
    if (readRevision) {
      revision = await readRevision();
    } else {
      const { currentRevisionAsync } = await import("./dataRevisionAsync.js");
      const { sharedPgDriver } = await import("./pgSharedDriver.js");
      const { toPostgresSql } = await import("./sqlDialect.js");
      const pgDriver = await sharedPgDriver();
      // Native PG executor: reuses currentRevisionAsync()'s CURRENT_REVISION_SQL and
      // `Number(row?.n) || 0` normalisation while bypassing the SQLite-mirror schema
      // prep (which is unavailable under PG_NO_SQLITE_OPEN=1). strict ⇒ no SQLite fallback.
      const exec = async (sql, params = []) => {
        const res = await pgDriver.query(toPostgresSql(sql), params);
        return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
      };
      revision = await currentRevisionAsync({ driver: "postgres", exec, strict: true });
    }
  } catch {
    revision = null; // fail-closed
  }
  return guestCacheNamespace({ driver: "postgres", revision });
}
