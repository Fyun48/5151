import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  announcementInboxForUser,
  bannerAnnouncements,
  buildSponsoredListingFeed,
  canDeliverSponsoredChannel,
  commsMeta,
  createAnnouncement,
  createCampaign,
  CURRENT_SPONSOR_BENEFITS,
  deliverSponsoredWebhook,
  dismissAnnouncement,
  ensureCommsSchema,
  FORBIDDEN_TARGETING_FIELDS,
  markAnnouncementRead,
  normalizeCommsConfig,
  publicActiveAnnouncements,
  publicActiveCampaigns,
  publicAnnouncementView,
  publicCampaignView,
  publishAnnouncement,
  recordSponsoredEvent,
  resolveActiveAnnouncements,
  resolveActiveCampaigns,
  SPONSORED_CONTENT_TYPE,
  SPONSORED_LABEL,
  sponsoredWebhookPayload,
  supportPresentation,
  SYSTEM_ANNOUNCEMENT_LABEL,
  updateAnnouncement,
  updateCampaign,
} from "../src/comms.js";
import { eventMatrixKey, notifyChannelOn, normalizeNotifyMatrix } from "../src/notifyMatrix.js";
import { eventLabel } from "../src/notify.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureCommsSchema(db);
  return db;
}

const NOW = new Date("2026-09-08T02:00:00.000Z");

test("admin can create announcement; disabled/future/expired stay hidden", () => {
  const db = open();
  const draft = createAnnouncement(db, 1, { title: "一般維護預告", body: "凌晨暫停抓取", severity: "info" }, NOW);
  assert.equal(draft.status, "draft");
  assert.equal(publicActiveAnnouncements(db, NOW).length, 0);
  publishAnnouncement(db, 1, draft.id, NOW);
  assert.equal(resolveActiveAnnouncements(db, NOW).length, 1);

  createAnnouncement(db, 1, {
    title: "已關閉",
    body: "不要顯示",
    status: "published",
    enabled: false,
  }, NOW);
  createAnnouncement(db, 1, {
    title: "未來才出現",
    body: "還沒開始",
    status: "published",
    enabled: true,
    start_at: "2026-12-01T00:00:00.000Z",
  }, NOW);
  createAnnouncement(db, 1, {
    title: "已過期",
    body: "結束了",
    status: "published",
    enabled: true,
    end_at: "2026-01-01T00:00:00.000Z",
  }, NOW);
  const active = publicActiveAnnouncements(db, NOW);
  assert.equal(active.length, 1);
  assert.equal(active[0].title, "一般維護預告");
  assert.equal(active[0].label, SYSTEM_ANNOUNCEMENT_LABEL);
  assert.equal("created_by" in active[0], false);
  db.close();
});

test("important announcement can banner; ads cannot", () => {
  const db = open();
  const info = createAnnouncement(db, 1, {
    title: "一般通知",
    body: "放通知匣",
    severity: "info",
    status: "published",
    enabled: true,
    banner: true,
  }, NOW);
  const important = createAnnouncement(db, 1, {
    title: "重要維護",
    body: "今晚暫停",
    severity: "important",
    status: "published",
    enabled: true,
    banner: true,
  }, NOW);
  const banners = bannerAnnouncements(db, NOW);
  assert.equal(banners.length, 1);
  assert.equal(banners[0].id, important.id);
  assert.equal(publicAnnouncementView(info).banner, false);
  const campaign = createCampaign(db, 1, {
    sponsor_name: "合作A",
    title: " mens compact",
    text: "短文",
    destination_url: "https://example.com/ad",
    status: "published",
    enabled: true,
  }, NOW);
  assert.equal(campaign.content_type, SPONSORED_CONTENT_TYPE);
  assert.ok(!bannerAnnouncements(db, NOW).some((row) => row.content_type === SPONSORED_CONTENT_TYPE));
  db.close();
});

test("read/dismiss is per member and unsafe markup is stripped/rejected", () => {
  const db = open();
  const post = createAnnouncement(db, 1, {
    title: "系統公告一",
    body: "請更新 App",
    status: "published",
    enabled: true,
  }, NOW);
  markAnnouncementRead(db, 9, post.id, NOW);
  dismissAnnouncement(db, 8, post.id, NOW);
  const forNine = announcementInboxForUser(db, 9, NOW);
  const forEight = announcementInboxForUser(db, 8, NOW);
  const forGuest = announcementInboxForUser(db, null, NOW);
  assert.equal(forNine[0].read, true);
  assert.equal(forEight.length, 0);
  assert.equal(forGuest.length, 1);
  assert.throws(() => createAnnouncement(db, 1, {
    title: "<script>alert(1)</script>駭",
    body: "x",
  }, NOW), /不安全/);
  db.close();
});

test("sponsored cards insert without changing organic count/sort/ids", () => {
  const listings = [
    { post_id: "a", title: "一" },
    { post_id: "b", title: "二" },
    { post_id: "c", title: "三" },
    { post_id: "d", title: "四" },
    { post_id: "e", title: "五" },
    { post_id: "f", title: "六" },
  ];
  const campaigns = [{
    id: 11,
    sponsor_name: "合作B",
    title: "短贊助",
    text: "一句話",
    destination_url: "https://example.com/s",
    content_type: SPONSORED_CONTENT_TYPE,
  }];
  const feed = buildSponsoredListingFeed(listings, campaigns, { interval: 5, sessionCap: 3 });
  assert.equal(feed.organicCount, 6);
  assert.deepEqual(feed.organicIds, ["a", "b", "c", "d", "e", "f"]);
  assert.equal(feed.display.filter((row) => row.kind === "listing").length, 6);
  assert.equal(feed.display.filter((row) => row.kind === "sponsored").length, 1);
  assert.equal(feed.display[5].kind, "sponsored");
  assert.equal(feed.display[5].label, SPONSORED_LABEL);
  assert.equal(feed.display[5].campaign.content_type, SPONSORED_CONTENT_TYPE);
  const tighter = buildSponsoredListingFeed(listings, campaigns, { interval: 4 });
  assert.equal(tighter.inserted, 1);
  assert.equal(tighter.organicCount, 6);
});

test("inactive/future/expired/disabled campaigns do not appear; unsafe URL rejected", () => {
  const db = open();
  const cfg = normalizeCommsConfig({ sponsored_master_enabled: true, listing_placement_enabled: true });
  createCampaign(db, 1, {
    title: "關閉中",
    destination_url: "https://example.com/x",
    status: "published",
    enabled: false,
  }, NOW);
  createCampaign(db, 1, {
    title: "未來檔",
    destination_url: "https://example.com/y",
    status: "published",
    enabled: true,
    start_at: "2026-12-01T00:00:00.000Z",
  }, NOW);
  createCampaign(db, 1, {
    title: "過期檔",
    destination_url: "https://example.com/z",
    status: "published",
    enabled: true,
    end_at: "2026-01-01T00:00:00.000Z",
  }, NOW);
  const live = createCampaign(db, 1, {
    title: "進行中",
    destination_url: "https://example.com/ok",
    status: "published",
    enabled: true,
    channels: { inapp: true, webhook: true },
  }, NOW);
  assert.equal(resolveActiveCampaigns(db, cfg, NOW).map((row) => row.id).join(","), String(live.id));
  assert.equal(publicActiveCampaigns(db, { ...cfg, sponsored_master_enabled: false }, NOW).length, 0);
  assert.throws(() => createCampaign(db, 1, {
    title: "壞網址",
    destination_url: "javascript:alert(1)",
  }, NOW), /http\/https/);
  assert.throws(() => createCampaign(db, 1, {
    title: "data",
    destination_url: "data:text/html,hi",
  }, NOW), /http\/https/);
  db.close();
});

test("sponsored notification type is not system/important; channel and user prefs gate delivery", async () => {
  const db = open();
  const campaign = createCampaign(db, 1, {
    title: "贊助通知",
    text: "看這裡",
    destination_url: "https://example.com/n",
    status: "published",
    enabled: true,
    channels: { inapp: true, webhook: true, email: true, push: true },
  }, NOW);
  assert.equal(eventMatrixKey("sponsored"), "sponsored");
  assert.equal(eventMatrixKey("system"), "system");
  assert.notEqual(eventMatrixKey("sponsored"), eventMatrixKey("system"));
  assert.equal(eventLabel("sponsored"), SPONSORED_LABEL);
  assert.equal(eventLabel("system"), SYSTEM_ANNOUNCEMENT_LABEL);
  const defaults = normalizeNotifyMatrix({});
  assert.equal(defaults.sponsored.dock, false);
  assert.equal(defaults.sponsored.webhook, false);
  assert.equal(defaults.system.dock, true);
  assert.equal(notifyChannelOn({ notifyMatrix: defaults }, "webhook", "sponsored"), false);
  assert.equal(notifyChannelOn({
    notifyMatrix: { ...defaults, sponsored: { ...defaults.sponsored, webhook: true } },
    discordWebhook: "https://example.com/hook",
  }, "webhook", "sponsored"), true);

  const off = canDeliverSponsoredChannel(campaign, "webhook", {
    notifyMatrix: defaults,
    discordWebhook: "https://example.com/hook",
  });
  assert.equal(off.ok, false);
  const noAdapter = await deliverSponsoredWebhook(db, {
    campaign,
    userId: 3,
    settings: {
      notifyMatrix: { ...defaults, sponsored: { dock: false, push: false, webhook: true, mail: false } },
      discordWebhook: "https://example.com/hook",
    },
  });
  assert.equal(noAdapter.delivered, false);
  assert.equal(noAdapter.state, "unsupported");

  let sent = null;
  const ok = await deliverSponsoredWebhook(db, {
    campaign,
    userId: 3,
    settings: {
      notifyMatrix: { ...defaults, sponsored: { dock: false, push: false, webhook: true, mail: false } },
      discordWebhook: "https://example.com/hook",
    },
    sender: async (url, payload) => { sent = { url, payload }; },
  });
  assert.equal(ok.delivered, true);
  assert.equal(sent.payload.type, "sponsored");
  assert.equal(sent.payload.campaign_id, String(campaign.id));
  assert.match(sent.payload.content, /贊助內容/);

  const pushOff = canDeliverSponsoredChannel(campaign, "push", {
    notifyMatrix: { ...defaults, sponsored: { ...defaults.sponsored, push: true } },
  }, { pushPermission: "denied", pushSubscribed: false, pushConfigured: true });
  assert.equal(pushOff.ok, false);
  assert.match(pushOff.detail, /push/);

  const systemStillOn = notifyChannelOn({
    notifyMatrix: { ...defaults, sponsored: { dock: false, push: false, webhook: false, mail: false } },
  }, "dock", "system");
  assert.equal(systemStillOn, true);
  db.close();
});

test("support presentation reuses real benefits and is not an ad or modal", () => {
  const offer = supportPresentation({
    support_entry_enabled: true,
    support_card_enabled: true,
    support_card_interval: 24,
  }, { sponsored: false }, { plan: "free", role: "member" });
  assert.equal(offer.content_type, "support");
  assert.equal(offer.label, "支持本站");
  assert.equal(offer.blocking, false);
  assert.equal(offer.modal, false);
  assert.equal(offer.show_entry, true);
  assert.deepEqual(offer.benefits.map((row) => row.id), CURRENT_SPONSOR_BENEFITS.map((row) => row.id));
  assert.ok(offer.benefits.some((row) => /100 張/.test(row.label)));
  assert.ok(offer.benefits.some((row) => /591／5168/.test(row.label)));
  const sponsor = supportPresentation({ support_entry_enabled: true, support_card_enabled: true }, {}, { plan: "sponsor" });
  assert.equal(sponsor.show_entry, false);
  assert.equal(sponsor.sponsored, true);
  assert.ok(FORBIDDEN_TARGETING_FIELDS.includes("race"));
  assert.ok(!commsMeta().forbidden_targeting.includes("listing_feed"));
});

test("public campaign view hides admin actor and impression analytics stay privacy-light", () => {
  const db = open();
  const campaign = createCampaign(db, 99, {
    title: "公開卡",
    destination_url: "https://example.com/p",
    status: "published",
    enabled: true,
  }, NOW);
  const pub = publicCampaignView(campaign);
  assert.equal("created_by" in pub, false);
  assert.equal("impressions" in pub, false);
  recordSponsoredEvent(db, campaign.id, "impression", "listing", NOW);
  recordSponsoredEvent(db, campaign.id, "click", "listing", NOW);
  const admin = publicCampaignView(updateCampaign(db, 99, campaign.id, { title: "公開卡" }, NOW), { includeAdmin: true });
  assert.equal(admin.impressions, 1);
  assert.equal(admin.clicks, 1);
  db.close();
});
