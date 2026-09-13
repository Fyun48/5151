import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
