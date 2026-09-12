import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendPriceCeilingCandidates } from "../src/listPriceSql.js";
import { passesPriceFilter } from "../src/listingCost.js";

test("SQL price reduction never drops an eligible legacy, unknown or rounded rent", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE listings (post_id INTEGER PRIMARY KEY, price_num REAL, price TEXT, extra_fee REAL, extra_fees TEXT)");
    const insert = db.prepare("INSERT INTO listings VALUES (?, ?, ?, ?, ?)");
    const prices = [null, 0, -1, 3.8, 999.99, 1000, 19999.49, 20000, 20000.49,
      20000.5, 20001, 20001.01, 40000, Infinity, -Infinity, "50000元", "待確認"];
    for (let i = 0; i < prices.length; i++) insert.run(i + 1, prices[i], "18000元", 0, "[]");
    insert.run(100, 18000, "18000元", 5000, "[]");
    const all = db.prepare("SELECT * FROM listings ORDER BY post_id").all();
    for (const priceMax of [0, 999.5, 20000, 20000.5, 30000, Infinity]) {
      for (const includeExtras of [false, true]) {
        const settings = { priceMax, priceMaxIncludesExtras: includeExtras };
        const clauses = [], params = [];
        appendPriceCeilingCandidates(settings, clauses, params);
        const candidates = db.prepare(`SELECT * FROM listings ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY post_id`).all(...params);
        assert.deepEqual(candidates.filter(row => passesPriceFilter(row, settings)).map(row => row.post_id),
          all.filter(row => passesPriceFilter(row, settings)).map(row => row.post_id), JSON.stringify(settings));
        if (priceMax === 20000) assert.ok(!candidates.some(row => row.post_id === 13), "known excessive rent should not reach JS");
      }
    }
  } finally {
    db.close();
  }
});
