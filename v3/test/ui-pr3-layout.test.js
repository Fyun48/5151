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
  // Owner 2026-10-07：會員與贊助會員不再顯示「物件連結失效」回報鈕（訪客本來就看不到）。
  // CSS 殘留的 .btn-report-gone 樣式規則不算，這裡綁的是「卡片上不會再生出那個按鈕」。
  assert.doesNotMatch(html, /btn-card-action btn-report-gone/);
  assert.match(html, /function sameHouseGoneBtn\(peer\) \{\s*\n\s*return "";/);
});

test("filter chips follow the 2026-10-07 rules (viewed chip, member-hidden same-source chips)", () => {
  assert.match(html, /data-filter="viewed">已瀏覽</);
  assert.doesNotMatch(html, /data-filter="unseen">未瀏覽</);
  // 同屋源／疑似同屋源：訪客限定，會員與贊助會員由 CSS 藏起來。
  assert.match(html, /class="chip guest-filter" data-filter="same_source">同屋源更新</);
  assert.match(html, /class="chip guest-filter" data-filter="suspected">疑似同屋源</);
  assert.match(html, /body:not\(\.role-guest\) \.guest-filter \{ display: none !important; \}/);
  // 「已瀏覽」要有帳號才有資料，訪客不給一顆永遠按出空清單的鈕。
  assert.match(html, /class="chip needs-account" data-filter="viewed"/);
  assert.match(html, /body\.role-guest \.needs-account \{ display: none !important; \}/);
  // 特別關注／已隱藏的一鍵清除（只在切到該篩選時出現）。
  assert.match(html, /id="clearWatchedBtn"/);
  assert.match(html, /id="clearHiddenBtn"/);
  assert.match(html, /\/api\/me\/listings\/clear-flags/);
});

test("list page size is 10 on mobile and 25 on desktop", () => {
  assert.match(html, /const LIST_PAGE_SIZE = 25;/);
  assert.match(html, /const MOBILE_LIST_PAGE_SIZE = 10;/);
  assert.match(html, /function listPageSize\(\) \{[\s\S]*?max-width: 767px[\s\S]*?MOBILE_LIST_PAGE_SIZE : LIST_PAGE_SIZE/);
  // 一頁筆數改由 listPageSize() 決定，不能再有寫死的舊常數被拿去用。
  assert.doesNotMatch(html, /GUEST_LIST_PAGE_SIZE/);
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
