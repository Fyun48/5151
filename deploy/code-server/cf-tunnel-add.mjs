#!/usr/bin/env node
/**
 * 用 Cloudflare API 幫「遠端管理（token）模式」的 cloudflared tunnel 加一個 Public Hostname + DNS。
 *
 * 為什麼需要：NAS 上的 `jgitea-tunnel` 是用 `--token` 啟動（設定放在 Cloudflare 端），
 * 本機沒有 config.yml，所以新增 hostname 只能走 dashboard 或 API。這支把 API 路徑自動化，
 * 之後要再加服務（例如 agent console）只要改 PUBLIC_HOSTNAME/SERVICE 重跑。
 *
 * 用法（在 NAS 上，用 --network host 的 node 容器跑）
 *   docker run --rm --network host \
 *     -e CF_API_TOKEN=... -e CF_ACCOUNT_ID=... -e CF_TUNNEL_ID=... \
 *     -e PUBLIC_HOSTNAME=code.reversalplay.me -e SERVICE=http://localhost:8484 \
 *     -v "$PWD/cf-tunnel-add.mjs:/cf.mjs:ro" node:22-bookworm-slim node /cf.mjs
 *
 * 行為（idempotent）：
 *   1) 讀取 tunnel 現有 ingress，移除同名的舊規則，插到 catch-all（http_status:404）之前。
 *   2) 確保 zone 內有指向 <tunnel>.cfargotunnel.com 的 proxied CNAME。
 *   3) 不改動其他既有規則（例如 jgitea01）。
 */
const API = "https://api.cloudflare.com/client/v4";
const {
  CF_API_TOKEN: TOKEN,
  CF_ACCOUNT_ID: ACCOUNT,
  CF_TUNNEL_ID: TUNNEL,
  PUBLIC_HOSTNAME: HOST,
  SERVICE,
  CF_ZONE_NAME: ZONE = "reversalplay.me",
} = process.env;

function need(name, v) { if (!v) { console.error(`缺少環境變數 ${name}`); process.exit(2); } return v; }
need("CF_API_TOKEN", TOKEN); need("CF_ACCOUNT_ID", ACCOUNT); need("CF_TUNNEL_ID", TUNNEL);
need("PUBLIC_HOSTNAME", HOST); need("SERVICE", SERVICE);

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok || body.success === false) {
    console.error(`Cloudflare ${init.method || "GET"} ${path} → HTTP ${res.status}`, JSON.stringify(body.errors || body).slice(0, 400));
    process.exit(1);
  }
  return body.result;
}

const cfg = await cf(`/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`);
const ingress = (cfg?.config?.ingress || []).filter((r) => r.hostname !== HOST);
const catchAllIdx = ingress.findIndex((r) => !r.hostname);
const rule = { hostname: HOST, service: SERVICE };
if (catchAllIdx >= 0) ingress.splice(catchAllIdx, 0, rule); else ingress.push(rule);
await cf(`/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`, {
  method: "PUT",
  body: JSON.stringify({ config: { ...(cfg?.config || {}), ingress } }),
});
console.log(`ingress 已更新：${HOST} → ${SERVICE}`);
console.log(JSON.stringify(ingress, null, 2));

const zones = await cf(`/zones?name=${encodeURIComponent(ZONE)}`);
const zoneId = zones?.[0]?.id;
if (!zoneId) { console.error(`找不到 zone ${ZONE}`); process.exit(1); }
const target = `${TUNNEL}.cfargotunnel.com`;
const existing = await cf(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(HOST)}`);
if (existing?.length) {
  console.log(`DNS 已存在：${existing[0].type} ${existing[0].name} → ${existing[0].content} (proxied=${existing[0].proxied})`);
} else {
  const rec = await cf(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: "CNAME", name: HOST, content: target, proxied: true, ttl: 1, comment: "5151 code-server via jgitea-tunnel" }),
  });
  console.log(`DNS 已建立：${rec.type} ${rec.name} → ${rec.content} (proxied=${rec.proxied})`);
}
