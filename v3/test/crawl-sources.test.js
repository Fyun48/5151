import { test } from "node:test";
import assert from "node:assert/strict";
import { crawlSourceEnabled, defaultCrawlSources, normalizeCrawlSources } from "../src/crawlSources.js";

test("591 crawl source is on and stubs stay off until enabled", () => {
  const items = defaultCrawlSources();
  assert.equal(crawlSourceEnabled(items, "591"), true);
  assert.equal(crawlSourceEnabled(items, "rakuya"), false);
  assert.equal(crawlSourceEnabled(items, "self"), false);
  const next = normalizeCrawlSources({ rakuya: true, "591": false });
  assert.equal(crawlSourceEnabled(next, "591"), false);
  assert.equal(crawlSourceEnabled(next, "rakuya"), true);
  assert.ok(next.find((row) => row.id === "self")?.stub);
});
