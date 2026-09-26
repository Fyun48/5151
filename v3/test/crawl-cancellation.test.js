import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { guardCrawlSqlite, crawlRequestSignal } from "../src/crawlExecution.js";
import { withBudget, createTickGate } from "../src/crawlWatchdog.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test("late crawler continuation cannot use a cached SQLite statement; unrelated work remains usable", async () => {
  const db = guardCrawlSqlite(new DatabaseSync(":memory:"));
  db.exec("CREATE TABLE writes (value TEXT)");
  const insert = db.prepare("INSERT INTO writes VALUES (?)");
  const resumed = deferred(), parent = new AbortController();
  const reason = new Error("old crawl cancelled");
  let continuation;
  const pending = withBudget(() => continuation = (async () => {
    await resumed.promise;
    insert.run("stale");
  })(), 5000, "crawl", { signal: parent.signal });
  parent.abort(reason);
  await assert.rejects(pending, error => error === reason);
  const stopped = assert.rejects(continuation, error => error === reason);
  resumed.resolve();
  await stopped;
  insert.run("independent");
  assert.deepEqual(db.prepare("SELECT value FROM writes").all().map(r => r.value), ["independent"]);
  db.close();
});

test("SQLite iterators obtained before cancellation cannot execute their next step", async () => {
  const db = guardCrawlSqlite(new DatabaseSync(":memory:"));
  db.exec("CREATE TABLE writes (value TEXT)");
  const parent = new AbortController();
  await assert.rejects(withBudget(() => {
    const iterator = db.prepare("INSERT INTO writes VALUES ('late') RETURNING value").iterate();
    parent.abort(new Error("cancel iterator"));
    try { iterator.next(); } finally { iterator.return(); }
  }, 5000, "crawl", { signal: parent.signal }), /cancel iterator/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM writes").get().n, 0);
  db.close();
});

test("SQLite transaction can roll back after cancellation but cannot commit", async () => {
  const db = guardCrawlSqlite(new DatabaseSync(":memory:"));
  db.exec("CREATE TABLE writes (value TEXT)");
  const parent = new AbortController();
  await assert.rejects(withBudget(async () => {
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO writes VALUES (?)").run("rolled back");
      parent.abort(new Error("cancel before commit"));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }, 5000, "crawl", { signal: parent.signal }), /cancel before commit/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM writes").get().n, 0);
  db.close();
});

test("crawl deadline cancels network signals, including a delayed timer, and gate supersession aborts the old generation", async () => {
  let request;
  await assert.rejects(withBudget(async () => {
    request = crawlRequestSignal(AbortSignal.timeout(5000));
    await new Promise((resolve, reject) => request.addEventListener("abort", () => reject(request.reason), { once: true }));
  }, 25), { code: "TIMEOUT" });
  assert.equal(request.aborted, true);
  const db = guardCrawlSqlite(new DatabaseSync(":memory:"));
  db.exec("CREATE TABLE writes (value TEXT)");
  await assert.rejects(withBudget(() => {
    const until = Date.now() + 20;
    while (Date.now() < until) { /* intentionally delay the timer */ }
    db.exec("INSERT INTO writes VALUES ('late')");
  }, 5), { code: "TIMEOUT" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM writes").get().n, 0);
  db.close();
  const gate = createTickGate();
  const first = gate.begin(), signal = gate.signal(first);
  const second = gate.begin();
  assert.equal(signal.aborted, true);
  gate.end(first);
  assert.equal(gate.isBusy(), true);
  gate.abandon();
  assert.equal(gate.signal(second).aborted, true);
});

test("PG crawler statement rolls back after in-flight cancellation; no cancelled COMMIT or next query is dispatched", async () => {
  const entered = deferred(), response = deferred(), finished = deferred();
  const calls = [];
  const parent = new AbortController();
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "INSERT INTO writes VALUES (1)") { entered.resolve(); await response.promise; }
      return { rows: [] };
    },
    release() { calls.push("release"); finished.resolve(); },
  };
  class Pool {
    on() {}
    async connect() { return client; }
    async query(sql) { calls.push(`pool:${sql}`); return { rows: [] }; }
    async end() {}
  }
  const driver = await createPostgresDriver({ env: {}, importPg: async () => ({ Pool }) });
  let work;
  const pending = withBudget(() => work = driver.query("INSERT INTO writes VALUES (1)"), 5000, "crawl", { signal: parent.signal });
  await entered.promise;
  parent.abort(new Error("cancel in flight"));
  await assert.rejects(pending, /cancel in flight/);
  const stopped = assert.rejects(work, /cancel in flight/);
  response.resolve();
  await stopped;
  await finished.promise;
  assert.deepEqual(calls, ["BEGIN", "INSERT INTO writes VALUES (1)", "ROLLBACK", "release"]);
  await driver.query("SELECT 1");
  assert.equal(calls.at(-1), "pool:SELECT 1", "ordinary requests retain the existing path");
  await driver.close();
});

test("real PG rolls back crawler writes when its deadline expires during SQL", { skip: !process.env.PG_TEST_URL }, async () => {
  const driver = await createPostgresDriver({ connectionString: process.env.PG_TEST_URL, poolOptions: { max: 1 } });
  try {
    await driver.query("CREATE TEMP TABLE crawl_abort_fixture (value INTEGER)");
    const entered = deferred();
    const parent = new AbortController();
    const pending = withBudget(() => driver.withTransaction(async client => {
      await client.query("INSERT INTO crawl_abort_fixture VALUES (1)");
      entered.resolve();
      await client.query("SELECT pg_sleep(0.1)");
    }), 5000, "crawl", { signal: parent.signal });
    await entered.promise;
    parent.abort(new Error("cancel SQL"));
    await assert.rejects(pending, /cancel SQL/);
    // max=1 makes this wait for the old transaction's rollback/release.
    const rows = await driver.query("SELECT COUNT(*)::int AS n FROM crawl_abort_fixture");
    assert.equal(rows.rows[0].n, 0);
  } finally {
    await driver.close();
  }
});
