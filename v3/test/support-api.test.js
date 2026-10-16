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
  recordSupportEvent,
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
const supportSrc = readFileSync(path.join(dir, "../src/support.js"), "utf8");
const supportAsyncSrc = readFileSync(path.join(dir, "../src/supportAsync.js"), "utf8");

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initSupportDomain(db, new Date("2026-09-15T00:00:00.000Z"));
  return db;
}

/** 把 domain 打開＋啟用一個有網址的收款管道，才能走到「有得結帳」的分支。 */
function openCheckout(db, { page_url = "https://buymeacoffee.com/demo" } = {}) {
  saveSupportConfig(db, { flags: { enabled: true } });
  const provider = listSupportProviders(db).find((row) => row.kind === "buy_me_a_coffee");
  updateSupportProvider(db, provider.id, { is_active: true, page_url });
  return provider;
}

const customTier = (db) => listSupportTiers(db).find((row) => row.amount === 0);

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
    // ⚠️ 一定要指定 `received_at`：儀表板是用 `received_at` 篩選期間（下面 now = 2026-09-15），
    // 而 `createManualTransaction()` 預設用「現在」當 received_at ⇒ 只要執行時間跨到 10 月，
    // 這筆就落在 9 月的窗口外、`totals.count` 變 0（2026-10-01 00:4x 實際紅過一次）。
    received_at: "2026-09-10T00:00:00.000Z",
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

// ---------------------------------------------------------------------------
// 自訂金額（B1）：前端送的 amount 真的到後端、有驗證、而且只有「自訂支持」採用它。
// ---------------------------------------------------------------------------

test("custom amount is carried through the checkout and validated as an integer 10–100000", async () => {
  const db = open();
  openCheckout(db);
  const custom = customTier(db);

  const ok = await createSupportCheckout(db, { tierId: custom.id, amount: 500 });
  assert.equal(ok.available, true);
  assert.equal(ok.amount, 500);
  assert.equal(ok.checkoutType, "external");
  // 瀏覽器表單送出的是字串，數字字串要收。
  assert.equal((await createSupportCheckout(db, { tierId: custom.id, amount: "320" })).amount, 320);
  // 邊界值本身合法。
  assert.equal((await createSupportCheckout(db, { tierId: custom.id, amount: 10 })).amount, 10);
  assert.equal((await createSupportCheckout(db, { tierId: custom.id, amount: 100000 })).amount, 100000);
  db.close();
});

test("custom amount rejects non-integers and out-of-range values", async () => {
  const db = open();
  openCheckout(db);
  const custom = customTier(db);

  const bad = [9, 0, -10, 100001, 12.5, "12.5", "abc", "", " ", null, undefined, 1e9];
  for (const amount of bad) {
    await assert.rejects(
      () => createSupportCheckout(db, { tierId: custom.id, amount }),
      (error) => error.code === "INVALID_AMOUNT" && /整數/.test(error.message),
      `amount=${String(amount)} 應該被 INVALID_AMOUNT 擋下`,
    );
  }
  // 被擋下之後，同一個資料庫再送合法金額仍然可以結帳（驗證沒留下壞狀態）。
  const after = await createSupportCheckout(db, { tierId: custom.id, amount: 500 });
  assert.equal(after.available, true);
  assert.equal(after.amount, 500);
  db.close();
});

test("a tier with a fixed amount wins over the amount sent by the client", async () => {
  const db = open();
  openCheckout(db);
  const fixed = listSupportTiers(db).find((row) => row.amount === 150);

  assert.equal((await createSupportCheckout(db, { tierId: fixed.id, amount: 99999 })).amount, 150);
  assert.equal((await createSupportCheckout(db, { tierId: fixed.id })).amount, 150);
  // 固定方案的金額不是使用者控制的，亂帶也不該讓結帳失敗（維持既有規則）。
  assert.equal((await createSupportCheckout(db, { tierId: fixed.id, amount: "abc" })).amount, 150);
  db.close();
});

test("amount without a tier is validated when present and keeps the legacy 0 when absent", async () => {
  const db = open();
  openCheckout(db);
  assert.equal((await createSupportCheckout(db, { amount: 250 })).amount, 250);
  assert.equal((await createSupportCheckout(db, {})).amount, 0);
  await assert.rejects(
    () => createSupportCheckout(db, { amount: 5 }),
    (error) => error.code === "INVALID_AMOUNT",
  );
  db.close();
});

test("sync and async checkout share one amount rule", () => {
  assert.match(supportSrc, /resolveSupportCheckoutAmount\(\{ amount, tier \}\)/);
  assert.match(supportAsyncSrc, /resolveSupportCheckoutAmount\(\{ amount, tier \}\)/);
  // 金額驗證只留一份：兩支結帳函式都不再自己 moneyAmount(amount) 決定金額。
  assert.doesNotMatch(supportSrc, /let payAmount = moneyAmount\(amount\)/);
  assert.doesNotMatch(supportAsyncSrc, /let payAmount = moneyAmount\(amount\)/);
});

test("support_checkout_opened records the effective amount and the tier it came from", () => {
  const db = open();
  recordSupportEvent(db, "support_checkout_opened", { meta: { tierId: 7, amount: 500 } });
  const row = db.prepare(
    "SELECT meta_json FROM support_event WHERE kind='support_checkout_opened' ORDER BY id DESC LIMIT 1",
  ).get();
  // meta 是白名單（只留 ruleId／tierId／amount／sponsorId／days），沒加欄位就會被默默丢掉。
  assert.deepEqual(JSON.parse(row.meta_json), { tierId: 7, amount: 500 });
  db.close();
});

test("checkout route keeps the 200 + available:false shape for invalid amounts", () => {
  const route = serverSrc.slice(
    serverSrc.indexOf('app.post("/api/support/checkout"'),
    serverSrc.indexOf('app.post("/api/support/cta"'),
  );
  assert.match(route, /meta\.amount = Math\.round\(paidAmount\)/);
  assert.match(
    route,
    /if \(error\.code === "INVALID_AMOUNT"\) \{\s*res\.json\(\{ available: false, message: error\.message, code: error\.code \}\);\s*return;\s*\}/,
  );
  // 不擅自改成 400：既有呼叫端只看 available／message，HTTP 狀態維持 200。
  assert.doesNotMatch(route, /res\.status\(400\)/);
  assert.match(route, /error\.code === "RATE_LIMITED"[\s\S]{0,80}res\.status\(429\)/);
});
