import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, verifyPassword, validateEmail } from "../src/password.js";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { DISCLAIMER_TEXT, DISCLAIMER_VERSION, registerUser, verifyUserPassword } from "../src/members.js";

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensurePersonalSchema(db);
  return db;
}

test("password hash verifies and rejects a wrong password", () => {
  const stored = hashPassword("correct-horse");
  assert.equal(verifyPassword("correct-horse", stored), true);
  assert.equal(verifyPassword("wrong-password", stored), false);
  assert.equal(validateEmail("A@Example.COM"), "a@example.com");
});

test("register requires the disclaimer and stores a hashed password", () => {
  const db = memoryDb();
  assert.throws(() => registerUser(db, { email: "a@b.com", password: "password1" }), /免責聲明/);
  const user = registerUser(db, {
    email: "A@B.com",
    password: "password1",
    acceptDisclaimer: true,
  });
  assert.equal(user.email, "a@b.com");
  assert.equal(user.role, "member");
  assert.equal(user.disclaimer_version, DISCLAIMER_VERSION);
  assert.equal(verifyUserPassword(db, "a@b.com", "password1")?.id, user.id);
  assert.equal(verifyUserPassword(db, "a@b.com", "nope"), null);
  assert.throws(
    () => registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true }),
    /已經註冊/,
  );
});

test("disclaimer text says the system is free and sponsorship is voluntary", () => {
  assert.match(DISCLAIMER_TEXT, /免費/);
  assert.match(DISCLAIMER_TEXT, /贊助是自願/);
  assert.match(DISCLAIMER_TEXT, /不是仲介/);
});
