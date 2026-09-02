/** Google Directions 用量與費用估算（依公開價目，實際以 Cloud 帳單為準）。 */

export const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const RUSH_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const MAPS_SKU = {
  essentials: { id: "essentials", label: "一般路線", free: 10000, usdPerThousand: 5 },
  advanced: { id: "advanced", label: "含路況尖峰", free: 5000, usdPerThousand: 10 },
};

let usageSink = null;

export function bindMapsUsageSink(fn) {
  usageSink = typeof fn === "function" ? fn : null;
}

export function recordMapsUsage(sku, count = 1) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  if (!n || !usageSink) return;
  usageSink(sku === "advanced" ? "advanced" : "essentials", n);
}

export function hasGoogleMapsKey(env = process.env) {
  return Boolean(String(env.GOOGLE_MAPS_API_KEY || "").trim());
}

export function isCommuteRushEnabled(value) {
  return value === true;
}

export function taipeiYmd(now = Date.now()) {
  const d = new Date(Number(now) + TAIPEI_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function monthKey(day) {
  return String(day || "").slice(0, 7);
}

export function skuUsd(used, sku) {
  const billable = Math.max(0, (Number(used) || 0) - Number(sku.free || 0));
  return Math.round((billable / 1000) * Number(sku.usdPerThousand || 0) * 100) / 100;
}

export function secondsToMinutes(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n / 60));
}

export function nextWeekdayTaipeiUnix(hour, minute, { weekday = 2, now = Date.now(), minAheadMs = 36 * 60 * 60 * 1000 } = {}) {
  const shifted = new Date(Number(now) + TAIPEI_OFFSET_MS);
  const currentDow = shifted.getUTCDay();
  let add = (Number(weekday) - currentDow + 7) % 7;
  const at = (days) => Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + days,
    Number(hour) || 0,
    Number(minute) || 0,
    0,
  ) - TAIPEI_OFFSET_MS;
  let stamp = at(add);
  if (stamp <= Number(now) + Number(minAheadMs || 0)) {
    stamp = at(add === 0 ? 7 : add + 7);
  }
  return Math.floor(stamp / 1000);
}

export function rushStale(updatedAt, now = Date.now(), ttlMs = RUSH_TTL_MS) {
  const t = Date.parse(String(updatedAt || ""));
  if (!Number.isFinite(t)) return true;
  return Number(now) - t >= ttlMs;
}

export function summarizeMapsUsage(dailyRows, { now = Date.now() } = {}) {
  const today = taipeiYmd(now);
  const month = monthKey(today);
  const rows = Array.isArray(dailyRows) ? dailyRows : [];
  const byMonth = new Map();
  let todayEssentials = 0;
  let todayAdvanced = 0;
  let allEssentials = 0;
  let allAdvanced = 0;
  for (const row of rows) {
    const day = String(row.day || "");
    const essentials = Math.max(0, Number(row.essentials) || 0);
    const advanced = Math.max(0, Number(row.advanced) || 0);
    allEssentials += essentials;
    allAdvanced += advanced;
    if (day === today) {
      todayEssentials += essentials;
      todayAdvanced += advanced;
    }
    const key = monthKey(day);
    if (!key) continue;
    const cur = byMonth.get(key) || { essentials: 0, advanced: 0 };
    cur.essentials += essentials;
    cur.advanced += advanced;
    byMonth.set(key, cur);
  }
  const thisMonth = byMonth.get(month) || { essentials: 0, advanced: 0 };
  const monthUsd = Math.round((
    skuUsd(thisMonth.essentials, MAPS_SKU.essentials) + skuUsd(thisMonth.advanced, MAPS_SKU.advanced)
  ) * 100) / 100;
  let lifetimeUsd = 0;
  for (const item of byMonth.values()) {
    lifetimeUsd += skuUsd(item.essentials, MAPS_SKU.essentials);
    lifetimeUsd += skuUsd(item.advanced, MAPS_SKU.advanced);
  }
  lifetimeUsd = Math.round(lifetimeUsd * 100) / 100;
  return {
    today,
    month,
    todayEssentials,
    todayAdvanced,
    monthEssentials: thisMonth.essentials,
    monthAdvanced: thisMonth.advanced,
    monthUsd,
    lifetimeEssentials: allEssentials,
    lifetimeAdvanced: allAdvanced,
    lifetimeUsd,
    essentialsFree: MAPS_SKU.essentials.free,
    advancedFree: MAPS_SKU.advanced.free,
  };
}
