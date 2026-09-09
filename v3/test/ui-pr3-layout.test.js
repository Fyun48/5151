import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");

test("desktop expanded filters stay in flow; only compact summary is sticky", () => {
  assert.match(html, /body\.panel-collapsed \.list-head-sticky \{\s*\n\s*position: static;/);
  assert.match(html, /body\.panel-collapsed \.list-head-sticky\.filter-compact \{\s*\n\s*position: sticky;/);
  assert.match(html, /body\.panel-collapsed \.filter-mini-btn \{[\s\S]*?bottom: 28px;/);
  assert.match(html, /#scrollTopBtn \{[\s\S]*bottom:\s*80px/);
});

test("scroll-top stays available on other desktop views once scrolled", () => {
  assert.match(html, /body:not\(\[data-app-view="listings"\]\) #scrollTopBtn:not\(\.on\)/);
  assert.doesNotMatch(html, /body:not\(\[data-app-view="listings"\]\) #scrollTopBtn \{\s*\n\s*visibility: hidden;/);
});

test("listing cards keep a photo frame and hide mobile pick boxes", () => {
  assert.match(html, /class="cover-ph"/);
  assert.match(html, />暫無</);
  assert.match(html, /item-cover\.empty,\s*\n\s*\.item-cover\[hidden\] \{ display: flex; \}/);
  assert.match(html, /\.item \.pick-hit \{ display: none !important; \}/);
  assert.match(html, /class="item-main"/);
  assert.match(html, /class="item-details"/);
  assert.match(html, /btn-card-action btn-watch/);
  assert.match(html, /btn-card-action btn-report-gone/);
});

test("same-house fold renders collapsed sources without dropping them", () => {
  assert.match(html, /same-house-fold/);
  assert.match(html, /house\.collapsed/);
  assert.match(html, /另有 \$\{house\.hidden_count/);
});

test("mobile help dock stays left of bottom nav; desktop dock sits left of filter X", () => {
  assert.match(html, /function bindHelpDockMotion/);
  assert.match(html, /is-scroll-hidden/);
  assert.match(html, /setTimeout\(showDock, reduced\(\) \? 0 : 1000\)/);
  assert.doesNotMatch(html, /bindSearchBarScrollHide/);
  assert.doesNotMatch(html, /search-bar-hidden/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /is-compact/);
  assert.match(html, /aria-label="常見問題 Q&amp;A"/);
  assert.match(html, /\.mobile-help-dock \{[\s\S]*?flex-direction: row;[\s\S]*?gap: 4px;[\s\S]*?bottom: 28px;/);
  assert.match(html, /right: calc\(18px \+ var\(--touch\) \+ 4px\)/);
  assert.match(html, /\.filter-head-actions > button\.mobile-only \{\s*display: none;/);
});

test("media tags and watermarked listing compose controls exist", () => {
  assert.match(html, /id="mediaTagPicks"/);
  assert.match(html, /id="mediaTagAdd"/);
  assert.match(html, /data-media-tag-pick/);
  assert.match(html, /data-media-tag-assign/);
  assert.match(html, /\/api\/media\/tags/);
  assert.match(html, /applyPickedTagPhotos/);
});
