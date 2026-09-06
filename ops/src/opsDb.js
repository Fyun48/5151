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
    -- 每次 (feedback_id, analysis_type, prompt_version, attempt) 一列；reprocess 產生新的 attempt，不覆寫歷史。
    -- 只存結構化結果與 raw_output_hash（雜湊），不存隱藏推理鏈。FK → ingested_feedback。
    CREATE TABLE IF NOT EXISTS feedback_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_id INTEGER NOT NULL,
      analysis_type TEXT NOT NULL DEFAULT 'classification',
      attempt INTEGER NOT NULL DEFAULT 1,
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
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TEXT NOT NULL,
      claimed_at TEXT,
      usage_input_tokens INTEGER,
      usage_output_tokens INTEGER,
      estimated_cost REAL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (feedback_id) REFERENCES ingested_feedback(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_identity ON feedback_analysis(feedback_id, analysis_type, prompt_version, attempt);
    CREATE INDEX IF NOT EXISTS idx_analysis_status ON feedback_analysis(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_analysis_feedback ON feedback_analysis(feedback_id, id);

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
