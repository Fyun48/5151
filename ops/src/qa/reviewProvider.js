// Phase 11 optional 獨立 AI 審查抽象。與 Coding Task 授權完全分離；無 coding/merge/deploy 權限。
// 只接收 sanitized 快照 + diff 摘要 + 決定性 QA findings；不接收密鑰/production 憑證/raw feedback 作指令。
// 預設不可用（無付費 AI 為必要）；Cursor 不得為必要的 runtime QA reviewer。不可捏造 AI 審查。

export const QA_REVIEW_PROMPT_VERSION = "qa-review-prompt-v1";

// 決定性 stub（測試）：依決定性 findings 給出 PASS/REVIEW_REQUIRED/FAIL 建議，不連外。
export function makeStubQaReviewProvider(opts = {}) {
  return {
    name: "stub",
    available: true,
    model: opts.model || "stub-1",
    async review({ deterministicFindings }) {
      const rec = opts.recommendation
        || (deterministicFindings?.blocking_checks?.length ? "FAIL" : (deterministicFindings?.warning_count ? "REVIEW_REQUIRED" : "PASS"));
      return {
        recommendation: rec,
        risk_level: rec === "FAIL" ? "high" : rec === "REVIEW_REQUIRED" ? "medium" : "low",
        findings: opts.findings || ["deterministic-informed stub review"],
        scope_concerns: [],
        security_concerns: [],
        regression_concerns: [],
        missing_evidence: [],
        model: opts.model || "stub-1",
        prompt_version: QA_REVIEW_PROMPT_VERSION,
      };
    },
  };
}

function unavailable(name, setup) {
  return { name, available: false, setup, async review() { throw Object.assign(new Error(`${name} QA reviewer unavailable`), { status: 503 }); } };
}
export function makeCursorQaReviewProvider() {
  return unavailable("cursor", { status: "pending_integration", required: ["A supported non-interactive Cursor review API reachable from Ops (not available in this environment).", "Cursor is optional and MUST NOT be required as the runtime QA reviewer."] });
}
export function makeLocalQaReviewProvider(env = process.env) {
  const cmd = String(env.QA_REVIEW_COMMAND || "").trim();
  if (!cmd) return unavailable("local", { status: "not_configured", required: ["Set QA_REVIEW_COMMAND to a local/self-hosted reviewer (opt-in; never in CI)."] });
  return unavailable("local", { status: "opt_in_runtime_only", required: ["Local reviewer execution is opt-in at runtime and not exercised by tests/CI."] });
}

export function makeQaReviewProvider(env = process.env) {
  if (env.QA_REVIEWER !== "1" && env.QA_REVIEWER !== "on") return unavailable("none", { status: "disabled", required: ["QA optional AI reviewer disabled; deterministic QA still runs."] });
  const kind = String(env.QA_REVIEW_PROVIDER || "").toLowerCase();
  if (kind === "stub") return makeStubQaReviewProvider({ model: env.QA_REVIEW_MODEL });
  if (kind === "cursor") return makeCursorQaReviewProvider();
  if (kind === "local") return makeLocalQaReviewProvider(env);
  return unavailable("none", { status: "not_configured", required: ["Set QA_REVIEW_PROVIDER to a supported reviewer."] });
}
