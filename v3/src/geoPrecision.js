import { CITIES } from "./regions.js";

export const LOCATION_CLASSES = Object.freeze({
  SOURCE: "source",
  ADDRESS: "address",
  COMMUNITY: "community",
  STREET: "street",
  ADMIN: "admin",
  UNKNOWN: "unknown",
});

export const LOCATION_CLASS_RANK = Object.freeze({
  source: 50,
  address: 45,
  community: 40,
  street: 20,
  admin: 5,
  unknown: 0,
});

export const LOCATION_CLASS_LABELS = Object.freeze({
  source: "依來源地圖位置計算",
  address: "依地址位置計算",
  community: "依社區位置估算",
  street: "依路段位置估算",
  admin: "地址僅能定位到行政區，通勤距離待確認",
  unknown: "尚未取得足夠位置資料",
});

export const GEO_FAST_BUDGET_MS = 5_000;
export const GEO_FAST_MAX_EXTERNAL = 1;
export const NOTIFY_BACKOFF_MS = 6 * 60 * 60 * 1000;

export const NOTIFY_DECIDE = Object.freeze({
  WAIT_GEO: "wait_geo",
  WAIT_ROUTE: "wait_route",
  WAIT_PRECISION: "wait_precision",
  READY: "ready",
  SKIP_DISTANCE: "skip_distance",
  WAIT_DATA: "wait_data",
  CANCELLED: "cancelled",
  SUPERSEDED: "superseded",
});

const SOURCE_CLASSES = new Set(["591", "hbhousing", "sinyi", "housefun", "houseprice", "ddroom", "rakuya"]);

let cityNames = null;

function cityNameList() {
  if (cityNames) return cityNames;
  const names = new Set();
  for (const city of CITIES || []) {
    const name = String(city.name || "").trim();
    if (name) names.add(name);
    if (name.startsWith("台")) names.add(`臺${name.slice(1)}`);
    if (name.startsWith("臺")) names.add(`台${name.slice(1)}`);
  }
  names.add("臺北市");
  names.add("台北市");
  cityNames = [...names].sort((a, b) => b.length - a.length);
  return cityNames;
}

export function commuteMetersWithinLimit(meters, kmLimit) {
  const m = Number(meters);
  const km = Number(kmLimit);
  if (!Number.isFinite(m) || m < 0 || !Number.isFinite(km) || km <= 0) return false;
  return m <= km * 1000;
}

export function kmListToMinMeters(routes, fallbackMeters = null) {
  if (Number.isFinite(Number(fallbackMeters)) && Number(fallbackMeters) > 0) return Math.round(Number(fallbackMeters));
  const list = (Array.isArray(routes) ? routes : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!list.length) return null;
  return Math.round(Math.min(...list) * 1000);
}

export function normalizeHouseNumber(value) {
  const raw = String(value || "").replace(/\s+/g, "");
  if (!raw) return "";
  const match = raw.match(/(\d+)\s*[-－—之]\s*(\d+)\s*號?/);
  if (match) return `${match[1]}-${match[2]}號`;
  const plain = raw.match(/(\d+)\s*號/);
  return plain ? `${plain[1]}號` : "";
}

export function parseTaiwanAddressParts(address) {
  let raw = String(address || "").replace(/\s+/g, "").replace(/台北/g, "臺北");
  raw = raw.replace(/(\d+)[-－—](\d+)號/g, "$1-$2號").replace(/(\d+)之(\d+)號/g, "$1-$2號");
  let city = "";
  for (const name of cityNameList()) {
    const norm = name.replace(/台北/g, "臺北");
    if (raw.startsWith(norm) || raw.startsWith(name)) {
      city = norm;
      raw = raw.slice(name.startsWith("台") && raw.startsWith("臺") ? norm.length : name.length);
      break;
    }
  }
  if (!city) {
    for (const name of cityNameList()) {
      const norm = name.replace(/台北/g, "臺北");
      const idx = raw.indexOf(norm) >= 0 ? raw.indexOf(norm) : raw.indexOf(name);
      if (idx >= 0) {
        city = norm;
        raw = raw.slice(idx + (raw.includes(norm) ? norm.length : name.length));
        break;
      }
    }
  }
  const districtMatch = raw.match(/^(.{1,4}[區鄉鎮市])/);
  const district = districtMatch?.[1] || "";
  if (district) raw = raw.slice(district.length);
  const number = normalizeHouseNumber(raw.match(/(\d+(?:-\d+)?)號/)?.[0] || "");
  if (number) raw = raw.replace(/\d+(?:[-－—之]\d+)?號/, "");
  const section = (raw.match(/(\d+)段/) || [])[1] || "";
  const lane = (raw.match(/(\d+)巷/) || [])[1] || "";
  const alley = (raw.match(/(\d+)弄/) || [])[1] || "";
  const road = raw
    .replace(/\d+段/g, "")
    .replace(/\d+巷/g, "")
    .replace(/\d+弄/g, "")
    .replace(/[，,。．.、]/g, "")
    .trim();
  return {
    city: city.replace(/台北/g, "臺北"),
    district,
    road,
    section,
    lane,
    alley,
    number,
    raw: String(address || ""),
  };
}

export function streetCacheKey(parts = {}) {
  const city = String(parts.city || "").replace(/台北/g, "臺北");
  const district = String(parts.district || "");
  const road = String(parts.road || "");
  if (!city || !district || !road) return "";
  return `street:${city}|${district}|${road}|${parts.section || ""}|${parts.lane || ""}|${parts.alley || ""}`;
}

export function houseCacheKey(parts = {}) {
  const street = streetCacheKey(parts);
  if (!street || !parts.number) return "";
  return street.replace(/^street:/, "house:") + `|${parts.number}`;
}

export function addressPartsVersion(parts = {}) {
  return houseCacheKey(parts) || streetCacheKey(parts) || "";
}

export function inferLocationClassFromAddress(address) {
  const parts = parseTaiwanAddressParts(address);
  if (parts.number && parts.road && parts.city && parts.district) return LOCATION_CLASSES.ADDRESS;
  if (parts.road && parts.city && parts.district) return LOCATION_CLASSES.STREET;
  if (parts.city && parts.district) return LOCATION_CLASSES.ADMIN;
  return LOCATION_CLASSES.UNKNOWN;
}

export function resolveLocationClass(listing = {}, override = "") {
  const forced = String(override || listing.location_class || "").trim();
  if (LOCATION_CLASS_RANK[forced] != null) return forced;
  const source = String(listing.geo_source || "");
  if (source === "community") return LOCATION_CLASSES.COMMUNITY;
  if (SOURCE_CLASSES.has(source)) return LOCATION_CLASSES.SOURCE;
  if (source === "geocode") {
    const quality = String(listing.geo_quality || listing.quality || "");
    if (quality === "house" || listing.location_class === "address") return LOCATION_CLASSES.ADDRESS;
    if (quality === "street") return LOCATION_CLASSES.STREET;
    if (quality === "district" || quality === "admin") return LOCATION_CLASSES.ADMIN;
    return inferLocationClassFromAddress(listing.address_used || listing.address);
  }
  return LOCATION_CLASSES.UNKNOWN;
}

export function locationClassLabel(cls) {
  return LOCATION_CLASS_LABELS[String(cls || "")] || LOCATION_CLASS_LABELS.unknown;
}

export function canUseForRoadDistance(cls) {
  return ["source", "address", "community", "street"].includes(String(cls || ""));
}

export function canNotifyByDistance(cls, includeStreetEstimate = false) {
  const kind = String(cls || "");
  if (kind === "source" || kind === "address" || kind === "community") return true;
  if (kind === "street") return includeStreetEstimate === true;
  return false;
}

export function isStreetEstimate(listing = {}) {
  return resolveLocationClass(listing) === LOCATION_CLASSES.STREET;
}

export function listingHasStreetAddress(listing = {}) {
  const parts = parseTaiwanAddressParts(listing.address || listing.address_norm || "");
  return Boolean(parts.city && parts.district && parts.road);
}

export function listingNeedsExternalGeocode(listing = {}) {
  const cls = resolveLocationClass(listing);
  const lat = Number(listing.lat);
  const lng = Number(listing.lng);
  const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  if (hasPin && (cls === "source" || cls === "address" || cls === "community")) return false;
  return true;
}

export function betterLocationClass(nextClass, prevClass) {
  return (LOCATION_CLASS_RANK[nextClass] || 0) > (LOCATION_CLASS_RANK[prevClass] || 0);
}

export function shouldAcceptGeoUpdate(prev = {}, next = {}) {
  const nextCls = resolveLocationClass(next);
  const prevCls = resolveLocationClass(prev);
  const nextVer = Number(next.coord_version || next.address_version || 0);
  const prevVer = Number(prev.coord_version || prev.address_version || 0);
  if (nextVer && prevVer && nextVer < prevVer) return false;
  if (betterLocationClass(nextCls, prevCls)) return true;
  if (nextCls === prevCls && nextVer >= prevVer) return true;
  return false;
}

export function notifyIncludeStreetEstimate(settings = {}) {
  const value = settings.notifyIncludeStreetEstimate;
  return value === true || value === 1 || value === "1";
}

export function effectiveNotifyLocationClass(listing = {}, settings = {}) {
  const listingClass = resolveLocationClass(listing);
  const workClass = String(settings.workLocationClass || "").trim();
  if (LOCATION_CLASS_RANK[workClass] != null && (LOCATION_CLASS_RANK[workClass] || 0) < (LOCATION_CLASS_RANK[listingClass] || 0)) {
    return workClass;
  }
  return listingClass;
}

export function decideNotifyGeo(listing = {}, settings = {}) {
  const commuteOn = Number(settings.commuteKm) > 0;
  if (!commuteOn) return { verdict: "send", decide: NOTIFY_DECIDE.READY, reason: "no_commute_limit" };
  const cls = effectiveNotifyLocationClass(listing, settings);
  const includeStreet = notifyIncludeStreetEstimate(settings);
  if (!canUseForRoadDistance(cls)) {
    return {
      verdict: "pending",
      decide: listingHasStreetAddress(listing) ? NOTIFY_DECIDE.WAIT_GEO : NOTIFY_DECIDE.WAIT_DATA,
      reason: cls === "admin" ? "admin_only" : "no_location",
      location_class: cls,
    };
  }
  const meters = kmListToMinMeters(listing.route_kms, listing.route_min_m);
  if (meters == null) {
    return { verdict: "pending", decide: NOTIFY_DECIDE.WAIT_ROUTE, reason: "wait_route", location_class: cls };
  }
  const within = commuteMetersWithinLimit(meters, settings.commuteKm);
  if (!canNotifyByDistance(cls, includeStreet)) {
    return {
      verdict: "pending",
      decide: NOTIFY_DECIDE.WAIT_PRECISION,
      reason: within ? "street_needs_opt_in" : "street_over_limit_hold",
      location_class: cls,
      approximate: true,
    };
  }
  if (!within) {
    if (cls === "street") {
      return {
        verdict: "pending",
        decide: NOTIFY_DECIDE.WAIT_PRECISION,
        reason: "street_over_limit_hold",
        location_class: cls,
        approximate: true,
      };
    }
    return { verdict: "skip", decide: NOTIFY_DECIDE.SKIP_DISTANCE, reason: "over_limit", location_class: cls };
  }
  return {
    verdict: "send",
    decide: NOTIFY_DECIDE.READY,
    reason: cls === "street" ? "street_estimate" : "ok",
    location_class: cls,
    approximate: cls === "street",
    notify_note: cls === "street" ? "依路段位置估算，實際距離可能不同" : "",
  };
}

export function commutePrecisionText(item = {}, km) {
  const cls = resolveLocationClass(item);
  const job = String(item.geo_job_state || item.commute_state || "");
  if (job === "querying") return "正在查詢位置";
  if (job === "retry" || item.geo_error === "busy") return "定位服務暫時忙碌，稍後重試";
  if (cls === "admin") return LOCATION_CLASS_LABELS.admin;
  if (cls === "unknown" && (km == null || km === "")) {
    return job === "wait_data" ? LOCATION_CLASS_LABELS.unknown : "等待定位";
  }
  if (km != null && km !== "" && canUseForRoadDistance(cls)) {
    return `到公司約 ${km} 公里，${locationClassLabel(cls)}`;
  }
  if (cls === "street" || (canUseForRoadDistance(cls) && (km == null || km === ""))) {
    return "已取得概略位置，正在計算路程";
  }
  return locationClassLabel(cls);
}

export function notifyShouldBackoff(event = {}, now = Date.now()) {
  const created = Date.parse(event?.created_at || "");
  return Number.isFinite(created) && now - created > NOTIFY_BACKOFF_MS;
}

export function mergeChannelJob(prev = {}, patch = {}) {
  const channel = String(patch.channel || prev.channel || "");
  const next = { ...prev, ...patch, channel };
  if (prev.job_state === "accepted" && patch.job_state === "retry") return prev;
  if (patch.job_state === "accepted") {
    next.accepted_at = patch.accepted_at || new Date().toISOString();
    next.fail_reason = "";
  }
  if (patch.job_state === "unknown") {
    next.fail_reason = patch.fail_reason || "timeout_maybe_accepted";
  }
  return next;
}

export function eventFullyHandled(channelJobs = []) {
  if (!channelJobs.length) return false;
  return channelJobs.every((job) => ["accepted", "skipped", "legacy_handled_unknown"].includes(String(job.job_state || "")));
}

export function geoInflightKey(address, scope = "tw", provider = "auto") {
  const parts = parseTaiwanAddressParts(address);
  return `${addressPartsVersion(parts) || String(address || "")}|${scope}|${provider}`;
}

export function providerCityMatches(parts, providerCity = "", providerDistrict = "") {
  const city = String(providerCity || "").replace(/台北/g, "臺北");
  const district = String(providerDistrict || "");
  const hasCjk = (value) => /[\u4e00-\u9fff]/.test(value);
  if (parts.city && city && hasCjk(city) && hasCjk(parts.city) && !city.includes(parts.city) && !parts.city.includes(city)) return false;
  if (parts.district && district && hasCjk(district) && hasCjk(parts.district) && !district.includes(parts.district) && !parts.district.includes(district)) return false;
  return true;
}

export function isTaiwanCoord(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && a > 21.5 && a < 26.5 && b > 118 && b < 123;
}

export function normalizeWorkLocationClass(value) {
  const raw = String(value || "").trim();
  return LOCATION_CLASS_RANK[raw] != null ? raw : "";
}
