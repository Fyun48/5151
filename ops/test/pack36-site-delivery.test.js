import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { createProduct, pauseProduct, reconnectProduct, unsubscribeProduct } from "../src/products.js";
import {
  confirmSiteDeliveryObservation,
  describeSiteDeliveryOffer,
} from "../src/siteDelivery.js";
import { beginUnsubscribeExit, listPendingWork, pendingForHandoff } from "../src/exitDrill.js";

const root = dirname(fileURLToPath(import.meta.url));
const AUTH = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(AUTH);
  const server = createApp({ db, auth, ingestSecret: "secret" }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ base, db }); } finally { server.close(); db.close(); }
}

async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: AUTH.ownerEmail, password: AUTH.ownerPassword }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

test("connected products do not offer site-delivery confirmation", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  const offer = describeSiteDeliveryOffer(db, "shop");
  assert.equal(offer.offered, false);
  assert.equal(offer.reason, "subscription_active");
  const pending = listPendingWork(db, "shop");
  assert.equal(pending.site_delivery_unconfirmed, false);
  assert.equal(pending.items.filter((it) => it.kind === "site_delivery").length, 0);
  db.close();
});

test("pending list offers stop-delivery observation after unsubscribe without rewriting state", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  createProduct(db, { id: "other", displayName: "別站" });
  const un = beginUnsubscribeExit(db, "shop", { actor: "owner" });
  assert.equal(un.site_delivery_unconfirmed, true);
  const offer = describeSiteDeliveryOffer(db, "shop");
  assert.equal(offer.offered, true);
  assert.equal(offer.rewrite_subscription, false);
  assert.equal(offer.site_not_claimed, true);
  assert.deepEqual(offer.observed_delivery, ["stopped", "still_sending", "unknown"]);
  const item = un.pending.items.find((it) => it.kind === "site_delivery");
  assert.ok(item);
  assert.equal(item.state, "unconfirmed");
  assert.equal(item.delivery_confirm.offered, true);
  assert.match(item.note, /本站停止遞送尚未由此畫面確認/);
  assert.equal(listPendingWork(db, "other").items.filter((it) => it.kind === "site_delivery").length, 0);
  assert.equal(listPendingWork(db, "other").site_delivery_unconfirmed, false);
  db.close();
});

test("confirming still-sending writes observation only and leaves subscription exited", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  unsubscribeProduct(db, "shop", { actor: "owner" });
  let fetchCalls = 0;
  const out = confirmSiteDeliveryObservation(db, "shop", {
    actor: "owner",
    reason: "本站後台仍顯示 OPS 遞送開啟",
    observedDelivery: "still_sending",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
  });
  assert.equal(out.confirmed, true);
  assert.equal(out.rewrite_subscription, false);
  assert.equal(out.site_not_claimed, true);
  assert.equal(out.observed_delivery, "still_sending");
  assert.equal(out.product.status, "exited");
  assert.equal(out.product.subscription.status, "exited");
  assert.equal(fetchCalls, 0);
  const product = db.prepare("SELECT status FROM ops_product WHERE id='shop'").get();
  const sub = db.prepare("SELECT status FROM product_subscription WHERE product_id='shop'").get();
  assert.equal(product.status, "exited");
  assert.equal(sub.status, "exited");
  const obs = db.prepare("SELECT evidence_kind, observed_delivery, rewrite_subscription FROM product_site_delivery_observation WHERE product_id='shop'").get();
  assert.equal(obs.evidence_kind, "site_delivery_stop_confirmed");
  assert.equal(obs.observed_delivery, "still_sending");
  assert.equal(obs.rewrite_subscription, 0);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='site_delivery.stop_observed'").get().n >= 1);
  assert.equal(describeSiteDeliveryOffer(db, "shop").offered, false);
  assert.equal(describeSiteDeliveryOffer(db, "shop").reason, "already_confirmed");
  assert.equal(listPendingWork(db, "shop").site_delivery_unconfirmed, false);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "site_delivery").length, 0);
  const again = confirmSiteDeliveryObservation(db, "shop", {
    reason: "再按一次",
    observedDelivery: "still_sending",
  });
  assert.equal(again.idempotent, true);
  assert.equal(again.rewrite_subscription, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM product_site_delivery_observation WHERE product_id='shop'").get().n, 1);
  db.close();
});

test("confirm requires reason and observed_delivery", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  unsubscribeProduct(db, "shop", { actor: "owner" });
  assert.throws(
    () => confirmSiteDeliveryObservation(db, "shop", { observedDelivery: "stopped" }),
    (err) => err.status === 400,
  );
  assert.throws(
    () => confirmSiteDeliveryObservation(db, "shop", { reason: "本站後台已關遞送" }),
    (err) => err.status === 400,
  );
  assert.throws(
    () => confirmSiteDeliveryObservation(db, "shop", { reason: "本站後台已關遞送", observedDelivery: "maybe" }),
    (err) => err.status === 400,
  );
  assert.equal(describeSiteDeliveryOffer(db, "shop").offered, true);
  db.close();
});

test("owner_direct spoof cannot confirm site delivery from the pending offer", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  unsubscribeProduct(db, "shop", { actor: "owner" });
  assert.throws(
    () => confirmSiteDeliveryObservation(db, "shop", {
      reason: "x",
      observedDelivery: "stopped",
      owner_direct: true,
    }),
    (err) => err.status === 403,
  );
  assert.equal(describeSiteDeliveryOffer(db, "shop").offered, true);
  assert.equal(listPendingWork(db, "shop").items.filter((it) => it.kind === "site_delivery").length, 1);
  db.close();
});

test("active or paused products cannot use the confirm-delivery door", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  assert.equal(describeSiteDeliveryOffer(db, "shop").reason, "subscription_active");
  assert.throws(
    () => confirmSiteDeliveryObservation(db, "shop", { reason: "x", observedDelivery: "stopped" }),
    (err) => err.status === 409 && /訂閱仍接通/.test(err.message),
  );
  pauseProduct(db, "shop", { actor: "owner" });
  assert.equal(describeSiteDeliveryOffer(db, "shop").reason, "subscription_active");
  assert.throws(
    () => confirmSiteDeliveryObservation(db, "shop", { reason: "x", observedDelivery: "stopped" }),
    (err) => err.status === 409 && /訂閱仍接通/.test(err.message),
  );
  db.close();
});

test("reconnect starts a new generation that can be confirmed again after the next unsubscribe", () => {
  const db = openOpsDb(":memory:");
  createProduct(db, { id: "shop", displayName: "商店站" });
  unsubscribeProduct(db, "shop", { actor: "owner" });
  confirmSiteDeliveryObservation(db, "shop", { reason: "本站已關遞送", observedDelivery: "stopped" });
  reconnectProduct(db, "shop", { actor: "owner" });
  assert.equal(describeSiteDeliveryOffer(db, "shop").reason, "subscription_active");
  unsubscribeProduct(db, "shop", { actor: "owner" });
  const offer = describeSiteDeliveryOffer(db, "shop");
  assert.equal(offer.offered, true);
  assert.equal(offer.generation, 2);
  db.close();
});

test("handoff pending copies the computed delivery flag instead of forcing unconfirmed", () => {
  const filtered = pendingForHandoff({
    items: [{ kind: "credential", id: 1 }],
    blocking: [],
    site_delivery_unconfirmed: false,
  });
  assert.equal(filtered.site_delivery_unconfirmed, false);
  const unconfirmed = pendingForHandoff({
    items: [{ kind: "site_delivery", id: "shop", state: "unconfirmed" }],
    blocking: [],
    site_delivery_unconfirmed: true,
  });
  assert.equal(unconfirmed.site_delivery_unconfirmed, true);
});

test("confirm-site-delivery API writes observation without calling the site", async () => {
  await withServer(async ({ base, db }) => {
    createProduct(db, { id: "shop", displayName: "商店站" });
    const { cookie, csrf } = await login(base);
    const un = await (await fetch(`${base}/ops/api/products/shop/unsubscribe`, {
      method: "POST",
      headers: { cookie, "X-CSRF-Token": csrf, Origin: base },
    })).json();
    assert.equal(un.site_delivery_unconfirmed, true);
    const pending = await (await fetch(`${base}/ops/api/products/shop/pending`, {
      headers: { cookie },
    })).json();
    assert.equal(pending.site_delivery_unconfirmed, true);
    assert.ok(pending.pending.items.some((it) => it.kind === "site_delivery"));
    const spoof = await fetch(`${base}/ops/api/products/shop/confirm-site-delivery`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ reason: "x", observed_delivery: "stopped", owner_direct: true }),
    });
    assert.equal(spoof.status, 403);
    const ok = await (await fetch(`${base}/ops/api/products/shop/confirm-site-delivery`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf, Origin: base },
      body: JSON.stringify({ reason: "本站後台已關遞送", observed_delivery: "stopped" }),
    })).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.confirmed, true);
    assert.equal(ok.rewrite_subscription, false);
    assert.equal(ok.site_not_claimed, true);
    assert.equal(ok.observed_delivery, "stopped");
    const after = await (await fetch(`${base}/ops/api/products/shop/pending`, {
      headers: { cookie },
    })).json();
    assert.equal(after.site_delivery_unconfirmed, false);
    assert.equal(after.pending.items.filter((it) => it.kind === "site_delivery").length, 0);
  });
});

test("console exposes pending-list delivery confirm without opening a coding or deploy path", () => {
  const html = readFileSync(join(root, "../public/console.html"), "utf8");
  const js = readFileSync(join(root, "../public/console.js"), "utf8");
  assert.match(html, /解除訂閱後，本站停止遞送尚未確認時可從未決清單確認已停送、仍在送或停送不明/);
  assert.match(html, /確認只寫觀察，不改寫訂閱終態，也不假裝本站已停送/);
  assert.match(html, /console\.js\?v=20260915-pkg36/);
  assert.match(js, /PENDING_DELIVERY_CONFIRM/);
  assert.match(js, /確認已停送/);
  assert.match(js, /確認仍在送/);
  assert.match(js, /確認停送不明/);
  assert.match(js, /\/ops\/api\/products\/\$\{encodeURIComponent\(pid\)\}\/confirm-site-delivery/);
  assert.match(js, /observed_delivery: spec\.observedDelivery/);
  assert.doesNotMatch(js, /\/ops\/api\/coding-tasks\/\$\{itemId\}\/(execute|claim)/);
  assert.doesNotMatch(js, /owner_direct:\s*true/);
});
