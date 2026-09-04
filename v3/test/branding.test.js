import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, APP_VERSION } from "../src/brand.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("branding stays 吉比租房物件追蹤 with inconspicuous ver. 3.36", () => {
  assert.equal(APP_NAME, "吉比租房物件追蹤");
  assert.equal(APP_VERSION, "3.36");
  for (const rel of ["../public/index.html", "../public/login.html", "../public/admin.html"]) {
    const html = readFileSync(path.join(dir, rel), "utf8");
    assert.match(html, /吉比租房物件追蹤/);
    assert.match(html, /ver\. 3\.36/);
    assert.equal(html.includes("開發版"), false);
    assert.doesNotMatch(html, /<h1>[^<]*v3/i);
    assert.doesNotMatch(html, /<title>[^<]*v3/i);
  }
});

test("PWA files and bottom nav exist", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const manifest = readFileSync(path.join(dir, "../public/manifest.webmanifest"), "utf8");
  const sw = readFileSync(path.join(dir, "../public/sw.js"), "utf8");
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /data-nav="listings"/);
  assert.match(html, /data-nav="post"/);
  assert.match(html, /data-nav="demand"/);
  assert.match(html, /data-nav="me"/);
  assert.match(html, /data-nav="notify"/);
  assert.match(html, /spirit\.html/);
  assert.match(html, />設定</);
  assert.match(html, /id="demandView"/);
  assert.match(html, /id="selfListingForm"/);
  assert.match(html, /id="openFilterSheetBtn"/);
  assert.match(html, /data-notify-ch="push"/);
  assert.match(html, /bottom-nav/);
  assert.match(manifest, /吉比租房物件追蹤/);
  assert.match(sw, /showNotification/);
});
