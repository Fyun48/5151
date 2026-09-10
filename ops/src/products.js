import { randomBytes } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { verifyIngestRequest } from "./ingestSignature.js";

export const DEFAULT_PRODUCT_ID = "v3";
export const DEFAULT_PRODUCT_NAME = "吉比租房";

export const PRODUCT_STATUSES = Object.freeze(["active", "paused", "exiting", "exited"]);
export const SUBSCRIPTION_STATUSES = Object.freeze([
  "connecting", "connected", "paused", "exiting", "exited", "reconnecting",
]);

const PRODUCT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function parseCaps(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function normalizeProductId(value, { fallback = "" } = {}) {
  const id = String(value || "").trim().toLowerCase();
  if (PRODUCT_ID_RE.test(id)) return id;
  return fallback;
}

export function ensureDefaultProduct(db, { now = new Date() } = {}) {
  const ts = iso(now);
  db.prepare(`
    INSERT INTO ops_product(id, display_name, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(DEFAULT_PRODUCT_ID, DEFAULT_PRODUCT_NAME, ts, ts);
  db.prepare(`
    INSERT INTO product_subscription(product_id, generation, status, capabilities, started_at, updated_at)
    VALUES (?, 1, 'connected', ?, ?, ?)
    ON CONFLICT(product_id) DO NOTHING
  `).run(DEFAULT_PRODUCT_ID, JSON.stringify({ feedback_copy: true }), ts, ts);
}

export function ensureLegacyIngestSecret(db, secret, { productId = DEFAULT_PRODUCT_ID, now = new Date() } = {}) {
  const trimmed = String(secret || "");
  if (!trimmed) return null;
  ensureDefaultProduct(db, { now });
  const existing = db.prepare(
    "SELECT * FROM product_ingest_credential WHERE product_id=? AND status='active' AND secret=?",
  ).get(productId, trimmed);
  if (existing) return existing;
  return issueCredential(db, { productId, secret: trimmed, label: "legacy-env", now });
}

export function listProducts(db) {
  const rows = db.prepare(`
    SELECT p.*, s.generation AS subscription_generation, s.status AS subscription_status,
           s.capabilities, s.started_at AS subscription_started_at, s.ended_at AS subscription_ended_at
      FROM ops_product p
      LEFT JOIN product_subscription s ON s.product_id = p.id
     ORDER BY p.id ASC
  `).all();
  return rows.map(publicProduct);
}

export function getProduct(db, productId) {
  const id = normalizeProductId(productId);
  if (!id) return null;
  const row = db.prepare(`
    SELECT p.*, s.generation AS subscription_generation, s.status AS subscription_status,
           s.capabilities, s.started_at AS subscription_started_at, s.ended_at AS subscription_ended_at
      FROM ops_product p
      LEFT JOIN product_subscription s ON s.product_id = p.id
     WHERE p.id=?
  `).get(id);
  return row || null;
}

export function publicProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    display_name: row.display_name,
    status: row.status,
    subscription: {
      generation: Number(row.subscription_generation || 1),
      status: row.subscription_status || "connected",
      capabilities: parseCaps(row.capabilities),
      started_at: row.subscription_started_at || row.created_at || null,
      ended_at: row.subscription_ended_at || null,
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createProduct(db, { id, displayName, actor = "owner", now = new Date() } = {}) {
  const productId = normalizeProductId(id);
  if (!productId) throw httpError("invalid product_id", 400);
  if (getProduct(db, productId)) throw httpError("product exists", 409);
  const ts = iso(now);
  const name = String(displayName || productId).trim().slice(0, 80) || productId;
  return withImmediateTx(db, () => {
    db.prepare(`
      INSERT INTO ops_product(id, display_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)
    `).run(productId, name, ts, ts);
    db.prepare(`
      INSERT INTO product_subscription(product_id, generation, status, capabilities, started_at, updated_at)
      VALUES (?, 1, 'connected', ?, ?, ?)
    `).run(productId, JSON.stringify({ feedback_copy: true }), ts, ts);
    const cred = issueCredential(db, { productId, label: "initial", now });
    appendAuditRow(db, {
      actor,
      action: "product.created",
      entityType: "ops_product",
      entityId: productId,
      data: { display_name: name },
      now,
    });
    return { product: publicProduct(getProduct(db, productId)), ingest_secret: cred.secret };
  });
}

function setStatuses(db, productId, { productStatus, subscriptionStatus, actor, now, action }) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  const ts = iso(now);
  return withImmediateTx(db, () => {
    if (productStatus) {
      db.prepare("UPDATE ops_product SET status=?, updated_at=? WHERE id=?").run(productStatus, ts, product.id);
    }
    if (subscriptionStatus) {
      const ended = ["exited", "exiting"].includes(subscriptionStatus) ? ts : null;
      db.prepare("UPDATE product_subscription SET status=?, ended_at=?, updated_at=? WHERE product_id=?")
        .run(subscriptionStatus, ended, ts, product.id);
    }
    appendAuditRow(db, {
      actor,
      action,
      entityType: "ops_product",
      entityId: product.id,
      data: { product_status: productStatus || product.status, subscription_status: subscriptionStatus || product.subscription_status },
      now,
    });
    return publicProduct(getProduct(db, product.id));
  });
}

export function pauseProduct(db, productId, { actor = "owner", now = new Date() } = {}) {
  return setStatuses(db, productId, {
    productStatus: "paused",
    subscriptionStatus: "paused",
    actor,
    now,
    action: "product.paused",
  });
}

export function resumeProduct(db, productId, { actor = "owner", now = new Date() } = {}) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  if (product.status === "exited" || product.subscription_status === "exited") {
    throw httpError("reconnect required", 409);
  }
  return setStatuses(db, productId, {
    productStatus: "active",
    subscriptionStatus: "connected",
    actor,
    now,
    action: "product.resumed",
  });
}

export function unsubscribeProduct(db, productId, { actor = "owner", now = new Date() } = {}) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  const ts = iso(now);
  return withImmediateTx(db, () => {
    revokeCredentials(db, product.id, { now, actor });
    db.prepare("UPDATE ops_product SET status=?, updated_at=? WHERE id=?").run("exited", ts, product.id);
    db.prepare("UPDATE product_subscription SET status=?, ended_at=?, updated_at=? WHERE product_id=?")
      .run("exited", ts, ts, product.id);
    appendAuditRow(db, {
      actor,
      action: "product.unsubscribed",
      entityType: "ops_product",
      entityId: product.id,
      data: { generation: product.subscription_generation },
      now,
    });
    return publicProduct(getProduct(db, product.id));
  });
}

export function reconnectProduct(db, productId, { actor = "owner", now = new Date() } = {}) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  const ts = iso(now);
  return withImmediateTx(db, () => {
    revokeCredentials(db, product.id, { now, actor });
    const nextGen = Number(product.subscription_generation || 1) + 1;
    db.prepare("UPDATE ops_product SET status=?, updated_at=? WHERE id=?").run("active", ts, product.id);
    db.prepare(`
      UPDATE product_subscription
         SET generation=?, status='connected', ended_at=NULL, started_at=?, updated_at=?
       WHERE product_id=?
    `).run(nextGen, ts, ts, product.id);
    const cred = issueCredential(db, { productId: product.id, label: `gen-${nextGen}`, now, generation: nextGen });
    appendAuditRow(db, {
      actor,
      action: "product.reconnected",
      entityType: "ops_product",
      entityId: product.id,
      data: { generation: nextGen },
      now,
    });
    return { product: publicProduct(getProduct(db, product.id)), ingest_secret: cred.secret };
  });
}

export function issueCredential(db, { productId, secret = null, label = "ingest", now = new Date(), generation = null } = {}) {
  const id = normalizeProductId(productId);
  if (!id) throw httpError("invalid product_id", 400);
  const product = getProduct(db, id) || { subscription_generation: 1 };
  const material = secret || randomBytes(24).toString("hex");
  const ts = iso(now);
  const gen = generation == null ? Number(product.subscription_generation || 1) : Number(generation);
  const res = db.prepare(`
    INSERT INTO product_ingest_credential(product_id, generation, secret, label, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ?)
  `).run(id, gen, material, String(label || "ingest").slice(0, 64), ts);
  return { id: Number(res.lastInsertRowid), product_id: id, secret: material, generation: gen, label };
}

export function rotateCredential(db, productId, { actor = "owner", now = new Date() } = {}) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  if (!productAcceptsIngest(product)) throw httpError("subscription_inactive", 403);
  return withImmediateTx(db, () => {
    revokeCredentials(db, product.id, { now, actor });
    const cred = issueCredential(db, { productId: product.id, label: "rotated", now });
    appendAuditRow(db, {
      actor,
      action: "product.credential.rotated",
      entityType: "ops_product",
      entityId: product.id,
      data: { credential_id: cred.id },
      now,
    });
    return { product: publicProduct(getProduct(db, product.id)), ingest_secret: cred.secret };
  });
}

export function revokeCredentials(db, productId, { now = new Date() } = {}) {
  const ts = iso(now);
  db.prepare("UPDATE product_ingest_credential SET status='revoked', revoked_at=? WHERE product_id=? AND status='active'")
    .run(ts, productId);
}

export function listActiveCredentials(db) {
  return db.prepare(`
    SELECT id, product_id, generation, secret, label, status, created_at
      FROM product_ingest_credential
     WHERE status='active'
     ORDER BY id ASC
  `).all();
}

export function productAcceptsIngest(product) {
  if (!product) return false;
  const pStatus = product.status;
  const sStatus = product.subscription_status || product.subscription?.status;
  return pStatus === "active" && (sStatus === "connected" || sStatus === "connecting");
}

export function getFeedbackForProduct(db, feedbackId, productId) {
  const id = Number(feedbackId) || 0;
  if (!id) return null;
  const row = db.prepare("SELECT * FROM ingested_feedback WHERE id=?").get(id);
  if (!row) return null;
  if (productId && row.product_id !== productId) return null;
  return row;
}

export function resolveIngestAuth(db, {
  method,
  path,
  headers,
  rawBody,
  envSecret = "",
  now = Date.now(),
} = {}) {
  const candidates = listActiveCredentials(db);
  const env = String(envSecret || "");
  const v3Creds = Number(db.prepare(
    "SELECT COUNT(*) AS n FROM product_ingest_credential WHERE product_id=?",
  ).get(DEFAULT_PRODUCT_ID)?.n || 0);
  // env 只在完全沒有憑證列時當後備；撤銷／輪替後不得再靠環境變數開門。
  if (env && v3Creds === 0 && !candidates.some((c) => c.secret === env && c.product_id === DEFAULT_PRODUCT_ID)) {
    candidates.push({
      id: 0,
      product_id: DEFAULT_PRODUCT_ID,
      generation: 0,
      secret: env,
      label: "env",
      status: "active",
    });
  }
  if (!candidates.length) {
    const anyCreds = Number(db.prepare("SELECT COUNT(*) AS n FROM product_ingest_credential").get()?.n || 0);
    if (anyCreds) return { ok: false, status: 401, error: "unauthorized", reason: "no_active_credential" };
    return { ok: false, status: 503, error: "ingest not configured", reason: "no_secret_configured" };
  }

  let matched = null;
  for (const cred of candidates) {
    const check = verifyIngestRequest({ method, path, headers, rawBody, secret: cred.secret, now });
    if (check.ok) {
      matched = { ...check, productId: cred.product_id, generation: cred.generation, credentialId: cred.id };
      break;
    }
  }
  if (!matched) return { ok: false, status: 401, error: "unauthorized", reason: "bad_signature" };

  const product = getProduct(db, matched.productId);
  if (!productAcceptsIngest(product || { status: "active", subscription_status: "connected" })) {
    return { ok: false, status: 403, error: "subscription_inactive", reason: "subscription_inactive", productId: matched.productId };
  }
  return { ok: true, ...matched };
}
