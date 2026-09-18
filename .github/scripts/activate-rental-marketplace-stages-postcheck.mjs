// Post-activation runtime probes for staged Stage 2 / 3 / 4 activation.
// Runs inside the Production container via `docker exec` (no restart).
//
// Two independent signals are combined:
//   1. the running process flag cache (`getRentalMarketplaceFlags()`), which is the
//      exact value the serving process uses; and
//   2. real HTTP gate probes against the live listener, proving the target stage
//      stops returning its "disabled" code and that later stages still do.
//
// NOTE: `docker exec` starts a fresh process that does NOT carry the session
// signing secret, so `auth.js` must be imported AFTER `env.js` (same as the
// Stage 1 postcheck); otherwise every authenticated probe would 401.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POST_ACTIVATION_SOURCE = "post_activation_authenticated_probes";
export const PROBE_TIMEOUT_MS = 8000;
export const TARGET_STAGES = Object.freeze([2, 3, 4]);
export const STAGE_FLAGS = Object.freeze({
  2: Object.freeze(["offer_enabled"]),
  3: Object.freeze(["public_share_v2_enabled"]),
  4: Object.freeze(["owner_notifications_enabled", "notifications_enabled"]),
});
export const EARLIER_FLAGS = Object.freeze({
  2: Object.freeze(["owner_matching_enabled"]),
  3: Object.freeze(["owner_matching_enabled", "offer_enabled"]),
  4: Object.freeze(["owner_matching_enabled", "offer_enabled", "public_share_v2_enabled"]),
});
export const LATER_FLAGS = Object.freeze({
  2: Object.freeze(["public_share_v2_enabled", "owner_notifications_enabled", "notifications_enabled"]),
  3: Object.freeze(["owner_notifications_enabled", "notifications_enabled"]),
  4: Object.freeze([]),
});
export const OUTBOUND_FLAGS = Object.freeze([
  "digest_enabled",
  "outbound_mail_enabled",
  "outbound_push_enabled",
]);
export const DISABLED_CODES = Object.freeze({
  owner_matching: "owner_matching_disabled",
  shares: "share_disabled",
  offers: "wish_offer_disabled",
});

const FORBIDDEN_EVIDENCE = Object.freeze([
  "SESSION_SECRET",
  "NAS_SSH_KEY",
  "AUTH_PASSWORD",
  "auth.env",
  "rank_score",
  "freshness_score",
  "activity_score",
  "wish_id",
  "last_active_at",
]);

export function opaqueId(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

export function assertNoEvidenceSecrets(doc) {
  const text = typeof doc === "string" ? doc : JSON.stringify(doc);
  for (const token of FORBIDDEN_EVIDENCE) {
    if (text.includes(token)) throw new Error(`staged post-activation evidence leaked ${token}`);
  }
  // Boundary-anchored: compact fixture run ids / timestamps must not look like 09xxxxxxxx.
  if (/(?<!\d)09\d{8}(?!\d)/.test(text)) throw new Error("staged post-activation evidence leaked phone");
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) {
    throw new Error("staged post-activation evidence leaked email");
  }
}

export async function httpJson({ baseUrl, target, method = "GET", cookie, body, timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (cookie) headers.Cookie = `591_session=${cookie}`;
    const init = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(`${baseUrl}${target.startsWith("/") ? target : `/${target}`}`, init);
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: true };
    }
    return {
      status: response.status,
      code: typeof parsed?.code === "string" ? parsed.code : "",
      body: parsed,
      elapsed_ms: Date.now() - started,
      sqlite_busy: /SQLITE_BUSY|database is locked/i.test(text),
      http_5xx: response.status >= 500 && response.status <= 599,
      timed_out: false,
    };
  } catch (error) {
    const timedOut = error?.name === "AbortError" || /aborted|timeout/i.test(String(error?.message || error));
    return {
      status: 0,
      code: "",
      body: {},
      elapsed_ms: Date.now() - started,
      sqlite_busy: false,
      http_5xx: false,
      timed_out: timedOut,
      error: timedOut ? "timeout" : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildFlagChecks({ flags, stage }) {
  const target = Number(stage);
  if (!TARGET_STAGES.includes(target)) throw new Error(`unsupported target stage ${stage}`);
  const wish = flags?.wish || {};
  const isOn = (key) => wish[key] === true;
  const isOff = (key) => wish[key] === false;
  return {
    pr_a_flags_on: flags?.rental_catalog_v2?.enabled === true && wish.lifecycle_enabled === true,
    stage1_on: isOn("owner_matching_enabled"),
    earlier_stages_on: EARLIER_FLAGS[target].every(isOn),
    target_stage_on: STAGE_FLAGS[target].every(isOn),
    later_stages_off: LATER_FLAGS[target].every(isOff),
    outbound_off: OUTBOUND_FLAGS.every(isOff),
  };
}

const SHARE_GATE_SENTINEL = "__stages-postcheck-does-not-exist__";
const GATE_TIMEOUT_CODES = Object.freeze(["", "ECONNREFUSED"]);

function probeBytes(probe) {
  return JSON.stringify(probe?.body ?? {});
}

export function probeHasPii(probe) {
  const text = probeBytes(probe);
  if (/(?<!\d)09\d{8}(?!\d)/.test(text)) return "phone";
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) return "email";
  for (const token of FORBIDDEN_EVIDENCE) if (text.includes(token)) return token;
  return "";
}

/** Read-only gate probes against the live listener (plus one sentinel-id POST). */
export async function probeStageGates({ baseUrl, fetchImpl, cookie }) {
  const gates = {
    // Open when the owner-matching gate is on; 404 owner_matching_disabled when off.
    aggregate: await httpJson({ baseUrl, target: "/api/demand/aggregate", fetchImpl }),
    // Open when wish.offer_enabled is on; 404 wish_offer_disabled when off.
    offers: await httpJson({ baseUrl, target: "/api/wish-offers/owner", fetchImpl }),
    // Sentinel id can never exist, so this cannot write a share event; the only
    // signal used is whether the share_v2 gate refused with share_disabled.
    shares: await httpJson({
      baseUrl,
      target: `/api/public/wish-room/${SHARE_GATE_SENTINEL}/share-events`,
      method: "POST",
      body: { event_type: "view" },
      fetchImpl,
    }),
    notifications: cookie
      ? await httpJson({ baseUrl, target: "/api/rental-notify/prefs", cookie, fetchImpl })
      : { status: 0, code: "", body: {}, timed_out: false, http_5xx: false, sqlite_busy: false },
  };
  gates.notifications_anonymous = await httpJson({ baseUrl, target: "/api/rental-notify/prefs", fetchImpl });
  return gates;
}

export function classifyGates({ gates, stage }) {
  const target = Number(stage);
  const reachable = (probe) => probe.status > 0 || GATE_TIMEOUT_CODES.includes(probe.code);
  const shareRefused = gates.shares.code === DISABLED_CODES.shares;
  const offerRefused = gates.offers.code === DISABLED_CODES.offers;
  const notificationsEnabled = gates.notifications.body?.enabled === true;
  const notificationsDisabled =
    gates.notifications.body?.enabled === false ||
    gates.notifications.code === "rental_notify_disabled" ||
    gates.notifications.status === 404;

  let targetServing = false;
  let targetSignal = "";
  if (target === 2) {
    targetSignal = "wish_offer_gate_open";
    targetServing = reachable(gates.offers) && !offerRefused && gates.offers.status !== 404;
  } else if (target === 3) {
    targetSignal = "share_v2_gate_open";
    targetServing = reachable(gates.shares) && !shareRefused && gates.shares.status !== 404;
  } else {
    targetSignal = "rental_notify_enabled";
    targetServing = notificationsEnabled;
  }

  let laterClosed = true;
  if (target === 2) laterClosed = shareRefused && notificationsDisabled;
  else if (target === 3) laterClosed = notificationsDisabled;

  return {
    owner_matching_open: reachable(gates.aggregate) && gates.aggregate.code !== DISABLED_CODES.owner_matching,
    offer_gate_open: reachable(gates.offers) && !offerRefused,
    share_gate_open: reachable(gates.shares) && !shareRefused,
    notifications_enabled: notificationsEnabled,
    notifications_disabled: notificationsDisabled,
    anonymous_notification_probe_requires_session: gates.notifications_anonymous?.status === 401,
    target_serving: targetServing,
    target_signal: targetSignal,
    later_gates_closed: laterClosed,
  };
}

export function buildRedactionChecks({ gates }) {
  const probes = Object.entries(gates);
  const leaks = probes
    .map(([name, probe]) => [name, probeHasPii(probe)])
    .filter(([, reason]) => reason);
  const closedGates = [gates.aggregate, gates.offers, gates.shares].filter(
    (probe) => probe && typeof probe.code === "string" && probe.code.endsWith("_disabled"),
  );
  return {
    probe_bodies_without_pii: leaks.length === 0,
    closed_gate_responses_are_opaque: closedGates.every(
      (probe) => Object.keys(probe.body || {}).every((key) => key === "error" || key === "code"),
    ),
    authenticated_probe_requires_session: gates.notifications_anonymous?.status === 401,
    leak_report: leaks.map(([name, reason]) => ({ probe: name, kind: reason })),
  };
}


export function mintSessionCookieValue(sessionCookie, email) {
  const header = sessionCookie({ get() { return ""; }, secure: false }, email);
  const match = String(header || "").match(/^591_session=([^;]+)/);
  if (!match) throw new Error("failed to mint an authenticated session cookie");
  return match[1];
}

/**
 * Read-only lookup of an existing account used ONLY to mint one authenticated
 * probe session. The email is never written to evidence (only opaqueId), and no
 * response body from that session is persisted.
 */
export function resolveProbeEmail(db) {
  try {
    const row = db
      .prepare("SELECT email FROM users WHERE email IS NOT NULL AND email <> '' ORDER BY id ASC LIMIT 1")
      .get();
    return row?.email ? String(row.email) : "";
  } catch {
    return "";
  }
}

export async function runStagedPostActivationGate({
  db,
  getRentalMarketplaceFlags,
  sessionCookie,
  stage,
  sourceSha,
  baseUrl = process.env.STAGES_POSTCHECK_BASE_URL || "http://127.0.0.1:5153",
  fetchImpl = fetch,
  resultPath = process.env.STAGES_POSTCHECK_RESULT_PATH || "/tmp/stages-postcheck.json",
} = {}) {
  const target = Number(stage);
  if (!TARGET_STAGES.includes(target)) throw new Error(`unsupported target stage ${stage}`);
  const flags = getRentalMarketplaceFlags();
  const flagChecks = buildFlagChecks({ flags, stage: target });

  const probeEmail = resolveProbeEmail(db);
  if (!probeEmail) throw new Error("no account available to mint an authenticated probe session");
  const cookie = mintSessionCookieValue(sessionCookie, probeEmail);

  const gates = await probeStageGates({ baseUrl, fetchImpl, cookie });
  const gateView = classifyGates({ gates, stage: target });
  const redaction = buildRedactionChecks({ gates });

  const checks = {
    pr_a_flags_on: flagChecks.pr_a_flags_on,
    stage1_on: flagChecks.stage1_on && flagChecks.earlier_stages_on,
    target_stage_on: flagChecks.target_stage_on && gateView.target_serving,
    later_stages_off: flagChecks.later_stages_off && gateView.later_gates_closed,
    outbound_off: flagChecks.outbound_off,
    privacy_redaction:
      redaction.probe_bodies_without_pii &&
      redaction.closed_gate_responses_are_opaque &&
      redaction.authenticated_probe_requires_session,
  };
  const ok = Object.values(checks).every((value) => value === true);

  const doc = {
    schema: "rental-marketplace-stages-post-activation/v1",
    generated_at: new Date().toISOString(),
    phase: "post_activation",
    probed_here: true,
    authoritative_source: POST_ACTIVATION_SOURCE,
    stage: target,
    source_sha: sourceSha,
    ok,
    checks,
    flags_seen: {
      rental_catalog_v2_enabled: flags?.rental_catalog_v2?.enabled === true,
      lifecycle_enabled: flags?.wish?.lifecycle_enabled === true,
      ...Object.fromEntries(
        [...new Set([...EARLIER_FLAGS[target], ...STAGE_FLAGS[target], ...LATER_FLAGS[target], ...OUTBOUND_FLAGS])]
          .map((key) => [key, flags?.wish?.[key] === true]),
      ),
    },
    gates: {
      owner_matching_open: gateView.owner_matching_open,
      offer_gate_open: gateView.offer_gate_open,
      share_gate_open: gateView.share_gate_open,
      notifications_enabled: gateView.notifications_enabled,
      notifications_disabled: gateView.notifications_disabled,
      target_signal: gateView.target_signal,
      target_serving: gateView.target_serving,
      later_gates_closed: gateView.later_gates_closed,
      anonymous_notification_probe_status: gates.notifications_anonymous.status,
    },
    redaction,
    probe_timings_ms: Object.fromEntries(
      Object.entries(gates).map(([name, probe]) => [name, probe.elapsed_ms]),
    ),
    probe_account: opaqueId(probeEmail),
  };

  assertNoEvidenceSecrets(doc);
  writeFileSync(resultPath, JSON.stringify(doc, null, 2) + "\n");
  if (!ok) {
    throw new Error(`staged Stage ${target} post-activation probes failed: ${JSON.stringify(checks)}`);
  }
  return doc;
}

async function main() {
  const spec = process.env.STAGES_DOMAIN_DB_MODULE || "/app/src/db.js";
  const href = spec.startsWith("file:") ? spec : pathToFileURL(path.resolve(spec)).href;
  // Load env.js first so auth.js signs cookies with the running server's real
  // session secret (see the header comment).
  const envSpec = process.env.STAGES_ENV_MODULE || "/app/src/env.js";
  await import(pathToFileURL(path.resolve(envSpec)).href);
  const [dbMod, authMod] = await Promise.all([
    import(href),
    import(pathToFileURL(path.resolve(process.env.STAGES_AUTH_MODULE || "/app/src/auth.js")).href),
  ]);
  await runStagedPostActivationGate({
    db: dbMod.db,
    getRentalMarketplaceFlags: dbMod.getRentalMarketplaceFlags,
    sessionCookie: authMod.sessionCookie,
    stage: process.env.STAGES_POSTCHECK_STAGE,
    sourceSha: process.env.STAGES_POSTCHECK_SOURCE_SHA || "",
  });
  console.log("POST_ACTIVATION_PROBES_OK");
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  await main();
}

