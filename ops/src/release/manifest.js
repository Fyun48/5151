import { createHash } from "node:crypto";

// Phase 13 不可變 Release Manifest：由 DB 證據「決定性」組裝（不需 LLM）；sanitized（無 PII/密鑰）。
// 內容涵蓋 A.變更 B.來源 C.授權 D.QA E.DB/Config F.Staging G.風險。

function pick(qaChecks, type) { return (qaChecks || []).find((c) => c.check_type === type) || null; }

export function buildManifestContent({ snapshot, task, auth, qa, staging, currentMaster }) {
  const qaChecks = qa?.checks || [];
  const stgChecks = staging?.checks || [];
  const findings = (list, types) => list.filter((c) => types.includes(c.check_type)).map((c) => ({ check_type: c.check_type, status: c.status, severity: c.severity, finding: c.finding }));
  return {
    what_is_changing: {
      title: snapshot.title, problem_statement: snapshot.problem_statement, proposed_change: snapshot.proposed_change,
      intended_outcome: snapshot.intended_outcome, scope: snapshot.scope, non_goals: snapshot.non_goals, acceptance_criteria: snapshot.acceptance_criteria,
    },
    source: {
      coding_task_id: Number(task.id), base_sha: task.base_sha, head_sha: task.head_sha,
      changed_files: (Array.isArray(task.changed_files) ? task.changed_files.map((f) => (typeof f === "string" ? f : f.path)) : []),
      insertions: task.diff_insertions, deletions: task.diff_deletions, diff_hash: qa.diff_hash,
      protected_path_warnings: task.protected_flags || null,
    },
    authorization: {
      development_authorization_id: Number(auth.id), proposal_id: Number(auth.proposal_id),
      proposal_version: Number(auth.proposal_version), proposal_hash: String(auth.proposal_hash),
      gate1_approved_by: auth.approved_by, gate1_approved_at: auth.approved_at,
    },
    qa: {
      qa_run_id: Number(qa.id), final_result: qa.final_result, fresh: qa.fresh,
      checks: qaChecks.map((c) => ({ check_type: c.check_type, status: c.status, severity: c.severity })),
      security_findings: findings(qaChecks, ["SECRET_SCAN", "SECURITY_STATIC"]),
      protected_path_findings: findings(qaChecks, ["PROTECTED_PATH", "DEPLOYMENT_SAFETY"]),
      dependency_change: pick(qaChecks, "DEPENDENCY_CHANGE")?.evidence || null,
    },
    database_config: {
      migration: pick(qaChecks, "DATABASE_MIGRATION") ? { status: pick(qaChecks, "DATABASE_MIGRATION").status, finding: pick(qaChecks, "DATABASE_MIGRATION").finding, evidence: pick(qaChecks, "DATABASE_MIGRATION").evidence } : null,
      config_change: pick(qaChecks, "CONFIG_CHANGE")?.evidence || null,
      // Phase 14 不修改已核准的 immutable manifest 本體；clearance 為獨立 record，經 authorization / manifest hash 連結。
      production_migration_safety: "NOT_ASSESSED (Phase 14 required)",
    },
    staging: {
      staging_deployment_id: Number(staging.id), artifact_digest: staging.artifact_digest, staged_head_sha: staging.head_sha,
      environment_id: staging.staging_environment_id, environment_class: staging.staging_environment_class,
      validation_result: staging.validation_result,
      health: stgChecks.find((c) => c.check_type === "HEALTH")?.status || null,
      smoke: stgChecks.find((c) => c.check_type === "SMOKE")?.status || null,
      isolation: findings(stgChecks, ["ENVIRONMENT_ISOLATION", "DATABASE_ISOLATION", "STORAGE_ISOLATION", "EXTERNAL_SIDE_EFFECT_SAFETY"]),
      staging_url: staging.staging_url, config_fingerprint: staging.config_fingerprint,
    },
    risks: {
      known_risks: snapshot.known_risks, security_considerations: snapshot.security_considerations,
      compliance_considerations: snapshot.compliance_considerations, operational_considerations: snapshot.operational_considerations,
      rollback_considerations: snapshot.rollback_considerations,
      unresolved_warnings: [...qaChecks, ...stgChecks].filter((c) => c.status === "WARN" || c.status === "REVIEW").map((c) => c.check_type),
    },
    baseline: { current_master_sha_at_generation: currentMaster },
  };
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.keys(v).sort().reduce((o, k) => { o[k] = canonical(v[k]); return o; }, {});
  return v;
}

// manifest_hash 覆蓋所有審批相關內容 + provenance。任一審批相關欄位變動 → hash 變動。
export function computeManifestHash({ content, version, headSha, artifactDigest, releaseInputFingerprint }) {
  return createHash("sha256").update(JSON.stringify({ content: canonical(content), version, headSha, artifactDigest, releaseInputFingerprint })).digest("hex");
}

export function releaseInputFingerprint(p) {
  const parts = [
    `coding_task_id:${p.codingTaskId}`, `authorization_id:${p.authorizationId}`,
    `proposal_id:${p.proposalId}`, `proposal_version:${p.proposalVersion}`, `proposal_hash:${p.proposalHash}`,
    `base_sha:${p.baseSha}`, `head_sha:${p.headSha}`, `current_master_sha:${p.currentMaster ?? ""}`,
    `coding_result_hash:${p.codingResultHash ?? ""}`, `diff_hash:${p.diffHash ?? ""}`,
    `qa_run_id:${p.qaRunId}`, `qa_input_fp:${p.qaInputFp}`, `qa_policy_fp:${p.qaPolicyFp}`,
    `staging_deployment_id:${p.stagingId}`, `staging_input_fp:${p.stagingInputFp ?? ""}`, `staging_policy_fp:${p.stagingPolicyFp}`, `staging_config_fp:${p.stagingConfigFp}`,
    `artifact_digest:${p.artifactDigest}`, `release_policy_fp:${p.releasePolicyFp}`,
  ].sort();
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
