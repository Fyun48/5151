import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/admin-ia.js"),
  "utf8",
);

function load() {
  const ctx = createContext({ window: {}, globalThis: {} });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  runInContext(src, ctx);
  return ctx.AdminIA;
}

test("legacy admin hashes map to the new pages", () => {
  const IA = load();
  assert.equal(IA.normalizeHash("members"), "members/users");
  assert.equal(IA.normalizeHash("crawl"), "inventory/crawl");
  assert.equal(IA.normalizeHash("site"), "content/brand");
  assert.equal(IA.normalizeHash("qa"), "content/qa");
  assert.equal(IA.normalizeHash("notices"), "comms/notices");
  assert.equal(IA.normalizeHash("promo"), "revenue/sponsors");
  assert.equal(IA.normalizeHash("ads"), "revenue/ads");
  assert.equal(IA.normalizeHash("mail"), "comms/smtp");
  assert.equal(IA.normalizeHash("feedback"), "feedback/inbox");
  assert.equal(IA.normalizeHash("inventory/same-house"), "inventory/same-house");
  assert.equal(IA.normalizeHash(""), "overview");
});

test("admin command search finds destinations by alias", () => {
  const IA = load();
  assert.equal(IA.searchPages("樂屋")[0].id, "inventory/sources");
  assert.equal(IA.searchPages("Google")[0].id, "system/maps");
  assert.equal(IA.searchPages("免責")[0].id, "content/legal");
  assert.equal(IA.searchPages("刪除會員")[0].id, "members/users");
  assert.equal(IA.searchPages("同房源")[0].id, "inventory/same-house");
});
