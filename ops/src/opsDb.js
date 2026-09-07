import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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

    -- Phase 2：從 Product 非同步遞送進來的 feedback。
    -- delivery_id / idempotency_key 皆唯一 → 重複遞送只會有一筆邏輯紀錄（冪等）。
    -- trust_level 一律 untrusted；Phase 2 只儲存與傳輸，不執行任何內容。
    CREATE TABLE IF NOT EXISTS ingested_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
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
      received_at TEXT NOT NULL
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
      status TEXT NOT NULL DEFAULT 'pending',       -- pending|processing|completed|failed|failed_retry
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
  return db;
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
  return db;
}

export function defaultDataDir() {
  return process.env.OPS_DATA_DIR || path.join(process.cwd(), "data-ops");
}

export function defaultDbPath() {
  return path.join(defaultDataDir(), "ops.db");
}

export { existsSync };
