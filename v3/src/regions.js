import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CITIES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/cities.json"), "utf8"),
);

const DISTRICT_INDEX = new Map();
const DISTRICT_NAME_COUNTS = new Map();
for (const city of CITIES) {
  for (const district of city.districts) {
    DISTRICT_INDEX.set(`${city.id}-${district.id}`, { ...district, region: city.id, city: city.name });
    DISTRICT_NAME_COUNTS.set(district.name, (DISTRICT_NAME_COUNTS.get(district.name) || 0) + 1);
  }
}

export function districtKey(region, section) {
  return `${Number(region)}-${Number(section)}`;
}

export function allDistricts() {
  return [...DISTRICT_INDEX.values()];
}

export function lookupDistrict(key) {
  return DISTRICT_INDEX.get(String(key)) || null;
}

export function normalizeWatchDistricts(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const key = String(raw || "").trim();
    if (!DISTRICT_INDEX.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function districtFromRegionSection(region, section) {
  const key = districtKey(region, section);
  return DISTRICT_INDEX.get(key)?.name || "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function districtNameFromListing(listing) {
  const fromIds = districtFromRegionSection(
    listing?.regionid ?? listing?.region_id,
    listing?.sectionid ?? listing?.section_id,
  );
  if (fromIds) return fromIds;

  const bits = String(listing?.source_key || "").split("|");
  if (bits.length >= 2 && bits[0] !== "" && bits[1] !== "") {
    const fromKey = districtFromRegionSection(bits[0], bits[1]);
    if (fromKey) return fromKey;
  }

  const hay = `${listing?.address || ""}${listing?.title || ""}`;
  if (!hay) return "";
  const districts = [...DISTRICT_INDEX.values()].sort((a, b) => b.name.length - a.name.length);
  for (const city of CITIES) {
    if (!hay.includes(city.name)) continue;
    const inCity = districts.filter((row) => row.region === city.id);
    for (const district of inCity) {
      if (hay.includes(district.name)) return district.name;
    }
    for (const district of inCity) {
      const short = district.name.replace(/[區市鄉鎮]$/, "");
      if (short.length < 2) continue;
      const re = new RegExp(
        `${escapeRegExp(city.name)}${escapeRegExp(short)}|${escapeRegExp(short)}(?:區|[路街巷弄大道里村])`,
      );
      if (re.test(hay)) return district.name;
    }
  }
  for (const district of districts) {
    if ((DISTRICT_NAME_COUNTS.get(district.name) || 0) !== 1) continue;
    if (hay.includes(district.name)) return district.name;
  }
  // 591 地址有時只寫「五股成泰路」「八里龍形路」沒有「區」
  for (const district of districts) {
    if ((DISTRICT_NAME_COUNTS.get(district.name) || 0) !== 1) continue;
    const short = district.name.replace(/[區市鄉鎮]$/, "");
    if (short.length < 2) continue;
    const re = new RegExp(
      `(?:^|[市])${escapeRegExp(short)}|${escapeRegExp(short)}(?:區|[路街巷弄大道里村])`,
    );
    if (re.test(hay)) return district.name;
  }
  return "";
}

function priceParam(min, max) {
  const lo = Number(min) > 0 ? String(Math.round(Number(min))) : "";
  const hi = Number(max) > 0 ? String(Math.round(Number(max))) : "";
  if (!lo && !hi) return "";
  return `${lo}_${hi}`;
}

export function parsePriceParam(raw) {
  const text = String(raw || "").replaceAll("$", "").trim();
  if (!text) return { min: 0, max: 0 };
  const [lo, hi] = text.split("_");
  return {
    min: Number(lo) > 0 ? Number(lo) : 0,
    max: Number(hi) > 0 ? Number(hi) : 0,
  };
}

export function districtsFromSearchUrls(urls) {
  const out = [];
  for (const raw of urls || []) {
    try {
      const url = new URL(String(raw).trim());
      const region = url.searchParams.get("regionid") || url.searchParams.get("region") || "";
      const section = url.searchParams.get("section") || "";
      for (const id of section.split(",")) {
        const key = districtKey(region, id);
        if (DISTRICT_INDEX.has(key)) out.push(key);
      }
    } catch {
      // ignore
    }
  }
  return normalizeWatchDistricts(out);
}

export function priceFromSearchUrls(urls) {
  for (const raw of urls || []) {
    try {
      const url = new URL(String(raw).trim());
      const price = url.searchParams.get("price") || url.searchParams.get("rentprice") || "";
      const parsed = parsePriceParam(price);
      if (parsed.min || parsed.max) return parsed;
    } catch {
      // ignore
    }
  }
  return { min: 0, max: 0 };
}

export function buildSearchUrls({
  districts,
  priceMin = 0,
  priceMax = 0,
  excludeRooftop = false,
} = {}) {
  const selected = normalizeWatchDistricts(districts);
  const grouped = new Map();
  for (const key of selected) {
    const hit = DISTRICT_INDEX.get(key);
    if (!hit) continue;
    const list = grouped.get(hit.region) || [];
    list.push(hit.id);
    grouped.set(hit.region, list);
  }
  const price = priceParam(priceMin, priceMax);
  const urls = [];
  for (const [region, sections] of grouped) {
    const params = new URLSearchParams();
    params.set("region", String(region));
    params.set("section", [...new Set(sections)].sort((a, b) => a - b).join(","));
    if (price) params.set("price", price);
    if (excludeRooftop === true) params.set("notice", "not_cover");
    urls.push(`https://rent.591.com.tw/list?${params}`);
  }
  return urls;
}
