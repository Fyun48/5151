import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  createSqliteUsersRepository,
  createPostgresUsersRepository,
  createUsersRepository,
} from "../src/repository/users.js";

function sqliteRepo() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'member',
    plan TEXT NOT NULL DEFAULT 'free',
    created_at TEXT NOT NULL
  )`);
  return { db, repo: createSqliteUsersRepository(db) };
}

test("sqlite users repository create/find/setPasswordHash/list", async () => {
  const { db, repo } = sqliteRepo();
  assert.equal(await repo.findByEmail("A@Example.com"), null);

  const created = await repo.create({ email: "A@Example.com", passwordHash: "h1", role: "member" });
  assert.ok(created.id > 0);
  assert.equal(created.email, "a@example.com"); // normalized lowercase
  assert.equal(created.role, "member");

  const byEmail = await repo.findByEmail("a@example.com");
  assert.equal(byEmail.password_hash, "h1");
  const byId = await repo.findById(created.id);
  assert.equal(byId.email, "a@example.com");

  await repo.setPasswordHash(created.id, "h2");
  assert.equal((await repo.findById(created.id)).password_hash, "h2");

  await repo.create({ email: "b@example.com", role: "admin", plan: "sponsor" });
  assert.equal((await repo.list()).length, 2);
  db.close();
});

test("factory selects sqlite by default and postgres by driver", async () => {
  const { db } = sqliteRepo();
  const repo = createUsersRepository({ sqliteDb: db });
  assert.equal(repo.name, "sqlite");
  await repo.create({ email: "u@example.com" });
  assert.ok((await repo.findByEmail("u@example.com")).id > 0);

  assert.throws(() => createUsersRepository({ driver: "postgres" }), /requires pgPool/);
  assert.throws(() => createUsersRepository({ sqliteDb: null }), /requires sqliteDb/);
  db.close();
});

test("postgres users repository uses $n placeholders and RETURNING", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id: 1, email: "u@example.com", password_hash: "h", role: "member", plan: "free", created_at: "now" }] };
    },
  };
  const repo = createPostgresUsersRepository(pool);
  await repo.create({ email: "U@Example.com", passwordHash: "h" });
  await repo.findByEmail("u@example.com");
  await repo.findById(1);
  await repo.setPasswordHash(1, "h2");

  assert.match(calls[0].sql, /\$1, \$2, \$3, \$4, \$5/);
  assert.match(calls[0].sql, /RETURNING id, email, password_hash, role, plan, created_at/);
  assert.match(calls[1].sql, /WHERE email = \$1/);
  assert.match(calls[2].sql, /WHERE id = \$1/);
  assert.match(calls[3].sql, /UPDATE users SET password_hash = \$1 WHERE id = \$2/);
});
