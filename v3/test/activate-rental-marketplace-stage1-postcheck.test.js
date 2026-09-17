import { test } from "node:test";
import assert from "node:assert/strict";
import {
  opaqueId,
  selectPostActivationFixtures,
  runAuthenticatedMatchingProbes,
  publicPostActivationEvidence,
  POST_ACTIVATION_SOURCE,
} from "../../.github/scripts/activate-rental-marketplace-stage1-postcheck.mjs";

const pausedToken = "paused-token-aaa";
const completedToken = "completed-token-bbb";
const inactiveToken = "inactive-token-ccc";
const activeToken = "active-token-ddd";

function fixtures(extra = {}) {
  return selectPostActivationFixtures({
    users: [
      { id: 11, email: "owner-a@example.com" },
      { id: 22, email: "owner-b@example.com" },
    ],
    listings: [
      {
        post_id: 501,
        listed_by_user_id: 11,
        source: "self",
        self_status: "open",
        price_num: 20000,
        district: "1-8",
      },
    ],
    wishes: [
      { public_token: pausedToken, lifecycle: "paused", status: "open", districts: ["1-8"], rent_max: 30000 },
      { public_token: completedToken, lifecycle: "completed", status: "closed", districts: ["1-8"], rent_max: 30000 },
      { public_token: inactiveToken, lifecycle: "expired", status: "expired", districts: ["1-8"], rent_max: 30000 },
      { public_token: activeToken, lifecycle: "active", status: "open", districts: ["1-8"], rent_max: 30000 },
    ],
    listingFormFields: () => ({ district: "1-8" }),
    ...extra,
  });
}

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function mockFetch(router) {
  return async (url, opts = {}) => {
    const path = String(url).replace("http://127.0.0.1:5153", "");
    const cookie = String(opts.headers?.Cookie || "");
    const result = router(path, cookie);
    if (!result) throw new Error(`unexpected url ${path} cookie=${cookie}`);
    return result;
  };
}

function ownerOtherRouter({ ownerMatches, ownerSummary, missing, otherMatches, otherSummary }) {
  return (path, cookie) => {
    const other = cookie.includes("other-cookie");
    if (path === "/api/self-listings/501/matches") return other ? otherMatches() : ownerMatches();
    if (path === "/api/self-listings/501/matches/summary") return other ? otherSummary() : ownerSummary();
    if (path === "/api/self-listings/0/matches") return missing();
    return null;
  };
}

test("post-activation fixtures require two accounts and paused/completed/inactive overlapping wishes", () => {
  const selected = fixtures();
  assert.equal(selected.listing_id, 501);
  assert.equal(selected.owner_email, "owner-a@example.com");
  assert.equal(selected.other_email, "owner-b@example.com");
  assert.deepEqual(new Set(selected.suppressed.map((row) => row.class)), new Set(["paused", "completed", "inactive"]));
  assert.throws(
    () => fixtures({ users: [{ id: 11, email: "only@example.com" }] }),
    /second living account/,
  );
  assert.throws(
    () => fixtures({
      wishes: [
        { public_token: pausedToken, lifecycle: "paused", status: "open", districts: ["1-8"], rent_max: 30000 },
        { public_token: completedToken, lifecycle: "completed", status: "closed", districts: ["1-8"], rent_max: 30000 },
      ],
    }),
    /missing suppressed wishes: inactive/,
  );
});

test("authenticated probes accept opaque 404 cross-account and reject leaked suppressed wishes", async () => {
  const selected = fixtures();
  const ok = await runAuthenticatedMatchingProbes({
    fixtures: selected,
    cookies: { owner: "owner-cookie", other: "other-cookie" },
    fetchImpl: mockFetch(ownerOtherRouter({
      ownerMatches: () => jsonResponse(200, { items: [{ wish_ref: activeToken, match_score: 4 }] }),
      ownerSummary: () => jsonResponse(200, { enabled: true, count: 1 }),
      missing: () => jsonResponse(404, { error: "找不到這則站內刊登", code: "listing_not_found" }),
      otherMatches: () => jsonResponse(404, { error: "找不到這則站內刊登", code: "listing_not_found" }),
      otherSummary: () => jsonResponse(404, { error: "找不到這則站內刊登", code: "listing_not_found" }),
    })),
  });
  assert.equal(ok.authoritative_source, POST_ACTIVATION_SOURCE);
  assert.equal(ok.functional_smoke.authenticated_cross_account.verified, true);
  assert.equal(ok.suppression.leaked_count, 0);
  const published = publicPostActivationEvidence(ok);
  assert.doesNotMatch(JSON.stringify(published), /example\.com|owner-cookie|owner-a|owner-b/);

  await assert.rejects(
    () => runAuthenticatedMatchingProbes({
      fixtures: selected,
      cookies: { owner: "owner-cookie", other: "other-cookie" },
      fetchImpl: mockFetch(ownerOtherRouter({
        ownerMatches: () => jsonResponse(200, { items: [{ wish_ref: pausedToken }] }),
        ownerSummary: () => jsonResponse(200, { enabled: true }),
        missing: () => jsonResponse(404, { error: "找不到這則站內刊登", code: "listing_not_found" }),
        otherMatches: () => jsonResponse(404, { error: "找不到這則站內刊登", code: "listing_not_found" }),
        otherSummary: () => jsonResponse(404, { error: "找不到這則站內刊登", code: "listing_not_found" }),
      })),
    }),
    /inactive\/paused\/completed/,
  );

  await assert.rejects(
    () => runAuthenticatedMatchingProbes({
      fixtures: selected,
      cookies: { owner: "owner-cookie", other: "other-cookie" },
      fetchImpl: mockFetch(ownerOtherRouter({
        ownerMatches: () => jsonResponse(200, { items: [] }),
        ownerSummary: () => jsonResponse(200, { enabled: true }),
        missing: () => jsonResponse(404, { error: "找不到這則站內刊登", code: "listing_not_found" }),
        otherMatches: () => jsonResponse(401, { error: "請先登入" }),
        otherSummary: () => jsonResponse(401, { error: "請先登入" }),
      })),
    }),
    /unauthenticated 401 cannot satisfy cross-account evidence/,
  );
});

test("post-activation probes fail-closed on 5xx, sqlite busy, and timeout", async () => {
  const selected = fixtures();
  await assert.rejects(
    () => runAuthenticatedMatchingProbes({
      fixtures: selected,
      cookies: { owner: "owner-cookie", other: "other-cookie" },
      fetchImpl: mockFetch(() => jsonResponse(500, { error: "boom" })),
    }),
    /http_5xx/,
  );
  await assert.rejects(
    () => runAuthenticatedMatchingProbes({
      fixtures: selected,
      cookies: { owner: "owner-cookie", other: "other-cookie" },
      fetchImpl: mockFetch(() => jsonResponse(200, { error: "SQLITE_BUSY" })),
    }),
    /sqlite_busy/,
  );
  await assert.rejects(
    () => runAuthenticatedMatchingProbes({
      fixtures: selected,
      cookies: { owner: "owner-cookie", other: "other-cookie" },
      timeoutMs: 5,
      fetchImpl: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    }),
    /timed out/,
  );
  assert.equal(opaqueId("x").length, 12);
});
