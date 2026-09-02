import { normalizeCommuteMode } from "./geo.js";
import { googleDirectionsAllowed, isBillableDirectionsStatus, nextWeekdayTaipeiUnix, recordMapsUsage, secondsToMinutes } from "./mapsBilling.js";

const GEO_UA = "591-tracker/1.0 (personal rental watcher; acefengyun@gmail.com)";

let lastRouteAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function metersToKm(meters) {
  const n = Number(meters);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / 1000) * 10) / 10;
}

function uniqueDistances(values) {
  const out = [];
  for (const value of values) {
    const km = metersToKm(value);
    if (km == null) continue;
    if (!out.includes(km)) out.push(km);
  }
  return out.sort((a, b) => a - b).slice(0, 3);
}

function routeMeters(route) {
  return (route.legs || []).reduce((sum, leg) => sum + Number(leg.distance?.value || 0), 0);
}

function routeTrafficSeconds(route) {
  return (route.legs || []).reduce((sum, leg) => {
    const traffic = Number(leg.duration_in_traffic?.value);
    const plain = Number(leg.duration?.value);
    const n = Number.isFinite(traffic) && traffic > 0 ? traffic : plain;
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
}

async function googleDirections(fromLat, fromLng, toLat, toLng, { departureTime = 0, mode = "scooter" } = {}) {
  if (!googleDirectionsAllowed()) return null;
  const key = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  if (!key) return null;
  const url = new URL("https://maps.googleapis.com/maps/api/directions/json");
  url.searchParams.set("origin", `${fromLat},${fromLng}`);
  url.searchParams.set("destination", `${toLat},${toLng}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("alternatives", "true");
  if (normalizeCommuteMode(mode) !== "car") url.searchParams.set("avoid", "highways");
  url.searchParams.set("region", "tw");
  url.searchParams.set("language", "zh-TW");
  url.searchParams.set("key", key);
  const rush = Number(departureTime) > 0;
  if (rush) {
    url.searchParams.set("departure_time", String(Math.round(Number(departureTime))));
    url.searchParams.set("traffic_model", "best_guess");
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const body = await res.json();
  if (!isBillableDirectionsStatus(body.status)) return null;
  recordMapsUsage(rush ? "advanced" : "essentials", 1);
  const routes = body.routes || [];
  const distances = uniqueDistances(routes.map(routeMeters));
  const durationMin = secondsToMinutes(Math.min(...routes.map(routeTrafficSeconds).filter((n) => n > 0)));
  return { distances, durationMin };
}

async function googleRoutes(fromLat, fromLng, toLat, toLng, mode = "scooter") {
  const row = await googleDirections(fromLat, fromLng, toLat, toLng, { mode });
  return row?.distances?.length ? row.distances : null;
}

async function osrmRoutes(fromLat, fromLng, toLat, toLng) {
  const wait = 1100 - (Date.now() - lastRouteAt);
  if (wait > 0) await sleep(wait);
  const path = `${Number(fromLng)},${Number(fromLat)};${Number(toLng)},${Number(toLat)}`;
  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${path}`);
  url.searchParams.set("alternatives", "3");
  url.searchParams.set("overview", "false");
  url.searchParams.set("steps", "false");
  lastRouteAt = Date.now();
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": GEO_UA },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 429) return { busy: true };
  if (!res.ok) return null;
  const body = await res.json();
  if (body.code && body.code !== "Ok") return null;
  return uniqueDistances((body.routes || []).map((route) => route.distance));
}

export function roundCoord(value) {
  return Math.round(Number(value) * 1e5) / 1e5;
}

export function makeRouteKey(fromLat, fromLng, toLat, toLng, mode = "scooter") {
  const base = `${roundCoord(fromLat)},${roundCoord(fromLng)}>${roundCoord(toLat)},${roundCoord(toLng)}`;
  return normalizeCommuteMode(mode) === "car" ? `car:${base}` : base;
}

function mergeKm(a, b) {
  return [...new Set([...(a || []), ...(b || [])])].sort((x, y) => x - y).slice(0, 3);
}

export async function fetchRoadRoutes(fromLat, fromLng, toLat, toLng, { mode = "scooter" } = {}) {
  const from = [Number(fromLat), Number(fromLng)];
  const to = [Number(toLat), Number(toLng)];
  if (!from.every(Number.isFinite) || !to.every(Number.isFinite)) return null;
  let distances = [];
  try {
    const google = await googleRoutes(from[0], from[1], to[0], to[1], mode);
    if (google?.length) distances = google;
  } catch {
    // 沒有 Google key 或失敗時改用 OpenStreetMap 路線
  }
  if (distances.length >= 2) return distances;
  try {
    const osrm = await osrmRoutes(from[0], from[1], to[0], to[1]);
    if (osrm?.busy) return distances.length ? distances : null;
    if (osrm?.length) distances = mergeKm(distances, osrm);
  } catch {
    return distances.length ? distances : null;
  }
  return distances.length ? distances : null;
}

export async function fetchRushRoadRoutes(fromLat, fromLng, toLat, toLng, { now = Date.now(), mode = "scooter" } = {}) {
  const from = [Number(fromLat), Number(fromLng)];
  const to = [Number(toLat), Number(toLng)];
  if (!from.every(Number.isFinite) || !to.every(Number.isFinite)) return null;
  if (!googleDirectionsAllowed()) return null;
  const amAt = nextWeekdayTaipeiUnix(8, 15, { now });
  const pmAt = nextWeekdayTaipeiUnix(18, 15, { now });
  let morning = null;
  let evening = null;
  try {
    morning = await googleDirections(from[0], from[1], to[0], to[1], { departureTime: amAt, mode });
  } catch {
    morning = null;
  }
  try {
    evening = await googleDirections(from[0], from[1], to[0], to[1], { departureTime: pmAt, mode });
  } catch {
    evening = null;
  }
  const distances = mergeKm(morning?.distances, evening?.distances);
  const rushAm = morning?.durationMin ?? null;
  const rushPm = evening?.durationMin ?? null;
  if (!distances.length && rushAm == null && rushPm == null) return null;
  return { distances, rushAm, rushPm };
}
