import { httpError } from "./errors.js";

// Phase 8 提案輸出的受控結構與嚴格驗證。模型輸出一律 untrusted：只讀已知欄位、不 eval、不執行；
// 違反結構/大小即拒絕。不接受、不儲存隱藏推理鏈（chain-of-thought）；rationale/evidence 僅結論式。

export const PROPOSAL_SCHEMA_VERSION = "proposal-schema-v1";

export const TITLE_MAX = 200;
export const TEXT_MAX = 2000;
export const LIST_ITEM_MAX = 300;
export const LIST_LEN_MAX = 20;
export const RAW_OUTPUT_MAX = 40000;

// 純字串欄位（必填 title/problem_statement/proposed_change；其餘選填）。
const STRING_FIELDS = [
  "title", "problem_statement", "proposed_change", "intended_outcome",
  "security_considerations", "compliance_considerations", "operational_considerations",
  "rollback_considerations", "evidence_summary",
];
// 陣列欄位（短字串清單）。
const LIST_FIELDS = ["scope", "non_goals", "acceptance_criteria", "known_risks"];

const REQUIRED = ["title", "problem_statement", "proposed_change"];

function boundStr(value, max) {
  const s = String(value == null ? "" : value).trim();
  return s.length > max ? s.slice(0, max) : s;
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

export function validateProposalOutput(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw httpError("proposal output must be a JSON object", 422);
  }
  const out = {};
  for (const f of STRING_FIELDS) {
    out[f] = f === "title" ? boundStr(obj[f], TITLE_MAX) : boundStr(obj[f], TEXT_MAX);
  }
  for (const f of REQUIRED) {
    if (!out[f]) throw httpError(`proposal missing required field: ${f}`, 422);
  }
  for (const f of LIST_FIELDS) out[f] = toStringList(obj[f]);
  return out;
}

export function parseAndValidateProposal(rawText) {
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
  return validateProposalOutput(obj);
}

// 供 hash / current pointer 使用的「審批相關內容」正規化序列化（決定性）。
export function canonicalProposalContent(p) {
  return {
    schema_version: PROPOSAL_SCHEMA_VERSION,
    title: p.title || "",
    problem_statement: p.problem_statement || "",
    proposed_change: p.proposed_change || "",
    intended_outcome: p.intended_outcome || "",
    scope: [...(p.scope || [])],
    non_goals: [...(p.non_goals || [])],
    acceptance_criteria: [...(p.acceptance_criteria || [])],
    known_risks: [...(p.known_risks || [])],
    security_considerations: p.security_considerations || "",
    compliance_considerations: p.compliance_considerations || "",
    operational_considerations: p.operational_considerations || "",
    rollback_considerations: p.rollback_considerations || "",
    evidence_summary: p.evidence_summary || "",
    source_evaluation_run_id: p.source_evaluation_run_id ?? null,
    source_impact_assessment_id: p.source_impact_assessment_id ?? null,
  };
}

export { STRING_FIELDS, LIST_FIELDS };
