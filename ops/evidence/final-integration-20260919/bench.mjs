/**
 * OPS final-integration seeded benchmark (Packages 0-37 → PR #369).
 * Local, in-memory SQLite only. Never touches Production, never opens a socket.
 * Run:  node ops/evidence/final-integration-20260919/bench.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { openOpsDb } from "../../src/opsDb.js";
import { createEntity, getEntity, findEntity } from "../../src/stateMachine.js";
import { appendAuditRow, listAudit } from "../../src/audit.js";
import { getCurrentIssueProposal } from "../../src/proposal.js";
import { seedProductionStable } from "../../src/release/productionRelease.js";
import { describeRollbackIdentityRecord } from "../../src/release/rollbackContract.js";
import { ensureDefaultProduct, listProducts } from "../../src/products.js";
import { ingestFeedback } from "../../src/ingest.js";
import { listPendingWork } from "../../src/exitDrill.js";
import { listIssuesWithLifecycle, getDashboard } from "../../src/dashboard.js";
import { ensureCrmReplicaSchema, listCrmViews } from "../../src/crmReplica.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-09-19T00:00:00.000Z");
const SCALES = [100, 1000, 10000];
const ITERS_READ = 20;
const ITERS_WRITE = 12;

function iso(n) { return new Date(NOW.getTime() + n).toISOString(); }
function round(n) { return Math.round(n * 1000) / 1000; }

/** Wraps db.prepare so we can count the SQL statements a path issues. */
function instrument(db) {
  const orig = db.prepare.bind(db);
  let count = 0;
  db.prepare = (sql, ...rest) => { count += 1; return orig(sql, ...rest); };
  return { reset: () => { count = 0; }, count: () => count };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function bench(label, fn, iterations) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return { label, iterations, p50_ms: round(percentile(samples, 50)), p95_ms: round(percentile(samples, 95)), max_ms: round(samples[samples.length - 1]), avg_ms: round(sum / samples.length) };
}

function seed(n) {
  const db = openOpsDb(":memory:");
  const probe = instrument(db);
  const insIssue = db.prepare(
    "INSERT INTO issue_candidate(title, summary, category, clustering_version, status, issue_kind, product_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const insProposal = db.prepare(
    `INSERT INTO issue_proposal(issue_id, proposal_version, generation_version, input_fingerprint, policy_fingerprint,
       proposal_hash, final_recommendation, title, problem_statement, proposed_change, status, provider, model,
       next_attempt_at, generated_at, created_at, subscription_generation)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insCurrent = db.prepare(
    "INSERT INTO issue_proposal_current(issue_id, proposal_id, proposal_version, proposal_hash, input_fingerprint, updated_at) VALUES (?,?,?,?,?,?)",
  );

  const issueIds = [];
  for (let i = 1; i <= n; i += 1) {
    const info = insIssue.run(`issue-${i}`, "seeded", "BUG", "bench-v1", "open", "normal", "v3", iso(i), iso(i));
    const issueId = Number(info.lastInsertRowid);
    const proposalId = Number(insProposal.run(
      issueId, 1, "gen-v1", `fp-${i}`, "policy-fp", `hash-${i}`, "FIX", `title-${i}`,
      "problem", "change", "completed", "stub", "stub-v1", iso(i), iso(i), iso(i), 0,
    ).lastInsertRowid);
    insCurrent.run(issueId, proposalId, 1, `hash-${i}`, `fp-${i}`, iso(i));
    issueIds.push(issueId);
  }
  for (let i = 1; i <= n; i += 1) {
    createEntity(db, { entityType: "lifecycle", id: `issue-entity-${i}`, actor: "bench", meta: { issue: i }, now: NOW });
  }
  // 直接補 state_transition 列（唯一 idempotency_key），讓 dedup 查詢打在真實資料上。
  const insTransition = db.prepare(
    "INSERT INTO state_transition(entity_type, entity_id, from_state, to_state, actor, idempotency_key, entity_version, created_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (let i = 1; i <= n; i += 1) {
    insTransition.run("lifecycle", `issue-entity-${i}`, "initial", "seeded", "bench", `bench-key-${i}`, 1, iso(i));
  }
  for (let i = 1; i <= n; i += 1) {
    appendAuditRow(db, { actor: "bench", action: "bench.seed", entityType: "lifecycle", entityId: `issue-entity-${i}`, data: { i }, now: NOW });
  }
  seedProductionStable(db, {
    sourceSha: "b".repeat(40), artifactDigest: "sha256:" + "33".repeat(32), workflowRunId: "33999999999",
    provenance: { kind: "bench" }, staticTreeHash: "cd".repeat(32), schemaCompat: "compatible", now: NOW,
  });

  // 產品路徑種子：feedback + pending analysis + CRM replica + 多站（v3 product）。
  ensureDefaultProduct(db, { now: NOW });
  ensureCrmReplicaSchema(db);
  const insFeedback = db.prepare(
    "INSERT INTO ingested_feedback(product_id, delivery_id, idempotency_key, source, kind, content, contact, submitted_at, received_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const insAnalysis = db.prepare(
    "INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, prompt_version, status, next_attempt_at, created_at) VALUES (?,?,?,?,?,?,?)",
  );
  const insCrm = db.prepare(
    "INSERT INTO ingested_crm_contact(product_id, delivery_id, idempotency_key, external_contact_id, display_name, email, phone, last_synced_at, received_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  for (let i = 1; i <= n; i += 1) {
    const f = insFeedback.run("v3", `d-${i}`, `k-${i}`, "web", "bug", `content-${i}`, `user-${i}`, iso(i), iso(i));
    insAnalysis.run(Number(f.lastInsertRowid), "classification", 1, "c-v1", "pending", iso(i), iso(i));
    insCrm.run("v3", `cd-${i}`, `ck-${i}`, `ext-${i}`, `contact-${i}`, `c${i}@example.test`, `09${i}`, iso(i), iso(i));
  }

  const counts = {};
  for (const table of ["issue_candidate", "issue_proposal", "issue_proposal_current", "state_entity", "state_transition", "audit_log", "production_stable_current"]) {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
  }
  return { db, probe, issueIds, counts };
}

function explain(db, sql) {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  const text = rows.map((r) => r.detail || "").join(" | ");
  return { sql, search_nodes: (text.match(/SEARCH/gi) || []).length, scan_nodes: (text.match(/SCAN/gi) || []).length, plan: text };
}

function runScale(n) {
  const { db, probe, issueIds, counts } = seed(n);
  const read = (sql, fn, iterations = ITERS_READ) => {
    const plan = explain(db, sql);
    probe.reset();
    const b = bench(plan.sql, fn, iterations);
    return { ...b, query_count: round(probe.count() / iterations), ...plan };
  };

  const proposalPath = read(
    "SELECT * FROM issue_proposal_current WHERE issue_id = ?",
    (i) => getCurrentIssueProposal(db, issueIds[i % issueIds.length], { now: NOW }),
  );
  const entityPath = read(
    "SELECT * FROM state_entity WHERE id = ?",
    (i) => getEntity(db, `issue-entity-${(i % n) + 1}`),
  );
  const findPath = read(
    "SELECT * FROM state_entity WHERE entity_type = ? LIMIT 1",
    (i) => findEntity(db, `issue-entity-${(i % n) + 1}`),
  );
  const dedupPath = read(
    "SELECT * FROM state_transition WHERE idempotency_key = ?",
    (i) => db.prepare("SELECT * FROM state_transition WHERE idempotency_key = ?").get(`missing-key-${i}`),
  );
  const auditPath = read(
    "SELECT * FROM audit_log ORDER BY id DESC LIMIT 200",
    () => listAudit(db, { limit: 200, offset: 0 }),
  );

  probe.reset();
  const stableWrite = bench("seedProductionStable (idempotent upsert)", () => {
    seedProductionStable(db, {
      sourceSha: "b".repeat(40), artifactDigest: "sha256:" + "33".repeat(32), workflowRunId: "33999999999",
      provenance: { kind: "bench" }, staticTreeHash: "cd".repeat(32), schemaCompat: "compatible", now: NOW,
    });
  }, ITERS_WRITE);
  stableWrite.query_count = round(probe.count() / ITERS_WRITE);

  const rollbackDescribe = bench("describeRollbackIdentityRecord (pure)", () => {
    describeRollbackIdentityRecord({ current: { source_sha: "b".repeat(40), artifact_digest: "sha256:" + "33".repeat(32), static_tree_hash: "cd".repeat(32), schema_compat: "compatible" }, previous: null, provenance: { kind: "bench" } });
  }, ITERS_READ);
  rollbackDescribe.query_count = 0;

  // 產品路徑（feedback ingestion / pending queue / cluster / CRM / dashboard / multi-site）。
  probe.reset();
  const ingestPath = bench("ingestFeedback (write)", (i) => {
    ingestFeedback(db, { deliveryId: `bench-${n}-${i}`, payload: { idempotency_key: `bk-${n}-${i}`, kind: "bug", content: "x" }, payloadHash: `h-${n}-${i}`, productId: "v3", now: NOW });
  }, ITERS_WRITE);
  ingestPath.query_count = round(probe.count() / ITERS_WRITE);

  // listPendingWork / getDashboard 做 EXISTS 掃描、listCrmViews 無 LIMIT 且逐筆 N+1：以少量迭代測量並記錄此觀察。
  const pendingPath = read("SELECT * FROM feedback_analysis WHERE status IN ('pending','failed_retry','processing')", () => listPendingWork(db, "v3"), 3);
  const clusterPath = read("SELECT * FROM issue_candidate ORDER BY id DESC LIMIT 80", () => listIssuesWithLifecycle(db, { limit: 80 }));
  // listCrmViews 無 LIMIT 且逐筆 N+1（case/note/todo/module），故用較少迭代並記錄此觀察。
  const crmPath = read("SELECT * FROM ingested_crm_contact ORDER BY id DESC", () => listCrmViews(db, {}), 2);
  const dashboardPath = read("SELECT COUNT(*) FROM ingested_feedback", () => getDashboard(db, {}, { productId: "v3" }), 3);
  const productsPath = read("SELECT * FROM ops_product ORDER BY id", () => listProducts(db));

  db.close();
  return { scale: n, counts, paths: [proposalPath, entityPath, findPath, dedupPath, auditPath, stableWrite, rollbackDescribe, ingestPath, pendingPath, clusterPath, crmPath, dashboardPath, productsPath] };
}

function main() {
  const started = performance.now();
  const results = SCALES.map(runScale);
  const report = {
    schema: "ops-final-integration-bench-v1",
    generated_at: new Date().toISOString(),
    pr: "#369",
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      sqlite: "node:sqlite DatabaseSync(:memory:)",
      data: "seeded only; no Production data, no network, no writes outside this process",
    },
    method: "p50/p95/max over N iterations; SQL statement count via prepare-counting wrapper; EXPLAIN QUERY PLAN per read path",
    total_ms: round(performance.now() - started),
    results,
  };
  mkdirSync(HERE, { recursive: true });
  writeFileSync(path.join(HERE, "bench.json"), `${JSON.stringify(report, null, 2)}\n`);

  const lines = [];
  lines.push("# OPS final-integration seeded benchmark — PR #369");
  lines.push("");
  lines.push(`node ${report.environment.node} / ${report.environment.platform}; in-memory SQLite; generated ${report.generated_at}`);
  lines.push("");
  for (const scale of results) {
    lines.push(`## scale ${scale.scale} rows`);
    lines.push("");
    lines.push("| path | p50 ms | p95 ms | max ms | avg ms | iters | queries/call | SEARCH | SCAN |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const p of scale.paths) {
      lines.push(`| ${p.label} | ${p.p50_ms} | ${p.p95_ms} | ${p.max_ms} | ${p.avg_ms} | ${p.iterations} | ${p.query_count} | ${p.search_nodes ?? "-"} | ${p.scan_nodes ?? "-"} |`);
    }
    lines.push("");
    lines.push(`row counts: ${Object.entries(scale.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    lines.push("");
  }
  const allPlans = results.flatMap((s) => s.paths.filter((p) => p.plan).map((p) => ({ scale: s.scale, path: p.label, plan: p.plan, search: p.search_nodes, scan: p.scan_nodes })));
  const scans = allPlans.filter((p) => p.scan > 0);
  const searches = allPlans.filter((p) => p.search > 0 && p.scan === 0);
  lines.push("## EXPLAIN QUERY PLAN summary");
  lines.push("");
  lines.push(`${allPlans.length} read-path/scale observations: ${searches.length} are index SEARCH with no SCAN node, ${scans.length} contain a SCAN node.`);
  lines.push("");
  for (const p of allPlans) lines.push(`- \`${p.plan}\` — SEARCH ${p.search} / SCAN ${p.scan}`);
  writeFileSync(path.join(HERE, "bench.md"), `${lines.join("\n")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();

