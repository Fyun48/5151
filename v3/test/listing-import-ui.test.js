import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(dir, "..", p), "utf8");
const html = read("public/index.html");
const admin = read("public/admin.html");
const server = read("src/server.js");

test("sponsor import entry and review UI exist; normal members see locked hint", () => {
  assert.match(html, /從 591 \/ 5168 匯入/);
  assert.match(html, /贊助會員可使用 591 \/ 5168 物件匯入/);
  assert.match(html, /id="importUrl"/);
  assert.match(html, /id="importStartBtn"/);
  assert.match(html, /id="importReview"/);
  assert.match(html, /id="importDeclaration"/);
  assert.match(html, /我確認本人有權使用及刊登以上匯入的文字與圖片/);
  assert.match(html, /terms\.html\?type=external_import_declaration/);
  assert.match(html, /確認匯入（仍是草稿）/);
  assert.match(html, /function syncImportAccess/);
  assert.match(html, /function loadActiveImport/);
  assert.match(html, /listing-imports\/\$\{currentImport\.id\}\/publish/);
  assert.doesNotMatch(html, /許願房/);
});

test("server exposes listing-import routes with sponsor/rate-limit hooks", () => {
  assert.match(server, /app\.post\("\/api\/listing-imports"/);
  assert.match(server, /assertImportAllowed\(session\.userId/);
  assert.match(server, /startListingImportFor\(session\.userId/);
  assert.match(server, /app\.post\("\/api\/listing-imports\/:id\/confirm"/);
  assert.match(server, /app\.post\("\/api\/listing-imports\/:id\/publish"/);
  assert.match(server, /app\.get\("\/api\/admin\/listing-imports"/);
  assert.doesNotMatch(server, /Googlebot/);
});

test("admin has compact import provenance table", () => {
  assert.match(admin, /id="listingImports"/);
  assert.match(admin, /id="importAdminRows"/);
  assert.match(admin, /\/api\/admin\/listing-imports/);
  assert.match(admin, /聲明雜湊/);
});
