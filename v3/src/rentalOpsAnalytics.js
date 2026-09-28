/** Admin 營運分析。bounded date range + daily pre-aggregate，不撈全量 raw events。 */

import { rentalNotifyHttpError } from "./rentalNotify.js";
import { surveyAggregate } from "./rentalSurvey.js";

export const ANALYTICS_MAX_DAYS = 93;
export const ANALYTICS_DRILL_MAX = 50;

// 匯出給 PG 版（`rentalOpsAnalyticsAsync.js`）逐字重用：區間驗證與錯誤碼不能有第二份實作。
export function clampRange(from, to) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw rentalNotifyHttpError("日期格式不正確", 400, "invalid_range");
  }
  if (end.getTime() - start.getTime() > ANALYTICS_MAX_DAYS * 86400000) {
    throw rentalNotifyHttpError("查詢區間過長", 400, "range_too_large");
  }
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

// 區間參數一律是「日」：起日取當天 00:00:00.000Z、迄日取 23:59:59.999Z。
export const DAY_START = (day) => `${day}T00:00:00.000Z`;
export const DAY_END = (day) => `${day}T23:59:59.999Z`;

export function analyticsQueryError(cause, code = "analytics_query_failed") {
  const err = rentalNotifyHttpError("營運分析查詢失敗", 500, code);
  if (cause) err.cause = cause;
  return err;
}

// 這一組語句是同步版與 PG 版**唯一**的來源：PG 版（`rentalOpsAnalyticsAsync.js`）
// 直接跑同一批字串，只有中位數那一句因為方言（`julianday` vs `EXTRACT`）分成兩種寫法。
// ⚠️ 抽出來時逐字照抄，不要「順手整理」——這裡每一句都對應 admin 畫面上的一個數字。
export const RENTAL_OPS_SQL = Object.freeze({
  sumMetric: "SELECT COALESCE(SUM(value), 0) AS n FROM rental_analytics_daily WHERE metric = ? AND day >= ? AND day <= ?",
  timeseries: "SELECT day, value FROM rental_analytics_daily WHERE metric = ? AND day >= ? AND day <= ? ORDER BY day ASC",
  medianCount: `SELECT COUNT(*) AS n FROM wish_offers
      WHERE accepted_at IS NOT NULL AND accepted_at >= ? AND accepted_at <= ?`,
  // SQLite：julianday() 直接算秒差。
  medianOrderSqlite: `SELECT (julianday(accepted_at) - julianday(created_at)) * 86400 AS secs
    FROM wish_offers
    WHERE accepted_at IS NOT NULL AND accepted_at >= ? AND accepted_at <= ?
    ORDER BY secs ASC, id ASC
    LIMIT ? OFFSET ?`,
  // PG：`julianday()` 不存在，用 `EXTRACT(EPOCH FROM (timestamptz - timestamptz))`。
  // 兩個欄位在 PG 上是 TEXT（SQLite 的 TEXT 鏡射過來），所以要明確轉型；
  // 值一律是應用程式寫入的 ISO 字串，轉型不會失敗。
  medianOrderPg: `SELECT (EXTRACT(EPOCH FROM (accepted_at::timestamptz - created_at::timestamptz))) AS secs
    FROM wish_offers
    WHERE accepted_at IS NOT NULL AND accepted_at >= ? AND accepted_at <= ?
    ORDER BY secs ASC, id ASC
    LIMIT ? OFFSET ?`,
  wishDraft: "SELECT COUNT(*) AS n FROM demand_posts WHERE COALESCE(lifecycle, '') = 'draft'",
  wishActive: "SELECT COUNT(*) AS n FROM demand_posts WHERE COALESCE(lifecycle, 'active') = 'active' AND status = 'open'",
  wishNeedsConfirmation: "SELECT COUNT(*) AS n FROM demand_posts WHERE lifecycle = 'needs_confirmation'",
  wishPaused: "SELECT COUNT(*) AS n FROM demand_posts WHERE lifecycle = 'paused'",
  wishCompleted: "SELECT COUNT(*) AS n FROM demand_posts WHERE lifecycle = 'completed'",
  wishExpired: "SELECT COUNT(*) AS n FROM demand_posts WHERE lifecycle = 'expired'",
  offerCreatedInRange: "SELECT COUNT(*) AS n FROM wish_offers WHERE created_at >= ? AND created_at <= ?",
  offerAcceptedInRange: "SELECT COUNT(*) AS n FROM wish_offers WHERE accepted_at >= ? AND accepted_at <= ?",
  offerReportsInRange: "SELECT COUNT(*) AS n FROM wish_offer_reports WHERE created_at >= ? AND created_at <= ?",
  subscriptionsActive: "SELECT COUNT(*) AS n FROM rental_match_subscriptions WHERE mode IN ('instant', 'daily_digest')",
  seenMatchPairs: "SELECT COUNT(*) AS n FROM rental_match_seen",
  drillSurveys: `SELECT public_token, found_via_site, via_feature, created_at
      FROM rental_completion_surveys
      WHERE created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  drillOffers: `SELECT public_token, status, created_at
      FROM wish_offers
      WHERE created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
});

// 許願房存量：`{ key: SQL }`，PG 版逐鍵跑同一組語句。
export const WISH_COUNT_SQL = Object.freeze({
  draft: RENTAL_OPS_SQL.wishDraft,
  active: RENTAL_OPS_SQL.wishActive,
  needs_confirmation: RENTAL_OPS_SQL.wishNeedsConfirmation,
  paused: RENTAL_OPS_SQL.wishPaused,
  completed: RENTAL_OPS_SQL.wishCompleted,
  expired: RENTAL_OPS_SQL.wishExpired,
});

// 報價狀態存量：PG 版逐個 status 跑同一句。
export const OFFER_STATUS_COUNT_SQL = "SELECT COUNT(*) AS n FROM wish_offers WHERE status = ?";

function sumMetric(db, metric, from, to) {
  try {
    return Number(db.prepare(RENTAL_OPS_SQL.sumMetric).get(metric, from, to)?.n) || 0;
  } catch (error) {
    throw analyticsQueryError(error, "analytics_metric_failed");
  }
}

function timeseries(db, metric, from, to) {
  try {
    return db.prepare(RENTAL_OPS_SQL.timeseries).all(metric, from, to);
  } catch (error) {
    throw analyticsQueryError(error, "analytics_series_failed");
  }
}

function countWhere(db, sql, params) {
  try {
    return Number(db.prepare(sql).get(...params)?.n) || 0;
  } catch (error) {
    throw analyticsQueryError(error, "analytics_count_failed");
  }
}

function medianSecondsToAccept(db, from, to) {
  const start = `${from}T00:00:00.000Z`;
  const end = `${to}T23:59:59.999Z`;
  let n = 0;
  try {
    n = Number(db.prepare(RENTAL_OPS_SQL.medianCount).get(start, end)?.n) || 0;
  } catch (error) {
    throw analyticsQueryError(error, "analytics_median_failed");
  }
  if (!n) return { median: null, n: 0 };
  const sql = RENTAL_OPS_SQL.medianOrderSqlite;
  try {
    if (n % 2 === 1) {
      const row = db.prepare(sql).get(start, end, 1, Math.floor((n - 1) / 2));
      return { median: Math.round(Number(row?.secs) || 0), n };
    }
    const rows = db.prepare(sql).all(start, end, 2, n / 2 - 1);
    const a = Number(rows[0]?.secs) || 0;
    const b = Number(rows[1]?.secs) || 0;
    return { median: Math.round((a + b) / 2), n };
  } catch (error) {
    throw analyticsQueryError(error, "analytics_median_failed");
  }
}

export function rentalOpsSummary(db, { from, to } = {}) {
  const range = clampRange(from, to);
  const wish = {
    draft: countWhere(db, WISH_COUNT_SQL.draft, []),
    active: countWhere(db, WISH_COUNT_SQL.active, []),
    needs_confirmation: countWhere(db, WISH_COUNT_SQL.needs_confirmation, []),
    paused: countWhere(db, WISH_COUNT_SQL.paused, []),
    completed: countWhere(db, WISH_COUNT_SQL.completed, []),
    expired: countWhere(db, WISH_COUNT_SQL.expired, []),
    definition: "點值為目前狀態存量，不是期間流量。",
  };
  const offerCreated = countWhere(db, RENTAL_OPS_SQL.offerCreatedInRange, [DAY_START(range.from), DAY_END(range.to)]);
  const offerAccepted = countWhere(db, RENTAL_OPS_SQL.offerAcceptedInRange, [DAY_START(range.from), DAY_END(range.to)]);
  const offers = {
    created: offerCreated,
    pending: countWhere(db, OFFER_STATUS_COUNT_SQL, ["pending"]),
    accepted: countWhere(db, OFFER_STATUS_COUNT_SQL, ["accepted"]),
    declined: countWhere(db, OFFER_STATUS_COUNT_SQL, ["declined"]),
    withdrawn: countWhere(db, OFFER_STATUS_COUNT_SQL, ["withdrawn"]),
    expired: countWhere(db, OFFER_STATUS_COUNT_SQL, ["expired"]),
    blocked: countWhere(db, OFFER_STATUS_COUNT_SQL, ["blocked"]),
    reported: countWhere(db, RENTAL_OPS_SQL.offerReportsInRange, [DAY_START(range.from), DAY_END(range.to)]),
    acceptance_rate: offerCreated ? Number((offerAccepted / offerCreated).toFixed(4)) : 0,
    acceptance_rate_definition: "期間 accepted_at / 期間 created。",
  };
  const notify = {
    generated: sumMetric(db, "notify_generated", range.from, range.to),
    suppressed: sumMetric(db, "notify_suppressed", range.from, range.to),
    deduped: sumMetric(db, "notify_deduped", range.from, range.to),
    queued: sumMetric(db, "notify_queued", range.from, range.to),
    delivered: sumMetric(db, "notify_delivered", range.from, range.to),
    failed: sumMetric(db, "notify_failed", range.from, range.to),
    retrying: sumMetric(db, "notify_retrying", range.from, range.to),
    digest: sumMetric(db, "digest_count", range.from, range.to),
  };
  const matching = {
    active_matchable_wishes: wish.active + wish.needs_confirmation,
    listings_with_subscription: countWhere(db, RENTAL_OPS_SQL.subscriptionsActive, []),
    seen_match_pairs: countWhere(db, RENTAL_OPS_SQL.seenMatchPairs, []),
    definition: "活躍可配對許願房為目前存量；訂閱數為目前開啟 instant/digest 的刊登。",
  };
  const median = medianSecondsToAccept(db, range.from, range.to);
  offers.median_seconds_to_accept = median.median;
  offers.median_sample_size = median.n;
  offers.median_definition = "期間全部 accepted 的母體中位秒數（奇數取中間值，偶數取兩中間值平均），不是最快 200 筆。";
  const growth = {
    share_views: sumMetric(db, "share_view", range.from, range.to),
    share_views_bot: sumMetric(db, "share_view_bot", range.from, range.to),
    share_cta: sumMetric(db, "share_cta", range.from, range.to),
    attributed_signup: sumMetric(db, "share_signup", range.from, range.to),
    attributed_listing: sumMetric(db, "share_listing", range.from, range.to),
    attributed_offer: sumMetric(db, "share_offer", range.from, range.to),
    survey_submitted: sumMetric(db, "survey_submitted", range.from, range.to),
    survey_skipped: sumMetric(db, "survey_skipped", range.from, range.to),
    confirm_after_reminder: sumMetric(db, "wish_confirmed", range.from, range.to),
    resume_after_pause: sumMetric(db, "wish_resumed", range.from, range.to),
    survey_breakdown: surveyAggregate(db, { from: DAY_START(range.from), to: DAY_END(range.to) }),
  };
  wish.resumed = sumMetric(db, "wish_resumed", range.from, range.to);
  wish.clone_or_restart = sumMetric(db, "wish_cloned", range.from, range.to);
  wish.clone_definition = "期間新建許願房且該使用者已有 completed 紀錄的次數；不是 resume。completed 不可直接改回 active。";
  return {
    range,
    wish,
    matching,
    offers,
    notifications: notify,
    growth,
    series: {
      notify_generated: timeseries(db, "notify_generated", range.from, range.to),
      share_view: timeseries(db, "share_view", range.from, range.to),
    },
  };
}

export function rentalOpsDrilldown(db, { kind = "offers", cursor = 0, limit = 20, from, to } = {}) {
  const range = clampRange(from, to);
  const size = Math.min(ANALYTICS_DRILL_MAX, Math.max(1, Number(limit) || 20));
  const offset = Math.max(0, Number(cursor) || 0);
  if (kind === "surveys") {
    const rows = db.prepare(RENTAL_OPS_SQL.drillSurveys).all(DAY_START(range.from), DAY_END(range.to), size + 1, offset);
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
    rows = db.prepare(RENTAL_OPS_SQL.drillOffers).all(DAY_START(range.from), DAY_END(range.to), size + 1, offset);
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
}
