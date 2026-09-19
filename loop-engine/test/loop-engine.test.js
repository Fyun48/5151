import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createTask,
  transition,
  testPassed,
  testFailed,
  recordCodeMetrics,
  applyOwnerDecision,
  TASK_STATE,
  OWNER_DECISION,
} from "../src/loopEngine.js";
import { verifyGiteaWebhookSignature } from "../src/giteaWebhook.js";

function runToReleaseCandidate(task) {
  transition(task, TASK_STATE.CODE);
  transition(task, TASK_STATE.TEST);
  testPassed(task);
  transition(task, TASK_STATE.IMPLEMENTATION_COMPLETE);
  transition(task, TASK_STATE.RELEASE_CANDIDATE);
  return task;
}

test("happy path plan -> release candidate", () => {
  const task = createTask({ id: "t1" });
  runToReleaseCandidate(task);
  assert.equal(task.state, TASK_STATE.RELEASE_CANDIDATE);
  assert.ok(task.audit.length >= 5);
});

test("self-fix loop retries then passes, bounded by max iterations", () => {
  const task = createTask({ id: "t2", budget: { maxSelfFixIterations: 2 } });
  transition(task, TASK_STATE.CODE);
  transition(task, TASK_STATE.TEST);
  testFailed(task);
  assert.equal(task.selfFixIterations, 1);
  transition(task, TASK_STATE.TEST);
  testFailed(task);
  assert.equal(task.selfFixIterations, 2);
  transition(task, TASK_STATE.TEST);
  // 3rd fix attempt exceeds budget
  assert.throws(() => testFailed(task), /max self-fix iterations/);
});

test("invalid transition is rejected", () => {
  const task = createTask();
  assert.throws(() => transition(task, TASK_STATE.TEST), /invalid transition/);
});

test("budget limits block entering CODE", () => {
  const task = createTask({ budget: { maxCostUsd: 10 } });
  recordCodeMetrics(task, { costUsd: 12 });
  assert.throws(() => transition(task, TASK_STATE.CODE), /max cost/);
});

test("owner decisions gate release", () => {
  const skip = runToReleaseCandidate(createTask({ id: "skip" }));
  applyOwnerDecision(skip, OWNER_DECISION.SKIP_REVIEW_AND_RELEASE);
  assert.equal(skip.state, TASK_STATE.RELEASE_READY);
  assert.ok(skip.audit.some((a) => a.code_review === "SKIPPED_BY_OWNER"));

  const review = runToReleaseCandidate(createTask({ id: "review" }));
  applyOwnerDecision(review, OWNER_DECISION.FINAL_REVIEW, { reviewerResult: { verdict: "approve" } });
  assert.equal(review.state, TASK_STATE.RELEASE_READY);

  const ret = runToReleaseCandidate(createTask({ id: "ret" }));
  applyOwnerDecision(ret, OWNER_DECISION.RETURN_TO_DEVELOPMENT);
  assert.equal(ret.state, TASK_STATE.CODE);
});

test("gitea webhook signature verifies and rejects tampering", () => {
  const secret = "webhook-secret";
  const payload = JSON.stringify({ ref: "refs/heads/master" });
  const sig = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  assert.equal(verifyGiteaWebhookSignature(secret, payload, sig), true);
  assert.equal(verifyGiteaWebhookSignature(secret, payload + "x", sig), false);
  assert.equal(verifyGiteaWebhookSignature(secret, payload, "sha256=deadbeef"), false);
  assert.equal(verifyGiteaWebhookSignature("", payload, sig), false);
});
