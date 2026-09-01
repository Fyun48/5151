import { test } from "node:test";
import assert from "node:assert/strict";
import { sortListingsRows } from "../src/db.js";

test("price_asc puts missing/zero prices last and orders real rents low to high", () => {
  const rows = sortListingsRows(
    [
      { post_id: 1, price_num: 36000 },
      { post_id: 2, price_num: 0 },
      { post_id: 3, price_num: 18000 },
      { post_id: 4, price_num: null },
      { post_id: 5, price_num: 22000 },
    ],
    "price_asc",
  );
  assert.deepEqual(
    rows.map((row) => row.post_id),
    [3, 5, 1, 2, 4],
  );
});

test("price_desc keeps zero prices after real rents", () => {
  const rows = sortListingsRows(
    [
      { post_id: 1, price_num: 18000 },
      { post_id: 2, price_num: 0 },
      { post_id: 3, price_num: 36000 },
    ],
    "price_desc",
  );
  assert.deepEqual(
    rows.map((row) => row.post_id),
    [3, 1, 2],
  );
});

test("newest in 特別關注 orders by watched_at, not last_seen_at", () => {
  const rows = sortListingsRows(
    [
      { post_id: 1, watched_at: "2026-08-01T00:00:00.000Z", last_seen_at: "2026-09-01T00:00:00.000Z" },
      { post_id: 2, watched_at: "2026-08-20T00:00:00.000Z", last_seen_at: "2026-08-02T00:00:00.000Z" },
      { post_id: 3, watched_at: "", last_seen_at: "2026-08-15T00:00:00.000Z" },
      { post_id: 4, watched_at: "2026-08-10T00:00:00.000Z", last_seen_at: "2026-08-20T00:00:00.000Z" },
    ],
    "newest",
    { filter: "watched" },
  );
  assert.deepEqual(
    rows.map((row) => row.post_id),
    [2, 4, 1, 3],
  );
});

test("newest outside 特別關注 uses first_seen_at, not update/last_seen", () => {
  const rows = sortListingsRows(
    [
      {
        post_id: 1,
        first_seen_at: "2026-08-01T00:00:00.000Z",
        last_seen_at: "2026-09-01T00:00:00.000Z",
        refresh_time: "剛剛",
      },
      {
        post_id: 2,
        first_seen_at: "2026-08-20T00:00:00.000Z",
        last_seen_at: "2026-08-21T00:00:00.000Z",
        refresh_time: "3天前",
      },
      {
        post_id: 3,
        first_seen_at: "2026-08-10T00:00:00.000Z",
        last_seen_at: "2026-08-30T00:00:00.000Z",
      },
    ],
    "newest",
    { filter: "all" },
  );
  assert.deepEqual(
    rows.map((row) => row.post_id),
    [2, 3, 1],
  );
});
