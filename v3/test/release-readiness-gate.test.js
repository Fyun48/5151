import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RENTAL_MARKETPLACE_FLAGS,
  normalizeRentalMarketplaceFlags,
  publicRentalMarketplaceFlags,
} from "../src/rentalMarketplaceFlags.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function wf(name) {
  return readFileSync(path.join(root, ".github/workflows", name), "utf8");
}

function onBlock(text) {
  const m = text.match(/\non:\n([\s\S]*?)\n[a-zA-Z]/);
  return m ? m[1] : "";
}

const CANONICAL = [
  "build-production-image.yml",
  "production-predeploy-check.yml",
  "deploy-v3.yml",
];

test("canonical Production path is dispatch-only and SHA/digest bound", () => {
  for (const name of CANONICAL) {
    const text = wf(name);
    const block = onBlock(text);
    assert.match(block, /workflow_dispatch:/);
    assert.doesNotMatch(block, /(^|\n)\s*push:/);
    assert.doesNotMatch(block, /(^|\n)\s*pull_request:/);
    assert.doesNotMatch(block, /(^|\n)\s*schedule:/);
    assert.doesNotMatch(block, /(^|\n)\s*workflow_run:/);
    assert.match(text, /\[0-9a-f\]\{40\}/);
    assert.match(text, /refs\/heads\/master/);
  }
  const deploy = wf("deploy-v3.yml");
  assert.match(deploy, /sha256:\[0-9a-f\]\{64\}/);
  assert.match(deploy, /v3 must not resolve to :latest/);
  assert.doesNotMatch(deploy, /build-push-action/);
});

test("docker.yml latest-tag path is retired and cannot deploy", () => {
  const text = wf("docker.yml");
  const block = onBlock(text);
  assert.match(block, /workflow_dispatch:/);
  assert.doesNotMatch(block, /(^|\n)\s*push:/);
  assert.match(text, /latest-tag deploy path retired|:latest 部署路徑已拆除/);
  assert.doesNotMatch(text, /outputs\.name \}\}:latest/);
  assert.doesNotMatch(text, /build-push-action/);
  assert.doesNotMatch(text, /docker compose (pull|up)/);
  assert.doesNotMatch(text, /appleboy\/(scp|ssh)-action/);
  assert.doesNotMatch(text, /packages:\s*write/);
  assert.match(text, /group:\s*production-deploy/);
});

test("default and public marketplace flags keep B/C/D and outbound OFF", () => {
  const defaults = normalizeRentalMarketplaceFlags(DEFAULT_RENTAL_MARKETPLACE_FLAGS);
  assert.equal(defaults.rental_catalog_v2.enabled, false);
  for (const key of [
    "lifecycle_enabled",
    "owner_matching_enabled",
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
    "digest_enabled",
    "outbound_mail_enabled",
    "outbound_push_enabled",
  ]) {
    assert.equal(defaults.wish[key], false, key);
  }
  const publicFlags = publicRentalMarketplaceFlags({
    rental_catalog_v2: { enabled: true },
    wish: {
      lifecycle_enabled: true,
      owner_matching_enabled: true,
      offer_enabled: true,
      public_share_v2_enabled: true,
      owner_notifications_enabled: true,
      notifications_enabled: true,
      digest_enabled: true,
      outbound_mail_enabled: true,
      outbound_push_enabled: true,
    },
  });
  assert.equal(publicFlags.rental_catalog_v2.enabled, true);
  assert.equal(publicFlags.wish.lifecycle_enabled, true);
  for (const key of [
    "owner_matching_enabled",
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
    "digest_enabled",
    "outbound_mail_enabled",
    "outbound_push_enabled",
  ]) {
    assert.equal(publicFlags.wish[key], false, key);
  }
});

test("PRA activation reserved list includes notify and outbound flags", () => {
  const domain = readFileSync(
    path.join(root, ".github/scripts/activate-rental-marketplace-pra-domain.mjs"),
    "utf8",
  );
  for (const key of [
    "owner_matching_enabled",
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
    "digest_enabled",
    "outbound_mail_enabled",
    "outbound_push_enabled",
  ]) {
    assert.match(domain, new RegExp(`"${key}"`));
    assert.doesNotMatch(domain, new RegExp(`${key}:\\s*true`));
  }
});

test("Stage 1 activation workflow exists as a separate manual-only path", () => {
  const text = wf("activate-rental-marketplace-stage1.yml");
  const block = onBlock(text);
  assert.match(block, /workflow_dispatch:/);
  assert.doesNotMatch(block, /(^|\n)\s*push:/);
  assert.match(text, /ACTIVATE-STAGE1-PRODUCTION/);
  assert.match(text, /group:\s*production-deploy/);
  const domain = readFileSync(
    path.join(root, ".github/scripts/activate-rental-marketplace-stage1-domain.mjs"),
    "utf8",
  );
  assert.match(domain, /owner_matching_enabled:\s*true/);
  assert.doesNotMatch(domain, /rental_catalog_v2:\s*\{\s*enabled:\s*false\s*\}/);
  for (const key of [
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
    "notifications_enabled",
    "digest_enabled",
    "outbound_mail_enabled",
    "outbound_push_enabled",
  ]) {
    assert.doesNotMatch(domain, new RegExp(`${key}:\\s*true`));
  }
});

test("readiness evidence file is present", () => {
  assert.equal(existsSync(path.join(root, "v3/RELEASE-READINESS.md")), true);
  assert.equal(
    existsSync(path.join(root, "v3/evidence/production-uat-20260917-pre-activation.json")),
    true,
  );
});
