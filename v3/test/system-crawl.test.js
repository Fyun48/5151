import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  assert.match(admin, /系統抓取底庫/);
  assert.match(admin, /id="systemShowMrt"/);
  assert.match(admin, /顯示步行 1\.5 公里內捷運站/);
});
