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
import {
  SupportPaymentUnavailable,
  adminProviderView,
  resolveSupportCheckout,
} from "./supportProviders.js";
import {
  BILLING_CYCLES,
  COST_CATEGORIES,
  CTA_RULE_TYPES,
  DEFAULT_SUPPORT_FLAGS,
  DISMISS_DAY_OPTIONS,
  SPONSOR_STATUSES,
  SUPPORT_EVENT_KINDS,
  SUPPORT_PROVIDER_KINDS,
  TRANSACTION_STATUSES,
  httpError,
  dashboardTotals,
  dismissUntilFromDays,
  emptyUsage,
  goalProgress,
  iso,
  mergeCtaState,
  moneyAmount,
  normalizeGoalDisplay,
  normalizePageCopy,
  normalizeSupportFlags,
  pickEligibleCtaRule,
  publicProviderView,
  resolveSponsorStatus,
  sanitizeUsage,
  sortSupportTiers,
  sponsorWindowActive,
  transactionDedupeKey,
} from "./supportDomain.js";
import { publicSponsorLinks, sanitizeHttpUrl } from "./sponsorLinks.js";
// SQLite 分支需要 handle：`support.js` 的函式是吃 `(db, ...)` 參數的（不像 db.js 用模組全域），
// 所以拿 `sqliteHandle()`——與 `listingGroupsAsync.js` 同一個既有模式，不必讓呼叫端多傳一個參數。
import { sqliteHandle } from "./db.js";
import {
  adminSupportConfig as adminSupportConfigSync,
  bool01,
  cleanText,
  defaultDraft,
  dismissSupportCta as dismissSupportCtaSync,
  evaluateSupportCta as evaluateSupportCtaSync,
  createManualTransaction as createManualTransactionSync,
  costActiveInMonth,
  createSupportCheckout as createSupportCheckoutSync,
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
  getSupportFlags as getSupportFlagsSync,
  monthBounds,
  handleSupportCtaRequest as handleSupportCtaRequestSync,
  markSupportCtaShown as markSupportCtaShownSync,
  listSupportTransactions as listSupportTransactionsSync,
  parseJson,
  periodBounds,
  previewSupportConfig as previewSupportConfigSync,
  publicSupportConfig as publicSupportConfigSync,
  publicThanksRow,
  publishSupportConfig as publishSupportConfigSync,
  recordSupportEvent as recordSupportEventSync,
  saveSupportConfig as saveSupportConfigSync,
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

const listSupportCostsPg = async (exec) => (await exec(COSTS_SQL, [])).map(costRow);

export async function listSupportCostsAsync(options = {}) {
  if (!isPg(options)) return listSupportCostsSync(sqliteHandle());
  return listSupportCostsPg(await pgExec(options));
}

const listSupportTiersPg = async (exec, { activeOnly = false } = {}) => {
  const rows = (await exec(TIERS_SQL, [])).map(tierRow);
  return sortSupportTiers(activeOnly ? rows.filter((row) => row.is_active) : rows);
};

export async function listSupportTiersAsync({ activeOnly = false } = {}, options = {}) {
  if (!isPg(options)) return listSupportTiersSync(sqliteHandle(), { activeOnly });
  return listSupportTiersPg(await pgExec(options), { activeOnly });
}

export async function listSupportProvidersAsync(options = {}) {
  if (!isPg(options)) return listSupportProvidersSync(sqliteHandle());
  const exec = await pgExec(options);
  return (await exec(PROVIDERS_SQL, [])).map(adminProviderView);
}

const listSupportSponsorsPg = async (exec, now) => (await exec(SPONSORS_SQL, [])).map((row) => sponsorRow(row, now));

export async function listSupportSponsorsAsync({ now = new Date() } = {}, options = {}) {
  if (!isPg(options)) return listSupportSponsorsSync(sqliteHandle(), now);
  return listSupportSponsorsPg(await pgExec(options), now);
}

// exec 版的 CTA 規則讀取：對外入口與 CTA 狀態機共用同一份（避免兩份漂移）。
const listCtaRulesPg = async (exec) => (await exec(CTA_RULES_SQL, [])).map(ctaRow);

export async function listCtaRulesAsync(options = {}) {
  if (!isPg(options)) return listCtaRulesSync(sqliteHandle());
  return listCtaRulesPg(await pgExec(options));
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

// ---------------------------------------------------------------------------
// 公開支持頁（publicPagePayload 那條鏈）
//
// `publicSupportConfig`／`previewSupportConfig` 都走 `publicPagePayload()`，而它會拉起
// `adminSupportConfig`（已完成）、`dashboardTotals`、`listSupportTransactions`（已完成）、
// `monthlyOperatingTotal`、`publicMonthlyCosts`、`activeCheckoutProvider`、
// `listSupportTiers`（已完成）、`publicActiveSponsors`、`publicSupportThanks`、`publicSponsorWays`。
// 這裡把「會碰 DB 的」都補上；純彙總（`dashboardTotals`／`goalProgress`／`publicProviderView`／
// `sponsorWindowActive`／`publicSponsorLinks`）照樣留在原模組共用。
//
// `publicSponsorWays` 讀的是**單一 settings 鍵**（`sponsorLinks`），與 support 網域是否開啟無關
// ——後台填了贊助連結就要讓公開頁看得到，不要變成死路。
const SPONSOR_LINKS_SETTING_SQL = "SELECT value FROM settings WHERE key = 'sponsorLinks'";
const PUBLIC_THANKS_SQL = `SELECT supporter_name, anonymous, message, amount, status
     FROM support_transaction
     WHERE status IN ('completed', 'manual')
     ORDER BY received_at DESC
     LIMIT 24`;

const publicSponsorWaysAsync = async (exec) => {
  try {
    const row = (await exec(SPONSOR_LINKS_SETTING_SQL, []))[0];
    return publicSponsorLinks(parseJson(row?.value, {}));
  } catch {
    return [];
  }
};

const monthlyOperatingTotalAsync = async (exec, now, { publicOnly = false } = {}) => {
  const { start, end } = monthBounds(now);
  return (await listSupportCostsPg(exec))
    .filter((row) => (!publicOnly || row.is_public) && costActiveInMonth(row, start, end))
    .reduce((acc, row) => acc + row.monthly_amount, 0);
};

const publicMonthlyCostsAsync = async (exec, now) => {
  const { start, end } = monthBounds(now);
  return (await listSupportCostsPg(exec))
    .filter((row) => row.is_public && costActiveInMonth(row, start, end))
    .map((row) => ({ category: row.category, name: row.name, monthly_amount: row.monthly_amount }));
};

const activeCheckoutProviderAsync = async (exec) =>
  (await exec(CHECKOUT_PROVIDER_WITH_URL_SQL, []))[0] || (await exec(CHECKOUT_PROVIDER_ANY_SQL, []))[0];

const publicActiveSponsorsAsync = async (exec, now) =>
  (await listSupportSponsorsPg(exec, now))
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

const publicSupportThanksAsync = async (exec) =>
  (await exec(PUBLIC_THANKS_SQL, [])).map(publicThanksRow);

// `publicPagePayload()` 的 PG 分支。逐條對應同步版，順序與條件都照抄。
const publicPagePayloadAsync = async (exec, page, flags, now) => {
  const config = await adminSupportConfigAsync({ driver: "postgres", exec });
  const totals = dashboardTotals((await listSupportTransactionsPg(exec, periodBounds("month", now))));
  const cost = await monthlyOperatingTotalAsync(exec, now, { publicOnly: true });
  const target = config.goal_amount || cost;
  const progress = goalProgress(totals.net || totals.gross, target);
  const provider = await activeCheckoutProviderAsync(exec);
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
    costs: flags.public_cost_enabled && page.show_cost ? await publicMonthlyCostsAsync(exec, now) : [],
    tiers: (await listSupportTiersPg(exec, { activeOnly: true })).map((row) => ({
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
    sponsors: flags.sponsor_enabled && page.show_sponsors ? await publicActiveSponsorsAsync(exec, now) : [],
    thanks: config.wall_enabled && page.show_supporters ? await publicSupportThanksAsync(exec) : [],
    sponsor_links: await publicSponsorWaysAsync(exec),
    entry: {
      show: flags.enabled,
      label: page.copy.cta_label || "支持本站",
      href: "/support.html",
    },
  };
};

export async function publicSupportConfigAsync({ now = new Date(), ...options } = {}) {
  if (!isPg(options)) return publicSupportConfigSync(sqliteHandle(), now);
  const exec = await pgExec(options);
  const flags = await readFlagsAsync(exec);
  if (!flags.enabled) {
    return {
      enabled: false,
      flags,
      entry: { show: false, label: "支持本站", href: "/support.html" },
      cta: { enabled: false },
      sponsor_links: await publicSponsorWaysAsync(exec),
    };
  }
  return publicPagePayloadAsync(exec, await readPublishedAsync(exec), flags, now);
}

export async function previewSupportConfigAsync({ now = new Date(), ...options } = {}) {
  if (!isPg(options)) return previewSupportConfigSync(sqliteHandle(), now);
  const exec = await pgExec(options);
  const flags = { ...(await readFlagsAsync(exec)), enabled: true };
  return publicPagePayloadAsync(exec, await readDraftAsync(exec), flags, now);
}

// ---------------------------------------------------------------------------
// CTA 狀態機（support_prompt_state）＋ 結帳
//
// 這群是「同步函式互相呼叫」的典型：`handleSupportCtaRequest` → `evaluateSupportCta`
// →（readFlags／memberUsageFromFlags／readPromptState／listCtaRules）→ `markSupportCtaShown`
// →（readPromptState／writePromptState）→ `recordSupportEvent`。這裡照著同樣的順序逐一 await，
// 純判斷（mergeCtaState／pickEligibleCtaRule／sanitizeUsage／dismissUntilFromDays）留在原模組共用。
const PROMPT_STATE_SQL = "SELECT * FROM support_prompt_state WHERE user_id=?";
const UPSERT_PROMPT_STATE_SQL = `INSERT INTO support_prompt_state(user_id, last_shown_at, dismissed_until, shown_count, updated_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET
     last_shown_at=excluded.last_shown_at,
     dismissed_until=excluded.dismissed_until,
     shown_count=excluded.shown_count,
     updated_at=excluded.updated_at`;
const MEMBER_USAGE_SQL = `SELECT
       SUM(CASE WHEN viewed=1 THEN 1 ELSE 0 END) AS views,
       SUM(CASE WHEN watched=1 THEN 1 ELSE 0 END) AS watches
     FROM user_listing_flags WHERE user_id=?`;
// 與同步版逐字相同：**先挑有 page_url 的**，沒有才退而挑任何啟用的；排序都是 is_default DESC, id ASC。
const CHECKOUT_PROVIDER_WITH_URL_SQL =
  "SELECT * FROM support_provider WHERE is_active=1 AND page_url!='' ORDER BY is_default DESC, id ASC LIMIT 1";
const CHECKOUT_PROVIDER_ANY_SQL =
  "SELECT * FROM support_provider WHERE is_active=1 ORDER BY is_default DESC, id ASC LIMIT 1";

// 同步版把整段包在 try/catch（沒有個人旗標表時只用客戶端用量），這裡照抄。
async function memberUsageFromFlagsAsync(exec, userId) {
  const usage = emptyUsage();
  if (!userId) return usage;
  try {
    const row = (await exec(MEMBER_USAGE_SQL, [userId]))[0];
    usage.views = Number(row?.views) || 0;
    usage.watches = Number(row?.watches) || 0;
  } catch {
    // 沒有個人旗標表時只用客戶端用量
  }
  return usage;
}

const readPromptStateAsync = async (exec, userId) => {
  if (!userId) return null;
  const row = (await exec(PROMPT_STATE_SQL, [userId]))[0];
  if (!row) return null;
  return {
    lastShownAt: row.last_shown_at || "",
    dismissedUntil: row.dismissed_until || "",
    shownCount: Number(row.shown_count) || 0,
  };
};

const writePromptStateAsync = async (exec, userId, state, now = new Date()) => {
  if (!userId) return state;
  await exec(UPSERT_PROMPT_STATE_SQL, [
    userId,
    state.lastShownAt || null,
    state.dismissedUntil || null,
    Number(state.shownCount) || 0,
    iso(now),
  ]);
  return state;
};

export async function evaluateSupportCtaAsync({ userId = null, usage = {}, clientState = {}, now = new Date(), ...options } = {}) {
  if (!isPg(options)) return evaluateSupportCtaSync(sqliteHandle(), { userId, usage, clientState, now });
  const exec = await pgExec(options);
  const flags = await readFlagsAsync(exec);
  if (!flags.enabled || !flags.cta_enabled) {
    return { show: false, reason: "disabled" };
  }
  const mergedUsage = sanitizeUsage({
    ...(await memberUsageFromFlagsAsync(exec, userId)),
    ...usage,
  });
  const state = mergeCtaState(await readPromptStateAsync(exec, userId), clientState, now);
  const rule = pickEligibleCtaRule(await listCtaRulesPg(exec), mergedUsage, state, now);
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

export async function markSupportCtaShownAsync({ userId = null, clientState = {}, now = new Date(), ...options } = {}) {
  if (!isPg(options)) return markSupportCtaShownSync(sqliteHandle(), { userId, clientState, now });
  const exec = await pgExec(options);
  const current = mergeCtaState(await readPromptStateAsync(exec, userId), clientState, now);
  const next = {
    ...current,
    lastShownAt: iso(now),
    shownCount: (Number(current.shownCount) || 0) + 1,
  };
  await writePromptStateAsync(exec, userId, next, now);
  return next;
}

export async function handleSupportCtaRequestAsync({ userId = null, usage = {}, clientState = {}, now = new Date(), ...options } = {}) {
  if (!isPg(options)) return handleSupportCtaRequestSync(sqliteHandle(), { userId, usage, clientState, now });
  const result = await evaluateSupportCtaAsync({ userId, usage, clientState, now, ...options });
  if (!result.show) return result;
  const state = await markSupportCtaShownAsync({ userId, clientState: result.state, now, ...options });
  await recordSupportEventAsync("support_cta_shown", { userId, meta: { ruleId: result.ruleId }, now, ...options });
  return { ...result, state };
}

export async function dismissSupportCtaAsync({ userId = null, days = 7, clientState = {}, now = new Date(), ...options } = {}) {
  if (!isPg(options)) return dismissSupportCtaSync(sqliteHandle(), { userId, days, clientState, now });
  const exec = await pgExec(options);
  const current = mergeCtaState(await readPromptStateAsync(exec, userId), clientState, now);
  const next = { ...current, dismissedUntil: dismissUntilFromDays(days, now) };
  await writePromptStateAsync(exec, userId, next, now);
  return next;
}

export async function createSupportCheckoutAsync({ tierId, amount } = {}, options = {}) {
  if (!isPg(options)) return createSupportCheckoutSync(sqliteHandle(), { tierId, amount });
  const exec = await pgExec(options);
  const flags = await readFlagsAsync(exec);
  if (!flags.enabled) {
    return { available: false, message: "目前尚未開放支持。" };
  }
  const provider = (await exec(CHECKOUT_PROVIDER_WITH_URL_SQL, []))[0]
    || (await exec(CHECKOUT_PROVIDER_ANY_SQL, []))[0];
  if (!provider) {
    return { available: false, message: "目前支持付款服務暫時無法使用，稍後再試即可。" };
  }
  let payAmount = moneyAmount(amount);
  if (tierId) {
    const tier = tierRow((await exec(TIER_BY_ID_SQL, [Number(tierId) || 0]))[0]);
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

// ---------------------------------------------------------------------------
// 後台設定（support_page_config）＋ 事件記錄
//
// `adminSupportConfig()` 內部會呼叫 `configRow()` **四次**（自己一次 + readFlags／readDraft／
// readPublished 各一次），而且**每次都重新 SELECT**。這裡逐字照抄同樣的結構，
// 不做「查一次共用」的最佳化——那是行為等價但形狀不同的改寫，留給之後有意為之的人。
const CONFIG_ROW_SQL = "SELECT * FROM support_page_config WHERE id=1";
const UPDATE_CONFIG_SQL = `UPDATE support_page_config
   SET flags_json=?, draft_json=?, goal_amount=?, goal_label=?, goal_display=?, wall_enabled=?, updated_at=?
   WHERE id=1`;
const PUBLISH_CONFIG_SQL = `UPDATE support_page_config
   SET published_json=?, published_at=?, updated_at=?
   WHERE id=1`;
const INSERT_EVENT_SQL = `INSERT INTO support_event(kind, user_id, guest_key, meta_json, created_at)
   VALUES (?, ?, ?, ?, ?)`;

const configRowAsync = async (exec) => (await exec(CONFIG_ROW_SQL, []))[0];
const readFlagsAsync = async (exec) => {
  const row = await configRowAsync(exec);
  return normalizeSupportFlags(parseJson(row?.flags_json, DEFAULT_SUPPORT_FLAGS));
};
const readDraftAsync = async (exec) => {
  const row = await configRowAsync(exec);
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
};
const readPublishedAsync = async (exec) => {
  const row = await configRowAsync(exec);
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
};

export async function getSupportFlagsAsync(options = {}) {
  if (!isPg(options)) return getSupportFlagsSync(sqliteHandle());
  return readFlagsAsync(await pgExec(options));
}

export async function adminSupportConfigAsync(options = {}) {
  if (!isPg(options)) return adminSupportConfigSync(sqliteHandle());
  const exec = await pgExec(options);
  const row = await configRowAsync(exec);
  return {
    flags: await readFlagsAsync(exec),
    draft: await readDraftAsync(exec),
    published: await readPublishedAsync(exec),
    published_at: row?.published_at || "",
    goal_amount: moneyAmount(row?.goal_amount),
    goal_label: row?.goal_label || "",
    goal_display: normalizeGoalDisplay(row?.goal_display),
    wall_enabled: Number(row?.wall_enabled) === 1,
    updated_at: row?.updated_at || "",
  };
}

export async function saveSupportConfigAsync(partial = {}, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return saveSupportConfigSync(sqliteHandle(), partial, now);
  const exec = await pgExec(options);
  const current = await adminSupportConfigAsync({ ...options, exec });
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
  await exec(UPDATE_CONFIG_SQL, [
    JSON.stringify(flags), JSON.stringify(draft), goalAmount, goalLabel, goalDisplay, wallEnabled, iso(now),
  ]);
  return adminSupportConfigAsync({ ...options, exec });
}

export async function publishSupportConfigAsync({ now = new Date(), ...options } = {}) {
  if (!isPg(options)) return publishSupportConfigSync(sqliteHandle(), now);
  const exec = await pgExec(options);
  const current = await adminSupportConfigAsync({ ...options, exec });
  await exec(PUBLISH_CONFIG_SQL, [JSON.stringify(current.draft), iso(now), iso(now)]);
  return adminSupportConfigAsync({ ...options, exec });
}

// `recordSupportEvent()`：不在白名單的 kind 直接回 `{ok:false}`（同步版就是這樣，不是拋錯）。
export async function recordSupportEventAsync(kind, { userId = null, guestKey = "", meta = {}, now = new Date(), ...options } = {}) {
  if (!isPg(options)) return recordSupportEventSync(sqliteHandle(), kind, { userId, guestKey, meta, now });
  if (!SUPPORT_EVENT_KINDS.includes(kind)) return { ok: false };
  const exec = await pgExec(options);
  const safe = {};
  if (meta && typeof meta === "object") {
    if (meta.ruleId) safe.ruleId = Number(meta.ruleId) || 0;
    if (meta.tierId) safe.tierId = Number(meta.tierId) || 0;
    if (meta.sponsorId) safe.sponsorId = Number(meta.sponsorId) || 0;
    if (meta.days) safe.days = Number(meta.days) || 0;
  }
  await exec(INSERT_EVENT_SQL, [
    kind, userId, String(guestKey || "").slice(0, 80), JSON.stringify(safe), iso(now),
  ]);
  return { ok: true };
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
const listSupportTransactionsPg = async (exec, { from, to } = {}) => {
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
};

export async function listSupportTransactionsAsync({ from, to } = {}, options = {}) {
  if (!isPg(options)) return listSupportTransactionsSync(sqliteHandle(), { from, to });
  return listSupportTransactionsPg(await pgExec(options), { from, to });
}
