const CITY_RE = "臺北市|台北市|新北市|桃園市|基隆市|新竹市";

function parseCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) > 0 ? n : null;
}

export function isTaiwanMapPin(lat, lng) {
  const a = parseCoord(lat);
  const b = parseCoord(lng);
  return a != null && b != null && a > 21.5 && a < 26.5 && b > 118 && b < 123;
}

export function extractMapFromHtml(html) {
  const text = String(html || "");
  if (!text) return null;
  const pairs = [];
  const patterns = [
    /"lat"\s*:\s*"(-?\d+\.\d+)"\s*,\s*"lng"\s*:\s*"(-?\d+\.\d+)"/gi,
    /"lat"\s*:\s*(-?\d+\.\d+)\s*,\s*"lng"\s*:\s*(-?\d+\.\d+)/gi,
    /"lng"\s*:\s*"(-?\d+\.\d+)"\s*,\s*"lat"\s*:\s*"(-?\d+\.\d+)"/gi,
    /"lng"\s*:\s*(-?\d+\.\d+)\s*,\s*"lat"\s*:\s*(-?\d+\.\d+)/gi,
    /data-lat="(-?\d+\.\d+)"[^>]*data-lng="(-?\d+\.\d+)"/gi,
    /query=(-?\d+\.\d+),(-?\d+\.\d+)/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      const swapped = /"lng"\s*:/.test(match[0]) && match[0].indexOf("lng") < match[0].indexOf("lat");
      const lat = swapped ? match[2] : match[1];
      const lng = swapped ? match[1] : match[2];
      if (isTaiwanMapPin(lat, lng)) pairs.push({ lat: Number(lat), lng: Number(lng) });
    }
  }
  if (!pairs.length) return null;
  const address = extractTaiwanStreetAddress(text.replace(/<[^>]+>/g, " "));
  return { ...pairs[0], address };
}

export function hasHouseNumber(address) {
  return /\d+(?:之\d+)?號/.test(String(address || "").replace(/\s+/g, ""));
}

/** 門牌精度：號 > 巷／弄 > 路街 > 行政區。用來決定要不要用較完整地址覆蓋列表粗址。 */
export function addressPrecision(address) {
  const text = String(address || "").replace(/\s+/g, "");
  if (!text) return 0;
  const hasHouse = /\d+(?:之\d+)?號/.test(text);
  const hasAlley = /\d+巷/.test(text) || /\d+弄/.test(text);
  const hasStreet = /[路街道大道]/.test(text);
  if (hasHouse && hasStreet) return 40;
  if (hasHouse) return 35;
  if (hasAlley && hasStreet) return 30;
  if (hasAlley) return 25;
  if (hasStreet) return 10;
  if (/[縣市].*[區鄉鎮]/.test(text) || /[區鄉鎮市]/.test(text)) return 5;
  return 1;
}

export function addressHasPrecisePart(address) {
  return addressPrecision(address) >= 25;
}

export function pickRicherAddress(candidates) {
  const list = (candidates || []).map((value) => String(value || "").trim()).filter(Boolean);
  if (!list.length) return "";
  return list.slice().sort((a, b) => {
    const diff = addressPrecision(b) - addressPrecision(a);
    return diff !== 0 ? diff : b.length - a.length;
  })[0];
}

export function preferListingAddress(incoming, stored, _geoSource = "") {
  const next = String(incoming || "").trim();
  const prev = String(stored || "").trim();
  return pickRicherAddress([next, prev]) || next || prev || "";
}

export function extractTaiwanStreetAddress(text) {
  const raw = String(text || "")
    .replace(/\s+/g, "")
    .replace(/[-－—|｜]/g, "");
  if (!raw) return "";
  const withCity = raw.match(new RegExp(`((?:${CITY_RE})[^<>]{0,40}?\\d+(?:之\\d+)?號)`));
  if (withCity) return withCity[1].replace(/台北市/g, "臺北市");
  const withAlley = raw.match(new RegExp(`((?:${CITY_RE})[^<>]{0,40}?\\d+巷(?:\\d+弄)?)`));
  if (withAlley) return withAlley[1].replace(/台北市/g, "臺北市");
  const withDistrict = raw.match(/((?:臺北|台北|新北|桃園|基隆|新竹)?[^\d<>]{1,20}區[^<>]{1,40}?\d+(?:之\d+)?號)/);
  if (withDistrict) return withDistrict[1].replace(/台北/g, "臺北");
  const districtAlley = raw.match(/((?:臺北|台北|新北|桃園|基隆|新竹)?[^\d<>]{1,20}區[^<>]{1,40}?\d+巷(?:\d+弄)?)/);
  return districtAlley ? districtAlley[1].replace(/台北/g, "臺北") : "";
}

export function formatListingAddress(address, communityName) {
  const addr = String(address || "").trim();
  const name = String(communityName || "").trim();
  if (!name) return addr;
  if (!addr) return name;
  if (addr.includes(name)) return addr;
  return `${name} ${addr}`;
}

/** 來源平台社區名有超連結時，本站改連到該社區的 Google 地圖搜尋。 */
export function communityMapsQuery(communityName, address = "") {
  const name = String(communityName || "").trim().replace(/[／/]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return "";
  const street = extractTaiwanStreetAddress(address) || String(address || "").replace(/\s+/g, "").trim();
  // 有門牌時用地址搜，避免社區別名被 Google 對成附近同名店家／建案。
  if (hasHouseNumber(street)) return street;
  const loc = String(address || "").replace(/\s+/g, "");
  const city = (loc.match(/^(台北市|臺北市|新北市|桃園市|基隆市|新竹市|[^市縣]{1,3}[市縣])/) || [])[0] || "";
  const district = (loc.match(/[市縣]([^\d市縣]{1,4}[區鄉鎮市])/) || [])[1] || "";
  return `${city}${district}${name}`;
}

export function communityMapsUrl(communityName, address = "") {
  const query = communityMapsQuery(communityName, address);
  if (!query) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** 來源有社區頁／社區超連結才算 linked；標題括號或純文字社區名不算。 */
export function sourceCommunityLinked({ communityId = 0, href = "", hasAnchor = false } = {}) {
  if (Number(communityId) > 0) return true;
  if (hasAnchor) return true;
  const link = String(href || "").trim();
  return Boolean(link) && /^https?:\/\//i.test(link);
}

export function communityRefFromDetail(data) {
  const pos = data?.positionRound || {};
  const addr = data?.address && typeof data.address === "object" ? data.address : {};
  const id = Number(pos.communityId || data?.communityId || addr.communityId || data?.community_id) || 0;
  const name = String(pos.communityName || data?.communityName || addr.communityName || data?.community_name || "").trim();
  return { id, name };
}

export function listingAddressFromDetail(data) {
  const addr = data?.address;
  if (typeof addr === "string") return addr.trim();
  const pos = data?.positionRound || {};
  return String(addr?.value || addr?.data || pos.address || "").trim();
}

export function parseCommunityPayload(payload) {
  const comm = payload?.data?.community || payload?.community || {};
  const rawAddress = String(comm.address || comm.full_address || comm.simple_address || "").trim();
  const address = extractTaiwanStreetAddress(rawAddress) || rawAddress.replace(/\s+/g, " ").trim();
  return {
    id: Number(comm.id) || 0,
    name: String(comm.name || "").trim(),
    address,
    lat: parseCoord(comm.lat),
    lng: parseCoord(comm.lng),
  };
}

export function parseCommunityIdFromSourceKey(sourceKey) {
  const bit = String(sourceKey || "").split("|")[2] || "";
  const match = bit.match(/^c(\d+)$/);
  return match ? Number(match[1]) : 0;
}

export function listingCommunityId(listing) {
  const id = Number(listing?.community_id);
  if (Number.isFinite(id) && id > 0) return id;
  return parseCommunityIdFromSourceKey(listing?.source_key);
}

export const TRUSTED_GEO_SOURCES = ["591", "community", "hbhousing", "sinyi", "housefun", "houseprice", "geocode"];

export function isTrustedGeoSource(source) {
  return TRUSTED_GEO_SOURCES.includes(String(source || ""));
}

export function sqlTrustedGeoSource(column = "geo_source") {
  return `IFNULL(${column}, '') IN (${TRUSTED_GEO_SOURCES.map((id) => `'${id}'`).join(", ")})`;
}

export function preferCommunityLocation(listingLoc = {}, communityLoc = null) {
  const listingAddress = String(listingLoc.address || "").trim();
  const listingLat = parseCoord(listingLoc.lat);
  const listingLng = parseCoord(listingLoc.lng);
  const communityId = Number(communityLoc?.id || listingLoc.community_id) || 0;
  const communityName = String(communityLoc?.name || listingLoc.community_name || "").trim();
  const communityAddress = String(communityLoc?.address || "").trim();
  const communityLat = parseCoord(communityLoc?.lat);
  const communityLng = parseCoord(communityLoc?.lng);
  const useCommunityCoords = communityLat != null && communityLng != null;
  const chosenAddress = pickRicherAddress([listingAddress, communityAddress]) || listingAddress || communityAddress;
  return {
    address: formatListingAddress(chosenAddress, communityName),
    lat: useCommunityCoords ? communityLat : listingLat,
    lng: useCommunityCoords ? communityLng : listingLng,
    geo_source: useCommunityCoords ? "community" : listingLat != null && listingLng != null ? "591" : null,
    community_id: communityId,
    community_name: communityName,
  };
}
