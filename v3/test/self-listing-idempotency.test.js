import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createSelfListing, ensureSelfListingSchema } from "../src/selfListings.js";
import {
  normalizeSelfListingIdempotencyKey,
  selfListingCreateFingerprint,
} from "../src/selfListingIdempotency.js";
import {
  beginSelfListingSubmit,
  endSelfListingSubmit,
  resolveSelfListingCreateKey,
} from "../src/selfListingSubmitGuard.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
const OLD = "2026-01-01T00:00:00.000Z";
const KEY = "11111111-2222-4333-8444-555555555555";

function listingSchemaSql() {
  return `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL DEFAULT '',
      search_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      price TEXT,
      price_num INTEGER,
      extra_fee INTEGER NOT NULL DEFAULT 0,
      extra_fee_text TEXT,
      price_contain_text TEXT,
      extra_fees TEXT,
      extra_fees_fetched INTEGER NOT NULL DEFAULT 0,
      address TEXT,
      area_name TEXT,
      layout TEXT,
      floor_name TEXT,
      kind_name TEXT,
      role_name TEXT,
      cover TEXT,
      tags TEXT,
      refresh_time TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_event TEXT NOT NULL DEFAULT 'new',
      viewed INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      hidden_at TEXT,
      match_post_id INTEGER,
      match_level TEXT,
      match_detail TEXT,
      match_rejected INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '591',
      source_id TEXT,
      model_score REAL,
      listed_by_user_id INTEGER,
      self_status TEXT,
      self_expires_at TEXT,
      self_body TEXT,
      contact_name TEXT,
      contact_role TEXT,
      mobile TEXT,
      phone TEXT,
      line_url TEXT,
      contact_fetched INTEGER NOT NULL DEFAULT 0
    );
  `;
}

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(listingSchemaSql());
  ensureSelfListingSchema(db);
  return db;
}

function addUser(db, { id, email }) {
  db.prepare("INSERT INTO users(id, email, created_at) VALUES (?, ?, ?)").run(id, email, OLD);
}

function sample(extra = {}) {
  return {
    district: "1-8",
    rent: 25000,
    ping: 18,
    kind: "whole",
    role: "owner",
    floor: 3,
    total_floors: 5,
    rooms: 2,
    living: 1,
    bath: 1,
    contact_name: "林先生",
    address: "台北市士林區中正路100號",
    phone: "0912345678",
    title: "【PR-A-UAT】士林整層可看屋",
    body: "近捷運、可入住、有洗衣機。",
    accept_pledge: true,
    ...extra,
  };
}

function countListings(db, userId) {
  return db.prepare("SELECT COUNT(*) n FROM listings WHERE listed_by_user_id=?").get(userId).n;
}

test("same user + same key sequential retry returns the same post_id", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const first = createSelfListing(db, 1, sample({ idempotency_key: KEY }));
  const again = createSelfListing(db, 1, sample({ idempotency_key: KEY }));
  assert.equal(again.post_id, first.post_id);
  assert.equal(countListings(db, 1), 1);
  db.close();
});

test("same user + same key different payload fails closed", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  createSelfListing(db, 1, sample({ idempotency_key: KEY }));
  assert.throws(
    () => createSelfListing(db, 1, sample({ idempotency_key: KEY, title: "【PR-A-UAT】另一個標題要夠長" })),
    (err) => err.status === 409 && err.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(countListings(db, 1), 1);
  db.close();
});

test("same payload + different key can create two listings", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const a = createSelfListing(db, 1, sample({
    idempotency_key: "aaaaaaaa-2222-4333-8444-555555555555",
    address: "台北市士林區中正路101號",
  }));
  const b = createSelfListing(db, 1, sample({
    idempotency_key: "bbbbbbbb-2222-4333-8444-555555555555",
    address: "台北市士林區中正路101號",
  }));
  assert.notEqual(a.post_id, b.post_id);
  assert.equal(countListings(db, 1), 2);
  db.close();
});

test("different users can reuse the same key independently", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  addUser(db, { id: 2, email: "b@example.com" });
  const a = createSelfListing(db, 1, sample({ idempotency_key: KEY, address: "台北市士林區中正路102號" }));
  const b = createSelfListing(db, 2, sample({ idempotency_key: KEY, address: "台北市士林區中正路103號" }));
  assert.notEqual(a.post_id, b.post_id);
  assert.equal(countListings(db, 1), 1);
  assert.equal(countListings(db, 2), 1);
  db.close();
});

test("legacy caller without key keeps old create behavior", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const a = createSelfListing(db, 1, sample({ address: "台北市士林區中正路104號" }));
  const b = createSelfListing(db, 1, sample({ address: "台北市士林區中正路105號" }));
  assert.notEqual(a.post_id, b.post_id);
  assert.equal(countListings(db, 1), 2);
  db.close();
});

test("same key + changed layout or floor_name fails closed", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  const base = sample({
    idempotency_key: KEY,
    rooms: 0,
    living: 0,
    bath: 0,
    floor: 0,
    total_floors: 0,
    layout: "1房0廳1衛",
    floor_name: "3F",
    address: "台北市士林區中正路108號",
  });
  createSelfListing(db, 1, base);
  assert.throws(
    () => createSelfListing(db, 1, { ...base, layout: "2房1廳1衛" }),
    (err) => err.status === 409 && err.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.throws(
    () => createSelfListing(db, 1, { ...base, floor_name: "5F" }),
    (err) => err.status === 409 && err.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(countListings(db, 1), 1);
  db.close();
});

test("invalid key is rejected and never interpolated as SQL", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com" });
  assert.throws(
    () => createSelfListing(db, 1, sample({ idempotency_key: "'; DROP TABLE listings;--" })),
    (err) => err.status === 400 && err.code === "INVALID_IDEMPOTENCY_KEY",
  );
  assert.throws(() => normalizeSelfListingIdempotencyKey("short"), /格式不正確/);
  assert.equal(normalizeSelfListingIdempotencyKey(""), "");
  assert.equal(selfListingCreateFingerprint(sample()).length, 64);
  assert.equal(countListings(db, 1), 0);
  db.close();
});

test("same user + same key concurrent creates only one listing", async () => {
  const file = path.join(os.tmpdir(), `self-idemp-${process.pid}-${Date.now()}.db`);
  const seed = new DatabaseSync(file);
  seed.exec("PRAGMA journal_mode=WAL");
  seed.exec("PRAGMA busy_timeout=30000");
  seed.exec(listingSchemaSql());
  ensureSelfListingSchema(seed);
  addUser(seed, { id: 1, email: "a@example.com" });
  seed.close();

  const workerSrc = `
    import { parentPort, workerData } from "node:worker_threads";
    import { DatabaseSync } from "node:sqlite";
    import { createSelfListing } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/selfListings.js")).href)};
    const db = new DatabaseSync(workerData.file);
    // busy_timeout is connection-local and cannot fail; WAL is already set by the seed, so a busy
    // header write here must not fail the worker (SQLITE_BUSY_RECOVERY on a contended runner).
    db.exec("PRAGMA busy_timeout=30000");
    try { db.exec("PRAGMA journal_mode=WAL"); } catch { /* seed already set WAL */ }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const transientLock = (error) => /database is locked|SQLITE_BUSY/i.test(String((error && error.message) || error));
    (async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const row = createSelfListing(db, 1, workerData.input);
          parentPort.postMessage({ ok: true, post_id: row.post_id });
          return;
        } catch (error) {
          if (transientLock(error) && attempt < 9) {
            await sleep(50 * (attempt + 1));
            continue;
          }
          parentPort.postMessage({ ok: false, status: error.status || 500, message: error.message });
          return;
        }
      }
    })().finally(() => db.close());
  `;
  const input = sample({ idempotency_key: KEY, address: "台北市士林區中正路106號" });
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(workerSrc, { eval: true, workerData: { file, input } });
    let payload = null;
    worker.once("message", (msg) => { payload = msg; });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (payload) resolve(payload);
      else reject(new Error(`worker exit ${code}`));
    });
  });
  const [left, right] = await Promise.all([run(), run()]);
  const ok = [left, right].filter((row) => row.ok);
  assert.equal(ok.length, 2, JSON.stringify([left, right]));
  assert.equal(ok[0].post_id, ok[1].post_id);
  const check = new DatabaseSync(file);
  check.exec("PRAGMA busy_timeout=30000");
  assert.equal(check.prepare("SELECT COUNT(*) n FROM listings WHERE listed_by_user_id=1").get().n, 1);
  check.close();
  unlinkSync(file);
});

test("frontend submit guard blocks a second in-flight create and keeps key on failure", () => {
  let n = 0;
  const makeKey = () => `key-${++n}-xxxxxxxx`;
  let state = resolveSelfListingCreateKey({}, "fp-1", makeKey);
  assert.equal(state.key, "key-1-xxxxxxxx");
  const first = beginSelfListingSubmit(state);
  assert.equal(first.allowed, true);
  const second = beginSelfListingSubmit(first.state);
  assert.equal(second.allowed, false);
  const failed = endSelfListingSubmit(first.state, { success: false });
  assert.equal(failed.inFlight, false);
  assert.equal(failed.key, "key-1-xxxxxxxx");
  const retry = resolveSelfListingCreateKey(failed, "fp-1", makeKey);
  assert.equal(retry.key, "key-1-xxxxxxxx");
  const changed = resolveSelfListingCreateKey(failed, "fp-2", makeKey);
  assert.equal(changed.key, "key-2-xxxxxxxx");
  const done = endSelfListingSubmit(beginSelfListingSubmit(retry).state, { success: true });
  assert.equal(done.key, "");
});

test("index.html create path uses the shared PraHelpers submit guard", () => {
  const handler = html.slice(
    html.indexOf('$("selfListingForm")?.addEventListener("submit"'),
    html.indexOf("let editingDraftId = null"),
  );
  assert.match(html, /src="\/pra-helpers\.js"/);
  assert.match(handler, /PraHelpers\.beginSelfListingSubmit\(selfListingGate\)/);
  assert.match(handler, /PraHelpers\.resolveSelfListingCreateKey/);
  assert.match(handler, /PraHelpers\.newSelfListingIdempotencyKey/);
  assert.match(handler, /PraHelpers\.endSelfListingSubmit/);
  assert.match(handler, /payload\.idempotency_key = selfListingGate\.key/);
  assert.doesNotMatch(handler, /Math\.random/);
  assert.doesNotMatch(html, /slc-\$\{Date\.now\(\)\}/);
});
