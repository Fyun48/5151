/** Additive Stage 1 fixture registry. Source of truth for fixture identities.
 * Cleanup is exact row identity + namespace only — never email LIKE.
 */

import { createHash } from "node:crypto";
import {
  STAGE1_FIXTURE_NAMESPACE,
  STAGE1_FIXTURE_TTL_MS,
  fixtureNamespaceOf,
  tableColumns,
} from "./stage1FixtureIsolation.js";

export { STAGE1_FIXTURE_NAMESPACE, STAGE1_FIXTURE_TTL_MS };

export const FIXTURE_MATURITY = Symbol("stage1-fixture-maturity");
export const FIXTURE_ISOLATION = Symbol("stage1-fixture-isolation");

export const STAGE1_FIXTURE_KIND = Object.freeze({
  USER: "user",
  LISTING: "listing",
  WISH: "wish",
});

export const STAGE1_FIXTURE_ROLE = Object.freeze({
  OWNER_A: "owner_a",
  OTHER_B: "other_b",
  TENANT_T: "tenant_t",
  LISTING_A: "listing_a",
  WISH_ACTIVE: "wish_active",
  WISH_PAUSED: "wish_paused",
  WISH_COMPLETED: "wish_completed",
  WISH_INACTIVE: "wish_inactive",
  WISH_HARD_CONFLICT: "wish_hard_conflict",
});

export function fixtureEmailForRole(runId, role) {
  const run = String(runId || "").trim();
  const key = String(role || "").trim();
  if (!run || !key) throw new Error("fixture email requires run_id and role");
  const hash = createHash("sha256").update(`stage1-fix:${run}:${key}`).digest("hex").slice(0, 12);
  const local = String(key).replace(/_/g, ".");
  return `stage1.fixture.${local}.${hash}@jibby.test`;
}

export const STAGE1_FIXTURE_STATUS = Object.freeze({
  ACTIVE: "active",
  CLEANED: "cleaned",
});

function iso(now = new Date()) {
  return new Date(now instanceof Date ? now.getTime() : now).toISOString();
}

function nowMs(now = new Date()) {
  return now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
}

export function makeStage1FixtureRunId(now = new Date(), workflowRunId = "local") {
  const stamp = new Date(nowMs(now)).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const run = String(workflowRunId || "local").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "local";
  return `${STAGE1_FIXTURE_NAMESPACE}:${stamp}:${run}`;
}

export function ensureStage1FixtureSchema(db) {
  if (!db) return;
  try {
    const listingCols = tableColumns(db, "listings");
    if (listingCols.size && !listingCols.has("fixture_namespace")) {
      db.exec("ALTER TABLE listings ADD COLUMN fixture_namespace TEXT");
    }
  } catch { /* listings may be absent in isolated tests */ }
  try {
    const wishCols = tableColumns(db, "demand_posts");
    if (wishCols.size && !wishCols.has("fixture_namespace")) {
      db.exec("ALTER TABLE demand_posts ADD COLUMN fixture_namespace TEXT");
    }
  } catch { /* demand_posts may be absent */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage1_fixture_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      row_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      cleaned_at TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stage1_fixture_active_row
      ON stage1_fixture_registry(namespace, kind, row_id)
      WHERE cleaned_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_stage1_fixture_run
      ON stage1_fixture_registry(namespace, run_id, kind, role);
    CREATE INDEX IF NOT EXISTS idx_stage1_fixture_expires
      ON stage1_fixture_registry(status, expires_at);
  `);
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_listings_fixture_namespace ON listings(fixture_namespace, post_id)");
  } catch { /* listings missing */ }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_demand_fixture_namespace ON demand_posts(fixture_namespace, id)");
  } catch { /* demand_posts missing */ }
}

export function registerFixtureRow(db, {
  namespace = STAGE1_FIXTURE_NAMESPACE,
  runId,
  kind,
  role,
  rowId,
  now = new Date(),
  ttlMs = STAGE1_FIXTURE_TTL_MS,
} = {}) {
  ensureStage1FixtureSchema(db);
  const id = Number(rowId) || 0;
  if (!id) throw new Error("fixture registry row_id is required");
  if (!runId) throw new Error("fixture registry run_id is required");
  if (!kind || !role) throw new Error("fixture registry kind and role are required");
  const created = iso(now);
  const expires = new Date(nowMs(now) + Number(ttlMs || STAGE1_FIXTURE_TTL_MS)).toISOString();
  const result = db.prepare(`
    INSERT INTO stage1_fixture_registry(
      namespace, run_id, kind, role, row_id, created_at, expires_at, cleaned_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(namespace, runId, kind, role, id, created, expires, STAGE1_FIXTURE_STATUS.ACTIVE);
  return {
    id: Number(result.lastInsertRowid),
    namespace,
    run_id: runId,
    kind,
    role,
    row_id: id,
    created_at: created,
    expires_at: expires,
    cleaned_at: null,
    status: STAGE1_FIXTURE_STATUS.ACTIVE,
  };
}

export function listActiveRegistryRows(db, {
  namespace = STAGE1_FIXTURE_NAMESPACE,
  runId,
  kind,
  now = new Date(),
} = {}) {
  ensureStage1FixtureSchema(db);
  const stamp = iso(now);
  let sql = `
    SELECT * FROM stage1_fixture_registry
    WHERE namespace = ?
      AND cleaned_at IS NULL
      AND status = ?
      AND expires_at > ?
  `;
  const params = [namespace, STAGE1_FIXTURE_STATUS.ACTIVE, stamp];
  if (runId) {
    sql += " AND run_id = ?";
    params.push(runId);
  }
  if (kind) {
    sql += " AND kind = ?";
    params.push(kind);
  }
  sql += " ORDER BY id ASC";
  return db.prepare(sql).all(...params);
}

export function listUncleanedRegistryRows(db, {
  namespace = STAGE1_FIXTURE_NAMESPACE,
} = {}) {
  ensureStage1FixtureSchema(db);
  return db.prepare(`
    SELECT * FROM stage1_fixture_registry
    WHERE namespace = ?
      AND cleaned_at IS NULL
    ORDER BY id ASC
  `).all(namespace);
}

export function uncleanedFixtureRunIds(db, {
  namespace = STAGE1_FIXTURE_NAMESPACE,
} = {}) {
  return [...new Set(listUncleanedRegistryRows(db, { namespace }).map((row) => String(row.run_id || "")))].filter(Boolean);
}

export function assertPrepareRunExclusive(db, runId, namespace = STAGE1_FIXTURE_NAMESPACE) {
  const want = String(runId || "").trim();
  if (!want) throw new Error("prepare requires a fixture run_id");
  const other = uncleanedFixtureRunIds(db, { namespace }).filter((id) => id !== want);
  if (other.length) {
    throw new Error(`uncleaned fixture run exists (${other.join(",")}); cleanup or reap-stale first`);
  }
  return true;
}

export function listStaleRegistryRows(db, {
  namespace = STAGE1_FIXTURE_NAMESPACE,
  now = new Date(),
} = {}) {
  ensureStage1FixtureSchema(db);
  return db.prepare(`
    SELECT * FROM stage1_fixture_registry
    WHERE namespace = ?
      AND cleaned_at IS NULL
      AND expires_at <= ?
    ORDER BY id ASC
  `).all(namespace, iso(now));
}

export function isActiveRegistryFixtureUser(db, userId, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) return false;
  ensureStage1FixtureSchema(db);
  const row = db.prepare(`
    SELECT id FROM stage1_fixture_registry
    WHERE namespace = ?
      AND kind = ?
      AND row_id = ?
      AND cleaned_at IS NULL
      AND status = ?
      AND expires_at > ?
    LIMIT 1
  `).get(
    STAGE1_FIXTURE_NAMESPACE,
    STAGE1_FIXTURE_KIND.USER,
    uid,
    STAGE1_FIXTURE_STATUS.ACTIVE,
    iso(now),
  );
  return Boolean(row?.id);
}

export function authorizeFixtureMaturity(db, userId, now = new Date()) {
  if (!isActiveRegistryFixtureUser(db, userId, now)) {
    throw new Error("fixture maturity exception requires an active unexpired registry user");
  }
  return Object.freeze({
    [FIXTURE_MATURITY]: true,
    userId: Number(userId),
  });
}

export function authorizeFixtureIsolation(db, userId, {
  now = new Date(),
  namespace = STAGE1_FIXTURE_NAMESPACE,
  runId,
  kind,
  role,
  rowId,
} = {}) {
  if (!isActiveRegistryFixtureUser(db, userId, now)) {
    throw new Error("fixture isolation requires an active unexpired registry user");
  }
  const ns = String(namespace || "").trim();
  if (ns !== STAGE1_FIXTURE_NAMESPACE) {
    throw new Error("fixture isolation namespace is not authorized");
  }
  if (!runId || !kind || !role) throw new Error("fixture isolation requires run_id, kind and role");
  return Object.freeze({
    [FIXTURE_MATURITY]: true,
    [FIXTURE_ISOLATION]: true,
    userId: Number(userId),
    namespace: ns,
    runId: String(runId),
    kind: String(kind),
    role: String(role),
    rowId: Number(rowId) || 0,
  });
}

export function fixtureNamespaceFromIsolation(db, userId, now, isolation) {
  if (
    !isolation
    || typeof isolation !== "object"
    || isolation[FIXTURE_ISOLATION] !== true
    || Number(isolation.userId) !== Number(userId)
    || !isActiveRegistryFixtureUser(db, userId, now)
  ) {
    return "";
  }
  const ns = String(isolation.namespace || "").trim();
  return ns === STAGE1_FIXTURE_NAMESPACE ? ns : "";
}

export function isFixtureMaturityAuthorized(db, userId, now, maturity) {
  return Boolean(
    maturity
    && typeof maturity === "object"
    && maturity[FIXTURE_MATURITY] === true
    && Number(maturity.userId) === Number(userId)
    && isActiveRegistryFixtureUser(db, userId, now),
  );
}

export function stampFixtureNamespace(db, table, idColumn, rowId, namespace = STAGE1_FIXTURE_NAMESPACE) {
  ensureStage1FixtureSchema(db);
  const id = Number(rowId) || 0;
  if (!id) throw new Error("stampFixtureNamespace requires row id");
  if (table === "listings") {
    db.prepare("UPDATE listings SET fixture_namespace = ? WHERE post_id = ?").run(namespace, id);
    return;
  }
  if (table === "demand_posts") {
    db.prepare("UPDATE demand_posts SET fixture_namespace = ? WHERE id = ?").run(namespace, id);
    return;
  }
  void idColumn;
  throw new Error(`unsupported fixture table ${table}`);
}

export function markRegistryRowCleaned(db, registryId, now = new Date()) {
  ensureStage1FixtureSchema(db);
  db.prepare(`
    UPDATE stage1_fixture_registry
    SET cleaned_at = ?, status = ?
    WHERE id = ? AND cleaned_at IS NULL
  `).run(iso(now), STAGE1_FIXTURE_STATUS.CLEANED, Number(registryId) || 0);
}

export function markRegistryRowsCleaned(db, rows, now = new Date()) {
  for (const row of rows || []) {
    if (row?.id) markRegistryRowCleaned(db, row.id, now);
  }
}

export function registryRowIdentity(row) {
  return {
    registry_id: Number(row.id) || 0,
    namespace: String(row.namespace || ""),
    run_id: String(row.run_id || ""),
    kind: String(row.kind || ""),
    role: String(row.role || ""),
    row_id: Number(row.row_id) || 0,
  };
}

export function assertExactRegistryIdentity(row, expected) {
  if (
    Number(row.id) !== Number(expected.registry_id)
    || String(row.namespace) !== String(expected.namespace)
    || String(row.kind) !== String(expected.kind)
    || Number(row.row_id) !== Number(expected.row_id)
  ) {
    throw new Error("FIXTURE_CLEANUP_FAILED: registry identity mismatch; refusing wildcard cleanup");
  }
}

export function rowMatchesFixtureNamespace(row, namespace = STAGE1_FIXTURE_NAMESPACE) {
  return fixtureNamespaceOf(row) === String(namespace || "").trim();
}
