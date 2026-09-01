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
  assert.match(html, /data-kind="building"/);
  assert.match(html, /kind=\$\{encodeURIComponent\(kind\)\}/);
  assert.match(html, /document\.querySelectorAll\("\[data-kind\]"\)/);
  assert.doesNotMatch(html, /data-filter="elevator"/);
  assert.doesNotMatch(html, /data-filter="apartment"/);
  assert.doesNotMatch(html, /data-filter="suite"/);
});
