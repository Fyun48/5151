import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";

const html = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/admin.html"),
  "utf8",
);
const ia = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/admin-ia.js"),
  "utf8",
);

test("admin settings use named IA groups instead of mixed tabs", () => {
  assert.match(html, /aria-label="後台分類"/);
  assert.match(html, /admin-ia\.js/);
  assert.match(html, /搜尋後台功能/);
  assert.match(html, /data-admin-page="overview"/);
  assert.match(html, /data-admin-page="inventory\/sources"/);
  assert.match(html, /data-admin-page="inventory\/same-house"/);
  assert.match(html, /data-admin-page="members\/users"/);
  assert.match(html, /data-admin-page="content\/legal"/);
  assert.match(html, /data-admin-page="system\/maps"/);
  assert.match(html, /data-admin-page="feedback\/inbox"/);
  assert.match(html, /function showAdminPanel/);
  assert.match(html, /admin-shell\.is-ready \.admin-panel \{ display: none; \}/);
  assert.match(html, /\.admin-dirty\[hidden\]/);
  assert.match(html, /min-width: 260px/);
  assert.doesNotMatch(html, /flex-direction:\s*row;\s*overflow-x:\s*auto/);
  assert.doesNotMatch(html, /畫面說明/);
  assert.doesNotMatch(html, /系統信件/);
  assert.match(ia, /房源與資料/);
  assert.match(ia, /會員與權限/);
  assert.match(ia, /站台內容/);
  assert.match(ia, /通知與溝通/);
  assert.match(ia, /收益與曝光/);
  assert.match(ia, /系統與整合/);
  assert.match(ia, /意見與治理/);
});

test("existing admin forms stay available under the new IA", () => {
  const sources = html.slice(html.indexOf('data-admin-page="inventory/sources"'), html.indexOf('data-admin-page="inventory/crawl"'));
  assert.match(sources, /id="crawlForm"/);
  assert.match(sources, /儲存物件來源/);
  assert.doesNotMatch(sources, /id="mapsForm"/);

  const crawl = html.slice(html.indexOf('data-admin-page="inventory/crawl"'), html.indexOf('data-admin-page="inventory/same-house"'));
  assert.match(crawl, /id="systemCrawlForm"/);
  assert.match(crawl, /儲存抓取範圍/);
  assert.doesNotMatch(crawl, /id="systemShowMrt"/);

  const maps = html.slice(html.indexOf('data-admin-page="system/maps"'), html.indexOf('data-admin-page="content/brand"'));
  assert.match(maps, /id="mapsForm"/);
  assert.match(maps, /id="googleEnabled"/);
  assert.match(maps, /id="systemShowMrt"/);
  assert.match(maps, /危險操作/);
  assert.match(maps, /停用並刪除 API Key/);

  const brand = html.slice(html.indexOf('data-admin-page="content/brand"'), html.indexOf('data-admin-page="content/legal"'));
  assert.match(brand, /id="brandForm"/);
  assert.doesNotMatch(brand, /id="listingImports"/);

  const legal = html.slice(html.indexOf('data-admin-page="content/legal"'), html.indexOf('data-admin-page="content/cms"'));
  assert.match(legal, /id="legalCopyForm"/);

  const cms = html.slice(html.indexOf('data-admin-page="content/cms"'), html.indexOf('data-admin-page="inventory/imports"'));
  assert.match(cms, /id="contentCms"/);
  assert.match(cms, /id="cmsReaccept"/);

  const imports = html.slice(html.indexOf('data-admin-page="inventory/imports"'), html.indexOf('data-admin-page="content/spirit"'));
  assert.match(imports, /id="listingImports"/);

  const qa = html.slice(html.indexOf('data-admin-page="content/qa"'), html.indexOf('data-admin-page="comms/notices"'));
  assert.match(qa, /id="helpQaRows"/);

  const smtp = html.slice(html.indexOf('data-admin-page="comms/smtp"'), html.indexOf('data-admin-page="system/oauth"'));
  assert.match(smtp, /id="smtpForm"/);
  assert.doesNotMatch(smtp, /id="oauthForm"/);

  const oauth = html.slice(html.indexOf('data-admin-page="system/oauth"'), html.indexOf('data-admin-page="comms/templates"'));
  assert.match(oauth, /id="oauthForm"/);

  const templates = html.slice(html.indexOf('data-admin-page="comms/templates"'), html.indexOf('data-admin-page="feedback/inbox"'));
  assert.match(templates, /verifiedWelcomeSubject/);

  const ads = html.slice(html.indexOf('data-admin-page="revenue/ads"'), html.indexOf('data-admin-page="revenue/campaigns"'));
  assert.match(ads, /id="adsForm"/);
  assert.match(ads, /已停用／相容功能/);
});

test("same-house admin UI and command search exist", () => {
  assert.match(html, /確認為同一房源/);
  assert.match(html, /此操作會影響全站所有使用者/);
  assert.match(html, /\/api\/admin\/same-house\/reconcile/);
  assert.match(html, /\/api\/admin\/same-house\/confirm/);
  assert.match(html, /\/api\/admin\/overview/);
  assert.match(ia, /樂屋/);
  assert.match(ia, /inventory\/same-house/);
  assert.match(ia, /members: "members\/users"/);
});

test("dirty navigation uses owner page and mapped save handlers", () => {
  assert.match(html, /IA\.decideNavigation/);
  assert.match(html, /fromHash:\s*true/);
  assert.match(html, /IA\.runStickySave/);
  assert.match(html, /IA\.noteControlChange/);
  assert.match(html, /IA\.finishPageLoad/);
  assert.match(html, /data-admin-transient/);
  assert.doesNotMatch(html, /addEventListener\("input", \(\) => IA\.setDirty\(true\)\)/);
  assert.match(ia, /decideNavigation/);
  assert.match(ia, /SAVE_PAGES/);
  assert.match(ia, /memberQuery: true/);
});
