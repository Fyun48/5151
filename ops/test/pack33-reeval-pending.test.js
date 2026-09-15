import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.EVALUATION_PROVIDER = "stub";
process.env.PROPOSAL_PROVIDER = "stub";

import { openOpsDb } from "../src/opsDb.js";
import { createProduct, unsubscribeProduct } from "../src/products.js";
import { calculateAndStoreImpact } from "../src/impact.js";
import { runEvaluationOnce } from "../src/evaluationWorker.js";
import { makeStubEvaluationProvider } from "../src/ai/evaluationProvider.js";
import { runProposalOnce } from "../src/proposalWorker.js";
import { makeStubProposalProvider } from "../src/ai/proposalProvider.js";
import { getCurrentIssueProposal, submitOwnerDecision } from "../src/proposal.js";
import { findEntity } from "../src/stateMachine.js";
import {
  describeOwnerReevalOffer,
  describeOwnerUnblockOffer,
  ownerManualReevaluate,
  ownerUnblock,
} from "../src/reevaluation.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));
const NOW = new Date();
let seq = 1;
const state = (db, iid) => findEntity(db, `issue:${iid}`)?.state;

function link(db, iid, fid, aid) {
  db.prepare("INSERT INTO issue_feedback_link(issue_id, feedback_id, analysis_id, added_by, membership_status, active, created_at) VALUES (?, ?, ?, 'auto', 'active', 1, ?)").run(iid, fid, aid, NOW.toISOString());
}

function seedFeedback(db, { severity = "HIGH", category = "BUG", productId = null } = {}) {
  const i = seq++;
  const ts = NOW.toISOString();
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, contact, user_ref, app_version, received_at, product_id) VALUES (?, ?, 'v3', 'bug', ?, 'leak@example.com', ?, '3.47', ?, ?)").run(`d${i}`, `k${i}`, `c${i}`, `reporter-${i}`, ts, productId);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', ?, 's', ?, 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, category, severity, ts, ts, ts);
  const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 't')").run(fid, aid, ts);
  return { fid, aid };
}

function seedIssue(db, { members = 8, severity = "HIGH", category = "BUG", productId = null } = {}) {
  const ts = NOW.toISOString();
  const iid = Number(db.prepare("INSERT INTO issue_candidate(title,summary,category,clustering_version,status,product_id,created_at,updated_at) VALUES('t','s',?,'cluster-v1','open',?,?,?)").run(category, productId, ts, ts).lastInsertRowid);
  for (let k = 0; k < members; k++) {
    const f = seedFeedback(db, { severity, category, productId });
    link(db, iid, f.fid, f.aid);
  }
  calculateAndStoreImpact(db, iid, { now: NOW });
  return iid;
}

async function decideIssue(db, { members = 8, category = "BUG", decision, productId = null } = {}) {
  const iid = seedIssue(db, { members, category, productId });
  await runEvaluationOnce(db, { provider: makeStubEvaluationProvider(), config: { concurrency: 1 }, now: () => NOW });
  await runProposalOnce(db, { provider: makeStubProposalProvider(), config: { concurrency: 1 }, now: () => NOW });
  const cur = getCurrentIssueProposal(db, iid, { now: NOW });
  submitOwnerDecision(db, iid, { action: decision, proposalId: cur.id, proposalVersion: cur.proposal_version, proposalHash: cur.proposal_hash, now: NOW });
  calculateAndStoreImpact(db, iid, { now: NOW });
  return { iid, proposal: cur };
}

test("pending list offers Owner manual reeval after auto reevaluation stops", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const { iid } = await decideIssue(db, { decision: "DEFER", productId: "shop" });
  unsubscribeProduct(db, "shop");
  const offer = describeOwnerReevalOffer(db, iid, { now: NOW });
  assert.equal(offer.offered, true);
  assert.equal(offer.from_state, "DEFERRED");
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "reevaluation" && it.id === iid);
  assert.ok(item);
  assert.equal(item.reeval.offered, true);
  assert.match(item.note, /手動重評/);
  assert.match(item.note, /不會開 PR/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "reevaluation").length, 0);
  db.close();
});

test("manual reeval from the pending offer reopens evaluation and does not authorize coding", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { iid } = await decideIssue(db, { decision: "REJECT", productId: "shop" });
  unsubscribeProduct(db, "shop");
  const out = ownerManualReevaluate(db, iid, { actor: "owner", reason: "要重看範圍", now: NOW });
  assert.equal(out.reopened, true);
  assert.equal(state(db, iid), "EVALUATING");
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "reevaluation" && it.id === iid).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_authorization").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_coding_task").get().n, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.reevaluation.reopened'").get().n >= 1);
  db.close();
});

test("pending list offers unblock for a blocked issue without starting deploy", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const { iid } = await decideIssue(db, { decision: "BLOCK", productId: "shop" });
  const offer = describeOwnerUnblockOffer(db, iid);
  assert.equal(offer.offered, true);
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "blocked" && it.id === iid);
  assert.ok(item);
  assert.equal(item.state, "blocked");
  assert.equal(item.unblock.offered, true);
  assert.match(item.note, /只有 Owner 能解除/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "blocked").length, 0);
  db.close();
});

test("unblock from the pending offer reopens evaluation and does not deploy", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { iid } = await decideIssue(db, { decision: "BLOCK", productId: "shop" });
  const out = ownerUnblock(db, iid, { actor: "owner", reason: "誤封鎖", now: NOW });
  assert.equal(out.unblocked, true);
  assert.equal(state(db, iid), "EVALUATING");
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "blocked" && it.id === iid).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_coding_task").get().n, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.unblocked'").get().n >= 1);
  db.close();
});

test("owner_direct spoof cannot mint reeval or unblock from the pending offer", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const deferred = await decideIssue(db, { decision: "DEFER", productId: "shop" });
  unsubscribeProduct(db, "shop");
  assert.throws(
    () => ownerManualReevaluate(db, deferred.iid, { reason: "x", owner_direct: true, now: NOW }),
    (err) => err.status === 403,
  );
  const blocked = await decideIssue(db, { decision: "BLOCK", productId: "other" });
  assert.throws(
    () => ownerUnblock(db, blocked.iid, { reason: "x", owner_direct: true, now: NOW }),
    (err) => err.status === 403,
  );
  assert.equal(describeOwnerReevalOffer(db, deferred.iid, { now: NOW }).offered, true);
  assert.equal(describeOwnerUnblockOffer(db, blocked.iid).offered, true);
  assert.equal(state(db, deferred.iid), "DEFERRED");
  assert.equal(state(db, blocked.iid), "BLOCKED");
  db.close();
});

test("already-reopened or closed issues are not offered on the pending list", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const first = await decideIssue(db, { decision: "DEFER", productId: "shop" });
  unsubscribeProduct(db, "shop");
  ownerManualReevaluate(db, first.iid, { reason: "done", now: NOW });
  assert.equal(describeOwnerReevalOffer(db, first.iid, { now: NOW }).offered, false);

  const second = await decideIssue(db, { decision: "BLOCK", productId: "other" });
  db.prepare("UPDATE issue_candidate SET status='closed' WHERE id=?").run(second.iid);
  assert.equal(describeOwnerUnblockOffer(db, second.iid).offered, false);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "blocked" || (it.kind === "reevaluation" && it.id === first.iid)).length, 0);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "blocked").length, 0);
  db.close();
});

test("console exposes pending-list reeval and unblock without opening a coding or deploy path", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /自動重評已停的暫緩／拒絕議題可從未決清單手動重評/);
  assert.match(html, /已封鎖的議題可解除封鎖/);
  assert.match(html, /只重開評估，不會開 PR、也不會部署/);
  assert.match(html, /已授權 Owner 直達不經這個門/);
  assert.match(html, /console\.js\?v=20260915-pkg36/);
  assert.match(js, /PENDING_REEVAL/);
  assert.match(js, /PENDING_UNBLOCK/);
  assert.match(js, /手動重評/);
  assert.match(js, /解除封鎖/);
  assert.match(js, /\/ops\/api\/issues\/\$\{itemId\}\/reevaluation\/reopen/);
  assert.match(js, /\/ops\/api\/issues\/\$\{itemId\}\/unblock/);
  assert.doesNotMatch(js, /\/ops\/api\/coding-tasks\/\$\{itemId\}\/(execute|claim)/);
  assert.doesNotMatch(js, /owner_direct:\s*true/);
});
