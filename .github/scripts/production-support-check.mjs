// Support diagnostics only. Never starts the HTTP server or obtains a session.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export function sourceHash(root) {
  const hash = createHash("sha256");
  function visit(relative = "") {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else {
        assert(entry.isFile(), "Source tree contains a non-regular file");
        hash.update(name).update("\0").update(readFileSync(path.join(root, name))).update("\0");
      }
    }
  }
  visit();
  return hash.digest("hex");
}

export function responseSignals(status, headers, text) {
  const safeHeaders = {};
  for (const key of ["server", "content-type", "cf-mitigated", "cf-ray", "retry-after"]) {
    const value = headers.get(key);
    if (value) safeHeaders[key] = value.replace(/[^\x20-\x7e]/g, "").slice(0, 120);
  }
  return {
    http_status: status, headers: safeHeaders,
    response_bytes: Buffer.byteLength(text), body_sha256: sha256(text),
    signals: {
      cloudflare_challenge_header: headers.get("cf-mitigated") === "challenge",
      challenge_platform_script: /cdn-cgi\/challenge-platform/i.test(text),
      just_a_moment: /just a moment/i.test(text),
      captcha_widget: /recaptcha|hcaptcha|id=["']captcha|name=["']captcha/i.test(text),
    },
  };
}

async function rakuyaResponse() {
  const { fetchRakuyaListPage, rakuyaListUrl } = await import("/app/src/rakuya.js");
  const { hasListingMainContent, looksLikeChallengePage, looksLikeCaptchaOrLogin } = await import("/app/src/importSanitize.js");
  const url = rakuyaListUrl({ regionId: 1, page: 1 });
  assert.equal(url, "https://rent.rakuya.com.tw/result?city=0");
  const started = performance.now();
  let evidence = { http_status: null };
  let result;
  try {
    result = await fetchRakuyaListPage({ url, fetchText: async target => {
      assert.equal(target, url);
      const response = await fetch(target, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", Accept: "text/html" },
        redirect: "manual", signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      evidence = responseSignals(response.status, response.headers, text);
      evidence.signals.listing_content = hasListingMainContent(text);
      evidence.signals.adapter_challenge = looksLikeChallengePage(text);
      evidence.signals.adapter_captcha_or_login = looksLikeCaptchaOrLogin(text);
      return { status: response.status, text };
    } });
  } catch (error) {
    result = { ok: false, code: error.name === "TimeoutError" ? "TIMEOUT" : "FETCH_FAILED" };
  }
  return { checked_at: new Date().toISOString(), url, ...evidence,
    elapsed_ms: Math.round(performance.now() - started), ok: result.ok,
    code: result.code || (result.ok ? "SUCCESS" : "FETCH_FAILED"), parsed_records: result.items?.length || 0 };
}

export function timingStages(details) {
  return Object.fromEntries(Object.entries(details || {}).filter(([key, value]) =>
    (/^(?:[a-z_]+_ms|candidates)$/.test(key) && Number.isFinite(value) && value >= 0) ||
    (key === "cache_hit" && typeof value === "boolean") ||
    (key === "cache_miss_reason" && [null, "empty", "expired", "data_changed"].includes(value))));
}

async function snapshotBenchmark() {
  assert.equal(process.env.DATA_DIR, "/snapshot", "Refusing to import application against live data");
  const filename = "/snapshot/v3.db";
  assert.equal(realpathSync(filename), filename, "Snapshot must not be a symlink");
  assert.match(process.env.ACCOUNT_EMAIL_SHA256 || "", /^[0-9a-f]{64}$/);
  const initial = new DatabaseSync(filename, { readOnly: true });
  let user, beforeCount, beforeSettings;
  const settingsSql = "SELECT key, value FROM user_settings WHERE user_id = ? ORDER BY key";
  try {
    const matches = initial.prepare("SELECT id, email, role FROM users").all().filter(row =>
      sha256(String(row.email).trim().toLowerCase()) === process.env.ACCOUNT_EMAIL_SHA256);
    assert.equal(matches.length, 1, "Expected account was not uniquely found");
    user = matches[0];
    assert.equal(user.role, "admin", "Expected the existing administrator account");
    beforeCount = initial.prepare("SELECT COUNT(*) AS n FROM listings").get().n;
    beforeSettings = JSON.stringify(initial.prepare(settingsSql).all(user.id));
  } finally { initial.close(); }
  // No credentials are copied. Imports can initialize only the disposable copy.
  process.env.AUTH_EMAIL = user.email;
  process.env.AUTH_PASSWORD = "";
  process.env.SESSION_SECRET = "offline-snapshot-no-server";
  process.env.V1_DB_PATH = "/no-legacy-v1";
  process.env.V2_DB_PATH = "/no-legacy-v2";
  globalThis.fetch = () => { throw new Error("Network disabled in snapshot benchmark"); };
  const app = await import("/app/src/db.js");
  try {
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM listings").get().n, beforeCount, "Initialization changed listing count");
    assert.equal(JSON.stringify(app.db.prepare(settingsSql).all(user.id)), beforeSettings, "Initialization changed account settings");
    const query = { filter: "all", kind: "whole,elevator", sources: "", q: "", sort: "newest", limit: 50, offset: 0, districts: [], sameHouse: true };
    const samples = [];
    app.db.exec("CREATE TEMP TABLE support_cache_revision(n INTEGER)");
    for (const scenario of ["first_process_query", "warm", "warm", "warm", "warm", "warm", "data_changed", "data_changed", "data_changed"]) {
      // Change only a TEMP table to exercise the existing total_changes cache
      // invalidation, while all real listing values and result counts stay fixed.
      if (scenario === "data_changed") app.db.exec("INSERT INTO support_cache_revision VALUES (1)");
      const started = performance.now();
      const page = app.listListings({ ...query, userId: user.id, matchVoteUserId: user.id });
      const afterQuery = performance.now();
      const statsDetails = {};
      const counts = app.stats(undefined, user.id, undefined, statsDetails);
      const finished = performance.now();
      samples.push({ scenario, query_ms: Math.round(afterQuery - started), stats_ms: Math.round(finished - afterQuery),
        total_ms: Math.round(finished - started), dataset: page.totalMatched, returned: page.listings.length,
        stats_total: counts.total, stages: timingStages(page.queryDetails), stats_stages: timingStages(statsDetails),
        page_sha256: sha256(JSON.stringify(page.listings.map(row => row.post_id))) });
    }
    assert.equal(new Set(samples.map(row => row.page_sha256)).size, 1, "Snapshot results changed between samples");
    assert(samples.filter(row => row.scenario === "warm").every(row => row.stats_stages.cache_hit), "Warm stats did not hit cache");
    assert(samples.filter(row => row.scenario === "data_changed").every(row => row.stats_stages.cache_miss_reason === "data_changed"), "Cache invalidation was not exercised");
    return { checked_at: new Date().toISOString(), scope: "production_host_offline_database_snapshot",
      http_measured: false, network: "none", memory_limit: "1 GiB", node: process.version, account_matched: true,
      profile_sha256: sha256(beforeSettings), stored_rows: beforeCount, query,
      cache_invalidation: "TEMP table total_changes; no listing edits or concurrent crawler simulation", samples };
  } finally { app.db.close(); }
}

const mode = process.argv[2];
if (["source-hash", "rakuya-response", "snapshot"].includes(mode)) {
  const result = mode === "source-hash" ? sourceHash(process.argv[3] || "/app/src")
    : mode === "snapshot" ? await snapshotBenchmark() : await rakuyaResponse();
  console.log(typeof result === "string" ? result : JSON.stringify(result));
}
