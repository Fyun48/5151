import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import {
  IDLE_PAUSE_MS,
  listIdleMemberIds,
  registerUser,
  touchLastLogin,
} from "../src/members.js";
import { confirmVerifyToken, issueVerifyToken } from "../src/emailVerify.js";

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensurePersonalSchema(db);
  return db;
}

test("members idle after 60 days without login", () => {
  const db = memoryDb();
  const user = registerUser(db, {
    email: "idle@b.com",
    password: "password1",
    acceptDisclaimer: true,
    emailVerified: true,
  });
  const now = Date.parse("2026-09-04T00:00:00.000Z");
  db.prepare("UPDATE users SET created_at = ?, last_login_at = ? WHERE id = ?").run(
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z",
    user.id,
  );
  const idle = listIdleMemberIds(db, { now, idleMs: IDLE_PAUSE_MS });
  assert.deepEqual(idle, [user.id]);
  touchLastLogin(db, user.id, { now });
  assert.deepEqual(listIdleMemberIds(db, { now, idleMs: IDLE_PAUSE_MS }), []);
});

test("used verify token stays findable as used, empty token is missing", () => {
  const db = memoryDb();
  const user = registerUser(db, {
    email: "v@b.com",
    password: "password1",
    acceptDisclaimer: true,
    emailVerified: false,
  });
  const { token } = issueVerifyToken(db, user.id);
  confirmVerifyToken(db, token);
  try {
    confirmVerifyToken(db, token);
    assert.fail("expected used");
  } catch (error) {
    assert.equal(error.code, "used");
  }
  try {
    confirmVerifyToken(db, "");
    assert.fail("expected missing");
  } catch (error) {
    assert.equal(error.code, "missing");
  }
  try {
    confirmVerifyToken(db, "no-such-token");
    assert.fail("expected missing");
  } catch (error) {
    assert.equal(error.code, "missing");
  }
});
