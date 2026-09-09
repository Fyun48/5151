import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  MEMBER_MAX_WATCHED,
  SPONSOR_MAX_WATCHED,
  canAddWatch,
  countWatched,
  watchLimitForActor,
  watchLimitMessage,
} from "../src/watchLimits.js";
import { setUserListingFlags } from "../src/personalFlags.js";

function mem() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE user_listing_flags (
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      watch_note TEXT NOT NULL DEFAULT '',
      viewed_at TEXT,
      watched_at TEXT,
      hidden_at TEXT,
      PRIMARY KEY (user_id, post_id)
    )
  `);
  return db;
}

test("watch limits are 6 for members, 15 for sponsors, unlimited for admin", () => {
  assert.equal(watchLimitForActor({ role: "member", plan: "free" }), MEMBER_MAX_WATCHED);
  assert.equal(watchLimitForActor({ role: "member", plan: "sponsor" }), SPONSOR_MAX_WATCHED);
  assert.equal(watchLimitForActor({ role: "admin", plan: "free" }), 0);
  assert.match(watchLimitMessage(MEMBER_MAX_WATCHED), /一般會員最多特別關注 6 筆/);
  assert.doesNotMatch(watchLimitMessage(MEMBER_MAX_WATCHED), /管理員/);
  assert.doesNotMatch(watchLimitMessage(SPONSOR_MAX_WATCHED), /管理員/);
});

test("member cannot add a 7th watch", () => {
  const db = mem();
  for (let i = 1; i <= 6; i += 1) setUserListingFlags(db, 1, i, { watched: true });
  assert.equal(countWatched(db, 1), 6);
  const gate = canAddWatch(db, 1, { role: "member", plan: "free" });
  assert.equal(gate.ok, false);
  assert.match(gate.error, /6 筆/);
  assert.equal(canAddWatch(db, 1, { role: "member", plan: "sponsor" }).ok, true);
  assert.equal(canAddWatch(db, 1, { role: "admin" }).ok, true);
  assert.equal(canAddWatch(db, 1, { role: "member", plan: "free" }, { alreadyWatched: true }).ok, true);
});
