import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPostgresDriver,
  describeConnection,
  numberFromPg,
  resolvePostgresConfig,
} from "../src/dbDriverPostgres.js";

// A stand-in for `pg` so the adapter's wiring (pool options, transactions,
// health check, close, pool-level error capture) is tested without a server.
class FakePool {
  constructor(config) {
    this.config = config;
    this.handlers = {};
    this.queries = [];
    this.clients = [];
    this.ended = false;
  }
  on(event, handler) {
    this.handlers[event] = handler;
    return this;
  }
  async query(text, params) {
    this.queries.push({ text, params, via: "pool" });
    if (/pg_is_in_recovery/.test(text)) return { rows: [{ ok: 1, in_recovery: true }], rowCount: 1 };
    return { rows: [{ ok: 1 }], rowCount: 1 };
  }
  async connect() {
    const pool = this;
    const client = {
      released: false,
      async query(text, params) {
        pool.queries.push({ text, params, via: "client" });
        return { rows: [], rowCount: 0 };
      },
      release() {
        client.released = true;
      },
    };
    this.clients.push(client);
    return client;
  }
  async end() {
    this.ended = true;
  }
}

const fakePg = { Pool: FakePool };
const importPg = async () => fakePg;

test("resolvePostgresConfig prefers the URL env over PG* variables", () => {
  const fromUrl = resolvePostgresConfig({ PG_URL: "postgres://u:p@h:5433/db", PGHOST: "ignored" });
  assert.equal(fromUrl.source, "PG_URL");
  assert.equal(fromUrl.connectionString, "postgres://u:p@h:5433/db");
  const fromVars = resolvePostgresConfig({ PGHOST: "192.168.0.220", PGPORT: "15432" });
  assert.equal(fromVars.source, "PG*");
  assert.equal(fromVars.connectionString, "");
  assert.equal(resolvePostgresConfig({}).source, "none");
});

test("pool options come from the environment with sane defaults", () => {
  const defaults = resolvePostgresConfig({}).options;
  assert.equal(defaults.max, 10);
  assert.equal(defaults.statement_timeout, 15_000);
  assert.equal(defaults.application_name, "5151-v3");
  const tuned = resolvePostgresConfig({
    PG_POOL_MAX: "25",
    PG_STATEMENT_TIMEOUT_MS: "2500",
    PG_APPLICATION_NAME: "5151-worker",
  }).options;
  assert.equal(tuned.max, 25);
  assert.equal(tuned.statement_timeout, 2500);
  assert.equal(tuned.application_name, "5151-worker");
  // Garbage/zero values fall back instead of disabling the guard.
  assert.equal(resolvePostgresConfig({ PG_POOL_MAX: "0" }).options.max, 10);
  assert.equal(resolvePostgresConfig({ PG_POOL_MAX: "abc" }).options.max, 10);
});

test("describeConnection never leaks the password", () => {
  const described = describeConnection("postgres://replicator:sup3rsecret@192.168.0.220:15432/5151_shadow", { max: 5 });
  assert.equal(described.host, "192.168.0.220");
  assert.equal(described.port, "15432");
  assert.equal(described.database, "5151_shadow");
  assert.equal(described.user, "replicator");
  assert.ok(!JSON.stringify(described).includes("sup3rsecret"));
});

test("numberFromPg normalises the BIGINT-as-string the driver returns", () => {
  assert.equal(numberFromPg("42"), 42);
  assert.equal(numberFromPg(42), 42);
  assert.equal(numberFromPg(null), null);
});

test("createPostgresDriver wires query/exec/healthCheck/close", async () => {
  const driver = await createPostgresDriver({
    connectionString: "postgres://u:p@127.0.0.1:5432/db",
    env: {},
    importPg,
  });
  assert.equal(driver.dialect, "postgres");
  assert.equal(driver.pool.config.application_name, "5151-v3");
  await driver.exec("CREATE TABLE t (id BIGINT)");
  const res = await driver.query("SELECT 1 AS ok");
  assert.equal(res.rows[0].ok, 1);
  assert.deepEqual(await driver.queryOne("SELECT 1 AS ok"), res.rows[0]);
  const health = await driver.healthCheck();
  assert.deepEqual(health, { ok: true, inRecovery: true });
  await driver.close();
  assert.equal(driver.pool.ended, true);
});

test("withTransaction commits, and rolls back + rethrows on failure", async () => {
  const driver = await createPostgresDriver({ connectionString: "postgres://u:p@h/db", env: {}, importPg });
  const ok = await driver.withTransaction(async (client) => {
    await client.query("UPDATE t SET a = 1");
    return "done";
  });
  assert.equal(ok, "done");
  assert.deepEqual(
    driver.pool.queries.map((q) => q.text),
    ["BEGIN", "UPDATE t SET a = 1", "COMMIT"],
  );
  assert.equal(driver.pool.clients[0].released, true);

  await assert.rejects(
    () =>
      driver.withTransaction(async () => {
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.deepEqual(
    driver.pool.queries.map((q) => q.text),
    ["BEGIN", "UPDATE t SET a = 1", "COMMIT", "BEGIN", "ROLLBACK"],
  );
  assert.equal(driver.pool.clients[1].released, true);
  await driver.close();
});

test("pool-level errors are captured instead of crashing the process", async () => {
  const driver = await createPostgresDriver({ connectionString: "postgres://u:p@h/db", env: {}, importPg });
  driver.pool.handlers.error(new Error("server closed the connection unexpectedly"));
  assert.equal(driver.poolErrors.length, 1);
  assert.match(driver.poolErrors[0].message, /server closed the connection/);
  await driver.close();
});

test("runSqliteSql translates SQLite SQL before sending it", async () => {
  const driver = await createPostgresDriver({ connectionString: "postgres://u:p@h/db", env: {}, importPg });
  await driver.runSqliteSql("SELECT IFNULL(a, 0) FROM t WHERE b = ?", [7]);
  const sent = driver.pool.queries.at(-1);
  assert.equal(sent.text, "SELECT COALESCE(a, 0) FROM t WHERE b = $1");
  assert.deepEqual(sent.params, [7]);
  await driver.close();
});
