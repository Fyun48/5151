// The notification queue's reads and writes (PostgreSQL side).
//
// Problem: watcher's flush loop drains `user_events` - it reads the pending page with
// db.js pendingNotifyEvents() and writes every channel outcome back with updateEventNotify() /
// markEventNotified(). Both were synchronous SQLite statements, so with DB_DRIVER=postgres the loop
// would find an empty queue (the events the site reads live in PostgreSQL) and, when it did find
// something, write the outcome to the wrong store.
//
// Driver behaviour:
//   • sqlite   - unchanged: db.js runs the same statements against its handle.
//   • postgres - this module runs them through the injected exec. The two fallbacks of the SQLite
//                functions are kept: the legacy pending page when the ordering statement does not
//                prepare, and `notified = 1` when the wide update does not apply.
//
// NOT here (POSTGRES_SWITCH_PLAN ③): enqueueListingEvent()'s decision chain still reads SQLite
// (users / settings / search profiles / listing groups), so a PostgreSQL deployment drains the queue
// but does not yet fill it.
export async function selectPendingEvents(exec, { deps, limit = 80, now } = {}) {
  const context = deps || {};
  const wide = context.pendingNotifyEventsQuery({ limit, now });
  try {
    return await exec(wide.sql, wide.params);
  } catch {
    const legacy = context.pendingNotifyEventsLegacyQuery({ limit });
    return exec(legacy.sql, legacy.params);
  }
}

export async function updateEventNotify(exec, { deps, id, patch = {} } = {}) {
  const context = deps || {};
  const rowQuery = context.eventNotifyRowQuery(id);
  const rows = await exec(rowQuery.sql, rowQuery.params);
  const row = (rows || [])[0];
  if (!row) return null;
  const statement = context.updateEventNotifyStatement({ ...row }, patch, id);
  try {
    await exec(statement.sql, statement.params);
  } catch (error) {
    if (!statement.fallbackToNotified) throw error;
    const fallback = context.markEventNotifiedQuery(id);
    await exec(fallback.sql, fallback.params);
  }
  return { ...statement.row, id: Number(id) };
}

export async function markEventNotified(exec, { deps, id } = {}) {
  const query = (deps || {}).markEventNotifiedQuery(id);
  await exec(query.sql, query.params);
  return { id: Number(id) || 0, notified: 1 };
}
