import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";
Object.assign(process.env, { STAGING_PROVIDER: "stub", STAGING_ENV_CLASS: "staging", STAGING_ENV_ID: "staging-1", STAGING_DB_CLASS: "disposable", STAGING_STORAGE_MODE: "isolated", STAGING_INTEGRATION_MODE: "sandbox", STAGING_MIGRATION_MODE: "isolated" });

import { openOpsDb } from "../src/opsDb.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { getCurrentIssueProposal, submitOwnerDecision } from "../src/proposal.js";
import { makeGitRepo } from "../src/coding/gitRepo.js";
import { makeStubCodingProvider } from "../src/coding/provider.js";
import { makeStubPrGateway } from "../src/coding/prGateway.js";
import { createCodingTask, claimCodingTaskBatch, executeCodingTask } from "../src/codingTask.js";
import { createQaRun, executeQaRun } from "../src/qaRun.js";
import { createStagingDeployment, claimStagingBatch, executeStagingDeployment } from "../src/stagingDeploy.js";
import { makeStubStagingProvider } from "../src/staging/provider.js";
import { createReleaseCandidate, submitOwnerReleaseDecision, RELEASE_OWNER_ACTIONS } from "../src/releaseCandidate.js";
import { checkDatabaseMigration } from "../src/qa/qaChecks.js";
import { buildDatabaseMigrationEvidence, classifySqlLine } from "../src/qa/migrationEvidence.js";
import {
  CLEARANCE_RESULTS, MIGRATION_CLASSIFICATIONS, buildMigrationSafetyPolicy, evaluateMigrationSafety,
  migrationSafetyPolicyFingerprint,
} from "../src/release/migrationSafetyPolicy.js";
import {
  createMigrationSafetyAssessment, getCurrentMigrationSafety, getPhase15ReleaseEligibility,
  assertPhase15MigrationClearance, sanitizeMigrationEvidence,
} from "../src/release/migrationSafety.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
let seq = 1;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function seedProposeIssue(db) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,created_at,updated_at) VALUES('t','s','BUG','cluster-v1','open',?,?)").run(ts, ts).lastInsertRowid);
  for (let k = 0; k < 8; k++) {
    const i = seq++;
    db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at) VALUES (?, ?, 'v3', 'bug', ?, 'leak@example.com', ?, '3.47', ?)").run(`d${i}`, `k${i}`, `content ${i}`, `reporter-${i}`, ts);
    const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
    db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', 'BUG', 'symptom', 'HIGH', 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, ts, ts, ts);
    const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
    db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
    db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, ts);
  }
  calculateAndStoreImpact(db, iid, { now: NOW });
  return iid;
}
function initGitRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "m14-repo-"));
  const remote = mkdtempSync(path.join(os.tmpdir(), "m14-remote-"));
  execFileSync("git", ["init", "-q", "-b", "master", dir]);
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "workflows", "test.yml"), "name: Tests\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { test: 'node -e "process.exit(0)"' } }) + "\n");
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "base"]);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(["remote", "add", "origin", remote]);
  return { dir, remote, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} try { rmSync(remote, { recursive: true, force: true }); } catch {} } };
}
function advanceMaster(dir) {
  writeFileSync(path.join(dir, "m.txt"), "x\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "master advance"]);
}
async function makeStagedTask(db) {
  const iid = seedProposeIssue(db);
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  submitOwnerDecision(db, iid, { action: "APPROVE_DEVELOPMENT", proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  const g = initGitRepo(); const repo = makeGitRepo(g.dir); const prov = makeStubCodingProvider();
  const { task } = createCodingTask(db, { issueId: iid, provider: prov, repo, now: NOW });
  const [c] = claimCodingTaskBatch(db, { now: NOW, limit: 5 });
  await executeCodingTask(db, c, { provider: prov, repo, pr: makeStubPrGateway(), selfTest: async () => ({ ran: true, passed: true }), now: NOW });
  const { run } = createQaRun(db, { codingTaskId: task.id, repo, now: NOW });
  await executeQaRun(db, run, { repo, now: NOW });
  createStagingDeployment(db, { codingTaskId: task.id, repo, now: NOW });
  const [d] = claimStagingBatch(db, { now: NOW, limit: 5 });
  await executeStagingDeployment(db, d, { repo, provider: makeStubStagingProvider(), now: NOW });
  return { iid, codingTaskId: task.id, repo, git: g };
}
function approve(db, codingTaskId, repo) {
  const { candidate: rc } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
  const out = submitOwnerReleaseDecision(db, {
    codingTaskId, action: "APPROVE_RELEASE", manifestId: rc.id, manifestVersion: rc.manifest_version,
    manifestHash: rc.manifest_hash, artifactDigest: rc.artifact_digest, headSha: rc.head_sha, repo, now: NOW,
  });
  return { rc, authorization: out.authorization };
}
function bind(auth) {
  return {
    releaseAuthorizationId: auth.id,
    manifestId: auth.release_manifest_id,
    manifestVersion: auth.release_manifest_version,
    manifestHash: auth.manifest_hash,
    headSha: auth.head_sha,
    artifactDigest: auth.artifact_digest,
  };
}
function phase15Ids(codingTaskId, auth) {
  return { codingTaskId, ...bind(auth) };
}
function boundProofs(authRow) {
  return {
    rollback_proof: {
      schema_version: "migration-rollback-proof-v1",
      verified: true,
      bound_artifact_digest: authRow.artifact_digest,
      bound_qa_run_id: authRow.qa_run_id,
      bound_staging_deployment_id: authRow.staging_deployment_id,
      method: "verified_isolated_rollback_replay",
    },
    old_code_compat_proof: {
      schema_version: "migration-compat-proof-v1",
      verified: true,
      bound_artifact_digest: authRow.artifact_digest,
      bound_qa_run_id: authRow.qa_run_id,
      bound_staging_deployment_id: authRow.staging_deployment_id,
      method: "verified_old_binary_against_new_schema",
    },
  };
}
function patchQaMigration(db, codingTaskId, evidence, status = "WARN") {
  const qa = db.prepare("SELECT qa_run_id FROM development_qa_current WHERE coding_task_id=?").get(codingTaskId);
  db.prepare("UPDATE development_qa_check SET status=?, evidence=? WHERE qa_run_id=? AND check_type='DATABASE_MIGRATION'")
    .run(status, JSON.stringify(evidence), qa.qa_run_id);
}

// ── 單元：classification / clearance ──
test("Phase 14 classify: complete no-migration scan → CLEARED_NO_MIGRATION", () => {
  const evidence = buildDatabaseMigrationEvidence({ files: [], addedLines: [] });
  const r = evaluateMigrationSafety({ qaCheck: { status: "PASS", finding: "no database migration detected", evidence } });
  assert.equal(r.classification, MIGRATION_CLASSIFICATIONS.NONE);
  assert.equal(r.clearance, CLEARANCE_RESULTS.CLEARED_NO_MIGRATION);
});

test("Phase 14 classify: missing/empty/legacy evidence is UNKNOWN blocked, not NONE", () => {
  const missing = evaluateMigrationSafety({ qaCheck: { status: "PASS" } });
  assert.equal(missing.classification, MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN);
  assert.equal(missing.clearance, CLEARANCE_RESULTS.BLOCKED_UNKNOWN);
  const empty = evaluateMigrationSafety({ qaCheck: { status: "PASS", evidence: {} } });
  assert.equal(empty.classification, MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN);
  assert.equal(empty.clearance, CLEARANCE_RESULTS.BLOCKED_UNKNOWN);
  const legacy = evaluateMigrationSafety({ qaCheck: { status: "WARN", finding: "schema change", evidence: { schema: true, files: ["migrations/001.sql"] } } });
  assert.equal(legacy.classification, MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN);
  assert.equal(legacy.clearance, CLEARANCE_RESULTS.BLOCKED_UNKNOWN);
  const malformed = evaluateMigrationSafety({ qaCheck: { status: "PASS", evidence: "not-an-object" } });
  assert.equal(malformed.clearance, CLEARANCE_RESULTS.BLOCKED_UNKNOWN);
});

test("Phase 14 classify: additive shape without bound proofs stays blocked", () => {
  const additiveEv = buildDatabaseMigrationEvidence({
    files: ["migrations/001_add_index.sql"],
    addedLines: ["CREATE INDEX idx_x ON t(x);"],
  });
  const unproven = evaluateMigrationSafety({ qaCheck: { status: "WARN", evidence: additiveEv } });
  assert.equal(unproven.classification, MIGRATION_CLASSIFICATIONS.ADDITIVE_BACKWARD_COMPATIBLE);
  assert.equal(unproven.clearance, CLEARANCE_RESULTS.BLOCKED_UNKNOWN);
  const skipIgnored = evaluateMigrationSafety({
    qaCheck: { status: "WARN", evidence: additiveEv },
    policy: buildMigrationSafetyPolicy({ additiveRequiresRollbackProof: false, additiveRequiresOldCodeCompatProof: false }),
  });
  assert.equal(skipIgnored.clearance, CLEARANCE_RESULTS.BLOCKED_UNKNOWN);
  const cleared = evaluateMigrationSafety({
    qaCheck: { status: "WARN", evidence: { ...additiveEv, ...boundProofs({ artifact_digest: "sha256:abc", qa_run_id: 1, staging_deployment_id: 2 }) } },
    binding: { artifactDigest: "sha256:abc", qaRunId: 1, stagingDeploymentId: 2 },
  });
  assert.equal(cleared.classification, MIGRATION_CLASSIFICATIONS.ADDITIVE_BACKWARD_COMPATIBLE);
  assert.equal(cleared.clearance, CLEARANCE_RESULTS.CLEARED_ADDITIVE);
});

test("Phase 14 classify: data migration is fail-closed", () => {
  const r = evaluateMigrationSafety({
    qaCheck: { status: "WARN", evidence: buildDatabaseMigrationEvidence({ files: ["migrations/002.sql"], addedLines: ["UPDATE users SET name='x';"] }) },
  });
  assert.equal(r.classification, MIGRATION_CLASSIFICATIONS.DATA_MIGRATION);
  assert.equal(r.clearance, CLEARANCE_RESULTS.BLOCKED_DATA_MIGRATION_UNPROVEN);
});

test("Phase 14 classify: destructive is blocked", () => {
  const r = evaluateMigrationSafety({ qaCheck: { status: "REVIEW", evidence: buildDatabaseMigrationEvidence({ files: ["migrations/drop.sql"], addedLines: ["DROP TABLE users;"] }) } });
  assert.equal(r.classification, MIGRATION_CLASSIFICATIONS.DESTRUCTIVE_OR_IRREVERSIBLE);
  assert.equal(r.clearance, CLEARANCE_RESULTS.BLOCKED_DESTRUCTIVE);
});

test("P1: multiline / multi-statement / runtime SQL cannot clear as NONE or additive", () => {
  const runtimeDrop = buildDatabaseMigrationEvidence({
    files: ["v3/src/opsDb.js"],
    addedLines: ["db.exec(`DROP", "TABLE users;`);"],
  });
  const runtime = evaluateMigrationSafety({ qaCheck: { status: runtimeDrop.schema ? "WARN" : "PASS", evidence: runtimeDrop } });
  assert.ok(["DESTRUCTIVE_OR_IRREVERSIBLE", "UNKNOWN_OR_UNPROVEN"].includes(runtime.classification));
  assert.ok(["BLOCKED_DESTRUCTIVE", "BLOCKED_UNKNOWN"].includes(runtime.clearance));

  const splitNotNull = buildDatabaseMigrationEvidence({
    files: ["migrations/002.sql"],
    addedLines: ["ALTER TABLE users ADD COLUMN status TEXT", "NOT NULL;"],
  });
  const notNull = evaluateMigrationSafety({ qaCheck: { status: "WARN", evidence: splitNotNull } });
  assert.equal(notNull.classification, MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN);
  assert.equal(notNull.clearance, CLEARANCE_RESULTS.BLOCKED_UNKNOWN);

  const maskedRename = buildDatabaseMigrationEvidence({
    files: ["migrations/003.sql"],
    addedLines: ["CREATE INDEX ix ON users(email); ALTER TABLE users RENAME TO archived_users;"],
  });
  const rename = evaluateMigrationSafety({ qaCheck: { status: "WARN", evidence: maskedRename } });
  assert.equal(rename.classification, MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN);
  assert.equal(rename.clearance, CLEARANCE_RESULTS.BLOCKED_UNKNOWN);
});

test("P1: unique index / old-write risk is not additive-compatible and SQL kind is not proof", () => {
  const uniqueEv = buildDatabaseMigrationEvidence({
    files: ["migrations/004.sql"],
    addedLines: ["CREATE UNIQUE INDEX idx_email ON users(email);"],
  });
  const unique = evaluateMigrationSafety({ qaCheck: { status: "WARN", evidence: uniqueEv } });
  assert.equal(unique.classification, MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN);
  assert.equal(unique.clearance, CLEARANCE_RESULTS.BLOCKED_UNKNOWN);
  assert.equal(unique.rollback_assessment.proven, false);
  assert.equal(unique.compatibility_assessment.proven, false);
});

test("Phase 14 classify: missing QA check → UNKNOWN blocked", () => {
  const r = evaluateMigrationSafety({ qaCheck: null });
  assert.equal(r.classification, MIGRATION_CLASSIFICATIONS.UNKNOWN_OR_UNPROVEN);
  assert.equal(r.clearance, CLEARANCE_RESULTS.BLOCKED_UNKNOWN);
});

test("Phase 14 SQL line classifier is deterministic", () => {
  assert.equal(classifySqlLine("CREATE INDEX idx_x ON t(x);").sql_kind, "CREATE_INDEX");
  assert.equal(classifySqlLine("ALTER TABLE t ADD COLUMN n TEXT;").sql_kind, "ADD_COLUMN_NULLABLE");
  assert.equal(classifySqlLine("ALTER TABLE t ADD COLUMN n TEXT NOT NULL;").kind, "UNKNOWN");
  assert.equal(classifySqlLine("UPDATE users SET name='x';").kind, "DATA");
  assert.equal(classifySqlLine("DROP TABLE users;").kind, "DESTRUCTIVE");
});

test("Phase 11 emits structured migration evidence without changing destructive REVIEW", () => {
  const r = checkDatabaseMigration({
    diff: { files: [{ path: "ops/migrations/001.sql", insertions: 1, deletions: 0 }] },
    addedLines: [{ path: "ops/migrations/001.sql", line: "DROP TABLE users;" }],
  });
  assert.equal(r.status, "REVIEW");
  assert.equal(r.evidence.destructive, true);
  assert.ok(r.evidence.statement_counts.destructive >= 1);
});

test("policy fingerprint is deterministic and excludes secrets", () => {
  const p = buildMigrationSafetyPolicy();
  assert.equal(migrationSafetyPolicyFingerprint(p), migrationSafetyPolicyFingerprint(buildMigrationSafetyPolicy()));
  assert.doesNotMatch(JSON.stringify(p), /password|ssh|token|credential/i);
  assert.equal(p.no_llm_decision, true);
  assert.equal(p.no_third_human_gate, true);
  assert.equal(p.allow_data_migration_clearance, false);
  assert.equal(p.additive_requires_rollback_proof, true);
  assert.equal(p.additive_requires_old_code_compat_proof, true);
  assert.equal(p.policy_version, "migration-safety-policy-v2");
});

// ── 整合：binding / freshness / immutability ──
test("NONE evidence on approved authorization → CLEARED_NO_MIGRATION; Phase 15 may consume", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { rc, authorization } = approve(db, codingTaskId, repo);
    const created = createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
    assert.equal(created.assessment.migration_classification, "NONE");
    assert.equal(created.assessment.clearance_result, "CLEARED_NO_MIGRATION");
    const cur = getCurrentMigrationSafety(db, codingTaskId, { repo });
    assert.equal(cur.fresh, true);
    const elig = getPhase15ReleaseEligibility(db, phase15Ids(codingTaskId, authorization), { repo });
    assert.equal(elig.allowed, true);
    const manifest = JSON.parse(db.prepare("SELECT manifest_content FROM development_release_candidate WHERE id=?").get(rc.id).manifest_content);
    assert.match(manifest.database_config.production_migration_safety, /NOT_ASSESSED \(Phase 14 required\)/);
    assertPhase15MigrationClearance(db, phase15Ids(codingTaskId, authorization), { repo });
  } finally { git.cleanup(); db.close(); }
});

test("additive / data / destructive / unknown create the expected clearance rows", async () => {
  const cases = [
    {
      evFor: (authRow) => ({
        ...buildDatabaseMigrationEvidence({ files: ["migrations/a.sql"], addedLines: ["CREATE TABLE extra (id INTEGER);"] }),
        ...boundProofs(authRow),
      }),
      classification: "ADDITIVE_BACKWARD_COMPATIBLE", clearance: "CLEARED_ADDITIVE",
    },
    {
      evFor: () => buildDatabaseMigrationEvidence({ files: ["migrations/b.sql"], addedLines: ["UPDATE users SET name='x';"] }),
      classification: "DATA_MIGRATION", clearance: "BLOCKED_DATA_MIGRATION_UNPROVEN",
    },
    {
      evFor: () => buildDatabaseMigrationEvidence({ files: ["migrations/c.sql"], addedLines: ["DROP TABLE users;"] }),
      classification: "DESTRUCTIVE_OR_IRREVERSIBLE", clearance: "BLOCKED_DESTRUCTIVE",
    },
    {
      evFor: () => ({ schema: true, files: ["migrations/d.sql"] }),
      classification: "UNKNOWN_OR_UNPROVEN", clearance: "BLOCKED_UNKNOWN",
    },
  ];
  for (const c of cases) {
    const db = openOpsDb(":memory:");
    const { codingTaskId, repo, git } = await makeStagedTask(db);
    try {
      const { authorization } = approve(db, codingTaskId, repo);
      const authRow = db.prepare("SELECT * FROM production_release_authorization WHERE id=?").get(authorization.id);
      patchQaMigration(db, codingTaskId, c.evFor(authRow), c.classification === "DESTRUCTIVE_OR_IRREVERSIBLE" ? "REVIEW" : "WARN");
      const created = createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
      assert.equal(created.assessment.migration_classification, c.classification, c.classification);
      assert.equal(created.assessment.clearance_result, c.clearance, c.clearance);
      const elig = getPhase15ReleaseEligibility(db, phase15Ids(codingTaskId, authorization), { repo });
      if (c.clearance.startsWith("CLEARED_")) assert.equal(elig.allowed, true);
      else {
        assert.equal(elig.allowed, false);
        assert.equal(elig.reason, "phase14_clearance_blocked");
      }
    } finally { git.cleanup(); db.close(); }
  }
});

test("exact Gate #2 authorization binding; mismatches are rejected", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization } = approve(db, codingTaskId, repo);
    const good = { codingTaskId, repo, now: NOW, ...bind(authorization) };
    assert.throws(() => createMigrationSafetyAssessment(db, { ...good, manifestHash: "wrong" }), /manifest_hash mismatch/);
    assert.throws(() => createMigrationSafetyAssessment(db, { ...good, manifestVersion: 99 }), /manifest_version mismatch/);
    assert.throws(() => createMigrationSafetyAssessment(db, { ...good, headSha: "wrong" }), /head_sha mismatch/);
    assert.throws(() => createMigrationSafetyAssessment(db, { ...good, artifactDigest: "wrong" }), /artifact_digest mismatch/);
    assert.throws(() => createMigrationSafetyAssessment(db, { ...good, releaseAuthorizationId: 999999 }), /not found/);
  } finally { git.cleanup(); db.close(); }
});

test("superseded authorization cannot keep a fresh clearance; Phase 15 blocked", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization } = approve(db, codingTaskId, repo);
    createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
    assert.equal(getCurrentMigrationSafety(db, codingTaskId, { repo }).fresh, true);
    advanceMaster(git.dir);
    const { candidate: v2 } = createReleaseCandidate(db, { codingTaskId, repo, now: NOW });
    assert.ok(v2.manifest_version >= 2);
    assert.equal(db.prepare("SELECT status FROM production_release_authorization WHERE id=?").get(authorization.id).status, "superseded");
    const cur = getCurrentMigrationSafety(db, codingTaskId, { repo });
    assert.equal(cur.fresh, false);
    assert.ok(cur.stale_reasons.some((r) => /superseded|source_base_drift|release:/.test(r)));
    const elig = getPhase15ReleaseEligibility(db, phase15Ids(codingTaskId, authorization), { repo });
    assert.equal(elig.allowed, false);
    assert.throws(() => createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) }), /superseded/);
  } finally { git.cleanup(); db.close(); }
});

test("stale QA/staging/release evidence cannot create or stay fresh", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization } = approve(db, codingTaskId, repo);
    createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
    const qa = db.prepare("SELECT * FROM development_qa_current WHERE coding_task_id=?").get(codingTaskId);
    const old = db.prepare("SELECT * FROM development_qa_run WHERE id=?").get(qa.qa_run_id);
    const ts = NOW.toISOString();
    const newId = Number(db.prepare(`INSERT INTO development_qa_run(issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash, base_sha, head_sha, coding_result_hash, diff_hash, qa_version, qa_policy_fingerprint, input_fingerprint, status, final_result, attempt_count, max_attempts, next_attempt_at, created_at, completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'completed', 'PASS', 0, 3, ?, ?, ?)`).run(
      old.issue_id, old.coding_task_id, old.development_authorization_id, old.proposal_id, old.proposal_version, old.proposal_hash,
      old.base_sha, old.head_sha, old.coding_result_hash, old.diff_hash, old.qa_version, old.qa_policy_fingerprint, "qa-fp-new",
      ts, ts, ts,
    ).lastInsertRowid);
    db.prepare("UPDATE development_qa_current SET qa_run_id=?, input_fingerprint='qa-fp-new' WHERE coding_task_id=?").run(newId, codingTaskId);
    const cur = getCurrentMigrationSafety(db, codingTaskId, { repo });
    assert.equal(cur.fresh, false);
    assert.ok(cur.stale_reasons.some((r) => /newer_qa|qa_not_fresh|release:/.test(r)));
    assert.throws(() => createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) }), /newer provenance|QA stale|stale/);
    const elig = getPhase15ReleaseEligibility(db, phase15Ids(codingTaskId, authorization), { repo });
    assert.equal(elig.allowed, false);
  } finally { git.cleanup(); db.close(); }
});

test("same input fingerprint is idempotent; evidence change appends a new version", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization } = approve(db, codingTaskId, repo);
    const a1 = createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
    const a2 = createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
    assert.equal(a2.idempotent, true);
    assert.equal(a2.assessment.id, a1.assessment.id);
    patchQaMigration(db, codingTaskId, { schema: true, files: ["migrations/x.sql"] });
    const a3 = createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
    assert.notEqual(a3.assessment.id, a1.assessment.id);
    assert.equal(a3.assessment.assessment_version, 2);
    assert.equal(a3.assessment.clearance_result, "BLOCKED_UNKNOWN");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM production_migration_safety_assessment WHERE release_authorization_id=?").get(authorization.id).n, 2);
  } finally { git.cleanup(); db.close(); }
});

test("assessment body is immutable / append-only; no secrets or PII in snapshot", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization } = approve(db, codingTaskId, repo);
    patchQaMigration(db, codingTaskId, { schema: true, files: ["migrations/x.sql"], contact: "leak@example.com", ssh_key: "SECRET", password: "pw" });
    const created = createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
    const raw = JSON.stringify(created.assessment.evidence_snapshot);
    assert.doesNotMatch(raw, /leak@example\.com/);
    assert.doesNotMatch(raw, /SECRET|demopass|password":"pw/i);
    const id = created.assessment.id;
    assert.throws(() => db.prepare("UPDATE production_migration_safety_assessment SET clearance_result='CLEARED_ADDITIVE' WHERE id=?").run(id), /immutable/);
    assert.throws(() => db.prepare("UPDATE production_migration_safety_assessment SET evidence_snapshot='{}' WHERE id=?").run(id), /immutable/);
    assert.throws(() => db.prepare("DELETE FROM production_migration_safety_assessment WHERE id=?").run(id), /append-only/);
    const sanitized = sanitizeMigrationEvidence({ email: "a@b.com", token: "tok", nested: { database_url: "postgres://x" } });
    assert.equal(sanitized.email, "[REDACTED]");
    assert.equal(sanitized.token, "[REDACTED]");
    assert.equal(sanitized.nested.database_url, "[REDACTED]");
    const cols = db.prepare("PRAGMA table_info(production_migration_safety_assessment)").all().map((c) => c.name.toLowerCase());
    for (const c of cols) assert.doesNotMatch(c, /password|secret|ssh|token|credential/);
  } finally { git.cleanup(); db.close(); }
});

test("Phase 13 manifest remains immutable after Phase 14 assessment", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { rc, authorization } = approve(db, codingTaskId, repo);
    const before = db.prepare("SELECT manifest_hash, manifest_content FROM development_release_candidate WHERE id=?").get(rc.id);
    createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
    const after = db.prepare("SELECT manifest_hash, manifest_content FROM development_release_candidate WHERE id=?").get(rc.id);
    assert.equal(after.manifest_hash, before.manifest_hash);
    assert.equal(after.manifest_content, before.manifest_content);
    assert.throws(() => db.prepare("UPDATE development_release_candidate SET manifest_content='{}' WHERE id=?").run(rc.id), /immutable/);
  } finally { git.cleanup(); db.close(); }
});

test("Phase 15 cannot consume missing/stale/blocked clearance", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const missing = getPhase15ReleaseEligibility(db, { codingTaskId }, { repo });
    assert.equal(missing.allowed, false);
    assert.match(missing.reason, /identity_required|missing/);
    const { authorization } = approve(db, codingTaskId, repo);
    assert.equal(getPhase15ReleaseEligibility(db, phase15Ids(codingTaskId, authorization), { repo }).allowed, false);
    patchQaMigration(db, codingTaskId, { destructive: true, files: ["x.sql"] }, "REVIEW");
    createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
    const blocked = getPhase15ReleaseEligibility(db, phase15Ids(codingTaskId, authorization), { repo });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "phase14_clearance_blocked");
    assert.throws(() => assertPhase15MigrationClearance(db, phase15Ids(codingTaskId, authorization), { repo }), /cannot consume/);
  } finally { git.cleanup(); db.close(); }
});

test("P1: Phase 15 assertion requires every identity; opts cannot override", async () => {
  const db = openOpsDb(":memory:");
  const { codingTaskId, repo, git } = await makeStagedTask(db);
  try {
    const { authorization } = approve(db, codingTaskId, repo);
    createMigrationSafetyAssessment(db, { codingTaskId, repo, now: NOW, ...bind(authorization) });
    assert.equal(getCurrentMigrationSafety(db, codingTaskId, { repo }).fresh, true);
    const full = phase15Ids(codingTaskId, authorization);
    assert.equal(getPhase15ReleaseEligibility(db, full, { repo }).allowed, true);
    assert.equal(getPhase15ReleaseEligibility(db, { codingTaskId }, { repo }).allowed, false);
    assert.equal(getPhase15ReleaseEligibility(db, { codingTaskId }, { repo, ...bind(authorization) }).allowed, false);
    assert.throws(() => assertPhase15MigrationClearance(db, { codingTaskId }, { repo, ...bind(authorization) }), /identity_required/);
    for (const key of Object.keys(full)) {
      const omitted = { ...full };
      delete omitted[key];
      const omitR = getPhase15ReleaseEligibility(db, omitted, { repo });
      assert.equal(omitR.allowed, false, `omitted ${key}`);
      assert.equal(omitR.reason, "phase15_identity_required");
      const nulled = { ...full, [key]: null };
      assert.equal(getPhase15ReleaseEligibility(db, nulled, { repo }).allowed, false, `null ${key}`);
      const emptied = { ...full, [key]: "" };
      assert.equal(getPhase15ReleaseEligibility(db, emptied, { repo }).allowed, false, `empty ${key}`);
      const mismatched = { ...full, [key]: key === "manifestHash" || key === "headSha" || key === "artifactDigest" ? "deadbeefdeadbeefdeadbeefdeadbeef" : 999999 };
      const mis = getPhase15ReleaseEligibility(db, mismatched, { repo });
      assert.equal(mis.allowed, false, `mismatch ${key}`);
    }
    assertPhase15MigrationClearance(db, full, { repo });
  } finally { git.cleanup(); db.close(); }
});

test("no third human gate and no Production mutation/deploy/SSH/workflow", () => {
  assert.deepEqual(RELEASE_OWNER_ACTIONS, ["APPROVE_RELEASE", "REQUEST_CHANGES", "CANCEL_RELEASE"]);
  const files = [
    "ops/src/release/migrationSafety.js",
    "ops/src/release/migrationSafetyPolicy.js",
    "ops/src/qa/migrationEvidence.js",
  ];
  for (const f of files) {
    const txt = readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(txt, /gh\s+pr\s+merge|--auto\b|workflow_dispatch|deploy-v3\.yml|casaos-compose|ssh |force-with-lease|APPROVE_MIGRATION/i);
    assert.doesNotMatch(txt, /openai|anthropic|chat\.completions|makeAiProvider|evaluationProvider/i);
    assert.doesNotMatch(txt, /MIGRATION_SAFETY_ADDITIVE_SKIP_/);
  }
});
