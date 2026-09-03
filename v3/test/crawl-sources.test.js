import { test } from "node:test";
import assert from "node:assert/strict";
import { crawlSourceEnabled, defaultCrawlSources, normalizeCrawlSources } from "../src/crawlSources.js";

test("591 crawl source is on, self listings are on, other stubs stay off", () => {
  const items = defaultCrawlSources();
  assert.equal(crawlSourceEnabled(items, "591"), true);
  assert.equal(crawlSourceEnabled(items, "rakuya"), false);
  assert.equal(crawlSourceEnabled(items, "self"), true);
  assert.equal(items.find((row) => row.id === "self")?.stub, false);
  const next = normalizeCrawlSources({ rakuya: true, "591": false });
  assert.equal(crawlSourceEnabled(next, "591"), false);
  assert.equal(crawlSourceEnabled(next, "rakuya"), true);
  assert.equal(crawlSourceEnabled(next, "self"), true);
  assert.ok(!next.find((row) => row.id === "self")?.stub);
});
