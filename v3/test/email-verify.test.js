import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { registerUser, verifyUserPassword } from "../src/members.js";
import {
  confirmVerifyToken,
  expireStaleVerifyTokens,
  isEmailVerified,
  issueVerifyToken,
  VERIFY_TTL_MS,
} from "../src/emailVerify.js";

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensurePersonalSchema(db);
  return db;
}

test("confirm token logs the member in once then dies", () => {
  const db = memoryDb();
  const user = registerUser(db, {
    email: "new@b.com",
    password: "password1",
    acceptDisclaimer: true,
    emailVerified: false,
  });
  assert.equal(isEmailVerified(user), false);
  const { token } = issueVerifyToken(db, user.id);
  const ok = confirmVerifyToken(db, token);
  assert.equal(ok.email, "new@b.com");
  assert.equal(isEmailVerified(ok), true);
  assert.throws(() => confirmVerifyToken(db, token), /已經使用過/);
});

test("unused token expires after three days and can notify once", () => {
  const db = memoryDb();
  const user = registerUser(db, {
    email: "late@b.com",
    password: "password1",
    acceptDisclaimer: true,
    emailVerified: false,
  });
  const now = Date.now();
  issueVerifyToken(db, user.id, { now });
  const expired = [];
  const n = expireStaleVerifyTokens(db, {
    now: now + VERIFY_TTL_MS + 1000,
    onExpire: (row) => expired.push(row.email),
  });
  assert.equal(n, 1);
  assert.deepEqual(expired, ["late@b.com"]);
  assert.equal(verifyUserPassword(db, "late@b.com", "password1")?.email, "late@b.com");
  assert.equal(isEmailVerified(verifyUserPassword(db, "late@b.com", "password1")), false);
  const again = expireStaleVerifyTokens(db, { now: now + VERIFY_TTL_MS + 2000, onExpire: () => {} });
  assert.equal(again, 0);
});
