import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  activityBucket,
  activityScoreFromSignals,
  canSelfTransition,
  createPublicToken,
  mapLegacyLifecycle,
  isLegacyWishForActivation,
  migrateOpenWishOnActivation,
  planLifecycleTick,
  remainingTtlDays,
  shouldApplyLifecyclePlan,
  transitionLifecycle,
  ttlExpiresAt,
  visibilityStatusFor,
} from "../src/wishLifecycle.js";
import { ensureDemandSchema } from "../src/demand.js";
import { runWishLifecycleTick, startWishLifecycleLoop } from "../src/wishLifecycleLoop.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const TICK_NOW = new Date("2026-09-17T00:00:00.000Z");
const LIFECYCLE_ON = { wish: { lifecycle_enabled: true } };

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-wish-lifecycle-"));
  const moduleUrl = (relative) => pathToFileURL(path.join(dir, relative)).href;
  const script = `
    import assert from "node:assert/strict";
    import path from "path";
    import { DatabaseSync } from "node:sqlite";
    import * as app from ${JSON.stringify(moduleUrl("../src/db.js"))};
    import { getNotifyCursor } from ${JSON.stringify(moduleUrl("../src/rentalNotify.js"))};
    import { WISH_LIFECYCLE_CURSOR_JOB } from ${JSON.stringify(moduleUrl("../src/wishLifecycleLoop.js"))};
    ${body}
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** active、TTL 未到、但長期未確認 → 下一次 tick 會轉 needs_confirmation（再用來偵測是否被重複掃描）。 */
function seedDueWish(db, id, now = TICK_NOW) {
  const idle = new Date(now.getTime() - 40 * 86400000).toISOString();
  db.prepare(
    `INSERT INTO demand_posts
       (id, user_id, status, lifecycle, expires_at, last_confirmed_at, last_active_at, created_at)
     VALUES (?, ?, 'open', 'active', ?, ?, ?, ?)`,
  ).run(id, id, new Date(now.getTime() + 30 * 86400000).toISOString(), idle, idle, idle);
}

/** active 且剛確認過 → 掃到也不會變更，用來單純驗證掃描範圍。 */
function seedIdleWish(db, id, now = TICK_NOW) {
  const stamp = now.toISOString();
  db.prepare(
    `INSERT INTO demand_posts
       (id, user_id, status, lifecycle, expires_at, last_confirmed_at, last_active_at, created_at)
     VALUES (?, ?, 'open', 'active', ?, ?, ?, ?)`,
  ).run(id, id, new Date(now.getTime() + 30 * 86400000).toISOString(), stamp, stamp, stamp);
}

/** 每位會員只能有一則 open 許願，所以測試資料一列一個 user_id。 */
function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)");
  for (const id of [1, 2, 3]) insert.run(id, `wish-seed-${id}@example.test`, TICK_NOW.toISOString());
  ensureDemandSchema(db);
  return db;
}

function recordingCursor(start = 0) {
  const state = { stored: start, writes: [] };
  return {
    state,
    cursor: {
      get: () => state.stored,
      set: (id) => { state.stored = id; state.writes.push(id); },
    },
  };
}

test("legacy status maps without destroying data", () => {
  assert.equal(mapLegacyLifecycle({ status: "open" }), "active");
  assert.equal(mapLegacyLifecycle({ status: "closed" }), "paused");
  assert.equal(mapLegacyLifecycle({ status: "closed", closed_reason: "completed" }), "completed");
  assert.equal(mapLegacyLifecycle({ status: "hidden" }), "blocked");
  assert.equal(visibilityStatusFor("needs_confirmation"), "open");
  assert.equal(visibilityStatusFor("paused"), "closed");
});

test("publish and extend use now + 14 days not stacked old expiry", () => {
  const now = new Date("2026-09-16T00:00:00.000Z");
  const first = transitionLifecycle({ status: "draft" }, "publish", now);
  assert.equal(first.lifecycle, "active");
  assert.equal(first.expires_at, ttlExpiresAt(now, 14));
  const later = new Date("2026-09-20T00:00:00.000Z");
  const extended = transitionLifecycle({
    status: "open",
    lifecycle: "active",
    expires_at: first.expires_at,
    continuous_active_from: first.continuous_active_from,
    last_confirmed_at: first.last_confirmed_at,
    published_at: first.published_at,
  }, "extend", later);
  assert.equal(extended.expires_at, ttlExpiresAt(later, 14));
  assert.ok(extended.expires_at > first.expires_at);
});

test("60 day continuous active requires reconfirm instead of blind +14", () => {
  const now = new Date("2026-11-16T00:00:00.000Z");
  const result = transitionLifecycle({
    status: "open",
    lifecycle: "active",
    continuous_active_from: "2026-09-16T00:00:00.000Z",
    last_confirmed_at: "2026-11-01T00:00:00.000Z",
  }, "extend", now);
  assert.equal(result.require_reconfirm, true);
  assert.equal(result.lifecycle, "needs_confirmation");
});

test("60 day reconfirm confirm action resets continuous window and returns active", () => {
  const started = "2026-09-16T00:00:00.000Z";
  const now = new Date("2026-11-16T00:00:00.000Z");
  const gated = transitionLifecycle({
    status: "open",
    lifecycle: "needs_confirmation",
    continuous_active_from: started,
    last_confirmed_at: "2026-11-01T00:00:00.000Z",
  }, "extend", now);
  assert.equal(gated.require_reconfirm, true);
  const blocked = transitionLifecycle({
    status: "open",
    lifecycle: "needs_confirmation",
    continuous_active_from: started,
    last_confirmed_at: "2026-11-01T00:00:00.000Z",
  }, "confirm", now);
  assert.equal(blocked.require_reconfirm, true);
  assert.equal(blocked.lifecycle, "needs_confirmation");
  assert.equal(blocked.continuous_active_from, undefined);
  const confirmed = transitionLifecycle({
    status: "open",
    lifecycle: "needs_confirmation",
    continuous_active_from: started,
    last_confirmed_at: "2026-11-01T00:00:00.000Z",
  }, "full_reconfirm", now);
  assert.equal(confirmed.lifecycle, "active");
  assert.equal(confirmed.require_reconfirm, undefined);
  assert.equal(confirmed.continuous_active_from, now.toISOString());
  assert.equal(confirmed.last_confirmed_at, now.toISOString());
  assert.equal(confirmed.expires_at, ttlExpiresAt(now, 14));
  const later = transitionLifecycle(confirmed, "extend", new Date("2026-11-20T00:00:00.000Z"));
  assert.equal(later.lifecycle, "active");
  assert.equal(later.require_reconfirm, undefined);
  assert.equal(canSelfTransition("active", "full_reconfirm"), false);
});

test("inactivity goes active → needs_confirmation → paused, never completed", () => {
  const now = new Date("2026-10-10T00:00:00.000Z");
  const confirm = planLifecycleTick({
    status: "open",
    lifecycle: "active",
    last_confirmed_at: "2026-09-20T00:00:00.000Z",
    expires_at: "2026-12-01T00:00:00.000Z",
  }, now);
  assert.equal(confirm.lifecycle, "needs_confirmation");
  const paused = planLifecycleTick({
    status: "open",
    lifecycle: "needs_confirmation",
    last_confirmed_at: "2026-09-10T00:00:00.000Z",
    expires_at: "2026-12-01T00:00:00.000Z",
  }, now);
  assert.equal(paused.lifecycle, "paused");
  assert.notEqual(paused.lifecycle, "completed");
});

test("completed cannot resume; blocked cannot self-resume", () => {
  assert.equal(canSelfTransition("completed", "resume"), false);
  assert.equal(canSelfTransition("blocked", "resume"), false);
  assert.equal(canSelfTransition("paused", "resume"), true);
  assert.throws(() => transitionLifecycle({ status: "closed", closed_reason: "completed" }, "resume"), /另開新的/);
  assert.throws(() => transitionLifecycle({ status: "hidden", lifecycle: "blocked" }, "resume"), /封鎖/);
});

test("extend vs expire race rechecks fresh row", () => {
  const now = new Date("2026-09-16T00:00:00.000Z");
  const planned = planLifecycleTick({
    status: "open",
    lifecycle: "active",
    expires_at: "2026-09-01T00:00:00.000Z",
    last_confirmed_at: "2026-08-20T00:00:00.000Z",
  }, now);
  assert.equal(planned.lifecycle, "needs_confirmation");
  const extended = {
    status: "open",
    lifecycle: "active",
    expires_at: "2026-09-30T00:00:00.000Z",
    last_confirmed_at: "2026-09-16T00:00:00.000Z",
  };
  assert.equal(shouldApplyLifecyclePlan(extended, planned, now), false);
});

test("TTL due enters confirmation; grace then expires not skip confirmation", () => {
  const published = "2026-09-01T00:00:00.000Z";
  const expires = ttlExpiresAt(new Date(published), 14);
  const due = planLifecycleTick({
    status: "open",
    lifecycle: "active",
    last_confirmed_at: published,
    expires_at: expires,
  }, new Date(expires));
  assert.equal(due.lifecycle, "needs_confirmation");
  assert.equal(due.status, "open");
  const duringGrace = planLifecycleTick({
    status: "open",
    lifecycle: "needs_confirmation",
    last_confirmed_at: published,
    expires_at: expires,
  }, new Date(Date.parse(expires) + 3 * 86400000));
  assert.equal(duringGrace, null);
  const afterGrace = planLifecycleTick({
    status: "open",
    lifecycle: "needs_confirmation",
    last_confirmed_at: published,
    expires_at: expires,
  }, new Date(Date.parse(expires) + 7 * 86400000));
  assert.equal(afterGrace.lifecycle, "paused");
  assert.equal(afterGrace.status, "closed");
});

test("14-day confirm keeps continuous window; 60-day confirm resets it", () => {
  const started = "2026-09-16T00:00:00.000Z";
  const day14 = new Date("2026-09-30T00:00:00.000Z");
  const stay = transitionLifecycle({
    status: "open",
    lifecycle: "needs_confirmation",
    continuous_active_from: started,
    last_confirmed_at: started,
  }, "confirm", day14);
  assert.equal(stay.lifecycle, "active");
  assert.equal(stay.continuous_active_from, started);
  assert.equal(stay.last_confirmed_at, day14.toISOString());
  const day60 = new Date("2026-11-16T00:00:00.000Z");
  const gated = transitionLifecycle({
    ...stay,
    continuous_active_from: started,
    last_confirmed_at: stay.last_confirmed_at,
  }, "extend", day60);
  assert.equal(gated.require_reconfirm, true);
  const blocked = transitionLifecycle({
    status: "open",
    lifecycle: "needs_confirmation",
    continuous_active_from: started,
    last_confirmed_at: stay.last_confirmed_at,
  }, "confirm", day60);
  assert.equal(blocked.require_reconfirm, true);
  assert.equal(blocked.continuous_active_from, undefined);
  const full = transitionLifecycle({
    status: "open",
    lifecycle: "needs_confirmation",
    continuous_active_from: started,
    last_confirmed_at: stay.last_confirmed_at,
  }, "full_reconfirm", day60);
  assert.equal(full.lifecycle, "active");
  assert.equal(full.continuous_active_from, day60.toISOString());
  const day30 = new Date("2026-10-16T00:00:00.000Z");
  assert.throws(() => transitionLifecycle({
    status: "open",
    lifecycle: "needs_confirmation",
    continuous_active_from: started,
    last_confirmed_at: stay.last_confirmed_at,
  }, "full_reconfirm", day30), /未滿期限|完整確認/);
  assert.throws(() => transitionLifecycle({
    status: "open",
    lifecycle: "active",
    continuous_active_from: started,
    last_confirmed_at: stay.last_confirmed_at,
  }, "full_reconfirm", day14), /狀態|完整確認|不能這樣/);
});

test("double tick is idempotent", () => {
  const row = {
    status: "expired",
    lifecycle: "expired",
    expires_at: "2026-09-01T00:00:00.000Z",
  };
  assert.equal(planLifecycleTick(row, new Date("2026-09-16T00:00:00.000Z")), null);
});

test("activity foundation uses buckets not a public score", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");
  assert.equal(activityBucket("2026-09-16T01:00:00.000Z", now), "today");
  assert.equal(activityBucket("2026-09-14T01:00:00.000Z", now), "within_3d");
  const scored = activityScoreFromSignals({ last_login_at: "2026-09-16T01:00:00.000Z" }, now);
  assert.ok(Number.isFinite(scored.activity_score));
  assert.equal(scored.activity_bucket, "today");
});

test("existing open migration resets TTL from activation time", () => {
  const now = new Date("2026-09-16T00:00:00.000Z");
  const migrated = migrateOpenWishOnActivation({
    status: "open",
    expires_at: "9999-12-31T00:00:00.000Z",
  }, now);
  assert.equal(migrated.expires_at, ttlExpiresAt(now, 14));
  assert.equal(migrated.last_confirmed_at, now.toISOString());
  assert.equal(migrated.last_active_at, now.toISOString());
  assert.equal(migrated.continuous_active_from, now.toISOString());
  const old = migrateOpenWishOnActivation({
    status: "open",
    last_confirmed_at: "2026-06-18T00:00:00.000Z",
    last_active_at: "2026-06-18T00:00:00.000Z",
    continuous_active_from: "2026-06-18T00:00:00.000Z",
  }, now);
  assert.equal(old.last_confirmed_at, now.toISOString());
  assert.equal(old.continuous_active_from, now.toISOString());
  assert.equal(isLegacyWishForActivation({
    status: "open",
    expires_at: ttlExpiresAt(now, 14),
    last_confirmed_at: now.toISOString(),
    continuous_active_from: now.toISOString(),
  }), false);
  assert.equal(migrateOpenWishOnActivation({
    status: "open",
    expires_at: ttlExpiresAt(now, 14),
    last_confirmed_at: "2026-06-18T00:00:00.000Z",
    continuous_active_from: "2026-06-18T00:00:00.000Z",
  }, now), null);
  assert.equal(migrateOpenWishOnActivation({ status: "closed" }, now), null);
});

test("opaque token is unguessable", () => {
  const a = createPublicToken();
  const b = createPublicToken();
  assert.equal(a.length, 32);
  assert.notEqual(a, b);
});

test("remaining TTL hides far-future sentinel", () => {
  assert.equal(remainingTtlDays("9999-12-31T00:00:00.000Z"), null);
  assert.ok(remainingTtlDays(ttlExpiresAt(new Date(), 14), Date.now()) >= 13);
});

test("worker skipped when lifecycle flag is off", () => {
  const result = runWishLifecycleTick({ prepare() { throw new Error("should not query"); } }, new Date(), {
    flags: { wish: { lifecycle_enabled: false } },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.changed, 0);
});

test("loop is non-reentrant", () => {
  let concurrent = 0;
  let max = 0;
  const loop = startWishLifecycleLoop(() => {
    concurrent += 1;
    max = Math.max(max, concurrent);
    concurrent -= 1;
    return { changed: 0 };
  }, { intervalMs: 10_000 });
  loop.tick();
  loop.tick();
  assert.equal(max, 1);
  loop.stop();
});

test("worker cursor advances so ids past the first batch still get scanned", () => {
  const db = memoryDb();
  for (const id of [1, 2, 3]) seedDueWish(db, id);
  const { state, cursor } = recordingCursor();
  const ticks = [0, 1, 2].map(() => runWishLifecycleTick(db, TICK_NOW, { limit: 1, flags: LIFECYCLE_ON, cursor }));
  assert.deepEqual(ticks.map((t) => t.after_id), [0, 1, 2]);
  assert.deepEqual(ticks.map((t) => t.next_id), [1, 2, 3]);
  assert.deepEqual(ticks.map((t) => t.changed), [1, 1, 1]);
  assert.deepEqual(state.writes, [1, 2, 3]);
  const states = db.prepare("SELECT lifecycle FROM demand_posts ORDER BY id").all().map((r) => r.lifecycle);
  assert.deepEqual(states, ["needs_confirmation", "needs_confirmation", "needs_confirmation"]);
});

test("worker without a cursor keeps the old rescan-first-batch behaviour", () => {
  const db = memoryDb();
  for (const id of [1, 2, 3]) seedDueWish(db, id);
  const first = runWishLifecycleTick(db, TICK_NOW, { limit: 1, flags: LIFECYCLE_ON });
  const second = runWishLifecycleTick(db, TICK_NOW, { limit: 1, flags: LIFECYCLE_ON });
  assert.equal(first.after_id, 0);
  assert.equal(second.after_id, 0);
  assert.equal(second.wrapped, false);
  assert.equal(db.prepare("SELECT lifecycle FROM demand_posts WHERE id = 1").get().lifecycle, "paused");
});

test("worker cursor wraps to the first batch once the tail is exhausted", () => {
  const db = memoryDb();
  for (const id of [1, 2, 3]) seedIdleWish(db, id);
  const { state, cursor } = recordingCursor(3);
  const tick = runWishLifecycleTick(db, TICK_NOW, { limit: 2, flags: LIFECYCLE_ON, cursor });
  assert.equal(tick.wrapped, true);
  assert.equal(tick.after_id, 3);
  assert.equal(tick.scanned, 2);
  assert.equal(tick.changed, 0);
  assert.equal(tick.next_id, 2);
  assert.deepEqual(state.writes, [2]);
});

test("worker cursor is left untouched when nothing is scanned", () => {
  const db = memoryDb();
  const { state, cursor } = recordingCursor(9);
  const tick = runWishLifecycleTick(db, TICK_NOW, { limit: 5, flags: LIFECYCLE_ON, cursor });
  assert.equal(tick.scanned, 0);
  assert.equal(tick.wrapped, true);
  assert.equal(tick.next_id, 9);
  assert.deepEqual(state.writes, []);
});

test("flag-off worker ignores the cursor entirely", () => {
  const { state, cursor } = recordingCursor(4);
  const result = runWishLifecycleTick({ prepare() { throw new Error("should not query"); } }, TICK_NOW, {
    flags: { wish: { lifecycle_enabled: false } },
    cursor,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.after_id, null);
  assert.equal(result.next_id, null);
  assert.deepEqual(state.writes, []);
});

test("production worker persists its cursor under the wish_lifecycle job key", () => {
  runIsolated(`
    app.saveRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
    const raw = new DatabaseSync(path.join(process.env.DATA_DIR, "v3.db"));
    const stamp = "2026-09-17T00:00:00.000Z";
    const idle = "2026-08-01T00:00:00.000Z";
    const now = new Date(stamp);
    const expires = new Date(now.getTime() + 30 * 86400000).toISOString();
    for (const id of [2, 3, 4]) {
      raw.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run(id, \`wish-lifecycle-\${id}@example.test\`, stamp);
    }
    for (const id of [1, 2, 3]) {
      raw.prepare(\`INSERT INTO demand_posts
          (id, user_id, status, lifecycle, expires_at, last_confirmed_at, last_active_at, created_at)
        VALUES (?, ?, 'open', 'active', ?, ?, ?, ?)\`).run(id, id + 1, expires, idle, idle, stamp);
    }
    const first = app.runWishLifecycleWorkerTick(now);
    assert.equal(first.skipped, false);
    assert.equal(first.after_id, 0);
    assert.equal(first.next_id, 3);
    assert.equal(getNotifyCursor(raw, WISH_LIFECYCLE_CURSOR_JOB), 3);
    const second = app.runWishLifecycleWorkerTick(now);
    assert.equal(second.after_id, 3);
    assert.equal(second.wrapped, true);
    assert.equal(second.next_id, 3);
  `);
});
