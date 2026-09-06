import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { makeStubEmbeddingProvider } from "../src/ai/embeddingProvider.js";
import { runEmbeddingOnce } from "../src/clusteringWorker.js";
import { listIssues, feedbackIssue } from "../src/clustering.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
let seq = 1;
function seedAnalyzed(db, content, category = "BUG") {
  const i = seq++;
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, kind, content, received_at) VALUES (?, ?, 'v3', 'bug', ?, ?)").run(`d${i}`, `k${i}`, content, ts);
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
  db.prepare("INSERT INTO feedback_analysis(feedback_id, analysis_type, revision, retry_count, max_retries, prompt_version, category, summary, severity_hint, confidence, language, status, next_attempt_at, created_at, completed_at) VALUES (?, 'classification', 1, 0, 5, 'feedback-classification-v1', ?, ?, 'MEDIUM', 0.8, 'zh-TW', 'completed', ?, ?, ?)").run(fid, category, content, ts, ts, ts);
  const aid = Number(db.prepare("SELECT id FROM feedback_analysis WHERE feedback_id=? ORDER BY id DESC LIMIT 1").get(fid).id);
  db.prepare("INSERT INTO feedback_analysis_current(feedback_id, analysis_type, analysis_id, updated_at, reason) VALUES (?, 'classification', ?, ?, 'test')").run(fid, aid, ts);
  return fid;
}

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const server = createApp({ db, auth }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db }); } finally { server.close(); db.close(); }
}
async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.com", password: "pw" }) });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

test("issue views require owner auth", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/ops/api/issues`)).status, 401);
    assert.equal((await fetch(`${base}/ops/api/issues/1`)).status, 401);
  });
});

test("owner lists issues and inspects members", async () => {
  await withServer(async ({ base, db }) => {
    seedAnalyzed(db, "登入按下去一直轉圈圈沒反應無法進入系統首頁");
    seedAnalyzed(db, "登入按下去以後一直轉圈圈沒反應無法進入系統首頁");
    await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), now: () => new Date() });
    const { cookie } = await login(base);
    const list = await (await fetch(`${base}/ops/api/issues`, { headers: { cookie } })).json();
    assert.ok(list.items.length >= 1);
    const issueId = feedbackIssue(db, 1);
    const detail = await (await fetch(`${base}/ops/api/issues/${issueId}`, { headers: { cookie } })).json();
    assert.equal(detail.issue.id, issueId);
    assert.ok(detail.members.length >= 1);
    assert.ok(Array.isArray(detail.history));
  });
});

test("merge/split/move require CSRF and are audited", async () => {
  await withServer(async ({ base, db }) => {
    const f1 = seedAnalyzed(db, "登入按鈕完全沒有反應而且無法使用系統");
    const f2 = seedAnalyzed(db, "希望增加深色模式與多語言的介面設定選項", "FEATURE_REQUEST");
    await runEmbeddingOnce(db, { provider: makeStubEmbeddingProvider(), now: () => new Date() });
    const i1 = feedbackIssue(db, f1), i2 = feedbackIssue(db, f2);
    const { cookie, csrf } = await login(base);
    // 無 CSRF → 403
    const noCsrf = await fetch(`${base}/ops/api/issues/merge`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ source_issue_id: i1, target_issue_id: i2 }) });
    assert.equal(noCsrf.status, 403);
    // 有 CSRF + 同源 → 200
    const ok = await fetch(`${base}/ops/api/issues/merge`, { method: "POST", headers: { cookie, "X-CSRF-Token": csrf, Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ source_issue_id: i1, target_issue_id: i2, reason: "same" }) });
    assert.equal(ok.status, 200);
    assert.equal(feedbackIssue(db, f1), i2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='issue.merged'").get().n, 1);
  });
});
