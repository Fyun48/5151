import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SPONSOR_INTRO,
  normalizeSponsorConfig,
  publicSponsorLinks,
  publicSponsorOffer,
  sanitizeHttpUrl,
  SPONSOR_PROVIDERS,
} from "../src/sponsorLinks.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("catalog covers no-monthly-fee card options", () => {
  const ids = SPONSOR_PROVIDERS.map((row) => row.id);
  assert.deepEqual(ids, ["opay", "ezpay", "oen", "kofi", "paypal", "bmc", "github"]);
  for (const row of SPONSOR_PROVIDERS) {
    assert.match(row.signupUrl, /^https:\/\//);
    assert.ok(row.feeNote);
    assert.ok(row.hint);
  }
});

test("sanitizeHttpUrl keeps http(s) and drops javascript", () => {
  assert.equal(sanitizeHttpUrl("https://ko-fi.com/demo"), "https://ko-fi.com/demo");
  assert.equal(sanitizeHttpUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeHttpUrl("data:text/html,hi"), "");
});

test("enabled provider without url is not public", () => {
  const cfg = normalizeSponsorConfig({
    providers: {
      opay: { url: "https://payment.opay.tw/example", enabled: true, label: "歐付寶" },
      kofi: { url: "", enabled: true, label: "Ko-fi" },
    },
    extras: [
      { id: "custom-1", label: "轉帳說明", url: "https://example.com/bank", enabled: true },
      { id: "bad", label: "壞連結", url: "javascript:alert(1)", enabled: true },
    ],
  });
  assert.equal(cfg.providers.opay.enabled, true);
  assert.equal(cfg.providers.kofi.enabled, false);
  const links = publicSponsorLinks(cfg);
  assert.equal(links.length, 2);
  assert.equal(links[0].url, "https://payment.opay.tw/example");
  assert.equal(links[1].label, "轉帳說明");
});

test("free members see links; admins and sponsors do not", () => {
  const cfg = normalizeSponsorConfig({
    intro: DEFAULT_SPONSOR_INTRO,
    providers: { paypal: { url: "https://paypal.me/demo", enabled: true } },
  });
  const free = publicSponsorOffer(cfg, { role: "member", plan: "free" });
  assert.equal(free.show, true);
  assert.equal(free.links.length, 1);
  assert.equal(free.links[0].label, "PayPal");
  assert.equal(free.links[0].blurb, "海外卡");
  const sponsor = publicSponsorOffer(cfg, { role: "member", plan: "sponsor" });
  assert.equal(sponsor.show, false);
  assert.equal(sponsor.sponsored, true);
  assert.equal(sponsor.links.length, 0);
  const admin = publicSponsorOffer(cfg, { role: "admin", plan: "free" });
  assert.equal(admin.show, false);
  assert.equal(admin.links.length, 0);
});

test("admin and index pages include sponsor UI", () => {
  const admin = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  assert.match(admin, /贊助連結/);
  assert.match(admin, /\/api\/admin\/sponsor/);
  assert.match(admin, /歐付寶/);
  assert.match(admin, /幫收 Link/);
  assert.doesNotThrow(() => {
    const blocks = [...admin.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const block of blocks) {
      if (/\bsrc\s*=/i.test(block[1])) continue;
      new Function(block[2]);
    }
  });
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /id="sponsorBar"/);
  assert.match(html, /paintSponsorOffer/);
  assert.match(html, /me\.sponsor/);
});
