import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createFeedback, ensureFeedbackSchema } from "../src/feedback.js";
import { APPLY_PATH, applySiteCommand, ensureSiteCommandInbox, handleApplyRequest, remoteCsAcceptControl } from "../src/siteCommandApply.js";
import { signIngestRequest } from "../src/opsSignature.js";
import { isPublicKitPath, publicPath } from "../src/auth.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA busy_timeout = 5000");
  ensureFeedbackSchema(db);
  ensureSiteCommandInbox(db);
  return db;
}

test("accept control is off by default and apply path is public but narrow", () => {
  const db = open();
  try {
    const control = remoteCsAcceptControl(db, {});
    assert.equal(control.effective, false);
    assert.equal(publicPath({ path: "/api/ops/commands/apply" }), true);
    assert.equal(publicPath({ path: "/api/ops/commands/apply/../admin" }), false);
    assert.equal(isPublicKitPath("/api/ops/commands/apply"), false);
  } finally {
    db.close();
  }
});

test("signed apply writes local feedback and repeats as duplicate", () => {
  const db = open();
  try {
    const created = createFeedback(db, 2, { kind: "idea", body: "希望樓層格式一致" });
    const env = { V3_OPS_COMMAND_ACCEPT: "1", V3_OPS_COMMAND_SECRET: "cmd-secret" };
    const payload = {
      command_id: "c-1",
      idempotency_key: "fb:1",
      command_kind: "feedback.patch_handling",
      payload: { feedback_id: created.id, handling_state: "done", admin_note: "已回覆" },
    };
    const raw = JSON.stringify(payload);
    const signed = signIngestRequest({
      method: "POST",
      path: APPLY_PATH,
      deliveryId: "c-1",
      rawBody: raw,
      secret: "cmd-secret",
    });
    const first = handleApplyRequest(db, { headers: Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v])), rawBody: raw, env });
    assert.equal(first.httpStatus, 200);
    assert.equal(first.body.apply_state, "applied");
    const row = db.prepare("SELECT status, admin_note FROM feedback WHERE id=?").get(created.id);
    assert.equal(row.status, "done");
    const second = applySiteCommand(db, payload);
    assert.equal(second.duplicate, true);
    assert.equal(second.apply_state, "applied");
  } finally {
    db.close();
  }
});
