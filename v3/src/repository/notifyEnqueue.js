// The notification enqueue's reads and writes (PostgreSQL side).
//
// enqueueListingEvent() decides what enters `user_events` and writes it - all synchronous SQLite. With
// DB_DRIVER=postgres the site reads PostgreSQL, so the watcher's event sites and the detail backfill's
// fee change would fill the queue in the store nobody reads. This module resolves the same inputs from
// PostgreSQL and then runs the identical reasoning (deps.notifyEnqueueDecision) over the identical
// statement text (the builders notifyEnqueueBuildContext() carries flat, mirroring the helpers db.js
// calls on SQLite).
//
// Per member the decision needs: their settings (global rows + user_settings + role/plan), their active
// search profile, their flags, the listing group of the post, and three dedupe reads on user_events.
// The decorated row comes from the same decoration plumbing the list page uses
// (preloadDecorationProviderAsync + decorateRowsWithProvider with sameHouse: false), so a member's scope
// is applied the way db.js applies it.
//
// Known, deliberate difference: db.js notifyJobSnapshotFor() answers from an in-process snapshot that
// watcher.bindNotifyJobSnapshots() fills from SQLite when a crawl run starts. That memo is SQLite
// state, so this module reads the active profile row instead of the frozen snapshot.
//
// NOT here: the flush loop's side of the queue (repository/notifyQueue.js), and the similarity queue
// (POSTGRES_SWITCH_PLAN ④).
import { ONCE_EVER_GROUP_NOTIFY_TYPES } from "../listingGroups.js";

export async function enqueueListingEvent(exec, { deps, listing, event } = {}) {
  const context = deps || {};
  // notifyEnqueueBuildContext() carries the statement builders flat, the way notifyBuildContext() does.
  const queries = context;
  const run = (query) => exec(query.sql, query.params);
  const payload = context.notifyEventPayload(listing, event);
  const ids = [];

  // The `settings` rows are read once per event: the member settings and the system-crawl block both
  // come from them (db.js getSettings()/getSystemCrawl() read the same table).
  const globalRows = await run(queries.globalSettings());
  const system = context.systemCrawlFromRows(globalRows);
  const userIds = (await run(queries.listUserIds()))
    .map((row) => Number(row.id) || 0)
    .filter(Boolean);

  for (const userId of userIds) {
    const userRows = await run(queries.userSettings(userId));
    const user = (await run(queries.userById(userId)))[0] || null;
    const settings = context.settingsFromRows({ globalRows, userRows, user, system });
    const snap = await activeProfileSnapshot(context, run, queries, userId);
    const scoped = snap.data && Object.keys(snap.data).length
      ? { ...settings, ...snap.data }
      : settings;
    const flags = (await run(queries.userFlags(userId, listing.post_id)))[0] || null;
    const overlaid = context.overlayPersonal(listing, flags);
    const provider = await context.preloadDecorationProviderAsync({
      exec,
      rows: [overlaid],
      settings: scoped,
      userId,
      sameHouse: false,
    });
    const row = context.decorateRowsWithProvider([overlaid], {
      settings: scoped,
      userId,
      provider,
      sameHouse: false,
    })[0];

    let groupId = "";
    try {
      groupId = String(((await run(queries.groupIdForPost(payload.post_id)))[0] || {}).group_id || "");
    } catch {
      groupId = "";
    }
    const lastRows = await run(queries.lastEventDetail(userId, payload.post_id, payload.type));
    const decision = context.notifyEnqueueDecision({
      event,
      payload,
      row,
      scoped,
      groupId,
      userEmail: (user && user.email) || "",
      mailConfigured: context.memberMailConfiguredFromRows(userRows),
      watchedInGroup: groupId ? (await run(queries.watchedInGroup(userId, groupId))).length > 0 : false,
      alreadyNotified: groupId
        ? await groupAlreadyNotified(context, run, queries, userId, groupId, payload)
        : false,
      newExists: payload.type === "new"
        ? (await run(queries.newEventExists(userId, payload.post_id))).length > 0
        : null,
      lastDetail: lastRows.length ? lastRows[0].detail : null,
    });
    if (!decision.enqueue) continue;

    const values = context.notifyEventRow(payload, { userId, groupId, snap });
    const inserted = await run(queries.insertUserEvent(values, { returning: true }));
    const id = Number((inserted[0] || {}).id) || 0;
    if (values.group_id || values.notify_profile_id) {
      try {
        await run(queries.eventProfileStatement(values, id));
      } catch {
        // older fixtures without the profile columns - addUserEvent() swallows the same failure
      }
    }
    ids.push(id);
  }
  return ids;
}

// getActiveSearchProfile(): repair the extra active rows first (the same two statements), then read.
async function activeProfileSnapshot(context, run, queries, userId) {
  let row = null;
  try {
    const ordered = await run(queries.activeProfileOrder(userId));
    if (ordered.length > 1) {
      await run(queries.deactivateProfiles(userId, ordered[0].id, new Date().toISOString()));
    }
    row = (await run(queries.activeProfile(userId)))[0] || null;
  } catch {
    row = null;
  }
  return context.notifySnapshotFromProfile(row);
}

// alreadyNotifiedGroup(): "new" is once-ever, everything else dedupes on the normalised detail.
async function groupAlreadyNotified(context, run, queries, userId, groupId, payload) {
  const onceEver = ONCE_EVER_GROUP_NOTIFY_TYPES.includes(String(payload.type || ""));
  const rows = await run(onceEver
    ? queries.groupNotifiedExists(userId, groupId, payload.type)
    : queries.groupNotifiedDetails(userId, groupId, payload.type));
  return context.notifyGroupAlreadySent({
    onceEver,
    exists: rows[0] || null,
    details: rows,
    detail: payload.detail,
  });
}