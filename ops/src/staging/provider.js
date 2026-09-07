import { createHash } from "node:crypto";

// Phase 12 廠商中立 Staging Provider 抽象。概念能力：available/build/deploy/status/validateEndpoint/destroy。
// 決定性 stub（測試）；真實 adapter 僅在確有支援/設定時可用，否則明確 unavailable + 回報所需設定（不發明 API）。
// CI/測試絕不建立真實雲端/NAS 資源、不消耗付費額度、不開公開端點。

export const STAGING_PROVIDER_VERSION = "staging-provider-v1";

// 決定性 stub：以 head SHA + config 產生「不可變」artifact digest；部署到假環境；health/smoke 可設定成敗。
export function makeStubStagingProvider(opts = {}) {
  return {
    name: "stub",
    available: true,
    version: STAGING_PROVIDER_VERSION,
    async build({ headSha, sanitizedConfig }) {
      if (opts.buildFail) throw Object.assign(new Error("stub build failed"), { code: "build_failed" });
      const digest = "sha256:" + createHash("sha256").update(`${headSha}|${STAGING_PROVIDER_VERSION}|${JSON.stringify(sanitizedConfig || {})}`).digest("hex");
      return { artifact_id: `stub-artifact-${String(headSha).slice(0, 12)}`, artifact_digest: digest, source_head_sha: headSha, build_tool: "stub-builder", build_command: "stub build", build_strategy: "immutable-artifact-v1" };
    },
    async deploy({ artifact, sanitizedConfig }) {
      if (opts.deployFail) return { deployed: false, detail: "stub deploy failed" };
      const envId = sanitizedConfig?.environment_id || "staging-ephemeral";
      return { deployed: true, environment_id: envId, environment_class: sanitizedConfig?.environment_class || "staging", endpoint_ref: `staging://${envId}/${String(artifact?.artifact_id || "app")}` };
    },
    async health() { return opts.healthFail ? { ran: true, passed: false, detail: "unhealthy" } : { ran: true, passed: true, checks: ["process_up", "http_health"] }; },
    async smoke() { return opts.smokeFail ? { ran: true, passed: false, detail: "smoke failed" } : { ran: true, passed: true, checks: ["app_responds"] }; },
    async cleanup({ environmentClass }) {
      // 護欄：只清理明確 staging-class（引擎另有 fail-closed 檢查）。
      return { cleaned: environmentClass !== "production" };
    },
  };
}

function unavailable(name, setup) {
  return { name, available: false, setup, async build() { throw Object.assign(new Error(`${name} staging provider unavailable`), { status: 503 }); }, async deploy() { throw Object.assign(new Error(`${name} unavailable`), { status: 503 }); } };
}

// 真實 adapter：本環境未提供受支援、可自動建立隔離 Staging 的安全機制 → 明確 unavailable（pending setup）。
export function makeContainerStagingProvider() {
  return unavailable("container", { status: "pending_setup", required: [
    "An isolated non-Production Staging target (separate container/host/cloud) reachable from Ops.",
    "Staging-only credentials (never Production DB/SSH/NAS/API secrets).",
    "Isolated staging database + isolated storage + sandbox external integrations.",
    "OPS_CODING_REPO_PATH for source, plus STAGING_* env (class/id/db/storage/integration modes).",
    "Cleanup/TTL configuration; environment-class guard for safe teardown.",
  ] });
}

export function makeStagingProvider(env = process.env) {
  const kind = String(env.STAGING_PROVIDER || "").toLowerCase();
  if (kind === "stub") return makeStubStagingProvider();
  if (kind === "container" || kind === "docker" || kind === "casaos" || kind === "cloud") return makeContainerStagingProvider();
  return unavailable("none", { status: "not_configured", required: ["Set STAGING_PROVIDER to a supported provider. No provider configured by default (staging never runs)."] });
}
