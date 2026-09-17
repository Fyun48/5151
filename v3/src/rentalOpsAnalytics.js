/** Admin 營運分析。bounded date range + daily pre-aggregate，不撈全量 raw events。 */

import { rentalNotifyHttpError } from "./rentalNotify.js";
import { surveyAggregate } from "./rentalSurvey.js";

export const ANALYTICS_MAX_DAYS = 93;
export const ANALYTICS_DRILL_MAX = 50;

function clampRange(from, to) {
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

function sumMetric(db, metric, from, to) {
  return Number(db.prepare(
    "SELECT COALESCE(SUM(value), 0) AS n FROM rental_analytics_daily WHERE metric = ? AND day >= ? AND day <= ?",
  ).get(metric, from, to)?.n) || 0;
}

function timeseries(db, metric, from, to) {
  return db.prepare(
    "SELECT day, value FROM rental_analytics_daily WHERE metric = ? AND day >= ? AND day <= ? ORDER BY day ASC",
  ).all(metric, from, to);
}

function countWhere(db, sql, params) {
  return Number(db.prepare(sql).get(...params)?.n) || 0;
}

export function rentalOpsSummary(db, { from, to } = {}) {
  const range = clampRange(from, to);
  const wish = {
    draft: countWhere(db, "SELECT COUNT(*) AS n FROM demand_posts WHERE COALESCE(lifecycle, '') = 'draft'", []),
    active: countWhere(db, "SELECT COUNT(*) AS n FROM demand_posts WHERE COALESCE(lifecycle, 'active') = 'active' AND status = 'open'", []),
    needs_confirmation: countWhere(db, "SELECT COUNT(*) AS n FROM demand_posts WHERE lifecycle = 'needs_confirmation'", []),
    paused: countWhere(db, "SELECT COUNT(*) AS n FROM demand_posts WHERE lifecycle = 'paused'", []),
    completed: countWhere(db, "SELECT COUNT(*) AS n FROM demand_posts WHERE lifecycle = 'completed'", []),
    expired: countWhere(db, "SELECT COUNT(*) AS n FROM demand_posts WHERE lifecycle = 'expired'", []),
    definition: "點值為目前狀態存量，不是期間流量。",
  };
  const offerCreated = countWhere(db, "SELECT COUNT(*) AS n FROM wish_offers WHERE created_at >= ? AND created_at <= ?", [`${range.from}T00:00:00.000Z`, `${range.to}T23:59:59.999Z`]);
  const offerAccepted = countWhere(db, "SELECT COUNT(*) AS n FROM wish_offers WHERE accepted_at >= ? AND accepted_at <= ?", [`${range.from}T00:00:00.000Z`, `${range.to}T23:59:59.999Z`]);
  const offers = {
    created: offerCreated,
    pending: countWhere(db, "SELECT COUNT(*) AS n FROM wish_offers WHERE status = 'pending'", []),
    accepted: countWhere(db, "SELECT COUNT(*) AS n FROM wish_offers WHERE status = 'accepted'", []),
    declined: countWhere(db, "SELECT COUNT(*) AS n FROM wish_offers WHERE status = 'declined'", []),
    withdrawn: countWhere(db, "SELECT COUNT(*) AS n FROM wish_offers WHERE status = 'withdrawn'", []),
    expired: countWhere(db, "SELECT COUNT(*) AS n FROM wish_offers WHERE status = 'expired'", []),
    blocked: countWhere(db, "SELECT COUNT(*) AS n FROM wish_offers WHERE status = 'blocked'", []),
    reported: countWhere(db, "SELECT COUNT(*) AS n FROM wish_offer_reports WHERE created_at >= ? AND created_at <= ?", [`${range.from}T00:00:00.000Z`, `${range.to}T23:59:59.999Z`]),
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
    listings_with_subscription: countWhere(db, "SELECT COUNT(*) AS n FROM rental_match_subscriptions WHERE mode IN ('instant', 'daily_digest')", []),
    seen_match_pairs: countWhere(db, "SELECT COUNT(*) AS n FROM rental_match_seen", []),
    definition: "活躍可配對許願房為目前存量；訂閱數為目前開啟 instant/digest 的刊登。",
  };
  const acceptedTimes = (() => {
    try {
      return db.prepare(`
        SELECT (julianday(accepted_at) - julianday(created_at)) * 86400 AS secs
        FROM wish_offers
        WHERE accepted_at >= ? AND accepted_at <= ?
        ORDER BY secs ASC
        LIMIT 200
      `).all(`${range.from}T00:00:00.000Z`, `${range.to}T23:59:59.999Z`).map((row) => Number(row.secs) || 0);
    } catch {
      return [];
    }
  })();
  const mid = acceptedTimes.length ? acceptedTimes[Math.floor((acceptedTimes.length - 1) / 2)] : 0;
  offers.median_seconds_to_accept = acceptedTimes.length ? Math.round(mid) : null;
  offers.median_definition = "期間 accepted 樣本（最多 200）的中位秒數；分母是期間 accepted 筆數。";
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
    survey_breakdown: surveyAggregate(db, { from: `${range.from}T00:00:00.000Z`, to: `${range.to}T23:59:59.999Z` }),
  };
  wish.resumed = sumMetric(db, "wish_resumed", range.from, range.to);
  wish.clone_or_restart = wish.resumed;
  wish.clone_definition = "期間 resume 次數；completed 不可直接改回 active，須另開新則。";
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
    const rows = db.prepare(`
      SELECT public_token, found_via_site, via_feature, created_at
      FROM rental_completion_surveys
      WHERE created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(`${range.from}T00:00:00.000Z`, `${range.to}T23:59:59.999Z`, size + 1, offset);
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
  const rows = db.prepare(`
    SELECT public_token, status, created_at
    FROM wish_offers
    WHERE created_at >= ? AND created_at <= ?
    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(`${range.from}T00:00:00.000Z`, `${range.to}T23:59:59.999Z`, size + 1, offset);
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
