import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, verifyPassword, validateEmail } from "../src/password.js";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { DISCLAIMER_TEXT, DISCLAIMER_VERSION, deleteUser, listUserIds, listUsers, registerUser, restoreUser, verifyUserPassword } from "../src/members.js";

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

test("deleted accounts stay in the table and allow only one reregister", () => {
  const db = memoryDb();
  const user = registerUser(db, { email: "keep@b.com", password: "password1", acceptDisclaimer: true });
  deleteUser(db, user.id, { by: "self", reason: "先不用了" });
  assert.equal(verifyUserPassword(db, "keep@b.com", "password1"), null);
  assert.equal(listUserIds(db).includes(user.id), false);
  assert.equal(listUsers(db).some((row) => row.email === "keep@b.com" && row.deleted_at), true);
  const again = registerUser(db, { email: "keep@b.com", password: "password9", acceptDisclaimer: true });
  assert.equal(again.id, user.id);
  assert.equal(Number(again.signup_count), 2);
  assert.equal(verifyUserPassword(db, "keep@b.com", "password9")?.id, user.id);
  deleteUser(db, again.id, { by: "admin", reasonCode: "abuse", reason: "異常行為多次" });
  assert.throws(
    () => registerUser(db, { email: "keep@b.com", password: "password8", acceptDisclaimer: true }),
    /不能再註冊/,
  );
  const restored = restoreUser(db, again.id);
  assert.equal(Boolean(restored.deleted_at), false);
  assert.equal(verifyUserPassword(db, "keep@b.com", "password9")?.id, user.id);
});

test("admin can sort members by created_at", () => {
  const db = memoryDb();
  registerUser(db, { email: "old@b.com", password: "password1", acceptDisclaimer: true });
  registerUser(db, { email: "new@b.com", password: "password1", acceptDisclaimer: true });
  const newest = listUsers(db, { sort: "created_at", order: "desc" });
  assert.equal(newest[0].email, "new@b.com");
  const found = listUsers(db, { q: "old@" });
  assert.equal(found.length, 1);
  assert.equal(found[0].email, "old@b.com");
});

test("disclaimer text says the system is free and sponsorship is voluntary", () => {
  assert.match(DISCLAIMER_TEXT, /免費/);
  assert.match(DISCLAIMER_TEXT, /贊助吉比是為了幫助此站持續成長茁壯/);
  assert.match(DISCLAIMER_TEXT, /不是仲介/);
});
