/** Cheap guest listing cache. Identical queries reuse a short-lived payload. */

// 訪客快取的時間常數（2026-10-10 建立；2026-10-16 放寬 SWR 陳舊上界）：
//   - TTL_MS：同 generation 的「新鮮窗口」——窗口內直接命中，不發背景重算。
//   - BUCKET_MS：PG revision generation 讀取的粗粒度 bucket（行程內 memo 的窗口）＝
//     「資料被改掉之後，最慢多久會被 generation 換代偵測到」的上界。
//   - MAX_STALE_MS：SWR 的**陳舊上界**（預設 10 分鐘）。entry 年齡 ≤ 上界 ⇒ 一律先回舊值
//     （同一個 key 只發一次 single-flight 背景重算）；只有「沒有 entry」或「年齡 > 上界」
//     才同步重算。
//
// 為什麼是 10 分鐘（600_000ms，2026-10-16 Owner 核可）：本專案資料由爬蟲**約每 20 分鐘**
// 更新一輪，所以「entry 陳舊 45 秒以上就不准回舊值」比資料本身的更新節奏嚴格一個量級，
// 低流量站的訪客幾乎每一發都落在「同步重算」那一格（正式站實測：間隔 150s 連續 7 發為
// 17.5／17.0／16.6／17.3／17.1／15.8／16.4 秒；改為 10 分鐘上界後走 SWR，同一支量測
// 每發 < 3 秒）。上界仍然存在，是為了讓「使用者最多看到多久以前的清單」有明確答案：
// 600 秒 ＋ 該次計算本身的耗時（見 docs/handoffs/20261016-guest-swr-stale-window.md）。
//
// 開關清單（照 repo 慣例：只認環境變數，不動 compose／.env）：
//   - GUEST_SWR_MAX_STALE_MS：覆寫陳舊上界（毫秒），**硬上界 clamp 在 [TTL_MS, 600_000]**。
//     只能調小、不能調大於 Owner 核可的 10 分鐘；解析失敗（未設、空字串、非正數）
//     一律回到預設 600_000。
export const TTL_MS = 20_000;
export const BUCKET_MS = 20_000;
export const GUEST_SWR_MAX_STALE_MS_ENV = "GUEST_SWR_MAX_STALE_MS";
/** 陳舊上界的硬上界（＝Owner 核可值）：環境變數再怎麼設都不會超過這個數。 */
export const MAX_STALE_MS_CEILING = 600_000;
export const MAX_STALE_MS = guestSwrMaxStaleMs();

/** 陳舊上界（毫秒）：環境變數覆寫一律 clamp 進 [TTL_MS, MAX_STALE_MS_CEILING]。 */
export function guestSwrMaxStaleMs(env = process.env) {
  const raw = Number(env?.[GUEST_SWR_MAX_STALE_MS_ENV]);
  const wanted = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MAX_STALE_MS_CEILING;
  return Math.min(Math.max(wanted, TTL_MS), MAX_STALE_MS_CEILING);
}
const MAX_ENTRIES = 200;
const cache = new Map();
// 進行中的計算（single-flight）：同一 key 的併發請求（含 SWR 的背景重算）共用同一個
// in-flight promise，只跑一次 load()。key 只看「參數」（不看 generation），
// 因此背景重算與新的冷計算也會併流，不會對同 key 同時起兩個重算。
const inflight = new Map();
// PG 的 revision generation 行程內 bucket memo（{ revision, at }）。多節點各自維護，
// generation 不同只會多觸發 SWR 背景重算、不會回錯資料（見 PR body）。
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

export function getCachedPublicListings(query, load, { namespace = "sqlite:guest:v2", now = Date.now } = {}) {
  // `namespace: null` means "never hit, never write" (fail-closed) — the caller
  // must still serve the freshly-loaded payload. PostgreSQL resolves a real
  // generation (pg:guest:v${revision}) via resolveGuestCacheNamespace(); when the
  // revision cannot be read the caller passes null here.
  if (namespace == null) {
    const result = load();
    if (result && typeof result.then === "function") {
      return result.then((payload) => ({ ...payload, cache_hit: false, cache_age_ms: 0 }));
    }
    return { ...result, cache_hit: false, cache_age_ms: 0 };
  }

  // 快取 key 只看參數、不看 generation：generation 換代不再把 key 換掉，
  // 這樣「冷算 25s > bucket 20s」那種查詢才有機會被同一筆 entry 命中（SWR）。
  const key = normalizePublicQuery(query);
  const nowMs = now();
  const hit = cache.get(key);

  if (hit) {
    const age = nowMs - hit.at;
    const generationChanged = hit.namespace !== namespace;
    if (!generationChanged && age < TTL_MS) {
      // 同 generation 且仍在新鮮窗口：直接命中，不做背景重算。
      return { ...hit.payload, cache_hit: true, cache_age_ms: age };
    }
    if (age <= MAX_STALE_MS) {
      // 陳舊上界內 ⇒ SWR：先回舊值，同時發一次 single-flight 背景重算。兩種情形：
      //   (a) 同 generation、年齡 ≥ TTL_MS：generation 是 `data_revision.MAX(id)`，沒換代
      //       代表寫入端沒有 bump 過 ⇒ 這筆 entry 的資料仍然有效，回舊值就是「正確值」，
      //       不是「將就的舊資料」。仍然發背景重算是為了讓 entry 的年齡回到 0——否則同一筆
      //       entry 會一路被養到上界，之後每 MAX_STALE_MS 就有一發請求掉回同步重算
      //       （低流量站＝每隔幾發卡一次十幾秒）。
      //   (b) generation 已換代：資料真的變了，但舊值仍在上界內 ⇒ 標準 SWR，先回舊值。
      // `stale: true` 的語意是「這次回的是快取舊值，且已發出背景重算」，不等於資料一定過期。
      revalidateInBackground(key, load, namespace, now);
      return { ...hit.payload, cache_hit: true, stale: true, cache_age_ms: age };
    }
    // 年齡 > MAX_STALE_MS：超過陳舊上界，不准再回舊值 → 落回下面的同步重算。
  }

  // 同步重算（single-flight：同 key 正在算時，併發的請求共用同一個 in-flight promise，
  // 不會各自再跑一次全量搜尋）。
  if (inflight.has(key)) {
    return inflight.get(key);
  }
  const result = load();
  // Cache only resolved success. A rejected request must remain an error and
  // must not leave a Promise or an empty result in the public cache.
  if (result && typeof result.then === "function") {
    const pending = result.then((payload) => rememberInto(key, namespace, now, payload));
    inflight.set(key, pending);
    pending.then(() => inflight.delete(key), () => inflight.delete(key));
    return pending;
  }
  return rememberInto(key, namespace, now, result);
}

function rememberInto(key, namespace, now, payload) {
  cache.set(key, { at: now(), payload, namespace });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return { ...payload, cache_hit: false, cache_age_ms: 0 };
}

// SWR 背景重算：只負責「算完把 entry 換成新代」，不回傳給當下這個請求。
// 背景重算拋錯一律吞掉＋log，不得影響已回出的舊值。
function revalidateInBackground(key, load, namespace, now) {
  if (inflight.has(key)) return; // single-flight：同 key 已有冷計算或背景重算在跑。
  let result;
  try {
    result = load();
  } catch (error) {
    logRevalidateError(error);
    return;
  }
  if (result && typeof result.then === "function") {
    // pending 本身會 reject（讓年齡 > MAX_STALE_MS 的 inflight joiners 拿到正確錯誤，而非 undefined）；
    // 這裡用「不 throw 的 rejection handler」把背景這條吞掉＋log，失敗不影響已回出的舊值。
    const pending = result.then((payload) => rememberInto(key, namespace, now, payload));
    inflight.set(key, pending);
    pending.then(
      () => inflight.delete(key),
      (error) => { logRevalidateError(error); inflight.delete(key); },
    );
  } else {
    try {
      rememberInto(key, namespace, now, result);
    } catch (error) {
      logRevalidateError(error);
    }
  }
}

function logRevalidateError(error) {
  try {
    console.error("[guest-cache] background revalidate failed:", error && error.message ? error.message : error);
  } catch {
    /* 連 log 都不能把回應弄掛 */
  }
}

/**
 * Guest-cache namespace (generation). In SQLite the namespace is the long-lived
 * `sqlite:guest:v2` (verbatim, #674). In PostgreSQL the durable `data_revision`
 * change-log is the generation: `pg:guest:v${MAX(id)}`. When a write bumps the
 * revision the namespace changes, so the next guest request resolves a different
 * namespace and the entry is served as stale (SWR, ≤ MAX_STALE_MS = 10 min) while a
 * single-flight revalidation runs in the background — instead of a hard miss.
 * （generation 沒換代、但年齡超過 TTL_MS 的 entry 同樣走 SWR，見 getCachedPublicListings
 * 的分支註解：沒換代＝寫入端沒 bump ⇒ 舊值仍是正確值，但仍發背景重算讓年齡歸零。）
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
 * 多節點（web-A／web-B）各自有行程內 bucket memo：BUCKET_MS（20 秒）也是「資料被改掉之後，
 * 最慢多久會被偵測到換代」的上界；偵測到之後，年齡 ≤ MAX_STALE_MS（10 分鐘）的 entry 會先回
 * 舊值（SWR）＋背景重算，超過才同步重算，因此不會回錯資料（回舊值的前提是「同參數、
 * 年齡 ≤ MAX_STALE_MS」，且重算完成前舊值仍在上限內）。
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
