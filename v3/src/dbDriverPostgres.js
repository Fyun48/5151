// PostgreSQL driver adapter (PostgreSQL hot path).
//
// Asynchronous, unlike the SQLite path: node-postgres (`pg`) has no synchronous
// interface, so every PostgreSQL consumer must await. The driver exposes a small
// surface (query / queryOne / exec / withTransaction / healthCheck / close) so a
// repository can be written once and run on either driver.
//
// Configuration precedence (first hit wins):
//   1. explicit `connectionString` argument
//   2. env.PG_URL | env.DATABASE_URL | env.POSTGRES_URL
//   3. env.PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE (read by `pg`)
// Values are never logged; `describeConnection()` redacts credentials.
import { toPostgresSql } from "./sqlDialect.js";
import { createCandidateContentStore } from "./pgCandidateContent.js";
import { currentCrawlOwner } from "./crawlOwnership.js";
import { currentCrawlExecution, isCrawlRollback, throwIfCrawlCancelled } from "./crawlExecution.js";

export const POSTGRES_APPLICATION_NAME = "5151-v3";

const URL_KEYS = ["PG_URL", "DATABASE_URL", "POSTGRES_URL"];
const HOST_KEYS = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"];

function intFromEnv(env, key, fallback) {
  const raw = Number(env?.[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// Resolves the pool configuration from the environment without connecting.
export function resolvePostgresConfig(env = process.env) {
  const explicit = env?.PG_URL || env?.DATABASE_URL || env?.POSTGRES_URL || "";
  const usesHostVars = HOST_KEYS.some((key) => env?.[key]);
  const connectionString = String(explicit || "").trim();
  const source = explicit ? URL_KEYS.find((key) => env[key]) : usesHostVars ? "PG*" : "none";
  const options = {
    max: intFromEnv(env, "PG_POOL_MAX", 10),
    idleTimeoutMillis: intFromEnv(env, "PG_POOL_IDLE_MS", 10_000),
    connectionTimeoutMillis: intFromEnv(env, "PG_CONNECT_TIMEOUT_MS", 5_000),
    statement_timeout: intFromEnv(env, "PG_STATEMENT_TIMEOUT_MS", 15_000),
    application_name: String(env?.PG_APPLICATION_NAME || POSTGRES_APPLICATION_NAME),
  };
  // libpq/pg read PGHOST/PGPORT/... themselves, so only the non-standard pool
  // knobs are passed explicitly.
  return { connectionString, source, options, usesHostVars };
}

// Redacted description for logs/diagnostics — never the password.
export function describeConnection(connectionString, options = {}) {
  if (!connectionString) {
    return { via: "env", application_name: options.application_name, max: options.max };
  }
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: url.port || "5432",
      database: url.pathname.replace(/^\//, ""),
      user: decodeURIComponent(url.username || ""),
      application_name: options.application_name,
      max: options.max,
    };
  } catch {
    return { via: "connection_string", application_name: options.application_name, max: options.max };
  }
}

// node-postgres returns BIGINT (int8) as a string to avoid precision loss. The
// SQLite path returns numbers, so repositories normalise through this helper to
// keep the two drivers comparable.
export function numberFromPg(value) {
  if (value == null) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

// BIGINT is OID 20 in PostgreSQL (every SQLite `INTEGER` column is mirrored as BIGINT).
export const PG_BIGINT_OID = 20;

// `pg` hands int8 back as a string, `node:sqlite` hands INTEGER back as a number. Every consumer
// in this app was written against the SQLite semantics, so a row read from PostgreSQL used to
// carry `post_id: "900001"`, `offline: "0"`, `community_id: "0"`, `price_num: "25000"` ... and
// the decorated card (or any `===` comparison, object key or arithmetic over it) differed between
// drivers. /api/state page parity surfaced it: v3/test/listing-stats-parity.test.js.
// Parsing int8 back to a number gives both drivers one semantics. Safe here: ids are ~1e9 and
// epoch milliseconds ~1.7e12, far below Number.MAX_SAFE_INTEGER (9.007e15). NUMERIC/DECIMAL
// columns (OID 1700) stay strings - the schema mirror maps SQLite REAL to DOUBLE PRECISION, so it
// has none, and a future one would need its own decision.
export function applySqliteNumberSemantics(pg) {
  if (!pg?.types?.setTypeParser) return false;
  pg.types.setTypeParser(PG_BIGINT_OID, (value) => (value == null ? null : Number(value)));
  return true;
}

export async function loadPgModule() {
  try {
    return await import("pg");
  } catch {
    throw new Error("pg package is not installed; run `npm install pg` to enable DB_DRIVER=postgres");
  }
}

export async function createPostgresDriver({
  connectionString,
  env = process.env,
  poolOptions = {},
  importPg = loadPgModule,
} = {}) {
  const pg = await importPg();
  // One numeric semantics for both drivers (BIGINT as a number, like node:sqlite); see
  // applySqliteNumberSemantics() for why the SQLite semantics is the one that has to win.
  applySqliteNumberSemantics(pg);
  const resolved = resolvePostgresConfig(env);
  const options = { ...resolved.options, ...poolOptions };
  const target = String(connectionString || resolved.connectionString || "").trim();
  const pool = new pg.Pool({ ...(target ? { connectionString: target } : {}), ...options });
  const candidateContent = createCandidateContentStore();

  // A pool-level error (server restart, network drop) must not crash the process
  // the way an unhandled EventEmitter "error" would.
  const poolErrors = [];
  pool.on("error", (err) => {
    candidateContent.clear();
    poolErrors.push({ message: err?.message || String(err), at: new Date().toISOString() });
    if (poolErrors.length > 20) poolErrors.shift();
  });

  function assertCrawlerActive() {
    throwIfCrawlCancelled();
    currentCrawlOwner()?.assertActive();
  }

  async function transact(fn) {
    assertCrawlerActive();
    const owner = currentCrawlOwner();
    if (owner) {
      if (owner.pool !== pool) throw new Error("Crawler cannot write through a different PostgreSQL pool");
      return owner.transact(client => transactOn(client, fn, false));
    }
    return transactOn(await pool.connect(), fn, true);
  }

  async function transactOn(client, fn, release) {
    try {
      assertCrawlerActive();
      await client.query("BEGIN");
      const guarded = (currentCrawlExecution() || currentCrawlOwner()) ? new Proxy(client, {
        get(target, key) {
          if (key === "query") return async (sql, ...args) => {
            const rollback = isCrawlRollback(typeof sql === "string" ? sql : sql?.text);
            if (!rollback) assertCrawlerActive();
            const result = await target.query(sql, ...args);
            if (!rollback) assertCrawlerActive();
            return result;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) : client;
      const result = await fn(guarded);
      assertCrawlerActive();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original error */ }
      throw err;
    } finally {
      if (release) client.release();
    }
  }

  async function query(text, params = []) {
    // Only crawler-scoped calls need the extra transaction. An in-flight
    // statement can finish after abort, but must roll back before COMMIT.
    // A COMMIT already submitted before abort cannot be retroactively undone.
    if (currentCrawlExecution() || currentCrawlOwner()) return transact(client => client.query(text, params));
    return pool.query(text, params);
  }

  return {
    dialect: "postgres",
    kind: "postgres",
    pool,
    candidateContent,
    config: {
      // Never expose the raw connection string: it carries the password and this
      // object ends up in logs / diagnostics / error reports.
      ...describeConnection(target, options),
      pool: options,
      source: resolved.source,
      hasConnectionString: Boolean(target),
    },
    poolErrors,
    async query(text, params = []) {
      return query(text, params);
    },
    async queryOne(text, params = []) {
      const res = await query(text, params);
      return res.rows[0] ?? null;
    },
    async exec(sql) {
      await query(sql);
    },
    async withTransaction(fn) {
      return transact(fn);
    },
    async healthCheck() {
      const res = await pool.query("SELECT 1 AS ok, pg_is_in_recovery() AS in_recovery");
      return { ok: Number(res.rows[0]?.ok) === 1, inRecovery: res.rows[0]?.in_recovery === true };
    },
    // Convenience for callers holding SQLite-flavoured SQL: translate then run.
    async runSqliteSql(text, params = []) {
      return query(toPostgresSql(text), params);
    },
    async close() {
      candidateContent.clear();
      await pool.end();
    },
  };
}
