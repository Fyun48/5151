import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMUTE_STATES,
  commuteFieldKey,
  commuteSettingsFingerprint,
  commuteStateLabel,
  finishBackfillRequest,
  isPendingCommuteState,
  mergeCommutePatch,
  rememberBackfillRequest,
  resolveCommuteState,
  routeRetryDecision,
  shouldHoldListLayout,
  shouldPaintCommute,
} from "../src/commuteState.js";

test("commute states map to the on-screen labels", () => {
  assert.equal(commuteStateLabel(COMMUTE_STATES.WAIT_GEO), "等待定位");
  assert.equal(commuteStateLabel(COMMUTE_STATES.WAIT_ROUTE), "等待計算");
  assert.equal(commuteStateLabel(COMMUTE_STATES.COMPUTING), "計算中");
  assert.equal(commuteStateLabel(COMMUTE_STATES.RETRY), "稍後重試");
  assert.equal(commuteStateLabel(COMMUTE_STATES.FAILED), "無法計算");
  assert.equal(resolveCommuteState({ commuteOn: true, hasCoords: false }), "wait_geo");
  assert.equal(resolveCommuteState({ commuteOn: true, hasCoords: true, commuteKm: 4.2 }), "done");
  assert.equal(resolveCommuteState({ commuteOn: true, hasCoords: true, job: { job_state: "failed" } }), "failed");
});

test("same listing ids still paint kilometers when only the commute node is stale", () => {
  const cache = { post_id: 11, commute_km: 4.2, commute_state: "done" };
  const patch = { post_id: 11, commute_km: 4.2, commute_state: "done" };
  const next = mergeCommutePatch(cache, patch);
  assert.equal(commuteFieldKey(cache), commuteFieldKey(next));
  const staleHtml = `<span data-commute="11"> · 機車等待計算</span>`;
  const nextHtml = `<span data-commute="11">機車路線約 4.2 公里</span>`;
  assert.equal(shouldPaintCommute({
    fieldChanged: commuteFieldKey(cache) !== commuteFieldKey(next),
    htmlChanged: staleHtml !== nextHtml,
  }), true);
});

test("same listing ids still merge kilometer patches and ignore stale settings", () => {
  const cache = { post_id: 11, commute_km: null, commute_state: "computing" };
  const next = mergeCommutePatch(cache, { post_id: 11, commute_km: 3.4, commute_state: "done" });
  assert.equal(next.commute_km, 3.4);
  assert.notEqual(commuteFieldKey(cache), commuteFieldKey(next));
  const stale = mergeCommutePatch(cache, { commute_km: 9 }, {
    fingerprint: "25.1,121.5|scooter",
    currentFingerprint: "25.2,121.6|car",
  });
  assert.equal(stale.commute_km, null);
  assert.equal(shouldHoldListLayout({ sameIds: true, filterChanged: false }), true);
  assert.equal(shouldHoldListLayout({ sameIds: false, busy: true, filterChanged: true }), true);
  assert.equal(shouldPaintCommute({ fieldChanged: false, htmlChanged: true }), true);
  assert.equal(shouldPaintCommute({ fieldChanged: false, htmlChanged: false }), false);
  assert.equal(isPendingCommuteState({ commute_state: "", commute_km: null }, true), true);
  assert.equal(isPendingCommuteState({ commute_state: "done", commute_km: 3.4 }, true), false);
});

test("busy backfill remembers the next run instead of dropping it", () => {
  const state = { busy: false, queued: false };
  assert.equal(rememberBackfillRequest(state), "start");
  assert.equal(rememberBackfillRequest(state), "queued");
  assert.equal(state.queued, true);
  assert.equal(finishBackfillRequest(state), "restart");
  assert.equal(state.busy, false);
  assert.equal(rememberBackfillRequest(state), "start");
  assert.equal(finishBackfillRequest(state), "idle");
});

test("transient failures retry and permanent gaps fail separately", () => {
  const busy = routeRetryDecision("busy", 1);
  assert.equal(busy.job_state, "retry");
  assert.ok(busy.next_retry_at);
  const none = routeRetryDecision("no_route", 1);
  assert.equal(none.job_state, "failed");
  assert.equal(none.fail_reason, "no_route");
  const geo = routeRetryDecision("no_coords", 2);
  assert.equal(geo.job_state, "failed");
  assert.equal(commuteSettingsFingerprint({ workLat: 25.05781, workLng: 121.6184, commuteMode: "scooter" }), "25.05781,121.6184|scooter");
});
