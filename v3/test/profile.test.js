import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { registerUser } from "../src/members.js";
import { displayName, normalizeNickname, updateUserProfile } from "../src/profile.js";

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensurePersonalSchema(db);
  return db;
}

test("nickname is optional and becomes the display name", () => {
  assert.equal(normalizeNickname(""), "");
  assert.throws(() => normalizeNickname("a"), /2/);
  assert.throws(() => normalizeNickname("a@b.com"), /信箱/);
  const db = memoryDb();
  const user = registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  assert.equal(displayName(user), "a@b.com");
  const next = updateUserProfile(db, user.id, { nickname: "小林" });
  assert.equal(next.nickname, "小林");
  assert.equal(displayName(next), "小林");
});
