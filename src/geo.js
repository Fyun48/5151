const MAX_BOXES = 10;

export const SHEZIDAO_BOX = {
  id: "shezidao",
  name: "社子島",
  south: 25.102,
  west: 121.457,
  north: 25.123,
  east: 121.488,
};

export function normalizeKeywords(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\n,，]/)
        .map((item) => item.trim())
        .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 40);
}

export function normalizeBoxes(value) {
  const list = Array.isArray(value) ? value : [];
  const boxes = [];
  for (const raw of list) {
    const south = Number(raw.south);
    const west = Number(raw.west);
    const north = Number(raw.north);
    const east = Number(raw.east);
    if (![south, west, north, east].every(Number.isFinite)) continue;
    const south2 = Math.min(south, north);
    const north2 = Math.max(south, north);
    const west2 = Math.min(west, east);
    const east2 = Math.max(west, east);
    if (north2 - south2 < 0.0003 || east2 - west2 < 0.0003) continue;
    if (north2 - south2 > 0.5 || east2 - west2 > 0.5) continue;
    boxes.push({
      id: String(raw.id || `box-${boxes.length + 1}`),
      name: String(raw.name || `範圍 ${boxes.length + 1}`).slice(0, 20),
      south: south2,
      west: west2,
      north: north2,
      east: east2,
    });
    if (boxes.length >= MAX_BOXES) break;
  }
  return boxes;
}

export function isExcludedByKeyword(listing, keywords) {
  const terms = normalizeKeywords(keywords).filter((term) => term.length >= 2);
  if (!terms.length) return false;
  const hay = `${listing.title || ""} ${listing.address || ""} ${listing.area_name || ""}`.toLowerCase();
  return terms.some((term) => hay.includes(term.toLowerCase()));
}

export function isExcludedByBox(lat, lng, boxes) {
  if (lat == null || lng == null || lat === "" || lng === "") return false;
  const nlat = Number(lat);
  const nlng = Number(lng);
  if (!Number.isFinite(nlat) || !Number.isFinite(nlng)) return false;
  return normalizeBoxes(boxes).some(
    (box) => nlat >= box.south && nlat <= box.north && nlng >= box.west && nlng <= box.east,
  );
}

function parseCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) > 0 ? n : null;
}

export function coordsFromListing(item) {
  const lat = parseCoord(item.lat ?? item.latitude ?? item.gps_lat);
  const lng = parseCoord(item.lng ?? item.longitude ?? item.lon ?? item.gps_lng);
  if (lat != null && lng != null) return { lat, lng };
  return { lat: null, lng: null };
}

export async function geocodeAddress(address, lookup) {
  const text = String(address || "").replace(/\s+/g, "").replace(/-/g, "");
  if (!text) return null;
  const cached = lookup?.(text);
  if (cached) return cached;
  const query = encodeURIComponent(`台北市${text}`);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${query}`, {
    headers: {
      "User-Agent": "591-tracker/1.0 (personal rental watcher)",
      Accept: "application/json",
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const hit = rows?.[0];
  if (!hit) return null;
  return { lat: Number(hit.lat), lng: Number(hit.lon) };
}
