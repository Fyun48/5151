// 後台稽核紀錄的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼需要：`appendAdminAudit()` 是對 `admin_audit` 的原始 SQLite 寫入，而 `auditReq()`（server.js）
// 在 admin 路由裡有 **20 個呼叫點**。所以在 PG 模式下，整條管理操作的稽核軌跡都寫進
// 「回答你那台節點」的本機檔案——另一台看不到，換節點就查不到剛才做了什麼。
// `admin_audit` 在 PG **本來就存在**（已對 information_schema 查證），只是 App 從沒寫過。
//
// 純規則（長度截斷、密鑰遮蔽）留在 adminAudit.js 的 buildAuditEntry()，兩個 driver 共用；
// 這裡只換「跑語句的人」。
//
// ⚠️ 一個必須講清楚的 PG 差異：同步版清理舊資料用的是
//     SELECT id FROM admin_audit ORDER BY id DESC LIMIT -1 OFFSET ?
//   `LIMIT -1` 是 SQLite 的「無上限」寫法，**PostgreSQL 不接受**，而 toPostgresSql 不會轉譯它。
//   所以 PG 分支用不帶 LIMIT 的版本（PG 的 OFFSET 語意相同）。
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import {
  ADMIN_AUDIT_MAX_ENTRIES,
  appendAdminAudit as appendAdminAuditSync,
  buildAuditEntry,
  lastAuditAction as lastAuditActionSync,
  listAdminAudit as listAdminAuditSync,
  rowToEntry,
} from "./adminAudit.js";

const COLUMNS = "at, actor_id, actor_email, action, target, before_json, after_json";
const INSERT_SQL = `INSERT INTO admin_audit(${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const LIST_SQL = `SELECT ${COLUMNS} FROM admin_audit ORDER BY id DESC LIMIT ?`;
const LAST_SQL = `SELECT ${COLUMNS} FROM admin_audit WHERE action = ? ORDER BY id DESC LIMIT 1`;
// 同步版用 `LIMIT -1 OFFSET ?`（SQLite 的「無上限」）；PG 不接受 LIMIT -1。
// 這裡改用 **`LIMIT 1 OFFSET ?`**：取「第 MAX+1 新的那一筆」，與同步版的第一列完全相同，
// 而且在 PostgreSQL 與 SQLite **都合法**——不需要為了方言寫兩份 SQL。
const TRIM_LOOKUP_SQL = "SELECT id FROM admin_audit ORDER BY id DESC LIMIT 1 OFFSET ?";
const TRIM_DELETE_SQL = "DELETE FROM admin_audit WHERE id <= ?";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// ---- 失敗可視性（2026-09-27 新增）--------------------------------------------
//
// 為什麼一定要有：`auditReq()` 的契約是「稽核失敗不得擋住管理操作」，所以它
// fire-and-forget 並吞掉錯誤。但那個契約讓一個**全損**的故障變得完全隱形——
// 正式站的 `admin_audit.id` identity 序列落後（`is_called=false` → nextval 回傳已存在的 1），
// 導致 #521 之後的**每一筆**稽核寫入都撞主鍵失敗，而 12 天內沒有任何日誌或告警，
// `admin_audit` 始終只有匯入的那一列。
// 詳見 `docs/handoffs/PG-IDENTITY-SEQUENCE-DEFECT-20260927.md`。
//
// 契約不變：仍然**不 await、不 throw**，管理操作照常完成。
// 改變的只有「失敗要留下痕跡」：計數器 + 日誌（第一次一定印，之後每 100 次印一次，避免洗版）。
// 計數器由 `auditFailureStats()` 讀出，`server.js` 把它接到 `/api/health`。
let auditFailures = 0;
let lastAuditFailure = null;
// 印 log 的節奏用**自己的**計數器，刻意不與 auditFailures 共用。
// 原因：`auditFailures % 100 === 0` 在計數器壞掉（停在 0）時恆為真 ⇒ 反而每次都印、變成洗版。
// 「算得準」與「印得省」是兩個關注點，不該互相耦合；各自的突變測試也才分得開。
let auditFailureLogs = 0;
const AUDIT_FAILURE_LOG_EVERY = 100;

function noteAuditFailure(error) {
  auditFailures += 1;
  lastAuditFailure = { at: new Date().toISOString(), message: String(error?.message || error || "unknown") };
  auditFailureLogs += 1;
  if (auditFailureLogs === 1 || auditFailureLogs % AUDIT_FAILURE_LOG_EVERY === 0) {
    console.error(`[audit] PG 稽核寫入失敗（累計 ${auditFailures} 筆）：${lastAuditFailure.message}`);
  }
}

/** 給 /api/health 用的快照。刻意只回數字與最後一次的訊息，不含 actor／target。 */
export function auditFailureStats() {
  return { failures: auditFailures, last: lastAuditFailure };
}

/** 只給測試用：把計數器歸零，讓每個 test 從乾淨狀態開始。 */
export function resetAuditFailureStats() {
  auditFailures = 0;
  lastAuditFailure = null;
  auditFailureLogs = 0;
}

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// adminAudit.js appendAdminAudit() 的 PG 分支。步驟與同步版逐條對應：寫入後把超過
// ADMIN_AUDIT_MAX_ENTRIES 的舊資料刪掉。
export async function appendAdminAuditAsync(params = {}, options = {}) {
  if (!isPg(options)) return appendAdminAuditSync(params);
  try {
    return await writeAdminAuditPg(params, options);
  } catch (error) {
    // 契約不變（仍然往外丟，由呼叫端決定要不要擋管理操作），但失敗一定留下痕跡。
    noteAuditFailure(error);
    throw error;
  }
}

async function writeAdminAuditPg(params, options) {
  const entry = buildAuditEntry(params);
  const exec = await pgExec(options);
  await exec(INSERT_SQL, [
    entry.at,
    entry.actorId,
    entry.actorEmail,
    entry.action,
    entry.target,
    entry.before == null ? null : JSON.stringify(entry.before),
    entry.after == null ? null : JSON.stringify(entry.after),
  ]);
  const extra = await exec(TRIM_LOOKUP_SQL, [ADMIN_AUDIT_MAX_ENTRIES]);
  if (extra[0]?.id != null) await exec(TRIM_DELETE_SQL, [extra[0].id]);
  return entry;
}

export async function listAdminAuditAsync({ limit = 80 } = {}, options = {}) {
  if (!isPg(options)) return listAdminAuditSync({ limit });
  const cap = Math.max(1, Math.min(ADMIN_AUDIT_MAX_ENTRIES, Number(limit) || 80));
  const exec = await pgExec(options);
  return (await exec(LIST_SQL, [cap])).map(rowToEntry);
}

export async function lastAuditActionAsync(action, options = {}) {
  if (!isPg(options)) return lastAuditActionSync(action);
  const exec = await pgExec(options);
  const rows = await exec(LAST_SQL, [String(action || "")]);
  return rows[0] ? rowToEntry(rows[0]) : null;
}
