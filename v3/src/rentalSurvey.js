/** Wish completion survey。append-only，可跳過，不要求新 PII。 */

import { randomBytes } from "node:crypto";
import { bumpAnalytics, rentalNotifyHttpError } from "./rentalNotify.js";
import { containsUnsafeMarkup, sanitizeDocumentText } from "./safeContent.js";

export const SURVEY_FOUND = Object.freeze(["yes", "no", "prefer_not_to_say", "skipped"]);
export const SURVEY_FEATURES = Object.freeze(["search", "wish_match", "owner_offer", "other", ""]);
export const SURVEY_DETAIL_MAX = 400;

export function getCompletionSurvey(db, userId, wishId) {
  return db.prepare(
    "SELECT * FROM rental_completion_surveys WHERE wish_id = ? AND user_id = ?",
  ).get(Number(wishId), Number(userId)) || null;
}

export function submitCompletionSurvey(db, userId, wishRow, input = {}, now = new Date()) {
  const wishId = Number(wishRow?.id || 0);
  const raw = wishId ? db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(wishId) : null;
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
  const found = SURVEY_FOUND.includes(input.found_via_site) ? input.found_via_site : "skipped";
  const via = SURVEY_FEATURES.includes(input.via_feature) ? input.via_feature : "";
  const helpful = [1, 2, 3, 4, 5].includes(Number(input.helpful)) ? Number(input.helpful) : null;
  let detail = sanitizeDocumentText(String(input.detail || "")).slice(0, SURVEY_DETAIL_MAX);
  if (containsUnsafeMarkup(detail)) throw rentalNotifyHttpError("內容包含不安全標記", 400, "unsafe_markup");
  const stamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  try {
    db.prepare(`
      INSERT INTO rental_completion_surveys(public_token, wish_id, user_id, found_via_site, via_feature, helpful, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomBytes(16).toString("base64url"), wishRow.id, Number(userId), found, via, helpful, detail, stamp);
  } catch (error) {
    if (String(error.message || "").includes("UNIQUE")) {
      return publicSurvey(getCompletionSurvey(db, userId, wishRow.id), { already: true });
    }
    throw error;
  }
  bumpAnalytics(db, found === "skipped" ? "survey_skipped" : "survey_submitted", now);
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

export function surveyAggregate(db, { from, to } = {}) {
  const params = [];
  let sql = "SELECT found_via_site, COUNT(*) AS n FROM rental_completion_surveys WHERE 1=1";
  if (from) { sql += " AND created_at >= ?"; params.push(from); }
  if (to) { sql += " AND created_at <= ?"; params.push(to); }
  sql += " GROUP BY found_via_site";
  return db.prepare(sql).all(...params);
}
