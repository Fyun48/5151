import { createHash } from "node:crypto";

// Canonical embedding 輸入：由「Phase 4 CURRENT 有效分析」＋精選 feedback 症狀文字組成。
// 決定性、版本化。絕不含 contact / user_ref / session / context / 附件二進位 / 其他個資。
export const NORMALIZATION_VERSION = "embed-input-v1";

const SYMPTOM_MAX = 1000;
const SUMMARY_MAX = 600;

// currentAnalysis：publicAnalysis 形狀（category, summary…）。feedbackRow：ingested_feedback。
export function buildEmbeddingInput(currentAnalysis, feedbackRow) {
  const category = String(currentAnalysis?.category || "OTHER").trim();
  const summary = String(currentAnalysis?.summary || "").trim().slice(0, SUMMARY_MAX);
  // 只取症狀文字（feedback.content），截斷；不含任何個資欄位。
  const symptom = String(feedbackRow?.content || "").trim().slice(0, SYMPTOM_MAX);
  // 用 category 值 + summary + 症狀（不加重複的標籤 boilerplate）；決定性、版本化。
  const text = [category, summary, symptom].filter(Boolean).join("\n");
  return { text, normalizationVersion: NORMALIZATION_VERSION, textHash: createHash("sha256").update(text).digest("hex") };
}
