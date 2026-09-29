/** 非同步 geocode：以正規化地址版本快取，特別關注優先，不偽裝不完整地址。 */

import { houseCacheKey, parseTaiwanAddressParts, streetCacheKey } from "./geoPrecision.js";

export const GEO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const GEO_QUALITY_RANK = Object.freeze({
  house: 3,
  street: 2,
  district: 1,
  unknown: 0,
});

export function addressVersion(address) {
  const parts = parseTaiwanAddressParts(address);
  return houseCacheKey(parts) || streetCacheKey(parts) || String(address || "").replace(/\s+/g, "");
}

export function inferGeoQuality({ address } = {}) {
  const text = String(address || "").replace(/\s+/g, "");
  const hasHouse = /\d+(?:[-－—之]\d+)?號/.test(text);
  const hasStreet = /[路街道大道]/.test(text) || /\d+巷/.test(text) || /\d+弄/.test(text);
  if (hasHouse && hasStreet) return "house";
  if (hasStreet) return "street";
  if (/[縣市].*[區鄉鎮]/.test(text) || /[區鄉鎮市]/.test(text)) return "district";
  return "unknown";
}

export function shouldRefreshGeo(cache, address, now = Date.now()) {
  if (!cache || !Number.isFinite(Number(cache.lat)) || !Number.isFinite(Number(cache.lng))) return true;
  const ver = addressVersion(address);
  if (cache.address_version && cache.address_version !== ver) return true;
  const have = GEO_QUALITY_RANK[cache.quality] || 0;
  const need = GEO_QUALITY_RANK[inferGeoQuality({ address })] || 0;
  if (have < need) return true;
  const updated = Date.parse(cache.updated_at || "");
  if (!Number.isFinite(updated) || now - updated > GEO_TTL_MS) return true;
  return false;
}

export function ensureGeoCacheSchema(db) {
  for (const sql of [
    "ALTER TABLE geo_cache ADD COLUMN quality TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE geo_cache ADD COLUMN geo_source TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE geo_cache ADD COLUMN address_used TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE geo_cache ADD COLUMN address_version TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE geo_cache ADD COLUMN location_class TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE geo_cache ADD COLUMN city TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE geo_cache ADD COLUMN district TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE geo_cache ADD COLUMN cache_kind TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE geo_cache ADD COLUMN provider TEXT NOT NULL DEFAULT ''",
  ]) {
    try { db.exec(sql); } catch { /* already migrated */ }
  }
}

/** `ensureGeoCacheSchema()` 補的那九個欄位（PG 版用 `ADD COLUMN IF NOT EXISTS` 逐字補同一組）。 */
export const GEO_CACHE_EXTRA_COLUMNS = Object.freeze([
  "quality", "geo_source", "address_used", "address_version", "location_class",
  "city", "district", "cache_kind", "provider",
]);

/**
 * `geo_cache` 一列的落地值（**純函式**）：同步版（`db.js setCachedGeo()`）與 PG 版
 * （`geoCacheAsync.setCachedGeoAsync()`）共用同一份推導——「quality／cache_kind 怎麼算」
 * 不能有兩份實作，否則兩個 driver 會寫出不同形狀的快取。
 * 回傳 `null` 代表這一筆不該落地（沒有可用的鍵，或座標不是有限數）。
 */
export function geoCacheRow(address, lat, lng, meta = {}, now = new Date()) {
  const key = addressVersion(address);
  if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return null;
  const quality = meta.quality || inferGeoQuality({ address: meta.address_used || address });
  const source = String(meta.geo_source || meta.source || "");
  const used = String(meta.address_used || address || "");
  const stamp = new Date(now).toISOString();
  const locationClass = String(meta.location_class || "");
  const city = String(meta.city || "");
  const district = String(meta.district || "");
  const cacheKind = String(meta.cache_kind || (locationClass === "street" ? "street" : locationClass === "address" ? "house" : quality));
  const provider = String(meta.provider || "");
  return {
    address: key,
    lat: Number(lat),
    lng: Number(lng),
    updated_at: stamp,
    quality,
    geo_source: source,
    address_used: used,
    address_version: key,
    location_class: locationClass,
    city,
    district,
    cache_kind: cacheKind,
    provider,
  };
}

export function createGeoQueue({
  concurrency = 2,
  lookup,
  geocode,
  onResult,
  now = () => Date.now(),
} = {}) {
  const jobs = [];
  let inflight = 0;
  let attempts = new Map();
  const MAX_ATTEMPTS = 3;

  function sortJobs() {
    jobs.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
  }

  function enqueue(job) {
    const address = String(job?.address || "").trim();
    if (!address) return false;
    const qualityNeeded = inferGeoQuality({ address });
    if (qualityNeeded === "unknown" && !job.allowIncomplete) return false;
    const cached = lookup?.(address);
    if (cached && !shouldRefreshGeo(cached, address, now())) return false;
    const key = addressVersion(address);
    if (jobs.some((item) => item.key === key) || [...attempts.keys()].includes(`run:${key}`)) {
      const existing = jobs.find((item) => item.key === key);
      if (existing && (Number(job.priority) || 0) > (Number(existing.priority) || 0)) {
        existing.priority = job.priority;
        existing.watched = existing.watched || job.watched;
        sortJobs();
      }
      return true;
    }
    jobs.push({
      key,
      address,
      priority: Number(job.priority) || (job.watched ? 100 : 10),
      watched: Boolean(job.watched),
      listingId: job.listingId || 0,
    });
    sortJobs();
    return true;
  }

  async function pump() {
    while (inflight < concurrency && jobs.length) {
      const job = jobs.shift();
      inflight += 1;
      const runKey = `run:${job.key}`;
      attempts.set(runKey, true);
      Promise.resolve()
        .then(() => geocode?.(job.address, { watched: job.watched, listingId: job.listingId }))
        .then((hit) => {
          attempts.delete(runKey);
          if (hit && Number.isFinite(Number(hit.lat))) {
            onResult?.(job, {
              ...hit,
              quality: hit.quality || inferGeoQuality({ address: hit.address_used || job.address }),
              address_used: hit.address_used || job.address,
            });
          } else {
            const n = (attempts.get(job.key) || 0) + 1;
            attempts.set(job.key, n);
            if (n < MAX_ATTEMPTS && job.watched) {
              job.priority = Math.max(1, (job.priority || 1) - 10);
              jobs.push(job);
              sortJobs();
            }
          }
        })
        .catch(() => {
          attempts.delete(runKey);
          const n = (attempts.get(job.key) || 0) + 1;
          attempts.set(job.key, n);
          if (n < MAX_ATTEMPTS) {
            job.priority = Math.max(1, (job.priority || 1) - 20);
            jobs.push(job);
            sortJobs();
          }
        })
        .finally(() => {
          inflight -= 1;
        });
    }
  }

  return {
    enqueue,
    pump,
    size: () => jobs.length + inflight,
    peek: () => jobs[0] || null,
    jobs,
  };
}

export function watchGeoPriority(watched) {
  return watched ? 100 : 10;
}
