import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAPABILITIES, updateProductCapabilities } from "../src/products.js";
import {
  enqueueAndMaybeDeliver,
  enqueueSiteCommand,
  listSiteCommands,
  productAllowsRemoteCs,
  remoteCsDeliveryControl,
} from "../src/siteCommand.js";
import { APPLY_PATH, applySiteCommand, ensureSiteCommandInbox, handleApplyRequest, setRemoteCsStopped } from "../../v3/src/siteCommandApply.js";
import { createFeedback, ensureFeedbackSchema } from "../../v3/src/feedback.js";
import { createContact, ensureCrmSchema } from "../../v3/src/crm.js";

const AUTH = { ownerEmail: "owner@example.com", ownerPassword: "s3cret-pass", sessionSecret: "srv-secret" };

function v3Db() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA busy_timeout = 5000");
  ensureFeedbackSchema(db);
  ensureCrmSchema(db);
  ensureSiteCommandInbox(db);
  return db;
}

async function loginAndCsrf(base) {
  const res = await fetch(`${base}/ops/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: AUTH.ownerEmail, password: AUTH.ownerPassword }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

test("remote_cs defaults off and delivery is off unless explicitly enabled", () => {
  assert.equal(DEFAULT_CAPABILITIES.remote_cs, false);
  assert.equal(remoteCsDeliveryControl({}).effective, false);
  assert.equal(remoteCsDeliveryControl({ OPS_REMOTE_CS_DELIVERY: "1" }).effective, false);
  assert.equal(remoteCsDeliveryControl({
    OPS_REMOTE_CS_DELIVERY: "1",
    V3_OPS_COMMAND_APPLY_URL: "http://127.0.0.1:5153/api/ops/commands/apply",
  }).effective, true);
  const db = openOpsDb(":memory:");
  try {
    const product = db.prepare("SELECT * FROM ops_product WHERE id='v3'").get();
    assert.ok(product);
    assert.equal(productAllowsRemoteCs({ ...product, capabilities: DEFAULT_CAPABILITIES, subscription_status: "connected" }), false);
  } finally {
    db.close();
  }
});

test("enqueue is refused until remote_cs is granted; offline delivery never marks applied", async () => {
  const db = openOpsDb(":memory:");
  try {
    assert.throws(
      () => enqueueSiteCommand(db, {
        product_id: "v3",
        command_kind: "feedback.patch_handling",
        idempotency_key: "k1",
        payload: { feedback_id: 1, handling_state: "doing" },
      }),
      /遠端客服未授權/,
    );
    const granted = updateProductCapabilities(db, "v3", { remote_cs: true });
    assert.equal(granted.subscription.capabilities.remote_cs, true);
    assert.ok(granted.command_secret);
    const pending = await enqueueAndMaybeDeliver(db, {
      product_id: "v3",
      command_kind: "feedback.patch_handling",
      idempotency_key: "k1",
      payload: { feedback_id: 1, handling_state: "doing" },
    }, { env: {} });
    assert.equal(pending.job.job_state, "pending");
    assert.equal(pending.job.apply_state, "unknown");
    assert.equal(pending.delivered, false);
    assert.equal(pending.reason, "delivery_off");

    const failed = await enqueueAndMaybeDeliver(db, {
      product_id: "v3",
      command_kind: "feedback.patch_handling",
      idempotency_key: "k2",
      payload: { feedback_id: 1, handling_state: "doing" },
    }, {
      applyUrl: "http://127.0.0.1:9/api/ops/commands/apply",
      secret: granted.command_secret,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    assert.equal(failed.job.job_state, "failed");
    assert.equal(failed.job.apply_state, "unknown");
    assert.equal(failed.delivered, false);
  } finally {
    db.close();
  }
});

test("v3 applies command locally then OPS records applied; duplicate is idempotent", async () => {
  const site = v3Db();
  const created = createFeedback(site, 1, { kind: "bug", body: "樓層顯示不一致請統一" });
  const ops = openOpsDb(":memory:");
  try {
    const granted = updateProductCapabilities(ops, "v3", { remote_cs: true });
    const result = await enqueueAndMaybeDeliver(ops, {
      product_id: "v3",
      command_kind: "feedback.patch_handling",
      idempotency_key: "remote_cs:feedback:1:v1",
      payload: { feedback_id: created.id, handling_state: "doing", admin_note: "已電話說明" },
    }, {
      applyUrl: "http://site.test/api/ops/commands/apply",
      secret: granted.command_secret,
      fetchImpl: async (_url, opts) => {
        const applied = handleApplyRequest(site, {
          headers: Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v])),
          rawBody: opts.body,
          env: { V3_OPS_COMMAND_ACCEPT: "1", V3_OPS_COMMAND_SECRET: granted.command_secret },
        });
        return {
          ok: applied.httpStatus === 200,
          status: applied.httpStatus,
          json: async () => applied.body,
        };
      },
    });
    assert.equal(result.job.apply_state, "applied");
    assert.equal(result.delivered, true);
    const row = site.prepare("SELECT status, admin_note FROM feedback WHERE id=?").get(created.id);
    assert.equal(row.status, "doing");
    assert.equal(row.admin_note, "已電話說明");

    const again = enqueueSiteCommand(ops, {
      product_id: "v3",
      command_kind: "feedback.patch_handling",
      idempotency_key: "remote_cs:feedback:1:v1",
      payload: { feedback_id: created.id, handling_state: "done" },
    });
    assert.equal(again.duplicate, true);
    assert.equal(again.job.command_id, result.job.command_id);
    const listed = listSiteCommands(ops, { productId: "v3" });
    assert.equal(listed.filter((j) => j.idempotency_key === "remote_cs:feedback:1:v1").length, 1);
  } finally {
    site.close();
    ops.close();
  }
});

test("v3 rejects apply when accept is off or locally stopped", () => {
  const site = v3Db();
  try {
    const off = handleApplyRequest(site, {
      headers: {},
      rawBody: "{}",
      env: {},
    });
    assert.equal(off.httpStatus, 403);
    assert.equal(off.body.apply_state, "rejected");
    assert.equal(off.body.reason, "accept_off");
    setRemoteCsStopped(site, true);
    const stopped = handleApplyRequest(site, {
      headers: {},
      rawBody: "{}",
      env: { V3_OPS_COMMAND_ACCEPT: "1", V3_OPS_COMMAND_SECRET: "abc" },
    });
    assert.equal(stopped.httpStatus, 403);
    assert.equal(stopped.body.reason, "local_stopped");
  } finally {
    site.close();
  }
});

test("crm.add_note writes on the site and Owner HTTP enqueue needs a session", async () => {
  const site = v3Db();
  const created = createContact(site, { display_name: "林小姐" });
  const contactId = created.contact?.id || created.id;
  const note = applySiteCommand(site, {
    command_id: "cmd-note-1",
    idempotency_key: "note:1",
    command_kind: "crm.add_note",
    payload: { contact_id: contactId, body: "已約定週一面談" },
  });
  assert.equal(note.apply_state, "applied");
  assert.ok(note.result.notes >= 1);

  const db = openOpsDb(":memory:");
  const auth = makeAuth(AUTH);
  const server = createApp({ db, auth, siteCommandApplyUrl: "" }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const anon = await fetch(`${base}/ops/api/site-commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: "v3", command_kind: "feedback.patch_handling", idempotency_key: "x", payload: { feedback_id: 1 } }),
    });
    assert.equal(anon.status, 401);
    updateProductCapabilities(db, "v3", { remote_cs: true });
    const { cookie, csrf } = await loginAndCsrf(base);
    const created = await fetch(`${base}/ops/api/site-commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie, "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({
        product_id: "v3",
        command_kind: "feedback.patch_handling",
        idempotency_key: "http-1",
        payload: { feedback_id: 1, handling_state: "doing" },
      }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.job.apply_state, "unknown");
    assert.equal(body.delivered, false);
  } finally {
    server.close();
    db.close();
    site.close();
  }
});
