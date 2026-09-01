import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("index.html inline script parses", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({
    attrs: m[1],
    source: m[2],
  }));
  const inline = blocks.filter((block) => !/\bsrc\s*=/i.test(block.attrs));
  assert.ok(inline.length >= 2, "watchdog and main script should be separate tags");
  for (const block of inline) {
    const trimmed = block.source.trim();
    if (!trimmed) continue;
    assert.doesNotThrow(() => new Function(block.source));
  }
});

test("boot watchdog still runs if the main page script never parses", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /id="bootFail"/);
  assert.match(html, /window\.__showBootFail/);
  assert.match(html, /window\.__APP_PARSED = true/);
  assert.match(html, /window\.__APP_BOOTED = true/);
  assert.match(html, /不要按清除資料/);
  const watchdogIdx = html.indexOf("window.__showBootFail");
  const parsedIdx = html.indexOf("window.__APP_PARSED = true");
  const bootedIdx = html.lastIndexOf("window.__APP_BOOTED = true");
  assert.ok(watchdogIdx > 0 && parsedIdx > watchdogIdx, "watchdog script must come before main script");
  assert.ok(bootedIdx > parsedIdx, "boot flag must be set after main script body");
});

test("watch fly animation is non-blocking and targets the watched chip", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /id="watchFlyLayer"/);
  assert.match(html, /pointer-events:\s*none/);
  assert.match(html, /function flyCardToChip/);
  assert.match(html, /function flyCardToWatchChip/);
  assert.match(html, /function flyCardToAllChip/);
  assert.match(html, /data-filter="watched"/);
  assert.match(html, /data-filter="all"/);
  assert.match(html, /flyCardToChip\(card, "watched"\)/);
  assert.match(html, /flyCardToChip\(card, "all"\)/);
  assert.match(html, /1\.15s/);
  assert.match(html, /noteDrafts/);
});

test("watch draft note ignores IME composition and list redraw", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /compositionstart/);
  assert.match(html, /compositionend/);
  assert.match(html, /noteComposing/);
  assert.match(html, /noteJustComposed/);
  assert.match(html, /listLoadGen/);
  assert.match(html, /replaceListHtml/);
  assert.match(html, /data-watch-draft-commit/);
  assert.match(html, /選字不會送出/);
  assert.match(html, /if \(gen !== listLoadGen\) return/);
  assert.match(html, /if \(!draftWatch\.has\(key\)\) return/);
  assert.match(html, /if \(noteComposing\) return true/);
  assert.doesNotMatch(html, /點欄位外即加入/);
  const keydown = html.slice(
    html.indexOf('$("list").addEventListener("keydown"'),
    html.indexOf('$("list").addEventListener("focusout"'),
  );
  assert.match(keydown, /commitWatchDraft\(id, ev\.target\.value\)/);
  assert.match(keydown, /noteJustComposed/);
  assert.doesNotMatch(keydown, /\.blur\(\)/);
  const focusout = html.slice(
    html.indexOf('$("list").addEventListener("focusout"'),
    html.indexOf('$("list").addEventListener("change"'),
  );
  assert.match(focusout, /listRendering \|\| skipDraftBlur \|\| noteComposing/);
  assert.match(focusout, /if \(!goingTo\) return/);
  assert.match(focusout, /watchDraftCommit/);
});

test("unwatch flies to the all chip before reloading", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  const unwatch = html.slice(html.indexOf("if (watched)"), html.indexOf("if (!viewed)"));
  assert.match(unwatch, /flyCardToAllChip\(card\)/);
  assert.match(unwatch, /watched: false/);
  assert.match(unwatch, /visibility = "hidden"/);
});

test("housing kind chips stay independent of 特別關注", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /data-kind="elevator"/);
  assert.match(html, /data-kind="apartment"/);
  assert.match(html, /data-kind="suite"/);
  assert.doesNotMatch(html, /data-kind="building"/);
  assert.match(html, /kind=\$\{encodeURIComponent\(kind\)\}/);
  assert.match(html, /document\.querySelectorAll\("\[data-kind\]"\)/);
  assert.doesNotMatch(html, /data-filter="elevator"/);
  assert.doesNotMatch(html, /data-filter="apartment"/);
  assert.doesNotMatch(html, /data-filter="suite"/);
});

test("page defaults to 全部 + 最新", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /class="chip on" data-filter="all"/);
  assert.match(html, /class="chip on" data-sort="newest"/);
  assert.match(html, /let sort = "newest"/);
  assert.doesNotMatch(html, /class="chip on" data-sort="price_asc"/);
});

test("non-admin members do not see the shared reset link after boot", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /id="resetLink"/);
  assert.match(html, /role !== "admin"/);
});

test("member profiles cap districts and include usable ping in notify copy", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /MEMBER_MAX_DISTRICTS = 10/);
  assert.match(html, /MEMBER_MAX_PROFILES = 3/);
  assert.match(html, /每個設定檔最多選/);
  assert.match(html, /notify_facts/);
  assert.match(html, /housing_type/);
  assert.match(html, /已存 \$\{list\.length\}／\$\{cap\}/);
  assert.match(html, /setSettingsReady\(settingsLoaded\)/);
  const profilesFn = html.slice(html.indexOf("function renderProfiles"), html.indexOf("function fillNotifyMatrix"));
  assert.equal(profilesFn.includes("if (label)"), false);
});

test("member settings copy hides advanced hints and locks schedule defaults", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /此通知只會訊息已是特別關注之物件/);
  assert.match(html, /郵件通知會寄到你註冊的 Email/);
  assert.match(html, /data-notify-ch="mail"/);
  assert.match(html, /dock: true, webhook: true, mail: true/);
  assert.match(html, /本系統每8分鐘會重新檢本物件來源比對篩選/);
  assert.match(html, /id="adminLink"/);
  assert.match(html, /後台管理/);
  assert.match(html, /id="sponsorBar"/);
  assert.match(html, /paintSponsorOffer/);
  assert.match(html, /classList\.toggle\("role-admin", meIsAdmin\)/);
  assert.match(html, /meIsAdmin \? Number\(\$\("intervalMinutes"\)\.value\) : undefined/);
  assert.match(html, /meIsAdmin \? \(Number\(\$\("offlineConfirmDays"\)\.value\) \|\| 7\) : 7/);
  assert.match(html, /meIsAdmin \? Number\(\$\("pagesPerWatch"\)\.value\) : 40/);
  assert.match(html, /body:not\(\.role-admin\) \.admin-only/);
  assert.match(html, /class="hint member-only"/);
  assert.doesNotMatch(html, /站內是右下角「待看更新」/);
  assert.doesNotMatch(html, /路徑用 591 物件頁「點地址」/);
  assert.doesNotMatch(html, /每次最多抓取頁數（每頁約 30 筆/);
  assert.doesNotMatch(html, /排程會依這個間隔抓 591 搜尋/);
  assert.doesNotMatch(html, /591 回「不存在／已關閉」後先標/);
  assert.doesNotMatch(html, /搜尋行政區（台北市 region=1/);
  assert.doesNotMatch(html, /以下數量只算 591 搜尋條件/);
  assert.doesNotMatch(html, /stat-note/);
});
