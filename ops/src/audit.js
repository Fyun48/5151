import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";

// 稽核鏈：append-only + hash-chain（tamper-evident，非真 immutable）。
// hash = sha256(prev_hash + "\n" + canonical(payload))。竄改任一列都會讓其後 hash 對不上。
//
// 兩種入口：
//   appendAuditRow(db, ...)：核心，無自帶交易。給「已在交易內」的呼叫者（如 state transition）使用。
//   appendAudit(db, ...)：包一個 BEGIN IMMEDIATE 交易，給獨立稽核寫入（如登入成功/失敗）使用。
// 兩者都會先做 redaction，稽核永遠不落地密碼 / token / 金鑰 / 憑證。

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// 敏感 key 一律遮罩；並掃描字串值裡疑似 token 的樣式。
const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|cookie|authorization|auth[-_]?header|api[-_]?key|access[-_]?key|private[-_]?key|credential|session|bearer|otp|ssh[-_]?key)/i;
const SENSITIVE_VALUE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})/;
const REDACTED = "[REDACTED]";

export function redactAuditData(value, depth = 0) {
  if (depth > 6) return "[TRUNCATED]";
  if (value == null) return value;
  if (typeof value === "string") {
    return SENSITIVE_VALUE.test(value) ? REDACTED : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactAuditData(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactAuditData(v, depth + 1);
  }
  return out;
}

export function lastAudit(db) {
  return db.prepare("SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1").get();
}

export function computeAuditHash(prevHash, row) {
  const payload = stableStringify({
    ts: row.ts,
    actor: row.actor,
    action: row.action,
    entity_type: row.entity_type ?? null,
    entity_id: row.entity_id ?? null,
    data: row.data ?? null,
  });
  return createHash("sha256").update(`${prevHash || ""}\n${payload}`).digest("hex");
}

// 核心：假設呼叫端已在交易內（無自帶 BEGIN/COMMIT）。
export function appendAuditRow(db, { actor, action, entityType = null, entityId = null, data = null, now = new Date() }) {
  if (!actor || !action) throw new Error("audit requires actor and action");
  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const safeData = data == null ? null : redactAuditData(data);
  const dataText = safeData == null ? null : stableStringify(safeData);
  const prev = lastAudit(db);
  const prevHash = prev ? prev.hash : "";
  const row = {
    ts,
    actor: String(actor),
    action: String(action),
    entity_type: entityType == null ? null : String(entityType),
    entity_id: entityId == null ? null : String(entityId),
    data: dataText,
  };
  const hash = computeAuditHash(prevHash, row);
  const res = db.prepare(
    `INSERT INTO audit_log(ts, actor, action, entity_type, entity_id, data, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.ts, row.actor, row.action, row.entity_type, row.entity_id, row.data, prevHash, hash);
  return { id: Number(res.lastInsertRowid), hash, prevHash };
}

// 獨立稽核寫入：自帶單一序列化交易，避免並發下 hash-chain 分岔。
export function appendAudit(db, opts) {
  return withImmediateTx(db, () => appendAuditRow(db, opts));
}

const AUDIT_PAGE_DEFAULT = 100;
const AUDIT_PAGE_MAX = 500;

// 一律有上限與分頁，避免不小心回傳整段歷史。
export function listAudit(db, { limit, offset = 0 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX));
  const off = Math.max(0, Number(offset) || 0);
  const total = Number(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n) || 0;
  const items = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?").all(cap, off);
  return { items, total, limit: cap, offset: off };
}

export function verifyAuditChain(db) {
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY id ASC").all();
  let prevHash = "";
  for (const r of rows) {
    if (String(r.prev_hash || "") !== prevHash) {
      return { ok: false, brokenAt: Number(r.id), reason: "prev_hash mismatch", count: rows.length };
    }
    const expect = computeAuditHash(prevHash, r);
    if (expect !== r.hash) {
      return { ok: false, brokenAt: Number(r.id), reason: "hash mismatch", count: rows.length };
    }
    prevHash = r.hash;
  }
  return { ok: true, count: rows.length, head: prevHash };
}

export function createCheckpoint(db, { now = new Date() } = {}) {
  return withImmediateTx(db, () => {
    const rows = db.prepare("SELECT id, hash, ts FROM audit_log ORDER BY id ASC").all();
    if (!rows.length) return null;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const rangeRoot = createHash("sha256").update(rows.map((r) => r.hash).join("\n")).digest("hex");
    const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const res = db.prepare(
      `INSERT INTO audit_checkpoint(period_start, period_end, from_id, to_id, range_root_hash, external_anchor, signature, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(first.ts, last.ts, Number(first.id), Number(last.id), rangeRoot, ts);
    return { id: Number(res.lastInsertRowid), fromId: Number(first.id), toId: Number(last.id), rangeRoot };
  });
}

export function listCheckpoints(db, { limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 1000));
  return db.prepare("SELECT * FROM audit_checkpoint ORDER BY id DESC LIMIT ?").all(cap);
}
