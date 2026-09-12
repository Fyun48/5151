import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sourceHash, responseSignals, timingStages } from "./production-support-check.mjs";

test("source identity includes nested file names and bytes, rejects symlinks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "support-source-"));
  try {
    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "nested", "a.js"), "source");
    const first = sourceHash(root);
    writeFileSync(path.join(root, "nested", "a.js"), "changed");
    assert.notEqual(sourceHash(root), first);
    symlinkSync("a.js", path.join(root, "nested", "link.js"));
    assert.throws(() => sourceHash(root), /non-regular/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("distinguishes a Cloudflare challenge from merely being served by Cloudflare", () => {
  const ordinary = responseSignals(200, new Headers({ server: "cloudflare" }), '<a data-ehid="abc">正常房源</a>');
  assert.equal(ordinary.signals.cloudflare_challenge_header, false);
  assert.equal(ordinary.signals.challenge_platform_script, false);
  const blocked = responseSignals(403, new Headers({ "cf-mitigated": "challenge", "cf-ray": "test-TPE" }),
    '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/test"></script>');
  assert.equal(blocked.signals.cloudflare_challenge_header, true);
  assert.equal(blocked.signals.challenge_platform_script, true);
  assert.equal(blocked.signals.just_a_moment, true);
});

test("does not emit cookie headers, HTML or arbitrary timing fields", () => {
  const secret = "private-cookie-or-listing-body";
  const result = responseSignals(403, new Headers({ "set-cookie": secret, authorization: secret, server: "cloudflare" }), secret);
  assert(!JSON.stringify(result).includes(secret));
  assert.deepEqual(timingStages({ prepare_ms: 1, candidates: 2, email: secret, cache_hit: false,
    cache_miss_reason: "data_changed", bad_ms: -5, body: secret }),
  { prepare_ms: 1, candidates: 2, cache_hit: false, cache_miss_reason: "data_changed" });
});

test("snapshot mode refuses a live DATA_DIR before importing the application", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./production-support-check.mjs", import.meta.url)), "snapshot"],
    { encoding: "utf8", env: { ...process.env, DATA_DIR: "/data" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to import application against live data/);
});
