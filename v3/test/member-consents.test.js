import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { registerUser } from "../src/members.js";
import {
  createDraft,
  createDraftFromPublished,
  ensureContentDocumentSchema,
  getEffectiveDocument,
  getRequiredRegistrationDocuments,
  publishDocument,
  seedDefaultDocuments,
  updateDraft,
} from "../src/contentDocuments.js";
import {
  assertRegistrationConsents,
  ensureMemberConsentSchema,
  hasAcceptedRequiredDocument,
  historicalDocumentForConsent,
  listMemberConsents,
  pendingRequiredDocuments,
  recordConsent,
  recordRegistrationConsents,
} from "../src/memberConsents.js";
import { defaultLegalCopy } from "../src/legalCopy.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensurePersonalSchema(db);
  ensureContentDocumentSchema(db);
  ensureMemberConsentSchema(db);
  seedDefaultDocuments(db, { legalCopy: defaultLegalCopy(), now: new Date("2026-09-07T00:00:00.000Z") });
  return db;
}

function snapshot(docs) {
  return docs.map((doc) => ({
    document_type: doc.document_type,
    document_id: doc.id,
    version: doc.version,
    content_hash: doc.content_hash,
  }));
}

test("registration cannot complete without matching current consents", () => {
  const db = open();
  const required = getRequiredRegistrationDocuments(db);
  assert.throws(() => assertRegistrationConsents(db, []), /請先閱讀並同意/);
  assert.throws(
    () => assertRegistrationConsents(db, required.map((doc) => ({ ...doc, content_hash: "stale" }))),
    /條款已更新/,
  );
  const accepted = assertRegistrationConsents(db, snapshot(required));
  assert.equal(accepted.length, 2);
  db.close();
});

test("accepted exact version hash and time are recorded and append-only", () => {
  const db = open();
  const user = registerUser(db, { email: "new@b.com", password: "password1", acceptDisclaimer: true });
  const required = getRequiredRegistrationDocuments(db);
  const now = new Date("2026-09-07T01:00:00.000Z");
  const rows = recordRegistrationConsents(db, user.id, required, { now });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].agreed_at, now.toISOString());
  assert.ok(rows[0].content_hash);
  assert.ok(rows[0].version);
  const again = recordRegistrationConsents(db, user.id, required, { now: new Date("2026-09-07T02:00:00.000Z") });
  assert.equal(again[0].id, rows[0].id);
  assert.equal(listMemberConsents(db, user.id).length, 2);

  const terms = getEffectiveDocument(db, "registration_terms");
  const draft = createDraftFromPublished(db, terms.id);
  updateDraft(db, draft.id, { body: `${terms.body}\n新版`, requires_reacceptance: true });
  publishDocument(db, draft.id);
  const v2 = getEffectiveDocument(db, "registration_terms");
  recordConsent(db, user.id, {
    document_type: v2.document_type,
    document_id: v2.id,
    version: v2.version,
    content_hash: v2.content_hash,
    source: "reaccept",
  }, { now: new Date("2026-09-07T03:00:00.000Z") });
  const history = listMemberConsents(db, user.id).filter((row) => row.document_type === "registration_terms");
  assert.equal(history.length, 2);
  assert.equal(history.some((row) => row.version === 1), true);
  assert.equal(history.some((row) => row.version === 2), true);
  db.close();
});

test("legacy members are not fabricated and are not locked unless reacceptance is required", () => {
  const db = open();
  const legacy = registerUser(db, { email: "old@b.com", password: "password1", acceptDisclaimer: true });
  assert.ok(legacy.accepted_disclaimer_at);
  assert.equal(listMemberConsents(db, legacy.id).length, 0);
  assert.equal(hasAcceptedRequiredDocument(db, legacy.id, "registration_terms"), true);
  assert.equal(hasAcceptedRequiredDocument(db, legacy.id, "privacy_notice"), true);
  assert.equal(pendingRequiredDocuments(db, legacy.id).length, 0);

  const terms = getEffectiveDocument(db, "registration_terms");
  updateDraft(db, terms.id, { requires_reacceptance: true });
  assert.equal(hasAcceptedRequiredDocument(db, legacy.id, "registration_terms"), false);
  assert.equal(pendingRequiredDocuments(db, legacy.id).some((doc) => doc.document_type === "registration_terms"), true);
  assert.equal(listMemberConsents(db, legacy.id).length, 0);
  db.close();
});

test("old acceptance is not treated as the required new version", () => {
  const db = open();
  const user = registerUser(db, { email: "v1@b.com", password: "password1", acceptDisclaimer: true });
  const required = getRequiredRegistrationDocuments(db);
  recordRegistrationConsents(db, user.id, required);
  const terms = getEffectiveDocument(db, "registration_terms");
  const draft = createDraftFromPublished(db, terms.id);
  updateDraft(db, draft.id, { body: `${terms.body}\n重大變更`, requires_reacceptance: true });
  publishDocument(db, draft.id);
  assert.equal(hasAcceptedRequiredDocument(db, user.id, "registration_terms"), false);
  const hist = historicalDocumentForConsent(db, user.id, listMemberConsents(db, user.id).find((row) => row.document_type === "registration_terms").id);
  assert.equal(hist.version, 1);
  assert.equal(hist.id, terms.id);
  db.close();
});

test("TOCTOU stale submitted version is rejected instead of silently accepting the new one", () => {
  const db = open();
  const stale = snapshot(getRequiredRegistrationDocuments(db));
  const terms = getEffectiveDocument(db, "registration_terms");
  const draft = createDraftFromPublished(db, terms.id);
  updateDraft(db, draft.id, { body: `${terms.body}\n更新後` });
  publishDocument(db, draft.id);
  assert.throws(() => assertRegistrationConsents(db, stale), /條款已更新/);
  db.close();
});
