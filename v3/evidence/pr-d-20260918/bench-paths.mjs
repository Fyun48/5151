/**
 * PR D representative seeded benchmark (Issue #325 PART P / PART R items 12 + 26-27).
 *
 * Local, seeded, in-memory SQLite only. It never touches Production, never opens a
 * socket and never mutates anything outside its own :memory: database.
 *
 * Run:  node v3/evidence/pr-d-20260918/bench-paths.mjs
 * Out:  paths-bench.json + a markdown table on stdout
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { ensureDemandSchema, setRentalCatalogCache, setRentalMarketplaceFlags } from "../../src/demand.js";
import { defaultCatalog } from "../../src/rentalCatalog.js";
import {
  RENTAL_DIGEST_MAX_ITEMS,
  RENTAL_NOTIFY_BATCH,
  addDigestItem,
  cleanupRentalNotify,
  closeDigestBuckets,
  deliverQueuedNotifications,
  emitRentalNotifyEvent,
  ensureRentalNotifySchema,
  explainRentalNotifyPlans,
  listDueMatchSubscriptions,
  openMatchEpisodeIfNeeded,
  recheckSeenMatchEligibility,
  saveMatchSubscription,
  scheduleLifecycleReminders,
  scheduleOfferExpiring,
  scheduleOwnerRetention,
  scheduleTenantRetention,
  setRentalNotifyDockWriter,
  setRentalNotifyHydrate,
} from "../../src/rentalNotify.js";
import { runRentalNotifyTick } from "../../src/rentalNotifyWorker.js";
import {
  recordShareEvent,
  resetShareGrowthLimits,
  resolveValidShareToken,
} from "../../src/rentalShareGrowth.js";
import { submitCompletionSurvey, surveyAggregate } from "../../src/rentalSurvey.js";
import {
  ANALYTICS_DRILL_MAX,
  ANALYTICS_MAX_DAYS,
  rentalOpsDrilldown,
  rentalOpsSummary,
} from "../../src/rentalOpsAnalytics.js";
import { ensureWishOfferSchema, explainWishOfferPlans } from "../../src/wishOffers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-09-17T12:00:00.000Z");
const DAY_MS = 86400000;

// In-app channels on and outbound (mail / push) explicitly off. The digest switch is ON
// here on purpose so the digest bucket sweep is actually exercised by the benchmark; it is
// NOT the posture Production runs today (Production keeps digest / mail / push OFF until
// the outbound gate gets its own approval). See README.md.
const FLAGS = {
  rental_catalog_v2: { enabled: true },
  wish: {
    lifecycle_enabled: true,
    owner_matching_enabled: true,
    offer_enabled: true,
    public_share_v2_enabled: true,
    owner_notifications_enabled: true,
    notifications_enabled: true,
    digest_enabled: true,
    outbound_mail_enabled: false,
    outbound_push_enabled: false,
  },
};

const SEED = {
  // One user per seeded wish: demand_posts enforces one open/draft wish per user
  // (idx_demand_one_mutable), so sharing users would violate a real invariant.
  users: 12000,
  listings: 6000,
  wishes: 12000,
  offers: 8000,
  notify_events: 30000,
  notify_deliveries: 30000,
  digest_items: 4000,
  match_subscriptions: 2000,
  match_seen: 20000,
  share_events: 15000,
  analytics_days: 200,
};

function tokenOf(index) {
  return `bench-wish-token-${String(index).padStart(6, "0")}`.padEnd(32, "0");
}

function isoOf(offsetMs) {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      post_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '房',
      url TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      last_seen_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      last_event TEXT NOT NULL DEFAULT 'new',
      source TEXT NOT NULL DEFAULT 'self',
      listed_by_user_id INTEGER,
      self_status TEXT DEFAULT 'open'
    );
  `);
  ensureWishOfferSchema(db);
  setRentalMarketplaceFlags(FLAGS);
  setRentalCatalogCache(defaultCatalog());
  setRentalNotifyHydrate(FLAGS);
  setRentalNotifyDockWriter(() => ({ ok: true }));
  resetShareGrowthLimits();
  return db;
}

function seed(db) {
  db.exec("BEGIN");
  const user = db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (?, ?, ?, ?)");
  for (let i = 1; i <= SEED.users; i += 1) user.run(i, `bench${i}@example.com`, `會員${i}`, "2026-01-01T00:00:00.000Z");

  const listing = db.prepare("INSERT INTO listings(post_id, title, source, listed_by_user_id, self_status) VALUES (?, ?, 'self', ?, ?)");
  for (let i = 1; i <= SEED.listings; i += 1) {
    listing.run(i, `站內刊登 ${i}`, (i % 3000) + 1, i % 2 === 1 ? "open" : "closed");
  }

  const wish = db.prepare(`
    INSERT INTO demand_posts(user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at,
      expires_at, public_token, lifecycle, last_active_at, updated_at)
    VALUES (?, '["1-8"]', ?, 'whole', 0, '找房', ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 1; i <= SEED.wishes; i += 1) {
    const uid = i;
    const kind = i % 6; // 0..1 open/active, 2 needs_confirmation, 3 completed, 4 paused, 5 draft
    let status = "open";
    let lifecycle = "active";
    if (kind === 2) lifecycle = "needs_confirmation";
    if (kind === 3) lifecycle = "completed";
    if (kind === 4) { lifecycle = "paused"; status = "closed"; }
    if (kind === 5) { lifecycle = "draft"; status = "draft"; }
    wish.run(
      uid,
      12000 + (i % 40) * 500,
      status,
      isoOf(-((i % 30) + 1) * DAY_MS),
      isoOf(((kind % 3) - 1) * 2 * DAY_MS + (i % 40) * 3600000),
      tokenOf(i),
      lifecycle,
      isoOf(-((i % 45) + 1) * DAY_MS - (i % 24) * 3600000),
      isoOf(-((i % 10) + 1) * 3600000),
    );
  }

  const offer = db.prepare(`
    INSERT INTO wish_offers(public_token, wish_id, listing_id, owner_user_id, tenant_user_id, status,
      created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let i = 1; i <= SEED.offers; i += 1) {
    offer.run(
      `bench-offer-token-${String(i).padStart(6, "0")}`.padEnd(32, "0"),
      (i % SEED.wishes) + 1,
      (i % SEED.listings) + 1,
      (i % 3000) + 1,
      (i % SEED.users) + 1,
      ["pending", "accepted", "declined", "expired"][i % 4],
      isoOf(-((i % 30) + 1) * DAY_MS - (i % 24) * 3600000),
      isoOf(-((i % 5) + 1) * 3600000),
      isoOf(((i % 7) - 3) * DAY_MS),
    );
  }

  const event = db.prepare(`
    INSERT INTO rental_notify_events(event_key, event_type, user_id, subject_type, subject_ref, payload_json, created_at)
    VALUES (?, 'wish_lifecycle_due_3d', ?, 'wish', ?, '{}', ?)
  `);
  for (let i = 1; i <= SEED.notify_events; i += 1) {
    event.run(`bench-event-${i}`, (i % SEED.users) + 1, tokenOf((i % SEED.wishes) + 1), isoOf(-(i % 72) * 3600000));
  }

  const delivery = db.prepare(`
    INSERT INTO rental_notify_deliveries(event_id, user_id, channel, status, attempt, next_retry_at, last_error, created_at, updated_at)
    VALUES (?, ?, 'dock', ?, ?, ?, '', ?, ?)
  `);
  for (let i = 1; i <= SEED.notify_deliveries; i += 1) {
    const status = i % 10 === 0 ? "queued" : i % 10 === 1 ? "retrying" : "sent";
    delivery.run(
      (i % SEED.notify_events) + 1,
      (i % SEED.users) + 1,
      status,
      i % 5,
      status === "sent" ? null : isoOf(((i % 5) - 2) * 3600000),
      isoOf(-(i % 48) * 3600000),
      isoOf(-(i % 24) * 3600000),
    );
  }
  db.exec("COMMIT");

  // Volumes that are cheaper and more faithful when seeded through the real APIs.
  db.exec("BEGIN");
  for (let i = 1; i <= SEED.match_subscriptions; i += 1) {
    // post_id p is owned by (p % 3000) + 1, so owner u owns p = u - 1 + 3000k.
    const owner = (i % 3000) + 1;
    saveMatchSubscription(db, owner, owner + 2999, i % 2 === 0 ? "instant" : "daily_digest", NOW);
  }
  for (let i = 1; i <= SEED.match_seen; i += 1) {
    const owner = (i % 3000) + 1;
    openMatchEpisodeIfNeeded(db, owner, owner + 2999, tokenOf((i % SEED.wishes) + 1), NOW);
  }
  for (let i = 1; i <= SEED.digest_items; i += 1) {
    addDigestItem(db, {
      userId: (i % 3000) + 1,
      eventId: (i % SEED.notify_events) + 1,
      listingId: (i % SEED.listings) + 1,
      wishRef: tokenOf((i % SEED.wishes) + 1),
      now: NOW,
    });
  }
  // Yesterday's open buckets, so the digest close sweep has real work to do.
  for (let i = 1; i <= 400; i += 1) {
    const userId = 7000 + i;
    addDigestItem(db, {
      userId,
      eventId: (i % SEED.notify_events) + 1,
      listingId: (i % SEED.listings) + 1,
      wishRef: tokenOf((i % SEED.wishes) + 1),
      now: new Date(NOW.getTime() - DAY_MS),
    });
  }
  // Completed wishes get a bounded sample of submitted surveys for the aggregate path.
  let surveys = 0;
  for (let i = 3; i <= SEED.wishes && surveys < 600; i += 6) {
    const row = db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(i);
    if (!row) continue;
    try {
      submitCompletionSurvey(db, row.user_id, row, { found_via_site: "yes", via_feature: "wish_match" }, NOW);
      surveys += 1;
    } catch {
      // a completed wish without the survey contract is skipped, not a failure
    }
  }
  for (let i = 1; i <= SEED.share_events; i += 1) {
    recordShareEvent(db, {
      shareToken: tokenOf((i % SEED.wishes) + 1),
      eventType: i % 5 === 0 ? "cta" : "view",
      ip: `203.0.113.${i % 250}`,
      userAgent: `bench-agent/${i}`,
      now: NOW,
    });
  }
  for (let i = 0; i < SEED.analytics_days; i += 1) {
    const day = new Date(NOW.getTime() - (i + 1) * DAY_MS).toISOString().slice(0, 10);
    db.prepare("INSERT INTO rental_analytics_daily(day, metric, value) VALUES (?, 'notify_generated', ?)").run(day, 10 + i);
    db.prepare("INSERT INTO rental_analytics_daily(day, metric, value) VALUES (?, 'notify_queued', ?)").run(day, 8 + i);
  }
  db.exec("COMMIT");
  return db;
}

function round(n) {
  return Number(Number(n).toFixed(3));
}

// Token-like strings are redacted before anything is written to the evidence files:
// the seeded public tokens and wish refs are random and would otherwise look like
// credentials to secret scanners.
const TOKENISH = /^[A-Za-z0-9_-]{16,}$/;

function scrub(value) {
  if (typeof value === "string") return TOKENISH.test(value) ? "<redacted-token>" : value;
  return value;
}

function summarizeResult(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return { rows: value.length };
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") out[k] = scrub(v);
    }
    return Object.keys(out).length ? out : { keys: Object.keys(value).length };
  }
  return { value: scrub(value) };
}

function measure(label, fn, { iterations = 5, warmup = 1, mutates = false, note = "" } = {}) {
  let last;
  let error = "";
  const samples = [];
  try {
    if (mutates) {
      // Mutating paths advance state, so they get a single warm-up-free short run.
      for (let i = 0; i < 3; i += 1) {
        const t0 = performance.now();
        last = fn();
        samples.push(performance.now() - t0);
      }
      iterations = samples.length;
    } else {
      for (let i = 0; i < warmup; i += 1) last = fn();
      for (let i = 0; i < iterations; i += 1) {
        const t0 = performance.now();
        last = fn();
        samples.push(performance.now() - t0);
      }
    }
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    label,
    mutates,
    note,
    iterations: samples.length,
    median_ms: sorted.length ? round(sorted[Math.floor(sorted.length / 2)]) : null,
    min_ms: sorted.length ? round(sorted[0]) : null,
    max_ms: sorted.length ? round(sorted[sorted.length - 1]) : null,
    result: summarizeResult(last),
    error,
  };
}

function runPaths(db) {
  const from = "2026-09-01";
  const to = "2026-09-17";
  const paths = [];
  const push = (row) => paths.push(row);

  push(measure("due lifecycle reminders (scheduleLifecycleReminders)", () => scheduleLifecycleReminders(db, NOW, { limit: RENTAL_NOTIFY_BATCH }), { mutates: true, note: "bounded 80/tick, cursor-paged" }));
  push(measure("notification dedup lookup (emitRentalNotifyEvent, second call)", () => emitRentalNotifyEvent(db, {
    eventType: "wish_lifecycle_due_3d", userId: 7, eventKey: "bench-dedup-lookup", subjectType: "wish", subjectRef: tokenOf(7), now: NOW,
  }), { note: "UNIQUE event_key dedup path" }));
  push(measure("pending delivery retry (deliverQueuedNotifications)", () => deliverQueuedNotifications(db, NOW, { limit: RENTAL_NOTIFY_BATCH }), { mutates: true, note: "bounded 80/batch" }));
  push(measure("digest bucket lookup (addDigestItem)", () => addDigestItem(db, { userId: 11, eventId: 1, listingId: 1, wishRef: tokenOf(11), now: NOW }), { note: `item cap ${RENTAL_DIGEST_MAX_ITEMS}/bucket` }));
  push(measure("owner subscription lookup (listDueMatchSubscriptions)", () => listDueMatchSubscriptions(db, { limit: RENTAL_NOTIFY_BATCH, now: NOW }), { note: "bounded 80/tick" }));
  push(measure("new-match notification dedup (openMatchEpisodeIfNeeded)", () => openMatchEpisodeIfNeeded(db, 2, 3001, tokenOf(2), NOW), { note: "rental_match_seen lookup" }));
  push(measure("new-match eligibility recheck (recheckSeenMatchEligibility)", () => recheckSeenMatchEligibility(db, 2, 3001, { now: NOW, limit: RENTAL_NOTIFY_BATCH }), { mutates: true, note: "bounded 80/batch" }));
  push(measure("completion survey due lookup (raw path used by the notify tick)", () => db.prepare("SELECT id FROM demand_posts WHERE lifecycle = 'completed' ORDER BY updated_at DESC LIMIT 80").all(), { note: "bounded 80" }));
  push(measure("survey aggregate over a bounded range (surveyAggregate)", () => surveyAggregate(db, { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` }), { note: "GROUP BY found_via_site" }));
  push(measure("analytics timeseries range (rentalOpsSummary)", () => rentalOpsSummary(db, { from, to }), { note: `range clamp ${ANALYTICS_MAX_DAYS} days` }));
  push(measure("admin drill-down pagination (rentalOpsDrilldown offers)", () => rentalOpsDrilldown(db, { kind: "offers", cursor: 0, limit: 20, from, to }), { note: `page cap ${ANALYTICS_DRILL_MAX}` }));
  push(measure("attribution conversion lookup (resolveValidShareToken)", () => resolveValidShareToken(db, tokenOf(3)), { note: "token lookup" }));
  push(measure("attribution conversion write (recordShareEvent signup, server source)", () => recordShareEvent(db, {
    shareToken: tokenOf(3), eventType: "signup", source: "server", userId: 21, ip: "203.0.113.9", userAgent: "bench/1", now: NOW,
  }), { mutates: true, note: "server-source conversion; public cta/server is refused by design" }));
  push(measure("offer expiring sweep (scheduleOfferExpiring)", () => scheduleOfferExpiring(db, NOW, { limit: RENTAL_NOTIFY_BATCH }), { mutates: true, note: "bounded 80/tick" }));
  push(measure("tenant retention sweep (scheduleTenantRetention)", () => scheduleTenantRetention(db, NOW, { limit: RENTAL_NOTIFY_BATCH }), { mutates: true, note: "bounded 80/tick" }));
  push(measure("owner retention sweep (scheduleOwnerRetention)", () => scheduleOwnerRetention(db, NOW, { limit: RENTAL_NOTIFY_BATCH }), { mutates: true, note: "bounded 80/tick" }));
  push(measure("digest bucket close (closeDigestBuckets)", () => closeDigestBuckets(db, NOW, { limit: RENTAL_NOTIFY_BATCH }), { mutates: true, note: "bounded 80/tick" }));
  push(measure("event/delivery cleanup (cleanupRentalNotify)", () => cleanupRentalNotify(db, NOW, { limit: RENTAL_NOTIFY_BATCH }), { mutates: true, note: `retention ${"180d"} events` }));
  push(measure("notify worker tick end to end (runRentalNotifyTick)", () => runRentalNotifyTick(db, NOW, { flags: FLAGS }), { mutates: true, note: "the real worker entry point" }));
  return paths;
}

function classifyPlan(planRows) {
  const rows = Array.isArray(planRows) ? planRows : [];
  const details = rows.map((r) => String(r.detail || r.error || ""));
  const text = details.join(" | ");
  const indexes = [...new Set((text.match(/USING (COVERING )?INDEX [A-Za-z0-9_]+/g) || []).map((m) => m.replace("USING INDEX ", "").replace("USING COVERING INDEX ", "cover:")))];
  const searchNodes = (text.match(/SEARCH/g) || []).length;
  const scanNodes = (text.match(/SCAN/g) || []).length;
  return { indexes, search_nodes: searchNodes, scan_nodes: scanNodes, scans_present: scanNodes > 0, details };
}

function collectPlans(db) {
  const out = {};
  for (const [key, rows] of Object.entries(explainRentalNotifyPlans(db))) out[`notify.${key}`] = classifyPlan(rows);
  for (const [key, rows] of Object.entries(explainWishOfferPlans(db))) out[`offer.${key}`] = classifyPlan(rows);
  return out;
}

// Only thresholds that already exist in the repo are used; nothing is relaxed.
const THRESHOLDS = [
  {
    name: "notify EXPLAIN probe + seeded dedup/retry queries",
    limit_ms: 200,
    source: "v3/test/rental-notify.test.js:449 (assert.ok(elapsed < 200))",
  },
];

const COUNT_TABLES = [
  "users", "listings", "demand_posts", "wish_offers", "rental_notify_events",
  "rental_notify_deliveries", "rental_digest_buckets", "rental_digest_items",
  "rental_match_subscriptions", "rental_match_seen", "rental_share_events",
  "rental_analytics_daily", "rental_completion_surveys",
];

function main() {
  const started = performance.now();
  const db = open();
  const seedStart = performance.now();
  seed(db);
  const seedMs = performance.now() - seedStart;

  const counts = {};
  for (const table of COUNT_TABLES) {
    try {
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) || 0;
    } catch {
      counts[table] = null;
    }
  }

  const paths = runPaths(db);
  const explain = collectPlans(db);
  db.close();

  const report = {
    schema: "pr-d-paths-bench-v1",
    generated_at: new Date().toISOString(),
    issue: "#325 PART P / PART R items 12 + 26-27",
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      sqlite: "node:sqlite DatabaseSync(:memory:)",
      data: "seeded only; no Production data, no network, no writes outside this process",
      posture_measured: "seeded benchmark posture: Stage 1-4 in-app ON, digest ON (to exercise the digest sweep), mail/push OFF. Production today keeps digest/mail/push OFF.",
    },
    dataset: { seed: SEED, actual_counts: counts, seed_ms: round(seedMs), total_ms: round(performance.now() - started) },
    bounds: {
      notify_batch: RENTAL_NOTIFY_BATCH,
      digest_items_per_bucket: RENTAL_DIGEST_MAX_ITEMS,
      analytics_drill_max: ANALYTICS_DRILL_MAX,
      analytics_range_days: ANALYTICS_MAX_DAYS,
    },
    thresholds: THRESHOLDS,
    errors: paths.filter((p) => p.error).map((p) => ({ label: p.label, error: p.error })),
    paths,
    explain,
  };

  mkdirSync(HERE, { recursive: true });
  writeFileSync(path.join(HERE, "paths-bench.json"), `${JSON.stringify(report, null, 2)}\n`);

  const lines = [];
  lines.push(`# PR D seeded path benchmark — ${report.generated_at}`);
  lines.push("");
  lines.push(`node ${report.environment.node} / ${report.environment.platform}; in-memory SQLite; seed ${round(seedMs)} ms; total ${report.dataset.total_ms} ms`);
  lines.push("");
  lines.push("| path | median ms | min | max | iters | bounds/notes | result |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const p of paths) {
    lines.push(`| ${p.label} | ${p.median_ms ?? "ERR"} | ${p.min_ms ?? ""} | ${p.max_ms ?? ""} | ${p.iterations} | ${p.note} | ${p.error ? `ERROR: ${p.error}` : JSON.stringify(p.result)} |`);
  }
  lines.push("");
  lines.push("## EXPLAIN QUERY PLAN (index usage)");
  lines.push("");
  lines.push("| path | indexes | SEARCH nodes | SCAN nodes |");
  lines.push("|---|---|---|---|");
  for (const [key, value] of Object.entries(explain)) {
    lines.push(`| ${key} | ${value.indexes.join(", ") || "-"} | ${value.search_nodes} | ${value.scan_nodes} |`);
  }
  const explainEntries = Object.values(explain);
  const searchOnly = explainEntries.filter((v) => v.search_nodes > 0 && v.scan_nodes === 0).length;
  const withScan = explainEntries.filter((v) => v.scan_nodes > 0).length;
  lines.push("");
  lines.push(`${explainEntries.length} paths total: ${searchOnly} are index SEARCH paths with no SCAN node, ${withScan} contains a SCAN node (see the table for which one).`);
  lines.push("");
  lines.push(`## Row counts after seeding`);
  lines.push("");
  for (const [table, n] of Object.entries(counts)) lines.push(`- ${table}: ${n === null ? "n/a" : n}`);
  writeFileSync(path.join(HERE, "paths-bench.md"), `${lines.join("\n")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
