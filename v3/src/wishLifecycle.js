/** 許願房生命週期。不綁 crawler tick。Completed 只能由使用者明確選「已找到房」。 */

import { randomBytes } from "node:crypto";

export const WISH_FAR_EXPIRE = "9999-12-31T00:00:00.000Z";

export const WISH_LIFECYCLE_STATES = Object.freeze([
  "draft",
  "active",
  "needs_confirmation",
  "paused",
  "completed",
  "expired",
  "blocked",
]);

export const WISH_TTL_DAYS_DEFAULT = 14;
export const WISH_CONTINUOUS_ACTIVE_DAYS = 60;
export const WISH_INACTIVE_CONFIRM_AFTER_DAYS = 14;
export const WISH_CONFIRM_GRACE_DAYS = 7;

export function createPublicToken() {
  return randomBytes(16).toString("hex");
}

export function ttlExpiresAt(now = new Date(), days = WISH_TTL_DAYS_DEFAULT) {
  const ms = nowMs(now) + Math.max(1, Number(days) || WISH_TTL_DAYS_DEFAULT) * 86400000;
  return new Date(ms).toString() === "Invalid Date" ? new Date(nowMs(now) + 14 * 86400000).toISOString() : new Date(ms).toISOString();
}

export function mapLegacyLifecycle(row = {}) {
  const stored = String(row.lifecycle || "").trim();
  if (WISH_LIFECYCLE_STATES.includes(stored)) return stored;
  const status = String(row.status || "draft");
  if (status === "open") return "active";
  if (status === "draft") return "draft";
  if (status === "hidden") return "blocked";
  if (status === "expired") return "expired";
  if (status === "closed") return row.closed_reason === "completed" ? "completed" : "paused";
  return "draft";
}

export function visibilityStatusFor(lifecycle) {
  if (lifecycle === "active" || lifecycle === "needs_confirmation") return "open";
  if (lifecycle === "draft") return "draft";
  if (lifecycle === "blocked") return "hidden";
  if (lifecycle === "expired") return "expired";
  return "closed";
}

export function daysBetween(from, to = Date.now()) {
  const a = Date.parse(from);
  if (!Number.isFinite(a)) return 0;
  return Math.max(0, Math.floor((nowMs(to) - a) / 86400000));
}

export function remainingTtlDays(expiresAt, now = Date.now()) {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t) || String(expiresAt) >= WISH_FAR_EXPIRE.slice(0, 10)) return null;
  return Math.max(0, Math.ceil((t - nowMs(now)) / 86400000));
}

export function activityBucket(lastActiveAt, now = Date.now()) {
  const age = daysBetween(lastActiveAt, now);
  if (!lastActiveAt) return "recently_quiet";
  if (age <= 0) return "today";
  if (age <= 3) return "within_3d";
  if (age <= 7) return "within_7d";
  return "recently_quiet";
}

export function activityBucketLabel(bucket) {
  return {
    today: "今天仍有活動",
    within_3d: "3 天內有活動",
    within_7d: "7 天內有活動",
    recently_quiet: "最近活動較少",
  }[bucket] || "最近活動較少";
}

export function activityScoreFromSignals(signals = {}, now = Date.now()) {
  const stamps = [
    signals.last_login_at,
    signals.last_confirmed_at,
    signals.wish_edited_at,
    signals.listing_viewed_at,
    signals.watched_at,
    signals.search_at,
    signals.commute_at,
  ].map((value) => Date.parse(value)).filter((n) => Number.isFinite(n));
  if (!stamps.length) return { last_active_at: "", activity_score: 0, activity_bucket: "recently_quiet" };
  const last = Math.max(...stamps);
  const ageDays = Math.max(0, (nowMs(now) - last) / 86400000);
  const score = Math.max(0, Math.round((1 - Math.min(ageDays, 30) / 30) * 100));
  return {
    last_active_at: new Date(last).toISOString(),
    activity_score: score,
    activity_bucket: activityBucket(new Date(last).toISOString(), now),
  };
}

export function canSelfTransition(from, action) {
  const lifecycle = WISH_LIFECYCLE_STATES.includes(from) ? from : "draft";
  if (lifecycle === "blocked") return false;
  if (action === "complete") return lifecycle !== "completed";
  if (action === "pause") return lifecycle === "active" || lifecycle === "needs_confirmation";
  if (action === "resume") return lifecycle === "paused" || lifecycle === "expired";
  if (action === "extend" || action === "confirm" || action === "full_reconfirm") {
    return lifecycle === "active" || lifecycle === "needs_confirmation";
  }
  if (action === "publish") return lifecycle === "draft" || lifecycle === "paused";
  return false;
}

export function transitionLifecycle(row, action, now = new Date(), { ttlDays = WISH_TTL_DAYS_DEFAULT, continuousDays = WISH_CONTINUOUS_ACTIVE_DAYS } = {}) {
  const current = mapLegacyLifecycle(row);
  if (!canSelfTransition(current, action)) {
    const err = new Error(current === "blocked" ? "已封鎖的許願房不能自己恢復" : current === "completed" ? "已找到房的許願房請另開新的一則" : "這個狀態不能這樣操作");
    err.status = 400;
    err.code = current === "blocked" ? "wish_blocked" : current === "completed" ? "wish_completed" : "wish_state";
    throw err;
  }
  const stamp = iso(now);
  if (action === "complete") {
    return { lifecycle: "completed", status: "closed", closed_reason: "completed", closed_at: stamp, updated_at: stamp };
  }
  if (action === "pause") {
    return { lifecycle: "paused", status: "closed", closed_reason: "paused", closed_at: stamp, updated_at: stamp };
  }
  if (action === "extend" || action === "confirm" || action === "full_reconfirm" || action === "resume" || action === "publish") {
    const started = row.continuous_active_from || row.last_confirmed_at || row.published_at || row.created_at;
    const continuous = daysBetween(started, now);
    if ((action === "extend" || action === "confirm") && continuous >= continuousDays) {
      return {
        lifecycle: "needs_confirmation",
        status: "open",
        require_reconfirm: true,
        updated_at: stamp,
      };
    }
    const resetWindow = action === "full_reconfirm" || action === "resume" || action === "publish" || !row.continuous_active_from;
    return {
      lifecycle: "active",
      status: "open",
      expires_at: ttlExpiresAt(now, ttlDays),
      last_confirmed_at: stamp,
      last_active_at: stamp,
      continuous_active_from: resetWindow ? stamp : row.continuous_active_from,
      closed_at: null,
      closed_reason: "",
      updated_at: stamp,
      published_at: row.published_at || stamp,
    };
  }
  const err = new Error("不支援的操作");
  err.status = 400;
  return undefined;
}

export function planLifecycleTick(row, now = new Date(), {
  confirmAfterDays = WISH_INACTIVE_CONFIRM_AFTER_DAYS,
  graceDays = WISH_CONFIRM_GRACE_DAYS,
} = {}) {
  const lifecycle = mapLegacyLifecycle(row);
  const stamp = iso(now);
  if (lifecycle === "blocked" || lifecycle === "completed" || lifecycle === "draft" || lifecycle === "paused" || lifecycle === "expired") {
    return null;
  }
  const ttlDue = isRealTtlDue(row.expires_at, now);
  const ttlPastGrace = isRealTtlPastGrace(row.expires_at, now, graceDays);
  const last = row.last_confirmed_at || row.last_active_at || row.published_at || row.updated_at || row.created_at;
  const idle = daysBetween(last, now);
  if (lifecycle === "active" && (ttlDue || idle >= confirmAfterDays)) {
    return { lifecycle: "needs_confirmation", status: "open", updated_at: stamp };
  }
  if (lifecycle === "needs_confirmation" && (ttlPastGrace || idle >= confirmAfterDays + graceDays)) {
    return { lifecycle: "paused", status: "closed", closed_at: stamp, closed_reason: "paused", updated_at: stamp };
  }
  return null;
}

/** Worker 寫入前重讀列：若使用者已續期／改狀態，不再覆寫。 */
export function shouldApplyLifecyclePlan(freshRow, planned, now = new Date()) {
  if (!planned || !freshRow) return false;
  const current = mapLegacyLifecycle(freshRow);
  if (current === "blocked" || current === "completed") return false;
  const still = planLifecycleTick(freshRow, now);
  return Boolean(still && still.lifecycle === planned.lifecycle);
}

export function migrateOpenWishOnActivation(row, now = new Date(), ttlDays = WISH_TTL_DAYS_DEFAULT) {
  if (String(row?.status || "") !== "open") return null;
  const stamp = iso(now);
  return {
    lifecycle: "active",
    status: "open",
    expires_at: ttlExpiresAt(now, ttlDays),
    last_confirmed_at: stamp,
    last_active_at: stamp,
    continuous_active_from: stamp,
    updated_at: stamp,
  };
}

export function publicInactiveWishView() {
  return {
    product: "許願房",
    headline: "租屋需求",
    inactive: true,
    noindex: true,
    message: "這個租屋需求目前已停止。",
  };
}

export function isRealTtlDue(expiresAt, now = Date.now()) {
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) && expires <= nowMs(now) && String(expiresAt) < WISH_FAR_EXPIRE;
}

export function isRealTtlPastGrace(expiresAt, now = Date.now(), graceDays = WISH_CONFIRM_GRACE_DAYS) {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || String(expiresAt) >= WISH_FAR_EXPIRE) return false;
  return expires + Math.max(0, Number(graceDays) || 0) * 86400000 <= nowMs(now);
}

function nowMs(now) {
  return now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
}

function iso(now) {
  return new Date(nowMs(now)).toISOString();
}
