import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRevisionMatches,
  candidateTag,
  composeOverrideYaml,
  digestReference,
  isFullSha,
  isImageDigest,
  sourceLabelAllowed,
} from "../../.github/scripts/deploy-v3-digest.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const yml = readFileSync(path.join(root, ".github/workflows/deploy-v3.yml"), "utf8");
const RELEASE_SHA = "620c3a2419c6591626eb35df0eba5ce2a13ae2fa";
const RELEASE_DIGEST = "sha256:17cd853459aab52ca9c32f2d31bb280792ae834073e4b866bb8ea63119896227";

test("digest helpers accept only full SHA and sha256:64hex", () => {
  assert.equal(isFullSha(RELEASE_SHA), true);
  assert.equal(isFullSha("620c3a2"), false);
  assert.equal(isFullSha(""), false);
  assert.equal(isImageDigest(RELEASE_DIGEST), true);
  assert.equal(isImageDigest("latest"), false);
  assert.equal(isImageDigest("sha256:abc"), false);
  assert.equal(isImageDigest("SHA256:" + "a".repeat(64)), false);
  assert.equal(isImageDigest(""), false);
  assert.equal(candidateTag(RELEASE_SHA), `ghcr.io/fyun48/5151:${RELEASE_SHA}`);
  assert.throws(() => candidateTag("latest"), /40-character/);
  assert.equal(digestReference(RELEASE_DIGEST), `ghcr.io/fyun48/5151@${RELEASE_DIGEST}`);
});

test("compose override pins only v3 by digest and never :latest", () => {
  const text = composeOverrideYaml(RELEASE_DIGEST);
  assert.match(text, /591-tracker-v3:/);
  assert.match(text, new RegExp(`image: ghcr.io/fyun48/5151@${RELEASE_DIGEST}`));
  assert.doesNotMatch(text, /591-tracker-v2:/);
  assert.doesNotMatch(text, /:latest/);
  assert.throws(() => composeOverrideYaml("latest"), /digest/);
});

test("OCI revision must equal DEPLOY_SHA", () => {
  assert.doesNotThrow(() => assertRevisionMatches(RELEASE_SHA, RELEASE_SHA));
  assert.throws(() => assertRevisionMatches("deadbeef", RELEASE_SHA), /OCI revision/);
  assert.equal(sourceLabelAllowed("https://github.com/Fyun48/5151"), true);
  assert.equal(sourceLabelAllowed("https://github.com/fyun48/5151", "Fyun48/5151"), true);
  assert.equal(sourceLabelAllowed("https://example.com/other"), false);
});

test("deploy-v3 remains manual workflow_dispatch with production controls", () => {
  assert.match(yml, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(yml, /^  push:/m);
  assert.match(yml, /confirmation must be exactly DEPLOY-PRODUCTION/);
  assert.match(yml, /sha must be a full 40-character commit SHA/);
  assert.match(yml, /image_digest must be exactly sha256: plus 64 lowercase hex/);
  assert.match(yml, /environment: production/);
  assert.match(yml, /group: production-deploy/);
  assert.match(yml, /PRODUCTION_DEPLOY_ALLOWED_ACTOR/);
  assert.match(yml, /github.triggering_actor|TRIGGERING_ACTOR/);
  assert.match(yml, /refs\/heads\/master/);
  assert.match(yml, /merge-base --is-ancestor/);
});

test("deploy-v3 derives tag from DEPLOY_SHA and verifies digest/revision/sharp before NAS mutation", () => {
  const verifyIdx = yml.indexOf("Verify candidate registry artifact");
  const scpIdx = yml.indexOf("Copy v3 app");
  const sshIdx = yml.indexOf("Pull digest-pinned image");
  assert.ok(verifyIdx > 0 && verifyIdx < scpIdx && scpIdx < sshIdx);
  assert.match(yml, /IMAGE_REPO="ghcr.io\/\$\{GITHUB_REPOSITORY,,\}"/);
  assert.match(yml, /TAG="\$\{IMAGE_REPO\}:\$\{DEPLOY_SHA\}"/);
  assert.match(yml, /org.opencontainers.image.revision/);
  assert.match(yml, /REV != "\$DEPLOY_SHA"|\$REV" != "\$DEPLOY_SHA"/);
  assert.match(yml, /import\('sharp'\)/);
  assert.doesNotMatch(yml, /docker build |build-push-action|docker push /);
});

test("deploy-v3 pins Production v3 to digest and stops retired v1/v2", () => {
  assert.match(yml, /docker-compose.override.yml/);
  assert.match(yml, /image: \$\{IMAGE_REPO\}@\$\{IMAGE_DIGEST\}/);
  assert.match(yml, /v3 must not resolve to :latest/);
  assert.match(yml, /force-recreate 591-tracker-v3/);
  assert.match(yml, /docker compose stop 591-tracker 591-tracker-v2/);
  assert.doesNotMatch(yml, /force-recreate 591-tracker-v2/);
  assert.doesNotMatch(yml, /up -d[^\n]*591-tracker-v2/);
  assert.match(yml, /\/api\/health/);
  assert.match(yml, /login.html/);
  assert.match(yml, /State.Status/);
  assert.match(yml, /Config.Image/);
  assert.match(yml, /DEPLOY_V3_OK/);
});

test("NAS ssh script avoids bash case/;; because drone-ssh joins lines with semicolons", () => {
  const start = yml.indexOf("Pull digest-pinned image and recreate v3 only");
  const ssh = yml.slice(start);
  assert.doesNotMatch(ssh, /\besac\b/);
  assert.doesNotMatch(ssh, /;;/);
  assert.match(ssh, /grep -Eq ':latest\$'/);
});

function deploySshScript() {
  const start = yml.indexOf("- name: Pull digest-pinned image and recreate v3 only");
  assert.ok(start > 0, "deploy ssh step not found");
  const bodyAt = yml.indexOf("script: |", start);
  assert.ok(bodyAt > 0, "deploy ssh script block not found");
  const lines = [];
  for (const line of yml.slice(bodyAt).split("\n").slice(1)) {
    if (!line.trim()) continue;
    if (!/^\s{12,}\S/.test(line)) break;
    lines.push(line.slice(12));
  }
  assert.ok(lines.length > 20, `deploy ssh script looks empty (${lines.length} lines)`);
  return lines;
}

test("deploy ssh script has no comment lines (drone-ssh ;-join would comment out the next command)", () => {
  const lines = deploySshScript();
  const comments = lines.filter((line) => line.trim().startsWith("#"));
  assert.deepEqual(comments, [], "inline ssh scripts must not contain # comments");
  assert.ok(lines[0].trim() === "set -euo pipefail");
  assert.ok(lines.some((line) => line.includes("echo \"deploy_start")), "first diagnostic echo must stay");
});

test("deploy ssh script stays valid bash when every line is joined with semicolons", () => {
  const joined = deploySshScript().join("; ") + "\n";
  const probe = spawnSync("bash", ["-n"], { input: joined, encoding: "utf8" });
  if (probe.error && probe.error.code === "ENOENT") return;
  assert.equal(probe.status, 0, probe.stderr || "deploy ssh script is not join-safe bash");
});

// ---- HA web group steps（A 組在 CasaOS、B 組在 Synology） ----------------------
// A/B 是同一組後端（HAProxy 輪詢兩台），發版一定要兩台同一個 digest，否則 failover 到
// 舊版節點會跑舊程式。以下把兩步的契約釘住（先前這兩步沒有測試）。
const GROUP_STEPS = {
  A: "Recreate A-group web node with the same digest",
  B: "Recreate B-group web node with the same digest (Synology)",
};

function groupStepScript(name) {
  const start = yml.indexOf(`- name: ${name}`);
  assert.ok(start > 0, `step not found: ${name}`);
  const bodyAt = yml.indexOf("script: |", start);
  assert.ok(bodyAt > 0, `script block not found: ${name}`);
  const lines = [];
  for (const line of yml.slice(bodyAt).split("\n").slice(1)) {
    if (!line.trim()) continue;
    if (!/^\s{12,}\S/.test(line)) break;
    lines.push(line.slice(12));
  }
  assert.ok(lines.length > 10, `group ssh script looks empty (${name}: ${lines.length})`);
  return lines;
}

test("both web groups are recreated from the release digest and fail closed on drift", () => {
  for (const [label, name] of Object.entries(GROUP_STEPS)) {
    const script = groupStepScript(name).join("\n");
    assert.match(script, /IMAGE_DIGEST='\$\{\{ inputs\.image_digest \}\}'/, `${label} must consume the release digest`);
    assert.match(script, /IMAGE_PIN="ghcr\.io\/fyun48\/5151@\$\{IMAGE_DIGEST\}"/, `${label} must pin by digest`);
    assert.match(script, /is not the requested digest pin/, `${label} must fail closed when the rendered image differs`);
    assert.match(script, /grep -Eq ':latest\$'/, `${label} must reject :latest`);
    assert.match(script, /running .*container image is not the requested digest pin/, `${label} must verify the running container image`);
    assert.match(script, /api\/health/, `${label} must health-check after recreate`);
    assert.match(script, /SKIPPED reason=no_compose/, `${label} must skip cleanly when the node is not deployed`);
  }
});

test("B-group step uses the tori bridge with its own credentials and never starts the worker profile", () => {
  const start = yml.indexOf("- name: Synology NAS SSH endpoint for the B-group web node");
  assert.ok(start > 0, "tori bridge step not found");
  const bridge = yml.slice(start, yml.indexOf("- name: Recreate B-group web node", start));
  assert.match(bridge, /hostname: ssh-tori\.reversalplay\.me/);
  assert.match(bridge, /client-id: \$\{\{ secrets\.CF_ACCESS_CLIENT_ID \}\}/);
  assert.match(bridge, /client-secret: \$\{\{ secrets\.CF_ACCESS_CLIENT_SECRET \}\}/);
  assert.match(bridge, /ssh-user: \$\{\{ secrets\.V3_SYNOLOGY_USER \}\}/);
  assert.match(bridge, /ssh-key: \$\{\{ secrets\.V3_SYNOLOGY_SSH_KEY \}\}/);
  assert.doesNotMatch(bridge, /NAS_SSH_KEY/, "B bridge must not reuse the CasaOS key");

  const script = groupStepScript(GROUP_STEPS.B).join("\n");
  assert.match(script, /compose up -d --no-build --force-recreate 5151-web-B/);
  assert.doesNotMatch(script, /5151-worker/, "B step must not start the profile-gated worker");
  assert.match(script, /DOCKER=\/usr\/local\/bin\/docker/, "non-interactive ssh on Synology has no docker on PATH");
});

test("A/B group ssh scripts contain no comment lines and stay valid bash when joined", () => {
  for (const [label, name] of Object.entries(GROUP_STEPS)) {
    const lines = groupStepScript(name);
    assert.deepEqual(
      lines.filter((line) => line.trim().startsWith("#")),
      [],
      `${label} group ssh script must not contain # comments`,
    );
    const probe = spawnSync("bash", ["-n"], { input: lines.join("; ") + "\n", encoding: "utf8" });
    if (probe.error && probe.error.code === "ENOENT") continue;
    assert.equal(probe.status, 0, `${label} group ssh script is not join-safe bash: ${probe.stderr || ""}`);
  }
});
