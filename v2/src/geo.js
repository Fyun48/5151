import { allDistricts } from "./regions.js";

const MAX_BOXES = 10;
const MAX_SPAN = 0.5;
const FALLBACK_PAD = 0.025;

const CN_NUM = {
  一: "1",
  二: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  七: "7",
  八: "8",
  九: "9",
  十: "10",
};

const DISTRICT_CENTERS = {
  士林區: [25.093, 121.525],
  北投區: [25.132, 121.502],
  大同區: [25.063, 121.515],
  中山區: [25.068, 121.533],
  松山區: [25.063, 121.557],
  大安區: [25.026, 121.543],
  信義區: [25.033, 121.565],
  內湖區: [25.083, 121.59],
  南港區: [25.055, 121.607],
  中正區: [25.032, 121.518],
  萬華區: [25.035, 121.499],
  文山區: [24.989, 121.57],
  五股區: [25.083, 121.438],
  蘆洲區: [25.089, 121.474],
  八里區: [25.146, 121.399],
  淡水區: [25.169, 121.443],
  板橋區: [25.011, 121.462],
  三重區: [25.062, 121.487],
  中和區: [24.999, 121.509],
  永和區: [25.008, 121.513],
  新莊區: [25.036, 121.45],
  新店區: [24.967, 121.542],
};

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

export function hasActiveBoxes(boxes) {
  return normalizeBoxes(boxes).some((box) => box.enabled !== false);
}

export function parseWorkCoord(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

export function hasWorkPoint(settings = {}) {
  return parseWorkCoord(settings.workLat) != null && parseWorkCoord(settings.workLng) != null;
}

export function needsListingGeo(settings = {}) {
  const commuteOn = Number(settings.commuteKm) > 0 && hasWorkPoint(settings);
  return commuteOn || hasActiveBoxes(settings.excludeBoxes);
}

export function commuteWorkJobs(settingsList) {
  const seen = new Set();
  const out = [];
  for (const settings of settingsList || []) {
    if (!(Number(settings?.commuteKm) > 0) || !hasWorkPoint(settings)) continue;
    const workLat = Number(settings.workLat);
    const workLng = Number(settings.workLng);
    const key = `${workLat},${workLng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ workLat, workLng, commuteKm: Number(settings.commuteKm) });
  }
  return out;
}

export function districtsNearBoxes(boxes) {
  const active = normalizeBoxes(boxes).filter((box) => box.enabled !== false);
  if (!active.length) return [];
  const pad = 0.06;
  const names = [];
  for (const [name, pair] of Object.entries(DISTRICT_CENTERS)) {
    const [lat, lng] = pair;
    if (
      active.some(
        (box) =>
          lat >= box.south - pad &&
          lat <= box.north + pad &&
          lng >= box.west - pad &&
          lng <= box.east + pad,
      )
    ) {
      names.push(name);
    }
  }
  return names;
}

export function addressGeoScore(address, nearDistricts = []) {
  const text = String(address || "");
  let score = 0;
  if (/\d+(?:之\d+)?號/.test(text)) score += 4;
  if (/巷/.test(text)) score += 2;
  if (/段/.test(text)) score += 1;
  for (const name of nearDistricts) {
    const shortName = String(name || "").replace(/區$/, "");
    if (shortName && (text.includes(name) || text.includes(shortName))) score += 8;
  }
  return score;
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

export function coordsFrom591Detail(data) {
  const addr = data?.address || {};
  const surround = data?.surround || {};
  const pos = data?.positionRound || {};
  return coordsFromListing({
    lat: addr.lat ?? surround.lat ?? pos.lat,
    lng: addr.lng ?? surround.lng ?? pos.lng ?? addr.lon ?? pos.lon,
  });
}

export function distanceKm(lat1, lng1, lat2, lng2) {
  const a = Number(lat1);
  const b = Number(lng1);
  const c = Number(lat2);
  const d = Number(lng2);
  if (![a, b, c, d].every(Number.isFinite)) return null;
  const toRad = (n) => (n * Math.PI) / 180;
  const dLat = toRad(c - a);
  const dLng = toRad(d - b);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const DISTRICT_CITY = new Map();

function cityForDistrict(district) {
  if (!DISTRICT_CITY.size) {
    for (const item of allDistricts()) {
      DISTRICT_CITY.set(item.name, item.city === "台北市" ? "臺北市" : item.city);
    }
  }
  return DISTRICT_CITY.get(district) || "";
}

function withArabicSections(text) {
  return String(text || "").replace(/[一二三四五六七八九十]+段/g, (chunk) => {
    const body = chunk.slice(0, -1);
    if (body === "十") return "10段";
    if (body.length === 1 && CN_NUM[body]) return `${CN_NUM[body]}段`;
    if (body.startsWith("十") && body.length === 2) {
      return `${10 + Number(CN_NUM[body[1]] || 0)}段`;
    }
    return `${[...body].map((ch) => CN_NUM[ch] || "").join("")}段`;
  });
}

function parseTaiwanAddress(address) {
  let raw = String(address || "")
    .replace(/\s+/g, "")
    .replace(/[-－—]/g, "")
    .replace(/台北/g, "臺北");
  const cityMatch = raw.match(/^(臺北市|新北市|桃園市|基隆市|新竹市)/);
  let city = cityMatch?.[1] || "";
  let rest = city ? raw.slice(city.length) : raw;
  const districtMatch = rest.match(/^(.{1,3}區)/);
  const district = districtMatch?.[1] || "";
  if (district) rest = rest.slice(district.length);
  if (!city && district) city = cityForDistrict(district);
  const numberMatch = rest.match(/(\d+(?:之\d+)?號)$/);
  const number = numberMatch?.[1] || "";
  if (number) rest = rest.slice(0, -number.length);
  return {
    raw,
    city,
    district,
    road: withArabicSections(rest) || raw,
    number,
  };
}

function geocodeQueries(address, cityHint = "") {
  const parsed = parseTaiwanAddress(address);
  if (!parsed.city && cityHint) {
    parsed.city = String(cityHint).replace(/台北/g, "臺北");
  }
  const out = [];
  const push = (value) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text && !out.includes(text)) out.push(text);
  };
  const compact = (road) => [parsed.city, parsed.district, road, parsed.number].filter(Boolean).join("");
  push(compact(parsed.road));
  if (!parsed.number && /\d+弄/.test(parsed.road)) {
    push(compact(parsed.road.replace(/\d+弄.*$/, "")));
  }
  if (!parsed.number && /\d+巷/.test(parsed.road)) {
    push(compact(parsed.road.replace(/\d+(?:巷|弄).*$/, "")));
  }
  push([parsed.road, parsed.number, parsed.district, parsed.city].filter(Boolean).join(", ").replace(/, ,/g, ","));
  if (parsed.road && parsed.city) push(`${parsed.road}${parsed.number}, ${parsed.district}, ${parsed.city}`.replace(/, ,/g, ","));
  if (parsed.road && !parsed.city) {
    push(`${parsed.road}, 臺北市`);
    push(`${parsed.road}, 新北市`);
  }
  return { parsed, queries: out.filter(Boolean).slice(0, 4) };
}

function photonQueries(parsed) {
  const out = [];
  const push = (value) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text && !out.includes(text)) out.push(text);
  };
  const street = [parsed.road, parsed.number].filter(Boolean).join(" ");
  push([street, parsed.district, parsed.city].filter(Boolean).join(", "));
  push([street, parsed.district].filter(Boolean).join(", "));
  push([parsed.road, parsed.district, parsed.city].filter(Boolean).join(", "));
  return out.slice(0, 3);
}

let lastNominatimAt = 0;
const GEO_UA = "591-tracker/1.0 (personal rental watcher; acefengyun@gmail.com)";

async function photonSearch(query) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "1");
  const res = await fetch(url, {
    headers: {
      "User-Agent": GEO_UA,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 429 || res.status === 503) return { busy: true };
  if (!res.ok) return null;
  const body = await res.json();
  const coords = body?.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lat = Number(coords[1]);
  const lng = Number(coords[0]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function nominatimSearch(params) {
  const wait = 1200 - (Date.now() - lastNominatimAt);
  if (wait > 0) await sleep(wait);
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "tw");
  url.searchParams.set("addressdetails", "0");
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  lastNominatimAt = Date.now();
  const res = await fetch(url, {
    headers: {
      "User-Agent": GEO_UA,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  return res;
}

export async function geocodeAddress(address, lookup, options = {}) {
  const text = geoKey(address);
  if (!text) return null;
  const cached = lookup?.(address) || lookup?.(text);
  if (cached) return cached;
  const { parsed, queries } = geocodeQueries(address, options.cityHint);
  let busy = false;

  for (const query of photonQueries(parsed)) {
    try {
      const hit = await photonSearch(query);
      if (hit?.busy) {
        busy = true;
        continue;
      }
      if (hit?.lat != null) return hit;
    } catch {
      // Photon 逾時就改試下一組
    }
  }

  if (options.skipNominatim) {
    if (options.strict && busy) throw new Error("地圖定位服務暫時忙碌，請稍後再試");
    return null;
  }

  const attempts = [];
  if (parsed.road && parsed.number && !/[巷弄]/.test(parsed.road)) {
    attempts.push({
      street: `${parsed.road} ${parsed.number}`.trim(),
      city: parsed.district,
      county: parsed.city || "臺灣",
      country: "Taiwan",
    });
  }
  for (const query of queries) attempts.push({ q: query });
  const maxAttempts = Math.max(1, Math.min(Number(options.maxAttempts) || 2, attempts.length));

  let lastStatus = 200;
  for (let i = 0; i < maxAttempts; i += 1) {
    let res;
    try {
      res = await nominatimSearch(attempts[i]);
    } catch {
      lastStatus = 0;
      continue;
    }
    lastStatus = res.status;
    if (res.status === 429 || res.status === 503) {
      busy = true;
      break;
    }
    if (!res.ok) continue;
    const rows = await res.json();
    const hit = rows?.[0];
    if (hit) return { lat: Number(hit.lat), lng: Number(hit.lon) };
  }
  if (options.strict) {
    if (busy) throw new Error("地圖定位服務暫時忙碌，請稍後再試");
    if (lastStatus && lastStatus !== 200) throw new Error(`地圖定位失敗（HTTP ${lastStatus}）`);
  }
  return null;
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
  for (const road of uniqueRoads) {
    const cached = options.lookup?.(road) || options.lookup?.(geoKey(road));
    let geo = cached;
    if (!geo) {
      geo = await geocodeAddress(road, options.lookup, { cityHint: "臺北市" });
    }
    if (!geo) {
      geo = await geocodeAddress(road, options.lookup, { cityHint: "新北市", strict: true });
    }
    if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) {
      throw new Error(`找不到路名「${road}」，請改成較完整的路名（例如加上路／街／段，或寫士林區承德路）再試`);
    }
    if (!cached) {
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
