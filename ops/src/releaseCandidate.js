import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { validateCodingTaskForQa, getCurrentCodingQA } from "./qaRun.js";
import { getCurrentCodingStaging } from "./stagingDeploy.js";
import { releaseConfigFromEnv, buildReleasePolicy, releasePolicyFingerprint, effectiveReleasePolicyFingerprint } from "./release/releasePolicy.js";
import { buildManifestContent, computeManifestHash, releaseInputFingerprint } from "./release/manifest.js";
import { notifyConfig, buildWebhookPayload, deliverWebhook } from "./notify/webhook.js";
import { rejectSpoofedOwnerDirect } from "./instructionSource.js";

export const RELEASE_OWNER_ACTIONS = ["APPROVE_RELEASE", "REQUEST_CHANGES", "CANCEL_RELEASE"];
function iso(now) { return (now instanceof Date ? now : new Date(now || Date.now())).toISOString(); }
function parse(v) { try { return v ? JSON.parse(v) : null; } catch { return null; } }

// 只有「確切、fresh 的 QA PASS + Staging PASS + 對應同一 QA run」的鏈可組 RC。source base drift 另行標記（不擋建立，但擋核准）。
export function validateReleaseChain(db, codingTaskId, { repo = null, env = process.env, now = new Date() } = {}) {
  const cfg = releaseConfigFromEnv(env);
  const { task, auth } = validateCodingTaskForQa(db, codingTaskId); // 涵蓋：coding task 合格、未取消、授權 active、proposal 相符
  const qa = getCurrentCodingQA(db, codingTaskId, { env });
  if (!qa) throw httpError("no current QA", 409);
  if (!qa.fresh) throw httpError(`QA stale (${(qa.stale_reasons || []).join(",")})`, 409);
  if (qa.final_result !== "PASS") throw httpError(`QA result ${qa.final_result} != PASS`, 409);
  const staging = getCurrentCodingStaging(db, codingTaskId, { env, now });
  if (!staging) throw httpError("no current staging", 409);
  if (!staging.fresh) throw httpError(`staging stale (${(staging.stale_reasons || []).join(",")})`, 409);
  if (staging.validation_result !== "PASS") throw httpError(`staging result ${staging.validation_result} != PASS`, 409);
  if (Number(staging.qa_run_id) !== Number(qa.id)) throw httpError("staging does not correspond to current QA run", 409);
  if (!staging.artifact_digest) throw httpError("no artifact digest", 409);
  if (String(staging.head_sha) !== String(task.head_sha)) throw httpError("staging head SHA mismatch", 409);
  const currentMaster = repo && repo.available ? repo.resolveRef(cfg.baseBranch) : null;
  const drift = currentMaster != null && String(currentMaster) !== String(task.base_sha);
  return { task, auth, qa, staging, currentMaster, drift, artifactDigest: staging.artifact_digest };
}

export function createReleaseCandidate(db, { codingTaskId, repo, env = process.env, now = new Date() }) {
  if (!repo || !repo.available) throw httpError("release repository gateway unavailable", 503);
  const cfg = releaseConfigFromEnv(env);
  const policy = buildReleasePolicy(cfg);
  const policyFp = releasePolicyFingerprint(policy);
  const ts = iso(now);
  const { task, auth, qa, staging, currentMaster, drift, artifactDigest } = validateReleaseChain(db, codingTaskId, { repo, env, now });
  const inputFp = releaseInputFingerprint({
    codingTaskId: Number(task.id), authorizationId: Number(auth.id), proposalId: Number(task.proposal_id), proposalVersion: Number(task.proposal_version), proposalHash: String(task.proposal_hash),
    baseSha: task.base_sha, headSha: task.head_sha, currentMaster, codingResultHash: task.result_hash, diffHash: qa.diff_hash,
    qaRunId: Number(qa.id), qaInputFp: qa.input_fingerprint, qaPolicyFp: qa.qa_policy_fingerprint,
    stagingId: Number(staging.id), stagingInputFp: staging.input_fingerprint, stagingPolicyFp: staging.staging_policy_fingerprint, stagingConfigFp: staging.config_fingerprint,
    artifactDigest, releasePolicyFp: policyFp,
  });
  const snapshot = parse(task.approved_scope_snapshot) || {};
  const taskObj = { id: task.id, base_sha: task.base_sha, head_sha: task.head_sha, changed_files: parse(task.changed_files) || [], diff_insertions: task.diff_insertions, diff_deletions: task.diff_deletions, protected_flags: parse(task.protected_flags) };
  const content = buildManifestContent({ snapshot, task: taskObj, auth, qa, staging, currentMaster });
  return withImmediateTx(db, () => {
    const existing = db.prepare("SELECT * FROM development_release_candidate WHERE release_input_fingerprint=? AND status!='cancelled' ORDER BY id DESC LIMIT 1").get(inputFp);
    if (existing) return { idempotent: true, candidate: publicRC(db, existing) };
    const version = 1 + (Number(db.prepare("SELECT MAX(manifest_version) m FROM development_release_candidate WHERE coding_task_id=?").get(Number(task.id)).m) || 0);
    const manifestHash = computeManifestHash({ content, version, headSha: task.head_sha, artifactDigest, releaseInputFingerprint: inputFp });
    // 新 manifest 版本 → 使該 coding task 既有 active 授權 supersede（舊核准不得涵蓋新 manifest）。
    for (const a of db.prepare("SELECT * FROM production_release_authorization WHERE coding_task_id=? AND status='active'").all(Number(task.id))) {
      db.prepare("UPDATE production_release_authorization SET status='superseded', superseded_at=?, superseded_reason='new_manifest_version' WHERE id=?").run(ts, a.id);
      appendAuditRow(db, { actor: "system", action: "issue.release.authorization_superseded", entityType: "production_release_authorization", entityId: String(a.id), data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), release_authorization_id: a.id, reason: "new_manifest_version" }, now });
    }
    const res = db.prepare(
      `INSERT INTO development_release_candidate(issue_id, coding_task_id, development_authorization_id, proposal_id, proposal_version, proposal_hash,
        qa_run_id, staging_deployment_id, manifest_version, release_manifest_version, release_policy_version, base_sha, head_sha, current_master_sha,
        source_tree_hash, coding_result_hash, diff_hash, artifact_id, artifact_digest, qa_input_fingerprint, qa_policy_fingerprint,
        staging_input_fingerprint, staging_policy_fingerprint, staging_config_fingerprint, release_policy_fingerprint, release_input_fingerprint,
        manifest_hash, manifest_content, source_base_drift, status, generated_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'completed', ?, ?)`,
    ).run(
      Number(task.issue_id), Number(task.id), Number(auth.id), Number(task.proposal_id), Number(task.proposal_version), String(task.proposal_hash),
      Number(qa.id), Number(staging.id), version, cfg.manifestVersion, cfg.policyVersion, task.base_sha, task.head_sha, currentMaster,
      staging.source_tree_hash || null, task.result_hash, qa.diff_hash, staging.artifact_id || null, artifactDigest, qa.input_fingerprint, qa.qa_policy_fingerprint,
      staging.input_fingerprint, staging.staging_policy_fingerprint, staging.config_fingerprint, policyFp, inputFp,
      manifestHash, JSON.stringify(content), drift ? 1 : 0, ts, ts,
    );
    const id = Number(res.lastInsertRowid);
    db.prepare(`INSERT INTO development_release_current(coding_task_id, release_manifest_id, manifest_version, manifest_hash, updated_at)
                VALUES (?,?,?,?,?) ON CONFLICT(coding_task_id) DO UPDATE SET release_manifest_id=excluded.release_manifest_id, manifest_version=excluded.manifest_version, manifest_hash=excluded.manifest_hash, updated_at=excluded.updated_at`)
      .run(Number(task.id), id, version, manifestHash, ts);
    // 通知 outbox（idempotent；未設 adapter → pending，不假造送達）。
    db.prepare(`INSERT OR IGNORE INTO release_notification(issue_id, coding_task_id, release_manifest_id, manifest_version, channel, status, payload, created_at, updated_at)
                VALUES (?,?,?,?, 'internal', 'pending', ?, ?, ?)`)
      .run(Number(task.issue_id), Number(task.id), id, version, JSON.stringify({ title: snapshot.title || "", manifest_version: version, head_sha: task.head_sha, artifact_digest: artifactDigest, qa_result: qa.final_result, staging_result: staging.validation_result, review_ref: `/ops/api/coding-tasks/${task.id}/release` }), ts, ts);
    appendAuditRow(db, { actor: "system", action: "issue.release_candidate.created", entityType: "development_release_candidate", entityId: String(id), data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), manifest_id: id, manifest_version: version, manifest_hash: manifestHash, head_sha: task.head_sha, artifact_digest: artifactDigest, qa_run_id: Number(qa.id), staging_deployment_id: Number(staging.id), source_base_drift: drift }, now });
    appendAuditRow(db, { actor: "system", action: "issue.release_candidate.current_changed", entityType: "development_release_current", entityId: String(task.id), data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), manifest_id: id, manifest_version: version } });
    appendAuditRow(db, { actor: "system", action: "issue.release.notification_queued", entityType: "development_release_candidate", entityId: String(id), data: { issue_id: Number(task.issue_id), coding_task_id: Number(task.id), manifest_id: id, manifest_version: version } });
    return { candidate: publicRC(db, db.prepare("SELECT * FROM development_release_candidate WHERE id=?").get(id)) };
  });
}

export function publicRC(db, row, { withManifest = false } = {}) {
  if (!row) return null;
  const out = {
    id: Number(row.id), issue_id: Number(row.issue_id), coding_task_id: Number(row.coding_task_id),
    development_authorization_id: Number(row.development_authorization_id), proposal_id: Number(row.proposal_id),
    proposal_version: Number(row.proposal_version), proposal_hash: row.proposal_hash, qa_run_id: Number(row.qa_run_id),
    staging_deployment_id: Number(row.staging_deployment_id), manifest_version: Number(row.manifest_version),
    release_manifest_version: row.release_manifest_version, base_sha: row.base_sha, head_sha: row.head_sha,
    current_master_sha: row.current_master_sha, coding_result_hash: row.coding_result_hash, diff_hash: row.diff_hash,
    artifact_id: row.artifact_id, artifact_digest: row.artifact_digest, release_policy_fingerprint: row.release_policy_fingerprint,
    release_input_fingerprint: row.release_input_fingerprint, manifest_hash: row.manifest_hash,
    source_base_drift: !!row.source_base_drift, status: row.status, generated_at: row.generated_at, created_at: row.created_at,
  };
  if (withManifest) out.manifest = parse(row.manifest_content);
  return out;
}

export function currentReleaseDecision(db, codingTaskId) {
  const latest = db.prepare("SELECT * FROM release_owner_decision WHERE coding_task_id=? ORDER BY id DESC LIMIT 1").get(Number(codingTaskId)) || null;
  const activeAuth = db.prepare("SELECT * FROM production_release_authorization WHERE coding_task_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(Number(codingTaskId)) || null;
  let label = "never_reviewed";
  if (activeAuth) label = "approved_release";
  else if (latest) label = latest.action === "REQUEST_CHANGES" ? "changes_requested" : latest.action === "CANCEL_RELEASE" ? "cancelled" : (latest.action === "APPROVE_RELEASE" ? "superseded_approval" : "reviewed");
  return { label, latest_decision: latest ? publicDecision(latest) : null, active_authorization: activeAuth ? publicAuthorization(activeAuth) : null };
}
export function publicDecision(row) { return row ? { id: Number(row.id), release_manifest_id: Number(row.release_manifest_id), manifest_version: Number(row.manifest_version), manifest_hash: row.manifest_hash, action: row.action, actor: row.actor, reason: row.reason, created_at: row.created_at } : null; }
export function publicAuthorization(row) { return row ? { id: Number(row.id), release_manifest_id: Number(row.release_manifest_id), release_manifest_version: Number(row.release_manifest_version), manifest_hash: row.manifest_hash, head_sha: row.head_sha, artifact_digest: row.artifact_digest, approved_by: row.approved_by, approved_at: row.approved_at, status: row.status, authorization_hash: row.authorization_hash } : null; }

// canonical 當前 RC + 新鮮度（Phase 14/15 不需以時間猜測）。
export function getCurrentReleaseCandidate(db, codingTaskId, { repo = null, env = process.env, now = new Date() } = {}) {
  const cur = db.prepare("SELECT * FROM development_release_current WHERE coding_task_id=?").get(Number(codingTaskId));
  if (!cur) return null;
  const rc = db.prepare("SELECT * FROM development_release_candidate WHERE id=?").get(Number(cur.release_manifest_id));
  if (!rc || rc.status !== "completed") return null;
  const cfg = releaseConfigFromEnv(env);
  const reasons = [];
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(codingTaskId));
  if (!task) reasons.push("coding_task_missing");
  else {
    if (task.status === "cancelled") reasons.push("coding_task_cancelled");
    if (String(task.head_sha) !== String(rc.head_sha)) reasons.push("head_sha_changed");
    if (String(task.result_hash || "") !== String(rc.coding_result_hash || "")) reasons.push("coding_result_hash_changed");
  }
  const auth = db.prepare("SELECT * FROM development_authorization WHERE id=?").get(Number(rc.development_authorization_id));
  if (!auth || auth.status !== "active" || String(auth.proposal_hash) !== String(rc.proposal_hash)) reasons.push("authorization_mismatch");
  const qa = getCurrentCodingQA(db, codingTaskId, { env });
  if (!qa || !qa.fresh || qa.final_result !== "PASS") reasons.push("qa_not_fresh_pass");
  else if (Number(qa.id) !== Number(rc.qa_run_id)) reasons.push("qa_run_changed");
  else if (String(qa.diff_hash) !== String(rc.diff_hash)) reasons.push("diff_hash_changed");
  const staging = getCurrentCodingStaging(db, codingTaskId, { env, now });
  if (!staging || !staging.fresh || staging.validation_result !== "PASS") reasons.push("staging_not_fresh_pass");
  else {
    if (Number(staging.id) !== Number(rc.staging_deployment_id)) reasons.push("staging_changed");
    if (String(staging.artifact_digest) !== String(rc.artifact_digest)) reasons.push("artifact_digest_changed");
  }
  if (effectiveReleasePolicyFingerprint(env) !== rc.release_policy_fingerprint) reasons.push("release_policy_changed");
  // source base drift：產生當時已漂移，或現在 master 已前進超出 RC 基準。
  if (rc.source_base_drift) reasons.push("source_base_drift");
  if (repo && repo.available) {
    const master = repo.resolveRef(cfg.baseBranch);
    if (master && String(master) !== String(rc.base_sha) && !reasons.includes("source_base_drift")) reasons.push("source_base_drift");
  } else if (cfg.sourceBaseDriftPolicy === "fail_closed") {
    reasons.push("source_base_unverified");
  }
  return { ...publicRC(db, rc, { withManifest: true }), fresh: reasons.length === 0, stale: reasons.length > 0, stale_reasons: reasons, current_decision: currentReleaseDecision(db, codingTaskId) };
}

export function getReleaseCandidateView(db, codingTaskId, { repo = null, env = process.env, now = new Date() } = {}) {
  const task = db.prepare("SELECT * FROM development_coding_task WHERE id=?").get(Number(codingTaskId));
  if (!task) throw httpError("coding task not found", 404);
  const current = getCurrentReleaseCandidate(db, codingTaskId, { repo, env, now });
  const history = db.prepare("SELECT * FROM development_release_candidate WHERE coding_task_id=? ORDER BY id DESC LIMIT 50").all(Number(codingTaskId)).map((r) => publicRC(db, r));
  const decisions = db.prepare("SELECT * FROM release_owner_decision WHERE coding_task_id=? ORDER BY id DESC LIMIT 100").all(Number(codingTaskId)).map(publicDecision);
  return { coding_task_id: Number(codingTaskId), issue_id: Number(task.issue_id), current, history, decisions };
}
export function getReleaseManifest(db, manifestId) {
  const row = db.prepare("SELECT * FROM development_release_candidate WHERE id=?").get(Number(manifestId));
  return row ? publicRC(db, row, { withManifest: true }) : null;
}

// ── Owner Gate #2 ──
export function submitOwnerReleaseDecision(db, opts) {
  rejectSpoofedOwnerDirect(opts);
  const { codingTaskId, action, manifestId, manifestVersion, manifestHash, artifactDigest, headSha, actor = "owner", reason = null, repo = null, env = process.env, now = new Date() } = opts || {};
  const act = String(action || "").toUpperCase();
  if (!RELEASE_OWNER_ACTIONS.includes(act)) throw httpError(`invalid action: ${action}`, 400);
  const ts = iso(now);
  return withImmediateTx(db, () => {
    const cur = db.prepare("SELECT * FROM development_release_current WHERE coding_task_id=?").get(Number(codingTaskId));
    if (!cur) throw httpError("no current release candidate", 404);
    const rc = db.prepare("SELECT * FROM development_release_candidate WHERE id=?").get(Number(cur.release_manifest_id));
    if (!rc) throw httpError("release candidate missing", 404);
    // 綁定確切 manifest id/version/hash（擋 TOCTOU / 舊分頁核准舊版）。
    if (Number(manifestId) !== Number(rc.id)) throw httpError("manifest is not current (superseded)", 409);
    if (Number(manifestVersion) !== Number(rc.manifest_version)) throw httpError("manifest_version mismatch", 409);
    if (String(manifestHash) !== String(rc.manifest_hash)) throw httpError("manifest_hash mismatch", 409);

    if (act === "APPROVE_RELEASE") {
      if (String(artifactDigest) !== String(rc.artifact_digest)) throw httpError("artifact_digest mismatch", 409);
      if (String(headSha) !== String(rc.head_sha)) throw httpError("head_sha mismatch", 409);
      // 冪等：同 manifest 已有 active 授權 → 回傳現有。
      const existing = db.prepare("SELECT * FROM production_release_authorization WHERE release_manifest_id=? AND manifest_hash=? AND status='active'").get(Number(rc.id), String(rc.manifest_hash));
      if (existing) return { idempotent: true, authorization: publicAuthorization(existing) };
      // 交易內再驗新鮮度（QA/Staging fresh PASS、無 drift、master 有效）。
      const fresh = getCurrentReleaseCandidate(db, codingTaskId, { repo, env, now });
      if (!fresh || !fresh.fresh) throw httpError(`cannot approve stale release candidate: ${(fresh?.stale_reasons || ["unknown"]).join(",")}`, 409);
      const authHash = createHash("sha256").update(JSON.stringify({ manifest_id: Number(rc.id), manifest_version: Number(rc.manifest_version), manifest_hash: rc.manifest_hash, head_sha: rc.head_sha, artifact_digest: rc.artifact_digest, coding_task_id: Number(codingTaskId) })).digest("hex");
      recordDecision(db, { rc, action: act, actor, reason, ts });
      const r = db.prepare(
        `INSERT INTO production_release_authorization(issue_id, coding_task_id, development_authorization_id, release_manifest_id, release_manifest_version, manifest_hash,
          proposal_id, proposal_version, proposal_hash, qa_run_id, staging_deployment_id, base_sha, head_sha, artifact_digest, authorization_hash, approved_by, approved_at, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?)`,
      ).run(Number(rc.issue_id), Number(codingTaskId), Number(rc.development_authorization_id), Number(rc.id), Number(rc.manifest_version), String(rc.manifest_hash),
        Number(rc.proposal_id), Number(rc.proposal_version), String(rc.proposal_hash), Number(rc.qa_run_id), Number(rc.staging_deployment_id), rc.base_sha, rc.head_sha, rc.artifact_digest, authHash, actor, ts, ts);
      const authId = Number(r.lastInsertRowid);
      appendAuditRow(db, { actor, action: "issue.release.approved", entityType: "development_release_candidate", entityId: String(rc.id), data: { issue_id: Number(rc.issue_id), coding_task_id: Number(codingTaskId), manifest_id: Number(rc.id), manifest_version: Number(rc.manifest_version), manifest_hash: rc.manifest_hash, head_sha: rc.head_sha, artifact_digest: rc.artifact_digest }, now });
      appendAuditRow(db, { actor, action: "issue.release.authorization_created", entityType: "production_release_authorization", entityId: String(authId), data: { issue_id: Number(rc.issue_id), coding_task_id: Number(codingTaskId), release_authorization_id: authId, manifest_id: Number(rc.id), manifest_version: Number(rc.manifest_version), manifest_hash: rc.manifest_hash, head_sha: rc.head_sha, artifact_digest: rc.artifact_digest }, now });
      return { authorization: publicAuthorization(db.prepare("SELECT * FROM production_release_authorization WHERE id=?").get(authId)) };
    }

    recordDecision(db, { rc, action: act, actor, reason, ts });
    if (act === "REQUEST_CHANGES") {
      const note = reason ? String(reason).trim() : "";
      if (!note) throw httpError("REQUEST_CHANGES requires a written reason", 400);
      appendAuditRow(db, { actor, action: "issue.release.changes_requested", entityType: "development_release_candidate", entityId: String(rc.id), data: { issue_id: Number(rc.issue_id), coding_task_id: Number(codingTaskId), manifest_id: Number(rc.id), manifest_version: Number(rc.manifest_version) }, now });
      return { changes_requested: true };
    }
    // CANCEL_RELEASE：若有 active 授權則 supersede；保留所有證據。
    for (const a of db.prepare("SELECT * FROM production_release_authorization WHERE coding_task_id=? AND status='active'").all(Number(codingTaskId))) {
      db.prepare("UPDATE production_release_authorization SET status='superseded', superseded_at=?, superseded_reason='release_cancelled' WHERE id=?").run(ts, a.id);
    }
    appendAuditRow(db, { actor, action: "issue.release.cancelled", entityType: "development_release_candidate", entityId: String(rc.id), data: { issue_id: Number(rc.issue_id), coding_task_id: Number(codingTaskId), manifest_id: Number(rc.id), manifest_version: Number(rc.manifest_version) }, now });
    return { cancelled: true };
  });
}
function recordDecision(db, { rc, action, actor, reason, ts }) {
  db.prepare(`INSERT INTO release_owner_decision(issue_id, coding_task_id, release_manifest_id, manifest_version, manifest_hash, action, actor, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(Number(rc.issue_id), Number(rc.coding_task_id), Number(rc.id), Number(rc.manifest_version), String(rc.manifest_hash), action, actor, reason ? String(reason).slice(0, 1000) : null, ts);
}

// ── 通知 outbox retry（idempotent；不改 Gate#2 狀態、不重建 RC；無 adapter → 不假造送達） ──
export async function retryReleaseNotification(db, notificationId, {
  actor = "owner",
  now = new Date(),
  env = process.env,
  sender = null,
} = {}) {
  const n = db.prepare("SELECT * FROM release_notification WHERE id=?").get(Number(notificationId));
  if (!n) throw httpError("notification not found", 404);
  if (n.status === "sent") return { idempotent: true, status: "sent" };

  const cfg = notifyConfig(env);
  const deliver = sender || (cfg.configured
    ? (payload) => deliverWebhook(cfg.url, payload, { timeoutMs: cfg.timeoutMs })
    : null);

  if (!deliver) {
    return withImmediateTx(db, () => {
      db.prepare("UPDATE release_notification SET attempt_count=attempt_count+1, updated_at=? WHERE id=?").run(iso(now), Number(n.id));
      appendAuditRow(db, { actor, action: "issue.release.notification_failed", entityType: "release_notification", entityId: String(n.id), data: { issue_id: Number(n.issue_id), coding_task_id: Number(n.coding_task_id), manifest_id: Number(n.release_manifest_id), reason: "no_adapter_configured" }, now });
      return { retried: true, status: "pending", reason: "no_adapter_configured" };
    });
  }

  const parsed = parse(n.payload) || {};
  const payload = buildWebhookPayload({
    event: "ops.release.candidate",
    title: parsed.title || `Release candidate #${n.manifest_version}`,
    text: `議題 #${n.issue_id} 已可審核發布（coding task ${n.coding_task_id}）。`,
    fields: [
      { name: "issue", value: n.issue_id },
      { name: "coding_task", value: n.coding_task_id },
      { name: "manifest", value: n.manifest_version },
    ],
    channel: cfg.channel,
  });
  const result = await deliver(payload);
  return withImmediateTx(db, () => {
    const latest = db.prepare("SELECT * FROM release_notification WHERE id=?").get(Number(n.id));
    if (!latest) throw httpError("notification not found", 404);
    if (latest.status === "sent") return { idempotent: true, status: "sent" };
    db.prepare("UPDATE release_notification SET attempt_count=attempt_count+1, updated_at=? WHERE id=?").run(iso(now), Number(n.id));
    if (result.ok) {
      db.prepare("UPDATE release_notification SET status='sent', updated_at=? WHERE id=?").run(iso(now), Number(n.id));
      appendAuditRow(db, { actor, action: "issue.release.notification_sent", entityType: "release_notification", entityId: String(n.id), data: { issue_id: Number(n.issue_id), coding_task_id: Number(n.coding_task_id), manifest_id: Number(n.release_manifest_id), channel: cfg.channel }, now });
      return { retried: true, status: "sent" };
    }
    appendAuditRow(db, { actor, action: "issue.release.notification_failed", entityType: "release_notification", entityId: String(n.id), data: { issue_id: Number(n.issue_id), coding_task_id: Number(n.coding_task_id), manifest_id: Number(n.release_manifest_id), reason: result.reason || "send_failed" }, now });
    return { retried: true, status: "pending", reason: result.reason || "send_failed" };
  });
}
export function listReleaseNotifications(db, codingTaskId) {
  return db.prepare("SELECT * FROM release_notification WHERE coding_task_id=? ORDER BY id DESC").all(Number(codingTaskId)).map((n) => ({ id: Number(n.id), manifest_id: Number(n.release_manifest_id), manifest_version: Number(n.manifest_version), channel: n.channel, status: n.status, attempt_count: Number(n.attempt_count), payload: parse(n.payload) }));
}
