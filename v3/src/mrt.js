import { crawlRequestSignal } from "./crawlExecution.js";
import { distanceKm } from "./geo.js";
import { MRT_STATIONS } from "./mrtStations.js";
import { roundCoord } from "./route.js";

const GEO_UA = "591-tracker/1.0 (personal rental watcher; acefengyun@gmail.com)";
// 🚨 A4：**步行路線一定要用 foot profile 的服務**。
// 原本打的是 OSRM 的公開示範站（`route/v1/walking/…`），那個站**只跑車用 profile**，
// `walking` 這個字在路徑裡完全是裝飾：2026-10-01 實測 `driving`／`walking`／`cycling`／`foot`
// 四個字串回傳**位元組完全相同**的結果（762.7 m／105.3 s ≈ 26 km/h），也就是拿車程冒充步行。
// FOSSGIS 的 `routed-foot` 是真的一個 foot profile：同一個查詢回 2,826.8 m／2,261.5 s（步行速度），
// 與車用 profile 的 2,925.1 m／265.3 s 明顯不同。可用環境變數覆寫（自架 OSRM 時改這裡）。
const FOOT_ROUTE_BASE = process.env.MRT_FOOT_ROUTE_BASE || "https://routing.openstreetmap.de/routed-foot/route/v1/foot";
const WALK_KMH = 4.5;
const RIDE_KMH = 15;
const WALK_FACTOR = 1.28;
const RIDE_FACTOR = 1.18;
const WALK_CANDIDATE_LIMIT = 5;
// A4 的候選站上限刻意比 5 大：上限一旦截斷，就不能宣稱「已查證沒有」。
// 8 是「市區幾乎不會截斷」與「最差情況不要打太多次外部服務」的折衷
// （每一次路線查詢間隔 1.1 秒 ⇒ 最差約 9 秒；有查證到符合的站就提早結束）。
const MRT_ACCESS_CANDIDATE_LIMIT = 8;

/** 步行路線達此距離（含）就不顯示最近捷運站。 */
export const MRT_WALK_MAX_KM = 1.5;

/** A4：刊登表單與許願房配對用的「可步行捷運」門檻，1,000 公尺（含）。 */
export const MRT_ACCESS_MAX_M = 1000;
/**
 * 路線來源標記：寫進快取，讓「已查證」與「未查證」分得出來（不可用直線距離冒充）。
 *
 * `MRT_CACHE_CONTRACT` 是**來源＋演算法版本**的契約字串：快取列只有在
 * `checked = 1 且 source = MRT_CACHE_CONTRACT` 時才算「已查證的步行結果」。
 * 換服務、換 profile、或改了候選站挑選方式時把版本往上加，舊列就自動失效（會按需重算）。
 * 這一版之前寫入的列（舊的車用 profile 或沒有來源欄位）一律不採計。
 */
export const MRT_ROUTE_SOURCE = "osrm-foot";
export const MRT_CACHE_VERSION = "v1";
export const MRT_CACHE_CONTRACT = `${MRT_ROUTE_SOURCE}:${MRT_CACHE_VERSION}`;

let lastMrtRouteAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 缺值安全的正數轉換：`null`／`undefined`／`""` 一律回 `null`（**不是 0**）。
 * `Number(null) === 0` 而且 `Number.isFinite(0)` 是 true，直接用 `Number()` 會把
 * 「沒有資料」變成「0 公尺」，再被門檻判定當成「符合」——這一類坑在本批踩過三次。
 */
export function nullableMeters(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 顯示用：四捨五入到 0.1 公里。**0 是合法距離**（查詢點與站點出入口重合），不可被當成「沒有值」。 */
function roundKm(km) {
  const n = Number(km);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10) / 10;
}

function minutesFromKm(km, kmh) {
  const n = Number(km);
  if (!Number.isFinite(n) || n < 0 || !kmh) return null;
  if (n === 0) return 0;
  return Math.max(1, Math.round((n / kmh) * 60));
}

export function makeMrtKey(lat, lng) {
  return `${roundCoord(lat)},${roundCoord(lng)}`;
}

/** A4：距離以公尺計，**小於或等於** 1,000 公尺才算符合（0 公尺＝同一點，也算符合）。 */
export function isMrtAccessWithin(meters, maxMeters = MRT_ACCESS_MAX_M) {
  const n = Number(meters);
  const cap = Number(maxMeters);
  if (!Number.isFinite(n) || n < 0) return false;
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return n <= cap;
}

export function isWalkableMrtDistance(km) {
  const n = Number(km);
  return Number.isFinite(n) && n >= 0 && n < MRT_WALK_MAX_KM;
}

export function nearestMrtStation(lat, lng) {
  const fromLat = Number(lat);
  const fromLng = Number(lng);
  if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng)) return null;
  let best = null;
  for (const [name, stationLat, stationLng] of MRT_STATIONS) {
    const km = distanceKm(fromLat, fromLng, stationLat, stationLng);
    if (km == null) continue;
    if (!best || km < best.straightKm) {
      best = { name, lat: stationLat, lng: stationLng, straightKm: km };
    }
  }
  return best;
}

/** 直線距離未達 1.5 公里的站才可能走出小於 1.5 公里的步行路線。 */
export function nearbyWalkMrtStations(lat, lng, { maxStraightKm = MRT_WALK_MAX_KM, limit = WALK_CANDIDATE_LIMIT } = {}) {
  const fromLat = Number(lat);
  const fromLng = Number(lng);
  if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng)) return [];
  const cap = Math.max(1, Number(limit) || WALK_CANDIDATE_LIMIT);
  const max = Number(maxStraightKm);
  const rows = [];
  for (const [name, stationLat, stationLng] of MRT_STATIONS) {
    const km = distanceKm(fromLat, fromLng, stationLat, stationLng);
    if (km == null || !Number.isFinite(max) || km >= max) continue;
    rows.push({ name, lat: stationLat, lng: stationLng, straightKm: km });
  }
  rows.sort((a, b) => a.straightKm - b.straightKm);
  return rows.slice(0, cap);
}

export function estimateMrtAccess(straightKm) {
  const base = Number(straightKm);
  if (!Number.isFinite(base) || base <= 0) return null;
  const walkKm = roundKm(base * WALK_FACTOR);
  const rideKm = roundKm(base * RIDE_FACTOR);
  return {
    walk_km: walkKm,
    walk_min: minutesFromKm(walkKm, WALK_KMH),
    ride_km: rideKm,
    ride_min: minutesFromKm(rideKm, RIDE_KMH),
  };
}

export function estimateMrtAccessForPoint(lat, lng) {
  const station = nearestMrtStation(lat, lng);
  if (!station) return null;
  const est = estimateMrtAccess(station.straightKm);
  if (!est) return null;
  return { station: station.name, ...est };
}

function tooFarResult(walkKm = null) {
  return {
    station: "",
    walk_km: walkKm,
    walk_min: null,
    ride_km: null,
    ride_min: null,
    too_far: true,
    resolved: true,
  };
}

/**
 * 對公開路線服務查一次步行距離。
 *
 * R1 之後多了一次**針對暫時性錯誤的重試**（5xx／網路錯誤）：公開服務偶爾回 502/503，
 * 一次失敗就讓整個判定掉進「待確認」對使用者太嚴苛。429 不重試（要尊重對方的限速），
 * 直接回 `{ busy: true }` 讓呼叫端顯示「待確認、可重試」。
 */
async function osrmWalkKm(fromLat, fromLng, toLat, toLng, { retry = 1 } = {}) {
  const path = `${Number(fromLng)},${Number(fromLat)};${Number(toLng)},${Number(toLat)}`;
  const url = new URL(`${FOOT_ROUTE_BASE}/${path}`);
  url.searchParams.set("alternatives", "false");
  url.searchParams.set("overview", "false");
  url.searchParams.set("steps", "false");
  let res;
  for (let attempt = 0; ; attempt += 1) {
    const wait = 1100 - (Date.now() - lastMrtRouteAt);
    if (wait > 0) await sleep(wait);
    lastMrtRouteAt = Date.now();
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": GEO_UA },
        signal: crawlRequestSignal(AbortSignal.timeout(10000)),
      });
    } catch (error) {
      if (attempt >= retry) throw error;
      res = null;
    }
    if (res && res.ok) break;
    if (res && res.status === 429) return { busy: true };
    if (attempt >= retry) {
      if (!res) return null;
      if (!res.ok) return null;
      break;
    }
    await sleep(700);
  }
  const body = await res.json();
  if (body.code && body.code !== "Ok") return null;
  const meters = Number(body.routes?.[0]?.distance);
  // `0` 是合法的（查詢點與站點出入口幾乎重合）；舊寫法用 `<= 0` 會把這種情況丟掉，
  // 於是「就在捷運站正上方」的地址反而查不到站。只有負值／非數字才算失敗。
  if (!Number.isFinite(meters) || meters < 0) return null;
  // ⚠️ `meters` 一定要保留**服務回傳的原始值（含小數）**：1000.4 公尺四捨五入成 1000 之後，
  // 門檻 `<= 1000` 會把它判成符合。公里只給顯示，判定一律用這個原始值。
  return { km: roundKm(meters / 1000), meters, source: MRT_ROUTE_SOURCE };
}

/**
 * A4：屋主在刊登表單輸入地址後用的「1 公里內可步行捷運」查詢。
 *
 * 與 `fetchMrtAccess()` 的差別：門檻是 1,000 公尺（含）、候選站先用**直線距離**篩
 * （直線是步行距離的下界，所以直線 > 1000 m 的站不可能合格，這樣可以少打外部服務），
 * 再用**真實步行路線**判定。狀態一律明確：
 *   - `within`：已查證且 ≤ 1,000 m（只有這種可以顯示「符合」）
 *   - `none`：已查證但沒有站點在 1 公里內
 *   - `unknown`：候選站有，但路線服務沒有給出可用結果 ⇒ **待確認**，不可當成符合或確定沒有
 */
export async function fetchMrtAccessWithin(lat, lng, { routeWalk, maxMeters = MRT_ACCESS_MAX_M } = {}) {
  const fromLat = Number(lat);
  const fromLng = Number(lng);
  if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng)) {
    return { status: "unknown", station: "", walk_m: null, walk_km: null, resolved: false, reason: "coords" };
  }
  const cap = Number(maxMeters);
  const limit = Math.max(1, Number(maxMeters) > 0 ? MRT_ACCESS_CANDIDATE_LIMIT : WALK_CANDIDATE_LIMIT);
  const maxKm = (Number.isFinite(cap) && cap > 0 ? cap : MRT_ACCESS_MAX_M) / 1000;
  const candidates = nearbyWalkMrtStations(fromLat, fromLng, { maxStraightKm: maxKm, limit });
  if (!candidates.length) {
    // 直線距離就沒有任何站在門檻內 ⇒ 步行一定更遠（直線是步行距離的下界）。
    // 這是**已查證**的「沒有」，而且與候選上限無關（一個候選都沒有，就沒有被截斷的問題）。
    return {
      status: "none", station: "", walk_m: null, walk_km: null, resolved: true,
      checked: 0, failed: 0, searched_m: maxKm * 1000, source: MRT_ROUTE_SOURCE,
    };
  }
  const walkFn = typeof routeWalk === "function" ? routeWalk : osrmWalkKm;
  let best = null;
  let checked = 0;
  let failures = 0;
  let busy = false;
  for (const station of candidates) {
    let walk = null;
    try {
      walk = await walkFn(fromLat, fromLng, station.lat, station.lng);
    } catch {
      walk = null;
    }
    if (walk?.busy) { busy = true; failures += 1; continue; }
    // 一律以**未四捨五入的公尺**判定；公里只用於顯示（1,049m 不可以因為顯示成 1.0 就變成符合）。
    const meters = Number.isFinite(Number(walk?.meters))
      ? Number(walk.meters)
      : (Number.isFinite(Number(walk?.km)) ? Number(walk.km) * 1000 : NaN);
    checked += 1;
    if (!Number.isFinite(meters) || meters < 0) { failures += 1; continue; }
    if (!best || meters < best.walk_m) best = { station: station.name, walk_m: meters };
    // 提早結束：已經找到一個「符合」的站，就沒有更好的答案了（`within` 是最終判定）。
    // 這讓最常見的情況只打一次外部服務，也少給公開服務添負擔。
    if (isMrtAccessWithin(meters, cap)) break;
  }

  const searched = {
    checked,
    failed: failures,
    busy,
    searched_m: maxKm * 1000,
    source: MRT_ROUTE_SOURCE,
    truncated: candidates.length >= limit,
  };

  if (best && isMrtAccessWithin(best.walk_m, cap)) {
    const km = roundKm(best.walk_m / 1000);
    return {
      ...searched,
      status: "within",
      station: best.station,
      walk_m: best.walk_m,          // 原始公尺（未四捨五入）——配對與門檻都用這個
      walk_km: km,                  // 顯示用
      walk_min: minutesFromKm(best.walk_m / 1000, WALK_KMH),
      resolved: true,
    };
  }

  // 走到這裡代表「已確認符合的站一個都沒有」。要宣告「已查證沒有」必須：
  //   1. 沒有候選站失敗／服務忙碌
  //   2. 候選沒有被上限截斷（截斷代表還有沒查的站，不能說確定了）
  if (failures > 0 || searched.truncated) {
    const km = best ? roundKm(best.walk_m / 1000) : null;
    return {
      ...searched,
      status: "unknown",
      station: "",
      walk_m: null,
      walk_km: null,
      resolved: false,
      nearest_walk_m: best ? best.walk_m : null,
      nearest_station: best ? best.station : "",
      nearest_walk_km: km,
    };
  }
  const km = best ? roundKm(best.walk_m / 1000) : null;
  return {
    ...searched,
    status: "none",
    station: "",
    walk_m: null,
    walk_km: null,
    resolved: true,
    nearest_walk_m: best ? best.walk_m : null,
    nearest_station: best ? best.station : "",
    nearest_walk_km: km,
  };
}

export async function fetchMrtAccess(lat, lng, { routeWalk } = {}) {
  const candidates = nearbyWalkMrtStations(lat, lng);
  if (!candidates.length) return tooFarResult();
  const walkFn = typeof routeWalk === "function" ? routeWalk : osrmWalkKm;
  let best = null;
  for (const station of candidates) {
    let walk = null;
    try {
      walk = await walkFn(lat, lng, station.lat, station.lng);
    } catch {
      walk = null;
    }
    if (walk?.busy) return { pending: true, resolved: false };
    const km = Number(walk?.km);
    if (!Number.isFinite(km) || km <= 0) continue;
    if (!best || km < best.walk_km) {
      best = {
        station: station.name,
        walk_km: km,
        walk_min: null,
        ride_km: null,
        ride_min: null,
        too_far: !isWalkableMrtDistance(km),
        resolved: true,
      };
    }
  }
  if (!best) return { pending: true, resolved: false };
  if (!isWalkableMrtDistance(best.walk_km)) return tooFarResult(best.walk_km);
  return best;
}

export function formatMrtAccess(row = {}) {
  const name = String(row.mrt_station || row.station || "").trim();
  const walkKm = Number(row.mrt_walk_km ?? row.walk_km);
  if (!name || !isWalkableMrtDistance(walkKm)) return "";
  return `捷運${name.replace(/站$/, "")}站 約 ${walkKm} 公里`;
}
