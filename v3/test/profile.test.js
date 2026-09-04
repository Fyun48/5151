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

test("contact fields need a privacy tick the first time", () => {
  const db = memoryDb();
  const user = registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  assert.throws(
    () => updateUserProfile(db, user.id, { contact_phone: "0912345678" }),
    /個資說明/,
  );
  const saved = updateUserProfile(db, user.id, { contact_phone: "0912345678", accept_privacy: true });
  assert.equal(saved.contact_phone, "0912345678");
  const again = updateUserProfile(db, user.id, { contact_phone: "0987654321" });
  assert.equal(again.contact_phone, "0987654321");
});
