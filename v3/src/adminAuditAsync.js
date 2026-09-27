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

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// adminAudit.js appendAdminAudit() 的 PG 分支。步驟與同步版逐條對應：寫入後把超過
// ADMIN_AUDIT_MAX_ENTRIES 的舊資料刪掉。
export async function appendAdminAuditAsync(params = {}, options = {}) {
  if (!isPg(options)) return appendAdminAuditSync(params);
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
