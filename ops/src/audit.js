import { createHash } from "node:crypto";

// 稽核鏈：append-only + hash-chain（tamper-evident，非真 immutable）。
// hash = sha256(prev_hash + "\n" + canonical(payload))。
// 竄改任何一列都會讓其後所有 hash 對不上，verifyAuditChain 可偵測。

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function lastAudit(db) {
  return db.prepare("SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1").get();
}

// 只覆蓋不可變的內容欄位（不含自增 id）。
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

export function appendAudit(db, { actor, action, entityType = null, entityId = null, data = null, now = new Date() }) {
  if (!actor || !action) throw new Error("audit requires actor and action");
  const ts = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const dataText = data == null ? null : stableStringify(data);
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

export function listAudit(db, { limit = 200, offset = 0 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const off = Math.max(0, Number(offset) || 0);
  return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?").all(cap, off);
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

// 週期 checkpoint：把目前整條鏈壓成一個 range root hash 存檔，供未來對外簽章 / 備份。
export function createCheckpoint(db, { now = new Date() } = {}) {
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
}

export function listCheckpoints(db, { limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 1000));
  return db.prepare("SELECT * FROM audit_checkpoint ORDER BY id DESC LIMIT ?").all(cap);
}
