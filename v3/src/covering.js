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

function coversFromWatchDistricts(settings = {}) {
  const grouped = new Map();
  for (const key of settings.watchDistricts || []) {
    const [regionRaw, sectionRaw] = String(key).split("-");
    const regionId = Number(regionRaw);
    const sectionId = Number(sectionRaw);
    if (!(regionId > 0) || !(sectionId > 0)) continue;
    const list = grouped.get(regionId) || [];
    list.push(sectionId);
    grouped.set(regionId, list);
  }
  return [...grouped.entries()].map(([regionId, sectionIds]) => ({
    regionId,
    sectionIds: numIds(sectionIds),
    priceMin: priceBound(settings.priceMin),
    priceMax: priceBound(settings.priceMax),
  }));
}

/** 單一會員目前的搜尋條件：網址與行政區／租金上限都算進覆蓋。 */
export function coversFromMemberSettings(settings = {}) {
  const covers = [];
  for (const raw of settings.searchUrls || []) {
    const cover = parseCoverFromSearchUrl(raw);
    if (cover.regionId > 0) covers.push(cover);
  }
  covers.push(...coversFromWatchDistricts(settings));
  return covers;
}

export function coverToListUrl(cover, { excludeRooftop = true } = {}) {
  const regionId = Number(cover?.regionId) || 0;
  if (regionId <= 0) return "";
  const params = new URLSearchParams();
  params.set("region", String(regionId));
  const sections = numIds(cover.sectionIds);
  if (sections.length) params.set("section", sections.join(","));
  const lo = Number(cover.priceMin) > 0 ? String(Math.round(Number(cover.priceMin))) : "";
  const hi = Number(cover.priceMax) > 0 ? String(Math.round(Number(cover.priceMax))) : "";
  if (lo || hi) params.set("price", `${lo}_${hi}`);
  if (excludeRooftop !== false) params.set("notice", "not_cover");
  params.set("order", "posttime");
  params.set("orderType", "desc");
  return `https://rent.591.com.tw/list?${params}`;
}

export function coveringJobsFromMembers(members, { excludeRooftop = true } = {}) {
  return mergeCovers(members)
    .map((job) => ({
      ...job,
      searchUrl: coverToListUrl(job, { excludeRooftop }),
    }))
    .filter((job) => job.searchUrl);
}

export function coveringJobsFromSettings(settings = {}) {
  return coveringJobsFromMembers(coversFromMemberSettings(settings), {
    excludeRooftop: settings.excludeRooftop !== false,
  });
}

/** 刊登是否落在這個會員自己的縣市／行政區／租金範圍（不是全站覆蓋）。 */
export function listingInMemberScope(listing, settings = {}) {
  const covers = coversFromMemberSettings(settings);
  if (!covers.length) return false;
  const bits = String(listing?.source_key || "").split("|");
  const regionId = Number(listing?.regionid || listing?.region_id || bits[0]) || 0;
  const sectionId = Number(listing?.sectionid || listing?.section_id || bits[1]) || 0;
  if (!(regionId > 0)) return false;
  const price = Number(listing?.price_num) || 0;
  for (const cover of covers) {
    if (Number(cover.regionId) !== regionId) continue;
    const want = numIds(cover.sectionIds);
    if (want.length && sectionId > 0 && !want.includes(sectionId)) continue;
    const max = priceBound(cover.priceMax);
    const min = priceBound(cover.priceMin);
    if (max > 0 && price > max) continue;
    if (min > 0 && price > 0 && price < min) continue;
    return true;
  }
  return false;
}
