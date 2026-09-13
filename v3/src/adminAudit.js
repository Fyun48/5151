/** 後台管理操作紀錄。存在 settings JSON，不必 migration。不記密碼與密鑰明文。 */

import { db } from "./db.js";

const SETTING_KEY = "adminAuditLog";
const MAX_ENTRIES = 200;
const SECRET_RE = /password|passwd|secret|api[_-]?key|smtpPass|clientSecret|token|authorization/i;

export function redactAuditValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 400) return `${value.slice(0, 400)}…`;
    return value;
  }
  if (typeof value !== "object" || depth > 3) return String(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactAuditValue(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_RE.test(key) ? (item ? "[redacted]" : "") : redactAuditValue(item, depth + 1);
  }
  return out;
}

function readRaw() {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTING_KEY);
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function listAdminAudit({ limit = 80 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 80));
  return readRaw().slice(0, cap);
}

export function appendAdminAudit({
  actorId = 0,
  actorEmail = "",
  action = "",
  target = "",
  before = null,
  after = null,
  now = new Date(),
} = {}) {
  const entry = {
    at: (now instanceof Date ? now : new Date(now)).toISOString(),
    actorId: Number(actorId) || 0,
    actorEmail: String(actorEmail || "").trim().slice(0, 200),
    action: String(action || "").trim().slice(0, 80),
    target: String(target || "").trim().slice(0, 240),
    before: redactAuditValue(before),
    after: redactAuditValue(after),
  };
  const next = [entry, ...readRaw()].slice(0, MAX_ENTRIES);
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(SETTING_KEY, JSON.stringify(next));
  return entry;
}

export function lastAuditAction(action) {
  return readRaw().find((row) => row.action === action) || null;
}
