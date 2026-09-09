import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  alreadyNotifiedGroup,
  bindListingsToGroup,
  bindWatchToGroup,
  collapseGroupSources,
  ensureListingGroupSchema,
  groupIdForPost,
  pickCanonicalGroupId,
  refreshGroupPrimary,
  watchedInGroup,
} from "../src/listingGroups.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      title TEXT,
      url TEXT,
      price TEXT,
      price_num INTEGER,
      extra_fee INTEGER DEFAULT 0,
      extra_fees TEXT,
      source TEXT,
      refresh_time TEXT,
      last_seen_at TEXT
    );
    CREATE TABLE user_listing_flags (
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      watched INTEGER NOT NULL DEFAULT 0,
      watch_group_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (user_id, post_id)
    );
    CREATE TABLE user_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      post_id INTEGER,
      type TEXT,
      detail TEXT NOT NULL DEFAULT '',
      group_id TEXT NOT NULL DEFAULT '',
      notify_profile_id TEXT NOT NULL DEFAULT '',
      notify_profile_version INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureListingGroupSchema(db);
  return db;
}

function insert(db, row) {
  db.prepare(`
    INSERT INTO listings(post_id, title, url, price, price_num, extra_fee, extra_fees, source, refresh_time, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 0, '[]', ?, ?, ?)
  `).run(row.post_id, row.title, row.url, String(row.price_num), row.price_num, row.source, row.refresh_time || "", row.last_seen_at || "");
}

test("bind listings keep a stable group id after primary switches", () => {
  const db = open();
  const a = { post_id: 1, title: "591 低價", url: "https://591/1", price_num: 18000, source: "591", refresh_time: "3天前" };
  const b = { post_id: 2, title: "住商 高價", url: "https://hb/2", price_num: 22000, source: "hbhousing", refresh_time: "剛剛" };
  insert(db, a);
  insert(db, b);
  const gid = bindListingsToGroup(db, [a, b], { evidence: { signals: ["address"] }, confidence: 0.9 });
  assert.match(gid, /^lg_/);
  assert.equal(groupIdForPost(db, 1), gid);
  assert.equal(groupIdForPost(db, 2), gid);
  const primary = refreshGroupPrimary(db, gid);
  assert.equal(Number(primary.post_id), 1);
  db.prepare("UPDATE listings SET price_num = 16000 WHERE post_id = 2").run();
  const next = refreshGroupPrimary(db, gid);
  assert.equal(Number(next.post_id), 2);
  assert.equal(groupIdForPost(db, 1), gid);
  db.close();
});

test("watch stays on group id when primary listing changes", () => {
  const db = open();
  const rows = [
    { post_id: 11, title: "A", url: "https://a", price_num: 20000, source: "591" },
    { post_id: 12, title: "B", url: "https://b", price_num: 21000, source: "sinyi" },
  ];
  rows.forEach((row) => insert(db, row));
  const gid = bindListingsToGroup(db, rows, { confidence: 0.88 });
  db.prepare("INSERT INTO user_listing_flags(user_id, post_id, watched) VALUES (7, 11, 1)").run();
  assert.equal(bindWatchToGroup(db, 7, 11), gid);
  assert.equal(watchedInGroup(db, 7, gid), true);
  db.prepare("UPDATE listings SET price_num = 15000 WHERE post_id = 12").run();
  refreshGroupPrimary(db, gid);
  assert.equal(watchedInGroup(db, 7, gid), true);
  db.close();
});

test("collapse shows three sources and folds the rest", () => {
  const members = [
    { post_id: 1, title: "一", source: "591", source_label: "591", url: "u1", price_num: 10000 },
    { post_id: 2, title: "二", source: "sinyi", source_label: "信義", url: "u2", price_num: 11000 },
    { post_id: 3, title: "三", source: "houseprice", source_label: "5168", url: "u3", price_num: 12000 },
    { post_id: 4, title: "四", source: "housefun", source_label: "好房網", url: "u4", price_num: 13000 },
    { post_id: 5, title: "五", source: "rakuya", source_label: "樂屋網", url: "u5", price_num: 14000 },
  ];
  const fold = collapseGroupSources(members);
  assert.equal(fold.visible.length, 3);
  assert.equal(fold.hidden_count, 2);
  assert.match(fold.fold_label, /另有 2 筆同物件來源/);
  assert.deepEqual(fold.collapsed.map((row) => row.title), ["四", "五"]);
  assert.ok(fold.collapsed.every((row) => row.url && row.source));
});

test("group notify is recorded once per type", () => {
  const db = open();
  db.prepare("INSERT INTO user_events(user_id, post_id, type, group_id) VALUES (1, 11, 'new', 'lg_x')").run();
  assert.equal(alreadyNotifiedGroup(db, 1, "lg_x", "new"), true);
  assert.equal(alreadyNotifiedGroup(db, 1, "lg_x", "price_drop", "20000 → 19000"), false);
  assert.equal(alreadyNotifiedGroup(db, 2, "lg_x", "new"), false);
  db.close();
});

test("merging groups migrates active watches to the deterministic canonical id", () => {
  const db = open();
  const early = [
    { post_id: 21, title: "A1", url: "https://a1", price_num: 20000, source: "591" },
    { post_id: 22, title: "A2", url: "https://a2", price_num: 21000, source: "sinyi" },
  ];
  const late = [
    { post_id: 31, title: "B1", url: "https://b1", price_num: 20500, source: "housefun" },
    { post_id: 32, title: "B2", url: "https://b2", price_num: 21500, source: "rakuya" },
  ];
  early.forEach((row) => insert(db, row));
  late.forEach((row) => insert(db, row));
  const groupA = bindListingsToGroup(db, early, { now: "2026-01-01T00:00:00.000Z" });
  const groupB = bindListingsToGroup(db, late, { now: "2026-06-01T00:00:00.000Z" });
  assert.notEqual(groupA, groupB);
  assert.equal(pickCanonicalGroupId(db, [groupB, groupA]), groupA);

  db.prepare("INSERT INTO user_listing_flags(user_id, post_id, watched, watch_group_id) VALUES (9, 31, 1, ?)").run(groupB);
  db.prepare("INSERT INTO user_listing_flags(user_id, post_id, watched, watch_group_id) VALUES (9, 21, 0, ?)").run(groupA);
  db.prepare("INSERT INTO user_listing_flags(user_id, post_id, watched, watch_group_id) VALUES (9, 32, 0, ?)").run(groupB);
  db.prepare("INSERT INTO user_events(user_id, post_id, type, detail, group_id) VALUES (9, 31, 'price_drop', '21000 → 20500', ?)").run(groupB);

  const mergedFirst = bindListingsToGroup(db, [late[0], early[0]], { now: "2026-09-01T00:00:00.000Z" });
  const mergedAgain = bindListingsToGroup(db, [early[1], late[1]], { now: "2026-09-02T00:00:00.000Z" });
  assert.equal(mergedFirst, groupA);
  assert.equal(mergedAgain, groupA);
  assert.equal(groupIdForPost(db, 31), groupA);
  assert.equal(groupIdForPost(db, 32), groupA);
  assert.equal(watchedInGroup(db, 9, groupA), true);
  assert.equal(watchedInGroup(db, 9, groupB), false);
  assert.equal(
    db.prepare("SELECT watch_group_id FROM user_listing_flags WHERE user_id = 9 AND post_id = 31").get().watch_group_id,
    groupA,
  );
  assert.equal(
    db.prepare("SELECT watch_group_id FROM user_listing_flags WHERE user_id = 9 AND post_id = 32").get().watch_group_id,
    groupB,
    "inactive watch_group_id is not rewritten",
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM listing_groups WHERE group_id = ?").get(groupB).n, 0);
  assert.equal(
    db.prepare("SELECT group_id FROM user_events WHERE user_id = 9 AND type = 'price_drop'").get().group_id,
    groupA,
  );
  db.close();
});

function groupMergeSnapshot(db) {
  return {
    groups: db.prepare("SELECT group_id, primary_post_id FROM listing_groups ORDER BY group_id").all(),
    members: db.prepare("SELECT post_id, group_id FROM listing_group_members ORDER BY post_id").all(),
    flags: db.prepare("SELECT user_id, post_id, watched, watch_group_id FROM user_listing_flags ORDER BY user_id, post_id").all(),
    events: db.prepare("SELECT user_id, post_id, type, detail, group_id FROM user_events ORDER BY id").all(),
  };
}

test("failed binding migration rolls back the whole group merge", () => {
  const db = open();
  const early = [
    { post_id: 41, title: "A1", url: "https://a1", price_num: 20000, source: "591" },
    { post_id: 42, title: "A2", url: "https://a2", price_num: 21000, source: "sinyi" },
  ];
  const late = [
    { post_id: 51, title: "B1", url: "https://b1", price_num: 20500, source: "housefun" },
    { post_id: 52, title: "B2", url: "https://b2", price_num: 21500, source: "rakuya" },
  ];
  early.forEach((row) => insert(db, row));
  late.forEach((row) => insert(db, row));
  const groupA = bindListingsToGroup(db, early, { now: "2026-01-01T00:00:00.000Z" });
  const groupB = bindListingsToGroup(db, late, { now: "2026-06-01T00:00:00.000Z" });
  db.prepare("INSERT INTO user_listing_flags(user_id, post_id, watched, watch_group_id) VALUES (3, 51, 1, ?)").run(groupB);
  db.prepare("INSERT INTO user_events(user_id, post_id, type, detail, group_id) VALUES (3, 51, 'price_drop', '21000 → 20500', ?)").run(groupB);
  const before = groupMergeSnapshot(db);

  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (String(sql).includes("UPDATE user_listing_flags SET watch_group_id") && String(sql).includes("watched = 1")) {
      return { run: () => { throw new Error("forced watch migrate failure"); } };
    }
    return originalPrepare(sql);
  };

  assert.throws(
    () => bindListingsToGroup(db, [late[0], early[0]], { now: "2026-09-01T00:00:00.000Z" }),
    /forced watch migrate failure/,
  );
  assert.deepEqual(groupMergeSnapshot(db), before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM listing_groups WHERE group_id = ?").get(groupB).n, 1);
  assert.equal(groupIdForPost(db, 51), groupB);
  assert.equal(groupIdForPost(db, 41), groupA);
  assert.equal(
    db.prepare("SELECT watch_group_id FROM user_listing_flags WHERE user_id = 3 AND post_id = 51").get().watch_group_id,
    groupB,
  );
  assert.equal(
    db.prepare("SELECT group_id FROM user_events WHERE user_id = 3 AND type = 'price_drop'").get().group_id,
    groupB,
  );
  db.close();
});

test("mutable group events dedupe by semantic detail, not forever by type", () => {
  const db = open();
  const gid = "lg_price";
  assert.equal(alreadyNotifiedGroup(db, 4, gid, "price_drop", "20000 → 19000"), false);
  db.prepare(
    "INSERT INTO user_events(user_id, post_id, type, detail, group_id) VALUES (4, 101, 'price_drop', '20000 → 19000', ?)",
  ).run(gid);
  assert.equal(alreadyNotifiedGroup(db, 4, gid, "price_drop", "20000 → 19000"), true, "same change from a peer is dropped");
  assert.equal(alreadyNotifiedGroup(db, 4, gid, "price_drop", "20000→19000"), true, "whitespace-normalized duplicate");
  assert.equal(alreadyNotifiedGroup(db, 4, gid, "price_drop", "19000 → 18000"), false, "later distinct drop still enqueues");
  db.prepare(
    "INSERT INTO user_events(user_id, post_id, type, detail, group_id) VALUES (4, 102, 'price_drop', '19000 → 18000', ?)",
  ).run(gid);
  assert.equal(alreadyNotifiedGroup(db, 4, gid, "price_drop", "19000 → 18000"), true);
  assert.equal(
    alreadyNotifiedGroup(db, 4, gid, "price_drop", "20000 → 19000"),
    true,
    "delayed peer of an earlier change is still a duplicate fingerprint",
  );
  assert.equal(alreadyNotifiedGroup(db, 4, gid, "new"), false);
  db.prepare("INSERT INTO user_events(user_id, post_id, type, detail, group_id) VALUES (4, 101, 'new', '', ?)").run(gid);
  assert.equal(alreadyNotifiedGroup(db, 4, gid, "new", "anything"), true, "new stays once-ever");
  db.close();
});
