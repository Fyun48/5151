import { makeLocalProvider, makeNullProvider } from "./provider.js";

// Phase 7 沿用既有 AI provider 抽象（analyze({system,user,timeoutMs}) -> {rawText, usage}）。
// local / null 直接重用 provider.js；stub 為角色感知的「決定性離線」實作（供測試/本地零成本）。
// 本階段不自動安裝任何模型、不呼叫付費 API；特定 coding-agent 廠商一律不作為評估 runtime。

function parseEvalData(user) {
  try {
    const m = String(user || "").match(/EVAL_DATA_BEGIN[^\n]*\n([\s\S]*?)\nEVAL_DATA_END/);
    return m ? JSON.parse(m[1]) : {};
  } catch { return {}; }
}

function riskForLevel(level) {
  const L = String(level || "").toUpperCase();
  if (L === "CRITICAL") return "CRITICAL";
  if (L === "HIGH") return "HIGH";
  if (L === "MEDIUM") return "MEDIUM";
  return "LOW";
}

// 決定性規則（僅供離線/測試）：
//  - SECURITY 對 SECURITY 類 issue → ESCALATE(CRITICAL)；COMPLIANCE 對 COMPLIANCE 類 issue → ESCALATE(CRITICAL)。
//  - 其餘角色依 impact_level：CRITICAL/HIGH→PROPOSE、MEDIUM→WAIT、LOW→IGNORE。
//  - 第二輪：若 peers 中出現 CRITICAL 的 ESCALATE，非升級角色改投 WAIT（保守 deliberation 效果）。
function stubDecision(data) {
  const role = String(data.role || "").toUpperCase();
  const round = Number(data.round || 1);
  const category = String(data.issue?.category || "").toUpperCase();
  const level = String(data.impact?.impact_level || "LOW").toUpperCase();
  const peers = Array.isArray(data.peers) ? data.peers : [];

  const isSecurityIssue = category === "SECURITY";
  const isComplianceIssue = category === "COMPLIANCE";

  if (role === "SECURITY" && isSecurityIssue) {
    return { recommendation: "ESCALATE", confidence: 0.9, risk_level: "CRITICAL", rationale: "Security-category issue requires specialist review.", evidence_refs: ["impact"], missing_evidence: [], risk_flags: ["security_exposure"] };
  }
  if (role === "COMPLIANCE" && isComplianceIssue) {
    return { recommendation: "ESCALATE", confidence: 0.9, risk_level: "CRITICAL", rationale: "Compliance-category issue requires specialist review.", evidence_refs: ["impact"], missing_evidence: [], risk_flags: ["compliance_exposure"] };
  }

  let rec = level === "CRITICAL" || level === "HIGH" ? "PROPOSE" : (level === "MEDIUM" ? "WAIT" : "IGNORE");
  if (round > 1) {
    const criticalEscalation = peers.some((p) => String(p.recommendation).toUpperCase() === "ESCALATE" && String(p.risk_level).toUpperCase() === "CRITICAL");
    if (criticalEscalation && rec === "PROPOSE") rec = "WAIT";
  }
  return { recommendation: rec, confidence: 0.75, risk_level: riskForLevel(level), rationale: `${role} view based on impact level ${level}.`, evidence_refs: ["impact"], missing_evidence: [], risk_flags: [] };
}

// stub 選項：behavior=timeout|error|malformed|badenum|badconfidence；failRole=只對某角色丟錯（測 partial-run）。
export function makeStubEvaluationProvider(opts = {}) {
  const usage = { calls: 0 };
  return {
    name: "stub",
    available: true,
    async health() { return { ok: true, provider: "stub" }; },
    getUsage() { return { ...usage }; },
    async analyze({ user }) {
      usage.calls += 1;
      const data = parseEvalData(user);
      const role = String(data.role || "").toUpperCase();
      if (opts.failRole && role === String(opts.failRole).toUpperCase()) {
        throw new Error(`stub failRole ${role}`);
      }
      if (opts.behavior === "timeout") { const e = new Error("stub timeout"); e.name = "AbortError"; throw e; }
      if (opts.behavior === "error") throw new Error("stub provider error");
      if (opts.behavior === "malformed") return { rawText: "not json <>", usage: stubUsage() };
      if (opts.behavior === "badenum") return { rawText: JSON.stringify({ recommendation: "NONSENSE", confidence: 0.5, risk_level: "LOW" }), usage: stubUsage() };
      if (opts.behavior === "badconfidence") return { rawText: JSON.stringify({ recommendation: "PROPOSE", confidence: 5, risk_level: "LOW" }), usage: stubUsage() };
      return { rawText: JSON.stringify(stubDecision(data)), usage: stubUsage() };
    },
  };
}

function stubUsage() {
  return { input_tokens: null, output_tokens: null, latency_ms: 1, estimated_cost: null };
}

// 依環境變數選 provider（與 AI 分析分開設定）。未設定 → Null（worker 略過、不消耗 attempts）。
export function makeEvaluationProvider(env = process.env, opts = {}) {
  const kind = String(opts.kind || env.EVALUATION_PROVIDER || "").toLowerCase();
  if (kind === "stub") return makeStubEvaluationProvider();
  if (kind === "local") return makeLocalProvider(env);
  return makeNullProvider();
}
