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

export function extractTaiwanStreetAddress(text) {
  const raw = String(text || "")
    .replace(/\s+/g, "")
    .replace(/[-－—|｜]/g, "");
  if (!raw) return "";
  const withCity = raw.match(new RegExp(`((?:${CITY_RE})[^<>]{0,40}?\\d+(?:之\\d+)?號)`));
  if (withCity) return withCity[1].replace(/台北市/g, "臺北市");
  const withDistrict = raw.match(/((?:臺北|台北|新北|桃園|基隆|新竹)?[^\d<>]{1,20}區[^<>]{1,40}?\d+(?:之\d+)?號)/);
  return withDistrict ? withDistrict[1].replace(/台北/g, "臺北") : "";
}

export function formatListingAddress(address, communityName) {
  const addr = String(address || "").trim();
  const name = String(communityName || "").trim();
  if (!name) return addr;
  if (!addr) return name;
  if (addr.includes(name)) return addr;
  return `${name} ${addr}`;
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

export const TRUSTED_GEO_SOURCES = ["591", "community", "hbhousing"];

export function isTrustedGeoSource(source) {
  return TRUSTED_GEO_SOURCES.includes(String(source || ""));
}

export function sqlTrustedGeoSource() {
  return `IFNULL(geo_source, '') IN (${TRUSTED_GEO_SOURCES.map((id) => `'${id}'`).join(", ")})`;
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
  const chosenAddress = communityAddress || listingAddress;
  return {
    address: formatListingAddress(chosenAddress, communityName),
    lat: useCommunityCoords ? communityLat : listingLat,
    lng: useCommunityCoords ? communityLng : listingLng,
    geo_source: useCommunityCoords ? "community" : listingLat != null && listingLng != null ? "591" : null,
    community_id: communityId,
    community_name: communityName,
  };
}
