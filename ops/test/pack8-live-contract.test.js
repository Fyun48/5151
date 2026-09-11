import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";
import { createProduct, listProducts } from "../src/products.js";
import {
  assertStableTargetIds,
  resolveProductionTarget,
  upsertProductEnvironment,
  DEFAULT_ENVIRONMENT_KEY,
} from "../src/productEnvironment.js";
import {
  assertCompleteRollbackContract,
  assertDbRestoreConfirmation,
  rollbackContractComplete,
  DB_RESTORE_CONFIRMATION,
} from "../src/release/rollbackContract.js";
import { previousStableComplete } from "../src/release/productionReleasePolicy.js";
import {
  getProductionStable,
  importOwnerDirectObservation,
  seedProductionStable,
} from "../src/release/productionRelease.js";
import { githubProviderLiveEnabled, makeGithubProductionReleaseProvider } from "../src/release/githubProductionReleaseProvider.js";
import { makeProductionReleaseProvider } from "../src/release/productionReleaseProvider.js";
import { INSTRUCTION_SOURCES } from "../src/instructionSource.js";

const SHA = "a".repeat(40);
const DIGEST = "sha256:" + "11".repeat(32);
const TREE = "aa".repeat(32);

test("display name cannot identify a production target", () => {
  const db = openOpsDb(":memory:");
  try {
    assert.throws(() => assertStableTargetIds({ displayName: "吉比租房" }), (e) => e.status === 400);
    assert.throws(() => assertStableTargetIds({ productId: "吉比租房" }), (e) => e.status === 400);
    assert.throws(() => resolveProductionTarget(db, { displayName: "吉比租房" }), (e) => e.status === 400);
    const v3 = resolveProductionTarget(db, { productId: "v3", environmentKey: "production" });
    assert.equal(v3.product_id, "v3");
    assert.equal(v3.environment_key, DEFAULT_ENVIRONMENT_KEY);
    assert.equal(v3.container_name, "591-tracker-v3");
    assert.notEqual(v3.product_id, v3.display_label);
  } finally {
    db.close();
  }
});

test("new product gets its own production environment, not the display name", () => {
  const db = openOpsDb(":memory:");
  try {
    const created = createProduct(db, { id: "shop", displayName: "商店站" });
    assert.equal(created.product.id, "shop");
    const env = resolveProductionTarget(db, { productId: "shop", environmentKey: "production" });
    assert.equal(env.product_id, "shop");
    assert.equal(env.environment_key, "production");
    assert.notEqual(env.environment_key, "商店站");
    upsertProductEnvironment(db, {
      productId: "shop",
      environmentKey: "production",
      containerName: "shop-prod",
      workflowFile: ".github/workflows/deploy-shop.yml",
      dataPath: "data-shop",
      deployIdentity: "Fyun48",
    });
    const listed = listProducts(db).find((p) => p.id === "shop");
    assert.equal(listed.environments[0].container_name, "shop-prod");
    assert.throws(
      () => upsertProductEnvironment(db, { productId: "商店站", environmentKey: "production" }),
      (e) => e.status === 400,
    );
  } finally {
    db.close();
  }
});

test("complete rollback contract needs SHA, digest, static tree, and compatible schema", () => {
  const digestOnly = {
    source_sha: SHA,
    artifact_digest: DIGEST,
    workflow_run_id: "1",
    provenance: { kind: "seeded" },
  };
  assert.equal(previousStableComplete(digestOnly), true);
  assert.equal(rollbackContractComplete(digestOnly), false);
  assert.throws(() => assertCompleteRollbackContract(digestOnly), (e) => e.status === 409);
  assert.equal(rollbackContractComplete({
    ...digestOnly,
    static_tree_hash: TREE,
    schema_compat: "compatible",
  }), true);
  assert.throws(
    () => assertCompleteRollbackContract({ ...digestOnly, static_tree_hash: TREE, schema_compat: "incompatible" }),
    (e) => e.status === 409,
  );
});

test("database restore needs a separate explicit confirmation and is not implied by rollback", () => {
  assert.deepEqual(assertDbRestoreConfirmation({}), { requested: false });
  assert.throws(() => assertDbRestoreConfirmation({ confirm_db_restore: true }), (e) => e.status === 409);
  assert.throws(() => assertDbRestoreConfirmation({ confirm_db_restore: "yes" }), (e) => e.status === 409);
  assert.deepEqual(assertDbRestoreConfirmation({ confirm_db_restore: DB_RESTORE_CONFIRMATION }), { requested: true });
});

test("owner-direct live observation is keyed by product and environment", () => {
  const db = openOpsDb(":memory:");
  try {
    seedProductionStable(db, {
      sourceSha: SHA,
      artifactDigest: DIGEST,
      workflowRunId: "1",
      staticTreeHash: TREE,
      schemaCompat: "compatible",
      provenance: { kind: "ops_candidate" },
      productId: "v3",
    });
    createProduct(db, { id: "shop", displayName: "商店站" });
    const newer = importOwnerDirectObservation(db, {
      productId: "v3",
      environmentKey: "production",
      sourceSha: "b".repeat(40),
      artifactDigest: "sha256:" + "22".repeat(32),
      staticTreeHash: "cc".repeat(32),
      schemaCompat: "compatible",
      workflowRunId: "99",
      instruction: { source: INSTRUCTION_SOURCES.VERIFIED_WORKFLOW_ACTOR, actor: "workflow:Fyun48" },
    });
    assert.equal(newer.source_sha, "b".repeat(40));
    assert.equal(getProductionStable(db, "v3", "production").source_sha, "b".repeat(40));
    assert.equal(getProductionStable(db, "shop", "production"), null);
  } finally {
    db.close();
  }
});

test("PRODUCTION_RELEASE_ALLOW_LIVE stays off by default and GitHub provider is unavailable", () => {
  assert.equal(githubProviderLiveEnabled({}), false);
  assert.equal(githubProviderLiveEnabled({
    PRODUCTION_RELEASE_ALLOW_LIVE: "0",
    PRODUCTION_RELEASE_MUTATION_GRANT: "not-enough",
    PRODUCTION_RELEASE_GITHUB_ACTOR: "Fyun48",
    GITHUB_TOKEN: "ghs_must_not_enable",
  }), false);
  assert.equal(makeGithubProductionReleaseProvider({ GITHUB_TOKEN: "ghs_x" }).available, false);
  assert.equal(makeProductionReleaseProvider({}).available, false);
});
