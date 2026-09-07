/** 會員同意紀錄：只追加、不覆蓋。舊會員不以新文件雜湊冒充歷史同意。 */
import {
  assertRequiredRegistrationReady,
  getDocumentById,
  getEffectiveDocument,
  getRequiredRegistrationDocuments,
  publicDocumentView,
  REGISTRATION_DOC_TYPES,
} from "./contentDocuments.js";

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function ensureMemberConsentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_consents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      document_type TEXT NOT NULL,
      document_id INTEGER,
      version INTEGER,
      content_hash TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      agreed_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_member_consents_user_type
      ON member_consents(user_id, document_type, agreed_at);
    CREATE INDEX IF NOT EXISTS idx_member_consents_doc
      ON member_consents(document_id, content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_member_consents_unique
      ON member_consents(user_id, document_id, content_hash);
  `);
}

export function listMemberConsents(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  return db.prepare(
    "SELECT * FROM member_consents WHERE user_id=? ORDER BY id DESC",
  ).all(uid).map(publicConsentRow);
}

export function publicConsentRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    document_type: row.document_type,
    document_id: row.document_id == null ? null : Number(row.document_id),
    version: row.version == null ? null : Number(row.version),
    content_hash: row.content_hash || "",
    source: row.source,
    agreed_at: row.agreed_at,
  };
}

export function recordConsent(db, userId, input = {}, { now = new Date() } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const type = String(input.document_type || "");
  const documentId = Number(input.document_id) || 0;
  const version = Number(input.version) || 0;
  const hash = String(input.content_hash || "").trim();
  const source = String(input.source || "registration").slice(0, 40);
  if (!type || !documentId || !version || !hash) throw httpError("同意紀錄不完整", 400);
  const existing = db.prepare(
    "SELECT id FROM member_consents WHERE user_id=? AND document_id=? AND content_hash=? LIMIT 1",
  ).get(uid, documentId, hash);
  if (existing) {
    return publicConsentRow(db.prepare("SELECT * FROM member_consents WHERE id=?").get(existing.id));
  }
  const res = db.prepare(
    `INSERT INTO member_consents(user_id, document_type, document_id, version, content_hash, source, agreed_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(uid, type, documentId, version, hash, source, iso(now));
  return publicConsentRow(db.prepare("SELECT * FROM member_consents WHERE id=?").get(Number(res.lastInsertRowid)));
}

function hasExactConsent(db, userId, doc) {
  if (!doc) return false;
  const row = db.prepare(
    "SELECT id FROM member_consents WHERE user_id=? AND document_id=? AND content_hash=? LIMIT 1",
  ).get(Number(userId), doc.id, doc.content_hash);
  return Boolean(row);
}

function hasLegacyRegistration(db, userId) {
  try {
    const user = db.prepare("SELECT accepted_disclaimer_at, disclaimer_version FROM users WHERE id=?").get(Number(userId));
    return Boolean(String(user?.accepted_disclaimer_at || "").trim());
  } catch {
    return false;
  }
}

/** 是否已接受「目前生效且必要」的該類型文件（比對 id＋雜湊，不是曾經同意過任一版）。 */
export function hasAcceptedRequiredDocument(db, userId, documentType, { now = new Date() } = {}) {
  const doc = getEffectiveDocument(db, documentType, { now });
  if (!doc) return false;
  if (hasExactConsent(db, userId, doc)) return true;
  if (doc.requires_reacceptance) return false;
  if (REGISTRATION_DOC_TYPES.includes(documentType) && hasLegacyRegistration(db, userId)) return true;
  return false;
}

export function pendingRequiredDocuments(db, userId, { now = new Date() } = {}) {
  return REGISTRATION_DOC_TYPES
    .map((type) => getEffectiveDocument(db, type, { now }))
    .filter((doc) => doc && !hasAcceptedRequiredDocument(db, userId, doc.document_type, { now }))
    .map(publicDocumentView);
}

export function assertRegistrationConsents(db, submitted, { now = new Date() } = {}) {
  assertRequiredRegistrationReady(db, { now });
  const required = getRequiredRegistrationDocuments(db, { now });
  const items = Array.isArray(submitted) ? submitted : [];
  const accepted = [];
  for (const doc of required) {
    const hit = items.find((row) => (
      Number(row?.document_id) === doc.id
      && Number(row?.version) === doc.version
      && String(row?.content_hash || "") === doc.content_hash
      && String(row?.document_type || "") === doc.document_type
    ));
    if (!hit) {
      const stale = items.find((row) => String(row?.document_type || "") === doc.document_type);
      if (stale) throw httpError("條款已更新，請重新閱讀目前有效版本後再同意", 409);
      throw httpError("請先閱讀並同意目前有效的註冊條款", 400);
    }
    accepted.push(doc);
  }
  return accepted;
}

export function recordRegistrationConsents(db, userId, docs, { source = "registration", now = new Date() } = {}) {
  return docs.map((doc) => recordConsent(db, userId, {
    document_type: doc.document_type,
    document_id: doc.id,
    version: doc.version,
    content_hash: doc.content_hash,
    source,
  }, { now }));
}

export function recordExactSubmittedConsents(db, userId, submitted, { source = "reaccept", now = new Date() } = {}) {
  const required = pendingRequiredDocuments(db, userId, { now });
  const acceptedDocs = [];
  for (const doc of required) {
    const hit = (Array.isArray(submitted) ? submitted : []).find((row) => (
      Number(row?.document_id) === doc.id
      && String(row?.content_hash || "") === doc.content_hash
    ));
    if (!hit) throw httpError("請先閱讀並同意更新後的條款", 400);
    acceptedDocs.push({
      document_type: doc.document_type,
      document_id: doc.id,
      version: doc.version,
      content_hash: doc.content_hash,
    });
  }
  return acceptedDocs.map((row) => recordConsent(db, userId, { ...row, source }, { now }));
}

export function historicalDocumentForConsent(db, userId, consentId) {
  const uid = Number(userId) || 0;
  const row = db.prepare("SELECT * FROM member_consents WHERE id=? AND user_id=?").get(Number(consentId) || 0, uid);
  if (!row || !row.document_id) return null;
  const doc = getDocumentById(db, row.document_id);
  if (!doc || doc.status !== "published") return null;
  return publicDocumentView(doc);
}
