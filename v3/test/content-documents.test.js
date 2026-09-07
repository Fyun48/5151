import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createDraft,
  createDraftFromPublished,
  documentFingerprint,
  ensureContentDocumentSchema,
  getEffectiveDocument,
  getRequiredRegistrationDocuments,
  publicDocumentView,
  publishDocument,
  seedDefaultDocuments,
  updateDraft,
} from "../src/contentDocuments.js";
import { defaultLegalCopy } from "../src/legalCopy.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureContentDocumentSchema(db);
  seedDefaultDocuments(db, { legalCopy: defaultLegalCopy(), now: new Date("2026-09-07T00:00:00.000Z") });
  return db;
}

test("seeded registration documents resolve canonically and deterministically", () => {
  const db = open();
  const terms = getEffectiveDocument(db, "registration_terms");
  const privacy = getEffectiveDocument(db, "privacy_notice");
  assert.equal(terms.status, "published");
  assert.equal(terms.version, 1);
  assert.equal(privacy.version, 1);
  assert.equal(terms.content_hash, documentFingerprint(terms));
  const required = getRequiredRegistrationDocuments(db);
  assert.equal(required.length, 2);
  assert.deepEqual(
    required.map((row) => row.document_type).sort(),
    ["privacy_notice", "registration_terms"],
  );
  assert.equal(getEffectiveDocument(db, "registration_terms")?.id, terms.id);
  assert.equal(getEffectiveDocument(db, "external_import_declaration")?.document_type, "external_import_declaration");
  assert.equal(getEffectiveDocument(db, "wish_room_rules")?.document_type, "wish_room_rules");
  db.close();
});

test("public document view hides admin actor fields and drafts stay unpublished", () => {
  const db = open();
  const pub = publicDocumentView(getEffectiveDocument(db, "registration_terms"));
  assert.equal("created_by" in pub, false);
  assert.equal("status" in pub, false);
  const draft = createDraft(db, {
    document_type: "listing_rules",
    title: "未公開草稿",
    body: "不應出現在公開頁",
    check_label: "草稿勾選",
  });
  assert.equal(draft.status, "draft");
  assert.notEqual(getEffectiveDocument(db, "listing_rules")?.id, draft.id);
  db.close();
});

test("content hash changes when acceptance-relevant fields change", () => {
  const db = open();
  const terms = getEffectiveDocument(db, "registration_terms");
  const next = documentFingerprint({ ...terms, body: `${terms.body}\n新增一句` });
  assert.notEqual(next, terms.content_hash);
  assert.equal(documentFingerprint(terms), terms.content_hash);
  db.close();
});

test("published versions are immutable and edit creates a new draft version", () => {
  const db = open();
  const terms = getEffectiveDocument(db, "registration_terms");
  const originalBody = terms.body;
  const originalHash = terms.content_hash;
  assert.throws(
    () => updateDraft(db, terms.id, { body: "偷偷改已發布本文" }),
    /已發布版本不可改本文/,
  );
  assert.throws(
    () => db.prepare("UPDATE content_documents SET body=? WHERE id=?").run("trigger", terms.id),
    /published_document_immutable/,
  );
  const still = getEffectiveDocument(db, "registration_terms");
  assert.equal(still.body, originalBody);
  assert.equal(still.content_hash, originalHash);
  const draft = createDraftFromPublished(db, terms.id);
  assert.equal(draft.status, "draft");
  assert.equal(draft.version, 2);
  assert.equal(draft.supersedes_id, terms.id);
  const edited = updateDraft(db, draft.id, { body: `${originalBody}\n第二版 ✨` });
  assert.notEqual(edited.content_hash, originalHash);
  publishDocument(db, edited.id);
  assert.equal(getEffectiveDocument(db, "registration_terms").version, 2);
  assert.equal(getEffectiveDocument(db, "registration_terms", { now: new Date("2026-09-07T00:00:00.000Z") }).id, edited.id);
  db.close();
});

test("conflicting published versions resolve to the highest in-effect version", () => {
  const db = open();
  const v1 = getEffectiveDocument(db, "privacy_notice");
  const future = createDraft(db, {
    document_type: "privacy_notice",
    title: "未來版",
    body: "還沒生效",
    check_label: "同意未來版",
    effective_from: "2099-01-01T00:00:00.000Z",
  });
  publishDocument(db, future.id);
  assert.equal(getEffectiveDocument(db, "privacy_notice").id, v1.id);
  const v3 = createDraft(db, {
    document_type: "privacy_notice",
    title: "現在較高版本",
    body: "目前應採用這版",
    check_label: "同意 v3",
  });
  publishDocument(db, v3.id);
  const effective = getEffectiveDocument(db, "privacy_notice");
  assert.equal(effective.id, v3.id);
  assert.equal(effective.version, 3);
  db.close();
});

test("requires_reacceptance flag can change on published docs without mutating body", () => {
  const db = open();
  const terms = getEffectiveDocument(db, "registration_terms");
  const updated = updateDraft(db, terms.id, { requires_reacceptance: true });
  assert.equal(updated.requires_reacceptance, true);
  assert.equal(updated.body, terms.body);
  assert.equal(updated.content_hash, terms.content_hash);
  db.close();
});

test("unsafe title is rejected and unicode emoji is kept", () => {
  const db = open();
  assert.throws(
    () => createDraft(db, {
      document_type: "listing_rules",
      title: "<script>alert(1)</script>",
      body: "正常本文",
      check_label: "同意",
    }),
    /不安全標記/,
  );
  const ok = createDraft(db, {
    document_type: "listing_rules",
    title: "刊登規則 ✨",
    body: "屋主確認與授權說明",
    check_label: "我同意 ✅",
  });
  assert.match(ok.title, /✨/);
  assert.match(ok.check_label, /✅/);
  db.close();
});
