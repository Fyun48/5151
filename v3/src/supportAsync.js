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
import { sortSupportTiers } from "./supportDomain.js";
// SQLite 分支需要 handle：`support.js` 的函式是吃 `(db, ...)` 參數的（不像 db.js 用模組全域），
// 所以拿 `sqliteHandle()`——與 `listingGroupsAsync.js` 同一個既有模式，不必讓呼叫端多傳一個參數。
import { sqliteHandle } from "./db.js";
import {
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
