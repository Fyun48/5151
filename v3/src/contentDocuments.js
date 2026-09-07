/** 產品內容／條款版本庫：小型、可延伸、已發布版本不可改接受相關本文。 */
import { createHash } from "node:crypto";
import {
  CONTENT_BODY_MAX,
  CONTENT_CHECK_MAX,
  CONTENT_TITLE_MAX,
  containsUnsafeMarkup,
  sanitizeDocumentBody,
  sanitizeDocumentText,
} from "./safeContent.js";
import { defaultLegalCopy, ensureIdleLegalClauses } from "./legalCopy.js";
import { DEMAND_LEGAL } from "./demand.js";
import { SELF_LEGAL, SELF_PLEDGE } from "./selfListings.js";

export const DOC_TYPES = {
  registration_terms: {
    id: "registration_terms",
    label: "註冊免責聲明",
    required_at: "registration",
    seed_title: "免責聲明",
  },
  privacy_notice: {
    id: "privacy_notice",
    label: "個資說明",
    required_at: "registration",
    seed_title: "個資說明",
  },
  listing_rules: {
    id: "listing_rules",
    label: "刊登規則",
    required_at: "listing",
    seed_title: "刊登規則",
  },
  external_import_declaration: {
    id: "external_import_declaration",
    label: "外部匯入聲明",
    required_at: "import",
    seed_title: "外部物件匯入聲明",
  },
  wish_room_rules: {
    id: "wish_room_rules",
    label: "許願房規則（尚未開通）",
    required_at: "wish_room",
    seed_title: "許願房使用規則",
  },
};

export const REGISTRATION_DOC_TYPES = Object.values(DOC_TYPES)
  .filter((row) => row.required_at === "registration")
  .map((row) => row.id);

export function isKnownDocType(type) {
  return Boolean(DOC_TYPES[String(type || "")]);
}

export function documentFingerprint(input = {}) {
  const canonical = JSON.stringify({
    document_type: String(input.document_type || ""),
    version: Number(input.version) || 0,
    title: String(input.title || ""),
    body: String(input.body || ""),
    format: String(input.format || "plain"),
    check_label: String(input.check_label || ""),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function ensureContentDocumentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_type TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'plain',
      check_label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      enabled INTEGER NOT NULL DEFAULT 1,
      requires_reacceptance INTEGER NOT NULL DEFAULT 0,
      effective_from TEXT,
      effective_until TEXT,
      content_hash TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      published_at TEXT,
      supersedes_id INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_documents_type_version
      ON content_documents(document_type, version);
    CREATE INDEX IF NOT EXISTS idx_content_documents_effective
      ON content_documents(document_type, status, enabled, version);
    CREATE TABLE IF NOT EXISTS content_document_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER,
      document_type TEXT NOT NULL,
      version INTEGER,
      action TEXT NOT NULL,
      actor_id INTEGER,
      content_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_content_document_events_doc
      ON content_document_events(document_type, document_id, created_at);
  `);
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS content_documents_immutable
      BEFORE UPDATE ON content_documents
      WHEN OLD.status = 'published' AND (
        NEW.body IS NOT OLD.body
        OR NEW.title IS NOT OLD.title
        OR NEW.format IS NOT OLD.format
        OR NEW.check_label IS NOT OLD.check_label
        OR NEW.content_hash IS NOT OLD.content_hash
        OR NEW.version IS NOT OLD.version
        OR NEW.document_type IS NOT OLD.document_type
      )
      BEGIN
        SELECT RAISE(ABORT, 'published_document_immutable');
      END;
    `);
  } catch {
    // trigger 已存在
  }
}

function audit(db, { document_id, document_type, version, action, actor_id, content_hash, now }) {
  db.prepare(
    `INSERT INTO content_document_events(document_id, document_type, version, action, actor_id, content_hash, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(document_id || null, document_type, version || null, action, actor_id || null, content_hash || "", iso(now));
}

function rowToDoc(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    document_type: row.document_type,
    version: Number(row.version),
    title: row.title,
    body: row.body,
    format: row.format || "plain",
    check_label: row.check_label || "",
    status: row.status,
    enabled: Number(row.enabled) === 1,
    requires_reacceptance: Number(row.requires_reacceptance) === 1,
    effective_from: row.effective_from || null,
    effective_until: row.effective_until || null,
    content_hash: row.content_hash,
    created_by: row.created_by == null ? null : Number(row.created_by),
    created_at: row.created_at,
    published_at: row.published_at || null,
    supersedes_id: row.supersedes_id == null ? null : Number(row.supersedes_id),
  };
}

export function publicDocumentView(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    document_type: doc.document_type,
    version: doc.version,
    title: doc.title,
    body: doc.body,
    format: doc.format,
    check_label: doc.check_label,
    requires_reacceptance: Boolean(doc.requires_reacceptance),
    effective_from: doc.effective_from,
    effective_until: doc.effective_until,
    content_hash: doc.content_hash,
    published_at: doc.published_at,
  };
}

export function adminDocumentView(doc) {
  return doc;
}

function assertType(type) {
  const id = String(type || "");
  if (!isKnownDocType(id)) throw httpError("未知的文件類型", 400);
  return id;
}

function normalizeFormat(format) {
  return String(format || "plain") === "markdown" ? "markdown" : "plain";
}

function inEffect(doc, nowIso) {
  if (!doc || doc.status !== "published" || !doc.enabled) return false;
  if (doc.effective_from && String(doc.effective_from) > nowIso) return false;
  if (doc.effective_until && String(doc.effective_until) <= nowIso) return false;
  return true;
}

export function listDocuments(db, { type, includeDrafts = false } = {}) {
  const rows = type
    ? db.prepare("SELECT * FROM content_documents WHERE document_type=? ORDER BY version DESC, id DESC").all(type)
    : db.prepare("SELECT * FROM content_documents ORDER BY document_type, version DESC, id DESC").all();
  return rows.map(rowToDoc).filter((doc) => includeDrafts || doc.status === "published");
}

export function getDocumentById(db, id) {
  return rowToDoc(db.prepare("SELECT * FROM content_documents WHERE id=?").get(Number(id) || 0));
}

export function getDocumentByTypeVersion(db, type, version) {
  return rowToDoc(
    db.prepare("SELECT * FROM content_documents WHERE document_type=? AND version=?").get(assertType(type), Number(version) || 0),
  );
}

/** 目前生效文件：已發布、啟用、在有效期間內、版本號最高。 */
export function getEffectiveDocument(db, type, { now = new Date() } = {}) {
  const id = assertType(type);
  const nowIso = iso(now);
  const rows = db.prepare(
    "SELECT * FROM content_documents WHERE document_type=? AND status='published' ORDER BY version DESC, id DESC",
  ).all(id).map(rowToDoc);
  return rows.find((doc) => inEffect(doc, nowIso)) || null;
}

export function getRequiredRegistrationDocuments(db, { now = new Date() } = {}) {
  return REGISTRATION_DOC_TYPES.map((type) => getEffectiveDocument(db, type, { now })).filter(Boolean);
}

export function assertRequiredRegistrationReady(db, { now = new Date() } = {}) {
  const missing = REGISTRATION_DOC_TYPES.filter((type) => !getEffectiveDocument(db, type, { now }));
  if (missing.length) {
    throw httpError("目前無法取得有效的註冊條款，請稍後再試", 503);
  }
}

function nextVersion(db, type) {
  const row = db.prepare("SELECT MAX(version) AS n FROM content_documents WHERE document_type=?").get(type);
  return (Number(row?.n) || 0) + 1;
}

function validatePayload(input = {}) {
  const title = sanitizeDocumentText(input.title, CONTENT_TITLE_MAX);
  const format = normalizeFormat(input.format);
  const body = sanitizeDocumentBody(input.body, format);
  const check_label = sanitizeDocumentText(input.check_label, CONTENT_CHECK_MAX);
  if (!title) throw httpError("請填標題", 400);
  if (!body) throw httpError("請填本文", 400);
  if (containsUnsafeMarkup(body) || containsUnsafeMarkup(title) || containsUnsafeMarkup(check_label)) {
    throw httpError("內容含有不安全標記，已拒絕儲存", 400);
  }
  return { title, body, format, check_label };
}

export function createDraft(db, input = {}, { actorId = 0, now = new Date() } = {}) {
  const type = assertType(input.document_type);
  const fields = validatePayload(input);
  const version = Number(input.version) > 0 ? Number(input.version) : nextVersion(db, type);
  const existing = getDocumentByTypeVersion(db, type, version);
  if (existing) throw httpError("這個版本號已存在", 409);
  const hash = documentFingerprint({ document_type: type, version, ...fields });
  const res = db.prepare(
    `INSERT INTO content_documents(
      document_type, version, title, body, format, check_label, status, enabled,
      requires_reacceptance, effective_from, effective_until, content_hash, created_by, created_at, supersedes_id
    ) VALUES (?,?,?,?,?,?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    type,
    version,
    fields.title,
    fields.body,
    fields.format,
    fields.check_label,
    input.enabled === false ? 0 : 1,
    input.requires_reacceptance === true ? 1 : 0,
    input.effective_from || null,
    input.effective_until || null,
    hash,
    Number(actorId) || null,
    iso(now),
    Number(input.supersedes_id) || null,
  );
  const doc = getDocumentById(db, Number(res.lastInsertRowid));
  audit(db, { document_id: doc.id, document_type: type, version, action: "draft_create", actor_id: actorId, content_hash: hash, now });
  return doc;
}

export function updateDraft(db, id, input = {}, { actorId = 0, now = new Date() } = {}) {
  const doc = getDocumentById(db, id);
  if (!doc) throw httpError("找不到文件", 404);
  if (doc.status === "published") {
    const flagsOnly = updatePublishedFlags(db, doc, input, { actorId, now });
    if (input.title != null || input.body != null || input.format != null || input.check_label != null) {
      throw httpError("已發布版本不可改本文；請建立新版本", 409);
    }
    return flagsOnly;
  }
  const fields = validatePayload({
    title: input.title ?? doc.title,
    body: input.body ?? doc.body,
    format: input.format ?? doc.format,
    check_label: input.check_label ?? doc.check_label,
  });
  const hash = documentFingerprint({ document_type: doc.document_type, version: doc.version, ...fields });
  db.prepare(
    `UPDATE content_documents SET title=?, body=?, format=?, check_label=?, enabled=?, requires_reacceptance=?,
     effective_from=?, effective_until=?, content_hash=? WHERE id=? AND status='draft'`,
  ).run(
    fields.title,
    fields.body,
    fields.format,
    fields.check_label,
    input.enabled === false ? 0 : (input.enabled === true ? 1 : (doc.enabled ? 1 : 0)),
    input.requires_reacceptance === true ? 1 : (input.requires_reacceptance === false ? 0 : (doc.requires_reacceptance ? 1 : 0)),
    input.effective_from === undefined ? doc.effective_from : (input.effective_from || null),
    input.effective_until === undefined ? doc.effective_until : (input.effective_until || null),
    hash,
    doc.id,
  );
  audit(db, { document_id: doc.id, document_type: doc.document_type, version: doc.version, action: "draft_update", actor_id: actorId, content_hash: hash, now });
  return getDocumentById(db, doc.id);
}

function updatePublishedFlags(db, doc, input, { actorId, now }) {
  db.prepare(
    `UPDATE content_documents SET enabled=?, requires_reacceptance=?, effective_from=?, effective_until=?
     WHERE id=? AND status='published'`,
  ).run(
    input.enabled === false ? 0 : (input.enabled === true ? 1 : (doc.enabled ? 1 : 0)),
    input.requires_reacceptance === true ? 1 : (input.requires_reacceptance === false ? 0 : (doc.requires_reacceptance ? 1 : 0)),
    input.effective_from === undefined ? doc.effective_from : (input.effective_from || null),
    input.effective_until === undefined ? doc.effective_until : (input.effective_until || null),
    doc.id,
  );
  audit(db, { document_id: doc.id, document_type: doc.document_type, version: doc.version, action: "flags_update", actor_id: actorId, content_hash: doc.content_hash, now });
  return getDocumentById(db, doc.id);
}

export function publishDocument(db, id, { actorId = 0, now = new Date() } = {}) {
  const doc = getDocumentById(db, id);
  if (!doc) throw httpError("找不到文件", 404);
  if (doc.status === "published") return doc;
  const stamp = iso(now);
  db.prepare(
    `UPDATE content_documents SET status='published', published_at=?, enabled=1 WHERE id=?`,
  ).run(stamp, doc.id);
  const published = getDocumentById(db, doc.id);
  audit(db, { document_id: published.id, document_type: published.document_type, version: published.version, action: "publish", actor_id: actorId, content_hash: published.content_hash, now });
  return published;
}

export function createDraftFromPublished(db, id, { actorId = 0, now = new Date() } = {}) {
  const doc = getDocumentById(db, id);
  if (!doc) throw httpError("找不到文件", 404);
  if (doc.status !== "published") throw httpError("只能從已發布版本開新草稿", 400);
  return createDraft(db, {
    document_type: doc.document_type,
    title: doc.title,
    body: doc.body,
    format: doc.format,
    check_label: doc.check_label,
    enabled: true,
    requires_reacceptance: false,
    supersedes_id: doc.id,
  }, { actorId, now });
}

export function listDocumentEvents(db, { type, documentId, limit = 50 } = {}) {
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  if (documentId) {
    return db.prepare("SELECT * FROM content_document_events WHERE document_id=? ORDER BY id DESC LIMIT ?").all(Number(documentId), n);
  }
  if (type) {
    return db.prepare("SELECT * FROM content_document_events WHERE document_type=? ORDER BY id DESC LIMIT ?").all(type, n);
  }
  return db.prepare("SELECT * FROM content_document_events ORDER BY id DESC LIMIT ?").all(n);
}

const IMPORT_DECLARATION = `我確認匯入的物件文字與照片為本人所有，或已取得合法授權可在本站重製、公開展示。我了解這是一次性複製成草稿，不會與來源網站持續同步。不實或未授權內容可能被下架，法律責任由我自行負擔。`;

const WISH_ROOM_RULES = `許願房是之後才會開通的需求／媒合說明區。使用前須閱讀當時有效版本。本文件現在只建立內容類型，不代表功能已上線。`;

export function seedDefaultDocuments(db, { now = new Date(), legalCopy } = {}) {
  const copy = legalCopy || defaultLegalCopy();
  const seeds = [
    {
      document_type: "registration_terms",
      title: DOC_TYPES.registration_terms.seed_title,
      body: ensureIdleLegalClauses(copy.disclaimer),
      check_label: copy.disclaimerCheck,
    },
    {
      document_type: "privacy_notice",
      title: DOC_TYPES.privacy_notice.seed_title,
      body: copy.privacy,
      check_label: copy.privacyCheck,
    },
    {
      document_type: "listing_rules",
      title: DOC_TYPES.listing_rules.seed_title,
      body: `${SELF_LEGAL}\n\n${SELF_PLEDGE}`,
      check_label: "我確認自己是屋主或已獲授權的代理人，刊登內容屬實。",
    },
    {
      document_type: "external_import_declaration",
      title: DOC_TYPES.external_import_declaration.seed_title,
      body: IMPORT_DECLARATION,
      check_label: "我確認有權使用匯入的文字與照片。",
    },
    {
      document_type: "wish_room_rules",
      title: DOC_TYPES.wish_room_rules.seed_title,
      body: `${WISH_ROOM_RULES}\n\n${DEMAND_LEGAL}`,
      check_label: "我已閱讀許願房規則。",
    },
  ];
  for (const seed of seeds) {
    const count = Number(db.prepare("SELECT COUNT(*) n FROM content_documents WHERE document_type=?").get(seed.document_type)?.n) || 0;
    if (count) continue;
    const draft = createDraft(db, { ...seed, requires_reacceptance: false, enabled: true }, { actorId: 0, now });
    publishDocument(db, draft.id, { actorId: 0, now });
  }
}

export function legalCopyFromDocuments(db, { now = new Date() } = {}) {
  const terms = getEffectiveDocument(db, "registration_terms", { now });
  const privacy = getEffectiveDocument(db, "privacy_notice", { now });
  const defaults = defaultLegalCopy();
  return {
    version: terms ? `v${terms.version}` : defaults.version,
    disclaimer: terms?.body || defaults.disclaimer,
    disclaimerCheck: terms?.check_label || defaults.disclaimerCheck,
    privacy: privacy?.body || defaults.privacy,
    privacyCheck: privacy?.check_label || defaults.privacyCheck,
    text: terms?.body || defaults.disclaimer,
    privacy_text: privacy?.body || defaults.privacy,
  };
}
