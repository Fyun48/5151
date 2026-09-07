import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listingPhotoUrls } from "../src/selfListings.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(dir, "..", p), "utf8");
const server = read("src/server.js");
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
  assert.match(server, /app\.get\("\/media\/lib\/:file"/);
  assert.match(server, /app\.get\("\/api\/public\/self-listing\/:id"/);
  assert.match(server, /app\.get\("\/l\/:id"/);
  // 刊登時驗證素材所有權（擋盜連他人 media）
  assert.match(server, /assertOwnsMemberMediaUrls\(session\.userId/);
  // 內容定址檔可長快取
  assert.match(server, /max-age=31536000, immutable/);
});

test("public paths allow media/lib, public API, and /l share page (no login wall)", () => {
  assert.match(auth, /p\.startsWith\("\/media\/lib\/"\)/);
  assert.match(auth, /p\.startsWith\("\/api\/public\/"\)/);
  assert.match(auth, /p\.startsWith\("\/l\/"\)/);
});

test("public listing view whitelists safe fields only (no private/account data)", () => {
  // publicListingView 只輸出白名單；不得出現 email / user_id / listed_by / role(session) 等私有欄位
  const fn = server.slice(server.indexOf("function publicListingView"), server.indexOf("app.get(\"/api/public/self-listing"));
  assert.match(fn, /contact_name|phone|line_url/);
  assert.doesNotMatch(fn, /email|listed_by_user_id|user_id|password|self_ban|agreed/);
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
  assert.doesNotMatch(listingHtml, /許願房/); // Wish Room 尚未上線，公開頁不得宣傳
});
