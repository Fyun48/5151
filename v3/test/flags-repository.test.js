import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createSqliteFlagsRepository,
  createPostgresFlagsRepository,
  createFlagsRepository,
} from "../src/repository/flags.js";

function sqliteRepo() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user_listing_flags (
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
  )`);
  return { db, repo: createSqliteFlagsRepository(db) };
}

test("sqlite flags repository get/set/map/delete", async () => {
  const { db, repo } = sqliteRepo();
  assert.equal(await repo.get(1, 101), null);

  await repo.set(1, 101, { watched: 1, watch_note: "離公司近" });
  assert.equal((await repo.get(1, 101)).watched, 1);
  assert.equal((await repo.get(1, 101)).watch_note, "離公司近");

  await repo.set(1, 101, { hidden: 1 }); // upsert keeps watched
  const row = await repo.get(1, 101);
  assert.equal(row.hidden, 1);

  await repo.set(1, 102, { viewed: 1 });
  assert.equal((await repo.map(1)).length, 2);

  assert.equal(await repo.delete(1, 102), true);
  assert.equal(await repo.delete(1, 999), false);
  assert.equal((await repo.map(1)).length, 1);
  db.close();
});

test("factory selects sqlite by default and postgres by driver", async () => {
  const { db } = sqliteRepo();
  const repo = createFlagsRepository({ sqliteDb: db });
  assert.equal(repo.name, "sqlite");
  await repo.set(7, 11, { watched: 1 });
  assert.equal((await repo.get(7, 11)).watched, 1);

  assert.throws(() => createFlagsRepository({ driver: "postgres" }), /requires pgPool/);
  assert.throws(() => createFlagsRepository({ sqliteDb: null }), /requires sqliteDb/);
  db.close();
});

test("postgres flags repository uses $n placeholders and ON CONFLICT", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ post_id: 11, viewed: 1, watched: 0, hidden: 0, watch_note: "" }], rowCount: 1 };
    },
  };
  const repo = createPostgresFlagsRepository(pool);
  await repo.set(7, 11, { watched: 1 });
  await repo.get(7, 11);
  await repo.map(7);
  await repo.delete(7, 11);

  const setSql = calls[0].sql;
  assert.match(setSql, /\$1, \$2/);
  assert.match(setSql, /ON CONFLICT \(user_id, post_id\) DO UPDATE SET/);
  assert.match(setSql, /viewed = EXCLUDED\.viewed/);
  assert.match(calls[1].sql, /user_id = \$1 AND post_id = \$2/);
  assert.match(calls[3].sql, /DELETE FROM user_listing_flags WHERE user_id = \$1 AND post_id = \$2/);
});
