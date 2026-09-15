/** Support / Sponsorship 純計算層。不得被 listing 排序或 fit score 引用。 */

import { APP_NAME, APP_NAME_SHORT } from "./brand.js";

export const SUPPORT_PROVIDER_KINDS = Object.freeze([
  "buy_me_a_coffee",
  "external_url",
  "newebpay",
  "ec_pay",
  "custom",
]);

export const FUTURE_PAYMENT_PROVIDERS = Object.freeze(["newebpay", "ec_pay", "line_pay"]);

export const COST_CATEGORIES = Object.freeze([
  "GCP / Server",
  "Database",
  "Google Maps API",
  "Geocoding API",
  "Email",
  "SMS",
  "Monitoring",
  "Domain",
  "Cloud Storage",
  "Proxy / crawler",
  "第三方 API",
  "Other",
]);

export const BILLING_CYCLES = Object.freeze(["monthly", "yearly", "one_time", "custom"]);
export const TRANSACTION_STATUSES = Object.freeze([
  "pending",
  "completed",
  "failed",
  "refunded",
  "cancelled",
  "manual",
]);
export const SPONSOR_STATUSES = Object.freeze(["draft", "scheduled", "active", "expired", "disabled"]);
export const GOAL_DISPLAY_MODES = Object.freeze(["exact", "percent", "hidden"]);
export const CTA_RULE_TYPES = Object.freeze([
  "watch",
  "view_listing",
  "search",
  "commute",
  "days_used",
  "same_house_merge",
]);
export const DISMISS_DAY_OPTIONS = Object.freeze([7, 14, 30]);
export const SUPPORT_EVENT_KINDS = Object.freeze([
  "support_entry_viewed",
  "support_cta_shown",
  "support_cta_dismissed",
  "support_cta_clicked",
  "support_page_viewed",
  "support_tier_clicked",
  "support_checkout_opened",
  "support_checkout_returned",
  "sponsor_impression",
  "sponsor_clicked",
]);

export const DEFAULT_SUPPORT_FLAGS = Object.freeze({
  enabled: false,
  cta_enabled: false,
  sponsor_enabled: false,
  public_cost_enabled: false,
});

export const DEFAULT_PAGE_COPY = Object.freeze({
  hero_title: `讓${APP_NAME_SHORT}持續免費`,
  hero_description:
    `${APP_NAME}免費提供租屋搜尋、整理與比較工具。如果它曾經幫你少開一些分頁、少花一些找房時間，你可以自願支持網站持續維護。沒有支持也不會減少任何功能。`,
  free_statement: "本站免費使用，支持完全自願，不支持也不會減少任何功能。",
  cost_section_title: "這些錢用在哪裡",
  support_section_title: "支持方式",
  footer_note: "支持不會改變搜尋結果、推薦或排序。",
  cta_label: "支持本站",
  secondary_label: "繼續找房",
  goal_title: "本月維運",
  wall_title: `感謝支持${APP_NAME_SHORT}`,
});

export const DEFAULT_SEED_TIERS = Object.freeze([
  { title: "請喝杯咖啡", description: "請開發者喝杯咖啡", amount: 30, icon: "☕", sort_order: 10, is_default: 1 },
  { title: "讓伺服器多活一下", description: "支持一次伺服器費用", amount: 60, icon: "☕☕", sort_order: 20, is_default: 0 },
  { title: "開發者今天可以吃飯", description: "幫忙負擔網站維運", amount: 150, icon: "🍱", sort_order: 30, is_default: 0 },
  { title: "自訂支持", description: "自行決定金額", amount: 0, icon: "❤", sort_order: 40, is_default: 0 },
]);

export const FORBIDDEN_COPY = Object.freeze(["donate", "捐款給我們", "急需資金", "救救本站"]);

export function httpError(message, status = 400, code = "") {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

export function iso(now = new Date()) {
  return new Date(now).toISOString();
}

export function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function moneyAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

export function monthlyCostAmount(amount, billingCycle) {
  const n = moneyAmount(amount);
  if (billingCycle === "yearly") return Math.round((n / 12) * 100) / 100;
  if (billingCycle === "monthly") return n;
  return n;
}

export function goalProgress(received, target) {
  const got = moneyAmount(received);
  const goal = moneyAmount(target);
  if (goal <= 0) {
    return {
      received: got,
      target: 0,
      ratio: 0,
      percent: 0,
      visualPercent: 0,
      over: false,
      coverageLabel: "—",
    };
  }
  const ratio = got / goal;
  const percent = Math.round(ratio * 1000) / 10;
  return {
    received: got,
    target: goal,
    ratio,
    percent,
    visualPercent: Math.min(100, Math.max(0, percent)),
    over: percent > 100,
    coverageLabel: `${percent}%`,
  };
}

export function sortSupportTiers(rows) {
  return [...(rows || [])].sort((a, b) => {
    const ao = Number(a.sort_order) || 0;
    const bo = Number(b.sort_order) || 0;
    if (ao !== bo) return ao - bo;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
}

export function usageValue(usage = {}, ruleType) {
  const src = usage && typeof usage === "object" ? usage : {};
  switch (ruleType) {
    case "watch":
      return Number(src.watches) || 0;
    case "view_listing":
      return Number(src.views) || 0;
    case "search":
      return Number(src.searches) || 0;
    case "commute":
      return Number(src.commuteUses) || 0;
    case "days_used":
      return Number(src.daysUsed) || 0;
    case "same_house_merge":
      return Number(src.sameHouseUsed) || 0;
    default:
      return 0;
  }
}

export function ctaRuleEligible(usage, rule) {
  if (!rule || rule.enabled === false || Number(rule.enabled) === 0) return false;
  const threshold = Math.max(1, Number(rule.threshold) || 1);
  return usageValue(usage, rule.rule_type) >= threshold;
}

export function ctaCooldownOpen(state, now = new Date(), cooldownDays = 7) {
  const days = Math.max(1, Number(cooldownDays) || 7);
  const until = state?.dismissedUntil || state?.dismissed_until || "";
  const last = state?.lastShownAt || state?.last_shown_at || "";
  const ts = new Date(now).getTime();
  if (until) {
    const dismissAt = new Date(until).getTime();
    if (Number.isFinite(dismissAt) && ts < dismissAt) return false;
  }
  if (last) {
    const lastAt = new Date(last).getTime();
    if (Number.isFinite(lastAt) && ts - lastAt < days * 24 * 60 * 60 * 1000) return false;
  }
  return true;
}

export function mergeCtaState(serverState, clientState, now = new Date()) {
  const a = serverState && typeof serverState === "object" ? serverState : {};
  const b = clientState && typeof clientState === "object" ? clientState : {};
  const pickLater = (left, right) => {
    const lt = left ? new Date(left).getTime() : 0;
    const rt = right ? new Date(right).getTime() : 0;
    if (!Number.isFinite(lt)) return right || "";
    if (!Number.isFinite(rt)) return left || "";
    return rt > lt ? right : left;
  };
  return {
    lastShownAt: pickLater(a.lastShownAt || a.last_shown_at, b.lastShownAt || b.last_shown_at),
    dismissedUntil: pickLater(a.dismissedUntil || a.dismissed_until, b.dismissedUntil || b.dismissed_until),
    shownCount: Math.max(Number(a.shownCount || a.shown_count) || 0, Number(b.shownCount || b.shown_count) || 0),
    updatedAt: iso(now),
  };
}

export function dismissUntilFromDays(days, now = new Date()) {
  const n = DISMISS_DAY_OPTIONS.includes(Number(days)) ? Number(days) : 7;
  return iso(new Date(new Date(now).getTime() + n * 24 * 60 * 60 * 1000));
}

export function pickEligibleCtaRule(rules, usage, state, now = new Date()) {
  const list = [...(rules || [])]
    .filter((row) => ctaRuleEligible(usage, row))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0));
  for (const rule of list) {
    if (ctaCooldownOpen(state, now, rule.cooldown_days || 7)) return rule;
  }
  return null;
}

export function transactionDedupeKey(provider, providerTransactionId) {
  const p = String(provider || "").trim();
  const id = String(providerTransactionId || "").trim();
  if (!p || !id) return "";
  return `${p}::${id}`;
}

export function sponsorWindowActive(row, now = new Date()) {
  if (!row) return false;
  const status = String(row.status || "");
  if (status === "disabled" || status === "draft" || status === "expired") return false;
  const ts = new Date(now).getTime();
  const start = row.start_at ? new Date(row.start_at).getTime() : 0;
  const end = row.end_at ? new Date(row.end_at).getTime() : Infinity;
  if (Number.isFinite(start) && start > ts) return status === "scheduled" ? false : false;
  if (Number.isFinite(end) && end < ts) return false;
  return status === "active" || (status === "scheduled" && start <= ts && end >= ts);
}

export function resolveSponsorStatus(row, now = new Date()) {
  const status = String(row?.status || "draft");
  if (status === "disabled" || status === "draft") return status;
  const ts = new Date(now).getTime();
  const start = row?.start_at ? new Date(row.start_at).getTime() : 0;
  const end = row?.end_at ? new Date(row.end_at).getTime() : Infinity;
  if (Number.isFinite(end) && end < ts) return "expired";
  if (Number.isFinite(start) && start > ts) return "scheduled";
  if (status === "scheduled" || status === "active" || status === "expired") return "active";
  return status;
}

export function normalizeSupportFlags(src = {}) {
  const raw = src && typeof src === "object" ? src : {};
  return {
    enabled: raw.enabled === true,
    cta_enabled: raw.cta_enabled === true,
    sponsor_enabled: raw.sponsor_enabled === true,
    public_cost_enabled: raw.public_cost_enabled === true,
  };
}

export function normalizePageCopy(src = {}) {
  const raw = src && typeof src === "object" ? src : {};
  const out = { ...DEFAULT_PAGE_COPY };
  for (const key of Object.keys(DEFAULT_PAGE_COPY)) {
    if (raw[key] != null) out[key] = String(raw[key]).trim().slice(0, key.endsWith("description") ? 800 : 160);
  }
  return out;
}

export function normalizeGoalDisplay(value) {
  return GOAL_DISPLAY_MODES.includes(String(value)) ? String(value) : "exact";
}

export function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  return "[redacted]";
}

export function publicProviderView(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind || row.provider,
    display_name: row.display_name || "",
    is_active: Number(row.is_active) === 1,
    is_default: Number(row.is_default) === 1,
    available: Number(row.is_active) === 1 && Boolean(row.page_url),
  };
}

export function dashboardTotals(rows = []) {
  const completed = (rows || []).filter((row) => ["completed", "manual"].includes(String(row.status)));
  const amounts = completed.map((row) => moneyAmount(row.amount));
  const fees = completed.map((row) => moneyAmount(row.fee));
  const nets = completed.map((row) => moneyAmount(row.net_amount || moneyAmount(row.amount) - moneyAmount(row.fee)));
  const people = new Set(
    completed
      .filter((row) => !row.anonymous && (row.supporter_user_id || row.supporter_email || row.supporter_name))
      .map((row) => String(row.supporter_user_id || row.supporter_email || row.supporter_name)),
  );
  const corporate = completed.filter((row) => row.kind === "corporate" || row.channel === "corporate");
  const personal = completed.filter((row) => row.kind !== "corporate" && row.channel !== "corporate");
  const sum = (list) => list.reduce((acc, n) => acc + n, 0);
  const total = sum(amounts);
  return {
    gross: total,
    net: sum(nets),
    fee: sum(fees),
    count: completed.length,
    people: people.size,
    anonymous: completed.filter((row) => row.anonymous).length,
    average: completed.length ? Math.round((total / completed.length) * 100) / 100 : 0,
    corporate: sum(corporate.map((row) => moneyAmount(row.amount))),
    personal: sum(personal.map((row) => moneyAmount(row.amount))),
  };
}

export function conversionFunnel(counts = {}, completedAvailable = false) {
  return {
    cta_shown: Number(counts.support_cta_shown) || 0,
    cta_clicked: Number(counts.support_cta_clicked) || 0,
    page_viewed: Number(counts.support_page_viewed) || 0,
    checkout_opened: Number(counts.support_checkout_opened) || 0,
    completed: completedAvailable ? Number(counts.completed) || 0 : null,
    completed_available: completedAvailable,
    completed_note: completedAvailable ? "" : "Completed data unavailable",
  };
}

export function emptyUsage() {
  return {
    watches: 0,
    views: 0,
    searches: 0,
    commuteUses: 0,
    daysUsed: 0,
    sameHouseUsed: 0,
  };
}

export function sanitizeUsage(src = {}) {
  const raw = src && typeof src === "object" ? src : {};
  return {
    watches: clampNumber(raw.watches, 0, 1_000_000, 0),
    views: clampNumber(raw.views, 0, 1_000_000, 0),
    searches: clampNumber(raw.searches, 0, 1_000_000, 0),
    commuteUses: clampNumber(raw.commuteUses, 0, 1_000_000, 0),
    daysUsed: clampNumber(raw.daysUsed, 0, 20_000, 0),
    sameHouseUsed: clampNumber(raw.sameHouseUsed, 0, 1_000_000, 0),
  };
}
