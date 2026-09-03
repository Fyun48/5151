import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { generateTempPassword, validatePassword } from "../src/password.js";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { registerUser, verifyUserPassword } from "../src/members.js";
import { forgotPasswordMessage, requestTempPassword } from "../src/forgotPassword.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensurePersonalSchema(db);
  return db;
}

test("forgot password emails a temp password and replaces the old one", async () => {
  const db = memoryDb();
  registerUser(db, { email: "A@B.com", password: "password1", acceptDisclaimer: true });
  const sent = [];
  const result = await requestTempPassword(db, "a@b.com", {
    configured: () => true,
    send: async (mail) => {
      sent.push(mail);
    },
    makePassword: () => "temp-pass-99",
    attempts: new Map(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.message, forgotPasswordMessage());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "a@b.com");
  assert.match(sent[0].subject, /臨時密碼/);
  assert.match(sent[0].text, /temp-pass-99/);
  assert.equal(verifyUserPassword(db, "a@b.com", "password1"), null);
  assert.equal(verifyUserPassword(db, "a@b.com", "temp-pass-99")?.email, "a@b.com");
});

test("unknown email still looks successful and does not send mail", async () => {
  const sent = [];
  const result = await requestTempPassword(memoryDb(), "nobody@example.com", {
    configured: () => true,
    send: async (mail) => {
      sent.push(mail);
    },
    attempts: new Map(),
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /若此帳號存在/);
  assert.equal(sent.length, 0);
});

test("send failure restores the previous password", async () => {
  const db = memoryDb();
  registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  const err = await requestTempPassword(db, "a@b.com", {
    configured: () => true,
    send: async () => {
      const fail = new Error("寄信失敗，請稍後再試");
      fail.status = 502;
      throw fail;
    },
    makePassword: () => "temp-pass-99",
    attempts: new Map(),
  }).catch((error) => error);
  assert.equal(err.status, 502);
  assert.equal(verifyUserPassword(db, "a@b.com", "password1")?.email, "a@b.com");
  assert.equal(verifyUserPassword(db, "a@b.com", "temp-pass-99"), null);
});

test("unconfigured mail returns 503 and does not change the password", async () => {
  const db = memoryDb();
  registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  const err = await requestTempPassword(db, "a@b.com", {
    configured: () => false,
    send: async () => {
      throw new Error("should not send");
    },
    attempts: new Map(),
  }).catch((error) => error);
  assert.equal(err.status, 503);
  assert.match(err.message, /尚未設定寄信/);
  assert.equal(verifyUserPassword(db, "a@b.com", "password1")?.email, "a@b.com");
});

test("cooldown returns 429 for the same email", async () => {
  const db = memoryDb();
  const attempts = new Map();
  const now = 1_000_000;
  await requestTempPassword(db, "nobody@example.com", {
    configured: () => true,
    send: async () => {},
    attempts,
    now,
  });
  const err = await requestTempPassword(db, "nobody@example.com", {
    configured: () => true,
    send: async () => {},
    attempts,
    now: now + 1000,
    cooldownMs: 60_000,
  }).catch((error) => error);
  assert.equal(err.status, 429);
  assert.match(err.message, /秒後再試/);
});

test("invalid email is rejected", async () => {
  const err = await requestTempPassword(memoryDb(), "not-an-email", {
    configured: () => true,
    attempts: new Map(),
  }).catch((error) => error);
  assert.equal(err.status, 400);
});

test("generated temp passwords meet the minimum length", () => {
  const pw = generateTempPassword();
  assert.equal(pw.length, 12);
  assert.equal(validatePassword(pw), pw);
  assert.notEqual(generateTempPassword(), generateTempPassword());
});

test("forgot-password API is listed as a public path", () => {
  const src = readFileSync(path.join(dir, "../src/auth.js"), "utf8");
  assert.match(src, /\/api\/forgot-password/);
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /app\.post\("\/api\/forgot-password"/);
});
