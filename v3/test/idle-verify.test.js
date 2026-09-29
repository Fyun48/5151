import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import {
  IDLE_PAUSE_MS,
  listIdleMemberIds,
  registerUser,
  touchLastLogin,
} from "../src/members.js";
import { confirmVerifyToken, issueVerifyToken } from "../src/emailVerify.js";
import { applyIdlePauseToMembers, applyIdleResume, applyIdleResumeAsync } from "../src/idlePause.js";
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
  // 第七十一批：`/api/me` 改走 PG 島嶼（同步版讀本機 ⇒ PG 站會顯示別台節點看不到的舊資料），
  // 但「同一個 12 小時節流」的契約不變。
  assert.match(me, /await touchLastLoginAsync\(session\.userId/);
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

test("applyIdleResumeAsync 與同步版逐欄相同（PG 島嶼用；三種情境都要一樣）", async () => {
  // 同步版與 async 版是兩份實作，所以要用**同一組注入回呼**比對三種情境：
  // 沒暫停、暫停中（要恢復）、恢復後仍暫停（不再 arm）。少一種就會有分支沒被比到。
  const cases = [
    { name: "沒暫停", current: { inactivityPaused: false } },
    { name: "暫停中", current: { inactivityPaused: true, notificationsPaused: true } },
    { name: "已恢復但通知仍關", current: { inactivityPaused: true, notificationsPaused: true, keepPaused: true } },
  ];
  for (const { name, current } of cases) {
    const make = () => {
      const state = { saved: null, armed: 0, settings: { ...current } };
      return {
        state,
        deps: {
          getSettings: (uid) => { assert.equal(uid, 7); return { ...state.settings }; },
          saveSettings: (uid, patch) => {
            assert.equal(uid, 7);
            state.saved = patch;
            state.settings = { ...state.settings, ...patch };
            // 「已恢復但通知仍關」：假的回傳值讓 armFetch 這條分支被走到／不被走到
            if (state.settings.keepPaused) state.settings.notificationsPaused = true;
            return { ...state.settings };
          },
          armFetch: (uid) => { assert.equal(uid, 7); state.armed += 1; return { ...state.settings, armed: true }; },
        },
      };
    };
    const syncWorld = make();
    const asyncWorld = make();
    const syncOut = applyIdleResume(7, syncWorld.deps);
    const asyncOut = await applyIdleResumeAsync(7, asyncWorld.deps);
    assert.deepEqual(asyncOut, syncOut, `${name}：回傳值必須逐欄相同`);
    assert.deepEqual(asyncWorld.state.saved, syncWorld.state.saved, `${name}：寫入的旗標必須相同`);
    assert.equal(asyncWorld.state.armed, syncWorld.state.armed, `${name}：armFetch 的次數必須相同`);
  }
  // uid 0 與空設定：兩邊都要早退，不得寫入
  assert.deepEqual(await applyIdleResumeAsync(0, {}), applyIdleResume(0, {}));
});
