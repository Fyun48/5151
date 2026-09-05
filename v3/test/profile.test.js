import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { registerUser } from "../src/members.js";
import { displayName, needsProfileOnboard, nicknameFromOauthName, normalizeNickname, updateUserProfile } from "../src/profile.js";

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

test("oauth display names fill blank nicknames only when they fit", () => {
  assert.equal(nicknameFromOauthName(""), "");
  assert.equal(nicknameFromOauthName("U"), "");
  assert.equal(nicknameFromOauthName("a@b.com"), "");
  assert.equal(nicknameFromOauthName("小林"), "小林");
  const long = "這是一段超過二十個字的社群顯示名稱ABCDEFG";
  assert.equal(nicknameFromOauthName(long), long.slice(0, 20));
});

test("verified members need profile until first save; register email cannot change", () => {
  const db = memoryDb();
  const pending = registerUser(db, {
    email: "new@b.com",
    password: "password1",
    acceptDisclaimer: true,
    emailVerified: false,
  });
  assert.equal(needsProfileOnboard(pending), false);
  const user = registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  assert.equal(needsProfileOnboard(user), true);
  assert.throws(() => updateUserProfile(db, user.id, { email: "other@b.com" }), /不能更改/);
  const saved = updateUserProfile(db, user.id, { nickname: "小林" });
  assert.equal(needsProfileOnboard(saved), false);
  assert.equal(saved.email, "a@b.com");
});

test("contact fields can save without a privacy tick", () => {
  const db = memoryDb();
  const user = registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  const saved = updateUserProfile(db, user.id, { contact_phone: "0912345678" });
  assert.equal(saved.contact_phone, "0912345678");
  const ticked = updateUserProfile(db, user.id, { contact_phone: "0987654321", accept_privacy: true });
  assert.equal(ticked.contact_phone, "0987654321");
});
