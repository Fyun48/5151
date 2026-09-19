import "./secretAtRestKey.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct } from "../src/products.js";
import { describeGate1Offer, submitOwnerDecision } from "../src/proposal.js";
import { listPendingWork } from "../src/exitDrill.js";
import { createEntityRow, transitionRow, findEntity } from "../src/stateMachine.js";

const root = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-09-13T00:00:00.000Z");

function seedWaitingProposal(db, productId, title = "Gate1 未決清單驗收") {
  const ts = NOW.toISOString();
  const issueId = Number(db.prepare(`
    INSERT INTO issue_candidate(title, summary, category, clustering_version, status, product_id, created_at, updated_at)
    VALUES (?, 's', 'BUG', 'cluster-v1', 'open', ?, ?, ?)
  `).run(title, productId, ts, ts).lastInsertRowid);
  const propId = Number(db.prepare(`
    INSERT INTO issue_proposal(issue_id, proposal_version, generation_version, proposal_hash, status, retry_count, max_retries, next_attempt_at, created_at)
    VALUES (?, 1, 'proposal-v1', 'hash-gate1', 'completed', 0, 5, ?, ?)
  `).run(issueId, ts, ts).lastInsertRowid);
  db.prepare(`
    INSERT INTO issue_proposal_current(issue_id, proposal_id, proposal_version, proposal_hash, input_fingerprint, updated_at)
    VALUES (?, ?, 1, 'hash-gate1', 'fp-gate1', ?)
  `).run(issueId, propId, ts);
  createEntityRow(db, { entityType: "issue", id: `issue:${issueId}`, actor: "test", now: NOW });
  transitionRow(db, { id: `issue:${issueId}`, to: "EVALUATING", actor: "test", now: NOW });
  transitionRow(db, { id: `issue:${issueId}`, to: "WAITING_OWNER_APPROVAL", actor: "test", now: NOW });
  return { issueId, propId };
}

test("pending list offers Gate #1 for a never-reviewed current proposal", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const { issueId, propId } = seedWaitingProposal(db, "shop");
  const offer = describeGate1Offer(db, issueId);
  assert.equal(offer.offered, true);
  assert.equal(offer.proposal_id, propId);
  assert.equal(offer.proposal_hash, "hash-gate1");
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "owner_approval" && it.id === issueId);
  assert.ok(item);
  assert.equal(item.state, "waiting_development");
  assert.equal(item.blocking, false);
  assert.equal(item.gate1.offered, true);
  assert.equal(item.gate1.proposal_id, propId);
  assert.match(item.note, /核准只寫開發授權/);
  assert.match(item.note, /要求修改必須寫原因/);
  assert.match(item.note, /Owner 直達不經這個門/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "owner_approval").length, 0);
  db.close();
});

test("REQUEST_CHANGES from the pending offer leaves the list and does not authorize coding", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, propId } = seedWaitingProposal(db, "shop", "要求修改");
  const out = submitOwnerDecision(db, issueId, {
    action: "REQUEST_CHANGES",
    proposalId: propId,
    proposalVersion: 1,
    proposalHash: "hash-gate1",
    reason: "請縮小範圍",
    now: NOW,
  });
  assert.equal(out.changes_requested, true);
  assert.equal(findEntity(db, `issue:${issueId}`).state, "PROPOSAL_CHANGES_REQUESTED");
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "owner_approval" && it.id === issueId).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_authorization").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_coding_task").get().n, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.proposal.changes_requested'").get().n >= 1);
  db.close();
});

test("DEFER from the pending offer leaves the list and does not deploy", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, propId } = seedWaitingProposal(db, "shop", "暫緩");
  const out = submitOwnerDecision(db, issueId, {
    action: "DEFER",
    proposalId: propId,
    proposalVersion: 1,
    proposalHash: "hash-gate1",
    reason: "owner_console",
    now: NOW,
  });
  assert.equal(out.deferred, true);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "owner_approval" && it.id === issueId).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_authorization").get().n, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.proposal.deferred'").get().n >= 1);
  db.close();
});

test("stale proposal binding and owner_direct spoof cannot mint Gate #1 from the pending offer", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const { issueId, propId } = seedWaitingProposal(db, "shop", "綁定");
  assert.throws(
    () => submitOwnerDecision(db, issueId, {
      action: "APPROVE_DEVELOPMENT",
      proposalId: propId,
      proposalVersion: 1,
      proposalHash: "old-hash",
    }),
    (err) => err.status === 409 && /proposal_hash mismatch/.test(err.message),
  );
  assert.throws(
    () => submitOwnerDecision(db, issueId, {
      action: "APPROVE_DEVELOPMENT",
      proposalId: propId,
      proposalVersion: 1,
      proposalHash: "hash-gate1",
      owner_direct: true,
    }),
    (err) => err.status === 403,
  );
  assert.equal(describeGate1Offer(db, issueId).offered, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM development_authorization").get().n, 0);
  db.close();
});

test("already-decided or missing current proposals are not offered on the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const first = seedWaitingProposal(db, "shop", "已決策");
  submitOwnerDecision(db, first.issueId, {
    action: "REJECT",
    proposalId: first.propId,
    proposalVersion: 1,
    proposalHash: "hash-gate1",
    reason: "done",
    now: NOW,
  });
  assert.equal(describeGate1Offer(db, first.issueId).offered, false);

  const second = seedWaitingProposal(db, "shop", "已關議題");
  db.prepare("UPDATE issue_candidate SET status='closed' WHERE id=?").run(second.issueId);
  assert.equal(describeGate1Offer(db, second.issueId).offered, false);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "owner_approval").length, 0);
  db.close();
});

test("console exposes pending-list Gate #1 without opening a coding or deploy path", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /待核准的開發提案可從未決清單核准、要求修改、暫緩、拒絕或封鎖/);
  assert.match(html, /核准只寫開發授權，不會開 PR、也不會部署/);
  assert.match(html, /要求修改必須寫原因/);
  assert.match(html, /已授權 Owner 直達不經這個門/);
  assert.match(html, /console\.js\?v=20260915-pkg37/);
  assert.match(js, /PENDING_GATE1/);
  assert.match(js, /核准開發/);
  assert.match(js, /請說明要改什麼/);
  assert.match(js, /\/ops\/api\/issues\/\$\{itemId\}\/proposal\/decision/);
  assert.doesNotMatch(js, /\/ops\/api\/coding-tasks\/\$\{itemId\}\/(execute|claim)/);
  assert.doesNotMatch(js, /owner_direct:\s*true/);
});
