import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(dir, "..", p), "utf8");
const html = read("public/index.html");
const admin = read("public/admin.html");
const sw = read("public/sw.js");
const server = read("src/server.js");
const auth = read("src/auth.js");
const db = read("src/db.js");
const comms = read("src/comms.js");

function assertScriptsParse(source) {
  const blocks = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    if (/\bsrc\s*=/i.test(block[1])) continue;
    assert.doesNotThrow(() => new Function(block[2]));
  }
}

test("user-facing labels keep announcements, ads, and support distinct", () => {
  assert.match(html, /id="announceBanner"/);
  assert.ok(html.indexOf('id="announceBanner"') < html.indexOf('id="listingsView"'), "important banner sits above the listing wrap");
  assert.match(html, /系統公告/);
  assert.match(html, /贊助內容/);
  assert.match(html, /支持本站/);
  assert.match(html, /data-notify-row="system"/);
  assert.match(html, /data-notify-row="sponsored"/);
  assert.match(html, /id="supportAccountCard"/);
  assert.match(html, /id="supportFooterLink"/);
  assert.match(html, /insertFeedExtras/);
  assert.match(html, /sponsored-card/);
  assert.match(html, /data-notify-row="sponsored" data-notify-ch="dock" \/>/);
});

test("listing insertion does not rewrite organic listing APIs", () => {
  assert.match(server, /app\.get\("\/api\/sponsored"/);
  assert.match(server, /app\.get\("\/api\/announcements"/);
  assert.match(server, /app\.get\("\/api\/comms"/);
  assert.match(server, /requireAdminApi/);
  assert.match(auth, /p === "\/api\/comms"/);
  assert.doesNotMatch(db, /content_type: "sponsored"/);
  assert.match(db, /function listListings/);
});

test("admin manages announcements, campaigns, and support presentation separately", () => {
  assert.match(admin, /id="announceForm"/);
  assert.match(admin, /id="campaignForm"/);
  assert.match(admin, /id="supportConfigForm"/);
  assert.match(admin, /\/api\/admin\/announcements/);
  assert.match(admin, /\/api\/admin\/campaigns/);
  assert.match(admin, /\/api\/admin\/comms-config/);
  assert.match(admin, /這是服務資訊，不是廣告/);
  assert.match(admin, /清楚標「贊助內容」/);
  assert.match(admin, /不是第三方廣告/);
  const notices = admin.slice(admin.indexOf('data-admin-page="comms/notices"'), admin.indexOf('data-admin-page="comms/news"'));
  assert.match(notices, /id="broadcastsForm"/);
  assert.match(notices, /id="announceForm"/);
  assert.match(notices, /歷史 hop 公告僅供檢視/);
  const ads = admin.slice(admin.indexOf('data-admin-page="revenue/ads"'), admin.indexOf('data-admin-page="revenue/campaigns"'));
  assert.match(ads, /id="adsForm"/);
  assert.match(ads, /歷史版位僅供檢視/);
  const campaigns = admin.slice(admin.indexOf('data-admin-page="revenue/campaigns"'), admin.indexOf('data-admin-page="comms/smtp"'));
  assert.match(campaigns, /id="campaignForm"/);
  assertScriptsParse(admin);
  assertScriptsParse(html);
});

test("service worker cache bumped to v7 with prefix cleanup intact", () => {
  assert.match(sw, /const CACHE_VERSION = "v7";/);
  assert.match(sw, /startsWith\(CACHE_PREFIX\)/);
  assert.match(sw, /self\.skipWaiting\(\)/);
  assert.match(sw, /self\.clients\.claim\(\)/);
});

test("支持本站 entry and sponsor ways come from comms instead of a dead-ended support page", () => {
  // 後台「贊助連結」是公開資訊：訪客也要拿得到，否則「支持本站」點進去只有說明沒有出口。
  assert.match(comms, /sponsor_links: Array\.isArray\(sponsorLinks\)/);
  assert.match(comms, /supportPresentation\(cfg, sponsorOffer, \{ \.\.\.\(user \|\| \{\}\), sponsorLinks \}\)/);
  assert.match(server, /const publicSponsorOffer = publicSponsorSettings\(\{\}\);/);
  assert.match(server, /sponsorLinks: publicSponsorOffer\.links/);
  // 前台把連結畫進帳號區，並由通訊設定的入口開關決定桌機 header 的「支持本站」。
  assert.match(html, /support\.sponsor_links/);
  assert.match(html, /links\.innerHTML = ways\.map\(sponsorChipHtml\)\.join\(""\)/);
  assert.match(html, /function paintSupportEntry\(\)/);
  assert.match(html, /support\.show_entry === true/);
  // Support domain 沒開時，入口仍然是連到 /support.html 的普通連結（那頁會列出後台「贊助連結」），
  // 不再用 JS 切換檢視＋捲動（使用者會覺得沒反應）。
  assert.match(html, /entry\.href = "\/support\.html"/);
  assert.match(html, /if \(footer\) footer\.href = "\/support\.html"/);
  assert.match(html, /<a href="\/support\.html" id="supportFooterLink">/);
  assert.match(html, /dataset\.supportDomain/);
});
