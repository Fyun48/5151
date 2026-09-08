import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { listingInMemberScope } from "../src/covering.js";
import {
  activateSearchProfile,
  ensureSearchProfileSchema,
  getActiveSearchProfile,
  notifySnapshotFromProfile,
  repairMultipleActiveProfiles,
} from "../src/searchProfiles.js";

function open() {
  const db = new DatabaseSync(":memory:");
  ensureSearchProfileSchema(db);
  return db;
}

test("activating a profile deactivates the previous one in one transaction", () => {
  const db = open();
  activateSearchProfile(db, 1, "p-taipei", {
    name: "台北",
    data: { watchDistricts: ["1-8"], searchUrls: ["https://rent.591.com.tw/list?region=1&section=8"] },
  });
  activateSearchProfile(db, 1, "p-ntpc", {
    name: "新北",
    data: { watchDistricts: ["3-50"], searchUrls: ["https://rent.591.com.tw/list?region=3&section=50"] },
  });
  const active = getActiveSearchProfile(db, 1);
  assert.equal(active.id, "p-ntpc");
  const rows = db.prepare("SELECT id, active FROM user_search_profiles WHERE user_id = 1").all();
  assert.equal(rows.filter((row) => row.active === 1).length, 1);
  assert.equal(rows.find((row) => row.id === "p-taipei").active, 0);
  db.close();
});

test("repair keeps the most recently used active profile and does not delete others", () => {
  const db = open();
  db.exec("DROP INDEX IF EXISTS idx_user_search_profiles_one_active");
  db.exec(`
    INSERT INTO user_search_profiles(id, user_id, name, data_json, active, version, last_used_at, created_at, updated_at)
    VALUES
      ('old', 4, '舊', '{}', 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('new', 4, '新', '{}', 1, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  `);
  assert.equal(repairMultipleActiveProfiles(db, 4), "new");
  const rows = db.prepare("SELECT id, active FROM user_search_profiles WHERE user_id = 4").all();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === "new").active, 1);
  assert.equal(rows.find((row) => row.id === "old").active, 0);
  db.close();
});

test("different users keep isolated active profiles and notify snapshots", () => {
  const db = open();
  activateSearchProfile(db, 1, "a", {
    data: { watchDistricts: ["1-8"], searchUrls: ["https://rent.591.com.tw/list?region=1&section=8"], priceMax: 20000 },
  });
  activateSearchProfile(db, 2, "b", {
    data: { watchDistricts: ["3-50"], searchUrls: ["https://rent.591.com.tw/list?region=3&section=50"], priceMax: 30000 },
  });
  const snap1 = notifySnapshotFromProfile(getActiveSearchProfile(db, 1));
  const snap2 = notifySnapshotFromProfile(getActiveSearchProfile(db, 2));
  assert.equal(snap1.notify_profile_id, "a");
  assert.equal(snap2.notify_profile_id, "b");
  const listingTaipei = { source_key: "1|8||台北市士林區中正路1號|3F|10|2房", price_num: 18000 };
  const listingTamsui = { source_key: "3|50||新北市淡水區淡金路1號|3F|10|2房", price_num: 18000 };
  assert.equal(listingInMemberScope(listingTaipei, snap1.data), true);
  assert.equal(listingInMemberScope(listingTamsui, snap1.data), false);
  assert.equal(listingInMemberScope(listingTamsui, snap2.data), true);
  assert.equal(listingInMemberScope(listingTaipei, snap2.data), false);
  db.close();
});

test("switching profiles bumps version so a notify job can freeze the old snapshot", () => {
  const db = open();
  const first = activateSearchProfile(db, 9, "live", { data: { watchDistricts: ["1-8"] } });
  const bound = notifySnapshotFromProfile(first);
  const second = activateSearchProfile(db, 9, "other", { data: { watchDistricts: ["3-50"] } });
  assert.notEqual(second.id, bound.notify_profile_id);
  const stillBound = bound.data;
  const listing = { source_key: "1|8||x|1F|10|1房", price_num: 15000 };
  assert.equal(listingInMemberScope(listing, stillBound), true);
  assert.equal(listingInMemberScope(listing, JSON.parse(second.data_json)), false);
  db.close();
});
