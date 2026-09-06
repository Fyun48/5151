// 使用者回饋（bug 回報／功能建議／其他）。
// 設計目標：使用者輸入越少越好，系統自動補齊情境，方便日後自動化分類與優先排序。
import { enqueueFeedbackOutbox } from "./feedbackOutbox.js";

export const FEEDBACK_KINDS = [
  { id: "bug", label: "回報問題", hint: "哪裡怪怪的、壞掉、看到錯誤" },
  { id: "idea", label: "功能建議", hint: "想要什麼、希望怎麼更好用" },
  { id: "other", label: "其他", hint: "體驗、文字、任何想說的" },
];

export const FEEDBACK_STATUSES = [
  { id: "new", label: "待看" },
  { id: "planned", label: "已排入" },
  { id: "doing", label: "處理中" },
  { id: "done", label: "已完成" },
  { id: "declined", label: "暫不處理" },
];

export const FEEDBACK_BODY_MIN = 4;
export const FEEDBACK_BODY_MAX = 2000;
export const FEEDBACK_CONTACT_MAX = 200;
export const FEEDBACK_NOTE_MAX = 2000;
export const FEEDBACK_CONTEXT_MAX = 4000;
export const FEEDBACK_MIN_GAP_MS = 20 * 1000;
export const FEEDBACK_MAX_PER_HOUR = 10;
export const FEEDBACK_MAX_PER_DAY = 30;

export const FEEDBACK_LEGAL =
  "回饋內容（含系統自動附上的目前畫面、篩選條件、裝置與版本）只給站方看，用來修 bug 與改功能。請不要在這裡填寫密碼或其他機密。";

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function nowMs(now) {
  return now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
}

function iso(now) {
  return new Date(nowMs(now)).toISOString();
}

export function normalizeFeedbackKind(value) {
  const id = String(value || "").trim().toLowerCase();
  return FEEDBACK_KINDS.some((row) => row.id === id) ? id : "other";
}

export function normalizeFeedbackStatus(value) {
  const id = String(value || "").trim().toLowerCase();
  return FEEDBACK_STATUSES.some((row) => row.id === id) ? id : "new";
}

// 只保留可序列化、上限受控的情境資料，避免任何人塞爆資料表。
export function normalizeFeedbackContext(input) {
  let obj = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      obj = {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  const strField = (key, max = 300) => {
    const raw = obj[key];
    if (raw == null) return;
    const text = String(raw).trim();
    if (text) out[key] = text.slice(0, max);
  };
  strField("route", 300);
  strField("view", 40);
  strField("role", 40);
  strField("plan", 40);
  strField("version", 40);
  strField("viewport", 40);
  strField("ua", 400);
  strField("lang", 40);
  strField("q", 200);
  strField("filter", 400);
  if (Array.isArray(obj.errors)) {
    const errs = obj.errors
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 5)
      .map((item) => item.slice(0, 300));
    if (errs.length) out.errors = errs;
  }
  return out;
}

export function ensureFeedbackSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'other',
      body TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'new',
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, id);
    CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at);
  `);
}

function userInfo(db, userId) {
  try {
    const row = db.prepare("SELECT email, nickname FROM users WHERE id = ?").get(Number(userId) || 0);
    return { email: String(row?.email || ""), nickname: String(row?.nickname || "") };
  } catch {
    return { email: "", nickname: "" };
  }
}

function assertNotFlooding(db, userId, now) {
  const uid = Number(userId) || 0;
  if (!uid) return;
  const last = db.prepare(
    "SELECT created_at FROM feedback WHERE user_id = ? ORDER BY id DESC LIMIT 1",
  ).get(uid);
  if (last && nowMs(now) - Date.parse(last.created_at) < FEEDBACK_MIN_GAP_MS) {
    throw httpError("剛剛才送出，請稍等一下再送", 429);
  }
  const hourAgo = new Date(nowMs(now) - 60 * 60 * 1000).toISOString();
  const hourly = db.prepare(
    "SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at >= ?",
  ).get(uid, hourAgo);
  if (Number(hourly?.n) >= FEEDBACK_MAX_PER_HOUR) {
    throw httpError("這一小時送出的回饋已達上限，稍後再試", 429);
  }
  const dayAgo = new Date(nowMs(now) - 24 * 60 * 60 * 1000).toISOString();
  const daily = db.prepare(
    "SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at >= ?",
  ).get(uid, dayAgo);
  if (Number(daily?.n) >= FEEDBACK_MAX_PER_DAY) {
    throw httpError("今天送出的回饋已達上限，明天再試", 429);
  }
}

export function createFeedback(db, userId, input = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  // honeypot：正常使用者看不到、也不會填這個欄位。
  if (String(input?.website || input?.hp || "").trim()) {
    return { ok: true, id: 0 };
  }
  assertNotFlooding(db, uid, now);
  const kind = normalizeFeedbackKind(input.kind);
  const body = String(input.body || "").trim();
  if (body.length < FEEDBACK_BODY_MIN) {
    throw httpError(`請多寫一點（至少 ${FEEDBACK_BODY_MIN} 個字）`);
  }
  const trimmedBody = body.slice(0, FEEDBACK_BODY_MAX);
  const contact = String(input.contact || "").trim().slice(0, FEEDBACK_CONTACT_MAX);
  const context = normalizeFeedbackContext(input.context);
  let contextText = JSON.stringify(context);
  if (contextText.length > FEEDBACK_CONTEXT_MAX) contextText = "{}";
  const stamp = iso(now);
  const result = db.prepare(
    `INSERT INTO feedback(user_id, kind, body, contact, context, status, admin_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'new', '', ?, ?)`,
  ).run(uid, kind, trimmedBody, contact, contextText, stamp, stamp);
  return { ok: true, id: Number(result.lastInsertRowid) };
}

// Phase 2：原子地建立 feedback 與其初始 outbox 事件（同一交易）。
// 不變式：feedback 存在 ⇔ 對應的初始 outbox 事件存在。
// enqueue=false 時只寫 feedback（供 outbox 功能停用時使用；此時不保證 IFF，僅用於明確關閉整合的情境）。
export function createFeedbackWithOutbox(db, userId, input = {}, { enqueue = true, now = new Date() } = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const res = createFeedback(db, userId, input, now);
    if (enqueue && res.id > 0) {
      const row = db.prepare("SELECT * FROM feedback WHERE id = ?").get(res.id);
      const ctx = parseContext(row.context);
      enqueueFeedbackOutbox(db, {
        feedbackId: res.id,
        data: {
          source: "v3",
          external_feedback_id: res.id,
          user_ref: Number(row.user_id) || 0,
          kind: row.kind,
          content: row.body,
          contact: row.contact || "",
          context: ctx,
          app_version: ctx.version || null,
          submitted_at: row.created_at,
          trust_level: "untrusted",
        },
        now,
      });
    }
    db.exec("COMMIT");
    return res;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* keep original error */ }
    throw err;
  }
}

function parseContext(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function decorateFeedback(db, row) {
  const info = userInfo(db, row.user_id);
  return {
    id: Number(row.id),
    user_id: Number(row.user_id) || 0,
    email: info.email,
    nickname: info.nickname,
    kind: normalizeFeedbackKind(row.kind),
    body: String(row.body || ""),
    contact: String(row.contact || ""),
    context: parseContext(row.context),
    status: normalizeFeedbackStatus(row.status),
    admin_note: String(row.admin_note || ""),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listFeedback(db, { status = "", kind = "", limit = 200 } = {}) {
  const where = [];
  const args = [];
  const st = String(status || "").trim().toLowerCase();
  if (st && st !== "all" && FEEDBACK_STATUSES.some((row) => row.id === st)) {
    where.push("status = ?");
    args.push(st);
  }
  const kd = String(kind || "").trim().toLowerCase();
  if (kd && kd !== "all" && FEEDBACK_KINDS.some((row) => row.id === kd)) {
    where.push("kind = ?");
    args.push(kd);
  }
  const cap = Math.max(1, Math.min(Number(limit) || 200, 500));
  const sql = `SELECT * FROM feedback ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${cap}`;
  const rows = db.prepare(sql).all(...args);
  return rows.map((row) => decorateFeedback(db, row));
}

export function feedbackStats(db) {
  const out = { total: 0, byStatus: {}, byKind: {} };
  for (const row of FEEDBACK_STATUSES) out.byStatus[row.id] = 0;
  for (const row of FEEDBACK_KINDS) out.byKind[row.id] = 0;
  try {
    const statusRows = db.prepare("SELECT status, COUNT(*) AS n FROM feedback GROUP BY status").all();
    for (const r of statusRows) {
      const id = normalizeFeedbackStatus(r.status);
      out.byStatus[id] = (out.byStatus[id] || 0) + Number(r.n || 0);
      out.total += Number(r.n || 0);
    }
    const kindRows = db.prepare("SELECT kind, COUNT(*) AS n FROM feedback GROUP BY kind").all();
    for (const r of kindRows) {
      const id = normalizeFeedbackKind(r.kind);
      out.byKind[id] = (out.byKind[id] || 0) + Number(r.n || 0);
    }
  } catch {
    // ignore
  }
  return out;
}

export function updateFeedback(db, id, patch = {}, now = new Date()) {
  const row = db.prepare("SELECT * FROM feedback WHERE id = ?").get(Number(id) || 0);
  if (!row) throw httpError("找不到這則回饋", 404);
  const sets = [];
  const args = [];
  if (patch.status != null) {
    sets.push("status = ?");
    args.push(normalizeFeedbackStatus(patch.status));
  }
  if (patch.admin_note != null) {
    sets.push("admin_note = ?");
    args.push(String(patch.admin_note || "").trim().slice(0, FEEDBACK_NOTE_MAX));
  }
  if (!sets.length) return decorateFeedback(db, row);
  sets.push("updated_at = ?");
  args.push(iso(now));
  args.push(row.id);
  db.prepare(`UPDATE feedback SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  const next = db.prepare("SELECT * FROM feedback WHERE id = ?").get(row.id);
  return decorateFeedback(db, next);
}

export function feedbackMeta() {
  return {
    kinds: FEEDBACK_KINDS,
    statuses: FEEDBACK_STATUSES,
    bodyMax: FEEDBACK_BODY_MAX,
    legal: FEEDBACK_LEGAL,
  };
}
