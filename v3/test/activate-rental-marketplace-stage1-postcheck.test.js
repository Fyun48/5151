import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCounterfactualMatch,
  isCounterfactuallyMatchable,
} from "../src/rentalMatch.js";
import {
  opaqueId,
  selectPostActivationFixtures,
  runAuthenticatedMatchingProbes,
  publicPostActivationEvidence,
  POST_ACTIVATION_SOURCE,
} from "../../.github/scripts/activate-rental-marketplace-stage1-postcheck.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

const pausedToken = "paused-token-aaa";
const completedToken = "completed-token-bbb";
const inactiveToken = "inactive-token-ccc";
const activeToken = "active-token-ddd";
const conflictingPausedToken = "paused-conflict-eee";

const MATCH_ENGINE = {
  isCounterfactuallyMatchable,
  evaluateCounterfactualMatch,
};

function matchableListing(extra = {}) {
  return {
    post_id: 501,
    listed_by_user_id: 11,
    source: "self",
    self_status: "open",
    price_num: 20000,
    source_key: "1|8||台北市士林區中正路|3|18坪|2房1廳1衛",
    address: "台北市士林區中正路100號",
    area_name: "18坪",
    layout: "2房1廳1衛",
    kind_name: "整層住家",
    listing_condition_values: JSON.stringify({
      need_pet: "not_allowed",
      need_cook: "allowed",
    }),
    ...extra,
  };
}

function lifecycleWish(token, lifecycle, status, extra = {}) {
  return {
    public_token: token,
    lifecycle,
    status,
    districts: ["1-8"],
    rent_max: 30000,
    ...extra,
  };
}

function fixtures(extra = {}) {
  return selectPostActivationFixtures({
    users: [
      { id: 11, email: "owner-a@example.com" },
      { id: 22, email: "owner-b@example.com" },
    ],
    listings: [matchableListing()],
    wishes: [
      lifecycleWish(pausedToken, "paused", "open"),
      lifecycleWish(completedToken, "completed", "closed"),
      lifecycleWish(inactiveToken, "expired", "expired"),
      lifecycleWish(activeToken, "active", "open"),
    ],
    ...MATCH_ENGINE,
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
  assert.ok(selected.suppressed.every((row) => row.counterfactual_eligible === true));
  assert.throws(
    () => fixtures({ users: [{ id: 11, email: "only@example.com" }] }),
    /second living account/,
  );
  assert.throws(
    () => fixtures({
      wishes: [
        lifecycleWish(pausedToken, "paused", "open"),
        lifecycleWish(completedToken, "completed", "closed"),
      ],
    }),
    /missing suppressed wishes: inactive/,
  );
  assert.throws(
    () => selectPostActivationFixtures({
      users: [
        { id: 11, email: "owner-a@example.com" },
        { id: 22, email: "owner-b@example.com" },
      ],
      listings: [matchableListing()],
      wishes: [
        lifecycleWish(pausedToken, "paused", "open"),
        lifecycleWish(completedToken, "completed", "closed"),
        lifecycleWish(inactiveToken, "expired", "expired"),
      ],
    }),
    /require deployed Match Engine counterfactual helper/,
  );
});

test("condition-conflicting suppressed wishes are rejected while lifecycle-only equivalents are accepted", () => {
  const conflicting = lifecycleWish(conflictingPausedToken, "paused", "open", {
    condition_choices: { need_pet: "want" },
  });
  const listing = matchableListing();
  assert.equal(isCounterfactuallyMatchable(listing, conflicting), false);
  assert.equal(isCounterfactuallyMatchable(listing, lifecycleWish(pausedToken, "paused", "open")), true);

  assert.throws(
    () => fixtures({
      wishes: [
        conflicting,
        lifecycleWish(completedToken, "completed", "closed"),
        lifecycleWish(inactiveToken, "expired", "expired"),
      ],
    }),
    /missing suppressed wishes: paused/,
  );

  const selected = fixtures({
    wishes: [
      conflicting,
      lifecycleWish(pausedToken, "paused", "open"),
      lifecycleWish(completedToken, "completed", "closed"),
      lifecycleWish(inactiveToken, "expired", "expired"),
    ],
  });
  const paused = selected.suppressed.filter((row) => row.class === "paused");
  assert.equal(paused.length, 1);
  assert.equal(paused[0].token_hash, opaqueId(pausedToken));
  assert.ok(!selected.suppressed.some((row) => row.token_hash === opaqueId(conflictingPausedToken)));
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
  assert.equal(ok.suppression.district_rent_heuristics_are_not_sufficient, true);
  assert.equal(ok.suppression.counterfactual_eligible_required, true);
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

test("Stage 1 postcheck loads the app env module so session cookies sign with the server secret", () => {
  // `docker exec` does not carry the secret that v3/src/env.js derives from
  // DATA_DIR, so the postcheck must import the env module before using auth.js;
  // otherwise every authenticated probe returns 401 owner_denied in Production.
  const source = readFileSync(path.join(root, ".github/scripts/activate-rental-marketplace-stage1-postcheck.mjs"), "utf8");
  assert.match(source, /STAGE1_ENV_MODULE \|\| "\/app\/src\/env\.js"/);
  const envIdx = source.indexOf('process.env.STAGE1_ENV_MODULE || "/app/src/env.js"');
  const authIdx = source.indexOf("STAGE1_AUTH_MODULE");
  assert.ok(envIdx > 0 && authIdx > 0, "postcheck env/auth module wiring missing");
  assert.ok(envIdx < authIdx, "env module must be loaded before auth module");
  assert.match(source, /await import\(pathToFileURL\(path\.resolve\(envSpec\)\)\.href\)/);
});

