import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UAT_CONCLUSION,
  UAT_ITEMS,
  UAT_REQUIRED_DEPS,
  UAT_SCHEMA,
  assertNoUatSecrets,
  assertUatDeps,
  assertUatReadiness,
  expectAllowed,
  expectDenied,
  itemIds,
  makeRecorder,
  makeUatNamespace,
  pendingOffersFor,
  runProductionUat,
  summarize,
} from "../../.github/scripts/production-uat-stages-domain.mjs";

const stage14On = () => ({
  rental_catalog_v2: { enabled: true },
  wish: {
    lifecycle_enabled: true,
    owner_matching_enabled: true,
    offer_enabled: true,
    public_share_v2_enabled: true,
    owner_notifications_enabled: true,
    notifications_enabled: true,
    digest_enabled: false,
    outbound_mail_enabled: false,
    outbound_push_enabled: false,
  },
});

const TOKEN = "uat-share-token-0001";

function httpError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

/** A fake domain that mirrors the behaviours the real modules document. */
function makeDeps(overrides = {}) {
  const state = {
    flags: stage14On(),
    livePending: 0,
    burst: 0,
    accepted: false,
    blocked: false,
    prefs: { lifecycle_reminder: true, channel_dock: true, offer_transactional: true },
    eventKeys: new Set(),
    shareViews: 0,
    seenIdempotency: "",
  };
  const db = { prepare: () => ({ get: () => ({ n: state.livePending }) }) };
  const deps = {
    getRentalMarketplaceFlags: () => state.flags,
    getRentalCatalog: () => ({}),
    setWishOfferHydrate: () => true,
    setRentalNotifyHydrate: () => true,
    setRentalNotifyDockWriter: () => true,
    assertCreateOfferGates: (_db, { wishRow }) => {
      if (wishRow?.eligible !== true) throw httpError("not eligible", 409, "match_no_longer_eligible");
      return true;
    },
    insertPendingOffer: (_db, { idempotencyKey }) => {
      if (idempotencyKey === state.seenIdempotency) return { id: 1, public_token: "uat-offer-1", status: "pending" };
      state.seenIdempotency = idempotencyKey;
      state.livePending = 1;
      return { id: 1, public_token: "uat-offer-1", status: "pending" };
    },
    acceptWishOffer: (_db, userId) => {
      if (Number(userId) !== ctxIds.tenantId) throw httpError("not found", 404, "offer_not_found");
      if (state.blocked) throw httpError("conflict", 409, "offer_conflict");
      state.accepted = true;
      return { status: "accepted" };
    },
    readOfferContact: (_db, userId) => {
      if (Number(userId) === ctxIds.otherId) throw httpError("not found", 404, "offer_not_found");
      return { contact_dock: true, masked_phone: "09******78" };
    },
    blockOwnerFromOffer: () => {
      state.blocked = true;
      return { ok: true, block_ref: "uat-block-1", offer: { status: "blocked" } };
    },
    assertOfferBurst: () => {
      state.burst += 1;
      if (state.burst > 5) throw httpError("too many", 429, "RATE_LIMITED");
      return true;
    },
    recordOfferFail: () => true,
    liveMatchEligible: (_db, _listing, wishRow) => ({ eligible: wishRow?.eligible === true }),
    recordShareEvent: (_db, { eventType, source }) => {
      if (source === "public" && eventType === "signup") {
        throw httpError("forbidden", 403, "share_conversion_forbidden");
      }
      state.shareViews += 1;
      if (state.shareViews > 1) return { recorded: false, reason: "deduped", is_bot: false };
      return { recorded: true, is_bot: false };
    },
    resolveValidShareToken: (_db, token) => (token === TOKEN ? TOKEN : ""),
    shouldAttributeSignup: ({ newlyCreated = false, source = "" } = {}) =>
      newlyCreated === true || source === "verify_email" || source === "oauth_register",
    emitRentalNotifyEvent: (_db, { eventType, eventKey }) => {
      if (eventType === "wish_lifecycle_due_3d" && state.prefs.lifecycle_reminder !== true) {
        return { emitted: false, reason: "preference_suppressed" };
      }
      if (state.eventKeys.has(eventKey)) return { emitted: false, reason: "deduped" };
      state.eventKeys.add(eventKey);
      return { emitted: true };
    },
    saveRentalNotifyPrefs: (_db, _userId, patch) => {
      state.prefs = { ...state.prefs, ...patch };
      return state.prefs;
    },
    getRentalNotifyPrefs: () => state.prefs,
    runRentalNotifyTick: (_db, _now, { limit }) => ({
      skipped: false,
      reminders: { scanned: 0, emitted: 0 },
      delivered: { scanned: Math.min(1, limit) },
      digest: { closed: 0 },
    }),
    startRentalNotifyLoop: (runTick, { intervalMs = 600000 } = {}) => {
      let running = false;
      const timer = setInterval(() => {}, intervalMs);
      return {
        tick() {
          if (running) return { skipped: true };
          running = true;
          try {
            return runTick();
          } finally {
            running = false;
          }
        },
        stop() {
          clearInterval(timer);
        },
      };
    },
    wishHasActiveOffer: () => false,
    httpProbe: async () => ({ status: 404, code: "", body: { error: "找不到心願" } }),
  };
  return { deps: { ...deps, ...overrides }, state, db };
}

const ctxIds = { tenantId: 12, otherId: 13 };

function makeCtx() {
  return {
    namespace: makeUatNamespace("35316208975"),
    ownerId: 11,
    tenantId: 12,
    otherId: 13,
    listing: { post_id: 900001 },
    wishes: {
      eligible: { id: 800001, public_token: TOKEN, eligible: true },
      paused: { id: 800002, public_token: "uat-paused", eligible: false },
      completed: { id: 800003, public_token: "uat-completed", eligible: false },
      closed: { id: 800004, public_token: "uat-closed", eligible: false },
    },
    notifyUserId: 11,
    shareToken: TOKEN,
    shareIp: "203.0.113.7",
    shareAgent: "uat-agent",
    idempotencyKey: "uat-idempotency-key",
    dockRows: [],
  };
}

test("UAT catalog covers stages 2, 3 and 4 exactly once", () => {
  const ids = itemIds();
  assert.equal(ids.length, 17);
  assert.equal(new Set(ids).size, 17);
  assert.deepEqual(ids.slice(0, 7), ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7"]);
  assert.deepEqual(ids.slice(7, 11), ["3.1", "3.2", "3.3", "3.4"]);
  assert.deepEqual(ids.slice(11), ["4.1", "4.2", "4.3", "4.4", "4.5", "4.6"]);
  assert.deepEqual([...new Set(UAT_ITEMS.map((item) => item.stage))], [2, 3, 4]);
});

test("UAT readiness requires stages 1-4 ON and every outbound channel OFF", () => {
  assert.equal(assertUatReadiness(stage14On()), true);
  const off = stage14On();
  off.wish.offer_enabled = false;
  assert.throws(() => assertUatReadiness(off, "case"), /case wish\.offer_enabled must be true/);
  const outbound = stage14On();
  outbound.wish.outbound_push_enabled = true;
  assert.throws(() => assertUatReadiness(outbound), /wish\.outbound_push_enabled must be false/);
  const noLifecycle = stage14On();
  noLifecycle.wish.lifecycle_enabled = false;
  assert.throws(() => assertUatReadiness(noLifecycle), /lifecycle_enabled must be true/);
  const noCatalog = stage14On();
  noCatalog.rental_catalog_v2.enabled = false;
  assert.throws(() => assertUatReadiness(noCatalog), /rental_catalog_v2\.enabled must be true/);
});

test("UAT namespace is derived from the workflow run id", () => {
  assert.equal(makeUatNamespace("35316208975"), "issue333-uat-35316208975");
  assert.match(makeUatNamespace(""), /^issue333-uat-local$/);
  assert.match(makeUatNamespace("stage:1:2/3"), /^issue333-uat-[0-9A-Za-z]+$/);
});

test("UAT evidence guard is fail-closed and keeps the phone check boundary anchored", () => {
  // A compact run id / timestamp must not be mistaken for a 09xxxxxxxx phone.
  assert.equal(assertNoUatSecrets({ namespace: "issue333-uat-2026091806452935316208975" }), true);
  assert.equal(assertNoUatSecrets({ note: "stage1-fix:20260918061756:35314199788" }), true);
  assert.throws(() => assertNoUatSecrets({ note: "0912345678" }), /leaked phone/);
  assert.throws(() => assertNoUatSecrets({ note: "a 0912345678" }), /leaked phone/);
  assert.throws(() => assertNoUatSecrets({ note: "owner@example.com" }), /leaked email/);
  assert.throws(() => assertNoUatSecrets({ note: "SESSION_SECRET" }), /leaked SESSION_SECRET/);
});

test("UAT recorder keeps going after an item fails and flags SQLITE_BUSY", async () => {
  const recorder = makeRecorder();
  const ok = await recorder.run({ id: "1.1", stage: 2, check: "passes" }, async () => ({ ok: true, expected: "x" }));
  const bad = await recorder.run({ id: "1.2", stage: 2, check: "throws" }, async () => {
    throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  });
  assert.equal(ok.status, "pass");
  assert.equal(bad.status, "fail");
  assert.equal(bad.sqlite_busy, true);
  assert.deepEqual(summarize(recorder.items), { total: 2, passed: 1, failed: 1, failed_ids: ["1.2"] });
  recorder.logProbe({ kind: "http", status: 200 });
  assert.equal(recorder.probeLog.length, 1);
});

test("UAT expectation helpers report denials and predicate failures", async () => {
  const denied = await expectDenied(async () => {
    throw Object.assign(new Error("nope"), { status: 404, code: "offer_not_found" });
  }, { status: 404, code: "offer_not_found" });
  assert.equal(denied.ok, true);
  assert.equal(denied.http_status, 404);
  const unexpected = await expectDenied(async () => ({ fine: true }), { status: 404 });
  assert.equal(unexpected.ok, false);
  assert.match(unexpected.reason, /expected denial/);
  assert.equal(expectAllowed({ n: 1 }, (value) => value.n === 1, "n is 1").ok, true);
  assert.equal(expectAllowed({ n: 2 }, (value) => value.n === 1, "n is 1").ok, false);
});

test("UAT dependency contract rejects a partial wiring and the read-only count works", () => {
  assert.throws(() => assertUatDeps({}), /requires domain dependency getRentalMarketplaceFlags/);
  const { deps, db } = makeDeps();
  assert.equal(assertUatDeps(deps), deps);
  assert.equal(UAT_REQUIRED_DEPS.length, 23);
  assert.equal(pendingOffersFor(db, 800001, 11), 0);
});

test("UAT happy path passes all 17 items and concludes ISSUE333_FINAL_UAT_PASS", async () => {
  const { deps, db } = makeDeps();
  const doc = await runProductionUat({
    db,
    deps,
    ctx: makeCtx(),
    flags: stage14On(),
    runId: "35316208975",
    workflow: "production-uat-stages-functional.yml",
  });
  assert.equal(doc.schema, UAT_SCHEMA);
  assert.deepEqual(doc.problems, []);
  assert.equal(doc.conclusion, UAT_CONCLUSION);
  assert.equal(doc.flags_mutated, false);
  assert.equal(doc.summary.total, 17);
  assert.equal(doc.summary.passed, 17);
  assert.equal(doc.items.every((item) => item.status === "pass"), true);
  assert.equal(doc.namespace, "issue333-uat-35316208975");
  // Item 2.5 records only the projection shape, never the projection itself.
  assert.equal(doc.items.find((item) => item.id === "2.5").observed.owner_projection_keys, 2);
  assert.equal(JSON.stringify(doc).includes("contact_dock"), false);
  assert.equal(JSON.stringify(doc).includes("09******78"), false);
});

test("UAT fails closed when a single item does not hold", async () => {
  const { deps, db } = makeDeps({
    recordShareEvent: () => ({ recorded: false, reason: "deduped", is_bot: false }),
  });
  const doc = await runProductionUat({ db, deps, ctx: makeCtx(), flags: stage14On(), runId: "1" });
  assert.equal(doc.conclusion, "");
  assert.equal(doc.items.find((item) => item.id === "3.1").status, "fail");
  assert.ok(doc.problems.some((p) => /item 3\.1/.test(p)));
  // Every item still executed: one failure never aborts the run.
  assert.equal(doc.summary.total, 17);
  // The stub also breaks item 3.3, whose public conversion must be refused with 403.
  assert.deepEqual(doc.summary.failed_ids, ["3.1", "3.3"]);
  assert.equal(doc.summary.passed, 15);
});

test("UAT fails closed when the domain mutates feature flags", async () => {
  let calls = 0;
  const { deps, db } = makeDeps({
    getRentalMarketplaceFlags: () => {
      calls += 1;
      const flags = stage14On();
      if (calls > 1) flags.wish.offer_enabled = false;
      return flags;
    },
  });
  const doc = await runProductionUat({ db, deps, ctx: makeCtx(), flags: stage14On(), runId: "1" });
  assert.equal(doc.flags_mutated, true);
  assert.ok(doc.problems.some((p) => /mutated feature flags/.test(p)));
  assert.equal(doc.conclusion, "");
});

test("UAT refuses an incomplete context and an unhydrated domain refuses nothing silently", async () => {
  const { deps, db } = makeDeps();
  const ctx = makeCtx();
  delete ctx.wishes.closed;
  await assert.rejects(
    () => runProductionUat({ db, deps, ctx, flags: stage14On() }),
    /context is incomplete: wishes\.closed/,
  );
  const noWiring = makeDeps({ setWishOfferHydrate: undefined });
  await assert.rejects(
    () => runProductionUat({ db, deps: noWiring.deps, ctx: makeCtx(), flags: stage14On() }),
    /requires domain dependency setWishOfferHydrate/,
  );
});


