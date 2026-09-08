import { createHash } from "node:crypto";
import { classifyChangedPaths } from "../coding/pathPolicy.js";
import { buildDatabaseMigrationEvidence } from "./migrationEvidence.js";

// Phase 11 決定性檢核。每個檢核為純函式：ctx → { check_type, status, severity, finding, evidence, command?, tool? }。
// status: PASS|FAIL|WARN|REVIEW|SKIPPED；severity: none|low|medium|high|blocking。
// 不存 hidden chain-of-thought；敏感值一律 redact。

function res(check_type, status, severity, finding = "", evidence = {}, extra = {}) {
  return { check_type, status, severity, finding, evidence, ...extra };
}

export function diffHash(diff) {
  const norm = (diff.files || []).map((f) => `${f.status || "M"}:${f.path}:${f.insertions}:${f.deletions}:${f.binary ? 1 : 0}`).sort();
  return createHash("sha256").update(JSON.stringify({ files: norm, ins: diff.insertions, del: diff.deletions })).digest("hex");
}

const changedPaths = (diff) => (diff.files || []).map((f) => f.path);

// 1. 授權/provenance：coding task 必要欄位齊全、狀態合格、未取消。
export function checkAuthorizationProvenance(ctx) {
  const t = ctx.codingTask;
  const missing = [];
  for (const f of ["development_authorization_id", "proposal_id", "proposal_version", "proposal_hash", "base_sha", "head_sha", "coding_branch", "result_hash"]) {
    if (t[f] == null || t[f] === "") missing.push(f);
  }
  if (t.status === "cancelled") return res("AUTHORIZATION_PROVENANCE", "FAIL", "blocking", "coding task cancelled", { status: t.status });
  if (missing.length) return res("AUTHORIZATION_PROVENANCE", "FAIL", "blocking", "missing provenance fields", { missing });
  return res("AUTHORIZATION_PROVENANCE", "PASS", "none", "provenance present", { proposal_id: t.proposal_id, proposal_version: t.proposal_version, authorization_id: t.development_authorization_id });
}

// 2. GIT_DIFF：獨立重算 diff，與 Phase-10 provenance 比對，不一致就 surface。
export function checkGitDiff(ctx) {
  const actual = changedPaths(ctx.diff).sort();
  const recorded = (Array.isArray(ctx.codingTask.changed_files) ? ctx.codingTask.changed_files.map((f) => (typeof f === "string" ? f : f.path)) : []).sort();
  const onlyActual = actual.filter((p) => !recorded.includes(p));
  const onlyRecorded = recorded.filter((p) => !actual.includes(p));
  const mismatch = onlyActual.length > 0 || onlyRecorded.length > 0;
  if (mismatch) return res("GIT_DIFF", "WARN", "medium", "independent diff differs from recorded provenance", { files: actual.length, insertions: ctx.diff.insertions, deletions: ctx.diff.deletions, only_actual: onlyActual.slice(0, 20), only_recorded: onlyRecorded.slice(0, 20) });
  return res("GIT_DIFF", "PASS", "none", "independent diff matches provenance", { files: actual.length, insertions: ctx.diff.insertions, deletions: ctx.diff.deletions });
}

function scopePathHints(snapshot) {
  const hints = new Set();
  const scan = (v) => {
    for (const m of String(v || "").matchAll(/([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]*)/g)) hints.add(m[1].replace(/\/+$/, "/"));
  };
  (snapshot?.scope || []).forEach(scan);
  scan(snapshot?.proposed_change);
  return [...hints];
}

// 3. APPROVED_SCOPE：與確切核准快照比對，偵測明顯的範圍外擴張（不用較新未核准版本合理化）。
export function checkApprovedScope(ctx) {
  const files = changedPaths(ctx.diff).filter((p) => !/^ai-dev-notes\//.test(p));
  const hints = scopePathHints(ctx.snapshot);
  if (!hints.length) return res("APPROVED_SCOPE", "PASS", "none", "scope not path-constrained by proposal; no expansion basis", { changed: files.length });
  const outside = files.filter((p) => !hints.some((h) => p === h || p.startsWith(h) || p.startsWith(h.replace(/\/$/, "") + "/")));
  if (outside.length) return res("APPROVED_SCOPE", "REVIEW", "high", "changes outside approved scope path hints", { allowed_hints: hints.slice(0, 20), outside: outside.slice(0, 20) });
  return res("APPROVED_SCOPE", "PASS", "none", "changes within approved scope hints", { allowed_hints: hints.slice(0, 20) });
}

// 4. PROTECTED_PATH：敏感路徑（非部署安全）→ REVIEW。部署安全交給 DEPLOYMENT_SAFETY。
export function checkProtectedPath(ctx) {
  const c = classifyChangedPaths(changedPaths(ctx.diff));
  if (c.sensitive.length) return res("PROTECTED_PATH", "REVIEW", "high", "sensitive protected paths modified", { sensitive: c.sensitive.slice(0, 20) });
  return res("PROTECTED_PATH", "PASS", "none", "no sensitive protected paths modified", {});
}

const SECRET_PATTERNS = [
  { t: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { t: "aws_access_key", re: /AKIA[0-9A-Z]{16}/ },
  { t: "generic_token", re: /(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9/_+\-]{12,}/i },
  { t: "github_token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { t: "bearer", re: /bearer\s+[A-Za-z0-9._\-]{20,}/i },
];
// 5. SECRET_SCAN：掃新增行的疑似機敏材料；發現即 blocking（值 redact）。
export function checkSecretScan(ctx) {
  const hits = [];
  for (const { path: p, line } of ctx.addedLines || []) {
    for (const s of SECRET_PATTERNS) {
      if (s.re.test(line)) { hits.push({ path: p, type: s.t }); break; }
    }
  }
  if (hits.length) return res("SECRET_SCAN", "FAIL", "blocking", "possible secret material added (values redacted)", { count: hits.length, hits: hits.slice(0, 20) });
  return res("SECRET_SCAN", "PASS", "none", "no secret-like additions detected", {});
}

const SECURITY_SENSITIVE = [/(^|\/)auth[^/]*\.js$/i, /(^|\/)session[^/]*\.js$/i, /csrf/i, /(^|\/)ingestSignature\.js$/i, /(^|\/)opsSignature\.js$/i, /(^|\/)malwareScan\.js$/i, /middleware/i, /secret/i];
// 6. SECURITY_STATIC：驗證/授權/session/CSRF/security middleware/密鑰處理 → 標記為 security-sensitive（需更強證據）。
export function checkSecurityStatic(ctx) {
  const files = changedPaths(ctx.diff).filter((p) => SECURITY_SENSITIVE.some((re) => re.test(p)));
  if (files.length) return res("SECURITY_STATIC", "REVIEW", "medium", "security-sensitive files modified", { files: files.slice(0, 20) });
  return res("SECURITY_STATIC", "PASS", "none", "no security-sensitive files modified", {});
}

// 7. DEPLOYMENT_SAFETY：動到部署安全控制檔 → blocking；否則若 repo 有 deploy-safety 測試則獨立跑。
export function checkDeploymentSafety(ctx) {
  const c = classifyChangedPaths(changedPaths(ctx.diff));
  if (c.deploy_safety.length) return res("DEPLOYMENT_SAFETY", "FAIL", "blocking", "deployment-safety controlled files modified (requires manual/elevated review)", { files: c.deploy_safety.slice(0, 20) });
  if (ctx.hasDeploySafetyTest && ctx.runCommand) {
    const out = ctx.runCommand("deploy-safety");
    if (out.ran && out.exitCode !== 0) return res("DEPLOYMENT_SAFETY", "FAIL", "blocking", "deploy-safety test failed", { exit_code: out.exitCode }, { command: "node --test test/deploy-safety.test.js", tool: "node-test" });
    if (out.ran) return res("DEPLOYMENT_SAFETY", "PASS", "none", "deploy-safety test passed", { exit_code: 0 }, { command: "node --test test/deploy-safety.test.js", tool: "node-test" });
  }
  return res("DEPLOYMENT_SAFETY", "PASS", "none", "no deployment-safety paths modified", {});
}

// 命令型檢核（tests/build/typecheck 失敗 → blocking；lint 失敗 → high/REVIEW）。
function commandCheck(ctx, { type, scriptKey, name, blocking }) {
  if (!ctx.packageScripts || !ctx.packageScripts[scriptKey]) return res(type, "SKIPPED", "none", `no '${scriptKey}' script in target repo`, {});
  if (!ctx.runCommand) return res(type, "SKIPPED", "none", "no command runner available", {});
  const out = ctx.runCommand(name);
  const command = `npm run ${scriptKey}`;
  if (!out.ran) return res(type, "SKIPPED", "none", out.reason || "not run", {}, { command });
  if (out.exitCode !== 0) return res(type, "FAIL", blocking ? "blocking" : "high", `${scriptKey} failed`, { exit_code: out.exitCode, output_tail: (out.output || "").slice(-500), timed_out: !!out.timedOut }, { command, tool: "npm" });
  return res(type, "PASS", "none", `${scriptKey} passed`, { exit_code: 0 }, { command, tool: "npm" });
}
export function checkTests(ctx) { return commandCheck(ctx, { type: "TESTS", scriptKey: "test", name: "test", blocking: true }); }
export function checkBuild(ctx) { return commandCheck(ctx, { type: "BUILD", scriptKey: "build", name: "build", blocking: true }); }
export function checkLint(ctx) { return commandCheck(ctx, { type: "LINT", scriptKey: "lint", name: "lint", blocking: false }); }
export function checkTypecheck(ctx) { return commandCheck(ctx, { type: "TYPECHECK", scriptKey: "typecheck", name: "typecheck", blocking: true }); }

// 12. DEPENDENCY_CHANGE：偵測 manifest/lock 變更，記錄新增/移除套件（不執行任意安裝腳本）。
export function checkDependencyChange(ctx) {
  const manifests = changedPaths(ctx.diff).filter((p) => /(^|\/)package\.json$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|requirements\.txt$/i.test(p));
  if (!manifests.length) return res("DEPENDENCY_CHANGE", "PASS", "none", "no dependency manifest changes", {});
  const added = [];
  for (const { path: p, line } of ctx.addedLines || []) {
    if (/package\.json$/i.test(p || "")) { const m = line.match(/"([@A-Za-z0-9._/-]+)"\s*:\s*"[^"]+"/); if (m) added.push(m[1]); }
  }
  return res("DEPENDENCY_CHANGE", "WARN", "low", "dependency manifest changed", { manifests: manifests.slice(0, 10), added_entries: [...new Set(added)].slice(0, 30) });
}

// 13. DATABASE_MIGRATION：偵測 schema/migration/破壞性 SQL 並輸出結構化證據（Phase 14 才做 Production clearance）。
export function checkDatabaseMigration(ctx) {
  const evidence = buildDatabaseMigrationEvidence({
    files: changedPaths(ctx.diff),
    addedLines: ctx.addedLines || [],
  });
  if (evidence.destructive) return res("DATABASE_MIGRATION", "REVIEW", "high", "destructive/irreversible SQL detected (not rollback-safe)", evidence);
  if (evidence.schema || evidence.files.length || evidence.data_rewrite) {
    return res("DATABASE_MIGRATION", "WARN", "medium", evidence.data_rewrite ? "data rewrite/backfill detected" : "schema/migration change detected", evidence);
  }
  return res("DATABASE_MIGRATION", "PASS", "none", "no database migration detected", evidence);
}

// 14. CONFIG_CHANGE：偵測環境變數/設定/基礎設施/feature flag 變更（不曝露機敏值）。
export function checkConfigChange(ctx) {
  const files = changedPaths(ctx.diff).filter((p) => /(^|\/)\.env|\.env(\.|$)|(^|\/)config\/|\.config\.(js|ts|json|cjs|mjs)$|docker-compose.*\.ya?ml$|(^|\/)compose\.ya?ml$|\.ini$|\.toml$|\.yaml$|\.yml$/i.test(p));
  if (!files.length) return res("CONFIG_CHANGE", "PASS", "none", "no configuration changes", {});
  return res("CONFIG_CHANGE", "WARN", "low", "configuration/environment change detected", { files: files.slice(0, 20) });
}

// 15. GENERATED_BINARY：diff 出現 binary/產生物 → WARN。
export function checkGeneratedBinary(ctx) {
  const bins = (ctx.diff.files || []).filter((f) => f.binary).map((f) => f.path);
  if (bins.length) return res("GENERATED_BINARY", "WARN", "medium", "binary/generated files in diff", { files: bins.slice(0, 20) });
  return res("GENERATED_BINARY", "PASS", "none", "no binary files in diff", {});
}

// 16. CHANGE_SIZE：超過集中式門檻 → high WARN（→REVIEW_REQUIRED）。
export function checkChangeSize(ctx) {
  const files = (ctx.diff.files || []).length;
  const lines = (ctx.diff.insertions || 0) + (ctx.diff.deletions || 0);
  const over = [];
  if (files > ctx.policy.maxChangedFiles) over.push({ type: "too_many_files", count: files, limit: ctx.policy.maxChangedFiles });
  if (lines > ctx.policy.maxDiffLines) over.push({ type: "too_many_lines", count: lines, limit: ctx.policy.maxDiffLines });
  if (over.length) return res("CHANGE_SIZE", "WARN", "high", "change size exceeds configured limits", { over });
  return res("CHANGE_SIZE", "PASS", "none", "change size within limits", { files, lines });
}

const CHECK_FNS = {
  AUTHORIZATION_PROVENANCE: checkAuthorizationProvenance,
  GIT_DIFF: checkGitDiff,
  APPROVED_SCOPE: checkApprovedScope,
  PROTECTED_PATH: checkProtectedPath,
  SECRET_SCAN: checkSecretScan,
  SECURITY_STATIC: checkSecurityStatic,
  DEPLOYMENT_SAFETY: checkDeploymentSafety,
  TESTS: checkTests,
  BUILD: checkBuild,
  LINT: checkLint,
  TYPECHECK: checkTypecheck,
  DEPENDENCY_CHANGE: checkDependencyChange,
  DATABASE_MIGRATION: checkDatabaseMigration,
  CONFIG_CHANGE: checkConfigChange,
  GENERATED_BINARY: checkGeneratedBinary,
  CHANGE_SIZE: checkChangeSize,
};

export function runAllChecks(ctx) {
  const results = [];
  for (const type of ctx.policy.requiredChecks) {
    const fn = CHECK_FNS[type];
    if (!fn) continue;
    const started = new Date().toISOString();
    let r;
    try { r = fn(ctx); } catch (e) { r = res(type, "FAIL", "blocking", "check crashed", { error: String(e.message || e).slice(0, 200) }); }
    results.push({ ...r, started_at: started, completed_at: new Date().toISOString() });
  }
  return results;
}
