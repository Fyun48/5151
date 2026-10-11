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

export async function enqueueListingEvent(exec, { deps, listing, event, globalRows: loadedGlobalRows = null, requestContext: loadedRequestContext = null } = {}) {
  const context = deps || {};
  // notifyEnqueueBuildContext() carries the statement builders flat, the way notifyBuildContext() does.
  const queries = context;
  const run = (query) => exec(query.sql, query.params);
  const payload = context.notifyEventPayload(listing, event);
  const ids = [];

  // The `settings` rows feed both the member settings and the system-crawl block (db.js
  // getSettings()/getSystemCrawl() read the same table). **同一輪／同一批只讀一次**：
  // 爬蟲輪次這種「逐筆房源各入列一次事件」的路徑會把當輪讀到的列傳下來
  // （`options.globalRows`／`options.requestContext`），這裡就不再每一筆事件重讀一次。
  // 呼叫端沒帶（後台單筆動作、離線事件…）時逐字沿用原本的讀法 ⇒ 行為完全不變。
  const globalRows = Array.isArray(loadedGlobalRows) ? loadedGlobalRows : await run(queries.globalSettings());
  const system = context.systemCrawlFromRows(globalRows);
  // 同一輪的裝飾資料共用這一批列（不然 22 個會員＝22 條 `SELECT key, value FROM settings`）。
  const requestContext = loadedRequestContext || context.decorationRequestContextFromRows(globalRows);
  const userIds = (await run(queries.listUserIds()))
    .map((row) => Number(row.id) || 0)
    .filter(Boolean);

  // ── 去重讀取改成「一次抓整批會員」────────────────────────────────────────────
  // 原本每位會員各送 1~3 條 user_events 查詢（正式站 180 秒窗口 507 次
  // `SELECT detail FROM user_events WHERE user_id = $1 AND post_id = $2 AND type = $3 …`）。
  // 這裡在迴圈外先抓好，迴圈內只查表；**判斷函式與條件完全不變**
  //（同一個 user+post+type 已存在就不重複入列 ⇒ 仍由 notifyEnqueueDecision 決定）。
  // 為什麼不會漏 race window：逐筆版的讀取也只影響「同一個 user」的下一次讀取，
  // 而 userIds 不重複、每位會員在迴圈裡只讀一次、也只入列一次 ⇒ 先前插入的列
  // 不會被其他會員的去重查詢看到。跨行程的並行寫入窗口與改動前相同（讀→寫，
  // 只是把讀提前），護欄是 v3/test/notify-enqueue-parity.test.js。
  const groupId = await groupIdForPost(context, run, queries, payload.post_id);
  const dedupe = await loadDedupeRows(context, run, queries, { userIds, payload, groupId });

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
      requestContext,
    });
    const row = context.decorateRowsWithProvider([overlaid], {
      settings: scoped,
      userId,
      provider,
      sameHouse: false,
    })[0];

    const decision = context.notifyEnqueueDecision({
      event,
      payload,
      row,
      scoped,
      groupId,
      userEmail: (user && user.email) || "",
      mailConfigured: context.memberMailConfiguredFromRows(userRows),
      watchedInGroup: groupId ? (await run(queries.watchedInGroup(userId, groupId))).length > 0 : false,
      alreadyNotified: groupId ? dedupe.alreadyNotified.get(userId) === true : false,
      newExists: payload.type === "new"
        ? dedupe.newExists.has(userId)
        : null,
      lastDetail: dedupe.lastDetail.has(userId) ? dedupe.lastDetail.get(userId) : null,
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
// 逐字沿用原本的三個判斷，只是輸入改成「一次抓回來的整批列」（見 loadDedupeRows）。
function groupAlreadyNotifiedFromRows(context, rows, { onceEver, detail }) {
  return context.notifyGroupAlreadySent({
    onceEver,
    exists: rows[0] || null,
    details: rows,
    detail,
  });
}

// groupIdForPost(): 同一個 post_id 對整批會員是同一個答案，所以只讀一次（原本每位會員讀一次）。
async function groupIdForPost(context, run, queries, postId) {
  try {
    return String(((await run(queries.groupIdForPost(postId)))[0] || {}).group_id || "");
  } catch {
    return "";
  }
}

// 一次抓好整批會員的去重依據：
//   lastDetail    user_id → 最新一筆同 user+post+type 的 detail（＝逐筆版的 ORDER BY id DESC LIMIT 1）
//   newExists     「這個 user 在這個 post 已經有一筆 type='new'」的集合
//   alreadyNotified user_id → alreadyNotifiedGroup() 的答案（同一個群組去重條件）
async function loadDedupeRows(context, run, queries, { userIds, payload, groupId }) {
  const lastDetail = new Map();
  const newExists = new Set();
  const alreadyNotified = new Map();
  if (!userIds.length) return { lastDetail, newExists, alreadyNotified };

  const lastRows = await run(queries.lastEventDetailsBatch(userIds, payload.post_id, payload.type));
  for (const row of lastRows || []) {
    const userId = Number(row.user_id) || 0;
    // ORDER BY user_id, id DESC ⇒ 每個 user 的第一列就是逐筆版會拿到的那一列。
    if (!lastDetail.has(userId)) lastDetail.set(userId, row.detail);
  }

  if (payload.type === "new") {
    for (const row of (await run(queries.newEventUserIdsBatch(userIds, payload.post_id))) || []) {
      newExists.add(Number(row.user_id) || 0);
    }
  }

  if (groupId) {
    const onceEver = ONCE_EVER_GROUP_NOTIFY_TYPES.includes(String(payload.type || ""));
    const rowsByUser = new Map();
    for (const row of (await run(queries.groupNotifiedBatch(userIds, groupId, payload.type))) || []) {
      const userId = Number(row.user_id) || 0;
      const list = rowsByUser.get(userId) || (rowsByUser.set(userId, []), rowsByUser.get(userId));
      list.push(row);
    }
    for (const userId of userIds) {
      alreadyNotified.set(userId, groupAlreadyNotifiedFromRows(context, rowsByUser.get(userId) || [], {
        onceEver,
        detail: payload.detail,
      }));
    }
  }
  return { lastDetail, newExists, alreadyNotified };
}