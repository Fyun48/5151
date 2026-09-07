/** SSRF 防護的對外抓取：只允許 HTTPS、精確 host 白名單、驗證轉址與解析位址。失敗一律拒絕。 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export const IMPORT_USER_AGENT = "JibbyRentImport/1.0 (+https://c5151.reversalplay.me)";

export const FETCH_LIMITS = {
  htmlMaxBytes: 1_500_000,
  imageMaxBytes: 8 * 1024 * 1024,
  timeoutMs: 10_000,
  maxRedirects: 3,
  maxPhotos: 12,
};

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
]);

let testFetch = null;
let testLookup = null;

export function _setSafeFetchForTests({ fetchImpl = null, lookupImpl = null } = {}) {
  testFetch = fetchImpl;
  testLookup = lookupImpl;
}

function httpError(message, status = 400, code = "UNSUPPORTED_URL") {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function hostnameOf(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

export function isIpv4Literal(host) {
  const h = hostnameOf(host);
  if (!h || isIP(h) !== 4) return false;
  return true;
}

export function isIpv6Literal(host) {
  const h = hostnameOf(host).replace(/^\[/, "").replace(/\]$/, "");
  return isIP(h) === 6;
}

export function isIpLiteral(host) {
  return isIpv4Literal(host) || isIpv6Literal(host);
}

function ipv4ToInt(ip) {
  const parts = String(ip).split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inCidr(ip, base, bits) {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
  return (a & mask) === (b & mask);
}

export function isPrivateOrBlockedIPv4(ip) {
  const text = String(ip || "").replace(/^::ffff:/i, "");
  if (!isIpv4Literal(text)) return false;
  if (inCidr(text, "0.0.0.0", 8)) return true;
  if (inCidr(text, "10.0.0.0", 8)) return true;
  if (inCidr(text, "127.0.0.0", 8)) return true;
  if (inCidr(text, "169.254.0.0", 16)) return true;
  if (inCidr(text, "172.16.0.0", 12)) return true;
  if (inCidr(text, "192.168.0.0", 16)) return true;
  if (inCidr(text, "100.64.0.0", 10)) return true;
  if (text === "255.255.255.255") return true;
  return false;
}

export function isPrivateOrBlockedIPv6(ip) {
  const text = String(ip || "").toLowerCase();
  if (text === "::1" || text === "https://example.net/id/garnet") return true;
  if (text.startsWith("fe80:")) return true;
  if (text.startsWith("fc") || text.startsWith("fd")) return true;
  if (text.startsWith("::ffff:")) {
    const v4 = text.slice(7);
    return isPrivateOrBlockedIPv4(v4);
  }
  return false;
}

export function isBlockedResolvedAddress(addr) {
  const text = String(addr || "").replace(/^\[/, "").replace(/\]$/, "");
  if (isIpv4Literal(text) || text.startsWith("::ffff:")) return isPrivateOrBlockedIPv4(text);
  if (isIpv6Literal(text)) return isPrivateOrBlockedIPv6(text);
  return true;
}

export function isBlockedHostname(host) {
  const h = hostnameOf(host);
  if (!h) return true;
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (isIpLiteral(h)) return true;
  return false;
}

export function parseHttpsUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) throw httpError("請提供網址", 400, "UNSUPPORTED_URL");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw httpError("網址格式不正確", 400, "UNSUPPORTED_URL");
  }
  const scheme = url.protocol.replace(":", "").toLowerCase();
  if (scheme !== "https") {
    const code = ["file", "ftp", "data", "javascript", "http"].includes(scheme) ? "UNSUPPORTED_URL" : "UNSUPPORTED_URL";
    throw httpError("只接受 HTTPS 的公開物件網址", 400, code);
  }
  if (url.username || url.password) throw httpError("不接受含帳密的網址", 400, "UNSUPPORTED_URL");
  const host = hostnameOf(url.hostname);
  if (!host) throw httpError("網址沒有主機名稱", 400, "UNSUPPORTED_URL");
  if (isBlockedHostname(host) || isIpLiteral(host)) {
    throw httpError("不接受內部或 IP 位址網址", 400, "UNSUPPORTED_URL");
  }
  return url;
}

export function assertAllowedHost(url, allowedHosts) {
  const host = hostnameOf(url.hostname);
  const allow = new Set((allowedHosts || []).map((h) => hostnameOf(h)));
  if (!allow.has(host)) throw httpError("這個網域不在支援清單", 400, "UNSUPPORTED_URL");
}

async function resolvePublicAddresses(hostname, lookupImpl) {
  const host = hostnameOf(hostname);
  if (isBlockedHostname(host)) throw httpError("不接受內部主機", 400, "UNSUPPORTED_URL");
  const lookup = lookupImpl || testLookup || ((name, opts) => dnsLookup(name, opts));
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw httpError("無法確認來源主機，已拒絕抓取", 400, "UNSUPPORTED_URL");
  }
  const list = Array.isArray(records) ? records : records ? [records] : [];
  if (!list.length) throw httpError("無法確認來源主機，已拒絕抓取", 400, "UNSUPPORTED_URL");
  const addrs = list.map((row) => String(row.address || row || "")).filter(Boolean);
  if (!addrs.length || addrs.some((addr) => isBlockedResolvedAddress(addr))) {
    throw httpError("來源主機解析到內部位址，已拒絕抓取", 400, "UNSUPPORTED_URL");
  }
  return addrs;
}

function headerLocation(res) {
  if (typeof res.headers?.get === "function") return res.headers.get("location") || "";
  return String(res.headers?.location || "");
}

async function readBoundedBody(res, maxBytes) {
  const len = Number(res.headers?.get?.("content-length") || res.headers?.["content-length"] || 0);
  if (len > maxBytes) throw httpError("來源回應過大", 400, "FETCH_BLOCKED");
  if (typeof res.arrayBuffer === "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw httpError("來源回應過大", 400, "FETCH_BLOCKED");
    return buf;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw httpError("來源回應過大", 400, "FETCH_BLOCKED");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 抓取允許的 HTTPS 網址。每個轉址目標都必須仍在白名單，且解析位址不可為內部網段。
 * @param {string} raw
 * @param {{ allowedHosts: string[], maxBytes?: number, timeoutMs?: number, accept?: string, fetchImpl?: Function, lookupImpl?: Function }} opts
 */
export async function safeFetchBuffer(raw, opts = {}) {
  const allowedHosts = opts.allowedHosts || [];
  const maxBytes = Number(opts.maxBytes) || FETCH_LIMITS.htmlMaxBytes;
  const timeoutMs = Number(opts.timeoutMs) || FETCH_LIMITS.timeoutMs;
  const fetchImpl = opts.fetchImpl || testFetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw httpError("抓取器尚未就緒", 503, "FETCH_BLOCKED");

  let current = parseHttpsUrl(raw);
  assertAllowedHost(current, allowedHosts);
  await resolvePublicAddresses(current.hostname, opts.lookupImpl);

  for (let hop = 0; hop <= FETCH_LIMITS.maxRedirects; hop += 1) {
    let res;
    try {
      res = await fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": IMPORT_USER_AGENT,
          Accept: opts.accept || "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.code) throw error;
      throw httpError("來源暫時無法連線", 400, "SOURCE_UNAVAILABLE");
    }

    const status = Number(res.status) || 0;
    if (status >= 300 && status < 400) {
      const loc = headerLocation(res);
      if (!loc) throw httpError("轉址目標無效", 400, "UNSUPPORTED_URL");
      let next;
      try {
        next = new URL(loc, current);
      } catch {
        throw httpError("轉址目標無效", 400, "UNSUPPORTED_URL");
      }
      if (next.protocol !== "https:") throw httpError("轉址必須仍是 HTTPS", 400, "UNSUPPORTED_URL");
      if (isBlockedHostname(next.hostname) || isIpLiteral(next.hostname)) {
        throw httpError("不接受轉到內部或 IP 位址", 400, "UNSUPPORTED_URL");
      }
      assertAllowedHost(next, allowedHosts);
      await resolvePublicAddresses(next.hostname, opts.lookupImpl);
      current = next;
      continue;
    }

    return { url: current.toString(), status, headers: res.headers, body: await readBoundedBody(res, maxBytes) };
  }
  throw httpError("轉址次數過多", 400, "UNSUPPORTED_URL");
}

export async function safeFetchText(raw, opts = {}) {
  const got = await safeFetchBuffer(raw, { ...opts, maxBytes: opts.maxBytes || FETCH_LIMITS.htmlMaxBytes });
  return { ...got, text: got.body.toString("utf8") };
}
