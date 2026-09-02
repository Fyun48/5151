import { distanceKm } from "./geo.js";
import { MRT_STATIONS } from "./mrtStations.js";
import { roundCoord } from "./route.js";

const GEO_UA = "591-tracker/1.0 (personal rental watcher; acefengyun@gmail.com)";
const WALK_KMH = 4.5;
const RIDE_KMH = 15;
const WALK_FACTOR = 1.28;
const RIDE_FACTOR = 1.18;

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

async function osrmDistanceKm(profile, fromLat, fromLng, toLat, toLng) {
  const wait = 1100 - (Date.now() - lastMrtRouteAt);
  if (wait > 0) await sleep(wait);
  const path = `${Number(fromLng)},${Number(fromLat)};${Number(toLng)},${Number(toLat)}`;
  const url = new URL(`https://router.project-osrm.org/route/v1/${profile}/${path}`);
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
  const seconds = Number(body.routes?.[0]?.duration);
  if (!Number.isFinite(meters) || meters <= 0) return null;
  return {
    km: roundKm(meters / 1000),
    min: Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null,
  };
}

export async function fetchMrtAccess(lat, lng) {
  const station = nearestMrtStation(lat, lng);
  if (!station) return null;
  const fallback = estimateMrtAccess(station.straightKm) || {};
  let walk = null;
  let ride = null;
  try {
    walk = await osrmDistanceKm("walking", lat, lng, station.lat, station.lng);
    if (walk?.busy) return { station: station.name, ...fallback, pending: true };
  } catch {
    walk = null;
  }
  try {
    ride = await osrmDistanceKm("cycling", lat, lng, station.lat, station.lng);
    if (ride?.busy) {
      return {
        station: station.name,
        walk_km: walk?.km ?? fallback.walk_km,
        walk_min: walk?.min ?? fallback.walk_min,
        ride_km: fallback.ride_km,
        ride_min: fallback.ride_min,
      };
    }
  } catch {
    ride = null;
  }
  return {
    station: station.name,
    walk_km: walk?.km ?? fallback.walk_km,
    walk_min: walk?.min ?? fallback.walk_min,
    ride_km: ride?.km ?? fallback.ride_km,
    ride_min: ride?.min ?? fallback.ride_min,
  };
}

export function formatMrtAccess(row = {}) {
  const name = String(row.mrt_station || row.station || "").trim();
  if (!name) return "";
  const walkKm = Number(row.mrt_walk_km ?? row.walk_km);
  const rideKm = Number(row.mrt_ride_km ?? row.ride_km);
  const walkMin = Number(row.mrt_walk_min ?? row.walk_min);
  const rideMin = Number(row.mrt_ride_min ?? row.ride_min);
  const bits = [`捷運${name.replace(/站$/, "")}站`];
  if (Number.isFinite(walkKm) && walkKm > 0) {
    bits.push(Number.isFinite(walkMin) ? `走路 ${walkKm} 公里（${walkMin} 分）` : `走路 ${walkKm} 公里`);
  }
  if (Number.isFinite(rideKm) && rideKm > 0) {
    bits.push(Number.isFinite(rideMin) ? `騎車 ${rideKm} 公里（${rideMin} 分）` : `騎車 ${rideKm} 公里`);
  }
  return bits.join(" · ");
}
