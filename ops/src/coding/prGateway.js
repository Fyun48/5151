// Phase 10 PR Gateway 抽象。Coding Provider 只能建立/更新自己的 coding 分支 PR，
// 且 PR 必為 DRAFT、base=master、絕不 auto-merge、絕不合併自己的 PR。

// 決定性 stub（測試）：記錄開啟的 draft PR，回傳 { number, url }。
export function makeStubPrGateway(opts = {}) {
  const opened = [];
  let n = Number(opts.startNumber) || 9000;
  return {
    name: "stub",
    available: true,
    opened,
    async openDraftPr({ branch, base, title, body }) {
      if (base !== "master") throw new Error("coding PR base must be master");
      if (!/^ai-dev\//.test(branch || "")) throw new Error("coding PR must be on ai-dev/ branch");
      if (opts.fail) throw new Error("stub PR creation failed");
      const number = n++;
      const rec = { number, url: `https://example.test/pr/${number}`, branch, base, title, body, draft: true };
      opened.push(rec);
      return { number: rec.number, url: rec.url, draft: true };
    },
  };
}

// 真正的 GitHub PR 建立需要具最小權限的自動化憑證/整合，本環境未提供 → 明確不可用（不發明 API）。
export function makeUnavailablePrGateway(reason = "not_configured") {
  return {
    name: "github",
    available: false,
    reason,
    setup: {
      status: "pending_integration",
      required: [
        "A GitHub App/token with least privilege able to push an ai-dev/* branch and open/update only its own PR.",
        "No permission for master push, branch-protection changes, secret admin, or deployment.",
      ],
    },
    async openDraftPr() { throw Object.assign(new Error("PR gateway unavailable"), { status: 503 }); },
  };
}

export function makePrGateway(env = process.env) {
  // 預設不可用（安全預設：未設定整合就不建立真實 PR）。
  return makeUnavailablePrGateway(env.OPS_PR_GATEWAY ? "unsupported" : "not_configured");
}
