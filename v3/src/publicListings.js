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

export function getCachedPublicListings(query, load) {
  const key = normalizePublicQuery(query);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) {
    return {
      ...hit.payload,
      cache_hit: true,
      cache_age_ms: now - hit.at,
    };
  }
  const payload = load();
  cache.set(key, { at: now, payload });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return { ...payload, cache_hit: false, cache_age_ms: 0 };
}
