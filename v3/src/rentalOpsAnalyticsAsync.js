// Admin 營運分析（rental ops analytics）的 driver-aware 入口（PG 島嶼，2026-09-28）。
//
// 涵蓋的路由：
//   `GET /api/admin/rental-ops`       → `rentalOpsSummaryAsync`
//   `GET /api/admin/rental-ops/drill` → `rentalOpsDrilldownAsync`
//
// 這一支跟其他批次不一樣的地方：`rentalOpsSummary()` 是**一包 30 幾個查詢的彙總**
// （許願房存量、報價狀態、通知計數、成長指標、時間序列、中位數），所以做法是
//
//   1. 語句**只有一份**：`rentalOpsAnalytics.js` 的 `RENTAL_OPS_SQL`／`WISH_COUNT_SQL`／
//      `OFFER_STATUS_COUNT_SQL`，PG 版跑同一批字串（第三十九批的紀律：能共用就共用）。
//   2. 只有**中位數**那一句分成兩種方言，見下。
//   3. 錯誤碼沿用同一組（`analytics_metric_failed` 等），呼叫端看到的 `code` 不會隨 driver 改變。
//
// ⚠️ **`julianday()` 是 SQLite 專屬**。同步版的 `medianSecondsToAccept()` 用
// `(julianday(accepted_at) - julianday(created_at)) * 86400` 排序之後取中間那 1～2 列；
// PG 沒有 `julianday()`，要改成 `EXTRACT(EPOCH FROM (timestamptz - timestamptz))`。
// 刻意**不**把中位數搬到 JS 算：那一句的 LIMIT/OFFSET 是「母體中位數、不是最快 N 筆」的
// 保證（`median_definition` 就是這樣寫給 admin 看的），搬到 JS 就等於撈全量。
// ⚠️ 兩個時間欄位在 PG 上是 TEXT（SQLite 的 TEXT 鏡射過來），所以一定要明確轉型；
// 值一律是應用程式寫入的 ISO 字串，轉型不會失敗。
//
// ⚠️ 「查詢失敗要轉成哪一個錯誤碼」也是逐句照抄同步版：`sumMetric`／`timeseries`／
// `countWhere`／中位數各有自己的碼，admin 畫面靠它分辨是哪一類查詢壞掉。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { surveyAggregateAsync } from "./rentalSurveyAsync.js";
import {
  ANALYTICS_DRILL_MAX,
  DAY_END,
  DAY_START,
  OFFER_STATUS_COUNT_SQL,
  RENTAL_OPS_SQL,
  WISH_COUNT_SQL,
  analyticsQueryError,
  clampRange,
} from "./rentalOpsAnalytics.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

async function withFallback(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, {})) throw error;
    return runSqlite();
  }
}

const nested = (options, run) => ({ ...options, driver: "postgres", exec: run });

// ── 四個查詢助手：逐字對應同步版的 sumMetric／timeseries／countWhere／中位數 ──────────
async function countWhere(run, sql, params = []) {
  try {
    return Number(one((await run(sql, params)).rows)?.n) || 0;
  } catch (error) {
    throw analyticsQueryError(error, "analytics_count_failed");
  }
}

async function sumMetric(run, metric, from, to) {
  try {
    return Number(one((await run(RENTAL_OPS_SQL.sumMetric, [metric, from, to])).rows)?.n) || 0;
  } catch (error) {
    throw analyticsQueryError(error, "analytics_metric_failed");
  }
}

async function timeseries(run, metric, from, to) {
  try {
    return (await run(RENTAL_OPS_SQL.timeseries, [metric, from, to])).rows || [];
  } catch (error) {
    throw analyticsQueryError(error, "analytics_series_failed");
  }
}

async function medianSecondsToAccept(run, from, to) {
  const start = DAY_START(from);
  const end = DAY_END(to);
  let n = 0;
  try {
    n = Number(one((await run(RENTAL_OPS_SQL.medianCount, [start, end])).rows)?.n) || 0;
  } catch (error) {
    throw analyticsQueryError(error, "analytics_median_failed");
  }
  if (!n) return { median: null, n: 0 };
  const sql = RENTAL_OPS_SQL.medianOrderPg;
  try {
    if (n % 2 === 1) {
      const row = one((await run(sql, [start, end, 1, Math.floor((n - 1) / 2)])).rows);
      return { median: Math.round(Number(row?.secs) || 0), n };
    }
    const rows = (await run(sql, [start, end, 2, n / 2 - 1])).rows || [];
    const a = Number(rows[0]?.secs) || 0;
    const b = Number(rows[1]?.secs) || 0;
    return { median: Math.round((a + b) / 2), n };
  } catch (error) {
    throw analyticsQueryError(error, "analytics_median_failed");
  }
}

// `rentalOpsSummary()` 的 PG 版。形狀（含每個 `*_definition` 文案與**鍵的順序**）與同步版逐鍵相同。
// ⚠️ 這一段刻意寫成「同步版的轉錄」而不是把同步版的物件共用：同步版的字面值是**參考實作**，
// 兩邊由 parity 測試（整個 summary 深度比對）釘住——共用同一個字面值的話，
// 「兩邊一起寫錯」會變成看不到的漂移。
export async function rentalOpsSummaryAsync(rangeInput = {}, options = {}) {
  const { from, to } = rangeInput || {};
  const range = clampRange(from, to);
  return withFallback(options, async (run) => {
    const wish = {
      draft: await countWhere(run, WISH_COUNT_SQL.draft),
      active: await countWhere(run, WISH_COUNT_SQL.active),
      needs_confirmation: await countWhere(run, WISH_COUNT_SQL.needs_confirmation),
      paused: await countWhere(run, WISH_COUNT_SQL.paused),
      completed: await countWhere(run, WISH_COUNT_SQL.completed),
      expired: await countWhere(run, WISH_COUNT_SQL.expired),
      definition: "點值為目前狀態存量，不是期間流量。",
    };
    const offerCreated = await countWhere(run, RENTAL_OPS_SQL.offerCreatedInRange, [DAY_START(range.from), DAY_END(range.to)]);
    const offerAccepted = await countWhere(run, RENTAL_OPS_SQL.offerAcceptedInRange, [DAY_START(range.from), DAY_END(range.to)]);
    const offers = {
      created: offerCreated,
      pending: await countWhere(run, OFFER_STATUS_COUNT_SQL, ["pending"]),
      accepted: await countWhere(run, OFFER_STATUS_COUNT_SQL, ["accepted"]),
      declined: await countWhere(run, OFFER_STATUS_COUNT_SQL, ["declined"]),
      withdrawn: await countWhere(run, OFFER_STATUS_COUNT_SQL, ["withdrawn"]),
      expired: await countWhere(run, OFFER_STATUS_COUNT_SQL, ["expired"]),
      blocked: await countWhere(run, OFFER_STATUS_COUNT_SQL, ["blocked"]),
      reported: await countWhere(run, RENTAL_OPS_SQL.offerReportsInRange, [DAY_START(range.from), DAY_END(range.to)]),
      acceptance_rate: offerCreated ? Number((offerAccepted / offerCreated).toFixed(4)) : 0,
      acceptance_rate_definition: "期間 accepted_at / 期間 created。",
    };
    const notify = {
      generated: await sumMetric(run, "notify_generated", range.from, range.to),
      suppressed: await sumMetric(run, "notify_suppressed", range.from, range.to),
      deduped: await sumMetric(run, "notify_deduped", range.from, range.to),
      queued: await sumMetric(run, "notify_queued", range.from, range.to),
      delivered: await sumMetric(run, "notify_delivered", range.from, range.to),
      failed: await sumMetric(run, "notify_failed", range.from, range.to),
      retrying: await sumMetric(run, "notify_retrying", range.from, range.to),
      digest: await sumMetric(run, "digest_count", range.from, range.to),
    };
    const matching = {
      active_matchable_wishes: wish.active + wish.needs_confirmation,
      listings_with_subscription: await countWhere(run, RENTAL_OPS_SQL.subscriptionsActive),
      seen_match_pairs: await countWhere(run, RENTAL_OPS_SQL.seenMatchPairs),
      definition: "活躍可配對許願房為目前存量；訂閱數為目前開啟 instant/digest 的刊登。",
    };
    const median = await medianSecondsToAccept(run, range.from, range.to);
    offers.median_seconds_to_accept = median.median;
    offers.median_sample_size = median.n;
    offers.median_definition = "期間全部 accepted 的母體中位秒數（奇數取中間值，偶數取兩中間值平均），不是最快 200 筆。";
    const growth = {
      share_views: await sumMetric(run, "share_view", range.from, range.to),
      share_views_bot: await sumMetric(run, "share_view_bot", range.from, range.to),
      share_cta: await sumMetric(run, "share_cta", range.from, range.to),
      attributed_signup: await sumMetric(run, "share_signup", range.from, range.to),
      attributed_listing: await sumMetric(run, "share_listing", range.from, range.to),
      attributed_offer: await sumMetric(run, "share_offer", range.from, range.to),
      survey_submitted: await sumMetric(run, "survey_submitted", range.from, range.to),
      survey_skipped: await sumMetric(run, "survey_skipped", range.from, range.to),
      confirm_after_reminder: await sumMetric(run, "wish_confirmed", range.from, range.to),
      resume_after_pause: await sumMetric(run, "wish_resumed", range.from, range.to),
      survey_breakdown: await surveyAggregateAsync({ from: DAY_START(range.from), to: DAY_END(range.to) }, nested(options, run)),
    };
    wish.resumed = await sumMetric(run, "wish_resumed", range.from, range.to);
    wish.clone_or_restart = await sumMetric(run, "wish_cloned", range.from, range.to);
    wish.clone_definition = "期間新建許願房且該使用者已有 completed 紀錄的次數；不是 resume。completed 不可直接改回 active。";
    return {
      range,
      wish,
      matching,
      offers,
      notifications: notify,
      growth,
      series: {
        notify_generated: await timeseries(run, "notify_generated", range.from, range.to),
        share_view: await timeseries(run, "share_view", range.from, range.to),
      },
    };
  }, async () => (await import("./rentalOpsAnalytics.js")).rentalOpsSummary(sqliteHandle(), rangeInput));
}

// `rentalOpsDrilldown()` 的 PG 版。
export async function rentalOpsDrilldownAsync(input = {}, options = {}) {
  const { kind = "offers", cursor = 0, limit = 20, from, to } = input || {};
  const range = clampRange(from, to);
  const size = Math.min(ANALYTICS_DRILL_MAX, Math.max(1, Number(limit) || 20));
  const offset = Math.max(0, Number(cursor) || 0);
  return withFallback(options, async (run) => {
    if (kind === "surveys") {
      const rows = (await run(RENTAL_OPS_SQL.drillSurveys, [DAY_START(range.from), DAY_END(range.to), size + 1, offset])).rows || [];
      return {
        kind,
        items: rows.slice(0, size).map((row) => ({
          survey_ref: row.public_token,
          found_via_site: row.found_via_site,
          via_feature: row.via_feature,
          created_at: String(row.created_at || "").slice(0, 16),
        })),
        next_cursor: rows.length > size ? offset + size : "",
      };
    }
    let rows = [];
    try {
      rows = (await run(RENTAL_OPS_SQL.drillOffers, [DAY_START(range.from), DAY_END(range.to), size + 1, offset])).rows || [];
    } catch (error) {
      throw analyticsQueryError(error, "analytics_drill_failed");
    }
    return {
      kind: "offers",
      items: rows.slice(0, size).map((row) => ({
        offer_ref: row.public_token,
        status: row.status,
        created_at: String(row.created_at || "").slice(0, 16),
      })),
      next_cursor: rows.length > size ? offset + size : "",
    };
  }, async () => (await import("./rentalOpsAnalytics.js")).rentalOpsDrilldown(sqliteHandle(), input));
}
