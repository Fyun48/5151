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
  // PG revision writes are currently best-effort, so they cannot safely identify
  // a cache generation. Until that contract is durable, PG passes namespace:null.
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
