/** Support / Sponsorship 服務。不得被 listingScore / match / sortListingsRows 引用。 */

import { containsUnsafeMarkup, sanitizeDocumentText } from "./safeContent.js";
import { publicSponsorLinks, sanitizeHttpUrl } from "./sponsorLinks.js";
import {
  BILLING_CYCLES,
  COST_CATEGORIES,
  CTA_RULE_TYPES,
  DEFAULT_PAGE_COPY,
  DEFAULT_SEED_TIERS,
  DEFAULT_SUPPORT_FLAGS,
  DISMISS_DAY_OPTIONS,
  SPONSOR_STATUSES,
  SUPPORT_EVENT_KINDS,
  SUPPORT_PROVIDER_KINDS,
  TRANSACTION_STATUSES,
  conversionFunnel,
  ctaCooldownOpen,
  dashboardTotals,
  dismissUntilFromDays,
  emptyUsage,
  goalProgress,
  httpError,
  iso,
  mergeCtaState,
  moneyAmount,
  monthlyCostAmount,
  normalizeGoalDisplay,
  normalizePageCopy,
  normalizeSupportFlags,
  remapLegacy5151PageCopy,
  pickEligibleCtaRule,
  publicProviderView,
  resolveSponsorStatus,
  sanitizeUsage,
  sortSupportTiers,
  sponsorWindowActive,
  transactionDedupeKey,
} from "./supportDomain.js";
import { adminProviderView, getSupportPaymentProvider, resolveSupportCheckout, SupportPaymentUnavailable } from "./supportProviders.js";
import { ensureSupportSchema } from "./supportSchema.js";

export { ensureSupportSchema } from "./supportSchema.js";
export { SupportPaymentUnavailable } from "./supportProviders.js";

const CHECKOUT_LIMIT = 10;
const CHECKOUT_WINDOW_MS = 60 * 1000;
const checkoutHits = new Map();

export function resetSupportCheckoutRateLimit() {
  checkoutHits.clear();
}

export function assertSupportCheckoutAllowed(ip, now = Date.now()) {
  const key = `ip:${ip || "unknown"}`;
  const row = checkoutHits.get(key) || { n: 0, start: now };
  if (now - row.start >= CHECKOUT_WINDOW_MS) {
    row.n = 0;
    row.start = now;
  }
  row.n += 1;
  checkoutHits.set(key, row);
  if (row.n > CHECKOUT_LIMIT) {
    const wait = Math.max(1, Math.ceil((CHECKOUT_WINDOW_MS - (now - row.start)) / 1000));
    const err = httpError(`操作稍快，請 ${wait} 秒後再試`, 429, "RATE_LIMITED");
    throw err;
  }
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

/** 後台「贊助連結」的公開收款方式。Support domain 關閉時仍要列得出來，否則支持頁只剩一句「尚未開放」。 */
function publicSponsorWays(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sponsorLinks'").get();
    return publicSponsorLinks(parseJson(row?.value, {}));
  } catch {
    return [];
  }
}

function cleanText(value, max) {
  const text = sanitizeDocumentText(value, max);
  if (containsUnsafeMarkup(text)) {
    throw httpError("內容含有不安全標記");
  }
  return text;
}

function bool01(value, fallback = 0) {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return fallback;
}

function defaultDraft() {
  return {
    copy: { ...DEFAULT_PAGE_COPY },
    show_goal: true,
    show_cost: true,
    show_supporters: true,
    show_sponsors: true,
  };
}

function seedIfEmpty(db, now = new Date()) {
  const stamp = iso(now);
  const config = db.prepare("SELECT id FROM support_page_config WHERE id=1").get();
  if (!config) {
    const draft = defaultDraft();
    db.prepare(`
      INSERT INTO support_page_config(id, flags_json, draft_json, published_json, published_at, goal_amount, goal_label, goal_display, wall_enabled, updated_at)
      VALUES (1, ?, ?, ?, NULL, 0, '支持本站持續免費', 'exact', 0, ?)
    `).run(
      JSON.stringify(DEFAULT_SUPPORT_FLAGS),
      JSON.stringify(draft),
      JSON.stringify(draft),
      stamp,
    );
  }
  if (!db.prepare("SELECT id FROM support_tier LIMIT 1").get()) {
    const insert = db.prepare(`
      INSERT INTO support_tier(title, description, amount, currency, icon, sort_order, is_active, is_default, provider_product_id, created_at, updated_at)
      VALUES (?, ?, ?, 'TWD', ?, ?, 1, ?, NULL, ?, ?)
    `);
    for (const tier of DEFAULT_SEED_TIERS) {
      insert.run(tier.title, tier.description, tier.amount, tier.icon, tier.sort_order, tier.is_default, stamp, stamp);
    }
  }
  if (!db.prepare("SELECT id FROM support_provider LIMIT 1").get()) {
    db.prepare(`
      INSERT INTO support_provider(kind, display_name, page_url, widget_url, secret_ref, is_active, is_default, created_at, updated_at)
      VALUES ('buy_me_a_coffee', 'Buy Me a Coffee', '', '', '', 0, 1, ?, ?)
    `).run(stamp, stamp);
    db.prepare(`
      INSERT INTO support_provider(kind, display_name, page_url, widget_url, secret_ref, is_active, is_default, created_at, updated_at)
      VALUES ('external_url', '外部收款連結', '', '', '', 0, 0, ?, ?)
    `).run(stamp, stamp);
  }
  if (!db.prepare("SELECT id FROM support_cta_rule LIMIT 1").get()) {
    const insert = db.prepare(`
      INSERT INTO support_cta_rule(rule_type, threshold, message, cooldown_days, enabled, priority, created_at, updated_at)
      VALUES (?, ?, ?, 7, 0, ?, ?, ?)
    `);
    const seeds = [
      ["view_listing", 20, "今天已經幫你整理不少租屋資訊。如果本站真的幫你省下時間，可以請開發者喝杯咖啡。", 10],
      ["watch", 5, "你已經收藏了幾間在意的房子。支持完全自願，不會影響搜尋結果。", 20],
      ["search", 5, "你已經搜過幾次。本站維持免費，支持只是自願的一杯咖啡。", 30],
      ["commute", 3, "你用過距離計算。如果這些整理有幫上忙，可以自願支持本站。", 40],
      ["days_used", 3, "你已經使用本站幾天了。沒有支持也不會少任何功能。", 50],
      ["same_house_merge", 1, "你用過合併重複物件。如果這省下時間，可以自願支持網站維護。", 60],
    ];
    for (const [type, threshold, message, priority] of seeds) {
      insert.run(type, threshold, message, priority, stamp, stamp);
    }
  }
}

export function initSupportDomain(db, now = new Date()) {
  ensureSupportSchema(db);
  seedIfEmpty(db, now);
  remapStoredLegacyProductNames(db, now);
}

function remapStoredLegacyProductNames(db, now = new Date()) {
  const row = configRow(db);
  if (!row) return;
  const draft = parseJson(row.draft_json, defaultDraft());
  const published = parseJson(row.published_json, defaultDraft());
  const nextDraft = { ...draft, copy: remapLegacy5151PageCopy(draft.copy || {}) };
  const nextPublished = { ...published, copy: remapLegacy5151PageCopy(published.copy || {}) };
  if (JSON.stringify(nextDraft) === JSON.stringify(draft) && JSON.stringify(nextPublished) === JSON.stringify(published)) {
    return;
  }
  db.prepare(`
    UPDATE support_page_config
    SET draft_json=?, published_json=?, updated_at=?
    WHERE id=1
  `).run(JSON.stringify(nextDraft), JSON.stringify(nextPublished), iso(now));
}

function configRow(db) {
  return db.prepare("SELECT * FROM support_page_config WHERE id=1").get();
}

function readFlags(db) {
  const row = configRow(db);
  return normalizeSupportFlags(parseJson(row?.flags_json, DEFAULT_SUPPORT_FLAGS));
}

function readDraft(db) {
  const row = configRow(db);
  const draft = parseJson(row?.draft_json, defaultDraft());
  return {
    ...defaultDraft(),
    ...draft,
    copy: normalizePageCopy(draft.copy),
    show_goal: draft.show_goal !== false,
    show_cost: draft.show_cost !== false,
    show_supporters: draft.show_supporters !== false,
    show_sponsors: draft.show_sponsors !== false,
  };
}

function readPublished(db) {
  const row = configRow(db);
  const published = parseJson(row?.published_json, defaultDraft());
  return {
    ...defaultDraft(),
    ...published,
    copy: normalizePageCopy(published.copy),
    show_goal: published.show_goal !== false,
    show_cost: published.show_cost !== false,
    show_supporters: published.show_supporters !== false,
    show_sponsors: published.show_sponsors !== false,
  };
}

export function getSupportFlags(db) {
  return readFlags(db);
}

export function adminSupportConfig(db) {
  const row = configRow(db);
  return {
    flags: readFlags(db),
    draft: readDraft(db),
    published: readPublished(db),
    published_at: row?.published_at || "",
    goal_amount: moneyAmount(row?.goal_amount),
    goal_label: row?.goal_label || "",
    goal_display: normalizeGoalDisplay(row?.goal_display),
    wall_enabled: Number(row?.wall_enabled) === 1,
    updated_at: row?.updated_at || "",
  };
}

export function saveSupportConfig(db, partial = {}, now = new Date()) {
  const current = adminSupportConfig(db);
  const src = partial && typeof partial === "object" ? partial : {};
  const flags = normalizeSupportFlags({ ...current.flags, ...(src.flags || {}) });
  const draft = {
    ...current.draft,
    ...(src.draft || {}),
    copy: normalizePageCopy({ ...current.draft.copy, ...(src.draft?.copy || src.copy || {}) }),
    show_goal: src.draft?.show_goal ?? src.show_goal ?? current.draft.show_goal,
    show_cost: src.draft?.show_cost ?? src.show_cost ?? current.draft.show_cost,
    show_supporters: src.draft?.show_supporters ?? src.show_supporters ?? current.draft.show_supporters,
    show_sponsors: src.draft?.show_sponsors ?? src.show_sponsors ?? current.draft.show_sponsors,
  };
  const goalAmount = src.goal_amount != null ? moneyAmount(src.goal_amount) : current.goal_amount;
  const goalLabel = src.goal_label != null ? cleanText(src.goal_label, 80) : current.goal_label;
  const goalDisplay = src.goal_display != null ? normalizeGoalDisplay(src.goal_display) : current.goal_display;
  const wallEnabled = src.wall_enabled != null ? bool01(src.wall_enabled, 0) : current.wall_enabled ? 1 : 0;
  db.prepare(`
    UPDATE support_page_config
    SET flags_json=?, draft_json=?, goal_amount=?, goal_label=?, goal_display=?, wall_enabled=?, updated_at=?
    WHERE id=1
  `).run(JSON.stringify(flags), JSON.stringify(draft), goalAmount, goalLabel, goalDisplay, wallEnabled, iso(now));
  return adminSupportConfig(db);
}

export function publishSupportConfig(db, now = new Date()) {
  const current = adminSupportConfig(db);
  db.prepare(`
    UPDATE support_page_config
    SET published_json=?, published_at=?, updated_at=?
    WHERE id=1
  `).run(JSON.stringify(current.draft), iso(now), iso(now));
  return adminSupportConfig(db);
}

function costRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    amount: moneyAmount(row.amount),
    billing_cycle: row.billing_cycle,
    monthly_amount: monthlyCostAmount(row.amount, row.billing_cycle),
    start_date: row.start_date || "",
    end_date: row.end_date || "",
    is_public: Number(row.is_public) === 1,
    note: row.note || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function costActiveInMonth(row, monthStart, monthEnd) {
  const start = row.start_date || row.start_at || "";
  const end = row.end_date || row.end_at || "";
  if (start && start > monthEnd) return false;
  if (end && end < monthStart) return false;
  return true;
}

export function monthBounds(now = new Date()) {
  const d = new Date(now);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), startIso: start.toISOString(), endIso: end.toISOString() };
}

export function listSupportCosts(db) {
  return db.prepare("SELECT * FROM support_operating_cost ORDER BY id DESC").all().map(costRow);
}

export function publicMonthlyCosts(db, now = new Date()) {
  const { start, end } = monthBounds(now);
  return listSupportCosts(db)
    .filter((row) => row.is_public && costActiveInMonth(row, start, end))
    .map((row) => ({
      category: row.category,
      name: row.name,
      monthly_amount: row.monthly_amount,
    }));
}

export function monthlyOperatingTotal(db, now = new Date(), { publicOnly = false } = {}) {
  const { start, end } = monthBounds(now);
  return listSupportCosts(db)
    .filter((row) => (!publicOnly || row.is_public) && costActiveInMonth(row, start, end))
    .reduce((acc, row) => acc + row.monthly_amount, 0);
}

export function createSupportCost(db, body = {}, now = new Date()) {
  const category = COST_CATEGORIES.includes(body.category) ? body.category : "Other";
  const name = cleanText(body.name, 80);
  if (!name) throw httpError("請填成本名稱");
  const amount = moneyAmount(body.amount);
  const billing = BILLING_CYCLES.includes(body.billing_cycle) ? body.billing_cycle : "monthly";
  const stamp = iso(now);
  const result = db.prepare(`
    INSERT INTO support_operating_cost(category, name, amount, billing_cycle, start_date, end_date, is_public, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    category,
    name,
    amount,
    billing,
    cleanText(body.start_date, 20) || stamp.slice(0, 10),
    body.end_date ? cleanText(body.end_date, 20) : null,
    bool01(body.is_public, 0),
    cleanText(body.note, 240),
    stamp,
    stamp,
  );
  return costRow(db.prepare("SELECT * FROM support_operating_cost WHERE id=?").get(result.lastInsertRowid));
}

export function updateSupportCost(db, id, body = {}, now = new Date()) {
  const current = costRow(db.prepare("SELECT * FROM support_operating_cost WHERE id=?").get(id));
  if (!current) throw httpError("找不到這筆成本", 404);
  const next = {
    category: COST_CATEGORIES.includes(body.category) ? body.category : current.category,
    name: body.name != null ? cleanText(body.name, 80) : current.name,
    amount: body.amount != null ? moneyAmount(body.amount) : current.amount,
    billing_cycle: BILLING_CYCLES.includes(body.billing_cycle) ? body.billing_cycle : current.billing_cycle,
    start_date: body.start_date != null ? cleanText(body.start_date, 20) : current.start_date,
    end_date: body.end_date !== undefined ? (body.end_date ? cleanText(body.end_date, 20) : null) : current.end_date || null,
    is_public: body.is_public != null ? bool01(body.is_public, 0) : current.is_public ? 1 : 0,
    note: body.note != null ? cleanText(body.note, 240) : current.note,
  };
  db.prepare(`
    UPDATE support_operating_cost
    SET category=?, name=?, amount=?, billing_cycle=?, start_date=?, end_date=?, is_public=?, note=?, updated_at=?
    WHERE id=?
  `).run(next.category, next.name, next.amount, next.billing_cycle, next.start_date, next.end_date, next.is_public, next.note, iso(now), id);
  return costRow(db.prepare("SELECT * FROM support_operating_cost WHERE id=?").get(id));
}

function tierRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    amount: moneyAmount(row.amount),
    currency: row.currency || "TWD",
    icon: row.icon || "",
    sort_order: Number(row.sort_order) || 0,
    is_active: Number(row.is_active) === 1,
    is_default: Number(row.is_default) === 1,
    provider_product_id: row.provider_product_id || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listSupportTiers(db, { activeOnly = false } = {}) {
  const rows = db.prepare("SELECT * FROM support_tier ORDER BY sort_order ASC, id ASC").all().map(tierRow);
  return sortSupportTiers(activeOnly ? rows.filter((row) => row.is_active) : rows);
}

export function createSupportTier(db, body = {}, now = new Date()) {
  const title = cleanText(body.title, 40);
  if (!title) throw httpError("請填方案名稱");
  const stamp = iso(now);
  if (bool01(body.is_default, 0)) {
    db.prepare("UPDATE support_tier SET is_default=0").run();
  }
  const result = db.prepare(`
    INSERT INTO support_tier(title, description, amount, currency, icon, sort_order, is_active, is_default, provider_product_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    cleanText(body.description, 160),
    moneyAmount(body.amount),
    cleanText(body.currency || "TWD", 8) || "TWD",
    cleanText(body.icon, 16),
    Number(body.sort_order) || 0,
    bool01(body.is_active, 1),
    bool01(body.is_default, 0),
    body.provider_product_id ? cleanText(body.provider_product_id, 80) : null,
    stamp,
    stamp,
  );
  return tierRow(db.prepare("SELECT * FROM support_tier WHERE id=?").get(result.lastInsertRowid));
}

export function updateSupportTier(db, id, body = {}, now = new Date()) {
  const current = tierRow(db.prepare("SELECT * FROM support_tier WHERE id=?").get(id));
  if (!current) throw httpError("找不到支持方案", 404);
  if (body.is_default === true || body.is_default === 1) {
    db.prepare("UPDATE support_tier SET is_default=0").run();
  }
  db.prepare(`
    UPDATE support_tier
    SET title=?, description=?, amount=?, currency=?, icon=?, sort_order=?, is_active=?, is_default=?, provider_product_id=?, updated_at=?
    WHERE id=?
  `).run(
    body.title != null ? cleanText(body.title, 40) : current.title,
    body.description != null ? cleanText(body.description, 160) : current.description,
    body.amount != null ? moneyAmount(body.amount) : current.amount,
    body.currency != null ? cleanText(body.currency, 8) : current.currency,
    body.icon != null ? cleanText(body.icon, 16) : current.icon,
    body.sort_order != null ? Number(body.sort_order) || 0 : current.sort_order,
    body.is_active != null ? bool01(body.is_active, 1) : current.is_active ? 1 : 0,
    body.is_default != null ? bool01(body.is_default, 0) : current.is_default ? 1 : 0,
    body.provider_product_id !== undefined ? (body.provider_product_id ? cleanText(body.provider_product_id, 80) : null) : current.provider_product_id || null,
    iso(now),
    id,
  );
  return tierRow(db.prepare("SELECT * FROM support_tier WHERE id=?").get(id));
}

export function listSupportProviders(db) {
  return db.prepare("SELECT * FROM support_provider ORDER BY is_default DESC, id ASC").all().map(adminProviderView);
}

export function updateSupportProvider(db, id, body = {}, now = new Date()) {
  const current = db.prepare("SELECT * FROM support_provider WHERE id=?").get(id);
  if (!current) throw httpError("找不到收款設定", 404);
  if (!SUPPORT_PROVIDER_KINDS.includes(current.kind) && body.kind && !SUPPORT_PROVIDER_KINDS.includes(body.kind)) {
    throw httpError("未知的收款方式");
  }
  if (body.is_default === true || body.is_default === 1) {
    db.prepare("UPDATE support_provider SET is_default=0").run();
  }
  const pageUrl = body.page_url !== undefined ? sanitizeHttpUrl(body.page_url) : current.page_url;
  const widgetUrl = body.widget_url !== undefined ? sanitizeHttpUrl(body.widget_url) : current.widget_url;
  const secret = body.secret_ref !== undefined ? String(body.secret_ref || "") : current.secret_ref;
  db.prepare(`
    UPDATE support_provider
    SET display_name=?, page_url=?, widget_url=?, secret_ref=?, is_active=?, is_default=?, updated_at=?
    WHERE id=?
  `).run(
    body.display_name != null ? cleanText(body.display_name, 40) : current.display_name,
    pageUrl,
    widgetUrl,
    secret,
    body.is_active != null ? bool01(body.is_active, 0) : current.is_active,
    body.is_default != null ? bool01(body.is_default, 0) : current.is_default,
    iso(now),
    id,
  );
  return adminProviderView(db.prepare("SELECT * FROM support_provider WHERE id=?").get(id));
}

function activeCheckoutProvider(db) {
  return db.prepare("SELECT * FROM support_provider WHERE is_active=1 AND page_url!='' ORDER BY is_default DESC, id ASC LIMIT 1").get()
    || db.prepare("SELECT * FROM support_provider WHERE is_active=1 ORDER BY is_default DESC, id ASC LIMIT 1").get();
}

function txRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    provider_transaction_id: row.provider_transaction_id || "",
    supporter_user_id: row.supporter_user_id ?? null,
    supporter_name: row.supporter_name || "",
    supporter_email: row.supporter_email || "",
    amount: moneyAmount(row.amount),
    fee: moneyAmount(row.fee),
    net_amount: moneyAmount(row.net_amount),
    currency: row.currency || "TWD",
    status: row.status,
    anonymous: Number(row.anonymous) === 1,
    message: row.message || "",
    channel: row.channel || "personal",
    received_at: row.received_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicThanksRow(row) {
  if (!row || Number(row.anonymous) === 1) {
    return { name: "匿名支持者", amount: null, message: "" };
  }
  return {
    name: String(row.supporter_name || "支持者").slice(0, 40),
    amount: null,
    message: String(row.message || "").slice(0, 80),
  };
}

export function listSupportTransactions(db, { from, to } = {}) {
  let sql = "SELECT * FROM support_transaction WHERE 1=1";
  const params = [];
  if (from) {
    sql += " AND received_at>=?";
    params.push(from);
  }
  if (to) {
    sql += " AND received_at<=?";
    params.push(to);
  }
  sql += " ORDER BY received_at DESC, id DESC";
  return db.prepare(sql).all(...params).map(txRow);
}

export function createManualTransaction(db, body = {}, now = new Date()) {
  const amount = moneyAmount(body.amount);
  if (amount <= 0) throw httpError("請填支持金額");
  const fee = moneyAmount(body.fee);
  const provider = cleanText(body.provider || "buy_me_a_coffee", 40) || "buy_me_a_coffee";
  const providerTx = body.provider_transaction_id ? cleanText(body.provider_transaction_id, 80) : null;
  if (providerTx && transactionDedupeKey(provider, providerTx)) {
    const exists = db.prepare("SELECT id FROM support_transaction WHERE provider=? AND provider_transaction_id=?").get(provider, providerTx);
    if (exists) throw httpError("這筆支持紀錄已存在", 409, "DUPLICATE_TRANSACTION");
  }
  const stamp = iso(now);
  const received = body.received_at ? iso(body.received_at) : stamp;
  const result = db.prepare(`
    INSERT INTO support_transaction(
      provider, provider_transaction_id, supporter_user_id, supporter_name, supporter_email,
      amount, fee, net_amount, currency, status, anonymous, message, channel, received_at, raw_reference, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    provider,
    providerTx,
    body.supporter_user_id ? Number(body.supporter_user_id) : null,
    body.anonymous ? null : cleanText(body.supporter_name, 40) || null,
    null,
    amount,
    fee,
    moneyAmount(amount - fee),
    cleanText(body.currency || "TWD", 8) || "TWD",
    TRANSACTION_STATUSES.includes(body.status) ? body.status : "manual",
    bool01(body.anonymous ?? true, 1),
    body.message ? cleanText(body.message, 160) : null,
    body.channel === "corporate" ? "corporate" : "personal",
    received,
    body.raw_reference ? cleanText(JSON.stringify({ note: String(body.raw_reference).slice(0, 200) }), 400) : null,
    stamp,
    stamp,
  );
  return txRow(db.prepare("SELECT * FROM support_transaction WHERE id=?").get(result.lastInsertRowid));
}

export function updateSupportTransaction(db, id, body = {}, now = new Date()) {
  const current = txRow(db.prepare("SELECT * FROM support_transaction WHERE id=?").get(id));
  if (!current) throw httpError("找不到支持紀錄", 404);
  const status = body.status && TRANSACTION_STATUSES.includes(body.status) ? body.status : current.status;
  const amount = body.amount != null ? moneyAmount(body.amount) : current.amount;
  const fee = body.fee != null ? moneyAmount(body.fee) : current.fee;
  db.prepare(`
    UPDATE support_transaction
    SET status=?, amount=?, fee=?, net_amount=?, anonymous=?, message=?, updated_at=?
    WHERE id=?
  `).run(
    status,
    amount,
    fee,
    moneyAmount(amount - fee),
    body.anonymous != null ? bool01(body.anonymous, 1) : current.anonymous ? 1 : 0,
    body.message !== undefined ? (body.message ? cleanText(body.message, 160) : null) : current.message || null,
    iso(now),
    id,
  );
  return txRow(db.prepare("SELECT * FROM support_transaction WHERE id=?").get(id));
}

function sponsorRow(row, now = new Date()) {
  if (!row) return null;
  const resolved = resolveSponsorStatus(row, now);
  return {
    id: row.id,
    name: row.name,
    logo: row.logo || "",
    website_url: row.website_url || "",
    description: row.description || "",
    start_at: row.start_at || "",
    end_at: row.end_at || "",
    amount: row.amount == null ? null : moneyAmount(row.amount),
    show_amount: Number(row.show_amount) === 1,
    status: row.status,
    resolved_status: resolved,
    display_location: row.display_location || "support_page",
    sort_order: Number(row.sort_order) || 0,
    disclosure_text: row.disclosure_text || "贊助",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listSupportSponsors(db, now = new Date()) {
  return db.prepare("SELECT * FROM support_sponsor ORDER BY sort_order ASC, id DESC").all().map((row) => sponsorRow(row, now));
}

export function createSupportSponsor(db, body = {}, now = new Date()) {
  const name = cleanText(body.name, 60);
  if (!name) throw httpError("請填贊助商名稱");
  const stamp = iso(now);
  const result = db.prepare(`
    INSERT INTO support_sponsor(name, logo, website_url, description, start_at, end_at, amount, show_amount, status, display_location, sort_order, disclosure_text, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    body.logo ? sanitizeHttpUrl(body.logo) : "",
    body.website_url ? sanitizeHttpUrl(body.website_url) : "",
    cleanText(body.description, 200),
    body.start_at || null,
    body.end_at || null,
    body.amount == null || body.amount === "" ? null : moneyAmount(body.amount),
    bool01(body.show_amount, 0),
    SPONSOR_STATUSES.includes(body.status) ? body.status : "draft",
    cleanText(body.display_location || "support_page", 40) || "support_page",
    Number(body.sort_order) || 0,
    cleanText(body.disclosure_text || "贊助", 20) || "贊助",
    stamp,
    stamp,
  );
  return sponsorRow(db.prepare("SELECT * FROM support_sponsor WHERE id=?").get(result.lastInsertRowid), now);
}

export function updateSupportSponsor(db, id, body = {}, now = new Date()) {
  const current = sponsorRow(db.prepare("SELECT * FROM support_sponsor WHERE id=?").get(id), now);
  if (!current) throw httpError("找不到企業贊助", 404);
  db.prepare(`
    UPDATE support_sponsor
    SET name=?, logo=?, website_url=?, description=?, start_at=?, end_at=?, amount=?, show_amount=?, status=?, display_location=?, sort_order=?, disclosure_text=?, updated_at=?
    WHERE id=?
  `).run(
    body.name != null ? cleanText(body.name, 60) : current.name,
    body.logo !== undefined ? sanitizeHttpUrl(body.logo) : current.logo,
    body.website_url !== undefined ? sanitizeHttpUrl(body.website_url) : current.website_url,
    body.description != null ? cleanText(body.description, 200) : current.description,
    body.start_at !== undefined ? body.start_at || null : current.start_at || null,
    body.end_at !== undefined ? body.end_at || null : current.end_at || null,
    body.amount !== undefined ? (body.amount === "" || body.amount == null ? null : moneyAmount(body.amount)) : current.amount,
    body.show_amount != null ? bool01(body.show_amount, 0) : current.show_amount ? 1 : 0,
    body.status && SPONSOR_STATUSES.includes(body.status) ? body.status : current.status,
    body.display_location != null ? cleanText(body.display_location, 40) : current.display_location,
    body.sort_order != null ? Number(body.sort_order) || 0 : current.sort_order,
    body.disclosure_text != null ? cleanText(body.disclosure_text, 20) : current.disclosure_text,
    iso(now),
    id,
  );
  return sponsorRow(db.prepare("SELECT * FROM support_sponsor WHERE id=?").get(id), now);
}

export function publicActiveSponsors(db, now = new Date()) {
  return listSupportSponsors(db, now)
    .filter((row) => sponsorWindowActive({ ...row, status: row.status === "scheduled" ? resolveSponsorStatus(row, now) : row.status }, now) || resolveSponsorStatus(row, now) === "active")
    .filter((row) => resolveSponsorStatus(row, now) === "active")
    .map((row) => ({
      id: row.id,
      name: row.name,
      logo: row.logo,
      website_url: row.website_url,
      description: row.description,
      disclosure_text: row.disclosure_text || "贊助",
      display_location: row.display_location,
      amount: row.show_amount ? row.amount : null,
    }));
}

function ctaRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    rule_type: row.rule_type,
    threshold: Number(row.threshold) || 1,
    message: row.message,
    cooldown_days: Number(row.cooldown_days) || 7,
    enabled: Number(row.enabled) === 1,
    priority: Number(row.priority) || 100,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listCtaRules(db) {
  return db.prepare("SELECT * FROM support_cta_rule ORDER BY priority ASC, id ASC").all().map(ctaRow);
}

export function updateCtaRule(db, id, body = {}, now = new Date()) {
  const current = ctaRow(db.prepare("SELECT * FROM support_cta_rule WHERE id=?").get(id));
  if (!current) throw httpError("找不到顯示規則", 404);
  db.prepare(`
    UPDATE support_cta_rule
    SET rule_type=?, threshold=?, message=?, cooldown_days=?, enabled=?, priority=?, updated_at=?
    WHERE id=?
  `).run(
    body.rule_type && CTA_RULE_TYPES.includes(body.rule_type) ? body.rule_type : current.rule_type,
    body.threshold != null ? Math.max(1, Number(body.threshold) || 1) : current.threshold,
    body.message != null ? cleanText(body.message, 280) : current.message,
    body.cooldown_days != null ? Math.max(1, Number(body.cooldown_days) || 7) : current.cooldown_days,
    body.enabled != null ? bool01(body.enabled, 0) : current.enabled ? 1 : 0,
    body.priority != null ? Number(body.priority) || 100 : current.priority,
    iso(now),
    id,
  );
  return ctaRow(db.prepare("SELECT * FROM support_cta_rule WHERE id=?").get(id));
}

export function memberUsageFromFlags(db, userId) {
  const usage = emptyUsage();
  if (!userId) return usage;
  try {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN viewed=1 THEN 1 ELSE 0 END) AS views,
        SUM(CASE WHEN watched=1 THEN 1 ELSE 0 END) AS watches
      FROM user_listing_flags WHERE user_id=?
    `).get(userId);
    usage.views = Number(row?.views) || 0;
    usage.watches = Number(row?.watches) || 0;
  } catch {
    // 沒有個人旗標表時只用客戶端用量
  }
  return usage;
}

function readPromptState(db, userId) {
  if (!userId) return null;
  const row = db.prepare("SELECT * FROM support_prompt_state WHERE user_id=?").get(userId);
  if (!row) return null;
  return {
    lastShownAt: row.last_shown_at || "",
    dismissedUntil: row.dismissed_until || "",
    shownCount: Number(row.shown_count) || 0,
  };
}

function writePromptState(db, userId, state, now = new Date()) {
  if (!userId) return state;
  db.prepare(`
    INSERT INTO support_prompt_state(user_id, last_shown_at, dismissed_until, shown_count, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      last_shown_at=excluded.last_shown_at,
      dismissed_until=excluded.dismissed_until,
      shown_count=excluded.shown_count,
      updated_at=excluded.updated_at
  `).run(userId, state.lastShownAt || null, state.dismissedUntil || null, Number(state.shownCount) || 0, iso(now));
  return state;
}

export function evaluateSupportCta(db, {
  userId = null,
  usage = {},
  clientState = {},
  now = new Date(),
} = {}) {
  const flags = readFlags(db);
  if (!flags.enabled || !flags.cta_enabled) {
    return { show: false, reason: "disabled" };
  }
  const mergedUsage = sanitizeUsage({
    ...memberUsageFromFlags(db, userId),
    ...usage,
  });
  const state = mergeCtaState(readPromptState(db, userId), clientState, now);
  const rule = pickEligibleCtaRule(listCtaRules(db), mergedUsage, state, now);
  if (!rule) return { show: false, reason: "cooldown_or_threshold", state };
  return {
    show: true,
    ruleId: rule.id,
    message: rule.message,
    dismissDays: DISMISS_DAY_OPTIONS.slice(),
    cooldownDays: rule.cooldown_days,
    state,
  };
}

export function markSupportCtaShown(db, { userId = null, clientState = {}, now = new Date() } = {}) {
  const current = mergeCtaState(readPromptState(db, userId), clientState, now);
  const next = {
    ...current,
    lastShownAt: iso(now),
    shownCount: (Number(current.shownCount) || 0) + 1,
  };
  writePromptState(db, userId, next, now);
  return next;
}

export function handleSupportCtaRequest(db, {
  userId = null,
  usage = {},
  clientState = {},
  now = new Date(),
} = {}) {
  const result = evaluateSupportCta(db, { userId, usage, clientState, now });
  if (!result.show) return result;
  const state = markSupportCtaShown(db, { userId, clientState: result.state, now });
  recordSupportEvent(db, "support_cta_shown", {
    userId,
    meta: { ruleId: result.ruleId },
    now,
  });
  return { ...result, state };
}

export function dismissSupportCta(db, {
  userId = null,
  days = 7,
  clientState = {},
  now = new Date(),
} = {}) {
  const current = mergeCtaState(readPromptState(db, userId), clientState, now);
  const next = {
    ...current,
    dismissedUntil: dismissUntilFromDays(days, now),
  };
  writePromptState(db, userId, next, now);
  return next;
}

export function recordSupportEvent(db, kind, { userId = null, guestKey = "", meta = {}, now = new Date() } = {}) {
  if (!SUPPORT_EVENT_KINDS.includes(kind)) return { ok: false };
  const safe = {};
  if (meta && typeof meta === "object") {
    if (meta.ruleId) safe.ruleId = Number(meta.ruleId) || 0;
    if (meta.tierId) safe.tierId = Number(meta.tierId) || 0;
    if (meta.sponsorId) safe.sponsorId = Number(meta.sponsorId) || 0;
    if (meta.days) safe.days = Number(meta.days) || 0;
  }
  db.prepare(`
    INSERT INTO support_event(kind, user_id, guest_key, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(kind, userId, String(guestKey || "").slice(0, 80), JSON.stringify(safe), iso(now));
  return { ok: true };
}

function eventCounts(db, from, to) {
  const rows = db.prepare(`
    SELECT kind, COUNT(*) AS n
    FROM support_event
    WHERE created_at>=? AND created_at<=?
    GROUP BY kind
  `).all(from, to);
  const out = {};
  for (const row of rows) out[row.kind] = Number(row.n) || 0;
  return out;
}

function periodBounds(period, now = new Date(), custom = {}) {
  const ts = new Date(now).getTime();
  if (period === "7d") return { from: iso(new Date(ts - 7 * 86400000)), to: iso(now) };
  if (period === "30d") return { from: iso(new Date(ts - 30 * 86400000)), to: iso(now) };
  if (period === "last_month") {
    const d = new Date(now);
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0, 23, 59, 59, 999));
    return { from: start.toISOString(), to: end.toISOString() };
  }
  if (period === "custom" && custom.from && custom.to) {
    return { from: iso(custom.from), to: iso(custom.to) };
  }
  const month = monthBounds(now);
  return { from: month.startIso, to: month.endIso };
}

export function supportDashboard(db, { period = "month", from, to, now = new Date() } = {}) {
  const bounds = periodBounds(period, now, { from, to });
  const txs = listSupportTransactions(db, bounds);
  const totals = dashboardTotals(txs);
  const cost = monthlyOperatingTotal(db, now);
  const publicCost = monthlyOperatingTotal(db, now, { publicOnly: true });
  const goal = adminSupportConfig(db);
  const progress = goalProgress(totals.net || totals.gross, goal.goal_amount || cost);
  const counts = eventCounts(db, bounds.from, bounds.to);
  const webhookReady = false;
  return {
    period,
    from: bounds.from,
    to: bounds.to,
    totals,
    operating_cost: cost,
    public_operating_cost: publicCost,
    coverage: progress,
    goal: {
      amount: goal.goal_amount,
      label: goal.goal_label,
      display: goal.goal_display,
    },
    funnel: conversionFunnel({ ...counts, completed: totals.count }, webhookReady),
    recent: txs.slice(0, 12),
    daily: dailyBars(txs, bounds.from, bounds.to),
  };
}

function dailyBars(txs, from, to) {
  const start = new Date(from);
  const end = new Date(to);
  const days = [];
  for (let t = start.getTime(); t <= end.getTime() && days.length < 62; t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const sum = txs
      .filter((row) => String(row.received_at || "").slice(0, 10) === day && ["completed", "manual"].includes(row.status))
      .reduce((acc, row) => acc + moneyAmount(row.amount), 0);
    days.push({ date: day, amount: sum });
  }
  return days;
}

export function publicSupportThanks(db) {
  return db.prepare(`
    SELECT supporter_name, anonymous, message, amount, status
    FROM support_transaction
    WHERE status IN ('completed', 'manual')
    ORDER BY received_at DESC
    LIMIT 24
  `).all().map(publicThanksRow);
}

function publicPagePayload(db, page, flags, now = new Date()) {
  const config = adminSupportConfig(db);
  const totals = dashboardTotals(listSupportTransactions(db, periodBounds("month", now)));
  const cost = monthlyOperatingTotal(db, now, { publicOnly: true });
  const target = config.goal_amount || cost;
  const progress = goalProgress(totals.net || totals.gross, target);
  const provider = activeCheckoutProvider(db);
  return {
    enabled: flags.enabled,
    flags,
    copy: page.copy,
    free_statement: page.copy.free_statement,
    show_goal: page.show_goal && config.goal_display !== "hidden",
    show_cost: page.show_cost && flags.public_cost_enabled,
    show_supporters: page.show_supporters && config.wall_enabled,
    show_sponsors: page.show_sponsors && flags.sponsor_enabled,
    goal: {
      label: config.goal_label || "本月維運目標",
      display: config.goal_display,
      ...progress,
      cost,
    },
    costs: flags.public_cost_enabled && page.show_cost ? publicMonthlyCosts(db, now) : [],
    tiers: listSupportTiers(db, { activeOnly: true }).map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      amount: row.amount,
      currency: row.currency,
      icon: row.icon,
      is_default: row.is_default,
    })),
    provider: publicProviderView(provider),
    checkout_available: Boolean(provider && provider.page_url && Number(provider.is_active) === 1),
    fallback_message: "目前支持付款服務暫時無法使用，稍後再試即可。",
    sponsors: flags.sponsor_enabled && page.show_sponsors ? publicActiveSponsors(db, now) : [],
    thanks: config.wall_enabled && page.show_supporters ? publicSupportThanks(db) : [],
    // 後台「贊助連結」是公開資訊，與 Support domain 的旗標無關；方案卡之外也讓它並存，不寫死第三方 URL。
    sponsor_links: publicSponsorWays(db),
    entry: {
      show: flags.enabled,
      label: page.copy.cta_label || "支持本站",
      href: "/support.html",
    },
  };
}

export function publicSupportConfig(db, now = new Date()) {
  const flags = readFlags(db);
  if (!flags.enabled) {
    return {
      enabled: false,
      flags,
      entry: { show: false, label: "支持本站", href: "/support.html" },
      cta: { enabled: false },
      // Support domain 關閉 ≠ 沒有支持方式。後台填了「贊助連結」就把公開收款頁列出來，
      // 不要讓 /support.html 變成只有一句「尚未開放」的死路。
      sponsor_links: publicSponsorWays(db),
    };
  }
  return publicPagePayload(db, readPublished(db), flags, now);
}

export function previewSupportConfig(db, now = new Date()) {
  const flags = { ...readFlags(db), enabled: true };
  return publicPagePayload(db, readDraft(db), flags, now);
}

export async function createSupportCheckout(db, { tierId, amount } = {}) {
  const flags = readFlags(db);
  if (!flags.enabled) {
    return { available: false, message: "目前尚未開放支持。" };
  }
  const provider = activeCheckoutProvider(db);
  if (!provider) {
    return { available: false, message: "目前支持付款服務暫時無法使用，稍後再試即可。" };
  }
  let payAmount = moneyAmount(amount);
  if (tierId) {
    const tier = tierRow(db.prepare("SELECT * FROM support_tier WHERE id=?").get(tierId));
    if (!tier || !tier.is_active) throw httpError("找不到支持方案", 404);
    if (tier.amount > 0) payAmount = tier.amount;
  }
  try {
    const checkout = await resolveSupportCheckout(provider, { amount: payAmount });
    return { available: true, ...checkout };
  } catch (error) {
    if (error instanceof SupportPaymentUnavailable) {
      return { available: false, message: error.message };
    }
    throw error;
  }
}

export async function verifySupportWebhook(providerKind, payload, headers) {
  const adapter = getSupportPaymentProvider(providerKind);
  return adapter.verifyWebhook(payload, headers);
}

export function listSupportAuditHints() {
  return [
    "support.provider.update",
    "support.checkout_url.update",
    "support.tier.create",
    "support.tier.update",
    "support.cost.create",
    "support.cost.update",
    "support.transaction.manual",
    "support.transaction.update",
    "support.transaction.refund",
    "support.sponsor.create",
    "support.sponsor.update",
    "support.sponsor.publish",
    "support.cta.update",
    "support.page.publish",
  ];
}

export function supportCtaStillCooling(state, now = new Date(), days = 7) {
  return !ctaCooldownOpen(state, now, days);
}
