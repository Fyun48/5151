import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(dir, "..", p), "utf8");
const html = read("public/index.html");
const support = read("public/support.html");
const supportPage = read("public/support-page.js");
const cta = read("public/support-cta.js");
const admin = read("public/admin.html");
const adminJs = read("public/admin-support.js");
const ia = read("public/admin-ia.js");

function assertScriptsParse(source) {
  const blocks = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    if (/\bsrc\s*=/i.test(block[1])) continue;
    assert.doesNotThrow(() => new Function(block[2]));
  }
}

test("support page uses CMS copy, abstract checkout, and free-site language", () => {
  assert.match(support, /讓吉比租房追蹤持續免費/);
  assert.match(support, /吉比租房物件追蹤免費提供/);
  assert.doesNotMatch(support, /讓 5151 持續免費/);
  assert.match(support, /不支持也不會減少任何功能/);
  assert.match(support, /rel="canonical"/);
  assert.match(support, /og:title/);
  assert.doesNotMatch(support, /buymeacoffee\.com/);
  assert.doesNotMatch(support, /急需資金|救救本站|Donate|捐款給我們/);
  assert.match(supportPage, /讓吉比租房追蹤持續免費/);
  assert.match(supportPage, /感謝支持吉比租房追蹤/);
  assert.doesNotMatch(supportPage, /5151/);
  assert.match(supportPage, /\/api\/support\/checkout/);
  assert.match(supportPage, /checkoutType|available/);
  assert.match(supportPage, /visualPercent/);
  assert.doesNotMatch(supportPage, /buymeacoffee\.com/);
  assertScriptsParse(support);
});

test("site entries and CTA stay out of the way of search chrome", () => {
  assert.match(html, /id="supportHeaderLink"/);
  assert.match(html, /id="supportFooterLink"/);
  assert.match(html, /id="supportCtaCard"/);
  assert.match(html, /id="supportMeLink"/);
  assert.match(html, /support-cta-card/);
  assert.match(html, /\.support-cta-card \{ bottom: calc\(64px \+ env\(safe-area-inset-bottom/);
  assert.match(html, /z-index: 90/);
  assert.match(html, /src="\/support-cta.js"/);
  assert.match(cta, /dismissedUntil/);
  assert.match(cta, /data-support-dismiss/);
  assert.match(cta, /Escape/);
  assert.match(cta, /if \(data\?\.state\) writeJson\(STORAGE_KEY, \{ \.\.\.clientState, \.\.\.data\.state \}\)/);
  assert.doesNotMatch(cta, /kind:\s*"support_cta_shown"/);
  assert.doesNotMatch(cta, /shownCount = \(Number\(state\.shownCount\)/);
  assert.doesNotMatch(cta, /buymeacoffee\.com/);
  assertScriptsParse(html);
});

test("support page still lists the configured sponsor ways while the domain stays closed", () => {
  assert.match(support, /id="directWays"/);
  assert.match(support, /id="directWaysList"/);
  assert.match(supportPage, /function renderDirectWays\(/);
  assert.match(supportPage, /sponsor_links/);
  assert.match(supportPage, /heroCta\.href = "#directWays"/);
  // 前端仍不得寫死第三方收款網址，一律用 API 回來的連結。
  assert.doesNotMatch(support, /buymeacoffee\.com/);
  assert.doesNotMatch(supportPage, /buymeacoffee\.com/);
  assertScriptsParse(support);
  assertScriptsParse(html);
});

test("admin support page covers dashboard, preview, and legacy comms form", () => {
  assert.match(admin, /id="supportAdminRoot"/);
  assert.match(admin, /id="supportConfigForm"/);
  assert.match(admin, /data-support-tab="dash"/);
  assert.match(admin, /預覽桌面/);
  assert.match(admin, /預覽手機/);
  assert.match(admin, /id="supportPreviewFrame"/);
  assert.match(admin, /support.enabled/);
  assert.match(adminJs, /\/api\/admin\/support\/dashboard/);
  assert.match(adminJs, /\/support.html\?preview=1/);
  assert.match(ia, /支持總覽/);
  assertScriptsParse(admin);
});
