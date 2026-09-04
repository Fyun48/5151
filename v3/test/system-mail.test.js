import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { changeUserPassword, registerUser, verifyUserPassword } from "../src/members.js";
import { defaultMailTemplates } from "../src/siteMail.js";
import { sendAccountMail } from "../src/systemMail.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensurePersonalSchema(db);
  return db;
}

test("sendAccountMail uses admin SMTP and never passes a member smtp override", async () => {
  const sent = [];
  const result = await sendAccountMail({
    kind: "welcome",
    to: "new@example.com",
    templates: defaultMailTemplates(),
    configured: () => true,
    send: async (mail) => sent.push(mail),
  });
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "new@example.com");
  assert.equal(sent[0].smtp, undefined);
  assert.match(sent[0].subject, /確認信箱|歡迎/);
});

test("sendAccountMail forwards stored admin smtp without a configured callback", async () => {
  const smtp = {
    host: "smtp.admin.test",
    from: "bot@admin.test",
    user: "bot@admin.test",
    pass: "x",
  };
  const sent = [];
  const result = await sendAccountMail({
    kind: "welcome",
    to: "new@example.com",
    templates: defaultMailTemplates(),
    smtp,
    send: async (mail) => sent.push(mail),
  });
  assert.equal(result.sent, true);
  assert.equal(sent[0].smtp, smtp);
  assert.equal(sent[0].to, "new@example.com");
});

test("sendAccountMail skips when admin SMTP is not configured", async () => {
  const sent = [];
  const result = await sendAccountMail({
    kind: "sponsor_thanks",
    to: "a@b.com",
    templates: defaultMailTemplates(),
    configured: () => false,
    send: async (mail) => sent.push(mail),
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "not_configured");
  assert.equal(sent.length, 0);
});

test("change password rejects the current password and stores the new one", () => {
  const db = memoryDb();
  const user = registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  const err = (() => {
    try {
      changeUserPassword(db, user.id, "wrong-pass", "password2");
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(err.status, 400);
  assert.match(err.message, /目前密碼不對/);
  assert.equal(verifyUserPassword(db, "a@b.com", "password1")?.id, user.id);
  changeUserPassword(db, user.id, "password1", "password2");
  assert.equal(verifyUserPassword(db, "a@b.com", "password1"), null);
  assert.equal(verifyUserPassword(db, "a@b.com", "password2")?.id, user.id);
});

test("server register, change-password, and sponsor patch queue system mail", () => {
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(src, /queueSystemMail\("welcome"/);
  assert.match(src, /queueSystemMail\("password_changed"/);
  assert.match(src, /queueSystemMail\("sponsor_thanks"/);
  assert.match(src, /queueSystemMail\("account_deleted"/);
  assert.match(src, /app\.post\("\/api\/change-password"/);
  const queue = src.slice(src.indexOf("function queueSystemMail"), src.indexOf('app.post("/api/register"'));
  assert.match(queue, /smtp:\s*getStoredSmtp\(\)/);
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(watcher, /smtp: mailBundle\.smtp \|\| null/);
  assert.doesNotMatch(watcher, /mailBundle\.configured \|\| mailConfigured\(\)/);
  assert.match(watcher, /const mailReady = Boolean\(mailBundle\.configured\)/);
});
