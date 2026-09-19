// OPS 對外目標（webhook / remote）的 SSRF 防護：共用 outbound URL validator。
// 只放行 https + 明確 allowlist host，且解析後不得落到 loopback/private/link-local/metadata/ULA。
// DNS 失敗一律 fail-closed。
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export const DEFAULT_ALLOWED_HOSTS = Object.freeze(["discord.com", "discordapp.com", "hooks.slack.com"]);
export const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB

export function configuredAllowHosts(env = process.env) {
  const extra = String(env.OPS_OUTBOUND_ALLOW_HOSTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_HOSTS, ...extra])];
}

export function hostAllowed(hostname, allowed) {
  const h = String(hostname || "").toLowerCase();
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

function isForbiddenIPv4(host) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c, d] = parts;
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local / metadata (169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

function isForbiddenIPv6(host) {
  let h = String(host).toLowerCase().replace(/%.*$/, "");
  if (h.startsWith("::ffff:")) return isForbiddenIPv4(h.slice(7));
  if (h === "::1" || h === "::") return true;
  const compact = h.replace(/:/g, "");
  if (/^f[cd]/.test(compact)) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(compact)) return true; // link-local fe80::/10
  return false;
}

export function hostIsForbidden(host) {
  const h = String(host || "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return isForbiddenIPv4(h);
  if (isIP(h) === 6) return isForbiddenIPv6(h);
  return false;
}

// resolveImpl: (host, { all:true }) => [{ address }] (node:dns/promises.lookup)。可注入供測試。
export async function validateOutboundUrl(rawUrl, {
  env = process.env,
  resolveImpl = dnsLookup,
  allowedHosts = configuredAllowHosts(env),
} = {}) {
  let url;
  try { url = new URL(String(rawUrl || "")); } catch { return { ok: false, reason: "invalid_url" }; }
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) return { ok: false, reason: "missing_host" };
  if (!hostAllowed(hostname, allowedHosts)) return { ok: false, reason: "host_not_allowed" };

  if (isIP(hostname)) {
    if (hostIsForbidden(hostname)) return { ok: false, reason: "forbidden_address" };
  } else if (resolveImpl) {
    let addrs;
    try { addrs = await resolveImpl(hostname, { all: true }); } catch { return { ok: false, reason: "dns_failed" }; }
    if (!addrs || !addrs.length) return { ok: false, reason: "dns_failed" };
    for (const item of addrs) {
      const ip = item && item.address ? item.address : item;
      if (hostIsForbidden(ip)) return { ok: false, reason: "forbidden_address" };
    }
  }
  return { ok: true, url: url.toString(), hostname };
}
