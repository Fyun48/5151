/** Google Directions 官方價目：https://developers.google.com/maps/billing-and-pricing/pricing
 *  Legacy Routes：Directions / Directions Advanced。免額於太平洋時間每月 1 日 00:00 重置。
 */
export const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
export const RUSH_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAPS_BILLING_TZ = "America/Los_Angeles";

export const MAPS_SKU = {
  essentials: {
    id: "essentials",
    skuId: "28A8-3EB4-4595",
    label: "Directions",
    free: 10000,
    usdPerThousand: 5,
    tiers: [
      { upTo: 100000, usdPerThousand: 5 },
      { upTo: Infinity, usdPerThousand: 4 },
    ],
  },
  advanced: {
    id: "advanced",
    skuId: "9407-00C2-CF85",
    label: "Directions Advanced",
    free: 5000,
    usdPerThousand: 10,
    tiers: [
      { upTo: 100000, usdPerThousand: 10 },
      { upTo: Infinity, usdPerThousand: 8 },
    ],
  },
};

let usageSink = null;
let directionsEnabledReader = () => false;

export function bindMapsUsageSink(fn) {
  usageSink = typeof fn === "function" ? fn : null;
}

export function bindGoogleDirectionsEnabled(fn) {
  directionsEnabledReader = typeof fn === "function" ? fn : () => false;
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

/** 後台未勾選時一律視為關閉，避免金鑰存在就自動打 Google 計費 API。 */
export function isGoogleDirectionsEnabled(value) {
  return value === true;
}

export function googleDirectionsAllowed(env = process.env) {
  return hasGoogleMapsKey(env) && directionsEnabledReader() === true;
}

export function mapsAdminWarning({ googleEnabled, rushEnabled, hasKey } = {}) {
  if (!googleEnabled) {
    return "Google Directions 已關閉。通勤公里數改走免費 OpenStreetMap（OSRM），不會再產生 Google 路線費用。";
  }
  if (!hasKey) {
    return "已允許 Google Directions，但還沒有金鑰，公里數仍走 OSRM。";
  }
  if (rushEnabled) {
    return "Google Directions 開啟中，會依公開價目計費；尖峰分鐘會打含路況的路線（較貴）。";
  }
  return "Google Directions 開啟中，只用一般路線算公里數（不含尖峰路況，仍會計費）。";
}

export function taipeiYmd(now = Date.now()) {
  const d = new Date(Number(now) + TAIPEI_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function pacificYmd(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MAPS_BILLING_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Number(now)));
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function monthKey(day) {
  return String(day || "").slice(0, 7);
}

export function isBillableDirectionsStatus(status) {
  return status === "OK" || status === "ZERO_RESULTS";
}

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/** 官方示例：各級距「費率 × 該級距次數／1000」，免額後再分 10 萬內／超過 10 萬。 */
export function skuCostBreakdown(used, sku) {
  const total = Math.max(0, Math.round(Number(used) || 0));
  const free = Math.max(0, Number(sku.free) || 0);
  const tiers = Array.isArray(sku.tiers) && sku.tiers.length
    ? sku.tiers
    : [{ upTo: Infinity, usdPerThousand: Number(sku.usdPerThousand) || 0 }];
  const lines = [];
  const freeEvents = Math.min(total, free);
  lines.push({
    range: `0–${free.toLocaleString("en-US")}`,
    events: freeEvents,
    usdPerThousand: 0,
    usd: 0,
  });
  let cursor = free;
  let usd = 0;
  for (const tier of tiers) {
    const cap = Number(tier.upTo);
    const end = Number.isFinite(cap) ? cap : Infinity;
    const available = end === Infinity ? Infinity : Math.max(0, end - cursor);
    const events = Math.min(Math.max(0, total - cursor), available);
    const lineUsd = money((events / 1000) * Number(tier.usdPerThousand || 0));
    const start = cursor + 1;
    lines.push({
      range: end === Infinity ? `${start.toLocaleString("en-US")}+` : `${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")}`,
      events,
      usdPerThousand: Number(tier.usdPerThousand || 0),
      usd: lineUsd,
    });
    usd += lineUsd;
    if (end === Infinity) break;
    cursor = end;
    if (total <= cursor) break;
  }
  return {
    sku: sku.label || sku.id,
    skuId: sku.skuId || "",
    used: total,
    free,
    billable: Math.max(0, total - free),
    usd: money(usd),
    lines,
  };
}

export function skuUsd(used, sku) {
  return skuCostBreakdown(used, sku).usd;
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
  const today = pacificYmd(now);
  const month = monthKey(today);
  const monthStart = `${month}-01`;
  const rows = Array.isArray(dailyRows) ? dailyRows : [];
  const byMonth = new Map();
  let todayEssentials = 0;
  let todayAdvanced = 0;
  let allEssentials = 0;
  let allAdvanced = 0;
  let monthEssentials = 0;
  let monthAdvanced = 0;
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
    if (day >= monthStart && day <= today) {
      monthEssentials += essentials;
      monthAdvanced += advanced;
    }
    const key = monthKey(day);
    if (!key) continue;
    const cur = byMonth.get(key) || { essentials: 0, advanced: 0 };
    cur.essentials += essentials;
    cur.advanced += advanced;
    byMonth.set(key, cur);
  }
  const essentialsBreakdown = skuCostBreakdown(monthEssentials, MAPS_SKU.essentials);
  const advancedBreakdown = skuCostBreakdown(monthAdvanced, MAPS_SKU.advanced);
  const monthUsd = money(essentialsBreakdown.usd + advancedBreakdown.usd);
  let lifetimeUsd = 0;
  for (const item of byMonth.values()) {
    lifetimeUsd += skuUsd(item.essentials, MAPS_SKU.essentials);
    lifetimeUsd += skuUsd(item.advanced, MAPS_SKU.advanced);
  }
  lifetimeUsd = money(lifetimeUsd);
  return {
    today,
    month,
    billingTz: MAPS_BILLING_TZ,
    todayEssentials,
    todayAdvanced,
    monthEssentials,
    monthAdvanced,
    monthUsd,
    lifetimeEssentials: allEssentials,
    lifetimeAdvanced: allAdvanced,
    lifetimeUsd,
    essentialsFree: MAPS_SKU.essentials.free,
    advancedFree: MAPS_SKU.advanced.free,
    essentialsBreakdown,
    advancedBreakdown,
  };
}
