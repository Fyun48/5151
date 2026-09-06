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
  const app = createApp({ db, auth });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ base, db });
  } finally {
    server.close();
    db.close();
  }
}

async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "s3cret-pass" }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  return { res, cookie };
}

test("health endpoint is public", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/ops/api/health`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.service, "ops");
    assert.equal(data.phase, 1);
  });
});

test("owner APIs require authentication", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/ops/api/audit`);
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.login, true);
  });
});

test("wrong credentials are rejected; correct credentials log in", async () => {
  await withServer(async ({ base }) => {
    const bad = await fetch(`${base}/ops/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "nope" }),
    });
    assert.equal(bad.status, 401);
    const { res } = await login(base);
    assert.equal(res.status, 200);
    assert.ok((res.headers.getSetCookie?.() || []).some((c) => c.startsWith("ops_session=")));
  });
});

test("authenticated owner can read audit and verify chain", async () => {
  await withServer(async ({ base }) => {
    const { cookie } = await login(base);
    const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
    assert.equal(me.ok, true);
    assert.equal(me.role, "owner");

    const audit = await (await fetch(`${base}/ops/api/audit`, { headers: { cookie } })).json();
    // login success was recorded
    assert.ok(audit.items.some((r) => r.action === "owner.login.ok"));

    const verify = await (await fetch(`${base}/ops/api/audit/verify`, { headers: { cookie } })).json();
    assert.equal(verify.ok, true);

    const cp = await (await fetch(`${base}/ops/api/audit/checkpoint`, { method: "POST", headers: { cookie } })).json();
    assert.equal(cp.ok, true);
    assert.ok(cp.checkpoint.id >= 1);
  });
});

test("state transitions are exposed read-only to owner", async () => {
  await withServer(async ({ base, db }) => {
    createEntity(db, { id: "srv-e1" });
    transition(db, { id: "srv-e1", to: "EVALUATING", actor: "system" });
    const { cookie } = await login(base);
    const data = await (await fetch(`${base}/ops/api/state/transitions`, { headers: { cookie } })).json();
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].to_state, "EVALUATING");
  });
});

test("unknown api path returns 404 json", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/ops/api/does-not-exist`);
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.error, "not found");
  });
});
