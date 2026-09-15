import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAGE_COPY,
  ctaCooldownOpen,
  ctaRuleEligible,
  dashboardTotals,
  dismissUntilFromDays,
  goalProgress,
  mergeCtaState,
  monthlyCostAmount,
  pickEligibleCtaRule,
  resolveSponsorStatus,
  sortSupportTiers,
  sponsorWindowActive,
  transactionDedupeKey,
} from "../src/supportDomain.js";
import { getSupportPaymentProvider, resolveSupportCheckout, SupportPaymentUnavailable } from "../src/supportProviders.js";

test("default support copy uses 吉比租房 names, not 5151", () => {
  assert.equal(DEFAULT_PAGE_COPY.hero_title, "讓吉比租房追蹤持續免費");
  assert.match(DEFAULT_PAGE_COPY.hero_description, /^吉比租房物件追蹤免費提供/);
  assert.equal(DEFAULT_PAGE_COPY.wall_title, "感謝支持吉比租房追蹤");
  assert.doesNotMatch(JSON.stringify(DEFAULT_PAGE_COPY), /5151/);
});

test("yearly cost converts to monthly", () => {
  assert.equal(monthlyCostAmount(4260, "monthly"), 4260);
  assert.equal(monthlyCostAmount(12000, "yearly"), 1000);
});

test("goal progress caps the bar at 100 and still reports overage", () => {
  const mid = goalProgress(1480, 4260);
  assert.equal(mid.percent, 34.7);
  assert.equal(mid.visualPercent, 34.7);
  assert.equal(mid.over, false);
  const over = goalProgress(5300, 4260);
  assert.ok(over.percent > 100);
  assert.equal(over.visualPercent, 100);
  assert.equal(over.over, true);
});

test("tiers sort by sort_order then id", () => {
  const rows = sortSupportTiers([
    { id: 3, sort_order: 20 },
    { id: 1, sort_order: 10 },
    { id: 2, sort_order: 10 },
  ]);
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3]);
});

test("CTA eligibility and cooldown", () => {
  assert.equal(ctaRuleEligible({ views: 30 }, { rule_type: "view_listing", threshold: 20, enabled: true }), true);
  assert.equal(ctaRuleEligible({ views: 10 }, { rule_type: "view_listing", threshold: 20, enabled: true }), false);
  assert.equal(ctaRuleEligible({ views: 30 }, { rule_type: "view_listing", threshold: 20, enabled: false }), false);
  const now = new Date("2026-09-15T00:00:00.000Z");
  assert.equal(ctaCooldownOpen({ lastShownAt: "2026-09-14T00:00:00.000Z" }, now, 7), false);
  assert.equal(ctaCooldownOpen({ lastShownAt: "2026-09-01T00:00:00.000Z" }, now, 7), true);
  assert.equal(ctaCooldownOpen({ dismissedUntil: "2026-09-20T00:00:00.000Z" }, now, 7), false);
  const until = dismissUntilFromDays(14, now);
  assert.equal(until.startsWith("2026-09-29"), true);
});

test("CTA picks the first cooling-open eligible rule by priority", () => {
  const now = new Date("2026-09-15T00:00:00.000Z");
  const rule = pickEligibleCtaRule([
    { id: 1, rule_type: "view_listing", threshold: 20, enabled: 1, priority: 10, cooldown_days: 7, message: "a" },
    { id: 2, rule_type: "watch", threshold: 5, enabled: 1, priority: 5, cooldown_days: 7, message: "b" },
  ], { views: 30, watches: 6 }, { lastShownAt: "2026-09-01T00:00:00.000Z" }, now);
  assert.equal(rule.id, 2);
});

test("member dismiss wins when it is later than the guest device", () => {
  const merged = mergeCtaState(
    { dismissedUntil: "2026-10-01T00:00:00.000Z", shownCount: 2 },
    { dismissedUntil: "2026-09-20T00:00:00.000Z", shownCount: 4 },
    new Date("2026-09-15T00:00:00.000Z"),
  );
  assert.equal(merged.dismissedUntil, "2026-10-01T00:00:00.000Z");
  assert.equal(merged.shownCount, 4);
});

test("transaction dedupe key requires provider and id", () => {
  assert.equal(transactionDedupeKey("buy_me_a_coffee", "tx_1"), "buy_me_a_coffee::tx_1");
  assert.equal(transactionDedupeKey("buy_me_a_coffee", ""), "");
});

test("sponsor active window", () => {
  const now = new Date("2026-09-15T00:00:00.000Z");
  assert.equal(resolveSponsorStatus({ status: "active", start_at: "2026-09-01", end_at: "2026-09-30" }, now), "active");
  assert.equal(resolveSponsorStatus({ status: "active", end_at: "2026-09-01" }, now), "expired");
  assert.equal(resolveSponsorStatus({ status: "scheduled", start_at: "2026-10-01" }, now), "scheduled");
  assert.equal(sponsorWindowActive({ status: "active", start_at: "2026-09-01", end_at: "2026-09-30" }, now), true);
  assert.equal(sponsorWindowActive({ status: "draft", start_at: "2026-09-01" }, now), false);
});

test("dashboard totals split personal and corporate", () => {
  const totals = dashboardTotals([
    { amount: 100, fee: 5, net_amount: 95, status: "manual", anonymous: 1, channel: "personal" },
    { amount: 500, fee: 0, net_amount: 500, status: "completed", anonymous: 0, supporter_name: "A", channel: "corporate" },
    { amount: 10, status: "failed" },
  ]);
  assert.equal(totals.count, 2);
  assert.equal(totals.corporate, 500);
  assert.equal(totals.personal, 100);
  assert.equal(totals.anonymous, 1);
});

test("Buy Me a Coffee adapter returns external checkout and stubs webhook", async () => {
  const bmc = getSupportPaymentProvider("buy_me_a_coffee");
  const checkout = await bmc.getCheckoutUrl({ page_url: "https://buymeacoffee.com/demo" });
  assert.equal(checkout.checkoutType, "external");
  assert.equal(checkout.provider, "buy_me_a_coffee");
  assert.match(checkout.url, /^https:\/\/buymeacoffee\.com\//);
  const hook = await bmc.verifyWebhook({}, {});
  assert.equal(hook.implemented, false);
  await assert.rejects(() => resolveSupportCheckout({ kind: "buy_me_a_coffee", is_active: 1, page_url: "" }), SupportPaymentUnavailable);
  const future = getSupportPaymentProvider("newebpay");
  await assert.rejects(() => future.getCheckoutUrl(), SupportPaymentUnavailable);
});
