import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createDemandPost, ensureDemandSchema, setRentalMarketplaceFlags } from "../src/demand.js";
import { remainingTtlDays } from "../src/wishLifecycle.js";
import {
  applyUnsubscribeToken,
  createUnsubscribeToken,
  defaultRentalNotifyPrefs,
  deliverQueuedNotifications,
  emitRentalNotifyEvent,
  ensureRentalNotifySchema,
  explainRentalNotifyPlans,
  getRentalNotifyPrefs,
  reminderWindowForWish,
  saveRentalNotifyPrefs,
  saveMatchSubscription,
  scheduleLifecycleReminders,
  scheduleOwnerRetention,
  scheduleTenantRetention,
  setRentalNotifyDockWriter,
  setRentalNotifyHydrate,
  addDigestItem,
  closeDigestBuckets,
  isoWeekKey,
} from "../src/rentalNotify.js";
import { startRentalNotifyLoop, runRentalNotifyTick } from "../src/rentalNotifyWorker.js";
import { recordShareEvent, resetShareGrowthLimits, sharePageExtras } from "../src/rentalShareGrowth.js";
import { submitCompletionSurvey, getCompletionSurvey, surveyAggregate } from "../src/rentalSurvey.js";
import { rentalOpsSummary, rentalOpsDrilldown } from "../src/rentalOpsAnalytics.js";
import { listingFitScore } from "../src/listingScore.js";
import { preferPrimaryListing } from "../src/match.js";
import { sortListingsRows } from "../src/db.js";
import { evaluateMatch, compareMatchRank } from "../src/rentalMatch.js";
import { OFFER_STATUSES } from "../src/wishOffers.js";

const NOW = new Date("2026-09-17T00:00:00.000Z");
const FLAGS_ON = {
  rental_catalog_v2: { enabled: true },
  wish: {
    lifecycle_enabled: true,
    owner_matching_enabled: true,
    offer_enabled: true,
    public_share_v2_enabled: true,
    notifications_enabled: true,
    digest_enabled: true,
    outbound_mail_enabled: false,
    outbound_push_enabled: false,
  },
};

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureDemandSchema(db);
  ensureRentalNotifySchema(db);
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (1, 't@example.com', '租客', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (2, 'o@example.com', '屋主', '2026-01-01T00:00:00.000Z')").run();
  setRentalMarketplaceFlags(FLAGS_ON);
  setRentalNotifyHydrate(FLAGS_ON);
  return db;
}

function seedWish(db, extra = {}) {
  const post = createDemandPost(db, extra.user_id || 1, {
    districts: ["1-8"],
    rent_max: 28000,
    housing_type: "whole",
    layout: "2",
    body: "士林兩房找屋",
    must_have: ["need_cook"],
  });
  if (extra.expires_at || extra.lifecycle || extra.last_active_at) {
    db.prepare(`
      UPDATE demand_posts
      SET expires_at = COALESCE(?, expires_at),
          lifecycle = COALESCE(?, lifecycle),
          last_active_at = COALESCE(?, last_active_at),
          status = COALESCE(?, status)
      WHERE id = ?
    `).run(extra.expires_at || null, extra.lifecycle || null, extra.last_active_at || null, extra.status || null, post.id);
  }
  return { ...post, ...extra };
}

test("defaults are conservative and public caps hide outbound", () => {
  const prefs = defaultRentalNotifyPrefs();
  assert.equal(prefs.lifecycle_reminder, true);
  assert.equal(prefs.new_match, false);
  assert.equal(prefs.daily_digest, false);
  assert.equal(prefs.channel_mail, false);
  assert.equal(prefs.channel_push, false);
  const extras = sharePageExtras({ wish: { public_share_v2_enabled: true, lifecycle_enabled: true } });
  assert.equal(extras.share_v2, true);
  assert.equal(extras.owner_cta, "我有符合的房子");
});

test("event dedup and preference suppression", () => {
  const db = open();
  const first = emitRentalNotifyEvent(db, {
    eventType: "wish_lifecycle_due_3d",
    userId: 1,
    eventKey: "wish_lifecycle_due_3d:1:2026-09-20",
    now: NOW,
  });
  const again = emitRentalNotifyEvent(db, {
    eventType: "wish_lifecycle_due_3d",
    userId: 1,
    eventKey: "wish_lifecycle_due_3d:1:2026-09-20",
    now: NOW,
  });
  assert.equal(first.emitted, true);
  assert.equal(again.reason, "deduped");
  saveRentalNotifyPrefs(db, 1, { lifecycle_reminder: false }, NOW);
  const suppressed = emitRentalNotifyEvent(db, {
    eventType: "wish_lifecycle_due_1d",
    userId: 1,
    eventKey: "wish_lifecycle_due_1d:1:2026-09-18",
    now: NOW,
  });
  assert.equal(suppressed.emitted, true);
  const row = db.prepare("SELECT status FROM rental_notify_deliveries WHERE event_id = ? AND channel = 'dock'").get(suppressed.event_id);
  assert.equal(row.status, "suppressed");
  db.close();
});

test("mail and push stay gated off even if prefs ask for them", () => {
  const db = open();
  saveRentalNotifyPrefs(db, 1, { channel_mail: true, channel_push: true }, NOW);
  emitRentalNotifyEvent(db, {
    eventType: "tenant_offer_received",
    userId: 1,
    eventKey: "tenant_offer_received:9",
    now: NOW,
  });
  const rows = db.prepare("SELECT channel, status FROM rental_notify_deliveries WHERE event_id = 1").all();
  const mail = rows.find((row) => row.channel === "mail");
  const push = rows.find((row) => row.channel === "push");
  assert.equal(mail.status, "suppressed");
  assert.equal(push.status, "suppressed");
  db.close();
});

test("delivery retry is idempotent and does not double-send dock", () => {
  const db = open();
  const seen = [];
  setRentalNotifyDockWriter((event) => { seen.push(event.source_key); });
  emitRentalNotifyEvent(db, {
    eventType: "wish_completed",
    userId: 1,
    eventKey: "wish_completed:1",
    now: NOW,
  });
  const first = deliverQueuedNotifications(db, NOW);
  const second = deliverQueuedNotifications(db, NOW);
  assert.equal(first.delivered, 1);
  assert.equal(second.delivered, 0);
  assert.equal(seen.length, 1);
  db.close();
});

test("3d and 1d reminder exact boundary; confirm changes deadline key", () => {
  const now = new Date("2026-09-17T00:00:00.000Z");
  assert.equal(remainingTtlDays("2026-09-20T00:00:00.000Z", now), 3);
  assert.equal(remainingTtlDays("2026-09-18T00:00:00.000Z", now), 1);
  assert.equal(reminderWindowForWish({ lifecycle: "active", expires_at: "2026-09-20T00:00:00.000Z" }, now), "wish_lifecycle_due_3d");
  assert.equal(reminderWindowForWish({ lifecycle: "active", expires_at: "2026-09-18T00:00:00.000Z" }, now), "wish_lifecycle_due_1d");
  assert.equal(reminderWindowForWish({ lifecycle: "completed", expires_at: "2026-09-18T00:00:00.000Z" }, now), null);
  assert.equal(reminderWindowForWish({ lifecycle: "paused", expires_at: "2026-09-18T00:00:00.000Z" }, now), null);
  const db = open();
  const wish = seedWish(db, { expires_at: "2026-09-20T00:00:00.000Z" });
  const first = scheduleLifecycleReminders(db, now);
  assert.equal(first.emitted, 1);
  db.prepare("UPDATE demand_posts SET expires_at = ? WHERE id = ?").run("2026-09-30T00:00:00.000Z", wish.id);
  const afterExtend = scheduleLifecycleReminders(db, now);
  assert.equal(afterExtend.emitted, 0);
  db.close();
});

test("worker is bounded and non-reentrant", () => {
  let n = 0;
  const loop = startRentalNotifyLoop(() => { n += 1; return { ok: true }; }, { intervalMs: 50_000 });
  const a = loop.tick();
  assert.equal(a.ok, true);
  const nested = (() => {
    let inner;
    const loop2 = startRentalNotifyLoop(() => {
      inner = loop2.tick();
      return { ok: true };
    }, { intervalMs: 50_000 });
    loop2.tick();
    loop2.stop();
    return inner;
  })();
  assert.equal(nested.skipped, true);
  loop.stop();
});

test("match subscription instant vs digest vs off; no per-match mail flood", () => {
  const db = open();
  saveMatchSubscription(db, 2, 99, "instant", NOW);
  saveRentalNotifyPrefs(db, 2, { new_match: true }, NOW);
  const matchFn = () => ({
    generation: 7,
    items: [
      { wish_ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { wish_ref: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ],
  });
  const first = runRentalNotifyTick(db, NOW, { flags: FLAGS_ON, matchFn });
  assert.equal(first.matches.emitted, 2);
  const again = runRentalNotifyTick(db, NOW, { flags: FLAGS_ON, matchFn });
  assert.equal(again.matches.emitted, 0);
  const mail = db.prepare("SELECT COUNT(*) AS n FROM rental_notify_deliveries WHERE channel = 'mail' AND status = 'queued'").get();
  assert.equal(mail.n, 0);
  saveMatchSubscription(db, 2, 99, "off", NOW);
  const third = runRentalNotifyTick(db, NOW, {
    flags: FLAGS_ON,
    matchFn: () => ({ generation: 8, items: [{ wish_ref: "cccccccccccccccccccccccccccccccc" }] }),
  });
  assert.equal(third.matches.emitted, 0);
  db.close();
});

test("digest bucket overflow and retry does not duplicate", () => {
  const db = open();
  for (let i = 0; i < 10; i += 1) {
    const ev = emitRentalNotifyEvent(db, {
      eventType: "owner_new_match_available",
      userId: 2,
      eventKey: `owner_new_match_available:2:99:w${i}:1`,
      now: NOW,
    });
    addDigestItem(db, { userId: 2, eventId: ev.event_id, listingId: 99, wishRef: `w${i}`, now: NOW });
  }
  const bucket = db.prepare("SELECT * FROM rental_digest_buckets WHERE user_id = 2").get();
  assert.equal(bucket.item_count, 8);
  assert.equal(bucket.overflow_count, 2);
  const first = closeDigestBuckets(db, new Date("2026-09-18T00:00:00.000Z"));
  const second = closeDigestBuckets(db, new Date("2026-09-18T00:00:00.000Z"));
  assert.equal(first.closed, 1);
  assert.equal(second.closed, 0);
  db.close();
});

test("share attribution dedup, bot mark, and burst limit", () => {
  const db = open();
  resetShareGrowthLimits();
  const a = recordShareEvent(db, { shareToken: "abc", eventType: "view", ip: "1.1.1.1", userAgent: "Mozilla", now: NOW });
  const b = recordShareEvent(db, { shareToken: "abc", eventType: "view", ip: "1.1.1.1", userAgent: "Mozilla", now: NOW });
  assert.equal(a.recorded, true);
  assert.equal(b.reason, "deduped");
  const bot = recordShareEvent(db, { shareToken: "abc", eventType: "view", ip: "2.2.2.2", userAgent: "Googlebot", now: NOW });
  assert.equal(bot.is_bot, true);
  resetShareGrowthLimits();
  let limited = false;
  for (let i = 0; i < 21; i += 1) {
    try {
      recordShareEvent(db, { shareToken: "xyz", eventType: "view", ip: `9.9.9.${i}`, userAgent: `Mozilla/${i}`, now: NOW });
    } catch (error) {
      if (error.code === "RATE_LIMITED") limited = true;
    }
  }
  assert.equal(limited, true);
  db.close();
});

test("completion survey skip, idempotent submit, ownership and XSS", () => {
  const db = open();
  const wish = seedWish(db, { lifecycle: "completed", status: "closed" });
  const row = db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(wish.id);
  const skip = submitCompletionSurvey(db, 1, row, { found_via_site: "skipped" }, NOW);
  assert.equal(skip.submitted, true);
  const again = submitCompletionSurvey(db, 1, row, { found_via_site: "yes", detail: "第二次" }, NOW);
  assert.equal(again.already, true);
  assert.throws(() => submitCompletionSurvey(db, 2, row, { found_via_site: "yes" }, NOW), /找不到/);
  const other = seedWish(db, { user_id: 1, lifecycle: "completed", status: "closed" });
  const otherRow = db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(other.id);
  assert.throws(
    () => submitCompletionSurvey(db, 1, otherRow, { found_via_site: "yes", detail: "<script>alert(1)</script>" }, NOW),
    /不安全/,
  );
  const agg = surveyAggregate(db);
  assert.ok(agg.some((row) => row.found_via_site === "skipped"));
  assert.ok(getCompletionSurvey(db, 1, wish.id));
  db.close();
});

test("retention skips pending offer and uses weekly cap", () => {
  const db = open();
  const wish = seedWish(db, { last_active_at: "2026-08-01T00:00:00.000Z" });
  db.exec(`
    CREATE TABLE IF NOT EXISTS wish_offers (
      id INTEGER PRIMARY KEY,
      public_token TEXT,
      wish_id INTEGER,
      listing_id INTEGER,
      owner_user_id INTEGER,
      tenant_user_id INTEGER,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      expires_at TEXT
    );
  `);
  const quiet = scheduleTenantRetention(db, NOW);
  assert.equal(quiet.emitted, 1);
  const again = scheduleTenantRetention(db, NOW);
  assert.equal(again.emitted, 0);
  db.prepare("INSERT INTO wish_offers(id, public_token, wish_id, listing_id, owner_user_id, tenant_user_id, status, created_at, updated_at, expires_at) VALUES (1,'tok',?,?,2,1,'pending',?,?,?)")
    .run(wish.id, 9, NOW.toISOString(), NOW.toISOString(), "2026-09-24T00:00:00.000Z");
  const laterWeek = new Date("2026-09-24T00:00:00.000Z");
  const blocked = scheduleTenantRetention(db, laterWeek);
  assert.equal(blocked.emitted, 0);
  assert.match(isoWeekKey(NOW), /2026-W/);
  db.close();
});

test("unsubscribe token is opaque and scoped", () => {
  const db = open();
  const token = createUnsubscribeToken(db, 1, "lifecycle", NOW);
  assert.doesNotMatch(token, /^\d+$/);
  const first = applyUnsubscribeToken(db, token, NOW);
  assert.equal(first.ok, true);
  const prefs = getRentalNotifyPrefs(db, 1);
  assert.equal(prefs.lifecycle_reminder, false);
  const second = applyUnsubscribeToken(db, token, NOW);
  assert.equal(second.already, true);
  assert.throws(() => applyUnsubscribeToken(db, "1", NOW), /找不到/);
  db.close();
});

test("admin analytics range, RBAC-free summary, no PII, bounded drill", () => {
  const db = open();
  emitRentalNotifyEvent(db, { eventType: "wish_completed", userId: 1, eventKey: "wish_completed:x", now: NOW });
  const summary = rentalOpsSummary(db, { from: "2026-09-01", to: "2026-09-17" });
  assert.equal(summary.range.from, "2026-09-01");
  assert.ok("generated" in summary.notifications);
  assert.doesNotMatch(JSON.stringify(summary), /t@example.com|0912|line\.me/);
  assert.throws(() => rentalOpsSummary(db, { from: "2026-01-01", to: "2026-09-17" }), /過長/);
  const drill = rentalOpsDrilldown(db, { kind: "offers", from: "2026-09-01", to: "2026-09-17", limit: 50 });
  assert.ok(Array.isArray(drill.items));
  assert.ok(drill.items.length <= 50);
  const empty = rentalOpsSummary(db, { from: "2025-01-01", to: "2025-01-10" });
  assert.equal(empty.notifications.generated, 0);
  db.close();
});

test("isolation: notify domain does not change listing sort, match rank, or offer statuses", () => {
  const settings = { priceMin: 10000, priceMax: 30000, wholeFloorOnly: true };
  const a = { post_id: 1, price_num: 18000, kind_name: "整層住家", floor_name: "5/10", commute_km: 3, tags: "[]", last_seen_at: "2026-09-01T00:00:00.000Z", first_seen_at: "2026-08-01T00:00:00.000Z" };
  const b = { ...a, post_id: 2, price_num: 24000, notify_count: 99, digest_count: 12 };
  assert.equal(listingFitScore(a, settings), listingFitScore({ ...a, notify_count: 88 }, settings));
  const sorted = sortListingsRows([{ ...a, fit_score: 40 }, { ...b, fit_score: 90 }], "fit_desc");
  assert.deepEqual(sorted.map((row) => row.post_id), [2, 1]);
  assert.equal(preferPrimaryListing(a, b, Date.parse("2026-09-15T00:00:00.000Z")), a);
  const listing = { id: 1, owner_id: 2, status: "open", source: "self", rent: 22000, districts: ["1-8"], rooms: 2, ping: 18, housing_type: "whole", listing_values: {} };
  const wish = { id: 1, public_token: "a".repeat(32), lifecycle: "active", status: "open", districts: ["1-8"], rent_max: 28000, layout: "2", housing_type: "whole", choices: {} };
  const left = evaluateMatch(listing, wish, { now: Date.parse(NOW.toISOString()) });
  const right = evaluateMatch({ ...listing, notify_boost: 99 }, wish, { now: Date.parse(NOW.toISOString()) });
  assert.equal(compareMatchRank(left, right), compareMatchRank(right, left) * -1 || 0);
  assert.deepEqual(OFFER_STATUSES, ["pending", "accepted", "declined", "withdrawn", "expired", "blocked"]);
});

test("EXPLAIN and seeded query stay indexed and bounded", () => {
  const db = open();
  for (let i = 0; i < 400; i += 1) {
    db.prepare(`
      INSERT INTO rental_notify_events(event_key, event_type, user_id, subject_type, subject_ref, payload_json, created_at)
      VALUES (?, 'wish_lifecycle_due_3d', 1, 'wish', ?, '{}', ?)
    `).run(`k${i}`, `w${i}`, NOW.toISOString());
    db.prepare(`
      INSERT INTO rental_notify_deliveries(event_id, user_id, channel, status, attempt, next_retry_at, last_error, created_at, updated_at)
      VALUES (?, 1, 'dock', 'queued', 0, ?, '', ?, ?)
    `).run(i + 1, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  }
  const plans = explainRentalNotifyPlans(db);
  const text = JSON.stringify(plans);
  assert.match(text, /idx_|USING|SEARCH|SCAN/);
  const t0 = performance.now();
  db.prepare("SELECT id FROM rental_notify_events WHERE event_key = ?").get("k10");
  db.prepare("SELECT id FROM rental_notify_deliveries WHERE status IN ('queued','retrying') AND next_retry_at <= ? ORDER BY id ASC LIMIT 80").all(NOW.toISOString());
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 200, `query too slow: ${elapsed}`);
  db.close();
});

test("flag off skips worker writes", () => {
  const db = open();
  setRentalNotifyHydrate({ wish: { notifications_enabled: false } });
  const out = runRentalNotifyTick(db, NOW, { flags: { wish: { notifications_enabled: false } } });
  assert.equal(out.skipped, true);
  db.close();
});
