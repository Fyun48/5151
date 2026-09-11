import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  TWD_MINOR,
  ensureBudgetSchema,
  saveProviderConfig,
  reserveBudget,
  settleBudget,
  holdBudget,
  releaseBudget,
  listProviderAdmin,
  twdToMinor,
} from "../src/budgetGuard.js";
import { executeWithProvider } from "../src/providers/executeWithProvider.js";
import { fetchListingPage } from "../src/providers/scraping.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  ensureBudgetSchema(db);
  return db;
}

function enableStub(db, category = "scraping_api", daily = 20) {
  return saveProviderConfig(db, {
    category,
    provider_code: "stub_paid",
    is_enabled: true,
    daily_budget_twd: daily,
    monthly_budget_twd: 100,
    ceiling_twd: 1,
  });
}

test("20 TWD budget with 18 settled allows at most two of ten 1 TWD reserves", () => {
  const db = open();
  enableStub(db, "scraping_api", 20);
  const now = new Date("2026-09-11T04:00:00.000Z");
  db.prepare(`
    INSERT INTO budget_limits(scope_kind, scope_key, period_kind, period_key, timezone, limit_minor, settled_minor, reserved_minor)
    VALUES ('category', 'scraping_api', 'day', '2026-09-11', 'Asia/Taipei', ?, ?, 0)
  `).run(twdToMinor(20), twdToMinor(18));
  const results = Array.from({ length: 10 }, (_, i) => reserveBudget(db, {
    category: "scraping_api",
    ceilingMinor: TWD_MINOR,
    requestId: `req-${i}`,
    attemptId: "a1",
    now,
  }));
  assert.equal(results.filter((row) => row.ok).length, 2);
  assert.equal(results.filter((row) => row.reason === "budget_exceeded").length, 8);
  db.close();
});

test("timeout holds sent reservation and does not free the ceiling", () => {
  const db = open();
  enableStub(db, "scraping_api", 2);
  const now = new Date("2026-09-11T04:00:00.000Z");
  const first = reserveBudget(db, { category: "scraping_api", ceilingMinor: TWD_MINOR, requestId: "t1", now });
  assert.equal(first.ok, true);
  holdBudget(db, first.reservation, { category: "scraping_api", now, note: "timeout" });
  const second = reserveBudget(db, { category: "scraping_api", ceilingMinor: TWD_MINOR, requestId: "t2", now });
  assert.equal(second.ok, true);
  const third = reserveBudget(db, { category: "scraping_api", ceilingMinor: TWD_MINOR, requestId: "t3", now });
  assert.equal(third.ok, false);
  assert.equal(third.reason, "budget_exceeded");
  const held = db.prepare("SELECT job_state FROM call_reservations WHERE id = ?").get(first.reservation.id);
  assert.equal(held.job_state, "unknown");
  const released = releaseBudget(db, first.reservation, { category: "scraping_api", now });
  assert.equal(released.ok, false);
  db.close();
});

test("known unused reservation can be released for the next call", () => {
  const db = open();
  enableStub(db, "scraping_api", 1);
  const now = new Date("2026-09-11T04:00:00.000Z");
  const first = reserveBudget(db, { category: "scraping_api", ceilingMinor: TWD_MINOR, requestId: "r1", now });
  releaseBudget(db, first.reservation, { category: "scraping_api", now });
  const second = reserveBudget(db, { category: "scraping_api", ceilingMinor: TWD_MINOR, requestId: "r2", now });
  assert.equal(second.ok, true);
  db.close();
});

test("daily budget 0 blocks paid calls", () => {
  const db = open();
  saveProviderConfig(db, { category: "scraping_api", provider_code: "stub_paid", is_enabled: true, daily_budget_twd: 0, ceiling_twd: 1 });
  const blocked = reserveBudget(db, { category: "scraping_api", ceilingMinor: TWD_MINOR, now: new Date("2026-09-11T04:00:00.000Z") });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "budget_zero");
  db.close();
});

test("disabled provider uses fallback and does not reserve", async () => {
  const db = open();
  const now = new Date("2026-09-11T04:00:00.000Z");
  const out = await executeWithProvider({
    db,
    category: "scraping_api",
    now,
    actionWithProvider: async () => ({ value: "paid", usage: { costMinor: TWD_MINOR } }),
    fallbackAction: async () => "free",
  });
  assert.equal(out, "free");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM call_reservations").get().n, 0);
  db.close();
});

test("enabled stub scraping settles and fetchListingPage stays on free path when off", async () => {
  const db = open();
  enableStub(db);
  const now = new Date("2026-09-11T04:00:00.000Z");
  const paid = await executeWithProvider({
    db,
    category: "scraping_api",
    now,
    actionWithProvider: async () => ({ value: "paid-html", usage: { costMinor: TWD_MINOR } }),
    fallbackAction: async () => "free",
  });
  assert.equal(paid, "paid-html");
  assert.equal(db.prepare("SELECT job_state FROM call_reservations").get().job_state, "settled");

  saveProviderConfig(db, { category: "scraping_api", provider_code: "stub_paid", is_enabled: false, daily_budget_twd: 20, ceiling_twd: 1 });
  const html = await fetchListingPage("https://example.com/x", {
    db,
    fallback: async () => "direct-html",
  });
  assert.equal(html, "direct-html");
  db.close();
});

test("uncertain timeout in executeWithProvider keeps the reservation", async () => {
  const db = open();
  enableStub(db, "scraping_api", 1);
  const now = new Date("2026-09-11T04:00:00.000Z");
  const out = await executeWithProvider({
    db,
    category: "scraping_api",
    now,
    actionWithProvider: async () => {
      const err = new Error("timeout");
      err.name = "AbortError";
      err.uncertainCharge = true;
      throw err;
    },
    fallbackAction: async () => "free",
  });
  assert.equal(out, "free");
  assert.equal(db.prepare("SELECT job_state FROM call_reservations").get().job_state, "unknown");
  const again = reserveBudget(db, { category: "scraping_api", ceilingMinor: TWD_MINOR, now });
  assert.equal(again.ok, false);
  db.close();
});

test("admin view never returns raw credentials", () => {
  const db = open();
  saveProviderConfig(db, {
    category: "scraping_api",
    provider_code: "zenrows",
    is_enabled: false,
    daily_budget_twd: 0,
    credential: "secret-zenrows-key",
  });
  const view = listProviderAdmin(db, { now: new Date("2026-09-11T04:00:00.000Z") });
  const scraping = view.items.find((row) => row.category === "scraping_api");
  assert.equal(scraping.has_credential, true);
  assert.equal(JSON.stringify(view).includes("secret-zenrows-key"), false);
  db.close();
});
