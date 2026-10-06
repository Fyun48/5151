// 物件一鍵分享（Phase 1）OG meta 的字串斷言＋純函式單元測試。
// 驗證：server.js 的 `/l/:id` 有 OG 注入、`/go/:id` 有 ref 記錄；
// listingShare.js 有 og:title／og:image／og:url／canonical 的組裝與注入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildListingShareOgMeta,
  firstListingShareImage,
  injectListingShareMeta,
  listingShareDescription,
} from "../src/listingShare.js";

const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const moduleSrc = readFileSync(new URL("../src/listingShare.js", import.meta.url), "utf8");

test("server.js：/l/:id 讀快取範本並注入 OG meta", () => {
  assert.match(server, /app\.get\("\/l\/:id", async \(req, res\)/);
  assert.match(server, /LISTING_SHARE_TEMPLATE/);
  assert.match(server, /buildListingShareOgMeta\(\{ title, description, image, url: canonical \}\)/);
  assert.match(server, /injectListingShareMeta\(LISTING_SHARE_TEMPLATE, meta, title\)/);
  assert.match(server, /firstListingShareImage\(view, base\)/);
});

test("server.js：/go/:id 有合法 ref 時先記一筆 view（不依賴 cookie）", () => {
  assert.match(server, /req\.query\?\.ref/);
  assert.match(server, /recordListingShareEventAsync\(\{\s*shareToken: ref/);
  assert.match(server, /eventType: "view"/);
});

test("listingShare.js：og:title／og:image／og:url／canonical 都在", () => {
  assert.match(moduleSrc, /og:title/);
  assert.match(moduleSrc, /og:image/);
  assert.match(moduleSrc, /og:description/);
  assert.match(moduleSrc, /og:url/);
  assert.match(moduleSrc, /rel="canonical"/);
  assert.match(moduleSrc, /og:type/);
  assert.match(moduleSrc, /og:site_name/);
});

test("buildListingShareOgMeta：組出 meta，無 image 時省略 og:image", () => {
  const meta = buildListingShareOgMeta({
    title: "台北兩房",
    description: "近捷運",
    image: "https://example.com/1.jpg",
    url: "https://example.com/l/2100000001",
  });
  assert.match(meta, /<meta property="og:title" content="台北兩房" \/>/);
  assert.match(meta, /<meta property="og:description" content="近捷運" \/>/);
  assert.match(meta, /<meta property="og:url" content="https:\/\/example\.com\/l\/2100000001" \/>/);
  assert.match(meta, /<meta property="og:image" content="https:\/\/example\.com\/1\.jpg" \/>/);
  assert.match(meta, /<link rel="canonical" href="https:\/\/example\.com\/l\/2100000001" \/>/);
  const noImg = buildListingShareOgMeta({ title: "x", description: "", image: "", url: "https://e/l/1" });
  assert.doesNotMatch(noImg, /og:image/);
});

test("injectListingShareMeta：meta 進 <head>，且只保留一個 <title>", () => {
  const template = '<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>舊標題</title></head><body>x</body></html>';
  const meta = buildListingShareOgMeta({ title: "新標題", description: "", image: "", url: "https://e/l/1" });
  const out = injectListingShareMeta(template, meta, "新標題");
  assert.match(out, /<head>/);
  assert.ok(out.indexOf("og:title") < out.indexOf("</head>"), "og meta 要在 head 內");
  assert.equal((out.match(/<title>/g) || []).length, 1, "只能有一個 <title>");
  assert.match(out, /<title>新標題<\/title>/);
  assert.doesNotMatch(out, /舊標題/);
});

test("firstListingShareImage：cover 優先、相對路徑補 PUBLIC_BASE_URL", () => {
  const withCover = firstListingShareImage({ cover: "https://cdn/1.jpg", photos: ["/media/self/a.png"] }, "https://example.com");
  assert.equal(withCover, "https://cdn/1.jpg");
  const noCover = firstListingShareImage({ cover: "", photos: ["/media/self/a.png"] }, "https://example.com");
  assert.equal(noCover, "https://example.com/media/self/a.png");
  const empty = firstListingShareImage({ cover: "", photos: [] }, "https://example.com");
  assert.equal(empty, "");
});

test("listingShareDescription：body 去標籤後截斷 160 字，fallback 到 traits", () => {
  const d = listingShareDescription({ body: "<p>近捷運</p>生活機能好" });
  assert.equal(d, "近捷運 生活機能好");
  assert.ok(d.length <= 160);
  const fromTraits = listingShareDescription({ body: "", trait_labels: ["可養寵物", "有陽台"] });
  assert.equal(fromTraits, "可養寵物、有陽台");
});

test("server.js：PUBLIC_BASE_URL 未設時，share-link 與 OG base 回退到請求 origin", () => {
  assert.match(server, /listingShareUrl\(id, result\.shareToken, publicBaseUrlEnv\(\) \|\| publicBaseUrl\(req\)/);
  assert.match(server, /const base = publicBaseUrlEnv\(\) \|\| publicBaseUrl\(req\);/);
});
