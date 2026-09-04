import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_NAME, APP_NAME_EN, APP_VERSION } from "../src/brand.js";
import {
  defaultBrandMascot,
  isSafeBrandUrl,
  kindFromUrl,
  normalizeBrandMascot,
} from "../src/brandMascot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(dir, "../public");

test("bundled mark exists without Pawprints filename and English name is JibbyRentH", () => {
  assert.equal(APP_NAME, "吉比租房物件追蹤");
  assert.equal(APP_NAME_EN, "JibbyRentH");
  assert.equal(APP_VERSION, "3.37");
  assert.equal(existsSync(path.join(publicDir, "brand/mark.png")), true);
  assert.equal(existsSync(path.join(publicDir, "brand/confused.webm")), true);
  assert.equal(existsSync(path.join(publicDir, "brand/walk.webp")), true);
  assert.equal(existsSync(path.join(publicDir, "icons/icon-192.png")), true);
  const html = readFileSync(path.join(publicDir, "index.html"), "utf8");
  const login = readFileSync(path.join(publicDir, "login.html"), "utf8");
  const admin = readFileSync(path.join(publicDir, "admin.html"), "utf8");
  const mascot = readFileSync(path.join(publicDir, "mascot.js"), "utf8");
  for (const text of [html, login, admin, mascot]) {
    assert.match(text, /JibbyRentH/);
    assert.equal(text.toLowerCase().includes("pawprints"), false);
  }
  assert.match(html, /class="brand-lockup"/);
  assert.match(html, /src="\/mascot\.js"/);
  assert.match(admin, /id="brandForm"/);
  assert.match(admin, /吉比形象/);
  assert.match(mascot, /noteConfused/);
});

test("brand URLs stay on this site and Pawprints cannot be the English name", () => {
  assert.equal(isSafeBrandUrl("/brand/mark.png"), true);
  assert.equal(isSafeBrandUrl("/media/brand/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"), true);
  assert.equal(isSafeBrandUrl("https://evil.example/x.png"), false);
  assert.equal(kindFromUrl("/brand/confused.webm"), "video");
  assert.equal(kindFromUrl("/brand/duo.png"), "image");
  const next = normalizeBrandMascot({ englishName: "PAWPRINTS", markUrl: "https://x", clips: { confused: { url: "/etc/passwd" } } });
  assert.equal(next.englishName, "JibbyRentH");
  assert.equal(next.markUrl, defaultBrandMascot().markUrl);
  assert.equal(next.clips.confused.url, defaultBrandMascot().clips.confused.url);
  assert.match(next.clips.confused.url, /confused\.webm/);
  assert.match(defaultBrandMascot().clips.welcome.url, /walk\.webp/);
  const tokens = readFileSync(path.join(publicDir, "tokens.css"), "utf8");
  assert.match(tokens, /width: 75vw/);
  assert.match(tokens, /height: 75vh/);
  assert.match(tokens, /\.jibby-mascot-media img,[\s\S]*background: transparent/);
  assert.doesNotMatch(tokens, /background: #111/);
  const admin = readFileSync(path.join(publicDir, "admin.html"), "utf8");
  assert.match(admin, /透明底/);
  assert.match(admin, /75% 畫面/);
  assert.doesNotMatch(admin, /background: var\(--ink\)/);
});
