import { test } from "node:test";
import assert from "node:assert/strict";
import { validateOutboundUrl, configuredAllowHosts, hostIsForbidden } from "../src/outboundUrl.js";

const ALLOW = ["discord.com", "hooks.slack.com", "example.com"];
const resolve = (addrs) => async (_host, _opts) => addrs;

test("rejects non-HTTPS", async () => {
  assert.equal((await validateOutboundUrl("http://discord.com/hook", { allowedHosts: ALLOW, resolveImpl: resolve([{ address: "8.8.8.8" }]) })).reason, "not_https");
});

test("rejects credentials in URL", async () => {
  assert.equal((await validateOutboundUrl("https://user:pass@discord.com/hook", { allowedHosts: ALLOW, resolveImpl: resolve([{ address: "8.8.8.8" }]) })).reason, "credentials_in_url");
});

test("rejects host not in allowlist", async () => {
  assert.equal((await validateOutboundUrl("https://evil.example/hook", { allowedHosts: ALLOW, resolveImpl: resolve([{ address: "8.8.8.8" }]) })).reason, "host_not_allowed");
});

test("rejects localhost and 127.0.0.1", async () => {
  assert.equal((await validateOutboundUrl("https://localhost/hook", { allowedHosts: ["localhost"], resolveImpl: resolve([{ address: "127.0.0.1" }]) })).reason, "forbidden_address");
  assert.equal((await validateOutboundUrl("https://127.0.0.1/hook", { allowedHosts: ["127.0.0.1"], resolveImpl: resolve([{ address: "127.0.0.1" }]) })).reason, "forbidden_address");
});

test("rejects RFC1918 and link-local/metadata addresses", async () => {
  for (const ip of ["10.0.0.5", "172.16.0.5", "192.168.1.5", "169.254.169.254", "100.64.0.1"]) {
    assert.equal(hostIsForbidden(ip), true, ip);
    assert.equal((await validateOutboundUrl(`https://${ip}/hook`, { allowedHosts: [ip], resolveImpl: resolve([{ address: ip }]) })).reason, "forbidden_address", ip);
  }
});

test("rejects IPv6 loopback / ULA / link-local", async () => {
  for (const ip of ["::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(hostIsForbidden(ip), true, ip);
  }
  assert.equal((await validateOutboundUrl("https://[::1]/hook", { allowedHosts: ["::1"], resolveImpl: resolve([{ address: "::1" }]) })).reason, "forbidden_address");
});

test("rejects a hostname whose DNS resolves to a private address", async () => {
  const r = await validateOutboundUrl("https://discord.com/hook", { allowedHosts: ALLOW, resolveImpl: resolve([{ address: "192.168.1.10" }]) });
  assert.equal(r.reason, "forbidden_address");
});

test("fails closed on DNS failure", async () => {
  const r = await validateOutboundUrl("https://discord.com/hook", { allowedHosts: ALLOW, resolveImpl: async () => { throw new Error("NXDOMAIN"); } });
  assert.equal(r.reason, "dns_failed");
});

test("allows an allowed public webhook (resolved to public IP)", async () => {
  const r = await validateOutboundUrl("https://discord.com/api/webhooks/1/abc", { allowedHosts: ALLOW, resolveImpl: resolve([{ address: "8.8.8.8" }]) });
  assert.equal(r.ok, true);
  assert.equal(r.hostname, "discord.com");
});

test("allowlist is suffix-aware and configurable", () => {
  const hosts = configuredAllowHosts({ OPS_OUTBOUND_ALLOW_HOSTS: "webhook.example.com, hooks.slack.com" });
  assert.ok(hosts.includes("webhook.example.com"));
  assert.ok(hosts.includes("hooks.slack.com"));
  assert.ok(hosts.includes("discord.com"));
});
