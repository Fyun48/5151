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
