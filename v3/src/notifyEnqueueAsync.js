// Driver-aware notification enqueue (the events that fill the queue).
//
// enqueueListingEvent() decides which members get an event and writes their `user_events` rows. It is
// synchronous SQLite, so with DB_DRIVER=postgres the watcher's event sites and the detail backfill's fee
// change filled a queue the site never reads - the shipper would then read an empty PostgreSQL queue.
// This module gives those call sites one async entry point:
//
//   • sqlite   - the existing db.js function, unchanged (production default)
//   • postgres - repository/notifyEnqueue.js over the shared pool, with the decision, the settings
//                assembly and the statement text coming from notifyEnqueueBuildContext()
//
// Fail-open: a PostgreSQL failure falls back to the SQLite call, exactly like crawlerWrites.js, so a
// hiccup cannot stop an event from being recorded; `options.strict` turns that off for tests and probes.
//
// The flush loop's side of the queue lives in notifyQueueAsync.js (POSTGRES_SWITCH_PLAN ③, first half);
// the similarity queue (④) is still SQLite-only.
import { enqueueListingEvent as enqueueListingEventSync, notifyEnqueueBuildContext } from "./db.js";
import { enqueueListingEvent as enqueueListingEventRepo } from "./repository/notifyEnqueue.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sharedPgDriver } from "./pgSharedDriver.js";

async function postgresExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

async function withFallback(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    const exec = await postgresExec(options);
    const deps = options.deps || notifyEnqueueBuildContext();
    return await runPostgres(exec, deps);
  } catch (error) {
    if (options.strict) throw error;
    return runSqlite();
  }
}

// db.js enqueueListingEvent(): the ids of the rows the enqueue wrote.
export function enqueueListingEventAsync(listing, event, options = {}) {
  return withFallback(
    options,
    (exec, deps) => enqueueListingEventRepo(exec, { deps, listing, event }),
    () => enqueueListingEventSync(listing, event),
  );
}

// Exposed for tests/diagnostics: the bundle the PostgreSQL enqueue resolves its inputs with.
export function notifyEnqueueContext() {
  return notifyEnqueueBuildContext();
}