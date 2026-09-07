import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(dir, "..", p), "utf8");

test("admin CMS UI covers list draft preview publish history and reacceptance", () => {
  const html = read("public/admin.html");
  assert.match(html, /id="contentCms"/);
  assert.match(html, /id="cmsEditor"/);
  assert.match(html, /id="cmsPreview"/);
  assert.match(html, /id="cmsHistory"/);
  assert.match(html, /id="cmsReaccept"/);
  assert.match(html, /id="cmsNewVersion"/);
  assert.match(html, /\/api\/admin\/documents/);
  assert.match(html, /requires_reacceptance/);
  assert.match(html, /已發布版本，本文鎖定/);
});

test("registration and reacceptance UIs stay readable and unchecked", () => {
  const login = read("public/login.html");
  const index = read("public/index.html");
  const terms = read("public/terms.html");
  assert.match(login, /id="legalOverlay"/);
  assert.match(login, /font-size: 16px/);
  assert.match(index, /id="reacceptOverlay"/);
  assert.match(index, /id="reacceptBanner"/);
  assert.match(index, /稍後再說/);
  assert.doesNotMatch(index, /location\.replace\("\/login\.html\?reaccept/);
  assert.match(index, /data-reaccept-type/);
  assert.match(terms, /\/api\/public\/documents/);
  assert.match(index, /listing_rules/);
  assert.match(index, /閱讀目前有效的免責聲明/);
});

test("server wires versioned register consents and admin-only CMS mutations", () => {
  const server = read("src/server.js");
  const auth = read("src/auth.js");
  assert.match(server, /registerUserWithConsents/);
  assert.match(server, /pending_documents/);
  assert.match(server, /app\.get\("\/api\/admin\/documents"/);
  assert.match(server, /app\.post\("\/api\/admin\/documents"/);
  assert.match(server, /requireAdminApi/);
  assert.match(server, /acceptPendingDocuments/);
  assert.match(auth, /p === "\/terms\.html"/);
  assert.match(auth, /p === "\/api\/public\/documents"/);
  assert.doesNotMatch(auth, /p === "\/api\/admin\/documents"/);
  assert.match(server, /renderSafeContent/);
});

test("media public share and listing routes remain present", () => {
  const server = read("src/server.js");
  const auth = read("src/auth.js");
  const html = read("public/index.html");
  assert.match(server, /app\.get\("\/l\/:id"/);
  assert.match(server, /app\.get\("\/api\/media"/);
  assert.match(auth, /p\.startsWith\("\/l\/"\)/);
  assert.match(html, /id="mediaGrid"/);
  assert.match(html, /公開分享頁/);
});
