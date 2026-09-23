import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  adminSupportConfig,
  assertSupportCheckoutAllowed,
  createManualTransaction,
  createSupportCheckout,
  createSupportCost,
  createSupportSponsor,
  createSupportTier,
  dismissSupportCta,
  evaluateSupportCta,
  handleSupportCtaRequest,
  initSupportDomain,
  listCtaRules,
  listSupportProviders,
  listSupportTiers,
  previewSupportConfig,
  publicSupportConfig,
  publishSupportConfig,
  resetSupportCheckoutRateLimit,
  saveSupportConfig,
  supportDashboard,
  updateCtaRule,
  updateSupportProvider,
  updateSupportSponsor,
} from "../src/support.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(path.join(dir, "../src/server.js"), "utf8");
const authSrc = readFileSync(path.join(dir, "../src/auth.js"), "utf8");

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initSupportDomain(db, new Date("2026-09-15T00:00:00.000Z"));
  return db;
}

test("feature flags default false and public payload stays dark", () => {
  const db = open();
  const pub = publicSupportConfig(db);
  assert.equal(pub.enabled, false);
  assert.equal(pub.flags.cta_enabled, false);
  assert.equal(pub.flags.sponsor_enabled, false);
  assert.equal(pub.flags.public_cost_enabled, false);
  assert.equal(pub.entry.show, false);
  db.close();
});

test("sponsor ways stay listed while the support domain is closed", () => {
  const db = open();
  assert.deepEqual(publicSupportConfig(db).sponsor_links, []);
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO settings(key, value) VALUES ('sponsorLinks', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify({ providers: { bmc: { url: "https://buymeacoffee.com/jibbyexample", enabled: true } } }),
  );
  const pub = publicSupportConfig(db);
  assert.equal(pub.enabled, false);
  assert.deepEqual(pub.sponsor_links.map((row) => row.id), ["bmc"]);
  assert.equal(pub.sponsor_links[0].url, "https://buymeacoffee.com/jibbyexample");
  assert.equal(pub.entry.show, false);
  db.close();
});

test("seeded tiers exist and providers start disabled without a live URL", () => {
  const db = open();
  const tiers = listSupportTiers(db);
  assert.ok(tiers.some((row) => row.amount === 30));
  assert.ok(tiers.some((row) => row.amount === 60));
  assert.ok(tiers.some((row) => row.amount === 150));
  assert.ok(tiers.some((row) => row.amount === 0));
  const providers = listSupportProviders(db);
  assert.ok(providers.every((row) => row.is_active === false));
  assert.ok(providers.every((row) => !row.page_url));
  assert.ok(!("secret_ref" in providers[0]));
  db.close();
});

test("init remaps published 5151 default copy to 吉比租房 names", () => {
  const db = open();
  saveSupportConfig(db, {
    flags: { enabled: true },
    draft: {
      copy: {
        hero_title: "讓 5151 持續免費",
        hero_description: "5151 免費提供租屋搜尋、整理與比較工具。如果它曾經幫你少開一些分頁、少花一些找房時間，你可以自願支持網站持續維護。沒有支持也不會減少任何功能。",
        wall_title: "感謝支持 5151",
      },
    },
  });
  publishSupportConfig(db);
  initSupportDomain(db);
  const pub = publicSupportConfig(db);
  assert.equal(pub.copy.hero_title, "讓吉比租房追蹤持續免費");
  assert.match(pub.copy.hero_description, /^吉比租房物件追蹤免費提供/);
  assert.equal(pub.copy.wall_title, "感謝支持吉比租房追蹤");
  db.close();
});

test("draft copy does not appear on the public page until publish", () => {
  const db = open();
  saveSupportConfig(db, {
    flags: { enabled: true },
    draft: { copy: { hero_title: "草稿標題" } },
  });
  assert.notEqual(publicSupportConfig(db).copy?.hero_title, "草稿標題");
  publishSupportConfig(db);
  assert.equal(publicSupportConfig(db).copy.hero_title, "草稿標題");
  assert.equal(previewSupportConfig(db).copy.hero_title, "草稿標題");
  db.close();
});

test("manual transaction dedupes provider ids and dashboard uses net amounts", () => {
  const db = open();
  createManualTransaction(db, {
    provider: "buy_me_a_coffee",
    provider_transaction_id: "bmc-1",
    amount: 150,
    fee: 8,
    anonymous: true,
  });
  assert.throws(() => createManualTransaction(db, {
    provider: "buy_me_a_coffee",
    provider_transaction_id: "bmc-1",
    amount: 150,
  }), /已存在/);
  const dash = supportDashboard(db, { period: "month", now: new Date("2026-09-15T12:00:00.000Z") });
  assert.equal(dash.totals.count, 1);
  assert.equal(dash.totals.fee, 8);
  assert.equal(dash.funnel.completed_available, false);
  assert.match(dash.funnel.completed_note, /unavailable/i);
  db.close();
});

test("public costs hide internal rows and yearly costs convert", () => {
  const db = open();
  saveSupportConfig(db, { flags: { enabled: true, public_cost_enabled: true }, goal_amount: 4260 });
  publishSupportConfig(db);
  createSupportCost(db, {
    category: "GCP / Server",
    name: "伺服器",
    amount: 12000,
    billing_cycle: "yearly",
    is_public: true,
    start_date: "2026-01-01",
  });
  createSupportCost(db, {
    category: "Other",
    name: "內部敏感",
    amount: 9999,
    billing_cycle: "monthly",
    is_public: false,
    start_date: "2026-01-01",
  });
  const pub = publicSupportConfig(db, new Date("2026-09-15T00:00:00.000Z"));
  assert.equal(pub.show_cost, true);
  assert.equal(pub.costs.length, 1);
  assert.equal(pub.costs[0].monthly_amount, 1000);
  assert.ok(!pub.costs.some((row) => row.name === "內部敏感"));
  db.close();
});

test("sponsor CRUD stays draft until activated and public payload omits amount by default", () => {
  const db = open();
  saveSupportConfig(db, { flags: { enabled: true, sponsor_enabled: true } });
  publishSupportConfig(db);
  const draft = createSupportSponsor(db, { name: "XXX", status: "draft", disclosure_text: "贊助" });
  assert.equal(publicSupportConfig(db).sponsors.length, 0);
  updateSupportSponsor(db, draft.id, {
    status: "active",
    start_at: "2026-09-01",
    end_at: "2026-10-01",
  });
  const pub = publicSupportConfig(db, new Date("2026-09-15T00:00:00.000Z"));
  assert.equal(pub.sponsors[0].name, "XXX");
  assert.equal(pub.sponsors[0].disclosure_text, "贊助");
  assert.equal(pub.sponsors[0].amount, null);
  db.close();
});

test("CTA evaluate respects flags, threshold and dismiss cooldown", () => {
  const db = open();
  const disabled = evaluateSupportCta(db, { usage: { views: 99 } });
  assert.equal(disabled.show, false);
  saveSupportConfig(db, { flags: { enabled: true, cta_enabled: true } });
  const rules = listCtaRules(db);
  const viewRule = rules.find((row) => row.rule_type === "view_listing");
  updateCtaRule(db, viewRule.id, { enabled: true, threshold: 20, cooldown_days: 7 });
  const ready = evaluateSupportCta(db, {
    usage: { views: 30 },
    now: new Date("2026-09-15T00:00:00.000Z"),
  });
  assert.equal(ready.show, true);
  dismissSupportCta(db, { userId: 9, days: 14, now: new Date("2026-09-15T00:00:00.000Z") });
  const again = evaluateSupportCta(db, {
    userId: 9,
    usage: { views: 30 },
    now: new Date("2026-09-16T00:00:00.000Z"),
  });
  assert.equal(again.show, false);
  db.close();
});

test("anonymous CTA uses post-show state so the next evaluation stays in cooldown", () => {
  const db = open();
  saveSupportConfig(db, { flags: { enabled: true, cta_enabled: true } });
  const viewRule = listCtaRules(db).find((row) => row.rule_type === "view_listing");
  updateCtaRule(db, viewRule.id, { enabled: true, threshold: 20, cooldown_days: 7 });
  const now = new Date("2026-09-15T00:00:00.000Z");
  const first = handleSupportCtaRequest(db, {
    userId: null,
    usage: { views: 30 },
    clientState: {},
    now,
  });
  assert.equal(first.show, true);
  assert.ok(first.state.lastShownAt);
  assert.equal(first.state.shownCount, 1);
  const shown = db.prepare("SELECT COUNT(*) AS n FROM support_event WHERE kind='support_cta_shown'").get();
  assert.equal(shown.n, 1);
  const again = handleSupportCtaRequest(db, {
    userId: null,
    usage: { views: 30 },
    clientState: first.state,
    now: new Date("2026-09-16T00:00:00.000Z"),
  });
  assert.equal(again.show, false);
  const stillOne = db.prepare("SELECT COUNT(*) AS n FROM support_event WHERE kind='support_cta_shown'").get();
  assert.equal(stillOne.n, 1);
  db.close();
});

test("checkout stays abstract and reports unavailable without an active URL", async () => {
  const db = open();
  saveSupportConfig(db, { flags: { enabled: true } });
  const closed = await createSupportCheckout(db, { amount: 30 });
  assert.equal(closed.available, false);
  const provider = listSupportProviders(db).find((row) => row.kind === "buy_me_a_coffee");
  updateSupportProvider(db, provider.id, { is_active: true, page_url: "https://buymeacoffee.com/demo" });
  const tier = createSupportTier(db, { title: "測試", amount: 30, is_active: true });
  const openCheckout = await createSupportCheckout(db, { tierId: tier.id });
  assert.equal(openCheckout.available, true);
  assert.equal(openCheckout.checkoutType, "external");
  assert.equal(openCheckout.provider, "buy_me_a_coffee");
  db.close();
});

test("admin config never echoes provider secrets", () => {
  const db = open();
  const cfg = adminSupportConfig(db);
  assert.equal("secret_ref" in cfg, false);
  const providers = listSupportProviders(db);
  assert.ok(providers.every((row) => row.has_secret === false));
  db.close();
});

test("checkout rate limit trips after the burst", () => {
  resetSupportCheckoutRateLimit();
  for (let i = 0; i < 10; i += 1) assertSupportCheckoutAllowed("1.2.3.4", 1_000);
  assert.throws(() => assertSupportCheckoutAllowed("1.2.3.4", 1_000), /稍快/);
});

test("admin support routes stay behind requireAdminApi and public paths are allowlisted", () => {
  assert.match(serverSrc, /app\.get\("\/api\/admin\/support\/dashboard", requireAdminApi/);
  assert.match(serverSrc, /app\.put\("\/api\/admin\/support\/config", requireAdminApi/);
  assert.match(serverSrc, /app\.post\("\/api\/admin\/support\/transactions\/manual", requireAdminApi/);
  assert.match(serverSrc, /app\.put\("\/api\/admin\/support\/providers\/:id", requireAdminApi/);
  assert.match(serverSrc, /app\.post\("\/api\/support\/checkout"/);
  assert.match(authSrc, /p === "\/support.html"/);
  assert.match(authSrc, /p.startsWith\("\/api\/support\/"\)/);
  const ctaRoute = serverSrc.slice(
    serverSrc.indexOf('app.post("/api/support/cta"'),
    serverSrc.indexOf('app.post("/api/support/cta/dismiss"'),
  );
  assert.match(ctaRoute, /handleSupportCtaRequest/);
  assert.doesNotMatch(ctaRoute, /markSupportCtaShown/);
  assert.doesNotMatch(ctaRoute, /recordSupportEvent/);
});
