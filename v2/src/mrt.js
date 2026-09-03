import { distanceKm } from "./geo.js";
import { MRT_STATIONS } from "./mrtStations.js";
import { roundCoord } from "./route.js";

const GEO_UA = "591-tracker/1.0 (personal rental watcher; acefengyun@gmail.com)";
const WALK_KMH = 4.5;
const RIDE_KMH = 15;
const WALK_FACTOR = 1.28;
const RIDE_FACTOR = 1.18;
const WALK_CANDIDATE_LIMIT = 5;

/** 步行路線達此距離（含）就不顯示最近捷運站。 */
export const MRT_WALK_MAX_KM = 1.5;

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
  const url = new URL(`https://router.project-osrm.org/route/v1/walking/${path}`);
  url.searchParams.set("alternatives", "false");
  url.searchParams.set("overview", "false");
  url.searchParams.set("steps", "false");
  lastMrtRouteAt = Date.now();
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": GEO_UA },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 429) return { busy: true };
  if (!res.ok) return null;
  const body = await res.json();
  if (body.code && body.code !== "Ok") return null;
  const meters = Number(body.routes?.[0]?.distance);
  if (!Number.isFinite(meters) || meters <= 0) return null;
  return { km: roundKm(meters / 1000) };
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
  return `捷運${name.replace(/站$/, "")}站 · 步行約 ${walkKm} 公里`;
}
