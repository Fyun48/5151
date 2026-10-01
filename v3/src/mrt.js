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

/** 步行路線達此距離（含）就不顯示最近捷運站。 */
export const MRT_WALK_MAX_KM = 1.5;

/** A4：刊登表單與許願房配對用的「可步行捷運」門檻，1,000 公尺（含）。 */
export const MRT_ACCESS_MAX_M = 1000;
/** 路線來源標記：寫進快取，讓「已查證」與「未查證」分得出來（不可用直線距離冒充）。 */
export const MRT_ROUTE_SOURCE = "osrm-foot";

let lastMrtRouteAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundKm(km) {
  const n = Number(km);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10) / 10;
}

function minutesFromKm(km, kmh) {
  const n = Number(km);
  if (!Number.isFinite(n) || n <= 0 || !kmh) return null;
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
  return Number.isFinite(n) && n > 0 && n < MRT_WALK_MAX_KM;
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

async function osrmWalkKm(fromLat, fromLng, toLat, toLng) {
  const wait = 1100 - (Date.now() - lastMrtRouteAt);
  if (wait > 0) await sleep(wait);
  const path = `${Number(fromLng)},${Number(fromLat)};${Number(toLng)},${Number(toLat)}`;
  const url = new URL(`${FOOT_ROUTE_BASE}/${path}`);
  url.searchParams.set("alternatives", "false");
  url.searchParams.set("overview", "false");
  url.searchParams.set("steps", "false");
  lastMrtRouteAt = Date.now();
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": GEO_UA },
    signal: crawlRequestSignal(AbortSignal.timeout(10000)),
  });
  if (res.status === 429) return { busy: true };
  if (!res.ok) return null;
  const body = await res.json();
  if (body.code && body.code !== "Ok") return null;
  const meters = Number(body.routes?.[0]?.distance);
  // `0` 是合法的（查詢點與站點出入口幾乎重合）；舊寫法用 `<= 0` 會把這種情況丟掉，
  // 於是「就在捷運站正上方」的地址反而查不到站。只有負值／非數字才算失敗。
  if (!Number.isFinite(meters) || meters < 0) return null;
  return { km: roundKm(meters / 1000), meters: Math.round(meters), source: MRT_ROUTE_SOURCE };
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
    return { status: "unknown", station: "", walk_m: null, walk_km: null, resolved: false };
  }
  const maxKm = Number(maxMeters) / 1000;
  const candidates = nearbyWalkMrtStations(fromLat, fromLng, { maxStraightKm: maxKm, limit: WALK_CANDIDATE_LIMIT });
  if (!candidates.length) {
    // 直線距離就沒有任何站在 1 公里內 ⇒ 步行一定更遠，這是**已查證**的「沒有」。
    return { status: "none", station: "", walk_m: null, walk_km: null, resolved: true, checked: 0 };
  }
  const walkFn = typeof routeWalk === "function" ? routeWalk : osrmWalkKm;
  let best = null;
  let checked = 0;
  let failures = 0;
  for (const station of candidates) {
    let walk = null;
    try {
      walk = await walkFn(fromLat, fromLng, station.lat, station.lng);
    } catch {
      walk = null;
    }
    if (walk?.busy) return { status: "unknown", station: "", walk_m: null, walk_km: null, resolved: false, busy: true, checked };
    const meters = Number(walk?.meters ?? (Number.isFinite(Number(walk?.km)) ? Number(walk.km) * 1000 : NaN));
    checked += 1;
    if (!Number.isFinite(meters) || meters < 0) { failures += 1; continue; }
    if (!best || meters < best.walk_m) {
      best = { station: station.name, walk_m: Math.round(meters), walk_km: roundKm(meters / 1000) };
    }
  }
  if (!best) {
    return { status: "unknown", station: "", walk_m: null, walk_km: null, resolved: false, checked, failed: failures };
  }
  return {
    status: isMrtAccessWithin(best.walk_m, maxMeters) ? "within" : "none",
    station: best.station,
    walk_m: best.walk_m,
    walk_km: best.walk_km,
    walk_min: minutesFromKm(best.walk_km, WALK_KMH),
    resolved: true,
    source: MRT_ROUTE_SOURCE,
    checked,
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
