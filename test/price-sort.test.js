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
