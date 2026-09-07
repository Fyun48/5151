import { makeLocalProvider, makeNullProvider } from "./provider.js";

// Phase 8 沿用既有 AI provider 抽象（analyze({system,user,timeoutMs}) -> {rawText, usage}）。
// local / null 直接重用 provider.js；stub 為決定性離線實作（供測試/本地零成本）。
// 本階段不自動安裝任何模型、不呼叫付費 API；特定 coding-agent 廠商一律不作為提案生成 runtime。

function parseData(user) {
  try {
    const m = String(user || "").match(/PROPOSAL_DATA_BEGIN[^\n]*\n([\s\S]*?)\nPROPOSAL_DATA_END/);
    return m ? JSON.parse(m[1]) : {};
  } catch { return {}; }
}

function stubProposal(data) {
  const issue = data.issue || {};
  const impact = data.impact || {};
  const title = `改善：${String(issue.title || "issue").slice(0, 60)}`;
  const rev = data.revision_instruction ? ` (revised: ${String(data.revision_instruction).slice(0, 60)})` : "";
  return {
    title: title + rev,
    problem_statement: `使用者回報彙整為 Issue #${issue.id ?? "?"}（分類 ${issue.category || "OTHER"}），影響等級 ${impact.impact_level || "?"}、近期回報數 ${impact.current_feedback_count ?? "?"}。`,
    proposed_change: "根據回報症狀調整相關功能行為，使其符合使用者預期。具體實作由後續 coding agent 決定。",
    intended_outcome: "回報的症狀不再發生，使用者可順利完成該操作。",
    scope: ["受影響的既有功能行為"],
    non_goals: ["不新增無關功能", "不變更計費或帳務"],
    acceptance_criteria: ["原回報情境不再重現", "既有自動化測試維持綠燈", "新增涵蓋此情境的測試"],
    known_risks: ["可能觸及共用元件，需回歸測試"],
    security_considerations: "無新增對外輸入面；沿用既有驗證與授權。",
    compliance_considerations: "無涉及新的個資蒐集或保存政策變更。",
    operational_considerations: "無需資料庫破壞性變更；可平順部署。",
    rollback_considerations: "以 Git 版本回滾即可還原，無資料遷移相依。",
    evidence_summary: `依據 Phase-6 影響力評估與 Phase-7 角色投票（建議 ${impact ? "PROPOSE" : "?"}）綜合產生。`,
  };
}

export function makeStubProposalProvider(opts = {}) {
  const usage = { calls: 0 };
  return {
    name: "stub",
    available: true,
    async health() { return { ok: true, provider: "stub" }; },
    getUsage() { return { ...usage }; },
    async analyze({ user }) {
      usage.calls += 1;
      if (opts.behavior === "timeout") { const e = new Error("stub timeout"); e.name = "AbortError"; throw e; }
      if (opts.behavior === "error") throw new Error("stub provider error");
      if (opts.behavior === "malformed") return { rawText: "not json <>", usage: stubUsage() };
      if (opts.behavior === "missing") return { rawText: JSON.stringify({ title: "x" }), usage: stubUsage() }; // 缺必填
      return { rawText: JSON.stringify(stubProposal(parseData(user))), usage: stubUsage() };
    },
  };
}

function stubUsage() {
  return { input_tokens: null, output_tokens: null, latency_ms: 1, estimated_cost: null };
}

export function makeProposalProvider(env = process.env) {
  const kind = String(env.PROPOSAL_PROVIDER || "").toLowerCase();
  if (kind === "stub") return makeStubProposalProvider();
  if (kind === "local") return makeLocalProvider(env);
  return makeNullProvider();
}
