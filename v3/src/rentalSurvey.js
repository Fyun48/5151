/** Wish completion survey。append-only，可跳過，不要求新 PII。 */

import { randomBytes } from "node:crypto";
import { bumpAnalytics, rentalNotifyHttpError } from "./rentalNotify.js";
import { containsUnsafeMarkup, sanitizeDocumentText } from "./safeContent.js";

export const SURVEY_FOUND = Object.freeze(["yes", "no", "prefer_not_to_say", "skipped"]);
export const SURVEY_FEATURES = Object.freeze(["search", "wish_match", "owner_offer", "other", ""]);
export const SURVEY_DETAIL_MAX = 400;

export function getCompletionSurvey(db, userId, wishId) {
  return db.prepare(SURVEY_BY_WISH_SQL).get(Number(wishId), Number(userId)) || null;
}

// 問卷列相關的語句抽成常數，讓 PG 版（`rentalSurveyAsync.js`）逐字共用。
export const SURVEY_BY_WISH_SQL =
  "SELECT * FROM rental_completion_surveys WHERE wish_id = ? AND user_id = ?";
export const SURVEY_WISH_SQL = "SELECT * FROM demand_posts WHERE id = ?";
export const SURVEY_INSERT_SQL = `INSERT INTO rental_completion_surveys(public_token, wish_id, user_id, found_via_site, via_feature, helpful, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

// 問卷欄位的**純**驗證與淨化。抽出來給 PG 版逐字重用——「不合法的值一律降級成
// skipped／空字串」「不安全標記要擋」不能有第二份實作。
export function surveyFields(input = {}) {
  const found = SURVEY_FOUND.includes(input.found_via_site) ? input.found_via_site : "skipped";
  const via = SURVEY_FEATURES.includes(input.via_feature) ? input.via_feature : "";
  const helpful = [1, 2, 3, 4, 5].includes(Number(input.helpful)) ? Number(input.helpful) : null;
  const detail = sanitizeDocumentText(String(input.detail || "")).slice(0, SURVEY_DETAIL_MAX);
  if (containsUnsafeMarkup(detail)) throw rentalNotifyHttpError("內容包含不安全標記", 400, "unsafe_markup");
  return { found, via, helpful, detail };
}

// `bumpAnalytics()` 的計數鍵：跳過也要記一筆，兩個 driver 共用同一個選擇規則。
export function surveyMetric(found) {
  return found === "skipped" ? "survey_skipped" : "survey_submitted";
}

export function submitCompletionSurvey(db, userId, wishRow, input = {}, now = new Date()) {
  const wishId = Number(wishRow?.id || 0);
  const raw = wishId ? db.prepare(SURVEY_WISH_SQL).get(wishId) : null;
  if (!raw || Number(raw.user_id) !== Number(userId)) {
    throw rentalNotifyHttpError("找不到這則許願房", 404, "wish_not_found");
  }
  if (String(raw.lifecycle || "") !== "completed") {
    throw rentalNotifyHttpError("完成找房後才能填回饋", 409, "survey_not_due");
  }
  wishRow = raw;
  const existing = getCompletionSurvey(db, userId, wishRow.id);
  if (existing) {
    return publicSurvey(existing, { already: true });
  }
  const { found, via, helpful, detail } = surveyFields(input);
  const stamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  try {
    db.prepare(SURVEY_INSERT_SQL)
      .run(randomBytes(16).toString("base64url"), wishRow.id, Number(userId), found, via, helpful, detail, stamp);
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      return publicSurvey(getCompletionSurvey(db, userId, wishRow.id), { already: true });
    }
    throw error;
  }
  bumpAnalytics(db, surveyMetric(found), now);
  return publicSurvey(getCompletionSurvey(db, userId, wishRow.id), { already: false });
}

export function publicSurvey(row, extra = {}) {
  if (!row) return { submitted: false, ...extra };
  return {
    submitted: true,
    already: Boolean(extra.already),
    survey_ref: row.public_token,
    found_via_site: row.found_via_site,
    via_feature: row.via_feature,
    helpful: row.helpful,
    created_at: String(row.created_at || "").slice(0, 16),
  };
}

// 彙總的 SQL 片段與列形狀抽出來，讓 PG 版共用同一組條件（只有 COUNT 的型別要正規化，
// 見 async 版的說明）。
export function surveyAggregateSql({ from, to } = {}) {
  const params = [];
  let sql = "SELECT found_via_site, COUNT(*) AS n FROM rental_completion_surveys WHERE 1=1";
  if (from) { sql += " AND created_at >= ?"; params.push(from); }
  if (to) { sql += " AND created_at <= ?"; params.push(to); }
  sql += " GROUP BY found_via_site";
  return { sql, params };
}

export function surveyAggregate(db, { from, to } = {}) {
  const { sql, params } = surveyAggregateSql({ from, to });
  return db.prepare(sql).all(...params);
}
