import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
const admin = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
const auth = readFileSync(path.join(dir, "../src/auth.js"), "utf8");

test("owner matching UI stays inside 有房刊登 and has no sixth nav", () => {
  assert.match(html, /id="ownerMatchOverlay"/);
  assert.match(html, /id="aggregateDemandPanel"/);
  assert.match(html, /id="demandExposure"/);
  assert.match(html, /data-self-matches/);
  assert.match(html, /提供房源（即將推出）/);
  assert.match(html, /id="wishOfferInbox"/);
  assert.match(html, /id="wishOfferOverlay"/);
  assert.match(html, /提供我的房源|wishOfferInbox|data-create-offer/);
  assert.match(html, /配對暫時無法取得/);
  assert.match(html, /matchUnavailable/);
  assert.match(html, /min-height: var\(--touch\)/);
  const nav = html.slice(html.indexOf('id="bottomNav"'), html.indexOf("</nav>", html.indexOf('id="bottomNav"')));
  assert.equal((nav.match(/data-nav="/g) || []).length, 5);
  assert.doesNotMatch(nav, /配對/);
});

test("APIs are wired with ownership and flag gates", () => {
  assert.match(server, /\/api\/self-listings\/:id\/matches\/summary/);
  assert.match(server, /\/api\/self-listings\/:id\/matches/);
  assert.match(server, /\/api\/demand\/aggregate/);
  assert.match(server, /\/api\/demand\/exposure/);
  assert.match(server, /\/api\/admin\/rental-match-rules/);
  assert.match(server, /ownerListingMatchSummary/);
  assert.match(server, /\/api\/self-listings\/:id\/matches\/:wishRef\/offers/);
  assert.match(server, /\/api\/wish-offers\/inbox/);
  assert.match(server, /\/api\/wish-offers\/:offerRef\/accept/);
  assert.match(server, /createWishOfferFor/);
});

test("admin rules page is read-only default rules", () => {
  assert.match(admin, /id="rentalMatchRules"/);
  assert.match(admin, /規則編輯器即將推出/);
  assert.match(admin, /disabled/);
});

test("demand aggregate remains a public path but owner matches do not", () => {
  assert.match(auth, /p.startsWith\("\/api\/demand\/"\)/);
  assert.doesNotMatch(auth, /\/api\/self-listings\/:id\/matches/);
});
