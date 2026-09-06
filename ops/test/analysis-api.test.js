import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { enqueueAnalysisRow } from "../src/feedbackAnalysis.js";
import { runAnalysisOnce } from "../src/analysisWorker.js";
import { makeStubProvider } from "../src/ai/provider.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const server = createApp({ db, auth }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  db.prepare(`INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, received_at) VALUES('d1','k1','v3','bug','登入轉圈圈',?)`).run(new Date().toISOString());
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback LIMIT 1").get().id);
  try {
    await run({ base, db, fid });
  } finally {
    server.close();
    db.close();
  }
}

async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.com", password: "pw" }) });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

test("analysis view requires owner auth", async () => {
  await withServer(async ({ base, fid }) => {
    assert.equal((await fetch(`${base}/ops/api/feedback/${fid}/analysis`)).status, 401);
    assert.equal((await fetch(`${base}/ops/api/analysis/stats`)).status, 401);
  });
});

test("owner sees feedback + completed analysis", async () => {
  await withServer(async ({ base, db, fid }) => {
    enqueueAnalysisRow(db, { feedbackId: fid });
    await runAnalysisOnce(db, { provider: makeStubProvider(), now: () => new Date(), random: () => 0.5 });
    const { cookie } = await login(base);
    const data = await (await fetch(`${base}/ops/api/feedback/${fid}/analysis`, { headers: { cookie } })).json();
    assert.equal(data.feedback.id, fid);
    assert.equal(data.analyses.length, 1);
    assert.equal(data.analyses[0].status, "completed");
    assert.ok(data.analyses[0].category);
    assert.equal(data.analyses[0].provider, "stub");
  });
});

test("owner re-analyze requires CSRF and creates a new attempt", async () => {
  await withServer(async ({ base, db, fid }) => {
    enqueueAnalysisRow(db, { feedbackId: fid });
    await runAnalysisOnce(db, { provider: makeStubProvider(), now: () => new Date(), random: () => 0.5 });
    const { cookie, csrf } = await login(base);
    // 無 CSRF → 403
    const noCsrf = await fetch(`${base}/ops/api/feedback/${fid}/reanalyze`, { method: "POST", headers: { cookie } });
    assert.equal(noCsrf.status, 403);
    // 有 CSRF + 同源 → 201，新 attempt
    const ok = await fetch(`${base}/ops/api/feedback/${fid}/reanalyze`, { method: "POST", headers: { cookie, "X-CSRF-Token": csrf, Origin: base, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.revision, 2);
    const list = await (await fetch(`${base}/ops/api/feedback/${fid}/analysis`, { headers: { cookie } })).json();
    assert.equal(list.analyses.length, 2);
  });
});

test("stats endpoint returns counts for owner", async () => {
  await withServer(async ({ base, db, fid }) => {
    enqueueAnalysisRow(db, { feedbackId: fid });
    const { cookie } = await login(base);
    const stats = await (await fetch(`${base}/ops/api/analysis/stats`, { headers: { cookie } })).json();
    assert.equal(typeof stats.total, "number");
    assert.ok(stats.pending >= 1);
  });
});
