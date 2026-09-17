// Post-activation authenticated matching probes. Read-only except minting
// session cookies. Never writes flags, listings, or wishes.
// Evidence must prove Stage 1 ON behavior; pre-activation UAT is not evidence.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POST_ACTIVATION_SOURCE = "post_activation_authenticated_probes";
export const MATCHABLE_WISH_LIFECYCLES = Object.freeze(["active", "needs_confirmation"]);
export const REQUIRED_SUPPRESSION_CLASSES = Object.freeze(["paused", "completed", "inactive"]);
export const PROBE_TIMEOUT_MS = 8000;
export const OPAQUE_LISTING_ERROR = "找不到這則站內刊登";
export const OPAQUE_LISTING_CODE = "listing_not_found";

const FORBIDDEN_EVIDENCE = [
  "SESSION_SECRET", "NAS_SSH_KEY", "AUTH_PASSWORD", "auth.env",
  "rank_score", "freshness_score", "activity_score", "wish_id", "last_active_at",
];

export function opaqueId(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

export function opaqueTarget(listingId, suffix = "matches") {
  return `/api/self-listings/${opaqueId(listingId)}/${suffix}`;
}

export function lifecycleOf(row = {}) {
  const stored = String(row.lifecycle || "").trim();
  if (stored) return stored;
  const status = String(row.status || "draft");
  if (status === "open") return "active";
  if (status === "draft") return "draft";
  if (status === "hidden") return "blocked";
  if (status === "expired") return "expired";
  if (status === "closed") return row.closed_reason === "completed" ? "completed" : "paused";
  return "draft";
}

export function isMatchableWish(row = {}) {
  const life = lifecycleOf(row);
  if (!MATCHABLE_WISH_LIFECYCLES.includes(life)) return false;
  const status = String(row.status || "");
  if (status === "hidden" || status === "draft") return false;
  if (status === "closed" && life !== "needs_confirmation") return false;
  return true;
}

export function suppressionClass(row = {}) {
  const life = lifecycleOf(row);
  if (life === "paused") return "paused";
  if (life === "completed") return "completed";
  if (!isMatchableWish(row)) return "inactive";
  return "";
}

function parseDistricts(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function wishOverlapsListing(wish, listingDistricts, rent) {
  const wishDistricts = parseDistricts(wish.districts);
  if (listingDistricts.length && wishDistricts.length) {
    if (!wishDistricts.some((key) => listingDistricts.includes(key))) return false;
  }
  const max = Number(wish.rent_max) || 0;
  const listingRent = Number(rent) || 0;
  if (listingRent > 0 && max > 0 && listingRent > max) return false;
  return true;
}

export function listingDistrictsFromRow(row, listingFormFields) {
  if (!row) return [];
  if (typeof listingFormFields === "function") {
    const district = String(listingFormFields(row)?.district || "").trim();
    return district ? [district] : [];
  }
  const district = String(row.district || "").trim();
  return district ? [district] : [];
}

export function isOpenSelfListing(row, now = new Date()) {
  if (!row) return false;
  if (String(row.source || "self") !== "self") return false;
  if (String(row.self_status || "open") !== "open") return false;
  const owner = Number(row.listed_by_user_id) || 0;
  if (owner <= 0) return false;
  const expires = Date.parse(row.self_expires_at || "");
  if (Number.isFinite(expires) && expires <= (now instanceof Date ? now.getTime() : now)) return false;
  return true;
}

export function selectPostActivationFixtures({
  listings = [],
  users = [],
  wishes = [],
  now = new Date(),
  listingFormFields,
} = {}) {
  const livingUsers = (users || []).filter((row) => row?.id && row?.email && !String(row.deleted_at || "").trim());
  const openListings = (listings || []).filter((row) => isOpenSelfListing(row, now));
  const listing = openListings.find((row) => livingUsers.some((user) => Number(user.id) === Number(row.listed_by_user_id)));
  if (!listing) {
    throw new Error("post-activation fixtures missing: no matchable self-listing with a living owner");
  }
  const owner = livingUsers.find((user) => Number(user.id) === Number(listing.listed_by_user_id));
  const other = livingUsers.find((user) => Number(user.id) !== Number(owner.id));
  if (!other) {
    throw new Error("post-activation fixtures missing: second living account required for cross-account probe");
  }
  const districts = listingDistrictsFromRow(listing, listingFormFields);
  const rent = Number(listing.price_num) || 0;
  const suppressed = [];
  const seen = new Set();
  for (const wish of wishes || []) {
    const klass = suppressionClass(wish);
    if (!klass) continue;
    if (!wishOverlapsListing(wish, districts, rent)) continue;
    const token = String(wish.public_token || "");
    if (!token || seen.has(token)) continue;
    seen.add(token);
    suppressed.push({
      class: klass,
      token_hash: opaqueId(token),
    });
  }
  const classes = new Set(suppressed.map((row) => row.class));
  const missing = REQUIRED_SUPPRESSION_CLASSES.filter((name) => !classes.has(name));
  if (missing.length) {
    throw new Error(`post-activation fixtures missing suppressed wishes: ${missing.join(",")}`);
  }
  return {
    owner_user_hash: opaqueId(owner.id),
    other_user_hash: opaqueId(other.id),
    listing_hash: opaqueId(listing.post_id || listing.id),
    listing_id: Number(listing.post_id || listing.id) || 0,
    owner_email: owner.email,
    other_email: other.email,
    listing_districts: districts,
    suppressed,
  };
}

export function mintSessionCookieValue(sessionCookie, email) {
  const header = sessionCookie({ get() { return ""; }, secure: false }, email);
  const match = String(header || "").match(/^591_session=([^;]+)/);
  if (!match) throw new Error("failed to mint authenticated session cookie");
  return match[1];
}

export function assertNoEvidenceSecrets(doc) {
  const text = typeof doc === "string" ? doc : JSON.stringify(doc);
  for (const token of FORBIDDEN_EVIDENCE) {
    if (text.includes(token)) {
      throw new Error(`post-activation evidence leaked ${token}`);
    }
  }
  if (/09\d{8}/.test(text)) throw new Error("post-activation evidence leaked phone");
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) {
    throw new Error("post-activation evidence leaked email");
  }
}

function nowIso(value = new Date()) {
  return new Date(value).toISOString();
}

export function probeRecord({
  name,
  target,
  method = "GET",
  auth,
  status,
  code = "",
  result,
  elapsed_ms = 0,
  timestamp = nowIso(),
  http_5xx = false,
  sqlite_busy = false,
  timed_out = false,
} = {}) {
  return {
    name,
    timestamp,
    target,
    method,
    auth,
    status: Number(status) || 0,
    code: String(code || ""),
    result,
    elapsed_ms: Number(elapsed_ms) || 0,
    http_5xx: http_5xx === true,
    sqlite_busy: sqlite_busy === true,
    timed_out: timed_out === true,
  };
}

export function publicPostActivationEvidence(doc) {
  const copy = structuredClone(doc);
  if (copy.fixtures) {
    delete copy.fixtures.owner_email;
    delete copy.fixtures.other_email;
    delete copy.fixtures.listing_id;
    if (Array.isArray(copy.fixtures.suppressed)) {
      copy.fixtures.suppressed = copy.fixtures.suppressed.map((row) => ({
        class: row.class,
        token_hash: row.token_hash,
      }));
    }
  }
  assertNoEvidenceSecrets(copy);
  return copy;
}

async function httpJson({ baseUrl, target, cookie, timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (cookie) headers.Cookie = `591_session=${cookie}`;
    const response = await fetchImpl(`${baseUrl}${target.startsWith("/") ? target : `/${target}`}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const elapsed_ms = Date.now() - started;
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: true }; }
    const sqlite_busy = /SQLITE_BUSY|database is locked/i.test(text);
    const http_5xx = response.status >= 500 && response.status <= 599;
    return {
      status: response.status,
      body,
      elapsed_ms,
      sqlite_busy,
      http_5xx,
      timed_out: false,
    };
  } catch (error) {
    const elapsed_ms = Date.now() - started;
    const timed_out = error?.name === "AbortError" || /aborted|timeout/i.test(String(error?.message || error));
    return {
      status: 0,
      body: {},
      elapsed_ms,
      sqlite_busy: false,
      http_5xx: false,
      timed_out,
      error: timed_out ? "timeout" : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function failProbe(message, probe) {
  const error = new Error(message);
  error.probe = probe;
  throw error;
}

export async function runAuthenticatedMatchingProbes({
  fixtures,
  cookies,
  baseUrl = "http://127.0.0.1:5153",
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  startedAt = nowIso(),
} = {}) {
  const probes = [];
  const listingPath = `/api/self-listings/${fixtures.listing_id}`;
  const missingPath = "/api/self-listings/0";

  async function call(name, urlPath, evidenceTarget, auth, cookie) {
    const got = await httpJson({
      baseUrl,
      target: urlPath,
      cookie,
      timeoutMs,
      fetchImpl,
    });
    const probe = probeRecord({
      name,
      target: evidenceTarget,
      auth,
      status: got.status,
      code: got.body?.code || "",
      result: "pending",
      elapsed_ms: got.elapsed_ms,
      http_5xx: got.http_5xx,
      sqlite_busy: got.sqlite_busy,
      timed_out: got.timed_out,
    });
    if (got.timed_out) {
      probe.result = "timeout";
      probes.push(probe);
      failProbe(`post-activation probe ${name} timed out`, probe);
    }
    if (got.sqlite_busy) {
      probe.result = "sqlite_busy";
      probes.push(probe);
      failProbe(`post-activation probe ${name} observed sqlite_busy`, probe);
    }
    if (got.http_5xx) {
      probe.result = "http_5xx";
      probes.push(probe);
      failProbe(`post-activation probe ${name} observed http_5xx`, probe);
    }
    return { got, probe };
  }

  const ownerMatches = await call(
    "owner_own_listing_matches",
    `${listingPath}/matches`,
    opaqueTarget(fixtures.listing_id, "matches"),
    "owner_session",
    cookies.owner,
  );
  if (ownerMatches.got.status !== 200) {
    ownerMatches.probe.result = "owner_denied";
    probes.push(ownerMatches.probe);
    failProbe("owner could not read own listing matches after Stage 1 ON", ownerMatches.probe);
  }
  const items = Array.isArray(ownerMatches.got.body?.items) ? ownerMatches.got.body.items : [];
  const leakedKeys = ["rank_score", "freshness_score", "activity_score", "wish_id"];
  if (items.some((item) => leakedKeys.some((key) => key in (item || {})))) {
    ownerMatches.probe.result = "privacy_leak";
    probes.push(ownerMatches.probe);
    failProbe("owner matches leaked internal ranking or wish_id", ownerMatches.probe);
  }
  const returnedHashes = new Set(items.map((item) => opaqueId(item.wish_ref || item.public_token || "")));
  const leaked = fixtures.suppressed.filter((row) => returnedHashes.has(row.token_hash));
  ownerMatches.probe.result = leaked.length ? "suppression_leak" : "owner_ok";
  ownerMatches.probe.code = "";
  probes.push(ownerMatches.probe);
  if (leaked.length) {
    failProbe("inactive/paused/completed wishes appeared in owner matching results", ownerMatches.probe);
  }

  const ownerSummary = await call(
    "owner_own_listing_summary",
    `${listingPath}/matches/summary`,
    opaqueTarget(fixtures.listing_id, "matches/summary"),
    "owner_session",
    cookies.owner,
  );
  if (ownerSummary.got.status !== 200 || ownerSummary.got.body?.enabled !== true) {
    ownerSummary.probe.result = "owner_summary_denied";
    probes.push(ownerSummary.probe);
    failProbe("owner could not read own listing match summary after Stage 1 ON", ownerSummary.probe);
  }
  ownerSummary.probe.result = "owner_ok";
  probes.push(ownerSummary.probe);

  const missing = await httpJson({
    baseUrl,
    target: `${missingPath}/matches`,
    cookie: cookies.owner,
    timeoutMs,
    fetchImpl,
  });
  const missingProbe = probeRecord({
    name: "owner_missing_listing_opaque",
    target: opaqueTarget(0, "matches"),
    auth: "owner_session",
    status: missing.status,
    code: missing.body?.code || "",
    result: missing.status === 404 && missing.body?.code === OPAQUE_LISTING_CODE ? "opaque_denial" : "unexpected",
    elapsed_ms: missing.elapsed_ms,
    http_5xx: missing.http_5xx,
    sqlite_busy: missing.sqlite_busy,
    timed_out: missing.timed_out,
  });
  if (missing.timed_out || missing.http_5xx || missing.sqlite_busy) {
    missingProbe.result = missing.timed_out ? "timeout" : missing.sqlite_busy ? "sqlite_busy" : "http_5xx";
    probes.push(missingProbe);
    failProbe("missing-listing probe failed closed", missingProbe);
  }
  probes.push(missingProbe);
  if (missingProbe.result !== "opaque_denial" || String(missing.body?.error || "") !== OPAQUE_LISTING_ERROR) {
    failProbe("missing listing denial is not the opaque listing_not_found contract", missingProbe);
  }

  for (const [name, suffix] of [
    ["other_account_listing_matches", "matches"],
    ["other_account_listing_summary", "matches/summary"],
  ]) {
    const got = await httpJson({
      baseUrl,
      target: `${listingPath}/${suffix}`,
      cookie: cookies.other,
      timeoutMs,
      fetchImpl,
    });
    const probe = probeRecord({
      name,
      target: opaqueTarget(fixtures.listing_id, suffix),
      auth: "other_account_session",
      status: got.status,
      code: got.body?.code || "",
      result: "pending",
      elapsed_ms: got.elapsed_ms,
      http_5xx: got.http_5xx,
      sqlite_busy: got.sqlite_busy,
      timed_out: got.timed_out,
    });
    if (got.timed_out || got.http_5xx || got.sqlite_busy) {
      probe.result = got.timed_out ? "timeout" : got.sqlite_busy ? "sqlite_busy" : "http_5xx";
      probes.push(probe);
      failProbe(`cross-account probe ${name} failed closed`, probe);
    }
    const sameOpaque = got.status === 404
      && got.body?.code === OPAQUE_LISTING_CODE
      && String(got.body?.error || "") === OPAQUE_LISTING_ERROR
      && String(got.body?.error || "") === String(missing.body?.error || "");
    probe.result = sameOpaque ? "opaque_denial" : (got.status === 401 ? "unauth_style_401" : "unexpected");
    probes.push(probe);
    if (got.status === 401) {
      failProbe("unauthenticated 401 cannot satisfy cross-account evidence", probe);
    }
    if (!sameOpaque) {
      failProbe("other account was not given the same opaque listing_not_found denial", probe);
    }
  }

  const finishedAt = nowIso();
  return {
    schema: "stage1-post-activation-probes-v1",
    phase: "post_activation",
    owner_matching_enabled: true,
    probed_here: true,
    authoritative_source: POST_ACTIVATION_SOURCE,
    started_at: startedAt,
    finished_at: finishedAt,
    fixtures: {
      owner_user_hash: fixtures.owner_user_hash,
      other_user_hash: fixtures.other_user_hash,
      listing_hash: fixtures.listing_hash,
      suppressed: fixtures.suppressed,
    },
    functional_smoke: {
      aggregate_status: 200,
      exposure_enabled: true,
      authenticated_cross_account: {
        probed_here: true,
        verified: true,
        unauth_401_is_not_cross_account: true,
        authoritative_source: POST_ACTIVATION_SOURCE,
        probes: probes.filter((row) => /other_account|missing_listing/.test(row.name)),
      },
    },
    suppression: {
      probed_here: true,
      verified: true,
      checked: true,
      row_counts_are_not_verification: true,
      authoritative_source: POST_ACTIVATION_SOURCE,
      suppressed_candidate_count: fixtures.suppressed.length,
      leaked_count: 0,
      lifecycles_checked: [...REQUIRED_SUPPRESSION_CLASSES],
      probes: probes.filter((row) => row.name === "owner_own_listing_matches"),
    },
    privacy_smoke: {
      owner_matches_clean: true,
      internal_rank_leaked: false,
    },
    probes,
    http_5xx: {
      observed: false,
      provenance: "defined_probes",
      probes: probes.map((row) => row.target),
    },
    sqlite_busy: {
      observed: false,
      provenance: "defined_probes",
      probes: probes.map((row) => row.target),
    },
  };
}

function queryRows(db, sql) {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

export function loadProductionFixtures(db, listingFormFields, now = new Date()) {
  const listings = queryRows(db, `
    SELECT post_id, listed_by_user_id, source, self_status, self_expires_at, price_num, address, source_key
    FROM listings
    WHERE COALESCE(source, '591') = 'self'
    ORDER BY post_id DESC
    LIMIT 80
  `);
  let users = queryRows(db, `
    SELECT id, email, COALESCE(deleted_at, '') AS deleted_at
    FROM users
    ORDER BY id ASC
    LIMIT 80
  `);
  if (!users.length) {
    users = queryRows(db, `
      SELECT id, email, '' AS deleted_at
      FROM users
      ORDER BY id ASC
      LIMIT 80
    `);
  }
  const wishes = queryRows(db, `
    SELECT id, districts, rent_max, status, lifecycle, public_token, closed_reason
    FROM demand_posts
    ORDER BY id DESC
    LIMIT 400
  `);
  return selectPostActivationFixtures({ listings, users, wishes, now, listingFormFields });
}

export async function runPostActivationGate({
  db,
  getRentalMarketplaceFlags,
  sessionCookie,
  listingFormFields,
  baseUrl = process.env.STAGE1_POSTCHECK_BASE_URL || "http://127.0.0.1:5153",
  fetchImpl = fetch,
  resultPath = process.env.STAGE1_POSTCHECK_RESULT_PATH || "/tmp/stage1-post-activation.json",
} = {}) {
  const flags = getRentalMarketplaceFlags();
  if (flags?.wish?.owner_matching_enabled !== true) {
    throw new Error("post-activation gate requires wish.owner_matching_enabled=true");
  }
  const later = [
    "offer_enabled", "public_share_v2_enabled", "owner_notifications_enabled",
    "notifications_enabled", "digest_enabled", "outbound_mail_enabled", "outbound_push_enabled",
  ];
  if (later.some((key) => flags?.wish?.[key] !== false)) {
    throw new Error("post-activation gate saw Stage 2-4/outbound enabled");
  }
  const fixtures = loadProductionFixtures(db, listingFormFields);
  const cookies = {
    owner: mintSessionCookieValue(sessionCookie, fixtures.owner_email),
    other: mintSessionCookieValue(sessionCookie, fixtures.other_email),
  };
  const raw = await runAuthenticatedMatchingProbes({ fixtures, cookies, baseUrl, fetchImpl });
  const evidence = publicPostActivationEvidence(raw);
  writeFileSync(resultPath, JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

async function main() {
  const spec = process.env.STAGE1_DOMAIN_DB_MODULE || "/app/src/db.js";
  const href = spec.startsWith("file:") ? spec : pathToFileURL(path.resolve(spec)).href;
  const [dbMod, authMod, listingMod] = await Promise.all([
    import(href),
    import(pathToFileURL(path.resolve(process.env.STAGE1_AUTH_MODULE || "/app/src/auth.js")).href),
    import(pathToFileURL(path.resolve(process.env.STAGE1_LISTING_MODULE || "/app/src/selfListings.js")).href),
  ]);
  await runPostActivationGate({
    db: dbMod.db,
    getRentalMarketplaceFlags: dbMod.getRentalMarketplaceFlags,
    sessionCookie: authMod.sessionCookie,
    listingFormFields: listingMod.listingFormFields,
  });
  console.log("POST_ACTIVATION_PROBES_OK");
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  await main();
}
