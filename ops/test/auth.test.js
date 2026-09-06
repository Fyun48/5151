import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAuth, normalizeEmail } from "../src/auth.js";

const CFG = { ownerEmail: "Owner@Example.com", ownerPassword: "s3cret-pass", sessionSecret: "ops-unit-secret" };

function tokenFrom(setCookie) {
  return setCookie.split(";")[0].split("=").slice(1).join("=");
}
function reqWith(setCookie, extra = {}) {
  return { headers: { cookie: `ops_session=${tokenFrom(setCookie)}`, ...(extra.headers || {}) }, socket: {} };
}

test("verify checks reused admin credentials; owner email normalized", () => {
  const auth = makeAuth(CFG);
  assert.equal(auth.configured, true);
  assert.equal(auth.ownerEmail, "owner@example.com");
  assert.equal(auth.verify("owner@example.com", "s3cret-pass"), true);
  assert.equal(auth.verify("owner@example.com", "wrong"), false);
  assert.equal(auth.verify("other@example.com", "s3cret-pass"), false);
});

test("cookie is scoped to /ops, HttpOnly, and round-trips", () => {
  const auth = makeAuth(CFG);
  const cookie = auth.sessionCookie({ headers: {}, socket: {} });
  assert.match(cookie, /^ops_session=/);
  assert.match(cookie, /Path=\/ops/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const session = auth.readSession(reqWith(cookie));
  assert.equal(session.email, "owner@example.com");
  assert.equal(session.role, "owner");
  assert.ok(session.nonce);
});

test("session signed with a different secret is rejected", () => {
  const auth = makeAuth(CFG);
  const cookie = auth.sessionCookie({ headers: {}, socket: {} });
  const other = makeAuth({ ...CFG, sessionSecret: "different-secret" });
  assert.equal(other.readSession(reqWith(cookie)), null);
});

test("idle and absolute expiration are enforced", () => {
  const auth = makeAuth(CFG);
  const t0 = 1_000_000_000_000;
  const cookie = auth.sessionCookie({ headers: {}, socket: {} }, t0);
  // 有效範圍內
  assert.ok(auth.readSession(reqWith(cookie), t0 + 60 * 60 * 1000)); // +1h
  // idle 超過 2h → 失效
  assert.equal(auth.readSession(reqWith(cookie), t0 + 3 * 60 * 60 * 1000), null);
  // 滑動可延長 idle，但不超過 absolute(12h)
  const session = auth.readSession(reqWith(cookie), t0 + 60 * 60 * 1000);
  const slid = auth.slideCookie({ headers: {}, socket: {} }, session, t0 + 11 * 60 * 60 * 1000);
  assert.ok(auth.readSession(reqWith(slid), t0 + 11.5 * 60 * 60 * 1000)); // idle ok, absolute ok
  assert.equal(auth.readSession(reqWith(slid), t0 + 12.5 * 60 * 60 * 1000), null); // 超過 absolute
});

test("CSRF token binds to session and is required for mutations", () => {
  const auth = makeAuth(CFG);
  const cookie = auth.sessionCookie({ headers: {}, socket: {} });
  const session = auth.readSession(reqWith(cookie));
  const csrf = auth.csrfTokenFor(session);
  assert.ok(csrf.length > 10);

  // 正確 token + 同源 → 通過
  const okReq = reqWith(cookie, { headers: { "x-csrf-token": csrf, host: "127.0.0.1:5551", origin: "http://127.0.0.1:5551" } });
  assert.equal(auth.verifyMutation(okReq).ok, true);

  // 缺 token → 403
  const noToken = reqWith(cookie, { headers: { host: "127.0.0.1:5551" } });
  assert.equal(auth.verifyMutation(noToken).status, 403);

  // 錯 token → 403
  const badToken = reqWith(cookie, { headers: { "x-csrf-token": "nope", host: "127.0.0.1:5551" } });
  assert.equal(auth.verifyMutation(badToken).status, 403);

  // 跨來源 Origin → 403
  const crossOrigin = reqWith(cookie, { headers: { "x-csrf-token": csrf, host: "127.0.0.1:5551", origin: "http://evil.example" } });
  assert.equal(auth.verifyMutation(crossOrigin).status, 403);
});

test("login lockout is scoped to IP + account (no global owner DoS)", () => {
  const auth = makeAuth(CFG);
  const attacker = { headers: { "x-forwarded-for": "9.9.9.9" }, socket: {} };
  const owner = { headers: { "x-forwarded-for": "1.1.1.1" }, socket: {} };
  const attackerKey = auth.attemptKey(attacker, "owner@example.com");
  const ownerKey = auth.attemptKey(owner, "owner@example.com");
  assert.notEqual(attackerKey, ownerKey);
  for (let i = 0; i < 8; i++) auth.recordFail(attackerKey);
  // 攻擊者自己的 (ip+帳號) 被鎖
  assert.throws(() => auth.assertNotLocked(attackerKey), (e) => e.status === 429);
  // Owner 從自己 IP 登入不受影響
  assert.doesNotThrow(() => auth.assertNotLocked(ownerKey));
});

test("requireOwner blocks anonymous and passes authenticated", () => {
  const auth = makeAuth(CFG);
  let code = null;
  auth.requireOwner({ headers: {}, socket: {} }, { status(c) { code = c; return this; }, json() {}, setHeader() {} }, () => { code = "next"; });
  assert.equal(code, 401);

  const cookie = auth.sessionCookie({ headers: {}, socket: {} });
  const req = reqWith(cookie);
  let ok = false;
  auth.requireOwner(req, { status() { return this; }, json() {}, setHeader() {} }, () => { ok = true; });
  assert.equal(ok, true);
  assert.equal(req.owner.role, "owner");
});

test("unconfigured owner cannot verify or read session", () => {
  const auth = makeAuth({ ownerEmail: "", ownerPassword: "", sessionSecret: "" });
  assert.equal(auth.configured, false);
  assert.equal(auth.verify("a@b.c", "x"), false);
  assert.equal(auth.readSession({ headers: {}, socket: {} }), null);
});

test("normalizeEmail lowercases and trims", () => {
  assert.equal(normalizeEmail("  A@B.Com "), "a@b.com");
});
