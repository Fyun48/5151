import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import {
  anyoneWatched,
  clearUserListingFlags,
  copyUserFlagsForRelist,
  ensureUser,
  listingIsMainListAffiliate,
  listingMatchesListFilter,
  loadFlagMap,
  loadFlags,
  mergeFlagsOnConfirm,
  migrateListingFlagsIfNeeded,
  overlayPersonal,
  overlayRowsPersonal,
  setUserListingFlags,
} from "../src/personalFlags.js";

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      viewed INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      watch_note TEXT NOT NULL DEFAULT '',
      viewed_at TEXT,
      watched_at TEXT,
      hidden_at TEXT,
      match_verdict TEXT
    );
  `);
  ensurePersonalSchema(db);
  return db;
}

test("two users keep independent watch and hide flags on the same listing", () => {
  const db = memoryDb();
  const alice = ensureUser(db, "alice@example.com");
  const bob = ensureUser(db, "bob@example.com");
  db.prepare("INSERT INTO listings(post_id) VALUES (101)").run();

  setUserListingFlags(db, alice, 101, { watched: true, watch_note: "Alice 的備註" });
  setUserListingFlags(db, bob, 101, { hidden: true, viewed: true });

  const aliceRow = overlayPersonal({ post_id: 101, match_verdict: "" }, loadFlags(db, alice, 101));
  const bobRow = overlayPersonal({ post_id: 101, match_verdict: "" }, loadFlags(db, bob, 101));

  assert.equal(aliceRow.watched, 1);
  assert.equal(aliceRow.hidden, 0);
  assert.equal(aliceRow.watch_note, "Alice 的備註");
  assert.equal(bobRow.watched, 0);
  assert.equal(bobRow.hidden, 1);
  assert.equal(bobRow.viewed, 1);
  assert.equal(listingMatchesListFilter(aliceRow, "all"), false);
  assert.equal(listingMatchesListFilter(bobRow, "all"), false);
  assert.equal(listingMatchesListFilter(bobRow, "hidden"), true);
  assert.equal(anyoneWatched(db, 101), true);
});

test("overlay keeps system-hidden duplicates even without a personal hide flag", () => {
  const row = overlayPersonal(
    { post_id: 9, match_verdict: "yes", hidden: 1, hidden_at: "2026-01-01T00:00:00.000Z" },
    { viewed: 0, watched: 0, hidden: 0, watch_note: "" },
  );
  assert.equal(row.hidden, 1);
  assert.equal(row.hidden_at, "2026-01-01T00:00:00.000Z");
  assert.equal(listingMatchesListFilter(row, "hidden"), true);
  assert.equal(listingMatchesListFilter(row, "all"), false);
});

test("main list hides cheaper-house affiliates except hidden filter or personal split", () => {
  const affiliate = { same_house_role: "affiliate", hidden: 0, offline: 0, match_verdict: "" };
  const split = { ...affiliate, same_house_split: true };
  const liveWhilePrimaryGone = { ...affiliate, same_house_primary_offline: true, offline: 0 };
  assert.equal(listingIsMainListAffiliate(affiliate, "all"), true);
  assert.equal(listingMatchesListFilter(affiliate, "all"), false);
  assert.equal(listingMatchesListFilter(affiliate, "guest"), false);
  assert.equal(listingMatchesListFilter(affiliate, "hidden"), false);
  assert.equal(listingIsMainListAffiliate(split, "all"), false);
  assert.equal(listingMatchesListFilter({ ...split, match_level: "high" }, "all"), true);
  assert.equal(listingIsMainListAffiliate(liveWhilePrimaryGone, "all"), false);
});

test("confirmed same-house duplicates leave the suspected filter", () => {
  const pending = { match_level: "high", match_verdict: "", hidden: 0, offline: 0 };
  const kept = { match_level: null, match_verdict: "", hidden: 0, offline: 0 };
  const hiddenDup = { match_level: "high", match_verdict: "yes", hidden: 1, offline: 0 };
  assert.equal(listingMatchesListFilter(pending, "suspected"), true);
  assert.equal(listingMatchesListFilter(kept, "suspected"), false);
  assert.equal(listingMatchesListFilter(hiddenDup, "suspected"), false);
  assert.equal(listingMatchesListFilter(hiddenDup, "hidden"), true);
  assert.equal(listingMatchesListFilter(hiddenDup, "all"), false);
});

test("watched filter keeps confirmed-offline, hidden, and same-house affiliates", () => {
  const confirmed = { watched: 1, offline: 1, offline_confirmed: 1, hidden: 0, match_verdict: "" };
  const hiddenWatch = { watched: 1, hidden: 1, offline: 0, match_verdict: "" };
  const affiliate = { watched: 1, same_house_role: "affiliate", hidden: 0, offline: 0, match_verdict: "" };
  assert.equal(listingMatchesListFilter(confirmed, "watched"), true);
  assert.equal(listingMatchesListFilter(hiddenWatch, "watched"), true);
  assert.equal(listingIsMainListAffiliate(affiliate, "watched"), false);
  assert.equal(listingMatchesListFilter(affiliate, "watched"), true);
  assert.equal(listingMatchesListFilter({ ...confirmed, watched: 0 }, "watched"), false);
});

test("relist copies each member's flags onto the new post_id", () => {
  const db = memoryDb();
  const alice = ensureUser(db, "alice@example.com");
  const bob = ensureUser(db, "bob@example.com");
  setUserListingFlags(db, alice, 10, { viewed: true, watch_note: "舊的" });
  setUserListingFlags(db, bob, 10, { watched: true, watch_note: "關注" });

  const copied = copyUserFlagsForRelist(db, 10, 20);
  assert.equal(copied, 2);

  const aliceNew = loadFlags(db, alice, 20);
  const bobNew = loadFlags(db, bob, 20);
  assert.equal(aliceNew.viewed, 1);
  assert.equal(aliceNew.hidden, 1);
  assert.equal(aliceNew.watch_note, "舊的");
  assert.equal(bobNew.watched, 1);
  assert.equal(bobNew.hidden, 0);
  assert.equal(bobNew.watch_note, "關注");
});

test("confirm-match merges watch notes onto the kept listing without hiding it", () => {
  const db = memoryDb();
  const alice = ensureUser(db, "alice@example.com");
  setUserListingFlags(db, alice, 1, { watched: true, watch_note: "主刊登" });
  setUserListingFlags(db, alice, 2, { hidden: true, viewed: true, watch_note: "重複" });
  mergeFlagsOnConfirm(db, 1, 2);
  const kept = loadFlags(db, alice, 1);
  assert.equal(kept.watched, 1);
  assert.equal(kept.hidden, 0);
  assert.equal(kept.watch_note, "主刊登");
});

test("migrate copies personal flags off listings and leaves confirmed duplicates hidden", () => {
  const db = memoryDb();
  const admin = ensureUser(db, "admin@local", { role: "admin" });
  db.prepare(
    `INSERT INTO listings(post_id, viewed, watched, hidden, watch_note, match_verdict)
     VALUES (1, 1, 1, 0, '要搬', ''),
            (2, 0, 0, 1, '', 'yes'),
            (3, 0, 0, 1, '', '')`,
  ).run();

  const first = migrateListingFlagsIfNeeded(db, admin);
  assert.equal(first.migrated, true);
  assert.equal(first.copied, 2);

  const flags = loadFlagMap(db, admin);
  assert.equal(flags.get(1).watched, 1);
  assert.equal(flags.get(1).watch_note, "要搬");
  assert.equal(flags.has(2), false);
  assert.equal(flags.get(3).hidden, 1);

  const listing1 = db.prepare("SELECT * FROM listings WHERE post_id = 1").get();
  const listing2 = db.prepare("SELECT * FROM listings WHERE post_id = 2").get();
  const listing3 = db.prepare("SELECT * FROM listings WHERE post_id = 3").get();
  assert.equal(listing1.watched, 0);
  assert.equal(listing1.watch_note, "");
  assert.equal(listing2.hidden, 1);
  assert.equal(listing3.hidden, 0);

  const second = migrateListingFlagsIfNeeded(db, admin);
  assert.equal(second.migrated, false);
});

test("unwatch keeps the personal note", () => {
  const db = memoryDb();
  const uid = ensureUser(db, "admin@local");
  setUserListingFlags(db, uid, 7, { watched: true, watch_note: "採光好" });
  const after = setUserListingFlags(db, uid, 7, { watched: false, watch_note: "" });
  assert.equal(after.watched, 0);
  assert.equal(after.watch_note, "採光好");
});

test("overlayRowsPersonal uses per-user flag map", () => {
  const db = memoryDb();
  const uid = ensureUser(db, "admin@local");
  setUserListingFlags(db, uid, 5, { viewed: true });
  const rows = overlayRowsPersonal([{ post_id: 5, title: "x", match_verdict: "" }, { post_id: 6, title: "y", match_verdict: "" }], loadFlagMap(db, uid));
  assert.equal(rows[0].viewed, 1);
  assert.equal(rows[1].viewed, 0);
});

// Owner 2026-10-07：「全部」= 未看過且未特別關注；看過的改走「已瀏覽」。
test("list filter: all excludes viewed, viewed returns only viewed", () => {
  const base = { offline: 0, offline_confirmed: 0, match_verdict: "", match_level: "", last_event: "" };
  const fresh = { ...base, watched: 0, hidden: 0, viewed: 0 };
  const seen = { ...base, watched: 0, hidden: 0, viewed: 1 };
  const watched = { ...base, watched: 1, hidden: 0, viewed: 0 };
  const watchedSeen = { ...base, watched: 1, hidden: 0, viewed: 1 };
  assert.equal(listingMatchesListFilter(fresh, "all"), true);
  assert.equal(listingMatchesListFilter(seen, "all"), false, "看過的不再出現在全部");
  assert.equal(listingMatchesListFilter(watched, "all"), false);
  assert.equal(listingMatchesListFilter(watchedSeen, "all"), false);
  assert.equal(listingMatchesListFilter(seen, "viewed"), true);
  assert.equal(listingMatchesListFilter(fresh, "viewed"), false);
  assert.equal(listingMatchesListFilter(watchedSeen, "viewed"), true, "看過且關注也要在已瀏覽找得到");
});

// 「全部清除」：只歸零指定欄位，另一欄仍保留（列不會被誤刪）。
test("clearUserListingFlags clears only the requested flag and keeps the other", () => {
  const db = memoryDb();
  const alice = ensureUser(db, "alice@example.com");
  const bob = ensureUser(db, "bob@example.com");
  db.prepare("INSERT INTO listings(post_id) VALUES (101)").run();
  db.prepare("INSERT INTO listings(post_id) VALUES (102)").run();

  setUserListingFlags(db, alice, 101, { watched: true, hidden: true, viewed: true, watch_note: "要看" });
  setUserListingFlags(db, alice, 102, { watched: true });
  setUserListingFlags(db, bob, 101, { watched: true, hidden: true });

  assert.equal(clearUserListingFlags(db, "watched", alice), 2, "只清自己的兩筆");
  const mine = db.prepare("SELECT post_id, watched, hidden, watched_at FROM user_listing_flags WHERE user_id = ? ORDER BY post_id").all(alice);
  assert.deepEqual(mine.map((r) => [r.post_id, r.watched, r.hidden]), [[101, 0, 1], [102, 0, 0]], "hidden 保留、watched 歸零");
  assert.equal(mine[0].watched_at, null, "時間戳要一起清掉");

  const other = db.prepare("SELECT watched FROM user_listing_flags WHERE user_id = ? AND post_id = 101").get(bob);
  assert.equal(other.watched, 1, "別人的資料不能被動到");

  assert.equal(clearUserListingFlags(db, "hidden", alice), 1);
  const after = db.prepare("SELECT watched, hidden FROM user_listing_flags WHERE user_id = ? AND post_id = 101").get(alice);
  assert.equal(after.hidden, 0);
});

test("clearUserListingFlags rejects unknown kinds and empty users", () => {
  const db = memoryDb();
  assert.throws(() => clearUserListingFlags(db, "post_id; DROP TABLE user_listing_flags", 7), (err) => err.status === 400 && err.code === "BAD_FLAG_KIND");
  assert.throws(() => clearUserListingFlags(db, "viewed", 7), (err) => err.code === "BAD_FLAG_KIND");
  assert.equal(clearUserListingFlags(db, "watched", 0), 0, "沒有 uid 就什麼都不做");
});
