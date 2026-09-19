import { test } from "node:test";
import assert from "node:assert/strict";
import "./secretAtRestKey.js";
import { openOpsDb } from "../src/opsDb.js";
import { ensureDefaultProduct, issueCredential, listActiveCredentials, resolveIngestAuth, rotateCredential } from "../src/products.js";
import { ensureCommandCredential, getActiveCommandSecret, ensureSiteCommandSchema } from "../src/siteCommand.js";
import { decryptSecret, secretAtRestKey, isEncryptedSecretBlob } from "../src/secretAtRest.js";
import { migrateCredentialSecretsAtRest, migrateLegacyCredentialsOnStartup } from "../src/credentialMigration.js";
import { signIngestRequest } from "../src/ingestSignature.js";

test("issued ingest credential is encrypted at rest (DB never holds plaintext)", () => {
  const db = openOpsDb(":memory:");
  ensureDefaultProduct(db);
  const { secret } = issueCredential(db, { productId: "v3", label: "test" });
  assert.ok(secret && secret.length > 0);
  const row = db.prepare("SELECT secret FROM product_ingest_credential ORDER BY id DESC LIMIT 1").get();
  assert.notEqual(row.secret, secret);
  assert.equal(isEncryptedSecretBlob(row.secret), true);
  assert.equal(decryptSecret(row.secret, secretAtRestKey()), secret);
  db.close();
});

test("listActiveCredentials never exposes the plaintext secret", () => {
  const db = openOpsDb(":memory:");
  ensureDefaultProduct(db);
  const { secret } = issueCredential(db, { productId: "v3" });
  const rows = listActiveCredentials(db);
  assert.equal(rows.some((r) => r.secret === secret), false);
  assert.equal(rows.some((r) => String(r.secret).includes(secret)), false);
  db.close();
});

test("ingest HMAC verification still works against encrypted-at-rest secret", () => {
  const db = openOpsDb(":memory:");
  ensureDefaultProduct(db);
  const { secret } = issueCredential(db, { productId: "v3" });
  const method = "POST";
  const path = "/ops/api/ingest/feedback";
  const rawBody = JSON.stringify({ ok: true });
  const signed = signIngestRequest({ method, path, deliveryId: "d1", rawBody, secret });
  const headers = Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const result = resolveIngestAuth(db, { method, path, rawBody, headers, now: Date.now() });
  assert.equal(result.ok, true);
  assert.equal(result.productId, "v3");
  db.close();
});

test("rotation revokes old and returns a fresh secret once (old never readable again)", () => {
  const db = openOpsDb(":memory:");
  ensureDefaultProduct(db);
  const first = issueCredential(db, { productId: "v3", label: "a" });
  const rotated = rotateCredential(db, "v3");
  assert.ok(rotated.ingest_secret);
  assert.notEqual(rotated.ingest_secret, first.secret);
  const active = db.prepare("SELECT * FROM product_ingest_credential WHERE status='active'").all();
  assert.equal(active.length, 1);
  assert.notEqual(active[0].secret, rotated.ingest_secret);
  db.close();
});

test("wrong or missing key fails closed (plaintext unrecoverable)", () => {
  const db = openOpsDb(":memory:");
  ensureDefaultProduct(db);
  const { secret } = issueCredential(db, { productId: "v3" });
  const row = db.prepare("SELECT secret FROM product_ingest_credential ORDER BY id DESC LIMIT 1").get();
  assert.equal(decryptSecret(row.secret, null), null);
  assert.equal(decryptSecret(row.secret, Buffer.alloc(32, 7)), null);
  db.close();
});

test("command credential is encrypted at rest and decrypted only at the signing boundary", () => {
  const db = openOpsDb(":memory:");
  ensureDefaultProduct(db);
  const { secret } = ensureCommandCredential(db, "v3");
  assert.ok(secret);
  const row = db.prepare("SELECT secret FROM product_command_credential WHERE product_id='v3' AND cred_state='active' ORDER BY id DESC LIMIT 1").get();
  assert.notEqual(row.secret, secret);
  assert.equal(isEncryptedSecretBlob(row.secret), true);
  assert.equal(getActiveCommandSecret(db, "v3"), secret);
  db.close();
});

test("legacy plaintext credentials migrate to encrypted at rest (idempotent, no plaintext logged)", () => {
  const db = openOpsDb(":memory:");
  ensureDefaultProduct(db);
  ensureSiteCommandSchema(db);
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO product_ingest_credential(product_id, generation, secret, label, status, created_at) VALUES ('v3', 1, 'legacy-ingest-secret', 'old', 'active', ?)").run(ts);
  db.prepare("INSERT INTO product_command_credential(product_id, generation, secret, cred_state, created_at) VALUES ('v3', 1, 'legacy-command-secret', 'active', ?)").run(ts);
  const res = migrateCredentialSecretsAtRest(db);
  assert.equal(res.migrated_ingest, 1);
  assert.equal(res.migrated_command, 1);
  const irow = db.prepare("SELECT secret FROM product_ingest_credential WHERE label='old'").get();
  const crow = db.prepare("SELECT secret FROM product_command_credential WHERE cred_state='active'").get();
  assert.notEqual(irow.secret, "legacy-ingest-secret");
  assert.notEqual(crow.secret, "legacy-command-secret");
  assert.equal(isEncryptedSecretBlob(irow.secret), true);
  assert.equal(isEncryptedSecretBlob(crow.secret), true);
  assert.equal(decryptSecret(irow.secret, secretAtRestKey()), "legacy-ingest-secret");
  assert.equal(decryptSecret(crow.secret, secretAtRestKey()), "legacy-command-secret");
  // 冪等：第二次遷移 0 筆。
  const again = migrateCredentialSecretsAtRest(db);
  assert.equal(again.migrated_ingest, 0);
  assert.equal(again.migrated_command, 0);
  db.close();
});

test("credential migration fails closed without a key and leaves plaintext untouched", () => {
  const db = openOpsDb(":memory:");
  ensureDefaultProduct(db);
  db.prepare("INSERT INTO product_ingest_credential(product_id, generation, secret, label, status, created_at) VALUES ('v3', 1, 'legacy', 'old', 'active', ?)").run(new Date().toISOString());
  assert.throws(() => migrateCredentialSecretsAtRest(db, { key: null }), /OPS_SECRET_AT_REST_KEY/);
  const row = db.prepare("SELECT secret FROM product_ingest_credential WHERE label='old'").get();
  assert.equal(row.secret, "legacy");
  db.close();
});

test("startup wiring: legacy plaintext migrates, HMAC still authenticates, second startup idempotent", () => {
  const db = openOpsDb(":memory:");
  ensureDefaultProduct(db);
  // 模擬舊 DB 的明文 ingest 憑證。
  db.prepare("INSERT INTO product_ingest_credential(product_id, generation, secret, label, status, created_at) VALUES ('v3', 1, 'legacy-startup-secret', 'old', 'active', ?)").run(new Date().toISOString());

  const first = migrateLegacyCredentialsOnStartup(db);
  assert.equal(first.migrated_ingest, 1);
  const row = db.prepare("SELECT secret FROM product_ingest_credential WHERE label='old'").get();
  assert.equal(isEncryptedSecretBlob(row.secret), true);

  // 舊 HMAC 憑證遷移後仍可驗證。
  const method = "POST";
  const path = "/ops/api/ingest/feedback";
  const rawBody = JSON.stringify({ ok: true });
  const signed = signIngestRequest({ method, path, deliveryId: "d1", rawBody, secret: "legacy-startup-secret" });
  const headers = Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const auth = resolveIngestAuth(db, { method, path, rawBody, headers, now: Date.now() });
  assert.equal(auth.ok, true);

  // 第二次啟動冪等。
  const second = migrateLegacyCredentialsOnStartup(db);
  assert.equal(second.migrated_ingest, 0);
  db.close();
});
