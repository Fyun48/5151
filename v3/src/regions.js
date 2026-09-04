export const CITIES = [
  {
    id: 1,
    name: "台北市",
    districts: [
      { id: 8, name: "士林區" },
      { id: 9, name: "北投區" },
      { id: 2, name: "大同區" },
      { id: 3, name: "中山區" },
      { id: 4, name: "松山區" },
      { id: 5, name: "大安區" },
      { id: 7, name: "信義區" },
      { id: 10, name: "內湖區" },
      { id: 11, name: "南港區" },
      { id: 1, name: "中正區" },
      { id: 6, name: "萬華區" },
      { id: 12, name: "文山區" },
    ],
  },
  {
    id: 3,
    name: "新北市",
    districts: [
      { id: 48, name: "五股區" },
      { id: 47, name: "蘆洲區" },
      { id: 49, name: "八里區" },
      { id: 50, name: "淡水區" },
      { id: 26, name: "板橋區" },
      { id: 43, name: "三重區" },
      { id: 38, name: "中和區" },
      { id: 37, name: "永和區" },
      { id: 44, name: "新莊區" },
      { id: 34, name: "新店區" },
      { id: 39, name: "土城區" },
      { id: 27, name: "汐止區" },
      { id: 46, name: "林口區" },
      { id: 45, name: "泰山區" },
      { id: 41, name: "樹林區" },
      { id: 40, name: "三峽區" },
      { id: 42, name: "鶯歌區" },
      { id: 51, name: "三芝區" },
    ],
  },
];

const DISTRICT_INDEX = new Map();
for (const city of CITIES) {
  for (const district of city.districts) {
    DISTRICT_INDEX.set(`${city.id}-${district.id}`, { ...district, region: city.id, city: city.name });
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
  for (const district of districts) {
    if (hay.includes(district.name)) return district.name;
  }
  // 591 地址有時只寫「五股成泰路」「八里龍形路」沒有「區」
  for (const district of districts) {
    const short = district.name.replace(/區$/, "");
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
