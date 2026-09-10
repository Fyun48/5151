import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/console.html"), "utf8");
const js = readFileSync(path.join(dir, "../public/console.js"), "utf8");
const css = readFileSync(path.join(dir, "../public/console.css"), "utf8");

test("console covers inbox, issues, gates and webhook test", () => {
  assert.match(html, /回饋收件匣/);
  assert.match(html, /議題與投票/);
  assert.match(html, /核准開發/);
  assert.match(html, /測試 webhook/);
  assert.doesNotMatch(html, /Phase 1（骨架/);
  assert.match(js, /\/ops\/api\/dashboard/);
  assert.match(js, /\/ops\/api\/feedback/);
  assert.match(js, /\/ops\/api\/notify\/test/);
  assert.match(html, /APPROVE_DEVELOPMENT/);
});

test("tab panes honor the hidden attribute (display:grid must not override it)", () => {
  assert.match(css, /\.tabpane\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(css, /#ownerArea\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(js, /pane\.hidden = pane\.id !== `tab-\$\{name\}`/);
  assert.match(html, /id="tab-inbox"[^>]*hidden/);
  assert.match(html, /id="tab-issues"[^>]*hidden/);
  assert.match(html, /id="tab-audit"[^>]*hidden/);
  assert.match(html, /id="tab-products"[^>]*hidden/);
  assert.match(html, /console\.css\?v=/);
  assert.match(html, /console\.js\?v=/);
});

test("console has product cards, switcher, and one-time secret", () => {
  assert.match(html, /data-tab="products"/);
  assert.match(html, /產品卡/);
  assert.match(html, /id="productCards"/);
  assert.match(html, /id="productSwitch"/);
  assert.match(html, /id="secretOnce"[^>]*hidden/);
  assert.match(html, /只顯示一次/);
  assert.match(html, /id="confirmDlg"[^>]*hidden/);
  assert.match(html, /role="status"/);
  assert.match(js, /\/ops\/api\/products/);
  assert.match(js, /\/ops\/api\/products\/\$\{encodeURIComponent\(id\)\}\/\$\{action\}/);
  assert.match(js, /pause|resume|unsubscribe|reconnect|rotate-credential/);
  assert.match(js, /確定解除/);
  assert.match(js, /確定輪替/);
  assert.match(js, /確定重連/);
  assert.match(js, /使用中/);
  assert.match(js, /aria-label/);
  assert.match(js, /productId=/);
  assert.match(css, /overflow-x:\s*hidden/);
});
