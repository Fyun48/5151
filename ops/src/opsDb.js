import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureCrmReplicaSchema } from "./crmReplica.js";
import { ensureProviderDrawerSchema } from "./providerDrawer.js";
import { ensureDefaultEnvironmentBindings, ensureProductEnvironmentSchema } from "./productEnvironment.js";
import { ensureInstructionRecordSchema } from "./instructionSource.js";
import { reapplyPurgeLedger } from "./purgeLedger.js";

// Ops 專用資料庫（與產品 v3 的 v3.db 完全分離）。
// 只放維運自動化系統的狀態機與稽核；Phase 1 尚無 feedback / AI / coding 相關資料。

export function applyOpsSchema(db) {
  db.exec(`
    -- 中央狀態機的實體：所有 lifecycle 實體共用一張表，靠 entity_type 區分。
    CREATE TABLE IF NOT EXISTS state_entity (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      state TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      meta TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 狀態轉移稽核（append-only）。idempotency_key 唯一，避免 webhook retry / 雙擊造成雙轉移。
    CREATE TABLE IF NOT EXISTS state_transition (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      actor TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      entity_version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    -- 稽核鏈（append-only, hash-chained, tamper-evident）。
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      data TEXT,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    -- 週期 checkpoint：記錄一段稽核鏈的 range root hash，預留外部簽章 anchor / 備份欄位。
    CREATE TABLE IF NOT EXISTS audit_checkpoint (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      range_root_hash TEXT NOT NULL,
      external_anchor TEXT,
      signature TEXT,
      created_at TEXT NOT NULL
    );

    -- 多站身分：穩定 product_id，不以顯示名／目錄當安全識別。
    CREATE TABLE IF NOT EXISTS ops_product (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_subscription (
      product_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'connected',
      capabilities TEXT,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS product_ingest_credential (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      secret TEXT NOT NULL,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_product_cred_active ON product_ingest_credential(product_id, status);

    -- 第 3 包：退出紀錄與交接包（exit_status 不是議題 lifecycle）。
    CREATE TABLE IF NOT EXISTS product_exit_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      action TEXT NOT NULL,
      exit_status TEXT NOT NULL,
      pending_json TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_exit_record_product ON product_exit_record(product_id, id);
    CREATE TABLE IF NOT EXISTS product_handoff_export (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      exit_record_id INTEGER,
      manifest_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );

    -- Phase 2：從 Product 非同步遞送進來的 feedback。
    -- 去重範圍是 (product_id, delivery_id) / (product_id, idempotency_key)，避免 A、B 各送 feedback:1 撞號。
    -- trust_level 一律 untrusted；Phase 2 只儲存與傳輸，不執行任何內容。
    CREATE TABLE IF NOT EXISTS ingested_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL DEFAULT 'v3',
      delivery_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',
      external_feedback_id TEXT,
      user_ref TEXT,
      kind TEXT,
      content TEXT,
      contact TEXT,
      context TEXT,
      app_version TEXT,
      submitted_at TEXT,
      trust_level TEXT NOT NULL DEFAULT 'untrusted',
      payload_hash TEXT,
      received_at TEXT NOT NULL,
      UNIQUE(product_id, delivery_id),
      UNIQUE(product_id, idempotency_key)
    );

    -- Phase 3：附件 metadata。內容存於 Storage Provider；此處只存不透明 object_key。
    -- FK → ingested_feedback，ON DELETE RESTRICT：不因刪除 feedback 而靜默連鎖刪除附件歷史（保留可稽核性）。
    CREATE TABLE IF NOT EXISTS feedback_attachment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_id INTEGER NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      original_filename TEXT,
      mime TEXT NOT NULL,
      category TEXT,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_provider TEXT NOT NULL,
      scan_status TEXT NOT NULL DEFAULT 'pending',
      pii_flag INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (feedback_id) REFERENCES ingested_feedback(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_feedback ON feedback_attachment(feedback_id);

    -- Phase 4：AI 首輪分類/摘要結果（版本化、可追溯、可重跑）。
    -- 明確區分兩個概念（Phase 4.1）：
    --   revision    = 語意上的「分析執行/版本」identity（每 feedback_id+analysis_type 遞增；reprocess 產生新的 revision）
    --   retry_count = 「同一個 revision」的執行層重試次數（provider timeout 等暫時性失敗）
    -- 每列一個 revision；reprocess 產生新 revision，不覆寫歷史。只存結構化結果與 raw_output_hash，不存隱藏推理鏈。
    CREATE TABLE IF NOT EXISTS feedback_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_id INTEGER NOT NULL,
      analysis_type TEXT NOT NULL DEFAULT 'classification',
      revision INTEGER NOT NULL DEFAULT 1,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 5,
      provider TEXT,
      model TEXT,
      model_version TEXT,
      prompt_version TEXT NOT NULL,
      category TEXT,
      summary TEXT,
      severity_hint TEXT,
      confidence REAL,
      language TEXT,
      raw_output_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_code TEXT,
      next_attempt_at TEXT NOT NULL,
      claimed_at TEXT,
      usage_input_tokens INTEGER,
      usage_output_tokens INTEGER,
      estimated_cost REAL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      subscription_generation INTEGER,
      FOREIGN KEY (feedback_id) REFERENCES ingested_feedback(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_identity ON feedback_analysis(feedback_id, analysis_type, revision);
    CREATE INDEX IF NOT EXISTS idx_analysis_status ON feedback_analysis(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_analysis_feedback ON feedback_analysis(feedback_id, id);

    -- Phase 4.1：CURRENT 指標。每 (feedback_id, analysis_type) 至多一筆，指向「唯一、確定、已 COMPLETED」的分析。
    -- 下游（Phase 5/6/7）一律透過此指標取用，而非 ORDER BY created_at DESC（最新可能是 failed/invalid）。
    CREATE TABLE IF NOT EXISTS feedback_analysis_current (
      feedback_id INTEGER NOT NULL,
      analysis_type TEXT NOT NULL,
      analysis_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      reason TEXT,
      PRIMARY KEY (feedback_id, analysis_type),
      FOREIGN KEY (analysis_id) REFERENCES feedback_analysis(id) ON DELETE RESTRICT
    );

    -- Phase 4.2：DB 層強制 CURRENT 指標不變式（不僅靠應用層 helper）。
    -- 指向的 feedback_analysis 必須：同 feedback_id、同 analysis_type、且 status='completed'。
    -- 即使用直接 SQL（INSERT/UPDATE）也無法違反。違反則 ABORT，整個 promotion 交易回滾。
    CREATE TRIGGER IF NOT EXISTS fac_guard_insert BEFORE INSERT ON feedback_analysis_current
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM feedback_analysis fa
        WHERE fa.id = NEW.analysis_id
          AND fa.feedback_id = NEW.feedback_id
          AND fa.analysis_type = NEW.analysis_type
          AND fa.status = 'completed'
      ) THEN RAISE(ABORT, 'current pointer must reference a COMPLETED analysis of the same feedback_id and analysis_type') END;
    END;
    CREATE TRIGGER IF NOT EXISTS fac_guard_update BEFORE UPDATE ON feedback_analysis_current
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM feedback_analysis fa
        WHERE fa.id = NEW.analysis_id
          AND fa.feedback_id = NEW.feedback_id
          AND fa.analysis_type = NEW.analysis_type
          AND fa.status = 'completed'
      ) THEN RAISE(ABORT, 'current pointer must reference a COMPLETED analysis of the same feedback_id and analysis_type') END;
    END;

    -- Phase 5：語意去重 + 可逆 Issue 分群。
    -- embedding：由「CURRENT 有效分析 + 症狀」產生的向量；記錄完整 provenance；current 變更時舊向量標 stale。
    CREATE TABLE IF NOT EXISTS embedding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_id INTEGER NOT NULL,
      analysis_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      model_version TEXT,
      dim INTEGER NOT NULL,
      normalization_version TEXT NOT NULL,
      vector TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      FOREIGN KEY (feedback_id) REFERENCES ingested_feedback(id) ON DELETE RESTRICT,
      FOREIGN KEY (analysis_id) REFERENCES feedback_analysis(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_embedding_identity ON embedding(feedback_id, analysis_id, model, model_version, normalization_version);
    CREATE INDEX IF NOT EXISTS idx_embedding_status ON embedding(status, feedback_id);

    -- issue_candidate：可能的共同問題群（純分析用途；不啟動 Development/Proposal）。
    CREATE TABLE IF NOT EXISTS issue_candidate (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      summary TEXT,
      category TEXT,
      clustering_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      merged_into INTEGER,
      parent_issue_id INTEGER,
      issue_kind TEXT NOT NULL DEFAULT 'normal',
      product_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- issue↔feedback 明確成員關係（不藏在 JSON）；一筆 feedback 至多屬於一個 active issue。
    CREATE TABLE IF NOT EXISTS issue_feedback_link (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      feedback_id INTEGER NOT NULL,
      analysis_id INTEGER,
      similarity_score REAL,
      coherence_score REAL,
      embedding_id INTEGER,
      embedding_model TEXT,
      clustering_version TEXT,
      added_by TEXT NOT NULL DEFAULT 'auto',
      membership_status TEXT NOT NULL DEFAULT 'active',
      review_flag INTEGER NOT NULL DEFAULT 0,
      review_reason TEXT,
      reason TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      removed_at TEXT,
      FOREIGN KEY (issue_id) REFERENCES issue_candidate(id) ON DELETE RESTRICT,
      FOREIGN KEY (feedback_id) REFERENCES ingested_feedback(id) ON DELETE RESTRICT,
      FOREIGN KEY (analysis_id) REFERENCES feedback_analysis(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_link_one_active_per_feedback ON issue_feedback_link(feedback_id) WHERE active = 1;
    CREATE INDEX IF NOT EXISTS idx_link_issue ON issue_feedback_link(issue_id, active);

    -- cluster_operation：所有分群操作的可追溯歷史（append-only）。
    CREATE TABLE IF NOT EXISTS cluster_operation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op TEXT NOT NULL,
      issue_id INTEGER,
      from_issue INTEGER,
      to_issue INTEGER,
      feedback_ids TEXT,
      actor TEXT NOT NULL,
      reason TEXT,
      clustering_version TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS cluster_operation_no_update BEFORE UPDATE ON cluster_operation
      BEGIN SELECT RAISE(ABORT, 'cluster_operation is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS cluster_operation_no_delete BEFORE DELETE ON cluster_operation
      BEGIN SELECT RAISE(ABORT, 'cluster_operation is append-only'); END;

    -- Phase 6：Issue 影響力/頻率評估（決定性、可解釋、版本化、歷史化）。不投票、不建 proposal、不觸發任何開發/發布。
    CREATE TABLE IF NOT EXISTS issue_impact_assessment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      scoring_version TEXT NOT NULL,
      membership_fingerprint TEXT NOT NULL,
      membership_count INTEGER NOT NULL,
      current_feedback_count INTEGER NOT NULL,
      distinct_reporter_count INTEGER NOT NULL,
      anonymous_feedback_count INTEGER NOT NULL,
      first_seen_at TEXT,
      last_seen_at TEXT,
      feedback_count_24h INTEGER NOT NULL DEFAULT 0,
      feedback_count_7d INTEGER NOT NULL DEFAULT 0,
      feedback_count_30d INTEGER NOT NULL DEFAULT 0,
      recent_velocity REAL,
      severity_distribution TEXT,
      category_distribution TEXT,
      app_version_distribution TEXT,
      source_distribution TEXT,
      components TEXT,
      impact_score REAL NOT NULL,
      impact_level TEXT NOT NULL,
      as_of_at TEXT NOT NULL,
      analysis_fingerprint TEXT NOT NULL,
      calculated_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issue_candidate(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_impact_issue ON issue_impact_assessment(issue_id, id);

    -- 每 issue 至多一個 CURRENT 影響力評估（下游 Phase 7 只讀此指標，不猜最新）。
    CREATE TABLE IF NOT EXISTS issue_impact_current (
      issue_id INTEGER NOT NULL PRIMARY KEY,
      assessment_id INTEGER NOT NULL,
      membership_fingerprint TEXT NOT NULL,
      analysis_fingerprint TEXT NOT NULL,
      as_of_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (assessment_id) REFERENCES issue_impact_assessment(id) ON DELETE RESTRICT
    );
    -- DB 層不變式：current 指標必須指向「同一 issue」的評估。
    CREATE TRIGGER IF NOT EXISTS iic_guard_insert BEFORE INSERT ON issue_impact_current
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM issue_impact_assessment a WHERE a.id = NEW.assessment_id AND a.issue_id = NEW.issue_id
      ) THEN RAISE(ABORT, 'impact current must reference an assessment of the same issue') END;
    END;
    CREATE TRIGGER IF NOT EXISTS iic_guard_update BEFORE UPDATE ON issue_impact_current
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM issue_impact_assessment a WHERE a.id = NEW.assessment_id AND a.issue_id = NEW.issue_id
      ) THEN RAISE(ABORT, 'impact current must reference an assessment of the same issue') END;
    END;

    -- Phase 7：角色制 Issue 評估與投票（analytical decision-support only）。
    -- 明確不做：建 proposal、核准開發、呼叫 coding provider、建 coding 分支/PR、部署 staging/production。
    -- 版本化歷史 run；每個 run 綁定「使用到的確切 canonical 證據」input_fingerprint 與 source_impact_assessment_id。
    CREATE TABLE IF NOT EXISTS issue_evaluation_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      evaluation_version TEXT NOT NULL,
      aggregation_version TEXT NOT NULL,
      role_set_version TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      policy_fingerprint TEXT,                       -- 決策政策/評估設定指紋（result-affecting config；不含 secrets）
      policy_snapshot TEXT,                          -- 去識別化政策快照（可解釋歷史 run 是用哪些規則產生）
      source_impact_assessment_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',       -- pending|processing|completed|failed|failed_retry|cancelled
      final_recommendation TEXT,                    -- PROPOSE|WAIT|IGNORE|ESCALATE（僅 completed）
      aggregate_confidence REAL,
      agreement REAL,
      aggregation_details TEXT,
      deliberation_enabled INTEGER NOT NULL DEFAULT 0,
      provider TEXT,
      model TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 5,
      error_code TEXT,
      next_attempt_at TEXT NOT NULL,
      claimed_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      subscription_generation INTEGER,
      FOREIGN KEY (issue_id) REFERENCES issue_candidate(id) ON DELETE RESTRICT,
      FOREIGN KEY (source_impact_assessment_id) REFERENCES issue_impact_assessment(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_eval_run_issue ON issue_evaluation_run(issue_id, id);
    CREATE INDEX IF NOT EXISTS idx_eval_run_status ON issue_evaluation_run(status, next_attempt_at);

    -- 每個角色（每輪）獨立結構化投票。保留第一輪，即使第二輪 deliberation 改票也不覆寫第一輪。
    -- 只存「結論式 rationale」與 output_hash，不存隱藏推理鏈（chain-of-thought）。
    CREATE TABLE IF NOT EXISTS issue_role_evaluation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evaluation_run_id INTEGER NOT NULL,
      issue_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
      recommendation TEXT NOT NULL,
      confidence REAL NOT NULL,
      risk_level TEXT NOT NULL,
      rationale TEXT,
      evidence_refs TEXT,
      missing_evidence TEXT,
      risk_flags TEXT,
      provider TEXT,
      model TEXT,
      model_version TEXT,
      prompt_version TEXT,
      output_hash TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL,
      FOREIGN KEY (evaluation_run_id) REFERENCES issue_evaluation_run(id) ON DELETE RESTRICT,
      FOREIGN KEY (issue_id) REFERENCES issue_candidate(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_role_eval_run ON issue_role_evaluation(evaluation_run_id, role, round);

    -- 每 issue 至多一個 CURRENT 評估（Phase 8 只讀此指標，不用 timestamp 猜最新）。
    CREATE TABLE IF NOT EXISTS issue_evaluation_current (
      issue_id INTEGER NOT NULL PRIMARY KEY,
      evaluation_run_id INTEGER NOT NULL,
      input_fingerprint TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      final_recommendation TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (evaluation_run_id) REFERENCES issue_evaluation_run(id) ON DELETE RESTRICT
    );
    -- DB 層不變式：current 指標必須指向「同一 issue、且已 completed」的 run。即使用直接 SQL 也無法違反。
    CREATE TRIGGER IF NOT EXISTS iec_guard_insert BEFORE INSERT ON issue_evaluation_current
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM issue_evaluation_run r WHERE r.id = NEW.evaluation_run_id AND r.issue_id = NEW.issue_id AND r.status = 'completed'
      ) THEN RAISE(ABORT, 'evaluation current must reference a COMPLETED run of the same issue') END;
    END;
    CREATE TRIGGER IF NOT EXISTS iec_guard_update BEFORE UPDATE ON issue_evaluation_current
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM issue_evaluation_run r WHERE r.id = NEW.evaluation_run_id AND r.issue_id = NEW.issue_id AND r.status = 'completed'
      ) THEN RAISE(ABORT, 'evaluation current must reference a COMPLETED run of the same issue') END;
    END;

    -- Phase 8：開發提案（immutable、版本化）＋ Owner 審批閘 #1。
    -- issue_proposal 為不可變產物：completed 後內容永不 UPDATE；任何修改＝新 proposal_version 新列。
    -- 生成為非同步 job（pending→processing→completed|failed|failed_retry），completed 才算正式提案。
    CREATE TABLE IF NOT EXISTS issue_proposal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      proposal_version INTEGER NOT NULL,
      generation_version TEXT NOT NULL,
      input_fingerprint TEXT,
      policy_fingerprint TEXT,
      proposal_hash TEXT,
      source_evaluation_run_id INTEGER,
      source_impact_assessment_id INTEGER,
      final_recommendation TEXT,
      title TEXT,
      problem_statement TEXT,
      proposed_change TEXT,
      intended_outcome TEXT,
      scope TEXT,
      non_goals TEXT,
      acceptance_criteria TEXT,
      known_risks TEXT,
      security_considerations TEXT,
      compliance_considerations TEXT,
      operational_considerations TEXT,
      rollback_considerations TEXT,
      evidence_summary TEXT,
      revision_instruction TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending|processing|completed|failed|failed_retry|cancelled
      provider TEXT,
      model TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 5,
      error_code TEXT,
      next_attempt_at TEXT NOT NULL,
      claimed_at TEXT,
      generated_at TEXT,
      created_at TEXT NOT NULL,
      subscription_generation INTEGER,
      FOREIGN KEY (issue_id) REFERENCES issue_candidate(id) ON DELETE RESTRICT,
      FOREIGN KEY (source_evaluation_run_id) REFERENCES issue_evaluation_run(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_proposal_issue ON issue_proposal(issue_id, id);
    CREATE INDEX IF NOT EXISTS idx_proposal_status ON issue_proposal(status, next_attempt_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_version ON issue_proposal(issue_id, proposal_version);
    -- completed 的提案內容不可變：禁止 UPDATE 內容欄位／hash／version（只允許非內容欄位維持不動）。
    CREATE TRIGGER IF NOT EXISTS proposal_immutable_completed BEFORE UPDATE ON issue_proposal
    WHEN OLD.status = 'completed' AND (
      IFNULL(NEW.proposal_hash,'') <> IFNULL(OLD.proposal_hash,'')
      OR IFNULL(NEW.proposal_version,0) <> IFNULL(OLD.proposal_version,0)
      OR IFNULL(NEW.title,'') <> IFNULL(OLD.title,'')
      OR IFNULL(NEW.problem_statement,'') <> IFNULL(OLD.problem_statement,'')
      OR IFNULL(NEW.proposed_change,'') <> IFNULL(OLD.proposed_change,'')
      OR IFNULL(NEW.intended_outcome,'') <> IFNULL(OLD.intended_outcome,'')
      OR IFNULL(NEW.scope,'') <> IFNULL(OLD.scope,'')
      OR IFNULL(NEW.non_goals,'') <> IFNULL(OLD.non_goals,'')
      OR IFNULL(NEW.acceptance_criteria,'') <> IFNULL(OLD.acceptance_criteria,'')
      OR IFNULL(NEW.evidence_summary,'') <> IFNULL(OLD.evidence_summary,'')
      OR IFNULL(NEW.input_fingerprint,'') <> IFNULL(OLD.input_fingerprint,'')
      OR IFNULL(NEW.status,'') <> 'completed'
    )
    BEGIN SELECT RAISE(ABORT, 'completed proposal is immutable'); END;

    -- 每 issue 至多一個 CURRENT 提案（下游只讀此指標；不用 timestamp 猜最新）。
    CREATE TABLE IF NOT EXISTS issue_proposal_current (
      issue_id INTEGER NOT NULL PRIMARY KEY,
      proposal_id INTEGER NOT NULL,
      proposal_version INTEGER NOT NULL,
      proposal_hash TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (proposal_id) REFERENCES issue_proposal(id) ON DELETE RESTRICT
    );
    -- DB 不變式：current 必須指向「同 issue、且 completed」的提案。
    CREATE TRIGGER IF NOT EXISTS ipc_guard_insert BEFORE INSERT ON issue_proposal_current
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM issue_proposal p WHERE p.id = NEW.proposal_id AND p.issue_id = NEW.issue_id AND p.status = 'completed'
      ) THEN RAISE(ABORT, 'proposal current must reference a COMPLETED proposal of the same issue') END;
    END;
    CREATE TRIGGER IF NOT EXISTS ipc_guard_update BEFORE UPDATE ON issue_proposal_current
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM issue_proposal p WHERE p.id = NEW.proposal_id AND p.issue_id = NEW.issue_id AND p.status = 'completed'
      ) THEN RAISE(ABORT, 'proposal current must reference a COMPLETED proposal of the same issue') END;
    END;

    -- Owner 決策歷史（append-only）：APPROVE_DEVELOPMENT / REQUEST_CHANGES / DEFER / REJECT / BLOCK。
    CREATE TABLE IF NOT EXISTS proposal_owner_decision (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      proposal_version INTEGER NOT NULL,
      proposal_hash TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      subscription_generation INTEGER,
      FOREIGN KEY (proposal_id) REFERENCES issue_proposal(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_owner_decision_issue ON proposal_owner_decision(issue_id, id);
    CREATE TRIGGER IF NOT EXISTS owner_decision_no_update BEFORE UPDATE ON proposal_owner_decision
      BEGIN SELECT RAISE(ABORT, 'proposal_owner_decision is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS owner_decision_no_delete BEFORE DELETE ON proposal_owner_decision
      BEGIN SELECT RAISE(ABORT, 'proposal_owner_decision is append-only'); END;

    -- 開發授權（APPROVE DEVELOPMENT 的產物）：綁定確切 proposal 快照，是未來 Phase 10 Coding Agent 的授權邊界。
    -- 內容不可變；只有 status 可從 active → superseded（提案改版後作廢，保留歷史）。
    CREATE TABLE IF NOT EXISTS development_authorization (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      proposal_version INTEGER NOT NULL,
      proposal_hash TEXT NOT NULL,
      source_evaluation_run_id INTEGER,
      authorization_hash TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',   -- active|superseded
      superseded_at TEXT,
      superseded_reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (proposal_id) REFERENCES issue_proposal(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_devauth_issue ON development_authorization(issue_id, id);
    -- 每個 (proposal_id, proposal_hash) 至多一筆 active 授權（冪等；避免重複授權）。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_devauth_active ON development_authorization(proposal_id, proposal_hash) WHERE status = 'active';

    -- Phase 9：重評/重啟授權（immutable, append-only）。這是中央狀態機把 DEFERRED/REJECTED → EVALUATING
    -- （authorization='reevaluation'）或 BLOCKED → EVALUATING（authorization='owner_unblock'）所需的「明確授權」歷史。
    -- 只記聚合證據指紋與 reason codes；不放原始 feedback / PII。scheduler tick 本身不算授權。
    CREATE TABLE IF NOT EXISTS issue_reevaluation_authorization (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      trigger_type TEXT NOT NULL,              -- auto | owner_manual | owner_unblock
      authorized_by TEXT NOT NULL,             -- policy | owner
      from_state TEXT NOT NULL,
      source_owner_decision_id INTEGER,
      baseline_fingerprint TEXT,
      current_evidence_fingerprint TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      reason_codes TEXT,
      observed_deltas TEXT,
      actor TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      subscription_generation INTEGER,
      FOREIGN KEY (issue_id) REFERENCES issue_candidate(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_reauth_issue ON issue_reevaluation_authorization(issue_id, id);
    -- 冪等：同 issue + 同 baseline + 同 current evidence + 同 policy 只授權一次（避免 flapping / 重複授權）。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reauth_dedupe ON issue_reevaluation_authorization(
      issue_id, IFNULL(baseline_fingerprint, ''), current_evidence_fingerprint, policy_fingerprint
    );
    CREATE TRIGGER IF NOT EXISTS reauth_no_update BEFORE UPDATE ON issue_reevaluation_authorization
      BEGIN SELECT RAISE(ABORT, 'issue_reevaluation_authorization is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS reauth_no_delete BEFORE DELETE ON issue_reevaluation_authorization
      BEGIN SELECT RAISE(ABORT, 'issue_reevaluation_authorization is append-only'); END;

    -- Phase 10：授權後的 Coding Task（唯一可呼叫 coding provider、修改原始碼的階段）。
    -- 只能由「ACTIVE development_authorization」建立；綁定確切 Proposal 快照與 base SHA。
    -- provenance 不可變（issue/authorization/proposal/base 綁定不改）；status 為工作狀態，與中央 Issue lifecycle 分離。
    -- 不 auto-merge、不部署、不建 Release Candidate。
    CREATE TABLE IF NOT EXISTS development_coding_task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      development_authorization_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      proposal_version INTEGER NOT NULL,
      proposal_hash TEXT NOT NULL,
      task_fingerprint TEXT NOT NULL,
      provider TEXT,
      provider_task_id TEXT,
      model TEXT,
      repository TEXT,
      base_branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      coding_branch TEXT,
      head_sha TEXT,
      approved_scope_snapshot TEXT,
      changed_files TEXT,
      diff_insertions INTEGER,
      diff_deletions INTEGER,
      protected_flags TEXT,
      selftest_results TEXT,
      warnings TEXT,
      result_hash TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending|claimed|running|changes_ready|failed|failed_retry|cancelled
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error_code TEXT,
      next_attempt_at TEXT NOT NULL,
      claimed_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      subscription_generation INTEGER,
      FOREIGN KEY (issue_id) REFERENCES issue_candidate(id) ON DELETE RESTRICT,
      FOREIGN KEY (development_authorization_id) REFERENCES development_authorization(id) ON DELETE RESTRICT,
      FOREIGN KEY (proposal_id) REFERENCES issue_proposal(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_coding_task_issue ON development_coding_task(issue_id, id);
    CREATE INDEX IF NOT EXISTS idx_coding_task_status ON development_coding_task(status, next_attempt_at);
    -- 每個 task_fingerprint 至多一個「未取消」的 task（idempotency：同授權+base+policy 不重複建立/推分支）。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_coding_task_active_fp ON development_coding_task(task_fingerprint) WHERE status != 'cancelled';
    -- provenance 不可變：completed（changes_ready）後不可竄改綁定欄位。
    CREATE TRIGGER IF NOT EXISTS coding_task_provenance_immutable BEFORE UPDATE ON development_coding_task
    WHEN OLD.status = 'changes_ready' AND (
      IFNULL(NEW.proposal_hash,'') <> IFNULL(OLD.proposal_hash,'')
      OR IFNULL(NEW.development_authorization_id,0) <> IFNULL(OLD.development_authorization_id,0)
      OR IFNULL(NEW.base_sha,'') <> IFNULL(OLD.base_sha,'')
      OR IFNULL(NEW.task_fingerprint,'') <> IFNULL(OLD.task_fingerprint,'')
      OR IFNULL(NEW.head_sha,'') <> IFNULL(OLD.head_sha,'')
    )
    BEGIN SELECT RAISE(ABORT, 'coding task provenance is immutable once changes are ready'); END;

    -- Phase 11：獨立自動化 QA & 安全審查。針對「確切」的 Phase-10 Coding Task 結果做獨立檢核。
    -- Coding Provider 自測不算核准證據；Phase 11 獨立重算 diff、跑 build/lint/tests、安全/範圍審查，
    -- 產生決定性 PASS/FAIL/REVIEW_REQUIRED。不 merge、不部署、不建 Release Manifest、不做 Owner Gate #2。
    CREATE TABLE IF NOT EXISTS development_qa_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      coding_task_id INTEGER NOT NULL,
      development_authorization_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      proposal_version INTEGER NOT NULL,
      proposal_hash TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      coding_result_hash TEXT,
      diff_hash TEXT,
      qa_version TEXT NOT NULL,
      qa_policy_fingerprint TEXT NOT NULL,
      qa_policy_snapshot TEXT,
      input_fingerprint TEXT NOT NULL,
      reviewer TEXT,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending|claimed|running|completed|failed|failed_retry|cancelled（job 狀態）
      final_result TEXT,                         -- PASS|FAIL|REVIEW_REQUIRED（completed 時）
      blocking_checks TEXT,
      warning_count INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error_code TEXT,
      next_attempt_at TEXT NOT NULL,
      claimed_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      subscription_generation INTEGER,
      FOREIGN KEY (issue_id) REFERENCES issue_candidate(id) ON DELETE RESTRICT,
      FOREIGN KEY (coding_task_id) REFERENCES development_coding_task(id) ON DELETE RESTRICT,
      FOREIGN KEY (development_authorization_id) REFERENCES development_authorization(id) ON DELETE RESTRICT,
      FOREIGN KEY (proposal_id) REFERENCES issue_proposal(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_qa_run_task ON development_qa_run(coding_task_id, id);
    CREATE INDEX IF NOT EXISTS idx_qa_run_status ON development_qa_run(status, next_attempt_at);
    -- idempotency：同一 input（coding_task+head+result+diff+policy）至多一列（cancelled 除外）。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_run_input_fp ON development_qa_run(input_fingerprint) WHERE status != 'cancelled';
    -- provenance 不可變：completed 後不可竄改綁定欄位。
    CREATE TRIGGER IF NOT EXISTS qa_run_provenance_immutable BEFORE UPDATE ON development_qa_run
    WHEN OLD.status = 'completed' AND (
      IFNULL(NEW.coding_task_id,0) <> IFNULL(OLD.coding_task_id,0)
      OR IFNULL(NEW.head_sha,'') <> IFNULL(OLD.head_sha,'')
      OR IFNULL(NEW.base_sha,'') <> IFNULL(OLD.base_sha,'')
      OR IFNULL(NEW.diff_hash,'') <> IFNULL(OLD.diff_hash,'')
      OR IFNULL(NEW.input_fingerprint,'') <> IFNULL(OLD.input_fingerprint,'')
      OR IFNULL(NEW.final_result,'') <> IFNULL(OLD.final_result,'')
    )
    BEGIN SELECT RAISE(ABORT, 'qa run provenance is immutable once completed'); END;

    -- 逐項檢核結果（獨立、結構化；不存 hidden chain-of-thought）。
    CREATE TABLE IF NOT EXISTS development_qa_check (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qa_run_id INTEGER NOT NULL,
      issue_id INTEGER NOT NULL,
      coding_task_id INTEGER NOT NULL,
      check_type TEXT NOT NULL,
      status TEXT NOT NULL,        -- PASS|FAIL|WARN|REVIEW|SKIPPED
      severity TEXT NOT NULL,      -- none|low|medium|high|blocking
      finding TEXT,
      evidence TEXT,
      command TEXT,
      tool TEXT,
      tool_version TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (qa_run_id) REFERENCES development_qa_run(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_qa_check_run ON development_qa_check(qa_run_id, id);

    -- 每個 Coding Task 的 canonical 當前 QA（只指向 completed run；供 Phase 12 不需以時間猜測）。
    CREATE TABLE IF NOT EXISTS development_qa_current (
      coding_task_id INTEGER NOT NULL PRIMARY KEY,
      qa_run_id INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      final_result TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (qa_run_id) REFERENCES development_qa_run(id) ON DELETE RESTRICT
    );

    -- Phase 12：隔離 Staging 部署與驗證。把「通過 fresh Phase-11 QA PASS 的確切 head SHA/artifact」
    -- 部署到「與 Production 完全隔離」的非正式環境，做 health/smoke 驗證並保存版本化證據。
    -- 不 merge、不 auto-merge、不部署 Production、不建 Release Manifest、不做 Owner Gate #2。
    CREATE TABLE IF NOT EXISTS development_staging_deployment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      coding_task_id INTEGER NOT NULL,
      development_authorization_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      proposal_version INTEGER NOT NULL,
      proposal_hash TEXT NOT NULL,
      qa_run_id INTEGER NOT NULL,
      qa_input_fingerprint TEXT,
      qa_policy_fingerprint TEXT,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      coding_result_hash TEXT,
      diff_hash TEXT,
      source_tree_hash TEXT,
      artifact_id TEXT,
      artifact_digest TEXT,
      staging_provider TEXT,
      staging_environment_id TEXT,
      staging_environment_class TEXT,
      staging_url TEXT,
      staging_policy_version TEXT NOT NULL,
      staging_policy_fingerprint TEXT NOT NULL,
      config_fingerprint TEXT,
      config_snapshot TEXT,
      input_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending|claimed|building|deploying|validating|ready|failed|failed_retry|cancelled|expired|superseded（部署工作狀態）
      validation_result TEXT,                    -- PASS|FAIL|REVIEW_REQUIRED
      blocking_checks TEXT,
      warning_count INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error_code TEXT,
      next_attempt_at TEXT NOT NULL,
      claimed_at TEXT,
      started_at TEXT,
      deployed_at TEXT,
      completed_at TEXT,
      expires_at TEXT,
      cleanup_status TEXT,
      subscription_generation INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issue_candidate(id) ON DELETE RESTRICT,
      FOREIGN KEY (coding_task_id) REFERENCES development_coding_task(id) ON DELETE RESTRICT,
      FOREIGN KEY (qa_run_id) REFERENCES development_qa_run(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_staging_task ON development_staging_deployment(coding_task_id, id);
    CREATE INDEX IF NOT EXISTS idx_staging_status ON development_staging_deployment(status, next_attempt_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_input_fp ON development_staging_deployment(input_fingerprint) WHERE status != 'cancelled';
    -- provenance 不可變：ready 後不可竄改綁定/artifact 欄位。
    CREATE TRIGGER IF NOT EXISTS staging_provenance_immutable BEFORE UPDATE ON development_staging_deployment
    WHEN OLD.status = 'ready' AND (
      IFNULL(NEW.coding_task_id,0) <> IFNULL(OLD.coding_task_id,0)
      OR IFNULL(NEW.head_sha,'') <> IFNULL(OLD.head_sha,'')
      OR IFNULL(NEW.qa_run_id,0) <> IFNULL(OLD.qa_run_id,0)
      OR IFNULL(NEW.artifact_digest,'') <> IFNULL(OLD.artifact_digest,'')
      OR IFNULL(NEW.input_fingerprint,'') <> IFNULL(OLD.input_fingerprint,'')
      OR IFNULL(NEW.validation_result,'') <> IFNULL(OLD.validation_result,'')
    )
    BEGIN SELECT RAISE(ABORT, 'staging deployment provenance is immutable once ready'); END;

    CREATE TABLE IF NOT EXISTS development_staging_check (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staging_deployment_id INTEGER NOT NULL,
      issue_id INTEGER NOT NULL,
      coding_task_id INTEGER NOT NULL,
      check_type TEXT NOT NULL,
      status TEXT NOT NULL,        -- PASS|FAIL|WARN|REVIEW|SKIPPED
      severity TEXT NOT NULL,      -- none|low|medium|high|blocking
      finding TEXT,
      evidence TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (staging_deployment_id) REFERENCES development_staging_deployment(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_staging_check_dep ON development_staging_check(staging_deployment_id, id);

    -- 每個 Coding Task 的 canonical 當前 Staging（只指向成功 ready 的部署）。
    CREATE TABLE IF NOT EXISTS development_staging_current (
      coding_task_id INTEGER NOT NULL PRIMARY KEY,
      staging_deployment_id INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      validation_result TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (staging_deployment_id) REFERENCES development_staging_deployment(id) ON DELETE RESTRICT
    );

    -- Phase 13：Release Candidate + 不可變 Release Manifest + Owner Gate #2。
    -- 把「確切通過 Gate#1 + QA PASS + Staging PASS」的證據打包成不可變 manifest 呈給 Owner 做第二次人工核准。
    -- 不部署 Production、不觸發 Production workflow、不跑 Production 遷移、不 merge、不 auto-merge、不改碼、不呼叫 coding provider。
    CREATE TABLE IF NOT EXISTS development_release_candidate (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      coding_task_id INTEGER NOT NULL,
      development_authorization_id INTEGER NOT NULL,
      proposal_id INTEGER NOT NULL,
      proposal_version INTEGER NOT NULL,
      proposal_hash TEXT NOT NULL,
      qa_run_id INTEGER NOT NULL,
      staging_deployment_id INTEGER NOT NULL,
      manifest_version INTEGER NOT NULL,
      release_manifest_version TEXT NOT NULL,
      release_policy_version TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      current_master_sha TEXT,
      source_tree_hash TEXT,
      coding_result_hash TEXT,
      diff_hash TEXT,
      artifact_id TEXT,
      artifact_digest TEXT NOT NULL,
      qa_input_fingerprint TEXT,
      qa_policy_fingerprint TEXT,
      staging_input_fingerprint TEXT,
      staging_policy_fingerprint TEXT,
      staging_config_fingerprint TEXT,
      release_policy_fingerprint TEXT NOT NULL,
      release_input_fingerprint TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      manifest_content TEXT NOT NULL,
      source_base_drift INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',   -- completed|cancelled（manifest 產物狀態；本體不可變）
      generated_at TEXT NOT NULL,
      subscription_generation INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issue_candidate(id) ON DELETE RESTRICT,
      FOREIGN KEY (coding_task_id) REFERENCES development_coding_task(id) ON DELETE RESTRICT,
      FOREIGN KEY (qa_run_id) REFERENCES development_qa_run(id) ON DELETE RESTRICT,
      FOREIGN KEY (staging_deployment_id) REFERENCES development_staging_deployment(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_rc_task ON development_release_candidate(coding_task_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rc_input_fp ON development_release_candidate(release_input_fingerprint) WHERE status != 'cancelled';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rc_task_version ON development_release_candidate(coding_task_id, manifest_version);
    -- manifest 本體不可變：hash/content/artifact/head 一旦寫入不可竄改。
    CREATE TRIGGER IF NOT EXISTS rc_manifest_immutable BEFORE UPDATE ON development_release_candidate
    WHEN (
      IFNULL(NEW.manifest_hash,'') <> IFNULL(OLD.manifest_hash,'')
      OR IFNULL(NEW.manifest_content,'') <> IFNULL(OLD.manifest_content,'')
      OR IFNULL(NEW.artifact_digest,'') <> IFNULL(OLD.artifact_digest,'')
      OR IFNULL(NEW.head_sha,'') <> IFNULL(OLD.head_sha,'')
      OR IFNULL(NEW.manifest_version,0) <> IFNULL(OLD.manifest_version,0)
    )
    BEGIN SELECT RAISE(ABORT, 'release manifest is immutable'); END;

    -- 不可變 Production Release Authorization（Gate #2 通過的域授權；不含任何部署憑證）。
    CREATE TABLE IF NOT EXISTS production_release_authorization (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      coding_task_id INTEGER NOT NULL,
      development_authorization_id INTEGER NOT NULL,
      release_manifest_id INTEGER NOT NULL,
      release_manifest_version INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      proposal_id INTEGER NOT NULL,
      proposal_version INTEGER NOT NULL,
      proposal_hash TEXT NOT NULL,
      qa_run_id INTEGER NOT NULL,
      staging_deployment_id INTEGER NOT NULL,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      artifact_digest TEXT NOT NULL,
      authorization_hash TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',   -- active|superseded
      superseded_at TEXT,
      superseded_reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (release_manifest_id) REFERENCES development_release_candidate(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_relauth_task ON production_release_authorization(coding_task_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_relauth_active ON production_release_authorization(release_manifest_id, manifest_hash) WHERE status = 'active';
    -- 授權綁定不可變（僅允許 active→superseded）。
    CREATE TRIGGER IF NOT EXISTS relauth_immutable BEFORE UPDATE ON production_release_authorization
    WHEN (
      IFNULL(NEW.manifest_hash,'') <> IFNULL(OLD.manifest_hash,'')
      OR IFNULL(NEW.release_manifest_id,0) <> IFNULL(OLD.release_manifest_id,0)
      OR IFNULL(NEW.head_sha,'') <> IFNULL(OLD.head_sha,'')
      OR IFNULL(NEW.artifact_digest,'') <> IFNULL(OLD.artifact_digest,'')
      OR IFNULL(NEW.approved_by,'') <> IFNULL(OLD.approved_by,'')
    )
    BEGIN SELECT RAISE(ABORT, 'production release authorization is immutable'); END;

    -- Owner Gate #2 決策歷史（append-only）。
    CREATE TABLE IF NOT EXISTS release_owner_decision (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      coding_task_id INTEGER NOT NULL,
      release_manifest_id INTEGER NOT NULL,
      manifest_version INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      action TEXT NOT NULL,        -- APPROVE_RELEASE|REQUEST_CHANGES|CANCEL_RELEASE
      actor TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (release_manifest_id) REFERENCES development_release_candidate(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_reldec_task ON release_owner_decision(coding_task_id, id);
    CREATE TRIGGER IF NOT EXISTS release_owner_decision_no_update BEFORE UPDATE ON release_owner_decision
    BEGIN SELECT RAISE(ABORT, 'release owner decisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS release_owner_decision_no_delete BEFORE DELETE ON release_owner_decision
    BEGIN SELECT RAISE(ABORT, 'release owner decisions are append-only'); END;

    -- 每個 Coding Task 的 canonical 當前 Release Candidate。
    CREATE TABLE IF NOT EXISTS development_release_current (
      coding_task_id INTEGER NOT NULL PRIMARY KEY,
      release_manifest_id INTEGER NOT NULL,
      manifest_version INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (release_manifest_id) REFERENCES development_release_candidate(id) ON DELETE RESTRICT
    );

    -- Release Candidate 通知 outbox（provider-neutral；未設 adapter → 留 pending，不假造送達）。
    CREATE TABLE IF NOT EXISTS release_notification (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      coding_task_id INTEGER NOT NULL,
      release_manifest_id INTEGER NOT NULL,
      manifest_version INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'internal',
      status TEXT NOT NULL DEFAULT 'pending',   -- pending|sent|failed|cancelled
      payload TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      subscription_generation INTEGER,
      FOREIGN KEY (release_manifest_id) REFERENCES development_release_candidate(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_relnotif_manifest ON release_notification(release_manifest_id, channel);

    -- Phase 14：Production DB Migration Safety Clearance（獨立不可變評估；不改 Phase-13 manifest 本體、不部署 Production）。
    -- 精確綁定 Gate #2 已核准的 production_release_authorization + manifest version/hash + head SHA + artifact digest + QA/staging。
    CREATE TABLE IF NOT EXISTS production_migration_safety_assessment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      coding_task_id INTEGER NOT NULL,
      release_authorization_id INTEGER NOT NULL,
      release_manifest_id INTEGER NOT NULL,
      release_manifest_version INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      qa_run_id INTEGER NOT NULL,
      staging_deployment_id INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      artifact_digest TEXT NOT NULL,
      migration_classification TEXT NOT NULL,
      clearance_result TEXT NOT NULL,
      evidence_snapshot TEXT NOT NULL,
      rollback_assessment TEXT NOT NULL,
      compatibility_assessment TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      assessment_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (release_authorization_id) REFERENCES production_release_authorization(id) ON DELETE RESTRICT,
      FOREIGN KEY (release_manifest_id) REFERENCES development_release_candidate(id) ON DELETE RESTRICT,
      FOREIGN KEY (qa_run_id) REFERENCES development_qa_run(id) ON DELETE RESTRICT,
      FOREIGN KEY (staging_deployment_id) REFERENCES development_staging_deployment(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_migsafety_task ON production_migration_safety_assessment(coding_task_id, id);
    CREATE INDEX IF NOT EXISTS idx_migsafety_auth ON production_migration_safety_assessment(release_authorization_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_migsafety_input_fp ON production_migration_safety_assessment(input_fingerprint);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_migsafety_auth_version ON production_migration_safety_assessment(release_authorization_id, assessment_version);
    -- 評估本體全欄位不可變（canonical pointer 在 production_migration_safety_current）。
    -- 實際 trigger 由 upgradeMigrationSafetyImmutability() 每次套用，以升級舊的部分欄位 WHEN 子句。
    CREATE TRIGGER IF NOT EXISTS migsafety_immutable BEFORE UPDATE ON production_migration_safety_assessment
    BEGIN SELECT RAISE(ABORT, 'migration safety assessment is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS migsafety_no_delete BEFORE DELETE ON production_migration_safety_assessment
    BEGIN SELECT RAISE(ABORT, 'migration safety assessment is append-only'); END;

    -- canonical 當前 pointer（可改指向新版本；歷史 assessment 仍 append-only）。
    CREATE TABLE IF NOT EXISTS production_migration_safety_current (
      coding_task_id INTEGER NOT NULL PRIMARY KEY,
      release_authorization_id INTEGER NOT NULL,
      assessment_id INTEGER NOT NULL,
      input_fingerprint TEXT NOT NULL,
      clearance_result TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (assessment_id) REFERENCES production_migration_safety_assessment(id) ON DELETE RESTRICT,
      FOREIGN KEY (release_authorization_id) REFERENCES production_release_authorization(id) ON DELETE RESTRICT
    );

    -- Phase 15：不可變 Production release attempt（狀態變更只走 append-only events + current pointer）。
    CREATE TABLE IF NOT EXISTS production_release_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      coding_task_id INTEGER NOT NULL,
      release_authorization_id INTEGER NOT NULL,
      release_authorization_hash TEXT NOT NULL,
      release_manifest_id INTEGER NOT NULL,
      release_manifest_version INTEGER NOT NULL,
      manifest_hash TEXT NOT NULL,
      migration_safety_assessment_id INTEGER NOT NULL,
      migration_safety_policy_fingerprint TEXT NOT NULL,
      migration_safety_input_fingerprint TEXT NOT NULL,
      clearance_result TEXT NOT NULL,
      proposal_id INTEGER NOT NULL,
      qa_run_id INTEGER NOT NULL,
      staging_deployment_id INTEGER NOT NULL,
      authorized_head_sha TEXT NOT NULL,
      source_tree_hash TEXT,
      artifact_digest TEXT NOT NULL,
      target_environment TEXT NOT NULL,
      workflow_file TEXT NOT NULL,
      workflow_ref TEXT NOT NULL,
      expected_master_head TEXT,
      input_fingerprint TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      run_version INTEGER NOT NULL,
      previous_stable_sha TEXT,
      previous_stable_digest TEXT,
      previous_stable_workflow_run_id TEXT,
      previous_stable_release_run_id INTEGER,
      previous_stable_provenance TEXT,
      authorized_github_actor TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      subscription_generation INTEGER,
      FOREIGN KEY (release_authorization_id) REFERENCES production_release_authorization(id) ON DELETE RESTRICT,
      FOREIGN KEY (release_manifest_id) REFERENCES development_release_candidate(id) ON DELETE RESTRICT,
      FOREIGN KEY (migration_safety_assessment_id) REFERENCES production_migration_safety_assessment(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_prrun_task ON production_release_run(coding_task_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prrun_input_fp ON production_release_run(input_fingerprint);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prrun_task_version ON production_release_run(coding_task_id, run_version);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prrun_auth_env ON production_release_run(release_authorization_id, target_environment);

    CREATE TABLE IF NOT EXISTS production_release_run_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      release_run_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      event_type TEXT NOT NULL,
      reason TEXT,
      error_code TEXT,
      evidence_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (release_run_id) REFERENCES production_release_run(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_prrev_run ON production_release_run_event(release_run_id, id);

    CREATE TABLE IF NOT EXISTS production_release_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      release_run_id INTEGER NOT NULL,
      evidence_kind TEXT NOT NULL,
      workflow_name TEXT,
      workflow_file TEXT,
      workflow_ref TEXT,
      workflow_run_id TEXT,
      workflow_attempt INTEGER,
      workflow_conclusion TEXT,
      workflow_head_sha TEXT,
      workflow_actor TEXT,
      target_environment TEXT,
      image_digest TEXT,
      oci_revision TEXT,
      oci_source TEXT,
      db_backup_identity TEXT,
      db_backup_hash TEXT,
      health_result TEXT,
      smoke_result TEXT,
      dispatch_request_id TEXT,
      provider_response_identity TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (release_run_id) REFERENCES production_release_run(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_previd_run ON production_release_evidence(release_run_id, id);

    CREATE TABLE IF NOT EXISTS production_release_workflow_binding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      release_run_id INTEGER NOT NULL,
      workflow_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      workflow_run_id TEXT,
      workflow_attempt INTEGER,
      dispatch_request_id TEXT,
      dispatch_owner TEXT,
      dispatch_intent_id TEXT,
      dispatch_claimed_at TEXT,
      dispatch_submitted_at TEXT,
      authorized_github_actor TEXT,
      provider_response_identity TEXT,
      binding_status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (release_run_id) REFERENCES production_release_run(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prbind_idem ON production_release_workflow_binding(idempotency_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prbind_kind ON production_release_workflow_binding(release_run_id, workflow_kind);

    CREATE TABLE IF NOT EXISTS production_release_current (
      coding_task_id INTEGER NOT NULL PRIMARY KEY,
      release_run_id INTEGER NOT NULL,
      current_status TEXT NOT NULL,
      input_fingerprint TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (release_run_id) REFERENCES production_release_run(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS production_stable_current (
      product_id TEXT NOT NULL,
      environment_key TEXT NOT NULL DEFAULT 'production',
      release_run_id INTEGER,
      source_sha TEXT,
      artifact_digest TEXT,
      workflow_run_id TEXT,
      provenance_json TEXT,
      provenance_fingerprint TEXT,
      static_tree_hash TEXT,
      schema_compat TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (product_id, environment_key)
    );

    CREATE TABLE IF NOT EXISTS production_release_global_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      release_run_id INTEGER,
      workflow_kind TEXT,
      lease_owner TEXT,
      claimed_at TEXT,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_state_entity_type ON state_entity(entity_type, state);
    CREATE INDEX IF NOT EXISTS idx_state_transition_entity ON state_transition(entity_type, entity_id, id);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id, id);

    -- DB 層防竄改：稽核鏈與狀態轉移一律 append-only，任何 UPDATE / DELETE 直接中止。
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_checkpoint_no_update BEFORE UPDATE ON audit_checkpoint
      BEGIN SELECT RAISE(ABORT, 'audit_checkpoint is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_checkpoint_no_delete BEFORE DELETE ON audit_checkpoint
      BEGIN SELECT RAISE(ABORT, 'audit_checkpoint is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS state_transition_no_update BEFORE UPDATE ON state_transition
      BEGIN SELECT RAISE(ABORT, 'state_transition is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS state_transition_no_delete BEFORE DELETE ON state_transition
      BEGIN SELECT RAISE(ABORT, 'state_transition is append-only'); END;
  `);
  upgradeMigrationSafetyImmutability(db);
  upgradeProductionReleaseImmutability(db);
  upgradeProductIsolation(db);
  upgradeExitDrill(db);
  upgradeCrmReplica(db);
  upgradeIssueFollowUp(db);
  upgradeProviderDrawer(db);
  upgradeLiveTargets(db);
  upgradeSiteCommand(db);
  return db;
}

export function upgradeSiteCommand(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_command_credential (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      secret TEXT NOT NULL,
      cred_state TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_command_cred_product ON product_command_credential(product_id, cred_state);
    CREATE TABLE IF NOT EXISTS site_command_job (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      command_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      job_state TEXT NOT NULL,
      apply_state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      site_result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT,
      subscription_generation INTEGER,
      UNIQUE(product_id, idempotency_key),
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_site_command_product ON site_command_job(product_id, id);
  `);
  const cols = tableColumns(db, "site_command_job");
  if (cols.length && !cols.includes("subscription_generation")) {
    db.exec("ALTER TABLE site_command_job ADD COLUMN subscription_generation INTEGER");
  }
}

export function upgradeLiveTargets(db) {
  ensureProductEnvironmentSchema(db);
  ensureInstructionRecordSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS production_release_target_lease (
      product_id TEXT NOT NULL,
      environment_key TEXT NOT NULL,
      release_run_id INTEGER,
      workflow_kind TEXT,
      lease_owner TEXT,
      claimed_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (product_id, environment_key)
    );
  `);
  const addIfMissing = (table, columns) => {
    let cols = [];
    try { cols = tableColumns(db, table); } catch { return; }
    if (!cols.length) return;
    for (const [name, decl] of columns) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    }
  };
  addIfMissing("production_release_run", [
    ["product_id", "TEXT"],
    ["environment_key", "TEXT"],
    ["instruction_source", "TEXT"],
    ["instruction_actor", "TEXT"],
    ["previous_stable_static_tree_hash", "TEXT"],
    ["previous_stable_schema_compat", "TEXT"],
  ]);
  migrateProductionStableEnvironmentScope(db);
  migrateGlobalLeaseToTargetLease(db);
  try {
    const products = db.prepare("SELECT id FROM ops_product").all();
    for (const row of products) ensureDefaultEnvironmentBindings(db, row.id);
  } catch { /* schema may still be mid-upgrade */ }
  ensureDefaultEnvironmentBindings(db, "v3");
}

export function upgradeProviderDrawer(db) {
  ensureProviderDrawerSchema(db);
}

export function upgradeIssueFollowUp(db) {
  const addIfMissing = (table, columns) => {
    let cols = [];
    try { cols = tableColumns(db, table); } catch { return; }
    if (!cols.length) return;
    for (const [name, decl] of columns) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    }
  };
  addIfMissing("issue_candidate", [
    ["parent_issue_id", "INTEGER"],
    ["issue_kind", "TEXT NOT NULL DEFAULT 'normal'"],
    ["product_id", "TEXT"],
  ]);
  addIfMissing("feedback_analysis", [
    ["subscription_generation", "INTEGER"],
  ]);
  addIfMissing("issue_evaluation_run", [
    ["subscription_generation", "INTEGER"],
  ]);
  addIfMissing("issue_proposal", [
    ["subscription_generation", "INTEGER"],
  ]);
  addIfMissing("development_coding_task", [
    ["subscription_generation", "INTEGER"],
  ]);
  addIfMissing("development_qa_run", [
    ["subscription_generation", "INTEGER"],
  ]);
  addIfMissing("development_staging_deployment", [
    ["subscription_generation", "INTEGER"],
  ]);
  addIfMissing("development_release_candidate", [
    ["subscription_generation", "INTEGER"],
  ]);
  addIfMissing("release_notification", [
    ["subscription_generation", "INTEGER"],
  ]);
  addIfMissing("production_release_run", [
    ["subscription_generation", "INTEGER"],
  ]);
  addIfMissing("proposal_owner_decision", [
    ["subscription_generation", "INTEGER"],
  ]);
  addIfMissing("issue_reevaluation_authorization", [
    ["subscription_generation", "INTEGER"],
  ]);
  db.exec("CREATE INDEX IF NOT EXISTS idx_issue_parent ON issue_candidate(parent_issue_id, id)");
}

export function upgradeCrmReplica(db) {
  ensureCrmReplicaSchema(db);
}

export function upgradeExitDrill(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_exit_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      action TEXT NOT NULL,
      exit_status TEXT NOT NULL,
      pending_json TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exit_record_product ON product_exit_record(product_id, id);
    CREATE TABLE IF NOT EXISTS product_handoff_export (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      exit_record_id INTEGER,
      manifest_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

// CREATE TRIGGER IF NOT EXISTS 不會升級已存在的舊 trigger；每次開庫重裝全欄位不可變。
export function upgradeMigrationSafetyImmutability(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS migsafety_immutable;
    DROP TRIGGER IF EXISTS migsafety_no_delete;
    CREATE TRIGGER migsafety_immutable BEFORE UPDATE ON production_migration_safety_assessment
    BEGIN SELECT RAISE(ABORT, 'migration safety assessment is immutable'); END;
    CREATE TRIGGER migsafety_no_delete BEFORE DELETE ON production_migration_safety_assessment
    BEGIN SELECT RAISE(ABORT, 'migration safety assessment is append-only'); END;
  `);
}

// Phase 15：release attempt / evidence 全欄位不可變；events 與 binding 的 identity 欄位不可改寫成另一次 dispatch。
export function upgradeProductionReleaseImmutability(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS prrun_immutable;
    DROP TRIGGER IF EXISTS prrun_no_delete;
    DROP TRIGGER IF EXISTS prrev_no_update;
    DROP TRIGGER IF EXISTS prrev_no_delete;
    DROP TRIGGER IF EXISTS previd_immutable;
    DROP TRIGGER IF EXISTS previd_no_delete;
    DROP TRIGGER IF EXISTS prbind_identity_immutable;
    DROP TRIGGER IF EXISTS prbind_no_delete;
    CREATE TRIGGER prrun_immutable BEFORE UPDATE ON production_release_run
    BEGIN SELECT RAISE(ABORT, 'production release run is immutable'); END;
    CREATE TRIGGER prrun_no_delete BEFORE DELETE ON production_release_run
    BEGIN SELECT RAISE(ABORT, 'production release run is append-only'); END;
    CREATE TRIGGER prrev_no_update BEFORE UPDATE ON production_release_run_event
    BEGIN SELECT RAISE(ABORT, 'production release events are append-only'); END;
    CREATE TRIGGER prrev_no_delete BEFORE DELETE ON production_release_run_event
    BEGIN SELECT RAISE(ABORT, 'production release events are append-only'); END;
    CREATE TRIGGER previd_immutable BEFORE UPDATE ON production_release_evidence
    BEGIN SELECT RAISE(ABORT, 'production release evidence is immutable'); END;
    CREATE TRIGGER previd_no_delete BEFORE DELETE ON production_release_evidence
    BEGIN SELECT RAISE(ABORT, 'production release evidence is append-only'); END;
    CREATE TRIGGER prbind_identity_immutable BEFORE UPDATE ON production_release_workflow_binding
    WHEN (
      IFNULL(NEW.release_run_id,0) <> IFNULL(OLD.release_run_id,0)
      OR IFNULL(NEW.workflow_kind,'') <> IFNULL(OLD.workflow_kind,'')
      OR IFNULL(NEW.idempotency_key,'') <> IFNULL(OLD.idempotency_key,'')
      OR (OLD.dispatch_intent_id IS NOT NULL AND IFNULL(NEW.dispatch_intent_id,'') <> IFNULL(OLD.dispatch_intent_id,''))
      OR (OLD.authorized_github_actor IS NOT NULL AND IFNULL(NEW.authorized_github_actor,'') <> IFNULL(OLD.authorized_github_actor,''))
      OR (OLD.workflow_run_id IS NOT NULL AND IFNULL(NEW.workflow_run_id,'') <> IFNULL(OLD.workflow_run_id,''))
      OR (OLD.workflow_attempt IS NOT NULL AND IFNULL(NEW.workflow_attempt,0) <> IFNULL(OLD.workflow_attempt,0))
      OR (OLD.dispatch_request_id IS NOT NULL AND IFNULL(NEW.dispatch_request_id,'') <> IFNULL(OLD.dispatch_request_id,''))
      OR (OLD.provider_response_identity IS NOT NULL AND IFNULL(NEW.provider_response_identity,'') <> IFNULL(OLD.provider_response_identity,''))
      OR (OLD.dispatch_submitted_at IS NOT NULL AND IFNULL(NEW.dispatch_submitted_at,'') <> IFNULL(OLD.dispatch_submitted_at,''))
    )
    BEGIN SELECT RAISE(ABORT, 'production release workflow binding identity is immutable'); END;
    CREATE TRIGGER prbind_no_delete BEFORE DELETE ON production_release_workflow_binding
    BEGIN SELECT RAISE(ABORT, 'production release workflow bindings are append-only'); END;
  `);
  ensureProductionReleaseBindingColumns(db);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function ensureProductionReleaseBindingColumns(db) {
  const addIfMissing = (table, columns) => {
    let cols = [];
    try { cols = tableColumns(db, table); } catch { return; }
    if (!cols.length) return;
    for (const [name, decl] of columns) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    }
  };
  addIfMissing("production_release_workflow_binding", [
    ["dispatch_owner", "TEXT"],
    ["dispatch_intent_id", "TEXT"],
    ["dispatch_claimed_at", "TEXT"],
    ["dispatch_submitted_at", "TEXT"],
    ["authorized_github_actor", "TEXT"],
  ]);
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_prrun_auth_env ON production_release_run(release_authorization_id, target_environment)");
  } catch { /* existing duplicate rows on old DBs stay fail-closed at app layer */ }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS production_release_global_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      release_run_id INTEGER,
      workflow_kind TEXT,
      lease_owner TEXT,
      claimed_at TEXT,
      updated_at TEXT
    )`);
  } catch { /* noop */ }
  addIfMissing("production_release_run", [
    ["authorized_github_actor", "TEXT"],
    ["previous_stable_release_run_id", "INTEGER"],
  ]);
  addIfMissing("production_stable_current", [
    ["provenance_fingerprint", "TEXT"],
  ]);
}

// 舊庫：ingest 去重是全域 UNIQUE；穩定版是 id=1。既有列明確歸入 v3，不猜「目前選取站」。
export function upgradeProductIsolation(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_product (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_subscription (
      product_id TEXT PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'connected',
      capabilities TEXT,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_ingest_credential (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      secret TEXT NOT NULL,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_product_cred_active ON product_ingest_credential(product_id, status);
  `);

  const ts = new Date().toISOString();
  db.prepare(`
    INSERT INTO ops_product(id, display_name, status, created_at, updated_at)
    VALUES ('v3', '吉比租房', 'active', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(ts, ts);
  db.prepare(`
    INSERT INTO product_subscription(product_id, generation, status, capabilities, started_at, updated_at)
    VALUES ('v3', 1, 'connected', '{"feedback_copy":true,"crm_sync":false,"stats":false,"cross_site_insight":false,"followup_service":false,"retain_after_exit":false}', ?, ?)
    ON CONFLICT(product_id) DO NOTHING
  `).run(ts, ts);

  migrateIngestedFeedbackProductScope(db);
  migrateProductionStableProductScope(db);

  const envSecret = process.env.OPS_INGEST_SECRET || "";
  if (envSecret) {
    const exists = db.prepare(
      "SELECT id FROM product_ingest_credential WHERE product_id='v3' AND status='active' AND secret=?",
    ).get(envSecret);
    if (!exists) {
      db.prepare(`
        INSERT INTO product_ingest_credential(product_id, generation, secret, label, status, created_at)
        VALUES ('v3', 1, ?, 'legacy-env', 'active', ?)
      `).run(envSecret, ts);
    }
  }
}

function migrateIngestedFeedbackProductScope(db) {
  let cols = [];
  try { cols = tableColumns(db, "ingested_feedback"); } catch { return; }
  if (!cols.length) return;
  if (cols.includes("product_id")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_ingested_product ON ingested_feedback(product_id, id)");
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE ingested_feedback_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL DEFAULT 'v3',
      delivery_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'unknown',
      external_feedback_id TEXT,
      user_ref TEXT,
      kind TEXT,
      content TEXT,
      contact TEXT,
      context TEXT,
      app_version TEXT,
      submitted_at TEXT,
      trust_level TEXT NOT NULL DEFAULT 'untrusted',
      payload_hash TEXT,
      received_at TEXT NOT NULL,
      UNIQUE(product_id, delivery_id),
      UNIQUE(product_id, idempotency_key)
    );
    INSERT INTO ingested_feedback_v2 (
      id, product_id, delivery_id, idempotency_key, source, external_feedback_id, user_ref, kind,
      content, contact, context, app_version, submitted_at, trust_level, payload_hash, received_at
    )
    SELECT id, 'v3', delivery_id, idempotency_key, source, external_feedback_id, user_ref, kind,
           content, contact, context, app_version, submitted_at, trust_level, payload_hash, received_at
      FROM ingested_feedback;
    DROP TABLE ingested_feedback;
    ALTER TABLE ingested_feedback_v2 RENAME TO ingested_feedback;
    CREATE INDEX IF NOT EXISTS idx_ingested_product ON ingested_feedback(product_id, id);
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

function migrateGlobalLeaseToTargetLease(db) {
  let oldCols = [];
  try { oldCols = tableColumns(db, "production_release_global_lease"); } catch { return; }
  if (!oldCols.length) return;
  const held = db.prepare("SELECT * FROM production_release_global_lease WHERE id=1").get();
  if (!held?.release_run_id) return;
  const ts = held.updated_at || new Date().toISOString();
  db.prepare(`
    INSERT INTO production_release_target_lease(
      product_id, environment_key, release_run_id, workflow_kind, lease_owner, claimed_at, updated_at)
    VALUES ('v3', 'production', ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, environment_key) DO UPDATE SET
      release_run_id=excluded.release_run_id,
      workflow_kind=excluded.workflow_kind,
      lease_owner=excluded.lease_owner,
      claimed_at=excluded.claimed_at,
      updated_at=excluded.updated_at
    WHERE production_release_target_lease.release_run_id IS NULL
  `).run(held.release_run_id, held.workflow_kind || null, held.lease_owner || null, held.claimed_at || null, ts);
}

function migrateProductionStableEnvironmentScope(db) {
  let cols = [];
  try { cols = tableColumns(db, "production_stable_current"); } catch { return; }
  if (!cols.length) return;
  if (cols.includes("environment_key") && cols.includes("static_tree_hash") && !cols.includes("id")) return;
  db.exec(`
    CREATE TABLE production_stable_current_v3 (
      product_id TEXT NOT NULL,
      environment_key TEXT NOT NULL DEFAULT 'production',
      release_run_id INTEGER,
      source_sha TEXT,
      artifact_digest TEXT,
      workflow_run_id TEXT,
      provenance_json TEXT,
      provenance_fingerprint TEXT,
      static_tree_hash TEXT,
      schema_compat TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (product_id, environment_key)
    );
    INSERT INTO production_stable_current_v3 (
      product_id, environment_key, release_run_id, source_sha, artifact_digest, workflow_run_id,
      provenance_json, provenance_fingerprint, static_tree_hash, schema_compat, updated_at
    )
    SELECT COALESCE(product_id, 'v3'), 'production', release_run_id, source_sha, artifact_digest, workflow_run_id,
           provenance_json, provenance_fingerprint, NULL, NULL, updated_at
      FROM production_stable_current;
    DROP TABLE production_stable_current;
    ALTER TABLE production_stable_current_v3 RENAME TO production_stable_current;
  `);
}

function migrateProductionStableProductScope(db) {
  let cols = [];
  try { cols = tableColumns(db, "production_stable_current"); } catch { return; }
  if (!cols.length) return;
  if (cols.includes("product_id") && !cols.includes("id")) return;
  if (cols.includes("product_id") && cols.includes("id")) {
    // 極少見的半遷移：已有 product_id 但仍用 id。維持現況，讀寫層改查 product_id。
    return;
  }
  db.exec(`
    CREATE TABLE production_stable_current_v2 (
      product_id TEXT PRIMARY KEY,
      release_run_id INTEGER,
      source_sha TEXT,
      artifact_digest TEXT,
      workflow_run_id TEXT,
      provenance_json TEXT,
      provenance_fingerprint TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO production_stable_current_v2 (
      product_id, release_run_id, source_sha, artifact_digest, workflow_run_id,
      provenance_json, provenance_fingerprint, updated_at
    )
    SELECT 'v3', release_run_id, source_sha, artifact_digest, workflow_run_id,
           provenance_json, provenance_fingerprint, updated_at
      FROM production_stable_current;
    DROP TABLE production_stable_current;
    ALTER TABLE production_stable_current_v2 RENAME TO production_stable_current;
  `);
}

// 開一個 ops 資料庫。dbPath = ":memory:" 供測試使用。
// Baseline 設定（明確且集中）：
// - foreign_keys = ON：外鍵約束（未來 domain 表需要）。
// - journal_mode = WAL：檔案型 DB 併發讀寫較佳（:memory: 會忽略）。
// - busy_timeout = 5000：兩個連線競爭寫鎖時等待而非立即 SQLITE_BUSY，配合 BEGIN IMMEDIATE 避免 fork。
// - synchronous = FULL：稽核/狀態機是 metadata，重durability 勝過吞吐；每次 commit 落盤。
export function openOpsDb(dbPath) {
  const target = dbPath || defaultDbPath();
  if (target !== ":memory:") {
    mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  applyOpsSchema(db);
  reapplyPurgeLedger(db);
  return db;
}

export function defaultDataDir() {
  return process.env.OPS_DATA_DIR || path.join(process.cwd(), "data-ops");
}

export function defaultDbPath() {
  return path.join(defaultDataDir(), "ops.db");
}

export { existsSync };
