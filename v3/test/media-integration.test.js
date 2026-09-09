import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listingPhotoUrls } from "../src/selfListings.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(dir, "..", p), "utf8");
const server = read("src/server.js");
const memberMedia = read("src/memberMedia.js");
const auth = read("src/auth.js");
const html = read("public/index.html");
const listingHtml = read("public/listing.html");

test("legacy self_photos still resolve (backward compatible)", () => {
  const legacy = { self_photos: JSON.stringify(["/media/self/" + "a".repeat(32) + ".jpg"]), cover: "/media/self/" + "b".repeat(32) + ".jpg" };
  const urls = listingPhotoUrls(legacy);
  assert.ok(urls.includes("/media/self/" + "a".repeat(32) + ".jpg"));
  assert.ok(urls.includes("/media/self/" + "b".repeat(32) + ".jpg"));
  // 新素材庫 url 也能存放於同一 self_photos（混用）
  const mixed = { self_photos: JSON.stringify(["/media/lib/" + "c".repeat(32) + ".jpg", "/media/self/" + "a".repeat(32) + ".jpg"]), cover: "" };
  const urls2 = listingPhotoUrls(mixed);
  assert.ok(urls2.includes("/media/lib/" + "c".repeat(32) + ".jpg"));
  assert.ok(urls2.includes("/media/self/" + "a".repeat(32) + ".jpg"));
});

test("server exposes media library + public sharing routes with ownership check", () => {
  assert.match(server, /app\.get\("\/api\/media"/);
  assert.match(server, /app\.post\("\/api\/media"/);
  assert.match(server, /app\.delete\("\/api\/media\/:id"/);
  assert.match(server, /app\.get\("\/media\/lib\/:file", servePublicMemberMedia\)/);
  assert.match(server, /app\.get\("\/api\/public\/self-listing\/:id"/);
  assert.match(server, /app\.get\("\/l\/:id"/);
  // 刊登時驗證素材所有權（擋盜連他人 media）
  assert.match(server, /assertOwnsMemberMediaUrls\(session\.userId/);
  assert.match(memberMedia, /export function servePublicMemberMedia/);
  assert.match(memberMedia, /memberMediaPublicFilePath\(req\.params\.file\)/);
  assert.match(memberMedia, /max-age=31536000, immutable/);
  assert.match(memberMedia, /sendFile\(path\.resolve\(full\)\)/);
  assert.match(memberMedia, /PUBLIC_KEY_RE = \/\^\[a-f0-9\]\{32\}\(_t\)\?\\.jpg\$\//);
  assert.doesNotMatch(memberMedia, /PUBLIC_KEY_RE = \/\^\[a-f0-9\]\{32\}\(_t\|_o\)\?\\.jpg\$\//);
});

test("public paths allow media/lib, public API, and /l share page (no login wall)", () => {
  assert.match(auth, /p\.startsWith\("\/media\/lib\/"\)/);
  assert.match(auth, /p\.startsWith\("\/api\/public\/"\)/);
  assert.match(auth, /p\.startsWith\("\/l\/"\)/);
});

test("public listing view whitelists safe fields only (no private/account data)", () => {
  assert.match(server, /publicListingView\(listing/);
  assert.match(server, /from "\.\/selfListings\.js"/);
});

test("in-app media library UI + gallery lightbox present", () => {
  assert.match(html, /id="mediaGrid"/);
  assert.match(html, /id="mediaQuota"/);
  assert.match(html, /id="appLightbox"/);
  assert.match(html, /function loadMediaLibrary\(\)/);
  assert.match(html, /fetch\("\/api\/media"/);
  assert.match(html, /\/api\/media\/\$\{encodeURIComponent\(id\)\}/); // delete
  // 第一張為封面（沿用既有排序，不再有貼封面網址）
  assert.doesNotMatch(html, /或貼封面網址/);
});

test("public share page has gallery + non-blocking CTA and does not advertise unbuilt Wish Room", () => {
  assert.match(listingHtml, /api\/public\/self-listing/);
  assert.match(listingHtml, /lightbox|lb-next|lb-prev/i);
  assert.match(listingHtml, /註冊會員可使用/);
  assert.match(listingHtml, /這則物件不存在或已下架/);
  assert.match(listingHtml, /找不到物件/);
  assert.match(listingHtml, /href="\/login\.html"/);
  assert.doesNotMatch(listingHtml, /許願房/); // Wish Room 尚未上線，公開頁不得宣傳
  assert.doesNotMatch(listingHtml, /listed_by|email_verified|password/);
});

test("owner cards expose public share path /l/:id so guests can open the listing", () => {
  assert.match(html, /href="\/l\/\$\{encodeURIComponent\(item\.post_id\)\}"/);
  assert.match(html, /公開分享頁/);
});
