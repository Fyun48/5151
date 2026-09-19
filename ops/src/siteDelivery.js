import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { getProduct, publicProduct } from "./products.js";
import { withImmediateTx } from "./tx.js";
import { rejectSpoofedOwnerDirect } from "./instructionSource.js";

export const SITE_DELIVERY_EVIDENCE_KIND = "site_delivery_stop_confirmed";
export const SITE_DELIVERY_OBSERVED = Object.freeze(["stopped", "still_sending", "unknown"]);

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function ensureSiteDeliverySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_site_delivery_observation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      subscription_generation INTEGER NOT NULL,
      evidence_kind TEXT NOT NULL,
      observed_delivery TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor TEXT NOT NULL,
      rewrite_subscription INTEGER NOT NULL DEFAULT 0,
      site_not_claimed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_site_delivery_obs_product
      ON product_site_delivery_observation(product_id, subscription_generation, evidence_kind);
  `);
}

function subscriptionRevoked(product) {
  if (!product) return false;
  const productStatus = String(product.status || "");
  const subStatus = String(product.subscription_status || product.subscription?.status || "");
  return ["exited", "exiting"].includes(productStatus) || ["exited", "exiting"].includes(subStatus);
}

export function siteDeliveryObservation(db, productId, generation) {
  ensureSiteDeliverySchema(db);
  const id = String(productId || "");
  const gen = Number(generation || 1);
  if (!id) return null;
  return db.prepare(`
    SELECT id, product_id, subscription_generation, evidence_kind, observed_delivery, reason, actor,
           rewrite_subscription, site_not_claimed, created_at
      FROM product_site_delivery_observation
     WHERE product_id=? AND subscription_generation=? AND evidence_kind=?
     ORDER BY id DESC LIMIT 1
  `).get(id, gen, SITE_DELIVERY_EVIDENCE_KIND) || null;
}

export function describeSiteDeliveryOffer(db, productId) {
  ensureSiteDeliverySchema(db);
  const product = getProduct(db, productId);
  if (!product) return { offered: false, reason: "not_found" };
  const generation = Number(product.subscription_generation || 1);
  if (!subscriptionRevoked(product)) {
    return { offered: false, reason: "subscription_active", confirmed: false, product_id: product.id, generation };
  }
  if (siteDeliveryObservation(db, product.id, generation)) {
    return {
      offered: false,
      reason: "already_confirmed",
      confirmed: true,
      product_id: product.id,
      generation,
    };
  }
  return {
    offered: true,
    confirmed: false,
    product_id: product.id,
    generation,
    observed_delivery: SITE_DELIVERY_OBSERVED.slice(),
    rewrite_subscription: false,
    site_not_claimed: true,
  };
}

export function confirmSiteDeliveryObservation(db, productId, opts = {}) {
  rejectSpoofedOwnerDirect(opts);
  const {
    actor = "owner",
    reason = null,
    observedDelivery = null,
    fetchImpl = null,
    now = new Date(),
  } = opts;
  const observed = String(observedDelivery || "").trim().toLowerCase();
  if (!SITE_DELIVERY_OBSERVED.includes(observed)) {
    throw httpError("確認必須寫下停送結果：stopped、still_sending 或 unknown", 400);
  }
  const note = String(reason || "").trim();
  if (!note) throw httpError("確認必須寫明實際看到的本站遞送結果", 400);
  if (typeof fetchImpl === "function") {
    // Observation only; the site stop-delivery endpoint is never called.
  }
  const product = getProduct(db, productId);
  if (!product) throw httpError("找不到產品", 404);
  if (!subscriptionRevoked(product)) {
    throw httpError("只有已解除訂閱或退出中的站才可確認停送。訂閱仍接通時不必寫觀察。", 409);
  }
  const generation = Number(product.subscription_generation || 1);
  const existing = siteDeliveryObservation(db, product.id, generation);
  if (existing) {
    return {
      idempotent: true,
      confirmed: true,
      rewrite_subscription: false,
      site_not_claimed: true,
      observed_delivery: existing.observed_delivery,
      generation,
      product: publicProduct(product),
    };
  }
  withImmediateTx(db, () => {
    db.prepare(`
      INSERT INTO product_site_delivery_observation(
        product_id, subscription_generation, evidence_kind, observed_delivery, reason, actor,
        rewrite_subscription, site_not_claimed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)
    `).run(product.id, generation, SITE_DELIVERY_EVIDENCE_KIND, observed, note.slice(0, 1000), actor, iso(now));
    appendAuditRow(db, {
      actor,
      action: "site_delivery.stop_observed",
      entityType: "ops_product",
      entityId: String(product.id),
      data: {
        product_id: product.id,
        generation,
        observed_delivery: observed,
        reason: note.slice(0, 1000),
        rewrite_subscription: false,
        site_not_claimed: true,
        prev_product_status: product.status,
        prev_subscription_status: product.subscription_status || null,
      },
      now,
    });
  });
  const fresh = getProduct(db, product.id);
  return {
    confirmed: true,
    rewrite_subscription: false,
    site_not_claimed: true,
    observed_delivery: observed,
    generation,
    product: publicProduct(fresh),
  };
}
