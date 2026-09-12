import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { appendDistrictCandidates, ensureDistrictCandidateIndex } from "../src/listDistrictSql.js";

test("district candidates retain complete connected groups without loading unrelated matches or other users' groups", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE listings (post_id INTEGER PRIMARY KEY, source_key TEXT, match_post_id INTEGER);
      CREATE INDEX matches ON listings(match_post_id);
      CREATE TABLE user_same_house_members (user_id INTEGER, group_key TEXT, post_id INTEGER,
        PRIMARY KEY(user_id, post_id));
      CREATE INDEX personal_group ON user_same_house_members(user_id, group_key);
      INSERT INTO listings VALUES
        (1, '1|8|selected', 0), (2, '3|34|incoming', 1),
        (3, '3|34|chain', 2), (4, '3|34|personal', 5),
        (5, '3|34|cycle', 4), (6, '3|34|unrelated', 7),
        (7, '3|34|unrelated', 6), (8, '3|34|other-user', 9),
        (9, '3|34|other-user', 8), (10, 'legacy', 11),
        (11, '3|34|legacy-peer', 0), (12, '3|34|missing-peer', 99),
        (13, '3|34|unrelated-personal', 0);
      INSERT INTO user_same_house_members VALUES
        (1, 'shared-name', 3), (1, 'shared-name', 4),
        (1, 'elsewhere', 12), (1, 'elsewhere', 13),
        (2, 'shared-name', 1), (2, 'shared-name', 8);
    `);
    const query = (viewer, names = ["士林區"]) => {
      const clauses = [], params = [];
      appendDistrictCandidates(names, clauses, params, { preserveRelationsFor: viewer });
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return db.prepare(`SELECT post_id FROM listings ${where} ORDER BY post_id`).all(...params).map(row => row.post_id);
    };
    assert.deepEqual(query(1), [1, 2, 3, 4, 5, 10, 11]);
    assert.deepEqual(query(2), [1, 2, 3, 8, 9, 10, 11]);
    assert.deepEqual(query(0), [1, 2, 3, 10, 11]);
    // Stats still use just district candidates, and absent district scope stays unrestricted.
    assert.deepEqual(query(undefined), [1, 10]);
    assert.equal(query(1, []).length, 13);
    // Broken external IDs can be shared by real rows. Traversal must terminate
    // and preserve incoming relationships even when the target row is absent.
    db.exec("INSERT INTO listings VALUES (14, '1|8|missing-target', 99)");
    assert.deepEqual(query(1), [1, 2, 3, 4, 5, 10, 11, 12, 13, 14]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listings").get().n, 14);
  } finally {
    db.close();
  }
});

test("district ID lookup uses the derived index and follows source-key edits automatically", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE listings (post_id INTEGER PRIMARY KEY, source_key TEXT, title TEXT);
      INSERT INTO listings VALUES (1, '1|8|selected', 'A'), (2, '3|34|foreign', 'B'), (3, 'legacy', 'C')`);
    ensureDistrictCandidateIndex(db);
    ensureDistrictCandidateIndex(db);
    const clauses = [], params = [];
    appendDistrictCandidates(["士林區"], clauses, params);
    const sql = `SELECT post_id, title FROM listings WHERE ${clauses.join(" AND ")} ORDER BY post_id`;
    const read = () => db.prepare(sql).all(...params).map(row => row.post_id);
    assert.deepEqual(read(), [1, 3]);
    const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all(...params).map(row => row.detail);
    assert.ok(plan.some(row => /USING COVERING INDEX idx_listings_district_prefix/.test(row)), plan.join("\n"));
    db.exec("UPDATE listings SET source_key = '3|34|moved' WHERE post_id = 1");
    db.exec("UPDATE listings SET source_key = '1|8|moved' WHERE post_id = 2");
    assert.deepEqual(read(), [2, 3]);
    db.exec("INSERT INTO listings VALUES (4, '1|8|new', 'D')");
    assert.deepEqual(read(), [2, 3, 4]);
  } finally {
    db.close();
  }
});
