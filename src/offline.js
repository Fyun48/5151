export const OFFLINE_CONFIRM_DAYS_DEFAULT = 7;
export const OFFLINE_RECHECK_HOURS = 12;

function toDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeOfflineConfirmDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return OFFLINE_CONFIRM_DAYS_DEFAULT;
  return Math.max(1, Math.min(Math.round(n), 30));
}

export function daysSince(fromIso, now = new Date()) {
  const from = toDate(fromIso);
  if (!from) return 0;
  return (now.getTime() - from.getTime()) / 86_400_000;
}

export function hoursSince(fromIso, now = new Date()) {
  const from = toDate(fromIso);
  if (!from) return Number.POSITIVE_INFINITY;
  return (now.getTime() - from.getTime()) / 3_600_000;
}

export function isPendingOffline(listing) {
  return Boolean(Number(listing?.offline)) && !Number(listing?.offline_confirmed);
}

export function isConfirmedOffline(listing) {
  return Boolean(Number(listing?.offline)) && Boolean(Number(listing?.offline_confirmed));
}

export function countsTowardAllTotal(listing) {
  if (listing?.hidden || Number(listing?.hidden)) return false;
  if (listing?.watched || Number(listing?.watched)) return false;
  if (listing?.match_verdict === "yes") return false;
  if (isPendingOffline(listing) || isConfirmedOffline(listing) || Number(listing?.offline)) return false;
  return true;
}

export function shouldConfirmOffline(listing, { days = OFFLINE_CONFIRM_DAYS_DEFAULT, now = new Date() } = {}) {
  if (!listing?.offline || listing.offline_confirmed) return false;
  return daysSince(listing.offline_at, now) >= normalizeOfflineConfirmDays(days);
}

export function shouldRecheckOffline(listing, { hours = OFFLINE_RECHECK_HOURS, days = OFFLINE_CONFIRM_DAYS_DEFAULT, now = new Date() } = {}) {
  if (!listing?.offline || listing.offline_confirmed) return false;
  if (shouldConfirmOffline(listing, { days, now })) return false;
  const last = listing.last_checked_at || listing.offline_at;
  return hoursSince(last, now) >= hours;
}
