import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const html = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/admin.html"),
  "utf8",
);

test("admin settings are grouped into clickable categories", () => {
  assert.match(html, /aria-label="後台分類"/);
  assert.match(html, /data-admin-nav="members"/);
  assert.match(html, /data-admin-nav="crawl"/);
  assert.match(html, /data-admin-nav="site"/);
  assert.match(html, /data-admin-nav="qa"/);
  assert.match(html, /data-admin-nav="notices"/);
  assert.match(html, /data-admin-nav="promo"/);
  assert.match(html, /data-admin-nav="ads"/);
  assert.match(html, /data-admin-nav="mail"/);
  assert.match(html, /抓取底庫/);
  assert.match(html, /畫面說明/);
  assert.match(html, /功能說明 Q&amp;A/);
  assert.match(html, /公告專區/);
  assert.match(html, /贊助曝光/);
  assert.match(html, /站內小廣告/);
  assert.match(html, /系統信件/);
  assert.match(html, /function showAdminPanel/);
  assert.match(html, /admin-shell\.is-ready \.admin-panel \{ display: none; \}/);

  const crawl = html.slice(html.indexOf('data-admin-panel="crawl"'), html.indexOf('data-admin-panel="site"'));
  assert.match(crawl, /物件來源/);
  assert.match(crawl, /系統抓取底庫/);
  assert.match(crawl, /通勤路線／Google 計費/);
  assert.ok(crawl.indexOf("物件來源") < crawl.indexOf("系統抓取底庫"));
  assert.ok(crawl.indexOf("系統抓取底庫") < crawl.indexOf("通勤路線"));

  const site = html.slice(html.indexOf('data-admin-panel="site"'), html.indexOf('data-admin-panel="qa"'));
  assert.match(site, /吉比形象／Logo/);
  assert.match(site, /宣告／免責／個資/);
  assert.match(site, /id="legalCopyForm"/);
  assert.doesNotMatch(site, /id="helpQaRows"/);
  assert.doesNotMatch(site, /id="broadcastsForm"/);

  const qa = html.slice(html.indexOf('data-admin-panel="qa"'), html.indexOf('data-admin-panel="notices"'));
  assert.match(qa, /功能說明 Q&amp;A/);
  assert.match(qa, /id="helpQaRows"/);
  assert.doesNotMatch(qa, /吉比形象／Logo/);

  const notices = html.slice(html.indexOf('data-admin-panel="notices"'), html.indexOf('data-admin-panel="promo"'));
  assert.match(notices, /公告／最新消息／贊助提醒/);
  assert.match(notices, /id="broadcastsForm"/);
  assert.doesNotMatch(notices, /吉比形象／Logo/);

  const promo = html.slice(html.indexOf('data-admin-panel="promo"'), html.indexOf('data-admin-panel="ads"'));
  assert.match(promo, /贊助連結/);
  assert.doesNotMatch(promo, /id="adsForm"/);

  const ads = html.slice(html.indexOf('data-admin-panel="ads"'), html.indexOf('data-admin-panel="mail"'));
  assert.match(ads, /站內小廣告/);
  assert.match(ads, /id="adsForm"/);
  assert.doesNotMatch(ads, /id="sponsorForm"/);

  const mail = html.slice(html.indexOf('data-admin-panel="mail"'));
  assert.match(mail, /寄信 SMTP/);
  assert.match(mail, /社群登入/);
  assert.match(mail, /id="oauthForm"/);
  assert.match(mail, /verifiedWelcomeSubject/);
  assert.match(mail, /信件內容/);
});
