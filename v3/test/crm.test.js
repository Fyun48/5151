import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureCrmSchema,
  createContact,
  createCase,
  addNote,
  addTodo,
  setCrmEnabled,
  isCrmEnabled,
  listContacts,
  getContact,
  CRM_LEGAL,
} from "../src/crm.js";
import { ensureCrmOutboxSchema, crmOutboxStats } from "../src/crmOutbox.js";
import { ensureFeedbackSchema } from "../src/feedback.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  ensureFeedbackSchema(db);
  ensureCrmSchema(db);
  ensureCrmOutboxSchema(db);
  return db;
}

test("site CRM works without OPS and close keeps data", () => {
  const db = open();
  const created = createContact(db, { display_name: "林小姐", company_name: "吉比", tags: "vip,北市" });
  assert.equal(created.contact.display_name, "林小姐");
  assert.deepEqual(created.contact.tags, ["vip", "北市"]);
  createCase(db, created.contact.id, { title: "漏水", handling_state: "doing", feedback_id: 9 });
  addNote(db, created.contact.id, { body: "已回電" });
  addTodo(db, created.contact.id, { title: "回訪" });
  assert.equal(listContacts(db).length, 1);
  assert.equal(crmOutboxStats(db).pending, 0);

  setCrmEnabled(db, false);
  assert.equal(isCrmEnabled(db), false);
  assert.throws(() => createContact(db, { display_name: "新的" }), /已關閉/);
  assert.equal(listContacts(db).length, 1);
  assert.equal(getContact(db, created.contact.id).notes.length, 1);

  setCrmEnabled(db, true);
  createContact(db, { display_name: "王先生" });
  assert.equal(listContacts(db).length, 2);
  assert.match(CRM_LEGAL, /會員名單/);
  db.close();
});

test("admin.html has CRM panel and close-is-not-drop copy", () => {
  const html = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/admin.html"),
    "utf8",
  );
  assert.match(html, /data-admin-nav="crm"/);
  assert.match(html, /data-admin-panel="crm"/);
  assert.match(html, /id="crmContactForm"/);
  assert.match(html, /id="crmErrorSummary"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /關閉模組只停新處理，資料保留/);
  assert.match(html, /"crm"/);
  assert.match(html, /function crmHandlingLabel/);
  assert.match(html, /CRM 已關閉，只能看既有資料/);
  const formStart = html.indexOf('id="crmContactForm"');
  const formEnd = html.indexOf("</form>", formStart);
  const formHtml = html.slice(formStart, formEnd);
  assert.doesNotMatch(formHtml, /id="crmQuery"/);
  assert.match(html, /id="crmQuery"/);
  assert.match(html, /id="crmSearchBtn"/);
  assert.match(html, /novalidate/);
  assert.match(html, /沒有符合/);
  assert.match(html, /min-width: 560px/);
});

test("CRM outbox only fills when delivery is effective", () => {
  const db = open();
  const prev = {
    d: process.env.OPS_CRM_DELIVERY,
    u: process.env.OPS_INGEST_URL,
    s: process.env.OPS_INGEST_SECRET,
  };
  process.env.OPS_CRM_DELIVERY = "1";
  process.env.OPS_INGEST_URL = "http://127.0.0.1:9";
  process.env.OPS_INGEST_SECRET = "secret";
  try {
    createContact(db, { display_name: "同步" });
    assert.equal(crmOutboxStats(db).pending, 1);
  } finally {
    process.env.OPS_CRM_DELIVERY = prev.d;
    process.env.OPS_INGEST_URL = prev.u;
    process.env.OPS_INGEST_SECRET = prev.s;
    db.close();
  }
});
