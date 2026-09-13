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

test("browser back/forward uses dirty owner, not the already-updated location.hash", () => {
  const IA = load();
  IA.beginPage("inventory/sources");
  IA.setDirty(true, 2);
  const next = "overview";
  assert.equal(IA.normalizeHash(next), next);
  assert.equal(IA.normalizeHash(next) !== next, false, "hashchange 時 location.hash 已等於目的地");
  const decision = IA.decideNavigation(next);
  assert.equal(decision.prompt, true);
  assert.equal(decision.allow, false);
  assert.equal(decision.stayOn, "inventory/sources");
  const samePage = IA.decideNavigation("inventory/sources");
  assert.equal(samePage.prompt, false);
  assert.equal(samePage.allow, true);
  assert.equal(samePage.stayOn, "inventory/sources");
});

test("transient search/filter controls and pages without save handlers stay clean", () => {
  const IA = load();
  IA.beginPage("members/users");
  IA.setDirty(true, 9);
  assert.equal(IA.isDirty(), false);
  assert.equal(IA.saveSpec("overview"), null);
  assert.equal(IA.saveSpec("inventory/same-house"), null);
  assert.equal(IA.saveSpec("feedback/inbox"), null);
  assert.equal(IA.saveSpec("inventory/sources")?.form, "crawlForm");
  assert.equal(IA.saveSpec("content/qa")?.button, "helpQaSave");
  assert.equal(IA.isTransientControl({ id: "memberQuery" }), true);
  assert.equal(IA.isTransientControl({ id: "sameHouseQuery" }), true);
  assert.equal(IA.isTransientControl({ id: "feedbackFilterStatus" }), true);
  assert.equal(IA.isTransientControl({ id: "adminSearch", type: "search" }), true);
  assert.equal(IA.noteControlChange({ id: "memberQuery" }), false);
  IA.beginPage("inventory/sources");
  assert.equal(IA.noteControlChange({ id: "sameHouseLimit" }), false);
});

test("dirtyCount is unique changed controls, not keypress count", () => {
  const IA = load();
  assert.equal(IA.changedCount({ a: "1", b: "2" }, { a: "1", b: "2" }), 0);
  assert.equal(IA.changedCount({ a: "1", b: "2" }, { a: "1", b: "3" }), 1);
  assert.equal(IA.changedCount({ a: "1" }, { a: "1", b: "2", c: "3" }), 2);
  assert.equal(IA.changedCount({ a: "1", b: "2" }, { a: "9", b: "8" }), 2);
});
