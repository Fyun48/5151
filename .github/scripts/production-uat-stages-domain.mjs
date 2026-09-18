/** Issue #333 consolidated Production functional UAT for Marketplace Stages 2-4.
 *
 * Contract:
 * - never mutates feature flags (the caller asserts before/after equality);
 * - creates and cleans its own fixtures through the existing domain APIs only;
 * - no raw SQL for writes, no raw SQL cleanup;
 * - shipped as an scp'd helper (production-uat-stages-remote.sh) that imports the
 *   domain APIs from /app/src at run time, so no v3 deploy is required;
 * - every domain function arrives through `deps`, so the item logic is unit
 *   testable without a Production database.
 */

export const UAT_SCHEMA = "rental-marketplace-stages-functional-uat/v1";
export const UAT_CONCLUSION = "ISSUE333_FINAL_UAT_PASS";
export const UAT_NAMESPACE_PREFIX = "issue333-uat";

/** Stage flags that must be ON, in activation order. */
export const UAT_STAGE_FLAGS = Object.freeze([
  "owner_matching_enabled",
  "offer_enabled",
  "public_share_v2_enabled",
  "owner_notifications_enabled",
  "notifications_enabled",
]);

/** Outbound channels that must stay OFF for the whole UAT. */
export const UAT_OUTBOUND_FLAGS = Object.freeze([
  "digest_enabled",
  "outbound_mail_enabled",
  "outbound_push_enabled",
]);

export const UAT_STAGE_NUMBERS = Object.freeze([2, 3, 4]);

export const UAT_HARD_DENIAL_CODES = Object.freeze({
  offer_not_found: 404,
  match_no_longer_eligible: 409,
  offer_unavailable: 409,
  offer_conflict: 409,
  share_not_found: 404,
  share_conversion_forbidden: 403,
  RATE_LIMITED: 429,
});

/**
 * The read-only readiness contract. Deliberately separate from
 * stage1FixtureOps.assertReadinessFlags, which requires the later flags to be
 * false and therefore rejects the live post-activation posture.
 */
export function assertUatReadiness(flags, label = "uat") {
  const wish = flags?.wish && typeof flags.wish === "object" ? flags.wish : {};
  if (flags?.rental_catalog_v2?.enabled !== true) {
    throw new Error(`${label} rental_catalog_v2.enabled must be true`);
  }
  if (wish.lifecycle_enabled !== true) {
    throw new Error(`${label} wish.lifecycle_enabled must be true`);
  }
  for (const key of UAT_STAGE_FLAGS) {
    if (wish[key] !== true) throw new Error(`${label} wish.${key} must be true`);
  }
  for (const key of UAT_OUTBOUND_FLAGS) {
    if (wish[key] !== false) throw new Error(`${label} wish.${key} must be false`);
  }
  return true;
}

export function makeUatNamespace(runId) {
  const compact = String(runId || "").replace(/[^0-9A-Za-z]/g, "").slice(-24) || "local";
  return `${UAT_NAMESPACE_PREFIX}-${compact}`;
}

/** Every UAT item, in a fixed order, with the stage it proves. */
export const UAT_ITEMS = Object.freeze([
  { id: "2.1", stage: 2, check: "eligible_offer_create" },
  { id: "2.2", stage: 2, check: "offer_duplicate_idempotency" },
  { id: "2.3", stage: 2, check: "offer_rate_limit_anti_abuse" },
  { id: "2.4", stage: 2, check: "tenant_accept_and_consent" },
  { id: "2.5", stage: 2, check: "authorized_contact_projection" },
  { id: "2.6", stage: 2, check: "offer_block_and_report" },
  { id: "2.7", stage: 2, check: "paused_completed_closed_rejection" },
  { id: "3.1", stage: 3, check: "share_attribution_first_party" },
  { id: "3.2", stage: 3, check: "share_event_dedup" },
  { id: "3.3", stage: 3, check: "share_cta_signup" },
  { id: "3.4", stage: 3, check: "share_sentinel_gate_open" },
  { id: "4.1", stage: 4, check: "notify_new_match_event" },
  { id: "4.2", stage: 4, check: "notify_dedup_and_episode" },
  { id: "4.3", stage: 4, check: "notify_preference_suppression" },
  { id: "4.4", stage: 4, check: "notify_worker_bounded_non_reentrant" },
  { id: "4.5", stage: 4, check: "notify_blocked_closed_ineligible_suppression" },
  { id: "4.6", stage: 4, check: "outbound_channels_stay_off" },
].map(Object.freeze));

export function itemIds() {
  return UAT_ITEMS.map((item) => item.id);
}

/** Boundary-anchored, fail-closed evidence guard. */
export function assertNoUatSecrets(doc, label = "uat evidence") {
  const text = JSON.stringify(doc ?? {});
  // Boundary-anchored so a compact run id / timestamp such as
  // "issue333-uat-20260918..." is not mistaken for a 09xxxxxxxx phone.
  if (/(?<!\d)09\d{8}(?!\d)/.test(text)) throw new Error(`${label} leaked phone`);
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) throw new Error(`${label} leaked email`);
  for (const token of ["SESSION_SECRET", "NAS_SSH_KEY", "AUTH_PASSWORD", "auth.env", "Fx!"]) {
    if (text.includes(token)) throw new Error(`${label} leaked ${token}`);
  }
  return true;
}


function requireDeps(deps, names) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    if (typeof deps?.[name] !== "function") {
      throw new Error(`production UAT requires domain dependency ${name}`);
    }
  }
  return deps;
}

function messageOf(error) {
  return String(error?.message || error || "");
}

function isBusyText(text) {
  return /SQLITE_BUSY|database is locked/i.test(String(text || ""));
}

/**
 * One item failure must not abort the run: every item is recorded, and the
 * workflow conclusion step fails closed when any item is not `pass`.
 */
export function makeRecorder() {
  const items = [];
  const probeLog = [];
  return {
    items,
    probeLog,
    logProbe(entry) {
      probeLog.push({ at: new Date().toISOString(), ...entry });
      return entry;
    },
    async run(item, fn, { required = true } = {}) {
      const entry = {
        id: item.id,
        stage: item.stage,
        check: item.check,
        required: required === true,
        status: "fail",
        expected: "",
        observed: {},
        code: "",
        http_status: 0,
        sqlite_busy: false,
        error: "",
      };
      try {
        const result = (await fn()) || {};
        entry.expected = String(result.expected ?? "");
        entry.observed = result.observed && typeof result.observed === "object" ? result.observed : {};
        entry.code = String(result.code ?? "");
        entry.http_status = Number(result.http_status ?? 0);
        entry.sqlite_busy = result.sqlite_busy === true || isBusyText(JSON.stringify(entry.observed));
        if (result.ok === true) {
          entry.status = "pass";
        } else {
          entry.error = String(result.reason || "item assertions did not hold");
        }
      } catch (error) {
        entry.error = messageOf(error);
        entry.code = String(error?.code || "");
        entry.http_status = Number(error?.status || 0);
        entry.sqlite_busy = isBusyText(entry.error);
      }
      items.push(entry);
      return entry;
    },
  };
}

/** Asserts that a domain call is refused with the documented status and code. */
export async function expectDenied(fn, { status = 0, code = "" } = {}) {
  try {
    await fn();
  } catch (error) {
    const seenStatus = Number(error?.status || 0);
    const seenCode = String(error?.code || "");
    const statusOk = status === 0 || seenStatus === status;
    const codeOk = code === "" || seenCode === code;
    return {
      ok: statusOk && codeOk,
      code: seenCode,
      http_status: seenStatus,
      observed: { denied: true, expected_status: status, expected_code: code },
      reason: statusOk && codeOk ? "" : `denied with ${seenStatus}/${seenCode}, expected ${status}/${code}`,
    };
  }
  return {
    ok: false,
    code: "",
    http_status: 0,
    observed: { denied: false, expected_status: status, expected_code: code },
    reason: `expected denial ${status}/${code} but the call succeeded`,
  };
}

/** Asserts that a domain call succeeded and satisfies a predicate. */
export function expectAllowed(value, predicate, expected) {
  if (typeof predicate === "function" && predicate(value) !== true) {
    return { ok: false, expected, observed: { value }, reason: "returned value did not satisfy the expectation" };
  }
  return { ok: true, expected, observed: { value } };
}

export function itemById(id) {
  const found = UAT_ITEMS.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown UAT item ${id}`);
  return found;
}

/** Read-only helper. The UAT never writes with raw SQL. */
export function countRows(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return Number(row?.n || 0);
}

export function pendingOffersFor(db, wishId, ownerUserId) {
  return countRows(
    db,
    "SELECT COUNT(*) AS n FROM wish_offers WHERE wish_id = ? AND owner_user_id = ? AND status = 'pending'",
    Number(wishId),
    Number(ownerUserId),
  );
}

/** Read-only: the dock delivery row for one notification event. */
export function dockDeliveryFor(db, eventId, channel = "dock") {
  if (!Number(eventId)) return null;
  try {
    return db
      .prepare("SELECT id, channel, status FROM rental_notify_deliveries WHERE event_id = ? AND channel = ? ORDER BY id DESC LIMIT 1")
      .get(Number(eventId), String(channel)) || null;
  } catch {
    return null;
  }
}

/** Read-only: how many notification events exist for one subject reference. */
export function notifyEventCount(db, subjectRef) {
  try {
    return countRows(db, "SELECT COUNT(*) AS n FROM rental_notify_events WHERE subject_ref = ?", String(subjectRef || ""));
  } catch {
    return -1;
  }
}

/** Read-only: dock delivery rows pointing at one subject reference. */
export function dockDeliveryCountForSubject(db, subjectRef) {
  try {
    return countRows(
      db,
      `SELECT COUNT(*) AS n FROM rental_notify_deliveries d
       JOIN rental_notify_events e ON e.id = d.event_id
       WHERE d.channel = 'dock' AND e.subject_ref = ?`,
      String(subjectRef || ""),
    );
  } catch {
    return -1;
  }
}

export async function runStage2Items({ db, helpers, ctx, recorder }) {
  await recorder.run(itemById("2.1"), async () => {
    const gates = helpers.assertCreateOfferGates(db, {
      ownerUserId: ctx.ownerId,
      listingRow: ctx.listing,
      wishRow: ctx.wishes.eligible,
      now: ctx.now,
    });
    const offer = helpers.insertPendingOffer(db, {
      ownerUserId: ctx.ownerId,
      listingRow: ctx.listing,
      wishRow: ctx.wishes.eligible,
      idempotencyKey: ctx.idempotencyKey,
      now: ctx.now,
    });
    ctx.offerRef = String(offer?.public_token || "");
    ctx.offerId = Number(offer?.id || 0);
    return expectAllowed(
      { gates_ok: gates == null, offer_ref_present: ctx.offerRef.length > 0, status: offer?.status || "" },
      (value) => value.offer_ref_present === true && value.status === "pending",
      "offer row created with status pending and a public token",
    );
  });

  await recorder.run(itemById("2.2"), async () => {
    let second = null;
    try {
      second = helpers.insertPendingOffer(db, {
        ownerUserId: ctx.ownerId,
        listingRow: ctx.listing,
        wishRow: ctx.wishes.eligible,
        idempotencyKey: ctx.idempotencyKey,
        now: ctx.now,
      });
    } catch (error) {
      second = { refused: true, code: String(error?.code || ""), message: messageOf(error) };
    }
    const live = pendingOffersFor(db, ctx.wishes.eligible.id, ctx.ownerId);
    return {
      ok: live === 1,
      expected: "a repeated idempotency key leaves exactly one pending offer",
      observed: {
        live_pending: live,
        second_token_same: second?.public_token === ctx.offerRef,
        second_refused: second?.refused === true,
        second_code: second?.code || "",
      },
      reason: live === 1 ? "" : `${live} pending offers remain after the repeated key`,
    };
  });

  await recorder.run(itemById("2.3"), async () => {
    const actorKey = `uat-burst:${ctx.namespace}`;
    let allowed = 0;
    let deniedCode = "";
    let deniedStatus = 0;
    for (let i = 0; i < 40; i += 1) {
      try {
        helpers.assertOfferBurst(actorKey, ctx.now);
        allowed += 1;
      } catch (error) {
        deniedCode = String(error?.code || "");
        deniedStatus = Number(error?.status || 0);
        break;
      }
    }
    helpers.recordOfferFail(`uat-fail:${ctx.namespace}`, ctx.now);
    return {
      ok: deniedCode !== "" && allowed > 0,
      expected: "a burst is refused with an explicit code",
      observed: { allowed, denied_code: deniedCode, denied_status: deniedStatus },
      code: deniedCode,
      http_status: deniedStatus,
      reason: deniedCode === "" ? "the burst was never refused within 40 attempts" : "",
    };
  });

  await recorder.run(itemById("2.4"), async () => {
    const accepted = helpers.acceptWishOffer(db, ctx.tenantId, ctx.offerRef, { now: ctx.now });
    const denial = await expectDenied(
      () => helpers.acceptWishOffer(db, ctx.otherId, ctx.offerRef, { now: ctx.now }),
      { status: 404, code: "offer_not_found" },
    );
    return {
      ok: String(accepted?.status || "") === "accepted" && denial.ok === true,
      expected: "the tenant accepts (pending -> accepted) and a third account is refused 404",
      observed: {
        accepted_status: accepted?.status || "",
        third_account: denial.observed,
        third_code: denial.code,
      },
      code: denial.code,
      http_status: denial.http_status,
      reason: denial.ok === true ? "" : denial.reason,
    };
  });

  await recorder.run(itemById("2.5"), async () => {
    const ownerView = helpers.readOfferContact(db, ctx.ownerId, ctx.offerRef, { now: ctx.now });
    const denial = await expectDenied(
      () => helpers.readOfferContact(db, ctx.otherId, ctx.offerRef, { now: ctx.now }),
      { status: 404, code: "offer_not_found" },
    );
    return {
      ok: Boolean(ownerView) && denial.ok === true,
      expected: "only offer participants receive the contact projection",
      observed: {
        owner_projection_keys: Object.keys(ownerView || {}).length,
        third_account: denial.observed,
      },
      code: denial.code,
      http_status: denial.http_status,
      reason: denial.ok === true ? "" : denial.reason,
    };
  });

  await recorder.run(itemById("2.6"), async () => {
    const blocked = helpers.blockOwnerFromOffer(db, ctx.tenantId, ctx.offerRef, { now: ctx.now });
    // A blocked thread must no longer be acceptable.
    const reaccept = await expectDenied(
      () => helpers.acceptWishOffer(db, ctx.tenantId, ctx.offerRef, { now: ctx.now }),
      { status: 409 },
    );
    return {
      ok: blocked?.ok === true && String(blocked?.offer?.status || "") === "blocked" && reaccept.ok === true,
      expected: "blocking terminalises the thread and it can no longer be accepted",
      observed: {
        block_ok: blocked?.ok === true,
        offer_status: blocked?.offer?.status || "",
        reaccept: reaccept.observed,
      },
      code: reaccept.code,
      http_status: reaccept.http_status,
      reason: blocked?.ok === true && reaccept.ok === true ? "" : "block did not terminalise the thread",
    };
  });

  await recorder.run(itemById("2.7"), async () => {
    const observed = {};
    let allRefused = true;
    for (const name of ["paused", "completed", "closed"]) {
      const wish = ctx.wishes[name];
      const live = helpers.liveMatchEligible(db, ctx.listing, wish, ctx.now);
      const denial = await expectDenied(
        () => helpers.assertCreateOfferGates(db, {
          ownerUserId: ctx.ownerId,
          listingRow: ctx.listing,
          wishRow: wish,
          now: ctx.now,
        }),
        { status: 409 },
      );
      // Item 2.6 blocked this owner, so the documented block gate may legitimately
      // answer first with offer_unavailable; match_no_longer_eligible is the
      // ineligibility code. Either way the create must be refused with 409 and the
      // wish must report eligible=false.
      const acceptable = denial.ok === true
        && ["match_no_longer_eligible", "offer_unavailable"].includes(denial.code);
      observed[name] = { eligible: live?.eligible === true, code: denial.code, status: denial.http_status };
      if (live?.eligible === true || acceptable !== true) allRefused = false;
    }
    return {
      ok: allRefused,
      expected: "paused, completed and closed wishes are ineligible and refused with 409",
      observed,
      reason: allRefused ? "" : "an ineligible wish was still eligible or was not refused",
    };
  });
}

export async function runStage3Items({ db, helpers, ctx, recorder }) {
  await recorder.run(itemById("3.1"), async () => {
    const first = helpers.recordShareEvent(db, {
      shareToken: ctx.shareToken,
      eventType: "view",
      ip: ctx.shareIp,
      userAgent: ctx.shareAgent,
      now: ctx.now,
      source: "public",
    });
    return {
      ok: first?.recorded === true,
      expected: "a first-party view on a controlled wish is recorded",
      observed: { recorded: first?.recorded, reason: first?.reason || "", is_bot: first?.is_bot === true },
      reason: first?.recorded === true ? "" : `share view was not recorded (${first?.reason || "no reason"})`,
    };
  });

  await recorder.run(itemById("3.2"), async () => {
    const repeat = helpers.recordShareEvent(db, {
      shareToken: ctx.shareToken,
      eventType: "view",
      ip: ctx.shareIp,
      userAgent: ctx.shareAgent,
      now: ctx.now,
      source: "public",
    });
    return {
      ok: repeat?.recorded === false && String(repeat?.reason || "") === "deduped",
      expected: "the same visitor may not double-count a view inside the dedup window",
      observed: { recorded: repeat?.recorded, reason: repeat?.reason || "" },
      reason: repeat?.recorded === false ? "" : "the repeated view was counted twice",
    };
  });

  await recorder.run(itemById("3.3"), async () => {
    const resolved = helpers.resolveValidShareToken(db, ctx.shareToken);
    const bogus = helpers.resolveValidShareToken(db, "__uat-not-a-share-token__");
    const firstParty = helpers.shouldAttributeSignup({ newlyCreated: true, source: "" });
    const thirdParty = helpers.shouldAttributeSignup({ newlyCreated: false, source: "referral" });
    const conversion = await expectDenied(
      () => helpers.recordShareEvent(db, {
        shareToken: ctx.shareToken,
        eventType: "signup",
        ip: ctx.shareIp,
        userAgent: ctx.shareAgent,
        now: ctx.now,
        source: "public",
      }),
      { status: 403, code: "share_conversion_forbidden" },
    );
    const ok =
      resolved === ctx.shareToken &&
      bogus === "" &&
      firstParty === true &&
      thirdParty === false &&
      conversion.ok === true;
    return {
      ok,
      expected: "tokens resolve, first-party signup attributes, third-party never, public conversion is forbidden",
      observed: {
        resolved: resolved === ctx.shareToken,
        bogus_empty: bogus === "",
        first_party_attributed: firstParty,
        third_party_attributed: thirdParty,
        public_conversion: conversion.observed,
      },
      code: conversion.code,
      http_status: conversion.http_status,
      reason: ok ? "" : "the share CTA attribution contract was not met",
    };
  });

  await recorder.run(itemById("3.4"), async () => {
    const probe = await helpers.httpProbe({
      path: "/api/public/wish-room/__stages-postcheck-does-not-exist__/share-events",
      method: "POST",
      body: { event_type: "view" },
    });
    const status = Number(probe?.status || 0);
    const code = String(probe?.code || "");
    // A sentinel room id can never exist, so an OPEN gate answers 404 with no
    // code. Only the share_disabled code means the gate is still closed.
    return {
      ok: status > 0 && code !== "share_disabled",
      expected: "the live share gate answers the sentinel probe without share_disabled",
      observed: { status, code },
      code,
      http_status: status,
      reason: code === "share_disabled" ? "the live share gate is still closed" : "",
    };
  });
}

export async function runStage4Items({ db, helpers, ctx, recorder }) {
  const subjectRef = String(ctx.wishes.eligible?.public_token || ctx.wishes.eligible?.public_ref || "");
  const baseEvent = (eventType, eventKey) => ({
    eventType,
    userId: ctx.notifyUserId,
    eventKey,
    subjectType: eventType.startsWith("owner_") ? "listing" : "wish",
    subjectRef,
    listingId: ctx.listing?.post_id ?? null,
    payload: { uat: ctx.namespace },
    now: ctx.now,
    queue: true,
  });

  await recorder.run(itemById("4.1"), async () => {
    helpers.saveRentalNotifyPrefs(db, ctx.notifyUserId, { lifecycle_reminder: true, channel_dock: true }, ctx.now);
    // Drain anything queued earlier so the subsequent dock write is attributable.
    helpers.deliverQueuedNotifications(db, ctx.now, { limit: 50 });
    ctx.dockRows.length = 0;
    const emitted = helpers.emitRentalNotifyEvent(
      db,
      baseEvent("owner_new_match_available", `uat-match:${ctx.namespace}`),
    );
    const queued = dockDeliveryFor(db, emitted?.event_id || 0);
    const pass = helpers.deliverQueuedNotifications(db, ctx.now, { limit: 50 });
    const settled = dockDeliveryFor(db, emitted?.event_id || 0);
    const ok =
      emitted?.emitted === true &&
      queued?.status === "queued" &&
      settled?.status === "delivered" &&
      ctx.dockRows.length >= 1;
    return {
      ok,
      expected: "the unique new-match event is queued for dock delivery and produces a real dock write",
      observed: {
        emitted: emitted?.emitted,
        event_id: emitted?.event_id || 0,
        dock_status_after_queue: queued?.status || "",
        dock_status_after_delivery: settled?.status || "",
        delivery_pass: { scanned: pass?.scanned ?? 0, delivered: pass?.delivered ?? 0 },
        dock_writes: ctx.dockRows.length,
      },
      reason: ok ? "" : "the new-match event did not reach a dock write through the delivery path",
    };
  });

  await recorder.run(itemById("4.2"), async () => {
    const duplicate = helpers.emitRentalNotifyEvent(
      db,
      baseEvent("owner_new_match_available", `uat-match:${ctx.namespace}`),
    );
    const nextEpisode = helpers.emitRentalNotifyEvent(
      db,
      baseEvent("owner_new_match_available", `uat-match:${ctx.namespace}:ep2`),
    );
    return {
      ok: duplicate?.emitted === false && nextEpisode?.emitted === true,
      expected: "the same event key is deduped while a new episode still emits",
      observed: {
        duplicate_emitted: duplicate?.emitted,
        duplicate_reason: duplicate?.reason || "",
        next_episode_emitted: nextEpisode?.emitted,
      },
      reason:
        duplicate?.emitted === false && nextEpisode?.emitted === true
          ? ""
          : "event-key dedup or new-episode emission did not behave as documented",
    };
  });

  await recorder.run(itemById("4.3"), async () => {
    // queueDeliveries() applies preferenceAllows() at queue time and writes a dock
    // delivery with status "suppressed". deliverQueuedNotifications() only scans
    // queued/retrying rows, so a suppressed dock row provably cannot be delivered.
    // channel_dock stays true here, so the suppression can only come from the
    // preference, not from the channel gate.
    const saved = helpers.saveRentalNotifyPrefs(
      db,
      ctx.notifyUserId,
      { lifecycle_reminder: false, channel_dock: true },
      ctx.now,
    );
    const readBack = helpers.getRentalNotifyPrefs(db, ctx.notifyUserId);
    helpers.deliverQueuedNotifications(db, ctx.now, { limit: 50 });
    const emitted = helpers.emitRentalNotifyEvent(
      db,
      baseEvent("wish_lifecycle_due_3d", `uat-suppress:${ctx.namespace}`),
    );
    const queued = dockDeliveryFor(db, emitted?.event_id || 0);
    const pass = helpers.deliverQueuedNotifications(db, ctx.now, { limit: 50 });
    const settled = dockDeliveryFor(db, emitted?.event_id || 0);
    const ok =
      saved?.lifecycle_reminder === false &&
      readBack?.lifecycle_reminder === false &&
      emitted?.emitted === true &&
      queued?.status === "suppressed" &&
      settled?.status === "suppressed";
    return {
      ok,
      expected: "a preference-suppressed lifecycle event gets dock delivery status suppressed and is never delivered",
      observed: {
        lifecycle_reminder: readBack?.lifecycle_reminder,
        channel_dock: readBack?.channel_dock,
        dock_status_after_queue: queued?.status || "",
        dock_status_after_delivery: settled?.status || "",
        delivery_pass: { scanned: pass?.scanned ?? 0, delivered: pass?.delivered ?? 0 },
      },
      reason: ok ? "" : "the suppressed dock delivery was not proven authoritatively",
    };
  });

  await recorder.run(itemById("4.4"), async () => {
    const limit = 5;
    const first = helpers.runRentalNotifyTick(db, ctx.now, { flags: ctx.flags, limit });
    const second = helpers.runRentalNotifyTick(db, ctx.now, { flags: ctx.flags, limit });
    // Non-reentrancy proof: call the loop's tick from inside a running tick.
    let inner = null;
    const loopHolder = {};
    const loop = helpers.startRentalNotifyLoop(
      () => {
        if (inner === null) inner = loopHolder.loop.tick();
        return { ran: true };
      },
      { intervalMs: 600000, log() {} },
    );
    loopHolder.loop = loop;
    const outer = loop.tick();
    loop.stop();
    const bounded = (tick) =>
      tick && tick.skipped === false && Number(tick.delivered?.scanned ?? 0) <= limit && Number(tick.reminders?.scanned ?? 0) <= limit;
    return {
      ok: bounded(first) === true && bounded(second) === true && inner?.skipped === true && outer?.ran === true,
      expected: "two ticks complete within the batch limit and a nested tick is refused",
      observed: {
        first_skipped: first?.skipped,
        second_skipped: second?.skipped,
        nested_tick_skipped: inner?.skipped === true,
        outer_ran: outer?.ran === true,
        delivered_scanned: Number(first?.delivered?.scanned ?? 0),
        limit,
      },
      reason: inner?.skipped === true ? "" : "a nested worker tick was not refused",
    };
  });

  await recorder.run(itemById("4.5"), async () => {
    // Drive the canonical path: processMatchSubscriptionRow applies
    // pairIsBlockedForNotify() and wishStillHardEligibleForNotify() BEFORE it calls
    // emitRentalNotifyEvent(). Item 2.6 blocked the tenant/owner pair, and the
    // closed wish is not a matchable lifecycle, while hardGateFn always allows, so
    // only the blocked/closed gate can suppress these two items.
    // Precondition guard: if the listing were not open the function would return
    // emitted 0 trivially, so that is asserted explicitly rather than assumed.
    const listingOpen = String(ctx.listing?.self_status || "") === "open";
    const sub = {
      owner_user_id: ctx.notifyUserId,
      listing_id: Number(ctx.listing?.post_id || 0),
      mode: "instant",
    };
    const allow = () => true;
    const eligibleRef = ctx.shareToken;
    const closedRef = String(ctx.wishes.closed?.public_token || "");
    const eventsBefore = notifyEventCount(db, eligibleRef);
    const blocked = helpers.processMatchSubscriptionRow(
      db,
      sub,
      { items: [{ wish_ref: eligibleRef }], complete: false },
      ctx.now,
      ctx.flags,
      { hardGateFn: allow },
    );
    const closed = helpers.processMatchSubscriptionRow(
      db,
      sub,
      { items: [{ wish_ref: closedRef }], complete: false },
      ctx.now,
      ctx.flags,
      { hardGateFn: allow },
    );
    const eventsAfter = notifyEventCount(db, eligibleRef);
    const closedEvents = notifyEventCount(db, closedRef);
    const closedDock = dockDeliveryCountForSubject(db, closedRef);
    const ok =
      listingOpen === true &&
      blocked?.emitted === 0 &&
      closed?.emitted === 0 &&
      eventsAfter === eventsBefore &&
      closedEvents === 0 &&
      closedDock === 0;
    return {
      ok,
      expected: "the canonical eligibility path emits 0 and writes no event or dock delivery for a blocked or closed pair",
      observed: {
        listing_open: listingOpen,
        blocked_pair_emitted: blocked?.emitted,
        closed_pair_emitted: closed?.emitted,
        eligible_events_before: eventsBefore,
        eligible_events_after: eventsAfter,
        closed_events: closedEvents,
        closed_dock_deliveries: closedDock,
      },
      reason: ok ? "" : "the blocked/closed suppression path did not hold",
    };
  });

  await recorder.run(itemById("4.6"), async () => {
    const live = helpers.getRentalMarketplaceFlags();
    const on = UAT_OUTBOUND_FLAGS.filter((key) => live?.wish?.[key] !== false);
    return {
      ok: on.length === 0,
      expected: "every outbound channel flag stays false for the whole UAT",
      observed: {
        outbound_flags: Object.fromEntries(UAT_OUTBOUND_FLAGS.map((key) => [key, live?.wish?.[key]])),
        notifications_enabled: live?.wish?.notifications_enabled === true,
      },
      reason: on.length === 0 ? "" : `outbound channel(s) on: ${on.join(", ")}`,
    };
  });
}

export const UAT_REQUIRED_DEPS = Object.freeze([
  "getRentalMarketplaceFlags",
  "getRentalCatalog",
  "setWishOfferHydrate",
  "setRentalNotifyHydrate",
  "setRentalNotifyDockWriter",
  "assertCreateOfferGates",
  "insertPendingOffer",
  "acceptWishOffer",
  "readOfferContact",
  "blockOwnerFromOffer",
  "assertOfferBurst",
  "recordOfferFail",
  "liveMatchEligible",
  "recordShareEvent",
  "resolveValidShareToken",
  "shouldAttributeSignup",
  "emitRentalNotifyEvent",
  "getRentalNotifyPrefs",
  "saveRentalNotifyPrefs",
  "deliverQueuedNotifications",
  "processMatchSubscriptionRow",
  "runRentalNotifyTick",
  "startRentalNotifyLoop",
  "httpProbe",
]);

export function assertUatDeps(deps) {
  return requireDeps(deps, UAT_REQUIRED_DEPS);
}

/** The domain modules keep their own in-process flag snapshot, so a fresh
 * `docker exec` process must hydrate it from the live flags before any domain
 * call, or assertWishOfferEnabled()/isRentalNotificationsEnabled() would read
 * the process defaults and refuse everything. */
export function hydrateUatDomain({ deps, flags }) {
  deps.setWishOfferHydrate(deps.getRentalCatalog(), flags);
  deps.setRentalNotifyHydrate(flags);
}

function assertUatContext(ctx) {
  const missing = [];
  if (!Number(ctx?.ownerId)) missing.push("ownerId");
  if (!Number(ctx?.tenantId)) missing.push("tenantId");
  if (!Number(ctx?.otherId)) missing.push("otherId");
  if (!ctx?.listing) missing.push("listing");
  for (const name of ["eligible", "paused", "completed", "closed"]) {
    if (!ctx?.wishes?.[name]) missing.push(`wishes.${name}`);
  }
  if (!String(ctx?.shareToken || "")) missing.push("shareToken");
  if (!Array.isArray(ctx?.dockRows)) missing.push("dockRows");
  if (missing.length) throw new Error(`production UAT context is incomplete: ${missing.join(", ")}`);
  return ctx;
}

/**
 * Runs the consolidated functional UAT. The caller owns fixture creation and
 * cleanup; this function owns readiness, hydration, item execution, flag
 * immutability and evidence assembly.
 */
export async function runProductionUat({ db, deps, ctx, flags, now = new Date(), runId = "", workflow = "" } = {}) {
  assertUatDeps(deps);
  assertUatContext(ctx);
  const snapshot = (value) => JSON.parse(JSON.stringify(value ?? {}));
  const before = snapshot(flags ?? deps.getRentalMarketplaceFlags());
  assertUatReadiness(before, "uat-before");

  hydrateUatDomain({ deps, flags: before });
  ctx.flags = before;
  ctx.now = ctx.now || now;
  ctx.namespace = ctx.namespace || makeUatNamespace(runId);
  deps.setRentalNotifyDockWriter((row) => {
    ctx.dockRows.push(row);
    return row;
  });

  const recorder = makeRecorder();
  await runStage2Items({ db, helpers: deps, ctx, recorder });
  await runStage3Items({ db, helpers: deps, ctx, recorder });
  await runStage4Items({ db, helpers: deps, ctx, recorder });

  const after = snapshot(deps.getRentalMarketplaceFlags());
  const flagsUnchanged = JSON.stringify(before) === JSON.stringify(after);
  // Record a broken after-posture as a problem instead of throwing, so the
  // evidence artifact always exists for the conclusion step to fail closed on.
  let afterReadinessError = "";
  try {
    assertUatReadiness(after, "uat-after");
  } catch (error) {
    afterReadinessError = messageOf(error);
  }

  const problems = [];
  if (afterReadinessError) problems.push(afterReadinessError);
  if (!flagsUnchanged) problems.push("the UAT mutated feature flags");
  for (const item of recorder.items) {
    if (item.required === true && item.status !== "pass") problems.push(`item ${item.id} (${item.check}) did not pass`);
  }
  for (const item of UAT_ITEMS) {
    if (!recorder.items.some((entry) => entry.id === item.id)) problems.push(`item ${item.id} was not executed`);
  }
  if (recorder.items.some((item) => item.sqlite_busy === true)) problems.push("a probe observed SQLITE_BUSY");

  const doc = {
    schema: UAT_SCHEMA,
    generated_at: new Date().toISOString(),
    run_id: String(runId || ""),
    workflow: String(workflow || ""),
    namespace: ctx.namespace,
    flags_mutated: !flagsUnchanged,
    before_raw_flags: before,
    after_raw_flags: after,
    summary: summarize(recorder.items),
    items: recorder.items,
    probe_log: recorder.probeLog,
    dock_rows: ctx.dockRows.length,
    problems,
    conclusion: problems.length === 0 ? UAT_CONCLUSION : "",
  };
  assertNoUatSecrets(doc);
  return doc;
}

export function summarize(items) {
  const failed = items.filter((item) => item.status !== "pass");
  return {
    total: items.length,
    passed: items.length - failed.length,
    failed: failed.length,
    failed_ids: failed.map((item) => item.id),
  };
}
