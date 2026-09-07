import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";

// Canonical source of truth：state_entity.state 是唯一可寫的 lifecycle 狀態。
// 這個守護測試確保：ops schema 裡除了 state_entity，沒有其他表新增可獨立寫入的
// lifecycle 狀態欄位（state / status / lifecycle_state）。未來加 domain 表時，
// 只能存「衍生/去正規化」狀態；若真的要加狀態欄位，必須同時更新此白名單並附上不可分歧的理由。
test("only state_entity holds a lifecycle state column", () => {
  const db = openOpsDb(":memory:");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  const STATE_COL = /^(state|status|lifecycle_state)$/i;
  // state_entity 是唯一可寫的「中央 lifecycle 狀態」。
  // feedback_analysis.status 是「背景分析 job 的處理狀態」（pending/processing/completed/failed），
  // 屬於局部工作狀態、非中央 lifecycle，且不會與 state_entity 分歧，故列入白名單。
  const STATE_COL_ALLOWED = /^(state|lifecycle_state)$/i; // 對白名單表僅允許 status（job / 分析用途狀態）
  // feedback_analysis.status = 分析 job 狀態；embedding.status = active/stale；issue_candidate.status = open/merged（分析分群狀態）。
  // issue_evaluation_run.status / issue_role_evaluation.status = Phase 7 評估 job 的處理狀態
  //   （pending/processing/completed/failed/failed_retry）；屬局部工作狀態、非中央 proposal lifecycle，
  //   且不會與 state_entity 分歧（Phase 7 為 analytical decision-support，不驅動 lifecycle 轉移）。
  // 皆非中央 proposal lifecycle，且不會與 state_entity 分歧。
  // issue_proposal.status = 提案生成 job 狀態；development_authorization.status = active/superseded（授權產物狀態）。
  //   兩者皆非中央 proposal lifecycle（lifecycle 在 state_entity），且不與其分歧。
  // development_coding_task.status = Phase 10 coding job 工作狀態（pending/claimed/running/changes_ready/failed/failed_retry/cancelled）；
  //   屬局部工作狀態、非中央 Issue lifecycle（lifecycle 在 state_entity），且不與其分歧。
  // development_qa_run.status = Phase 11 QA job 工作狀態；development_qa_check.status = 逐項檢核結果（PASS/FAIL/WARN/REVIEW/SKIPPED）；
  //   development_qa_current.final_result 非 status 欄位。皆屬局部/衍生狀態、非中央 Issue lifecycle，且不與其分歧。
  // development_staging_deployment.status = Phase 12 Staging 部署工作狀態；development_staging_check.status = 逐項驗證結果；
  //   development_staging_current.validation_result 非 status 欄位。皆屬局部/衍生狀態、非中央 Issue lifecycle，且不與其分歧。
  const ALLOWED = new Set(["state_entity", "feedback_analysis", "embedding", "issue_candidate", "issue_evaluation_run", "issue_role_evaluation", "issue_proposal", "development_authorization", "development_coding_task", "development_qa_run", "development_qa_check", "development_staging_deployment", "development_staging_check"]);
  const offenders = [];

  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const col of cols) {
      if (!STATE_COL.test(col)) continue;
      if (ALLOWED.has(table)) {
        // 白名單表：state_entity 可有任何；其餘白名單表只允許 job 狀態欄位 `status`（不得有 state/lifecycle_state）
        if (table !== "state_entity" && STATE_COL_ALLOWED.test(col)) offenders.push(`${table}.${col}`);
        continue;
      }
      offenders.push(`${table}.${col}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `發現非 canonical 的 lifecycle 狀態欄位：${offenders.join(", ")}。domain 表只能存衍生狀態。`,
  );
  // 確認 canonical 欄位存在
  const seCols = db.prepare("PRAGMA table_info(state_entity)").all().map((c) => c.name);
  assert.ok(seCols.includes("state"));
  assert.ok(seCols.includes("version"));
  db.close();
});
