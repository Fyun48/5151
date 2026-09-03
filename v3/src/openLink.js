import { isSelfListingId } from "./selfListings.js";

export function listingRedirectTarget(listing, postId) {
  const id = Number(postId) || Number(listing?.post_id) || 0;
  const source = String(listing?.source || "591");
  if (source === "self" || isSelfListingId(id)) return `/?self=${id}`;
  const url = String(listing?.url || "").trim();
  if (url && source !== "591" && /^https?:\/\//i.test(url)) return url;
  return rent591Url(id);
}

export function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || process.env.APP_URL || "")
    .trim()
    .replace(/\/$/, "");
}

export function rent591Url(postId) {
  const id = Number(postId) || 0;
  return `https://rent.591.com.tw/${id}`;
}

export function trackedListingPath(postId) {
  const id = Number(postId) || 0;
  return `/go/${id}`;
}

/** Discord／外部通知用絕對網址；未設定 PUBLIC_BASE_URL 時退回 591 直連（無法追蹤已瀏覽）。 */
export function trackedListingUrl(postId, fallbackUrl = "") {
  const id = Number(postId) || 0;
  const base = publicBaseUrl();
  if (base && id) return `${base}/go/${id}`;
  const fallback = String(fallbackUrl || "").trim();
  if (fallback) return fallback;
  return rent591Url(id);
}
