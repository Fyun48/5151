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

export function makeRouteKey(fromLat, fromLng, toLat, toLng) {
  return `${roundCoord(fromLat)},${roundCoord(fromLng)}>${roundCoord(toLat)},${roundCoord(toLng)}`;
}

export async function fetchRoadRoutes(fromLat, fromLng, toLat, toLng) {
  const from = [Number(fromLat), Number(fromLng)];
  const to = [Number(toLat), Number(toLng)];
  if (!from.every(Number.isFinite) || !to.every(Number.isFinite)) return null;
  try {
    const osrm = await osrmRoutes(from[0], from[1], to[0], to[1]);
    if (osrm?.busy) return null;
    return osrm?.length ? osrm : null;
  } catch {
    return null;
  }
}
