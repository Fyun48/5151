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
