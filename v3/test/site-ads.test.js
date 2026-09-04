import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSiteAds, publicSiteAds, SITE_AD_SLOTS } from "../src/siteAds.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("site ads sanitize urls and hide empty slots", () => {
  assert.deepEqual(SITE_AD_SLOTS.map((row) => row.id), ["listings", "between", "native", "login", "me"]);
  const cfg = normalizeSiteAds({
    slots: {
      listings: {
        enabled: true,
        title: "附近早餐",
        text: "走路三分鐘",
        url: "https://example.com/breakfast",
        image_url: "javascript:alert(1)",
      },
      login: { enabled: true, title: "", text: "沒標題不算開", url: "https://example.com" },
      me: { enabled: false, title: "關著", url: "https://example.com/x" },
    },
  });
  assert.equal(cfg.slots.listings.enabled, true);
  assert.equal(cfg.slots.listings.image_url, "");
  assert.equal(cfg.slots.login.enabled, false);
  const pub = publicSiteAds(cfg);
  assert.equal(pub.listings.title, "附近早餐");
  assert.equal(pub.listings.url, "https://example.com/breakfast");
  assert.equal(pub.login, null);
  assert.equal(pub.me, null);
});

test("admin, index, login and server expose site ads", () => {
  const admin = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  const index = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const login = readFileSync(path.join(dir, "../public/login.html"), "utf8");
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const auth = readFileSync(path.join(dir, "../src/auth.js"), "utf8");
  assert.match(admin, /站內小廣告/);
  assert.match(admin, /\/api\/admin\/ads/);
  assert.match(admin, /不是 Google Ads/);
  assert.match(index, /id="adListings"/);
  assert.match(index, /id="adMe"/);
  assert.match(index, /贊助訊息/);
  assert.match(login, /id="adLogin"/);
  assert.match(server, /getAdminAdsSettings/);
  assert.match(server, /app\.get\("\/api\/ads"/);
  assert.match(auth, /\/api\/ads/);
  const blocks = [...admin.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    if (/\bsrc\s*=/i.test(block[1])) continue;
    assert.doesNotThrow(() => new Function(block[2]));
  }
});
