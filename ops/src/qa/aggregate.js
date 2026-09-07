import { CAUTION_ORDER, QA_AGGREGATION_VERSION } from "./qaPolicy.js";

const SEV_RANK = { none: 0, low: 1, medium: 2, high: 3, blocking: 4 };

// 決定性、版本化的 QA 彙總（qa-agg-v1）。
// 任一 blocking 失敗 → FAIL；無 blocking 但有 high 級 WARN/REVIEW → REVIEW_REQUIRED；全數通過 → PASS。
// optional AI：PASS 不能凌駕決定性 FAIL；AI FAIL/REVIEW 僅能保守「提升謹慎度」到最多 REVIEW_REQUIRED。
export function aggregateQa(checks, { review = null, reviewSeverityThreshold = "high" } = {}) {
  const threshold = SEV_RANK[reviewSeverityThreshold] ?? 3;
  const blocking = [];
  let raiseToReview = false;
  for (const c of checks) {
    if (c.status === "FAIL" && c.severity === "blocking") { blocking.push(c.check_type); continue; }
    if (c.status === "FAIL") { if (SEV_RANK[c.severity] >= threshold) raiseToReview = true; continue; }
    if ((c.status === "REVIEW" || c.status === "WARN") && SEV_RANK[c.severity] >= threshold) raiseToReview = true;
  }
  let deterministic = blocking.length ? "FAIL" : (raiseToReview ? "REVIEW_REQUIRED" : "PASS");

  let final = deterministic;
  if (review && review.recommendation) {
    // AI 只能提升謹慎度（最多到 REVIEW_REQUIRED），且永不把 FAIL 降為 PASS。
    const aiRaise = review.recommendation === "FAIL" || review.recommendation === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "PASS";
    if (CAUTION_ORDER[aiRaise] > CAUTION_ORDER[final]) final = aiRaise;
  }
  const warnings = checks.filter((c) => c.status === "WARN" || c.status === "REVIEW");
  return {
    aggregation_version: QA_AGGREGATION_VERSION,
    final_result: final,
    deterministic_result: deterministic,
    blocking_checks: blocking,
    warning_count: warnings.length,
  };
}
