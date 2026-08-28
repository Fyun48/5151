const MAX_BOXES = 10;
const MAX_SPAN = 0.5;
const FALLBACK_PAD = 0.025;

const DIR_PATTERN =
  "以東側|以西側|以南側|以北側|以東|以西|以南|以北|之東|之西|之南|之北|東側|西側|南側|北側|東邊|西邊|南邊|北邊";

const DIR_MAP = {
  以東側: "east",
  以東: "east",
  之東: "east",
  東側: "east",
  東邊: "east",
  以西側: "west",
  以西: "west",
  之西: "west",
  西側: "west",
  西邊: "west",
  以南側: "south",
  以南: "south",
  之南: "south",
  南側: "south",
  南邊: "south",
  以北側: "north",
  以北: "north",
  之北: "north",
  北側: "north",
  北邊: "north",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function geoKey(address) {
  return String(address || "").replace(/\s+/g, "").replace(/-/g, "");
}

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
    if (north2 - south2 > MAX_SPAN || east2 - west2 > MAX_SPAN) continue;
    const source = raw.source === "text" ? "text" : "draw";
    boxes.push({
      id: String(raw.id || `box-${boxes.length + 1}`),
      name: String(raw.name || `範圍 ${boxes.length + 1}`).slice(0, 20),
      south: south2,
      west: west2,
      north: north2,
      east: east2,
      enabled: raw.enabled !== false,
      description: String(raw.description || "").slice(0, 200),
      source,
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

export function isExcludedByAgent(listing, settings = {}) {
  const ids = (settings.excludeAgentIds || []).map(Number).filter((id) => id > 0);
  if (listing.contact_uid && ids.includes(Number(listing.contact_uid))) return true;
  const terms = normalizeKeywords(settings.excludeAgents).filter((term) => term.length >= 2);
  if (!terms.length) return false;
  const hay = `${listing.contact_name || ""} ${listing.agency || ""} ${listing.role_name || ""} ${listing.contact_role || ""}`.toLowerCase();
  return terms.some((term) => hay.includes(term.toLowerCase()));
}

export function isExcludedByBox(lat, lng, boxes) {
  if (lat == null || lng == null || lat === "" || lng === "") return false;
  const nlat = Number(lat);
  const nlng = Number(lng);
  if (!Number.isFinite(nlat) || !Number.isFinite(nlng)) return false;
  return normalizeBoxes(boxes).some(
    (box) =>
      box.enabled !== false &&
      nlat >= box.south &&
      nlat <= box.north &&
      nlng >= box.west &&
      nlng <= box.east,
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

export async function geocodeAddress(address, lookup, options = {}) {
  const text = geoKey(address);
  if (!text) return null;
  const cached = lookup?.(text);
  if (cached) return cached;
  const query = encodeURIComponent(`台北市${text}`);
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=tw&q=${query}`, {
    headers: {
      "User-Agent": "591-tracker/1.0 (personal rental watcher)",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    if (options.strict) {
      if (res.status === 429) throw new Error("地圖定位服務暫時忙碌，請稍後再試");
      throw new Error(`地圖定位失敗（HTTP ${res.status}）`);
    }
    return null;
  }
  const rows = await res.json();
  const hit = rows?.[0];
  if (!hit) return null;
  return { lat: Number(hit.lat), lng: Number(hit.lon) };
}

function cleanRoadName(value) {
  return String(value || "")
    .replace(/^台北市/, "")
    .replace(/^(範圍為|範圍是|區域為|排除|位於|在於|在)/, "")
    .replace(/^(以及|還有|和|與|及|且)\s*/, "")
    .replace(/[的於]\s*$/g, "")
    .replace(/[,，、;；\s]+/g, "")
    .trim();
}

export function parseRegionText(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const re = new RegExp(`([^,，、;；\\n]+?)(${DIR_PATTERN})`, "g");
  const out = [];
  const seen = new Set();
  let match;
  while ((match = re.exec(raw)) !== null) {
    const road = cleanRoadName(match[1]);
    const dir = DIR_MAP[match[2]];
    if (!road || road.length < 2 || !dir) continue;
    const key = `${road}:${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ road, dir, label: match[2] });
  }
  return out;
}

function boundsFromConstraints(parts, coords) {
  let west;
  let east;
  let south;
  let north;
  const lats = [];
  const lngs = [];
  for (const part of parts) {
    const geo = coords[part.road];
    if (!geo) continue;
    lats.push(geo.lat);
    lngs.push(geo.lng);
    if (part.dir === "east") west = west == null ? geo.lng : Math.max(west, geo.lng);
    if (part.dir === "west") east = east == null ? geo.lng : Math.min(east, geo.lng);
    if (part.dir === "south") north = north == null ? geo.lat : Math.min(north, geo.lat);
    if (part.dir === "north") south = south == null ? geo.lat : Math.max(south, geo.lat);
  }
  if (!lats.length) {
    throw new Error("沒有可用的路名座標");
  }
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const midLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  if (west == null) west = east != null ? east - FALLBACK_PAD : midLng - FALLBACK_PAD;
  if (east == null) east = west + FALLBACK_PAD;
  if (south == null) south = north != null ? north - FALLBACK_PAD : midLat - FALLBACK_PAD;
  if (north == null) north = south + FALLBACK_PAD;
  if (!(west < east) || !(south < north)) {
    throw new Error("路名方位互相衝突，無法形成合理範圍。請檢查以東／以西、以南／以北是否寫反");
  }
  if (north - south > MAX_SPAN || east - west > MAX_SPAN) {
    throw new Error("算出的範圍太大（跨度超過 0.5 度），請改成較近的路名再試");
  }
  if (north - south < 0.0003 || east - west < 0.0003) {
    throw new Error("算出的範圍太小，請再補一個相對方位");
  }
  return { south, west, north, east };
}

export async function boxFromRoadDescription(text, options = {}) {
  const description = String(text || "").trim();
  const parts = parseRegionText(description);
  if (!parts.length) {
    throw new Error("無法解析範圍文字。請用「路名以東、路名以西、路名以南、路名以北」");
  }
  const uniqueRoads = [...new Set(parts.map((part) => part.road))];
  const coords = {};
  let fetched = 0;
  for (const road of uniqueRoads) {
    const cached = options.lookup?.(geoKey(road));
    if (!cached && fetched > 0) await sleep(1100);
    const geo = cached || (await geocodeAddress(road, options.lookup, { strict: true }));
    if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) {
      throw new Error(`找不到路名「${road}」，請改成較完整的路名（例如加上路／街／段）再試`);
    }
    if (!cached) {
      fetched += 1;
      options.save?.(road, geo.lat, geo.lng);
    }
    coords[road] = geo;
  }
  const bounds = boundsFromConstraints(parts, coords);
  const name = parts
    .map((part) => `${part.road}${part.label}`)
    .join(" ")
    .slice(0, 20);
  return {
    id: `box-${Date.now()}`,
    name: name || "文字範圍",
    ...bounds,
    enabled: true,
    description: description.slice(0, 200),
    source: "text",
  };
}
