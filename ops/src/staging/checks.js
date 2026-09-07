// Phase 12 決定性 Staging 檢核（隔離/來源/artifact/migration/config）+ 環境身分護欄 + 彙總。
// status: PASS|FAIL|WARN|REVIEW|SKIPPED；severity: none|low|medium|high|blocking。Provider prose 不能凌駕決定性失敗。

const PROD = /\bprod(uction)?\b|prd/i;
function res(check_type, status, severity, finding = "", evidence = {}) { return { check_type, status, severity, finding, evidence }; }

// 環境身分護欄：非明確 staging-class 一律 fail-closed（不以 hostname 猜測「非 production」）。
export function isProductionIdentity(config = {}) {
  return String(config.environment_class || "").toLowerCase() === "production" || PROD.test(String(config.environment_id || "")) || PROD.test(String(config.environment_class || ""));
}
export function isStagingClass(config = {}) {
  return ["staging", "test", "preview", "ephemeral", "isolated"].includes(String(config.environment_class || "").toLowerCase());
}

export function checkSourceIdentity({ repo, task, qaHeadSha }) {
  const stored = String(task.head_sha || "");
  if (String(qaHeadSha || "") !== stored) return res("SOURCE_IDENTITY", "FAIL", "blocking", "QA head SHA does not match coding task head SHA", { qa_head: qaHeadSha, task_head: stored });
  const resolved = repo && repo.resolveRef ? repo.resolveRef(task.coding_branch) : null;
  if (!resolved) return res("SOURCE_IDENTITY", "FAIL", "blocking", "cannot resolve coding branch head", { branch: task.coding_branch });
  if (resolved !== stored) return res("SOURCE_IDENTITY", "FAIL", "blocking", "coding branch advanced after QA (unreviewed code); re-run QA", { resolved, task_head: stored });
  return res("SOURCE_IDENTITY", "PASS", "none", "source head SHA matches QA-approved head", { head_sha: stored });
}

export function checkArtifactIntegrity({ artifact, headSha }) {
  const d = String(artifact?.artifact_digest || "");
  if (!d || d === "latest") return res("ARTIFACT_INTEGRITY", "FAIL", "blocking", "no immutable artifact digest (mutable 'latest' is not release evidence)", { artifact_digest: d || null });
  if (!/^[a-f0-9]{16,}$/i.test(d) && !/^sha256:[a-f0-9]{16,}$/i.test(d)) return res("ARTIFACT_INTEGRITY", "REVIEW", "high", "artifact digest is not a recognizable immutable digest", { artifact_digest: d });
  if (headSha && artifact.source_head_sha && artifact.source_head_sha !== headSha) return res("ARTIFACT_INTEGRITY", "FAIL", "blocking", "artifact not built from exact approved head SHA", { built_from: artifact.source_head_sha, expected: headSha });
  return res("ARTIFACT_INTEGRITY", "PASS", "none", "immutable artifact digest bound to head SHA", { artifact_digest: d });
}

export function checkEnvironmentIsolation(config) {
  if (isProductionIdentity(config)) return res("ENVIRONMENT_ISOLATION", "FAIL", "blocking", "environment identifies as Production", { environment_class: config.environment_class, environment_id: config.environment_id });
  if (!isStagingClass(config)) return res("ENVIRONMENT_ISOLATION", "REVIEW", "high", "environment class is not an explicit staging class (fail-closed ambiguity)", { environment_class: config.environment_class });
  if (!config.environment_id) return res("ENVIRONMENT_ISOLATION", "REVIEW", "high", "ambiguous staging environment identity", {});
  return res("ENVIRONMENT_ISOLATION", "PASS", "none", "explicit non-production staging environment", { environment_class: config.environment_class, environment_id: config.environment_id });
}

export function checkDatabaseIsolation(config) {
  if (config.db_required && !config.db_class) return res("DATABASE_ISOLATION", "FAIL", "blocking", "staging DB required but no isolated DB configured (fail-closed; never fall back to Production)", {});
  if (PROD.test(String(config.db_class || "")) || PROD.test(String(config.db_ref || ""))) return res("DATABASE_ISOLATION", "FAIL", "blocking", "staging points at a Production database", { db_class: config.db_class });
  if (!config.db_required && !config.db_class) return res("DATABASE_ISOLATION", "PASS", "none", "no database required for staging", {});
  return res("DATABASE_ISOLATION", "PASS", "none", "isolated staging database", { db_class: config.db_class });
}

export function checkStorageIsolation(config) {
  const m = String(config.storage_mode || "").toLowerCase();
  if (PROD.test(m)) return res("STORAGE_ISOLATION", "FAIL", "blocking", "staging uses Production storage", { storage_mode: m });
  if (["isolated", "ephemeral", "tmp", "test"].includes(m)) return res("STORAGE_ISOLATION", "PASS", "none", "isolated staging storage", { storage_mode: m });
  return res("STORAGE_ISOLATION", "REVIEW", "high", "storage isolation not clearly guaranteed", { storage_mode: m });
}

export function checkExternalSideEffectSafety(config) {
  const m = String(config.integration_mode || "").toLowerCase();
  if (["sandbox", "disabled", "mock", "test"].includes(m)) return res("EXTERNAL_SIDE_EFFECT_SAFETY", "PASS", "none", "external integrations sandboxed/disabled", { integration_mode: m });
  if (m === "live" || m === "production") return res("EXTERNAL_SIDE_EFFECT_SAFETY", "FAIL", "blocking", "live external integrations could cause real side effects (email/SMS/payment)", { integration_mode: m });
  return res("EXTERNAL_SIDE_EFFECT_SAFETY", "REVIEW", "high", "external side-effect safety not clearly guaranteed", { integration_mode: m });
}

// 消費 Phase-11 migration 證據；Phase 12 僅對隔離 DB 驗證，不宣稱破壞性遷移對 Production 安全。
export function checkMigration({ qaMigration, config }) {
  const mode = String(config.migration_mode || "").toLowerCase();
  if (!qaMigration || qaMigration.status === "PASS") return res("MIGRATION", "PASS", "none", "no migration detected by QA", {});
  if (config.db_required && mode !== "isolated" && mode !== "disposable") return res("MIGRATION", "FAIL", "blocking", "migration present but staging migration mode is not isolated/disposable", { migration_mode: mode });
  const destructive = !!(qaMigration.evidence && qaMigration.evidence.destructive);
  if (destructive) return res("MIGRATION", "REVIEW", "high", "destructive migration validated only against isolated staging (NOT declared Production-safe)", { migration_mode: mode, destructive: true });
  return res("MIGRATION", "WARN", "medium", "schema/migration change validated against isolated staging", { migration_mode: mode });
}

export function checkConfig({ configFingerprint, config }) {
  return res("CONFIG", "PASS", "none", "sanitized staging configuration recorded", { config_fingerprint: configFingerprint, environment_class: config.environment_class, integration_mode: config.integration_mode, migration_mode: config.migration_mode });
}

// 把 provider 的 deploy/health/smoke 結果包成 check（provider 說成功但實測失敗 → 以實測為準）。
export function checkFromProviderResult(type, result, { requiredFail = "blocking" } = {}) {
  if (!result || result.ran === false) return res(type, "SKIPPED", "none", "not run", {});
  const passed = result.passed === true || result.ok === true || result.deployed === true;
  if (!passed) return res(type, "FAIL", requiredFail, `${type.toLowerCase()} failed`, sanitizeResult(result));
  return res(type, "PASS", "none", `${type.toLowerCase()} ok`, sanitizeResult(result));
}
function sanitizeResult(r) {
  const out = {};
  for (const k of ["status_code", "endpoint_ref", "checks", "deployed", "passed", "detail"]) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

const SEV_RANK = { none: 0, low: 1, medium: 2, high: 3, blocking: 4 };
export function aggregateStaging(checks, { reviewSeverityThreshold = "high" } = {}) {
  const threshold = SEV_RANK[reviewSeverityThreshold] ?? 3;
  const blocking = [];
  let review = false;
  for (const c of checks) {
    if (c.status === "FAIL" && c.severity === "blocking") { blocking.push(c.check_type); continue; }
    if (c.status === "FAIL" && SEV_RANK[c.severity] >= threshold) review = true;
    if ((c.status === "REVIEW" || c.status === "WARN") && SEV_RANK[c.severity] >= threshold) review = true;
  }
  const validation = blocking.length ? "FAIL" : (review ? "REVIEW_REQUIRED" : "PASS");
  return { validation_result: validation, blocking_checks: blocking, warning_count: checks.filter((c) => c.status === "WARN" || c.status === "REVIEW").length };
}
