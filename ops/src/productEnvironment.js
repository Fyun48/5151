import { httpError } from "./errors.js";
import { appendAuditRow } from "./audit.js";
import { withImmediateTx } from "./tx.js";

export const DEFAULT_ENVIRONMENT_KEY = "production";
export const ENVIRONMENT_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const PRODUCT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export const V3_PRODUCTION_BINDING = Object.freeze({
  product_id: "v3",
  environment_key: DEFAULT_ENVIRONMENT_KEY,
  repo_url: "https://github.com/Fyun48/5151",
  workflow_file: ".github/workflows/deploy-v3.yml",
  container_name: "591-tracker-v3",
  data_path: "data-v3",
  deploy_identity: "Fyun48",
  display_label: "正式機",
});

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function normalizeProductId(value, { fallback = "" } = {}) {
  const id = String(value || "").trim().toLowerCase();
  if (PRODUCT_ID_RE.test(id)) return id;
  return fallback;
}

export function normalizeEnvironmentKey(value, { fallback = "" } = {}) {
  const key = String(value || "").trim().toLowerCase();
  if (ENVIRONMENT_KEY_RE.test(key)) return key;
  return fallback;
}

export function looksLikeDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  return !PRODUCT_ID_RE.test(raw.toLowerCase());
}

export function assertStableTargetIds({ productId, environmentKey, displayName } = {}) {
  if (displayName && !productId) {
    throw httpError("display name cannot identify a production target", 400);
  }
  if (looksLikeDisplayName(productId)) {
    throw httpError("display name cannot identify a production target", 400);
  }
  if (environmentKey && looksLikeDisplayName(environmentKey)) {
    throw httpError("environment key must be a stable id, not a display name", 400);
  }
}

export function ensureProductEnvironmentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_environment_binding (
      product_id TEXT NOT NULL,
      environment_key TEXT NOT NULL,
      repo_url TEXT,
      workflow_file TEXT,
      container_name TEXT,
      data_path TEXT,
      deploy_identity TEXT,
      display_label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (product_id, environment_key)
    );
    CREATE INDEX IF NOT EXISTS idx_product_env_product ON product_environment_binding(product_id);
  `);
}

export function publicEnvironmentBinding(row) {
  if (!row) return null;
  return {
    product_id: row.product_id,
    environment_key: row.environment_key,
    repo_url: row.repo_url || null,
    workflow_file: row.workflow_file || null,
    container_name: row.container_name || null,
    data_path: row.data_path || null,
    deploy_identity: row.deploy_identity || null,
    display_label: row.display_label || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function seedBinding(db, binding, now) {
  const ts = iso(now);
  db.prepare(`
    INSERT INTO product_environment_binding(
      product_id, environment_key, repo_url, workflow_file, container_name,
      data_path, deploy_identity, display_label, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(product_id, environment_key) DO NOTHING
  `).run(
    binding.product_id,
    binding.environment_key,
    binding.repo_url || null,
    binding.workflow_file || null,
    binding.container_name || null,
    binding.data_path || null,
    binding.deploy_identity || null,
    binding.display_label || null,
    ts,
    ts,
  );
}

export function ensureDefaultEnvironmentBindings(db, productId = "v3", { now = new Date() } = {}) {
  ensureProductEnvironmentSchema(db);
  const id = normalizeProductId(productId, { fallback: "v3" });
  if (id === "v3") {
    seedBinding(db, V3_PRODUCTION_BINDING, now);
    return getEnvironmentBinding(db, id, DEFAULT_ENVIRONMENT_KEY);
  }
  seedBinding(db, {
    product_id: id,
    environment_key: DEFAULT_ENVIRONMENT_KEY,
    repo_url: null,
    workflow_file: null,
    container_name: null,
    data_path: null,
    deploy_identity: null,
    display_label: "正式機",
  }, now);
  return getEnvironmentBinding(db, id, DEFAULT_ENVIRONMENT_KEY);
}

export function getEnvironmentBinding(db, productId, environmentKey = DEFAULT_ENVIRONMENT_KEY) {
  ensureProductEnvironmentSchema(db);
  const id = normalizeProductId(productId);
  const env = normalizeEnvironmentKey(environmentKey, { fallback: DEFAULT_ENVIRONMENT_KEY });
  if (!id || !env) return null;
  return publicEnvironmentBinding(
    db.prepare("SELECT * FROM product_environment_binding WHERE product_id=? AND environment_key=?").get(id, env),
  );
}

export function listProductEnvironments(db, productId) {
  ensureProductEnvironmentSchema(db);
  const id = normalizeProductId(productId);
  if (!id) return [];
  return db.prepare(
    "SELECT * FROM product_environment_binding WHERE product_id=? ORDER BY environment_key ASC",
  ).all(id).map(publicEnvironmentBinding);
}

export function upsertProductEnvironment(db, {
  productId, environmentKey, repoUrl, workflowFile, containerName, dataPath, deployIdentity, displayLabel,
  actor = "owner", now = new Date(),
} = {}) {
  assertStableTargetIds({ productId, environmentKey });
  const id = normalizeProductId(productId);
  const env = normalizeEnvironmentKey(environmentKey, { fallback: DEFAULT_ENVIRONMENT_KEY });
  if (!id) throw httpError("product_id required", 400);
  if (!env) throw httpError("environment_key required", 400);
  ensureProductEnvironmentSchema(db);
  const ts = iso(now);
  const existing = getEnvironmentBinding(db, id, env);
  return withImmediateTx(db, () => {
    db.prepare(`
      INSERT INTO product_environment_binding(
        product_id, environment_key, repo_url, workflow_file, container_name,
        data_path, deploy_identity, display_label, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(product_id, environment_key) DO UPDATE SET
        repo_url=excluded.repo_url,
        workflow_file=excluded.workflow_file,
        container_name=excluded.container_name,
        data_path=excluded.data_path,
        deploy_identity=excluded.deploy_identity,
        display_label=excluded.display_label,
        updated_at=excluded.updated_at
    `).run(
      id, env, repoUrl || null, workflowFile || null, containerName || null,
      dataPath || null, deployIdentity || null, displayLabel || null, existing?.created_at || ts, ts,
    );
    appendAuditRow(db, {
      actor,
      action: "product.environment.upserted",
      entityType: "product_environment_binding",
      entityId: `${id}:${env}`,
      data: { product_id: id, environment_key: env, container_name: containerName || null },
      now,
    });
    return getEnvironmentBinding(db, id, env);
  });
}

export function resolveProductionTarget(db, { productId, environmentKey = DEFAULT_ENVIRONMENT_KEY, displayName } = {}) {
  assertStableTargetIds({ productId, environmentKey, displayName });
  const id = normalizeProductId(productId);
  const env = normalizeEnvironmentKey(environmentKey, { fallback: DEFAULT_ENVIRONMENT_KEY });
  if (!id) throw httpError("product_id required", 400);
  const row = getEnvironmentBinding(db, id, env);
  if (!row) throw httpError("production target not registered", 404);
  return row;
}
