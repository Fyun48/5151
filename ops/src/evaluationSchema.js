import { httpError } from "./errors.js";

// Phase 7 角色投票的受控結構與嚴格驗證。模型輸出一律視為 untrusted：
// 只讀已知欄位、不 eval、不執行；違反結構/範圍/列舉即拒絕。
// 不接受、不儲存隱藏推理鏈（chain-of-thought）：rationale 僅為「結論式」摘要。

export const RECOMMENDATIONS = ["PROPOSE", "WAIT", "IGNORE", "ESCALATE"];
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"];

export const RATIONALE_MAX = 600;
export const LIST_ITEM_MAX = 120;
export const LIST_LEN_MAX = 10;
export const RAW_OUTPUT_MAX = 20000;

export function isRecommendation(v) {
  return RECOMMENDATIONS.includes(String(v || "").trim().toUpperCase());
}
export function isRiskLevel(v) {
  return RISK_LEVELS.includes(String(v || "").trim().toUpperCase());
}

// RISK_LEVELS 的序（供 escalation「>= HIGH」等比較）。
export const RISK_ORDER = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
export function riskAtLeast(level, min) {
  return (RISK_ORDER[String(level || "").toUpperCase()] ?? 0) >= (RISK_ORDER[String(min || "").toUpperCase()] ?? 0);
}

function toStringList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of arr) {
    if (item == null) continue;
    const s = String(item).trim();
    if (!s) continue;
    out.push(s.slice(0, LIST_ITEM_MAX));
    if (out.length >= LIST_LEN_MAX) break;
  }
  return out;
}

// 政策：
//  - recommendation 未知/缺漏 → 拒絕（validation 失敗）。
//  - confidence 必須為 0..1 數值，否則拒絕（不可靜默進入投票）。
//  - risk_level 未知/缺漏 → 正規化為 UNKNOWN（提示性質，不阻擋）。
//  - rationale：選填字串，過長截斷（僅結論，不含推理鏈）。
//  - evidence_refs / missing_evidence / risk_flags：字串陣列，長度/數量受限；非陣列則忽略成空陣列。
//  - 額外欄位一律忽略（不 eval、不執行）。
export function validateRoleOutput(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw httpError("role output must be a JSON object", 422);
  }
  const recommendation = String(obj.recommendation || "").trim().toUpperCase();
  if (!isRecommendation(recommendation)) {
    throw httpError(`invalid recommendation: ${recommendation || "(missing)"}`, 422);
  }
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw httpError("confidence must be a number in [0,1]", 422);
  }
  let riskLevel = String(obj.risk_level || obj.risk || "").trim().toUpperCase();
  if (!isRiskLevel(riskLevel)) riskLevel = "UNKNOWN";
  let rationale = obj.rationale == null ? "" : String(obj.rationale).trim();
  if (rationale.length > RATIONALE_MAX) rationale = rationale.slice(0, RATIONALE_MAX);
  return {
    recommendation,
    confidence,
    risk_level: riskLevel,
    rationale,
    evidence_refs: toStringList(obj.evidence_refs),
    missing_evidence: toStringList(obj.missing_evidence),
    risk_flags: toStringList(obj.risk_flags),
  };
}

// 從模型原始文字擷取 JSON（容忍 ```json 圍欄與前後雜訊），再嚴格驗證。
export function parseAndValidateRole(rawText) {
  const text = String(rawText == null ? "" : rawText);
  if (text.length > RAW_OUTPUT_MAX) throw httpError("model output too large", 422);
  let jsonText = text.trim();
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonText = fence[1].trim();
  else {
    const first = jsonText.indexOf("{");
    const last = jsonText.lastIndexOf("}");
    if (first >= 0 && last > first) jsonText = jsonText.slice(first, last + 1);
  }
  let obj;
  try { obj = JSON.parse(jsonText); } catch { throw httpError("model did not return valid JSON", 422); }
  return validateRoleOutput(obj);
}
