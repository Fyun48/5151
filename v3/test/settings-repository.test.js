import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createSqliteSettingsRepository,
  createPostgresSettingsRepository,
  createSettingsRepository,
} from "../src/repository/settings.js";

function sqliteRepo() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return { db, repo: createSqliteSettingsRepository(db) };
}

test("sqlite settings repository get/set/delete/all", async () => {
  const { repo } = sqliteRepo();
  await repo.set("siteName", "吉比租房");
  await repo.set("priceMax", "25000");
  assert.equal(await repo.get("siteName"), "吉比租房");
  assert.deepEqual(await repo.all(), [
    { key: "priceMax", value: "25000" },
    { key: "siteName", value: "吉比租房" },
  ]);

  await repo.set("siteName", "吉比租房 v2"); // upsert
  assert.equal(await repo.get("siteName"), "吉比租房 v2");

  await repo.delete("priceMax");
  assert.equal(await repo.get("priceMax"), null);
});

test("factory selects sqlite by default and postgres by driver", async () => {
  const { db } = sqliteRepo();
  const repo = createSettingsRepository({ sqliteDb: db });
  assert.equal(repo.name, "sqlite");
  await repo.set("k", "v");
  assert.equal(await repo.get("k"), "v");

  assert.throws(() => createSettingsRepository({ driver: "postgres" }), /requires pgPool/);
  assert.throws(() => createSettingsRepository({ sqliteDb: null }), /requires sqliteDb/);
  db.close();
});

test("postgres repository uses $n placeholders and ON CONFLICT", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ key: params?.[0], value: params?.[1] ?? "v" }] };
    },
  };
  const repo = createPostgresSettingsRepository(pool);
  await repo.set("k", "v");
  await repo.get("k");
  await repo.delete("k");
  await repo.all();

  const setSql = calls[0].sql;
  assert.match(setSql, /\$1, \$2/);
  assert.match(setSql, /ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value/);
  assert.match(calls[1].sql, /key = \$1/);
  assert.match(calls[2].sql, /DELETE FROM settings WHERE key = \$1/);
});
