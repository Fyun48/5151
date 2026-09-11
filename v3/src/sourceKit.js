/** 住商／信義／好房／樂屋的家俱瓦斯陽台補抓。591／5168／租租通走既有明細，不走這裡。 */

import { listingKitFrom } from "./listingKit.js";
import { safeFetchText } from "./safeFetch.js";

export const SOURCE_KIT_SOURCES = Object.freeze(["hbhousing", "sinyi", "housefun", "rakuya"]);

export const SOURCE_KIT_HOSTS = Object.freeze({
  hbhousing: Object.freeze(["www.hbhousing.com.tw", "hbhousing.com.tw"]),
  sinyi: Object.freeze(["www.sinyi.com.tw", "rent.sinyi.com.tw"]),
  housefun: Object.freeze(["rent.housefun.com.tw", "housefun.com.tw"]),
  rakuya: Object.freeze(["www.rakuya.com.tw", "rakuya.com.tw"]),
});

export function isSourceKitSource(source) {
  return SOURCE_KIT_SOURCES.includes(String(source || ""));
}

export function sourceKitHosts(source) {
  return SOURCE_KIT_HOSTS[String(source || "")] || [];
}

function hostOf(href) {
  try {
    return new URL(String(href || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function kitUrlAllowedForSource(href, source) {
  const host = hostOf(href);
  return Boolean(host && sourceKitHosts(source).includes(host));
}

export function resolveSourceKitUrl(listing, fallbackUrl = "") {
  const source = String(listing?.source || "");
  const raw = String(listing?.url || "").trim();
  const fallback = String(fallbackUrl || "").trim();
  if (raw && kitUrlAllowedForSource(raw, source)) return raw;
  if (fallback && kitUrlAllowedForSource(fallback, source)) return fallback;
  throw Object.assign(new Error("詳情網址不屬於此來源"), { code: "KIT_PARSE_EMPTY" });
}

export function looksLikeBlockedKitPage(html, status) {
  const body = String(html || "");
  if (Number(status) === 429) return { code: "RATE_LIMITED", message: "來源要求降低抓取頻率" };
  // 只認挑戰頁，不要把 cdnjs.cloudflare.com 這種腳本 CDN 當成被擋。
  if (
    /just a moment/i.test(body)
    || /cf-browser-verification|cf-challenge-running|cdn-cgi\/challenge-platform/i.test(body)
  ) {
    return { code: "FETCH_BLOCKED", message: "來源被 Cloudflare 或驗證擋住，不繞過" };
  }
  return null;
}

export async function fetchSourceKitPage(listing, options = {}) {
  const url = resolveSourceKitUrl(listing, options.fallbackUrl);
  const fetchText = options.fetchText;
  const got = fetchText
    ? await fetchText(url)
    : await safeFetchText(url, {
      allowedHosts: sourceKitHosts(listing?.source),
      timeoutMs: 12000,
    });
  const blocked = looksLikeBlockedKitPage(got?.text || got?.body, got?.status);
  if (blocked) {
    throw Object.assign(new Error(blocked.message), { code: blocked.code });
  }
  if (Number(got?.status) >= 400) {
    throw new Error(`詳情 ${got.status}`);
  }
  return { url, text: got?.text || got?.body || "", status: got?.status };
}

export async function fetchSourceKit(listing, options = {}) {
  const source = String(listing?.source || "");
  if (source === "hbhousing") {
    const { fetchHbDetailKit } = await import("./hbhousing.js");
    return fetchHbDetailKit(listing, options);
  }
  if (source === "sinyi") {
    const { fetchSinyiDetailKit } = await import("./sinyi.js");
    return fetchSinyiDetailKit(listing, options);
  }
  if (source === "housefun") {
    const { fetchHfDetailKit } = await import("./housefun.js");
    return fetchHfDetailKit(listing, options);
  }
  if (source === "rakuya") {
    const { fetchRakuyaDetailKit } = await import("./rakuya.js");
    return fetchRakuyaDetailKit(listing, options);
  }
  return listingKitFrom(listing || {});
}
