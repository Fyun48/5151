import { test } from "node:test";
import assert from "node:assert/strict";
import "./secretAtRestKey.js";
import { openOpsDb } from "../src/opsDb.js";
import { ensureDefaultProduct, issueCredential, listActiveCredentials, resolveIngestAuth, rotateCredential } from "../src/products.js";
import { ensureCommandCredential, getActiveCommandSecret } from "../src/siteCommand.js";
import { decryptSecret, secretAtRestKey, isEncryptedSecretBlob } from "../src/secretAtRest.js";
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
