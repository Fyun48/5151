import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const sw = readFileSync(path.join(dir, "../public/sw.js"), "utf8");

// Service Worker cache versioning：確保換版後使用者能取得新 shell、舊版 cache 被安全清除。
test("cache version constant is centralized (single prefix + version)", () => {
  assert.match(sw, /const CACHE_PREFIX = "jibi-shell-";/);
  assert.match(sw, /const CACHE_VERSION = "v\d+";/);
  assert.match(sw, /const CACHE = CACHE_PREFIX \+ CACHE_VERSION;/);
  // 名稱不再散落 magic string：除了前綴定義本身，不應再出現硬編碼的完整 cache 名稱。
  const fullNameHits = (sw.match(/"jibi-shell-v\d+"/g) || []).length;
  assert.equal(fullNameHits, 0, "cache full name should be composed from prefix+version, not hardcoded");
});

test("active cache version is bumped past the previously-shipped v3", () => {
  const version = sw.match(/const CACHE_VERSION = "(v\d+)";/)[1];
  assert.notEqual(version, "v3");
  assert.ok(Number(version.slice(1)) >= 4);
});

test("activate cleans ONLY this site's old cache versions (prefix-scoped), not others", () => {
  // 必須在 activate 內以 caches.keys() 過濾 CACHE_PREFIX 開頭且 !== CACHE 才刪除。
  assert.match(sw, /addEventListener\("activate"/);
  assert.match(sw, /caches\.keys\(\)/);
  assert.match(sw, /startsWith\(CACHE_PREFIX\)/);
  assert.match(sw, /key !== CACHE/);
  assert.match(sw, /caches\.delete\(key\)/);
  // 不可無條件刪除所有 cache（避免清掉不屬於本 SW 的 cache）。
  assert.doesNotMatch(sw, /caches\.keys\(\)[\s\S]{0,80}\.map\(\s*\(?key\)?\s*=>\s*caches\.delete/);
});

test("new SW takes over immediately (skipWaiting + clients.claim) so reload shows new shell", () => {
  assert.match(sw, /self\.skipWaiting\(\)/);
  assert.match(sw, /self\.clients\.claim\(\)/);
});

test("offline/cache fallback strategy preserved (network-first with cache fallback)", () => {
  assert.match(sw, /addEventListener\("fetch"/);
  assert.match(sw, /fetch\(req\)\.catch\(\(\)\s*=>\s*caches\.match\(req\)/);
});
