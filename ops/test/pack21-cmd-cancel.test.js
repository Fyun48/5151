import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct, updateProductCapabilities } from "../src/products.js";
import { cancelSiteCommand, deliverSiteCommand, enqueueSiteCommand } from "../src/siteCommand.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function grantRemoteCs(db, productId) {
  return updateProductCapabilities(db, productId, { remote_cs: true });
}

test("cancel pending remote-cs and drop it from the pending list", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  grantRemoteCs(db, "shop");
  const { job } = enqueueSiteCommand(db, {
    product_id: "shop",
    command_kind: "feedback.patch_handling",
    idempotency_key: "k-cancel",
    payload: { feedback_id: 1, handling_state: "doing" },
  });
  const before = listPendingWork(db, "shop").items.find((it) => it.kind === "site_command");
  assert.ok(before);
  assert.equal(before.id, job.id);
  assert.match(before.note, /可取消/);
  const out = cancelSiteCommand(db, job.id, { actor: "owner", reason: "stop_send" });
  assert.equal(out.cancelled, true);
  assert.equal(out.in_flight_not_withdrawn, false);
  assert.equal(out.job.job_state, "cancelled");
  assert.equal(out.job.last_error, "owner_cancelled:stop_send");
  assert.equal(out.job.apply_state, "unknown");
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "site_command").length, 0);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "site_command").length, 0);
  const again = cancelSiteCommand(db, job.id, { actor: "owner" });
  assert.equal(again.idempotent, true);
  db.close();
});

test("cancel sending does not claim the in-flight call was withdrawn", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  grantRemoteCs(db, "shop");
  const { job } = enqueueSiteCommand(db, {
    product_id: "shop",
    command_kind: "crm.add_note",
    idempotency_key: "k-mid",
    payload: { contact_id: 1, body: "note" },
  });
  db.prepare("UPDATE site_command_job SET job_state='sending' WHERE id=?").run(job.id);
  const out = cancelSiteCommand(db, job.id, { actor: "owner", reason: "mid_send" });
  assert.equal(out.cancelled, true);
  assert.equal(out.in_flight_not_withdrawn, true);
  let called = 0;
  const delivered = await deliverSiteCommand(db, job.command_id, {
    applyUrl: "http://127.0.0.1:9/api/ops/commands/apply",
    secret: "x",
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => ({ apply_state: "applied" }) };
    },
  });
  assert.equal(called, 0);
  assert.equal(delivered.job_state, "cancelled");
  assert.notEqual(delivered.apply_state, "applied");
  db.close();
});

test("late deliver after cancel does not write sent", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  grantRemoteCs(db, "shop");
  const { job } = enqueueSiteCommand(db, {
    product_id: "shop",
    command_kind: "feedback.patch_handling",
    idempotency_key: "k-late",
    payload: { feedback_id: 2, handling_state: "doing" },
  });
  cancelSiteCommand(db, job.id, { actor: "owner" });
  let called = 0;
  const delivered = await deliverSiteCommand(db, job.command_id, {
    applyUrl: "http://127.0.0.1:9/api/ops/commands/apply",
    secret: "x",
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => ({ apply_state: "applied" }) };
    },
  });
  assert.equal(called, 0);
  assert.equal(delivered.job_state, "cancelled");
  assert.notEqual(delivered.apply_state, "applied");
  db.close();
});

test("sent command cannot be rewritten by cancel", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  grantRemoteCs(db, "shop");
  const { job } = enqueueSiteCommand(db, {
    product_id: "shop",
    command_kind: "feedback.patch_handling",
    idempotency_key: "k-sent",
    payload: { feedback_id: 3, handling_state: "done" },
  });
  db.prepare("UPDATE site_command_job SET job_state='sent', apply_state='applied' WHERE id=?").run(job.id);
  assert.throws(() => cancelSiteCommand(db, job.id, { actor: "owner" }), (err) => err.status === 409 && /不宣稱撤回/.test(err.message));
  assert.equal(db.prepare("SELECT job_state, apply_state FROM site_command_job WHERE id=?").get(job.id).apply_state, "applied");
  db.close();
});

test("console exposes pending-list cancel for unsent remote-cs", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /未送出的遠端客服也可取消/);
  assert.match(html, /console\.js\?v=20260912-pkg22/);
  assert.match(js, /\/ops\/api\/site-commands\/\$\{id\}\/cancel/);
  assert.match(js, /取消未送出的遠端客服/);
  assert.match(js, /已在外送的呼叫不宣稱撤回/);
});
