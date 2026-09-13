import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct, reconnectProduct, unsubscribeProduct, updateProductCapabilities } from "../src/products.js";
import {
  deliverSiteCommand,
  enqueueSiteCommand,
  issueCommandCredential,
  siteCommandWriteDecision,
} from "../src/siteCommand.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function grantRemoteCs(db, productId) {
  return updateProductCapabilities(db, productId, { remote_cs: true });
}

test("enqueue stamps the current subscription generation", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  grantRemoteCs(db, "shop");
  const { job } = enqueueSiteCommand(db, {
    product_id: "shop",
    command_kind: "feedback.patch_handling",
    idempotency_key: "k-stamp",
    payload: { feedback_id: 1, handling_state: "doing" },
  });
  assert.equal(job.subscription_generation, 1);
  db.close();
});

test("unsubscribe blocks delivery and does not call the site", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  grantRemoteCs(db, "shop");
  const { job } = enqueueSiteCommand(db, {
    product_id: "shop",
    command_kind: "feedback.patch_handling",
    idempotency_key: "k-unsub",
    payload: { feedback_id: 1, handling_state: "doing" },
  });
  unsubscribeProduct(db, "shop");
  assert.equal(siteCommandWriteDecision(db, "shop", { expectedGeneration: 1 }).ok, false);
  let called = 0;
  const out = await deliverSiteCommand(db, job.command_id, {
    applyUrl: "http://127.0.0.1:9/api/ops/commands/apply",
    secret: "x",
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => ({ apply_state: "applied" }) };
    },
  });
  assert.equal(called, 0);
  assert.equal(out.job_state, "failed");
  assert.equal(out.last_error, "subscription_revoked");
  assert.notEqual(out.apply_state, "applied");
  db.close();
});

test("reconnect makes previous-generation command fail without sending", async () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  grantRemoteCs(db, "shop");
  const { job } = enqueueSiteCommand(db, {
    product_id: "shop",
    command_kind: "crm.add_note",
    idempotency_key: "k-reconn",
    payload: { contact_id: 1, body: "note" },
  });
  unsubscribeProduct(db, "shop");
  reconnectProduct(db, "shop");
  grantRemoteCs(db, "shop");
  issueCommandCredential(db, { productId: "shop" });
  let called = 0;
  const out = await deliverSiteCommand(db, job.command_id, {
    applyUrl: "http://127.0.0.1:9/api/ops/commands/apply",
    secret: "fresh-secret",
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => ({ apply_state: "applied" }) };
    },
  });
  assert.equal(called, 0);
  assert.equal(out.last_error, "stale_generation");
  assert.equal(out.job_state, "failed");
  db.close();
});

test("pending list scopes remote-cs notes after enqueue", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  grantRemoteCs(db, "shop");
  const { job } = enqueueSiteCommand(db, {
    product_id: "shop",
    command_kind: "feedback.patch_handling",
    idempotency_key: "k-pend",
    payload: { feedback_id: 2, handling_state: "doing" },
  });
  const pending = listPendingWork(db, "shop");
  const item = pending.items.find((it) => it.kind === "site_command");
  assert.ok(item);
  assert.equal(item.id, job.id);
  assert.equal(item.state, "pending");
  assert.equal(item.blocking, false);
  assert.match(item.note, /不會外送/);
  const other = listPendingWork(db, "other");
  assert.equal(other.items.filter((it) => it.kind === "site_command").length, 0);
  db.close();
});

test("console explains late remote-cs commands will not be sent", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /遠端客服/);
  assert.match(html, /外送客服命令/);
  assert.match(js, /未送出的遠端客服也不會外送/);
  assert.match(html, /console\.js\?v=20260913-pkg28/);
});
