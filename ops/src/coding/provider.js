import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

// Phase 10 廠商中立 Coding Provider 抽象。概念介面：
//   available()  是否可用（未設定/未整合 → false，worker 不會啟動，也不會假裝成功）
//   run({ workspace, snapshot, timeoutMs }) -> { provider_task_id, model, changed, notes }
//       在「隔離工作區 workspace（git worktree）」內實作核准範圍；只讀 snapshot 為授權邊界。
// 註：真正的多步 start/getStatus/cancel/getResult 未來可擴充；本階段用同步 run 足以驅動與測試。

export const CODING_PROVIDER_POLICY_VERSION = "coding-provider-v1";

// ── 決定性 stub（測試/離線；不呼叫任何付費 API、不連外） ──
export function makeStubCodingProvider(opts = {}) {
  return {
    name: "stub",
    available: true,
    model: opts.model || null,
    async run({ workspace, snapshot }) {
      if (opts.behavior === "timeout") { const e = new Error("stub timeout"); e.name = "AbortError"; throw e; }
      if (opts.behavior === "error") throw new Error("stub coding error");
      if (opts.behavior === "nochange") return { provider_task_id: "stub-1", changed: false, notes: "no change" };
      // 「說謊」：宣稱有改動卻不動任何檔案 → 用來驗證 git diff 才是唯一真相（prose 無法凌駕）。
      if (opts.behavior === "lie") return { provider_task_id: "stub-1", changed: true, notes: "I changed 10 files" };
      const shortHash = String(snapshot?.proposal_hash || "x").slice(0, 12);
      const dir = path.join(workspace, "ai-dev-notes");
      mkdirSync(dir, { recursive: true });
      // 依核准範圍寫入實作說明檔（真實產生 git diff）。實際實作策略由 provider 決定；此處為決定性最小變更。
      writeFileSync(path.join(dir, `${shortHash}.md`), [
        `# Approved change: ${snapshot?.title || ""}`,
        ``,
        `Proposal #${snapshot?.proposal_id} v${snapshot?.proposal_version} (${snapshot?.proposal_hash})`,
        ``,
        `## Proposed change`, String(snapshot?.proposed_change || ""),
        `## Acceptance criteria`, ...(Array.isArray(snapshot?.acceptance_criteria) ? snapshot.acceptance_criteria.map((c) => `- ${c}`) : []),
      ].join("\n") + "\n");
      if (opts.behavior === "oversize") {
        for (let i = 0; i < (Number(opts.files) || 60); i++) writeFileSync(path.join(dir, `extra-${i}.txt`), `line\n`.repeat(50));
      }
      if (opts.behavior === "protected") {
        // 故意改到部署安全控制檔（供偵測測試）：附加一行註解。
        const wf = path.join(workspace, ".github", "workflows", "test.yml");
        try { appendFileSync(wf, "\n# stub edit\n"); } catch { /* 檔案不存在則略過 */ }
      }
      return { provider_task_id: "stub-1", model: opts.model || null, changed: true, notes: "applied approved change" };
    },
  };
}

// 未整合/未設定的 provider：明確不可用；報告所需設定，絕不假裝已啟動任務或發明 API。
function unavailableProvider(name, setup) {
  return {
    name,
    available: false,
    setup,
    async run() { throw Object.assign(new Error(`${name} coding provider is not available`), { status: 503 }); },
  };
}

// Cursor adapter：本 repo/環境目前沒有受支援的非互動式 Cursor 自動化整合可從 ops 服務啟動 coding 任務。
// 因此明確標記 available=false（pending integration），並回報需要的整合機制，而非發明 API。
export function makeCursorCodingProvider() {
  return unavailableProvider("cursor", {
    status: "pending_integration",
    required: [
      "A supported non-interactive Cursor automation/agent API or CLI reachable from the Ops service (not available in this environment).",
      "Cursor account/plan authorizing programmatic coding runs.",
      "Least-privilege Git credentials able to push an ai-dev/* branch and open a PR only (no master push, no deploy, no secret admin).",
      "OPS_CODING_REPO_PATH pointing at a working clone the agent can operate in (or a provider-managed isolated workspace).",
    ],
  });
}

// 可選的本地命令 provider（opt-in；預設不可用；CI 絕不啟用）。
export function makeLocalCommandCodingProvider(env = process.env) {
  const cmd = String(env.OPS_CODING_COMMAND || "").trim();
  if (!cmd) return unavailableProvider("local", { status: "not_configured", required: ["Set OPS_CODING_COMMAND to a coding command run inside the isolated worktree (opt-in; never in CI)."] });
  // 真正執行留給 opt-in 部署；此處不在測試/CI 中執行任何命令。
  return unavailableProvider("local", { status: "opt_in_runtime_only", required: ["Local command execution is opt-in at runtime and intentionally not exercised by tests/CI."] });
}

export function makeCodingProvider(env = process.env, opts = {}) {
  const kind = String(opts.kind || env.CODING_PROVIDER || "").toLowerCase();
  if (kind === "stub") return makeStubCodingProvider();
  if (kind === "cursor") return makeCursorCodingProvider();
  if (kind === "local") return makeLocalCommandCodingProvider(env);
  return unavailableProvider("none", { status: "not_configured", required: ["Set CODING_PROVIDER to a supported provider. No provider is configured by default (coding never runs)."] });
}
