import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activityBucket,
  activityScoreFromSignals,
  canSelfTransition,
  createPublicToken,
  mapLegacyLifecycle,
  migrateOpenWishOnActivation,
  planLifecycleTick,
  remainingTtlDays,
  shouldApplyLifecyclePlan,
  transitionLifecycle,
  ttlExpiresAt,
  visibilityStatusFor,
} from "../src/wishLifecycle.js";
import { runWishLifecycleTick, startWishLifecycleLoop } from "../src/wishLifecycleLoop.js";

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
  const confirmed = transitionLifecycle({
    status: "open",
    lifecycle: "needs_confirmation",
    continuous_active_from: started,
    last_confirmed_at: "2026-11-01T00:00:00.000Z",
  }, "confirm", now);
  assert.equal(confirmed.lifecycle, "active");
  assert.equal(confirmed.require_reconfirm, undefined);
  assert.equal(confirmed.continuous_active_from, now.toISOString());
  assert.equal(confirmed.last_confirmed_at, now.toISOString());
  assert.equal(confirmed.expires_at, ttlExpiresAt(now, 14));
  const later = transitionLifecycle(confirmed, "extend", new Date("2026-11-20T00:00:00.000Z"));
  assert.equal(later.lifecycle, "active");
  assert.equal(later.require_reconfirm, undefined);
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
  assert.equal(afterGrace.lifecycle, "expired");
  assert.equal(afterGrace.status, "expired");
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
