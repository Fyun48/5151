import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import { crawlSourceEnabled, defaultCrawlSources, normalizeCrawlSources } from "../src/crawlSources.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("591 crawl source is on, self listings are on, extra portals are off until enabled", () => {
  const items = defaultCrawlSources();
  assert.equal(crawlSourceEnabled(items, "591"), true);
  assert.equal(crawlSourceEnabled(items, "hbhousing"), false);
  assert.equal(items.find((row) => row.id === "hbhousing")?.stub, false);
  assert.equal(items.find((row) => row.id === "sinyi")?.stub, false);
  assert.equal(items.find((row) => row.id === "houseprice")?.stub, false);
  assert.equal(items.find((row) => row.id === "ddroom")?.stub, false);
  assert.equal(items.find((row) => row.id === "rakuya")?.stub, false);
  assert.equal(items.find((row) => row.id === "housefun")?.stub, false);
  assert.equal(crawlSourceEnabled(items, "rakuya"), false);
  assert.equal(crawlSourceEnabled(items, "self"), true);
  assert.equal(items.find((row) => row.id === "self")?.stub, false);
  const next = normalizeCrawlSources({ rakuya: true, hbhousing: true, sinyi: true, "591": false });
  assert.equal(crawlSourceEnabled(next, "591"), false);
  assert.equal(crawlSourceEnabled(next, "hbhousing"), true);
  assert.equal(crawlSourceEnabled(next, "sinyi"), true);
  assert.equal(crawlSourceEnabled(next, "rakuya"), true);
  assert.equal(crawlSourceEnabled(next, "self"), true);
  assert.ok(!next.find((row) => row.id === "self")?.stub);
});

test("incomplete crawl-source payload does not enable rakuya by default", () => {
  const partial = normalizeCrawlSources({ "591": true });
  assert.equal(crawlSourceEnabled(partial, "591"), true);
  assert.equal(crawlSourceEnabled(partial, "rakuya"), false);
  const missing = normalizeCrawlSources([{ id: "591", enabled: true }]);
  assert.equal(crawlSourceEnabled(missing, "rakuya"), false);
});

test("saveCrawlSources keeps omitted source switches, including Owner rakuya setting", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-crawl-src-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    const enabled = (id) => app.getCrawlSources().items.find((row) => row.id === id)?.enabled;
    assert.equal(enabled("rakuya"), false);
    app.saveCrawlSources({ "591": true });
    assert.equal(enabled("rakuya"), false);
    app.saveCrawlSources({ items: [{ id: "rakuya", enabled: true }] });
    assert.equal(enabled("rakuya"), true);
    app.saveCrawlSources({ items: [{ id: "591", enabled: true }] });
    assert.equal(enabled("rakuya"), true, "omitted rakuya must not be rewritten");
    app.saveCrawlSources({ items: [{ id: "rakuya", enabled: false }] });
    assert.equal(enabled("rakuya"), false);
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
