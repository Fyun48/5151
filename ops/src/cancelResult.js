// 第 29 包：取消後的剩餘工作結果確認。
// 已取消的製作／QA／staging 若仍留下 branch、PR、測試站、排程或供應商工作，
// 未決清單列出已知結果。Owner 確認只寫觀察，不改寫 cancelled 終態，
// 不自動關 PR、不刪 branch、不拆測試容器、不宣稱外部工作已撤回。

import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";

export const CANCEL_RESULT_EVIDENCE_KIND = "cancel_result_confirmed";

const WORK = Object.freeze({
  coding: {
    table: "development_coding_task",
    entityType: "development_coding_task",
    notFound: "coding task not found",
    cancelDoor: "尚未取消的製作請走取消門。確認取消結果只適用已取消且仍有剩餘工作的製作。",
    noLeftover: "這筆已取消的製作沒有剩餘的 branch、PR 或供應商工作可確認。",
    audit: "issue.coding.cancel_result_confirmed",
    leftovers(row) {
      const items = [];
      if (row.coding_branch) items.push({ kind: "branch", value: row.coding_branch });
      if (row.pr_number != null || row.pr_url) {
        items.push({
          kind: "pull_request",
          pr_number: row.pr_number == null ? null : Number(row.pr_number),
          pr_url: row.pr_url || null,
        });
      }
      if (row.provider_task_id) items.push({ kind: "provider_task", value: row.provider_task_id });
      if (row.head_sha) items.push({ kind: "head_sha", value: row.head_sha });
      return items;
    },
  },
  qa: {
    table: "development_qa_run",
    entityType: "development_qa_run",
    notFound: "QA run not found",
    cancelDoor: "尚未取消的 QA 請走取消門。確認取消結果只適用已取消且仍有剩餘工作的 QA。",
    noLeftover: "這筆已取消的 QA 沒有剩餘的 worktree 或供應商工作可確認。",
    audit: "issue.qa.cancel_result_confirmed",
    leftovers(row) {
      const items = [];
      if (row.claimed_at || row.started_at) {
        items.push({
          kind: "worktree",
          claimed_at: row.claimed_at || null,
          started_at: row.started_at || null,
        });
      }
      return items;
    },
  },
  staging: {
    table: "development_staging_deployment",
    entityType: "development_staging_deployment",
    notFound: "staging deployment not found",
    cancelDoor: "尚未取消的隔離 staging 請走取消門。確認取消結果只適用已取消且仍有剩餘工作的測試站。",
    noLeftover: "這筆已取消的隔離 staging 沒有剩餘的測試站、映像或排程可確認。",
    audit: "issue.staging.cancel_result_confirmed",
    leftovers(row) {
      const items = [];
      if (row.staging_environment_id) items.push({ kind: "staging_environment", value: row.staging_environment_id });
      if (row.staging_url) items.push({ kind: "staging_url", value: row.staging_url });
      if (row.artifact_id) items.push({ kind: "artifact", value: row.artifact_id });
      if (row.started_at || row.deployed_at) {
        items.push({
          kind: "schedule",
          started_at: row.started_at || null,
          deployed_at: row.deployed_at || null,
        });
      }
      return items;
    },
  },
});

const LEFTOVER_LABEL = Object.freeze({
  branch: "branch",
  pull_request: "PR",
  provider_task: "供應商工作",
  head_sha: "已產生的程式變更",
  worktree: "worktree",
  staging_environment: "測試站",
  staging_url: "測試網址",
  artifact: "測試映像",
  schedule: "排程／部署作業",
});

export function leftoverLabels(leftovers) {
  return [...new Set((leftovers || []).map((item) => LEFTOVER_LABEL[item.kind] || item.kind))];
}

export function leftoverPendingNote(leftovers, { scoped = true } = {}) {
  const names = leftoverLabels(leftovers);
  const list = names.length ? names.join("／") : "剩餘工作";
  if (!scoped) {
    return `已取消且尚未分站；列出剩餘工作（${list}）但不能宣稱已處理外部 branch／PR／測試站`;
  }
  return `已取消。仍有剩餘工作（${list}）。確認結果不自動關閉 PR、不刪分支、不拆測試容器。`;
}

export function ensureCancelResultSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS development_work_result_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_kind TEXT NOT NULL,
      work_id INTEGER NOT NULL,
      evidence_kind TEXT NOT NULL,
      leftovers_json TEXT,
      actor TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_result_work ON development_work_result_evidence(work_kind, work_id, id);
    CREATE TRIGGER IF NOT EXISTS work_result_no_update BEFORE UPDATE ON development_work_result_evidence
      BEGIN SELECT RAISE(ABORT, 'development_work_result_evidence is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS work_result_no_delete BEFORE DELETE ON development_work_result_evidence
      BEGIN SELECT RAISE(ABORT, 'development_work_result_evidence is append-only'); END;
  `);
}

function loadWork(db, kind, workId) {
  const spec = WORK[kind];
  if (!spec) throw httpError("unknown cancel-result work kind", 400);
  const row = db.prepare(`SELECT * FROM ${spec.table} WHERE id=?`).get(Number(workId));
  return { spec, row };
}

function alreadyConfirmed(db, kind, workId) {
  ensureCancelResultSchema(db);
  return !!db.prepare(
    `SELECT id FROM development_work_result_evidence
      WHERE work_kind=? AND work_id=? AND evidence_kind=?
      ORDER BY id DESC LIMIT 1`,
  ).get(kind, Number(workId), CANCEL_RESULT_EVIDENCE_KIND);
}

export function describeCancelResultOffer(db, kind, workId) {
  ensureCancelResultSchema(db);
  const spec = WORK[kind];
  if (!spec) return { offered: false, reason: "unknown_kind" };
  const row = db.prepare(`SELECT * FROM ${spec.table} WHERE id=?`).get(Number(workId));
  if (!row) return { offered: false, reason: "not_found" };
  if (row.status !== "cancelled") return { offered: false, reason: "not_cancelled" };
  const leftovers = spec.leftovers(row);
  if (!leftovers.length) return { offered: false, reason: "no_leftovers" };
  return {
    offered: true,
    confirmed: alreadyConfirmed(db, kind, workId),
    auto_cleanup: false,
    leftovers,
  };
}

function refuseProviderCleanup(provider) {
  if (!provider) return;
  // closePullRequest / deleteBranch / cleanup / cancelProviderTask 即使存在也不得呼叫。
}

export function confirmCancelResult(db, kind, workId, { actor = "owner", provider = null, now = new Date() } = {}) {
  ensureCancelResultSchema(db);
  const { spec, row } = loadWork(db, kind, workId);
  if (!row) throw httpError(spec.notFound, 404);
  if (row.status !== "cancelled") throw httpError(spec.cancelDoor, 409);
  const leftovers = spec.leftovers(row);
  if (!leftovers.length) throw httpError(spec.noLeftover, 409);
  refuseProviderCleanup(provider);
  if (alreadyConfirmed(db, kind, workId)) {
    return {
      idempotent: true,
      auto_cleanup: false,
      cleanup_not_performed: true,
      leftovers,
    };
  }
  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  withImmediateTx(db, () => {
    db.prepare(`
      INSERT INTO development_work_result_evidence(
        work_kind, work_id, evidence_kind, leftovers_json, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(kind, Number(row.id), CANCEL_RESULT_EVIDENCE_KIND, JSON.stringify(leftovers), String(actor), ts);
    appendAuditRow(db, {
      actor,
      action: spec.audit,
      entityType: spec.entityType,
      entityId: String(row.id),
      data: {
        issue_id: Number(row.issue_id),
        coding_task_id: row.coding_task_id == null ? Number(row.id) : Number(row.coding_task_id),
        work_kind: kind,
        work_id: Number(row.id),
        leftovers,
        auto_cleanup: false,
        cleanup_not_performed: true,
        prev_status: row.status,
      },
      now,
    });
  });
  return {
    confirmed: true,
    auto_cleanup: false,
    cleanup_not_performed: true,
    leftovers,
  };
}
