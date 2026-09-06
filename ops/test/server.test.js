import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { createEntity, transition } from "../src/stateMachine.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "s3cret-pass", sessionSecret: "srv-secret" };

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const server = createApp({ db, auth }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, db });
  } finally {
    server.close();
    db.close();
  }
}

async function loginAndCsrf(base) {
  const res = await fetch(`${base}/ops/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "s3cret-pass" }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { res, cookie, csrf: me.csrfToken };
}

test("health is public and reports phase 1.1", async () => {
  await withServer(async ({ base }) => {
    const data = await (await fetch(`${base}/ops/api/health`)).json();
    assert.equal(data.ok, true);
    assert.equal(data.service, "ops");
    assert.equal(data.phase, "1.1");
  });
});

test("owner APIs require authentication", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/ops/api/audit`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).login, true);
  });
});

test("login rejects wrong creds and accepts correct ones", async () => {
  await withServer(async ({ base }) => {
    const bad = await fetch(`${base}/ops/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "nope" }),
    });
    assert.equal(bad.status, 401);
    const { res, csrf } = await loginAndCsrf(base);
    assert.equal(res.status, 200);
    assert.ok(csrf && csrf.length > 10);
  });
});

test("authenticated owner reads paginated audit and verifies chain", async () => {
  await withServer(async ({ base }) => {
    const { cookie } = await loginAndCsrf(base);
    const audit = await (await fetch(`${base}/ops/api/audit?limit=10`, { headers: { cookie } })).json();
    assert.ok(Array.isArray(audit.items));
    assert.ok(typeof audit.total === "number");
    assert.ok(audit.items.some((r) => r.action === "owner.login.ok"));
    const verify = await (await fetch(`${base}/ops/api/audit/verify`, { headers: { cookie } })).json();
    assert.equal(verify.ok, true);
  });
});

test("mutation requires CSRF token", async () => {
  await withServer(async ({ base }) => {
    const { cookie } = await loginAndCsrf(base);
    // 無 CSRF → 403
    const noCsrf = await fetch(`${base}/ops/api/audit/checkpoint`, { method: "POST", headers: { cookie } });
    assert.equal(noCsrf.status, 403);
  });
});

test("mutation rejects cross-origin even with valid CSRF", async () => {
  await withServer(async ({ base }) => {
    const { cookie, csrf } = await loginAndCsrf(base);
    const res = await fetch(`${base}/ops/api/audit/checkpoint`, {
      method: "POST",
      headers: { cookie, "X-CSRF-Token": csrf, Origin: "http://evil.example" },
    });
    assert.equal(res.status, 403);
  });
});

test("mutation succeeds with valid CSRF and same origin", async () => {
  await withServer(async ({ base }) => {
    const { cookie, csrf } = await loginAndCsrf(base);
    const res = await fetch(`${base}/ops/api/audit/checkpoint`, {
      method: "POST",
      headers: { cookie, "X-CSRF-Token": csrf, Origin: base },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.checkpoint.id >= 1);
  });
});

test("state transitions are exposed read-only to owner", async () => {
  await withServer(async ({ base, db }) => {
    createEntity(db, { id: "srv-e1", entityType: "issue" });
    transition(db, { id: "srv-e1", to: "EVALUATING" });
    const { cookie } = await loginAndCsrf(base);
    const data = await (await fetch(`${base}/ops/api/state/transitions`, { headers: { cookie } })).json();
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].to_state, "EVALUATING");
  });
});

test("static console loads and unknown api is 404", async () => {
  await withServer(async ({ base }) => {
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") || "", /text\/html/);
    const nf = await fetch(`${base}/ops/api/nope`);
    assert.equal(nf.status, 404);
  });
});

test("security headers are present", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/ops/api/health`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});
