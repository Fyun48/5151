import { parsePriceParam } from "./regions.js";

function numIds(values) {
  return [...new Set((values || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))].sort((a, b) => a - b);
}

function priceBound(value) {
  const n = Number(value) || 0;
  return n > 0 ? n : 0;
}

export function parseCoverFromSearchUrl(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    const regionId = Number(url.searchParams.get("regionid") || url.searchParams.get("region") || 0);
    const sectionIds = numIds(String(url.searchParams.get("section") || "").split(","));
    const price = parsePriceParam(url.searchParams.get("price") || url.searchParams.get("rentprice") || "");
    return {
      regionId: Number.isFinite(regionId) && regionId > 0 ? regionId : 0,
      sectionIds,
      priceMin: price.min,
      priceMax: price.max,
    };
  } catch {
    return { regionId: 0, sectionIds: [], priceMin: 0, priceMax: 0 };
  }
}

export function coverContains(existing, member) {
  if (!existing || !member) return false;
  if (Number(existing.regionId) !== Number(member.regionId) || Number(member.regionId) <= 0) return false;

  const have = numIds(existing.sectionIds);
  const want = numIds(member.sectionIds);
  if (have.length) {
    if (!want.length) return false;
    if (want.some((id) => !have.includes(id))) return false;
  }

  const haveMin = priceBound(existing.priceMin);
  const haveMax = priceBound(existing.priceMax);
  const wantMin = priceBound(member.priceMin);
  const wantMax = priceBound(member.priceMax);
  if (haveMin > wantMin) return false;
  if (wantMax === 0 && haveMax !== 0) return false;
  if (wantMax > 0 && haveMax > 0 && haveMax < wantMax) return false;
  return true;
}

export function mergeCovers(covers) {
  const groups = new Map();
  for (const raw of covers || []) {
    const regionId = Number(raw?.regionId) || 0;
    if (regionId <= 0) continue;
    const current = groups.get(regionId) || {
      regionId,
      sectionIds: null,
      priceMin: null,
      priceMax: null,
    };
    const sections = numIds(raw.sectionIds);
    if (current.sectionIds === null) current.sectionIds = sections;
    else if (!current.sectionIds.length || !sections.length) current.sectionIds = [];
    else current.sectionIds = numIds([...current.sectionIds, ...sections]);

    const min = priceBound(raw.priceMin);
    const max = priceBound(raw.priceMax);
    current.priceMin = current.priceMin == null ? min : min === 0 || current.priceMin === 0 ? 0 : Math.min(current.priceMin, min);
    current.priceMax = current.priceMax == null ? max : max === 0 || current.priceMax === 0 ? 0 : Math.max(current.priceMax, max);
    groups.set(regionId, current);
  }
  return [...groups.values()].map((item) => ({
    regionId: item.regionId,
    sectionIds: item.sectionIds || [],
    priceMin: item.priceMin || 0,
    priceMax: item.priceMax || 0,
  }));
}

export function isCoveredByJobs(member, jobs) {
  return (jobs || []).some((job) => coverContains(job, member));
}

export function uncoveredMembers(members, jobs) {
  return (members || []).filter((member) => !isCoveredByJobs(member, jobs));
}
