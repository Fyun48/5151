import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CRAWL_PAGES_591, CRAWL_PAGES_EXTERNAL, SYSTEM_CRAWL_INTERVAL_MINUTES } from "../src/crawlPolicy.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("shared crawl uses fixed page depth and a 15-minute default interval", () => {
  assert.equal(SYSTEM_CRAWL_INTERVAL_MINUTES, 15);
  assert.equal(CRAWL_PAGES_591, 12);
  assert.equal(CRAWL_PAGES_EXTERNAL, 6);
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(watcher, /CRAWL_PAGES_591/);
  assert.doesNotMatch(watcher, /settings\.pagesPerWatch/);
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /\/api\/admin\/system-crawl/);
  const admin = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  assert.match(admin, /id="systemCrawlForm"/);
  assert.match(admin, /id="systemOfflineConfirmDays"/);
  assert.match(admin, /確認已下架天數/);
  assert.match(admin, /系統抓取底庫/);
  assert.match(admin, /id="systemShowMrt"/);
  assert.match(admin, /id="systemShowListRefreshBar"/);
  assert.match(admin, /顯示列表更新細線/);
  assert.match(admin, /全站顯示步行未滿 1\.5 公里的最近捷運站/);
  assert.match(admin, /會員畫面沒有這些選項/);
  assert.match(watcher, /getSystemCrawl\(\)\.offlineConfirmDays/);
  assert.match(admin, /id="systemCrawlSelectAll"/);
  assert.match(admin, /id="systemCrawlSelectNone"/);
  assert.match(admin, /id="systemCatalogStats"/);
  assert.match(admin, /本島底庫總計/);
  assert.match(server, /refreshSiteCatalogStats/);
  assert.match(admin, /data-city-toggle/);
  assert.match(admin, /data-city-all/);
  assert.match(admin, /data-city-none/);
  assert.match(admin, /district-city:not\(\.is-open\) \.districts \{ display: none; \}/);
  assert.match(admin, />取消<\/button>/);
  assert.doesNotMatch(admin, /flex:1 1 280px/);
  const dbSrc = readFileSync(path.join(dir, "../src/db.js"), "utf8");
  const mrtFn = dbSrc.slice(dbSrc.indexOf("function mrtFields"), dbSrc.indexOf("export function setCachedRoute"));
  assert.match(mrtFn, /provider\.systemCrawl\(\) : getSystemCrawl\(\)/);
  assert.match(mrtFn, /system\.showMrt !== false/);
  assert.doesNotMatch(mrtFn, /settings\?\.showMrt/);
  assert.doesNotMatch(mrtFn, /settings\?\.systemShowMrt/);
});

test("system crawl stores offline confirm days for the watcher and getSettings overlay", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-offline-days-"));
  const script = `
    import { getSettings, getSystemCrawl, saveSettings, saveSystemCrawl } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    const first = getSystemCrawl();
    if (first.offlineConfirmDays !== 7) throw new Error("default " + first.offlineConfirmDays);
    const saved = saveSystemCrawl({ offlineConfirmDays: 3 });
    if (saved.offlineConfirmDays !== 3) throw new Error("saved " + saved.offlineConfirmDays);
    const mapsPartial = saveSystemCrawl({ showMrt: true });
    if (mapsPartial.offlineConfirmDays !== 3) throw new Error("partial reset " + mapsPartial.offlineConfirmDays);
    const clamped = saveSystemCrawl({ offlineConfirmDays: 99 });
    if (clamped.offlineConfirmDays !== 30) throw new Error("clamp " + clamped.offlineConfirmDays);
    saveSettings({ offlineConfirmDays: 2 }, 1);
    const settings = getSettings();
    if (settings.offlineConfirmDays !== 30) throw new Error("overlay " + settings.offlineConfirmDays);
    console.log(JSON.stringify({ ok: true, days: getSystemCrawl().offlineConfirmDays }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
    assert.deepEqual(JSON.parse(line), { ok: true, days: 30 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
