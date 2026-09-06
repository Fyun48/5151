import { httpError } from "../errors.js";

// AI 分析輸出的受控結構與嚴格驗證。模型輸出一律視為 untrusted：
// 只讀已知欄位、不 eval、不執行；違反結構/範圍/列舉即拒絕。

// 明確的分類 taxonomy（不接受模型自創字串）。
export const CATEGORIES = [
  "BUG",
  "FEATURE_REQUEST",
  "UX_UI",
  "PERFORMANCE",
  "SECURITY",
  "COMPLIANCE",
  "QUESTION_OR_USAGE",
  "DATA_QUALITY",
  "OTHER",
];

// severity 只是 AI 提示，不是最終嚴重度；受控刻度。
export const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];

export const SUMMARY_MAX = 600;
export const RAW_OUTPUT_MAX = 20000;
export const LANGUAGE_MAX = 16;

export function isCategory(v) {
  return CATEGORIES.includes(String(v || ""));
}
export function isSeverity(v) {
  return SEVERITIES.includes(String(v || ""));
}

// 政策：
//  - category 未知/缺漏 → 拒絕（validation 失敗）。模型應只輸出 taxonomy 內的值。
//  - severity 未知/缺漏 → 正規化為 UNKNOWN（提示性質，不阻擋）。
//  - confidence 必須為 0..1 數值，否則拒絕。
//  - summary 必須為非空字串且 <= SUMMARY_MAX，否則拒絕。
//  - language 選填，過長則截斷。
//  - 額外欄位一律忽略（不 eval、不執行）。
export function validateAnalysisOutput(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw httpError("analysis output must be a JSON object", 422);
  }
  const category = String(obj.category || "").trim().toUpperCase();
  if (!isCategory(category)) {
    throw httpError(`invalid category: ${category || "(missing)"}`, 422);
  }
  const summaryRaw = obj.summary;
  if (typeof summaryRaw !== "string" || !summaryRaw.trim()) {
    throw httpError("summary must be a non-empty string", 422);
  }
  const summary = summaryRaw.trim();
  if (summary.length > SUMMARY_MAX) {
    throw httpError(`summary too long (> ${SUMMARY_MAX})`, 422);
  }
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw httpError("confidence must be a number in [0,1]", 422);
  }
  let severity = String(obj.severity_hint || obj.severity || "").trim().toUpperCase();
  if (!isSeverity(severity)) severity = "UNKNOWN";
  let language = obj.language == null ? "" : String(obj.language).trim();
  if (language.length > LANGUAGE_MAX) language = language.slice(0, LANGUAGE_MAX);
  return { category, summary, severity_hint: severity, confidence, language };
}

// 從模型的原始文字擷取 JSON（容忍前後雜訊/```json 圍欄），再嚴格驗證。
export function parseAndValidate(rawText) {
  const text = String(rawText == null ? "" : rawText);
  if (text.length > RAW_OUTPUT_MAX) {
    throw httpError("model output too large", 422);
  }
  let jsonText = text.trim();
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonText = fence[1].trim();
  else {
    const first = jsonText.indexOf("{");
    const last = jsonText.lastIndexOf("}");
    if (first >= 0 && last > first) jsonText = jsonText.slice(first, last + 1);
  }
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    throw httpError("model did not return valid JSON", 422);
  }
  return validateAnalysisOutput(obj);
}
