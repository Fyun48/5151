import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct, updateProductCapabilities } from "../src/products.js";
import {
  confirmSiteCommandApplyObservation,
  describeSiteCommandApplyOffer,
  enqueueSiteCommand,
} from "../src/siteCommand.js";
import { listPendingWork } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));

function grantRemoteCs(db, productId) {
  return updateProductCapabilities(db, productId, { remote_cs: true });
}

function seedSentCommand(db, { productId = "shop", key = "k-sent", applyState = "unknown" } = {}) {
  grantRemoteCs(db, productId);
  const { job } = enqueueSiteCommand(db, {
    product_id: productId,
    command_kind: "feedback.patch_handling",
    idempotency_key: key,
    payload: { feedback_id: 1, handling_state: "doing" },
  });
  db.prepare("UPDATE site_command_job SET job_state='sent', apply_state=? WHERE id=?").run(applyState, job.id);
  return db.prepare("SELECT * FROM site_command_job WHERE id=?").get(job.id);
}

test("pending list offers apply observation for sent remote-cs without rewriting state", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const job = seedSentCommand(db, { productId: "shop" });
  const offer = describeSiteCommandApplyOffer(db, job.id);
  assert.equal(offer.offered, true);
  assert.equal(offer.rewrite_apply, false);
  assert.equal(offer.site_not_claimed, true);
  assert.deepEqual(offer.observed_apply, ["applied", "not_applied", "unknown"]);
  const item = listPendingWork(db, "shop").items.find((it) => it.kind === "site_command" && it.id === job.id);
  assert.ok(item);
  assert.equal(item.state, "sent");
  assert.equal(item.apply_confirm.offered, true);
  assert.match(item.note, /已送出的遠端客服不宣稱撤回/);
  assert.match(item.note, /可從未決清單確認本站套用結果/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "site_command").length, 0);
  db.close();
});

test("confirming not-applied writes observation only and leaves job state sent", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const job = seedSentCommand(db, { productId: "shop", key: "k-obs" });
  let fetchCalls = 0;
  const out = confirmSiteCommandApplyObservation(db, job.id, {
    actor: "owner",
    reason: "本站後台沒有這則處理紀錄",
    observedApply: "not_applied",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
  });
  assert.equal(out.confirmed, true);
  assert.equal(out.rewrite_apply, false);
  assert.equal(out.site_not_claimed, true);
  assert.equal(out.observed_apply, "not_applied");
  assert.equal(out.job.job_state, "sent");
  assert.equal(out.job.apply_state, "unknown");
  assert.equal(fetchCalls, 0);
  const row = db.prepare("SELECT job_state, apply_state FROM site_command_job WHERE id=?").get(job.id);
  assert.equal(row.job_state, "sent");
  assert.equal(row.apply_state, "unknown");
  const obs = db.prepare("SELECT evidence_kind, observed_apply FROM site_command_observation WHERE job_id=?").get(job.id);
  assert.equal(obs.evidence_kind, "site_command_apply_confirmed");
  assert.equal(obs.observed_apply, "not_applied");
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='site_command.apply_observed'").get().n >= 1);
  assert.equal(describeSiteCommandApplyOffer(db, job.id).offered, false);
  assert.equal(describeSiteCommandApplyOffer(db, job.id).reason, "already_confirmed");
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "site_command" && it.id === job.id).length, 0);
  const again = confirmSiteCommandApplyObservation(db, job.id, {
    reason: "再按一次",
    observedApply: "not_applied",
  });
  assert.equal(again.idempotent, true);
  assert.equal(again.rewrite_apply, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM site_command_observation WHERE job_id=?").get(job.id).n, 1);
  db.close();
});

test("confirm requires reason and observed_apply", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const job = seedSentCommand(db, { productId: "shop", key: "k-req" });
  assert.throws(
    () => confirmSiteCommandApplyObservation(db, job.id, { observedApply: "not_applied" }),
    (err) => err.status === 400,
  );
  assert.throws(
    () => confirmSiteCommandApplyObservation(db, job.id, { reason: "本站沒有這筆" }),
    (err) => err.status === 400,
  );
  assert.throws(
    () => confirmSiteCommandApplyObservation(db, job.id, { reason: "本站沒有這筆", observedApply: "maybe" }),
    (err) => err.status === 400,
  );
  assert.equal(describeSiteCommandApplyOffer(db, job.id).offered, true);
  db.close();
});

test("owner_direct spoof cannot confirm apply from the pending offer", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const job = seedSentCommand(db, { productId: "shop", key: "k-od" });
  assert.throws(
    () => confirmSiteCommandApplyObservation(db, job.id, {
      reason: "x",
      observedApply: "applied",
      owner_direct: true,
    }),
    (err) => err.status === 403,
  );
  assert.equal(describeSiteCommandApplyOffer(db, job.id).offered, true);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "site_command").length, 1);
  db.close();
});

test("pending or already-applied remote-cs cannot use the confirm-apply door", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  grantRemoteCs(db, "shop");
  const pending = enqueueSiteCommand(db, {
    product_id: "shop",
    command_kind: "crm.add_note",
    idempotency_key: "k-pending",
    payload: { contact_id: 1, body: "note" },
  }).job;
  assert.equal(describeSiteCommandApplyOffer(db, pending.id).reason, "not_sent");
  assert.throws(
    () => confirmSiteCommandApplyObservation(db, pending.id, { reason: "x", observedApply: "applied" }),
    (err) => err.status === 409 && /未送出的走取消/.test(err.message),
  );
  const applied = seedSentCommand(db, { productId: "shop", key: "k-applied", applyState: "applied" });
  assert.equal(describeSiteCommandApplyOffer(db, applied.id).reason, "already_applied");
  assert.throws(
    () => confirmSiteCommandApplyObservation(db, applied.id, { reason: "x", observedApply: "applied" }),
    (err) => err.status === 409 && /已回報套用成功/.test(err.message),
  );
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "site_command" && it.id === applied.id).length, 0);
  db.close();
});

test("console exposes pending-list apply confirm without opening a coding or deploy path", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /已送出且尚未確認套用的遠端客服可從未決清單確認已套用、未套用或套用不明/);
  assert.match(html, /確認只寫觀察，不改寫命令終態，也不假裝本站已回覆/);
  assert.match(html, /console\.js\?v=20260913-pkg35/);
  assert.match(js, /PENDING_APPLY_CONFIRM/);
  assert.match(js, /確認已套用/);
  assert.match(js, /確認未套用/);
  assert.match(js, /確認套用不明/);
  assert.match(js, /\/ops\/api\/site-commands\/\$\{itemId\}\/confirm-apply/);
  assert.match(js, /observed_apply: spec\.observedApply/);
  assert.doesNotMatch(js, /\/ops\/api\/coding-tasks\/\$\{itemId\}\/(execute|claim)/);
  assert.doesNotMatch(js, /owner_direct:\s*true/);
});
