// Support／贊助後台列表的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼挑這一批：把缺口路由分成「卡點全在 handler 內」「部分在深模組」「全在深模組」三類之後，
// `support.js` 的後台列表是最大的一群**全部卡在 handler 內**的（9 個函式、約 10 條路由）——
// 也就是可以直接改 handler 就完成的，不必先移植整個模組。
//
// 形狀與既有的島嶼一致：
//   - 純的列對應（`costRow`／`tierRow`／`sponsorRow`／`ctaRow`／`txRow`）**留在 `support.js`**，
//     由兩個 driver 共用；為此我把那五個函式加上 `export`（只加 export，行為不變）。
//     這樣就不會出現「PG 這份對應邏輯與同步版漂移」的問題。
//   - 排序用的 `sortSupportTiers` 與 `adminProviderView` 本來就從別的模組匯出，直接重用。
//   - 這裡只換「跑語句的人」。
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { adminProviderView } from "./supportProviders.js";
import {
  BILLING_CYCLES,
  COST_CATEGORIES,
  CTA_RULE_TYPES,
  SPONSOR_STATUSES,
  SUPPORT_PROVIDER_KINDS,
  TRANSACTION_STATUSES,
  httpError,
  iso,
  moneyAmount,
  sortSupportTiers,
  transactionDedupeKey,
} from "./supportDomain.js";
import { sanitizeHttpUrl } from "./sponsorLinks.js";
// SQLite 分支需要 handle：`support.js` 的函式是吃 `(db, ...)` 參數的（不像 db.js 用模組全域），
// 所以拿 `sqliteHandle()`——與 `listingGroupsAsync.js` 同一個既有模式，不必讓呼叫端多傳一個參數。
import { sqliteHandle } from "./db.js";
import {
  bool01,
  cleanText,
  createManualTransaction as createManualTransactionSync,
  createSupportCost as createSupportCostSync,
  createSupportSponsor as createSupportSponsorSync,
  createSupportTier as createSupportTierSync,
  ctaRow,
  costRow,
  listCtaRules as listCtaRulesSync,
  listSupportCosts as listSupportCostsSync,
  listSupportProviders as listSupportProvidersSync,
  listSupportSponsors as listSupportSponsorsSync,
  listSupportTiers as listSupportTiersSync,
  listSupportTransactions as listSupportTransactionsSync,
  sponsorRow,
  tierRow,
  txRow,
  updateCtaRule as updateCtaRuleSync,
  updateSupportCost as updateSupportCostSync,
  updateSupportProvider as updateSupportProviderSync,
  updateSupportSponsor as updateSupportSponsorSync,
  updateSupportTier as updateSupportTierSync,
  updateSupportTransaction as updateSupportTransactionSync,
} from "./support.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

const COSTS_SQL = "SELECT * FROM support_operating_cost ORDER BY id DESC";
const TIERS_SQL = "SELECT * FROM support_tier ORDER BY sort_order ASC, id ASC";
const PROVIDERS_SQL = "SELECT * FROM support_provider ORDER BY is_default DESC, id ASC";
const SPONSORS_SQL = "SELECT * FROM support_sponsor ORDER BY sort_order ASC, id DESC";
const CTA_RULES_SQL = "SELECT * FROM support_cta_rule ORDER BY priority ASC, id ASC";

export async function listSupportCostsAsync(options = {}) {
  if (!isPg(options)) return listSupportCostsSync(sqliteHandle());
  const exec = await pgExec(options);
  return (await exec(COSTS_SQL, [])).map(costRow);
}

export async function listSupportTiersAsync({ activeOnly = false } = {}, options = {}) {
  if (!isPg(options)) return listSupportTiersSync(sqliteHandle(), { activeOnly });
  const exec = await pgExec(options);
  const rows = (await exec(TIERS_SQL, [])).map(tierRow);
  return sortSupportTiers(activeOnly ? rows.filter((row) => row.is_active) : rows);
}

export async function listSupportProvidersAsync(options = {}) {
  if (!isPg(options)) return listSupportProvidersSync(sqliteHandle());
  const exec = await pgExec(options);
  return (await exec(PROVIDERS_SQL, [])).map(adminProviderView);
}

export async function listSupportSponsorsAsync({ now = new Date() } = {}, options = {}) {
  if (!isPg(options)) return listSupportSponsorsSync(sqliteHandle(), now);
  const exec = await pgExec(options);
  return (await exec(SPONSORS_SQL, [])).map((row) => sponsorRow(row, now));
}

export async function listCtaRulesAsync(options = {}) {
  if (!isPg(options)) return listCtaRulesSync(sqliteHandle());
  const exec = await pgExec(options);
  return (await exec(CTA_RULES_SQL, [])).map(ctaRow);
}

// ---------------------------------------------------------------------------
// 寫入（把「卡點全在 support.js」的那 21 條路由補完；本批先做 costs／tiers／providers）
//
// 每個都逐條對應同步版：取現值（沒有就 404）→ 算出 next → 寫入 → 回傳套過列對應的結果。
// 純的判斷（cleanText／moneyAmount／bool01／sanitizeHttpUrl）留在原模組共用，這裡只換「跑語句的人」。
// `is_default` 的**全表歸零**（`UPDATE support_tier SET is_default=0`）順序必須與同步版一致：
// 它发生在 INSERT／UPDATE **之前**，寫成之後會把剛設好的預設值又清掉。
const INSERT_COST_SQL = `INSERT INTO support_operating_cost(category, name, amount, billing_cycle, start_date, end_date, is_public, note, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_COST_SQL = `UPDATE support_operating_cost
   SET category=?, name=?, amount=?, billing_cycle=?, start_date=?, end_date=?, is_public=?, note=?, updated_at=?
   WHERE id=?`;
const INSERT_TIER_SQL = `INSERT INTO support_tier(title, description, amount, currency, icon, sort_order, is_active, is_default, provider_product_id, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_TIER_SQL = `UPDATE support_tier
   SET title=?, description=?, amount=?, currency=?, icon=?, sort_order=?, is_active=?, is_default=?, provider_product_id=?, updated_at=?
   WHERE id=?`;
const CLEAR_TIER_DEFAULT_SQL = "UPDATE support_tier SET is_default=0";
const UPDATE_PROVIDER_SQL = `UPDATE support_provider
   SET display_name=?, page_url=?, widget_url=?, secret_ref=?, is_active=?, is_default=?, updated_at=?
   WHERE id=?`;
const CLEAR_PROVIDER_DEFAULT_SQL = "UPDATE support_provider SET is_default=0";

// INSERT／UPDATE 之後要取回「那筆」——用 `SELECT *` 再套同一個純列對應，
// 與同步版 `costRow(db.prepare("SELECT * …").get(id))` 完全相同。
const COST_BY_ID_SQL = "SELECT * FROM support_operating_cost WHERE id=?";
// INSERT 之後要取回剛寫入的那一筆（同步版用 `lastInsertRowid`）。這裡用「id 最大的那一筆」，
// 語意相同且不依賴 RETURNING（注入式夾具與 PG 都吃得下）。
const COST_LAST_SQL = "SELECT * FROM support_operating_cost ORDER BY id DESC LIMIT 1";
const TIER_LAST_SQL = "SELECT * FROM support_tier ORDER BY id DESC LIMIT 1";
const TIER_BY_ID_SQL = "SELECT * FROM support_tier WHERE id=?";
const PROVIDER_BY_ID_SQL = "SELECT * FROM support_provider WHERE id=?";

export async function createSupportCostAsync(body = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return createSupportCostSync(sqliteHandle(), body, now);
  const exec = await pgExec(options);
  const src = body && typeof body === "object" ? body : {};
  const category = COST_CATEGORIES.includes(src.category) ? src.category : "Other";
  const name = cleanText(src.name, 80);
  if (!name) throw httpError("請填成本名稱");
  const stamp = iso(now);
  await exec(INSERT_COST_SQL, [
    category,
    name,
    moneyAmount(src.amount),
    BILLING_CYCLES.includes(src.billing_cycle) ? src.billing_cycle : "monthly",
    cleanText(src.start_date, 20) || stamp.slice(0, 10),
    src.end_date ? cleanText(src.end_date, 20) : null,
    bool01(src.is_public, 0),
    cleanText(src.note, 240),
    stamp,
    stamp,
  ]);
  return costRow((await exec(COST_LAST_SQL, []))[0]);
}

export async function updateSupportCostAsync(id, body = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return updateSupportCostSync(sqliteHandle(), id, body, now);
  const exec = await pgExec(options);
  const current = costRow((await exec(COST_BY_ID_SQL, [Number(id) || 0]))[0]);
  if (!current) throw httpError("找不到這筆成本", 404);
  const src = body && typeof body === "object" ? body : {};
  const next = {
    category: COST_CATEGORIES.includes(src.category) ? src.category : current.category,
    name: src.name != null ? cleanText(src.name, 80) : current.name,
    amount: src.amount != null ? moneyAmount(src.amount) : current.amount,
    billing_cycle: BILLING_CYCLES.includes(src.billing_cycle) ? src.billing_cycle : current.billing_cycle,
    start_date: src.start_date != null ? cleanText(src.start_date, 20) : current.start_date,
    end_date: src.end_date !== undefined ? (src.end_date ? cleanText(src.end_date, 20) : null) : current.end_date || null,
    is_public: src.is_public != null ? bool01(src.is_public, 0) : current.is_public ? 1 : 0,
    note: src.note != null ? cleanText(src.note, 240) : current.note,
  };
  await exec(UPDATE_COST_SQL, [
    next.category, next.name, next.amount, next.billing_cycle, next.start_date,
    next.end_date, next.is_public, next.note, iso(now), Number(id) || 0,
  ]);
  return costRow((await exec(COST_BY_ID_SQL, [Number(id) || 0]))[0]);
}

export async function createSupportTierAsync(body = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return createSupportTierSync(sqliteHandle(), body, now);
  const exec = await pgExec(options);
  const src = body && typeof body === "object" ? body : {};
  const title = cleanText(src.title, 40);
  if (!title) throw httpError("請填方案名稱");
  const stamp = iso(now);
  // 順序照抄同步版：先把其他方案的 is_default 清掉，再插入。
  if (bool01(src.is_default, 0)) await exec(CLEAR_TIER_DEFAULT_SQL, []);
  await exec(INSERT_TIER_SQL, [
    title,
    cleanText(src.description, 160),
    moneyAmount(src.amount),
    cleanText(src.currency || "TWD", 8) || "TWD",
    cleanText(src.icon, 16),
    Number(src.sort_order) || 0,
    bool01(src.is_active, 1),
    bool01(src.is_default, 0),
    // 逐字對應同步版：max 是 **80**，且 falsy 時寫 null（不是空字串）。
    src.provider_product_id ? cleanText(src.provider_product_id, 80) : null,
    stamp,
    stamp,
  ]);
  return tierRow((await exec(TIER_LAST_SQL, []))[0]);
}

export async function updateSupportTierAsync(id, body = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return updateSupportTierSync(sqliteHandle(), id, body, now);
  const exec = await pgExec(options);
  const current = tierRow((await exec(TIER_BY_ID_SQL, [Number(id) || 0]))[0]);
  if (!current) throw httpError("找不到支持方案", 404);
  const src = body && typeof body === "object" ? body : {};
  if (src.is_default === true || src.is_default === 1) await exec(CLEAR_TIER_DEFAULT_SQL, []);
  await exec(UPDATE_TIER_SQL, [
    src.title != null ? cleanText(src.title, 40) : current.title,
    src.description != null ? cleanText(src.description, 160) : current.description,
    src.amount != null ? moneyAmount(src.amount) : current.amount,
    src.currency != null ? cleanText(src.currency, 8) : current.currency,
    src.icon != null ? cleanText(src.icon, 16) : current.icon,
    src.sort_order != null ? Number(src.sort_order) || 0 : current.sort_order,
    src.is_active != null ? bool01(src.is_active, 1) : current.is_active ? 1 : 0,
    src.is_default != null ? bool01(src.is_default, 0) : current.is_default ? 1 : 0,
    src.provider_product_id !== undefined
      ? (src.provider_product_id ? cleanText(src.provider_product_id, 80) : null)
      : current.provider_product_id || null,
    iso(now),
    Number(id) || 0,
  ]);
  return tierRow((await exec(TIER_BY_ID_SQL, [Number(id) || 0]))[0]);
}

export async function updateSupportProviderAsync(id, body = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return updateSupportProviderSync(sqliteHandle(), id, body, now);
  const exec = await pgExec(options);
  const current = (await exec(PROVIDER_BY_ID_SQL, [Number(id) || 0]))[0];
  if (!current) throw httpError("找不到收款設定", 404);
  const src = body && typeof body === "object" ? body : {};
  if (!SUPPORT_PROVIDER_KINDS.includes(current.kind) && src.kind && !SUPPORT_PROVIDER_KINDS.includes(src.kind)) {
    throw httpError("未知的收款方式");
  }
  if (src.is_default === true || src.is_default === 1) await exec(CLEAR_PROVIDER_DEFAULT_SQL, []);
  const pageUrl = src.page_url !== undefined ? sanitizeHttpUrl(src.page_url) : current.page_url;
  const widgetUrl = src.widget_url !== undefined ? sanitizeHttpUrl(src.widget_url) : current.widget_url;
  const secret = src.secret_ref !== undefined ? String(src.secret_ref || "") : current.secret_ref;
  await exec(UPDATE_PROVIDER_SQL, [
    src.display_name != null ? cleanText(src.display_name, 60) : current.display_name,
    pageUrl,
    widgetUrl,
    secret,
    src.is_active != null ? bool01(src.is_active, 1) : current.is_active ? 1 : 0,
    src.is_default != null ? bool01(src.is_default, 0) : current.is_default ? 1 : 0,
    iso(now),
    Number(id) || 0,
  ]);
  return adminProviderView((await exec(PROVIDER_BY_ID_SQL, [Number(id) || 0]))[0]);
}

// ---- 贊助商／支持紀錄／CTA 規則的寫入（第二群）----
//
// 同樣逐條對應同步版。幾個容易漏的邊界，都在這裡照抄：
//   - sponsor 的 `logo`／`website_url` 是 `body.X ? sanitizeHttpUrl(X) : ""`（create）
//     與 `body.X !== undefined ? sanitizeHttpUrl(X) : current.X`（update）——**兩者不同**。
//   - sponsor 的 `amount`：`== null || === ""` 才寫 null（空字串不算 0）。
//   - CTA 規則的 `threshold`／`cooldown_days` 都有 `Math.max(1, … || 預設)` 的下限。
//   - 交易建立有**去重**：provider＋provider_transaction_id 已存在就 409。
const INSERT_SPONSOR_SQL = `INSERT INTO support_sponsor(name, logo, website_url, description, start_at, end_at, amount, show_amount, status, display_location, sort_order, disclosure_text, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_SPONSOR_SQL = `UPDATE support_sponsor
   SET name=?, logo=?, website_url=?, description=?, start_at=?, end_at=?, amount=?, show_amount=?, status=?, display_location=?, sort_order=?, disclosure_text=?, updated_at=?
   WHERE id=?`;
const SPONSOR_BY_ID_SQL = "SELECT * FROM support_sponsor WHERE id=?";
const SPONSOR_LAST_SQL = "SELECT * FROM support_sponsor ORDER BY id DESC LIMIT 1";

const INSERT_TX_SQL = `INSERT INTO support_transaction(
     provider, provider_transaction_id, supporter_user_id, supporter_name, supporter_email,
     amount, fee, net_amount, currency, status, anonymous, message, channel, received_at, raw_reference, created_at, updated_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPDATE_TX_SQL = `UPDATE support_transaction
   SET status=?, amount=?, fee=?, net_amount=?, anonymous=?, message=?, updated_at=?
   WHERE id=?`;
const TX_BY_ID_SQL = "SELECT * FROM support_transaction WHERE id=?";
const TX_LAST_SQL = "SELECT * FROM support_transaction ORDER BY id DESC LIMIT 1";
const TX_DUPLICATE_SQL =
  "SELECT id FROM support_transaction WHERE provider=? AND provider_transaction_id=?";

const UPDATE_CTA_RULE_SQL = `UPDATE support_cta_rule
   SET rule_type=?, threshold=?, message=?, cooldown_days=?, enabled=?, priority=?, updated_at=?
   WHERE id=?`;
const CTA_RULE_BY_ID_SQL = "SELECT * FROM support_cta_rule WHERE id=?";

export async function createSupportSponsorAsync(body = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return createSupportSponsorSync(sqliteHandle(), body, now);
  const exec = await pgExec(options);
  const src = body && typeof body === "object" ? body : {};
  const name = cleanText(src.name, 60);
  if (!name) throw httpError("請填贊助商名稱");
  const stamp = iso(now);
  await exec(INSERT_SPONSOR_SQL, [
    name,
    src.logo ? sanitizeHttpUrl(src.logo) : "",
    src.website_url ? sanitizeHttpUrl(src.website_url) : "",
    cleanText(src.description, 200),
    src.start_at || null,
    src.end_at || null,
    src.amount == null || src.amount === "" ? null : moneyAmount(src.amount),
    bool01(src.show_amount, 0),
    SPONSOR_STATUSES.includes(src.status) ? src.status : "draft",
    cleanText(src.display_location || "support_page", 40) || "support_page",
    Number(src.sort_order) || 0,
    cleanText(src.disclosure_text || "贊助", 20) || "贊助",
    stamp,
    stamp,
  ]);
  return sponsorRow((await exec(SPONSOR_LAST_SQL, []))[0], now);
}

export async function updateSupportSponsorAsync(id, body = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return updateSupportSponsorSync(sqliteHandle(), id, body, now);
  const exec = await pgExec(options);
  const current = sponsorRow((await exec(SPONSOR_BY_ID_SQL, [Number(id) || 0]))[0], now);
  if (!current) throw httpError("找不到企業贊助", 404);
  const src = body && typeof body === "object" ? body : {};
  await exec(UPDATE_SPONSOR_SQL, [
    src.name != null ? cleanText(src.name, 60) : current.name,
    src.logo !== undefined ? sanitizeHttpUrl(src.logo) : current.logo,
    src.website_url !== undefined ? sanitizeHttpUrl(src.website_url) : current.website_url,
    src.description != null ? cleanText(src.description, 200) : current.description,
    src.start_at !== undefined ? src.start_at || null : current.start_at || null,
    src.end_at !== undefined ? src.end_at || null : current.end_at || null,
    src.amount !== undefined ? (src.amount === "" || src.amount == null ? null : moneyAmount(src.amount)) : current.amount,
    src.show_amount != null ? bool01(src.show_amount, 0) : current.show_amount ? 1 : 0,
    src.status && SPONSOR_STATUSES.includes(src.status) ? src.status : current.status,
    src.display_location != null ? cleanText(src.display_location, 40) : current.display_location,
    src.sort_order != null ? Number(src.sort_order) || 0 : current.sort_order,
    src.disclosure_text != null ? cleanText(src.disclosure_text, 20) : current.disclosure_text,
    iso(now),
    Number(id) || 0,
  ]);
  return sponsorRow((await exec(SPONSOR_BY_ID_SQL, [Number(id) || 0]))[0], now);
}

export async function createManualTransactionAsync(body = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return createManualTransactionSync(sqliteHandle(), body, now);
  const exec = await pgExec(options);
  const src = body && typeof body === "object" ? body : {};
  const amount = moneyAmount(src.amount);
  if (amount <= 0) throw httpError("請填支持金額");
  const fee = moneyAmount(src.fee);
  const provider = cleanText(src.provider || "buy_me_a_coffee", 40) || "buy_me_a_coffee";
  const providerTx = src.provider_transaction_id ? cleanText(src.provider_transaction_id, 80) : null;
  if (providerTx && transactionDedupeKey(provider, providerTx)) {
    const exists = (await exec(TX_DUPLICATE_SQL, [provider, providerTx]))[0];
    if (exists) throw httpError("這筆支持紀錄已存在", 409, "DUPLICATE_TRANSACTION");
  }
  const stamp = iso(now);
  const received = src.received_at ? iso(src.received_at) : stamp;
  await exec(INSERT_TX_SQL, [
    provider,
    providerTx,
    src.supporter_user_id ? Number(src.supporter_user_id) : null,
    src.anonymous ? null : cleanText(src.supporter_name, 40) || null,
    null,
    amount,
    fee,
    moneyAmount(amount - fee),
    cleanText(src.currency || "TWD", 8) || "TWD",
    TRANSACTION_STATUSES.includes(src.status) ? src.status : "manual",
    bool01(src.anonymous ?? true, 1),
    src.message ? cleanText(src.message, 160) : null,
    src.channel === "corporate" ? "corporate" : "personal",
    received,
    src.raw_reference ? cleanText(JSON.stringify({ note: String(src.raw_reference).slice(0, 200) }), 400) : null,
    stamp,
    stamp,
  ]);
  return txRow((await exec(TX_LAST_SQL, []))[0]);
}

export async function updateSupportTransactionAsync(id, body = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return updateSupportTransactionSync(sqliteHandle(), id, body, now);
  const exec = await pgExec(options);
  const current = txRow((await exec(TX_BY_ID_SQL, [Number(id) || 0]))[0]);
  if (!current) throw httpError("找不到支持紀錄", 404);
  const src = body && typeof body === "object" ? body : {};
  const status = src.status && TRANSACTION_STATUSES.includes(src.status) ? src.status : current.status;
  const amount = src.amount != null ? moneyAmount(src.amount) : current.amount;
  const fee = src.fee != null ? moneyAmount(src.fee) : current.fee;
  await exec(UPDATE_TX_SQL, [
    status,
    amount,
    fee,
    moneyAmount(amount - fee),
    src.anonymous != null ? bool01(src.anonymous, 1) : current.anonymous ? 1 : 0,
    src.message !== undefined ? (src.message ? cleanText(src.message, 160) : null) : current.message || null,
    iso(now),
    Number(id) || 0,
  ]);
  return txRow((await exec(TX_BY_ID_SQL, [Number(id) || 0]))[0]);
}

export async function updateCtaRuleAsync(id, body = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return updateCtaRuleSync(sqliteHandle(), id, body, now);
  const exec = await pgExec(options);
  const current = ctaRow((await exec(CTA_RULE_BY_ID_SQL, [Number(id) || 0]))[0]);
  if (!current) throw httpError("找不到顯示規則", 404);
  const src = body && typeof body === "object" ? body : {};
  await exec(UPDATE_CTA_RULE_SQL, [
    src.rule_type && CTA_RULE_TYPES.includes(src.rule_type) ? src.rule_type : current.rule_type,
    src.threshold != null ? Math.max(1, Number(src.threshold) || 1) : current.threshold,
    src.message != null ? cleanText(src.message, 280) : current.message,
    src.cooldown_days != null ? Math.max(1, Number(src.cooldown_days) || 7) : current.cooldown_days,
    src.enabled != null ? bool01(src.enabled, 0) : current.enabled ? 1 : 0,
    src.priority != null ? Number(src.priority) || 100 : current.priority,
    iso(now),
    Number(id) || 0,
  ]);
  return ctaRow((await exec(CTA_RULE_BY_ID_SQL, [Number(id) || 0]))[0]);
}

// 逐字對應 db.js 版：`from`／`to` 是**選擇性**條件，順序與同步版相同
// （先 from 再 to，最後才是 ORDER BY）——參數順序寫錯會讓篩選悄悄失效。
export async function listSupportTransactionsAsync({ from, to } = {}, options = {}) {
  if (!isPg(options)) return listSupportTransactionsSync(sqliteHandle(), { from, to });
  const exec = await pgExec(options);
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
  return (await exec(sql, params)).map(txRow);
}
