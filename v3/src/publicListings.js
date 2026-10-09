/** Cheap guest listing cache. Identical queries reuse a short-lived payload. */

// 訪客快取的兩個時間常數（2026-10-10，第 N+1 批）：
//   - TTL_MS：單一 cache entry 的最長存活。
//   - BUCKET_MS：PG 的 revision generation 讀取粗粒度 bucket（行程內 memo 的窗口）。
// 最壞陳舊上限＝BUCKET_MS + TTL_MS ≤ 45_000（既有政策上限；實際可達到的陳舊 ≤ min(B,T)）。
export const TTL_MS = 20_000;
export const BUCKET_MS = 20_000;
const MAX_ENTRIES = 200;
const cache = new Map();
// 進行中的計算（single-flight）：同一 key 的併發請求共用同一個 in-flight promise，
// 只跑一次 load()；只依「當下 namespace（含 generation）」為 key，不會跨 generation 共用。
const inflight = new Map();
// PG 的 revision generation 行程內 bucket memo（{ revision, at }）。多節點各自維護，
// generation 不同只會少命中、不會回錯資料（見 PR body）。
let revisionBucket = null;

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
  inflight.clear();
  revisionBucket = null;
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
  // Single-flight：同一 key 正在算時，併發的請求共用同一個 in-flight promise，
  // 不會各自再跑一次全量搜尋（repository/decorationData.js 的 memo 形狀）。
  if (key != null && inflight.has(key)) {
    return inflight.get(key);
  }
  const result = load();
  // Cache only resolved success. A rejected request must remain an error and
  // must not leave a Promise or an empty result in the public cache.
  if (result && typeof result.then === "function") {
    const pending = result.then(remember);
    if (key != null) {
      inflight.set(key, pending);
      pending.then(() => inflight.delete(key), () => inflight.delete(key));
    }
    return pending;
  }
  return remember(result);
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

async function readCurrentRevisionNative() {
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
  return currentRevisionAsync({ driver: "postgres", exec, strict: true });
}

/**
 * Resolve the guest-cache namespace for the current driver. PostgreSQL reads
 * `MAX(id)` from `data_revision` through a BUCKET_MS 粗粒度 bucket：同一窗口內
 * 併發/連發的請求共用同一個 revision 當 generation（爬蟲活躍時才會真的 hit）；
 * 跨窗口才重讀。讀取失敗 ⇒ fail-closed 回 `null`（不回傳舊 generation、不命中、
 * 不寫入），呼叫端仍回傳正確資料。
 *
 * 多節點（web-A／web-B）各自有行程內 bucket memo：generation 不同只會少命中，
 * 不會回錯資料（快取鍵含 generation，且值只在同 generation 內存活 TTL_MS）。
 */
export async function resolveGuestCacheNamespace({ driver = "sqlite", readRevision = null, now = Date.now } = {}) {
  if (driver !== "postgres") return "sqlite:guest:v2";
  const nowMs = now();
  if (revisionBucket && nowMs - revisionBucket.at < BUCKET_MS) {
    return guestCacheNamespace({ driver: "postgres", revision: revisionBucket.revision });
  }
  let revision;
  try {
    revision = await (readRevision ? readRevision() : readCurrentRevisionNative());
  } catch {
    revision = null;
  }
  if (revision == null) return null; // fail-closed：不得沿用舊 generation
  revisionBucket = { revision, at: nowMs };
  return guestCacheNamespace({ driver: "postgres", revision });
}
