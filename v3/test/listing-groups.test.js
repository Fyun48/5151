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
  assert.equal(alreadyNotifiedGroup(db, 1, "lg_x", "price"), false);
  assert.equal(alreadyNotifiedGroup(db, 2, "lg_x", "new"), false);
  db.close();
});
