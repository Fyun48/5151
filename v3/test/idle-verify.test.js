import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import {
  IDLE_PAUSE_MS,
  listIdleMemberIds,
  registerUser,
  touchLastLogin,
} from "../src/members.js";
import { confirmVerifyToken, issueVerifyToken } from "../src/emailVerify.js";
import { applyIdlePauseToMembers, applyIdleResume } from "../src/idlePause.js";
import { memberShouldContributeCrawl } from "../src/settingsState.js";
import { shouldNotify } from "../src/notify.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensurePersonalSchema(db);
  return db;
}

test("members idle after 60 days without login", () => {
  const db = memoryDb();
  const user = registerUser(db, {
    email: "idle@b.com",
    password: "password1",
    acceptDisclaimer: true,
    emailVerified: true,
  });
  const now = Date.parse("2026-09-04T00:00:00.000Z");
  db.prepare("UPDATE users SET created_at = ?, last_login_at = ? WHERE id = ?").run(
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z",
    user.id,
  );
  const idle = listIdleMemberIds(db, { now, idleMs: IDLE_PAUSE_MS });
  assert.deepEqual(idle, [user.id]);
  touchLastLogin(db, user.id, { now });
  assert.deepEqual(listIdleMemberIds(db, { now, idleMs: IDLE_PAUSE_MS }), []);
});

test("recent last_login is not rewritten inside the throttle window", () => {
  const db = memoryDb();
  const user = registerUser(db, {
    email: "active@b.com",
    password: "password1",
    acceptDisclaimer: true,
    emailVerified: true,
  });
  const first = Date.parse("2026-09-05T01:00:00.000Z");
  assert.equal(touchLastLogin(db, user.id, { now: first }), true);
  const stamp = db.prepare("SELECT last_login_at FROM users WHERE id = ?").get(user.id).last_login_at;
  assert.equal(touchLastLogin(db, user.id, { now: first + 60 * 60 * 1000, minIntervalMs: 12 * 60 * 60 * 1000 }), false);
  assert.equal(db.prepare("SELECT last_login_at FROM users WHERE id = ?").get(user.id).last_login_at, stamp);
  assert.equal(touchLastLogin(db, user.id, { now: first + 13 * 60 * 60 * 1000, minIntervalMs: 12 * 60 * 60 * 1000 }), true);
});

test("unverified members are not auto-paused", () => {
  const db = memoryDb();
  const user = registerUser(db, {
    email: "pending@b.com",
    password: "password1",
    acceptDisclaimer: true,
    emailVerified: false,
  });
  const now = Date.parse("2026-09-04T00:00:00.000Z");
  db.prepare("UPDATE users SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", user.id);
  assert.deepEqual(listIdleMemberIds(db, { now, idleMs: IDLE_PAUSE_MS }), []);
});

test("idle pause stops crawl and notify; login resume does not mail", () => {
  const store = {
    7: { notificationsPaused: false, inactivityPaused: false, watchDistricts: ["1-8"], memberFetchDueAt: "2026-09-04T00:00:00.000Z" },
    8: { notificationsPaused: true, inactivityPaused: false, watchDistricts: ["1-8"], memberFetchDueAt: "" },
  };
  const mails = [];
  const paused = applyIdlePauseToMembers([7, 8], {
    getSettings: (id) => store[id],
    saveSettings: (id, patch) => {
      store[id] = { ...store[id], ...patch };
      return store[id];
    },
  });
  assert.equal(paused, 1);
  assert.equal(store[7].notificationsPaused, true);
  assert.equal(store[7].inactivityPaused, true);
  assert.equal(store[8].inactivityPaused, false);
  assert.equal(shouldNotify(store[7], { hidden: 0 }, { type: "new" }), false);
  assert.equal(memberShouldContributeCrawl(store[7], { now: Date.parse("2026-09-04T01:00:00.000Z") }), false);

  const armed = [];
  const result = applyIdleResume(7, {
    getSettings: (id) => store[id],
    saveSettings: (id, patch) => {
      store[id] = { ...store[id], ...patch };
      return store[id];
    },
    armFetch: (id) => {
      armed.push(id);
      store[id] = { ...store[id], memberFetchDueAt: "2026-09-04T01:08:00.000Z" };
      return store[id];
    },
  });
  assert.equal(result.resumed, true);
  assert.equal(result.mailed, false);
  assert.equal(mails.length, 0);
  assert.deepEqual(armed, [7]);
  assert.equal(store[7].notificationsPaused, false);
  assert.equal(store[7].inactivityPaused, false);

  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const after = src.slice(src.indexOf("function afterMemberSession"), src.indexOf('app.get("/verify-email"'));
  assert.match(after, /resumeIdleIfNeeded/);
  assert.doesNotMatch(after, /queueSystemMail/);
  const me = src.slice(src.indexOf('app.get("/api/me"'), src.indexOf("app.patch(\"/api/profile\""));
  assert.match(me, /touchLastLogin\(session\.userId/);
  assert.match(me, /minIntervalMs: 12 \* 60 \* 60 \* 1000/);
});

test("used verify token stays findable as used, empty token is missing", () => {
  const db = memoryDb();
  const user = registerUser(db, {
    email: "v@b.com",
    password: "password1",
    acceptDisclaimer: true,
    emailVerified: false,
  });
  const { token } = issueVerifyToken(db, user.id);
  confirmVerifyToken(db, token);
  try {
    confirmVerifyToken(db, token);
    assert.fail("expected used");
  } catch (error) {
    assert.equal(error.code, "used");
  }
  try {
    confirmVerifyToken(db, "");
    assert.fail("expected missing");
  } catch (error) {
    assert.equal(error.code, "missing");
  }
  try {
    confirmVerifyToken(db, "no-such-token");
    assert.fail("expected missing");
  } catch (error) {
    assert.equal(error.code, "missing");
  }
});
