import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createAnnouncement,
  createCampaign,
  ensureCommsSchema,
  publicActiveAnnouncements,
  publicActiveCampaigns,
  SPONSORED_CONTENT_TYPE,
  SYSTEM_ANNOUNCEMENT_LABEL,
} from "../src/comms.js";
import {
  adminBroadcastsView,
  LEGACY_BROADCASTS_USER_FACING,
  normalizeBroadcasts,
  publicBroadcasts,
  publicBroadcastsRuntime,
  rejectLegacyBroadcastMutation,
} from "../src/broadcasts.js";
import {
  adminSiteAdsView,
  LEGACY_SITE_ADS_USER_FACING,
  normalizeSiteAds,
  publicSiteAds,
  publicSiteAdsRuntime,
  rejectLegacySiteAdMutation,
  SITE_AD_SLOTS,
} from "../src/siteAds.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(dir, "..", p), "utf8");
const NOW = new Date("2026-09-08T03:00:00.000Z");

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureCommsSchema(db);
  return db;
}

test("system announcements have one canonical public runtime source", () => {
  const db = open();
  createAnnouncement(db, 1, {
    title: "正規系統公告",
    body: "這是唯一前台來源",
    status: "published",
    enabled: true,
  }, NOW);
  const active = publicActiveAnnouncements(db, NOW);
  assert.equal(active.length, 1);
  assert.equal(active[0].title, "正規系統公告");
  assert.equal(active[0].label, SYSTEM_ANNOUNCEMENT_LABEL);
  assert.equal(LEGACY_BROADCASTS_USER_FACING, false);
  assert.deepEqual(publicBroadcastsRuntime(), []);
  db.close();
});

test("legacy broadcast mutation cannot create a second end-user announcement path", () => {
  const historical = normalizeBroadcasts({
    items: {
      announcement: { enabled: true, title: "舊 hop 公告", body: "不應再出現在前台", hops: 1 },
    },
  });
  assert.equal(publicBroadcasts(historical).length, 1);
  assert.deepEqual(publicBroadcastsRuntime(historical), []);
  assert.throws(() => rejectLegacyBroadcastMutation(), (error) => (
    error.status === 409 && error.code === "legacy_broadcasts_readonly"
  ));
  const dbSrc = read("src/db.js");
  assert.match(dbSrc, /function saveAdminBroadcastsSettings/);
  assert.match(dbSrc, /rejectLegacyBroadcastMutation/);
  assert.match(dbSrc, /function publicBroadcastsSettings/);
  assert.match(dbSrc, /publicBroadcastsRuntime/);
  assert.doesNotMatch(dbSrc, /writeSettingKey\("broadcasts"/);
});

test("sponsored campaigns have one canonical public runtime source", () => {
  const db = open();
  createCampaign(db, 1, {
    sponsor_name: "逆遊科技",
    title: "正規贊助卡",
    destination_url: "https://example.com/s",
    status: "published",
    enabled: true,
    listing_placement: true,
  }, NOW);
  const cfg = { sponsored_master_enabled: true, listing_placement_enabled: true, listing_ad_interval: 5 };
  const active = publicActiveCampaigns(db, cfg, NOW);
  assert.equal(active.length, 1);
  assert.equal(active[0].content_type, SPONSORED_CONTENT_TYPE);
  assert.equal(active[0].title, "正規贊助卡");
  assert.equal(LEGACY_SITE_ADS_USER_FACING, false);
  const runtime = publicSiteAdsRuntime();
  for (const slot of SITE_AD_SLOTS) assert.equal(runtime[slot.id], null);
  db.close();
});

test("legacy siteAds cannot inject a second independent ad path", () => {
  const historical = normalizeSiteAds({
    slots: {
      listings: { enabled: true, title: "舊列表廣告", text: "不應再插入", url: "https://example.com/old" },
      native: { enabled: true, title: "舊卡片廣告", url: "https://example.com/card" },
    },
  });
  assert.equal(publicSiteAds(historical).listings.title, "舊列表廣告");
  const runtime = publicSiteAdsRuntime(historical);
  assert.equal(runtime.listings, null);
  assert.equal(runtime.native, null);
  assert.throws(() => rejectLegacySiteAdMutation(), (error) => (
    error.status === 409 && error.code === "legacy_site_ads_readonly"
  ));
  const dbSrc = read("src/db.js");
  assert.match(dbSrc, /rejectLegacySiteAdMutation/);
  assert.match(dbSrc, /publicSiteAdsRuntime/);
  assert.doesNotMatch(dbSrc, /writeSettingKey\("siteAds"/);
});

test("historical legacy data remains readable for admin", () => {
  const broadcasts = adminBroadcastsView({
    items: {
      announcement: { enabled: true, title: "舊公告仍可讀", body: "歷史", hops: 3 },
    },
  });
  assert.equal(broadcasts.config.items.announcement.title, "舊公告仍可讀");
  assert.equal(broadcasts.config.items.announcement.enabled, true);
  const ads = adminSiteAdsView({
    slots: {
      login: { enabled: true, title: "舊登入廣告", text: "歷史" },
    },
  });
  assert.equal(ads.config.slots.login.title, "舊登入廣告");
  assert.equal(ads.config.slots.login.enabled, true);
  const admin = read("public/admin.html");
  assert.match(admin, /id="broadcastsForm"/);
  assert.match(admin, /id="adsForm"/);
  assert.match(admin, /歷史 hop 公告僅供檢視/);
  assert.match(admin, /歷史版位僅供檢視/);
  assert.match(admin, /id="broadcastsSave" disabled/);
  assert.match(admin, /id="adsSave" disabled/);
});
