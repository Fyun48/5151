/** 外部物件匯入：精確 host 白名單與 URL 正規化。不是通用下載器。 */

import { isBlockedHostname, isIpLiteral, parseHttpsUrl } from "./safeFetch.js";

function httpError(message, status = 400, code = "UNSUPPORTED_URL") {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function hostOf(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

/** 公開物件頁允許的精確主機（不含 BFF／後台／任意子網域）。 */
export const IMPORT_PROVIDERS = {
  "591": {
    id: "591",
    label: "591",
    pageHosts: ["rent.591.com.tw", "www.591.com.tw"],
    imageHosts: ["img1.591.com.tw", "img2.591.com.tw", "hp1.591.com.tw", "hp2.591.com.tw"],
  },
  "5168": {
    id: "5168",
    label: "5168",
    pageHosts: ["rent.houseprice.tw"],
    imageHosts: ["rent.houseprice.tw", "static.houseprice.tw"],
  },
};

export function allPageHosts() {
  return [...new Set(Object.values(IMPORT_PROVIDERS).flatMap((p) => p.pageHosts))];
}

export function imageHostsFor(providerId) {
  const p = IMPORT_PROVIDERS[providerId];
  return p ? [...p.imageHosts] : [];
}

export function pageHostsFor(providerId) {
  const p = IMPORT_PROVIDERS[providerId];
  return p ? [...p.pageHosts] : [];
}

export function providerByHost(host) {
  const h = hostOf(host);
  return Object.values(IMPORT_PROVIDERS).find((p) => p.pageHosts.includes(h)) || null;
}

export function canHandleImportUrl(raw) {
  try {
    const url = parseHttpsUrl(raw);
    return Boolean(providerByHost(url.hostname));
  } catch {
    return false;
  }
}

export function normalize591Url(url) {
  const host = hostOf(url.hostname);
  if (host === "rent.591.com.tw") {
    const m = url.pathname.match(/^\/(\d{5,12})\/?$/);
    if (m) return { id: m[1], normalized: `https://rent.591.com.tw/${m[1]}` };
  }
  if (host === "www.591.com.tw") {
    const id = url.searchParams.get("id") || "";
    if (/^\d{5,12}$/.test(id) && /\/home\/housing\/detail\/?$/.test(url.pathname)) {
      return { id, normalized: `https://www.591.com.tw/home/housing/detail?id=${id}` };
    }
  }
  throw httpError("請貼 591 單筆租屋物件網址（例如 https://rent.591.com.tw/12345678）", 400, "UNSUPPORTED_URL");
}

export function normalize5168Url(url) {
  const host = hostOf(url.hostname);
  if (host !== "rent.houseprice.tw") throw httpError("請貼 5168 單筆租屋物件網址", 400, "UNSUPPORTED_URL");
  const m = url.pathname.match(/^\/house\/([A-Za-z0-9_-]{3,40})\/?$/);
  if (!m) throw httpError("請貼 5168 單筆租屋物件網址（例如 https://rent.houseprice.tw/house/16705651）", 400, "UNSUPPORTED_URL");
  return { id: m[1], normalized: `https://rent.houseprice.tw/house/${m[1]}` };
}

export function normalizeImportUrl(raw) {
  const url = parseHttpsUrl(raw);
  if (isBlockedHostname(url.hostname) || isIpLiteral(url.hostname)) {
    throw httpError("不接受內部或 IP 位址網址", 400, "UNSUPPORTED_URL");
  }
  const provider = providerByHost(url.hostname);
  if (!provider) throw httpError("目前只支援 591 與 5168 的公開物件網址", 400, "UNSUPPORTED_URL");
  const parsed = provider.id === "591" ? normalize591Url(url) : normalize5168Url(url);
  return {
    provider: provider.id,
    original: String(raw || "").trim(),
    normalized: parsed.normalized,
    source_listing_id: parsed.id,
    pageHosts: pageHostsFor(provider.id),
    imageHosts: imageHostsFor(provider.id),
  };
}
