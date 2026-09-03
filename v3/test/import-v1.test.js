import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { importV1CacheIfNeeded } from "../src/importV1.js";

function makeDir() {
  return mkdtempSync(path.join(os.tmpdir(), "v1-import-"));
}

function open(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function seedV1(file) {
  const db = open(file);
  db.exec(`
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL,
      search_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      watch_note TEXT NOT NULL DEFAULT '',
      viewed_at TEXT,
      match_verdict TEXT,
      lat REAL,
      lng REAL
    );
    CREATE TABLE geo_cache (
      address TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE community_cache (
      community_id INTEGER PRIMARY KEY,
      name TEXT,
      address TEXT,
      lat REAL,
      lng REAL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO listings(post_id, source_key, search_key, title, url, first_seen_at, last_seen_at, viewed, watched, hidden, watch_note, viewed_at)
     VALUES (11, '1|8|a', 'https://rent.591.com.tw/list?region=1&section=8', '士林舊網址', 'https://rent.591.com.tw/11', '2026-01-01', '2026-01-02', 1, 1, 0, '要看', '2026-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO listings(post_id, source_key, search_key, title, url, first_seen_at, last_seen_at, hidden, match_verdict)
     VALUES (12, '1|5|b', 'https://rent.591.com.tw/list?region=1&section=5', '重複刊登', 'https://rent.591.com.tw/12', '2026-01-01', '2026-01-02', 1, 'yes')`,
  ).run();
  db.prepare(
    `INSERT INTO geo_cache(address, lat, lng, updated_at) VALUES ('台北市士林區', 25.09, 121.52, '2026-01-01')`,
  ).run();
  db.prepare(
    `INSERT INTO community_cache(community_id, name, address, lat, lng, updated_at)
     VALUES (99, '測試社區', '士林區', 25.09, 121.52, '2026-01-01')`,
  ).run();
  db.close();
}

function seedV2(file) {
  const db = open(file);
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL,
      search_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      watch_note TEXT NOT NULL DEFAULT '',
      viewed_at TEXT,
      hidden_at TEXT,
      match_verdict TEXT
    );
    CREATE TABLE geo_cache (
      address TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE community_cache (
      community_id INTEGER PRIMARY KEY,
      name TEXT,
      address TEXT,
      lat REAL,
      lng REAL,
      updated_at TEXT NOT NULL
    );
  `);
  ensurePersonalSchema(db);
  db.prepare("INSERT INTO users(email, password_hash, role, plan, created_at) VALUES ('admin@local', '', 'admin', 'free', '2026-01-01')").run();
  db.prepare(
    "INSERT INTO user_settings(user_id, key, value) VALUES (1, 'searchUrls', ?)",
  ).run(JSON.stringify(["https://rent.591.com.tw/list?region=1&section=8,5,3"]));
  return db;
}

test("imports v1 listings, admin flags, and caches once", () => {
  const dir = makeDir();
  const v1 = path.join(dir, "591.db");
  const v2 = path.join(dir, "v3.db");
  seedV1(v1);
  const dest = seedV2(v2);
  const first = importV1CacheIfNeeded(dest, { v1Path: v1, adminUserId: 1 });
  assert.equal(first.imported, true);
  assert.equal(first.listings, 2);
  assert.equal(first.flags, 1);
  assert.equal(first.geo, 1);
  assert.equal(first.communities, 1);
  const watched = dest.prepare("SELECT * FROM listings WHERE post_id = 11").get();
  assert.equal(watched.viewed, 0);
  assert.equal(watched.watched, 0);
  assert.equal(watched.watch_note, "");
  assert.equal(watched.search_key, "https://rent.591.com.tw/list?region=1&section=8,5,3");
  const flags = dest.prepare("SELECT * FROM user_listing_flags WHERE user_id = 1 AND post_id = 11").get();
  assert.equal(flags.viewed, 1);
  assert.equal(flags.watched, 1);
  assert.equal(flags.watch_note, "要看");
  const dup = dest.prepare("SELECT * FROM listings WHERE post_id = 12").get();
  assert.equal(dup.hidden, 1);
  assert.equal(dup.match_verdict, "yes");
  assert.equal(dest.prepare("SELECT 1 AS ok FROM user_listing_flags WHERE post_id = 12").get(), undefined);
  const second = importV1CacheIfNeeded(dest, { v1Path: v1, adminUserId: 1 });
  assert.equal(second.imported, false);
  assert.equal(second.reason, "already");
  dest.close();
  rmSync(dir, { recursive: true, force: true });
});

test("does not overwrite an existing v2 listing", () => {
  const dir = makeDir();
  const v1 = path.join(dir, "591.db");
  const v2 = path.join(dir, "v3.db");
  seedV1(v1);
  const dest = seedV2(v2);
  dest.prepare(
    `INSERT INTO listings(post_id, source_key, search_key, title, url, first_seen_at, last_seen_at)
     VALUES (11, '1|8|a', 'https://rent.591.com.tw/list?region=1&section=8,5,3', 'v2 已有', 'https://rent.591.com.tw/11', '2026-02-01', '2026-02-02')`,
  ).run();
  const result = importV1CacheIfNeeded(dest, { v1Path: v1, adminUserId: 1 });
  assert.equal(result.listings, 1);
  assert.equal(dest.prepare("SELECT title FROM listings WHERE post_id = 11").get().title, "v2 已有");
  dest.close();
  rmSync(dir, { recursive: true, force: true });
});

test("skips when v1 database is missing", () => {
  const dir = makeDir();
  const dest = seedV2(path.join(dir, "v3.db"));
  const result = importV1CacheIfNeeded(dest, { v1Path: path.join(dir, "nope.db"), adminUserId: 1 });
  assert.equal(result.imported, false);
  assert.equal(result.reason, "missing");
  dest.close();
  rmSync(dir, { recursive: true, force: true });
});
