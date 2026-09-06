import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAuth, normalizeEmail } from "../src/auth.js";

const CFG = { ownerEmail: "Owner@Example.com", ownerPassword: "s3cret-pass", sessionSecret: "unit-secret" };

function reqWithCookie(setCookie) {
  const token = setCookie.split(";")[0].split("=").slice(1).join("=");
  return { headers: { cookie: `ops_session=${token}` }, socket: {} };
}

test("verify checks the reused admin credentials", () => {
  const auth = makeAuth(CFG);
  assert.equal(auth.configured, true);
  assert.equal(auth.ownerEmail, "owner@example.com");
  assert.equal(auth.verify("owner@example.com", "s3cret-pass"), true);
  assert.equal(auth.verify("owner@example.com", "wrong"), false);
  assert.equal(auth.verify("other@example.com", "s3cret-pass"), false);
});

test("session cookie round-trips and is bound to owner email", () => {
  const auth = makeAuth(CFG);
  const cookie = auth.sessionCookie({ headers: {}, socket: {} });
  assert.match(cookie, /^ops_session=/);
  assert.match(cookie, /HttpOnly/);
  const session = auth.readSession(reqWithCookie(cookie));
  assert.equal(session.email, "owner@example.com");
  assert.equal(session.role, "owner");
});

test("session signed with a different secret is rejected", () => {
  const auth = makeAuth(CFG);
  const cookie = auth.sessionCookie({ headers: {}, socket: {} });
  const other = makeAuth({ ...CFG, sessionSecret: "different-secret" });
  assert.equal(other.readSession(reqWithCookie(cookie)), null);
});

test("requireOwner blocks without session and passes with session", () => {
  const auth = makeAuth(CFG);
  let blocked = null;
  const res = { status(code) { blocked = code; return this; }, json() { return this; } };
  let nexted = false;
  auth.requireOwner({ headers: {}, socket: {} }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(blocked, 401);

  const cookie = auth.sessionCookie({ headers: {}, socket: {} });
  const req = reqWithCookie(cookie);
  let ok = false;
  auth.requireOwner(req, { status() { return this; }, json() { return this; } }, () => { ok = true; });
  assert.equal(ok, true);
  assert.equal(req.owner.role, "owner");
});

test("login lockout after repeated failures", () => {
  const auth = makeAuth(CFG);
  const key = "1.2.3.4|owner@example.com";
  for (let i = 0; i < 8; i++) auth.recordFail(key);
  assert.throws(() => auth.assertNotLocked(key), (err) => err.status === 429);
});

test("unconfigured owner cannot verify", () => {
  const auth = makeAuth({ ownerEmail: "", ownerPassword: "", sessionSecret: "" });
  assert.equal(auth.configured, false);
  assert.equal(auth.verify("a@b.c", "x"), false);
  assert.equal(auth.readSession({ headers: {}, socket: {} }), null);
});

test("normalizeEmail lowercases and trims", () => {
  assert.equal(normalizeEmail("  A@B.Com "), "a@b.com");
});
