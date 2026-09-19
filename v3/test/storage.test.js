import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveStorageDriver,
  deterministicStorageKey,
  createLocalStorage,
  createStorage,
  createS3Storage,
} from "../src/storage.js";
import { migrateMedia, verifyMedia } from "../src/mediaMigration.js";

function tmpDir(name) {
  return mkdtempSync(path.join(tmpdir(), name));
}

test("resolveStorageDriver defaults to local and accepts s3", () => {
  assert.equal(resolveStorageDriver({}), "local");
  assert.equal(resolveStorageDriver({ STORAGE_DRIVER: "s3" }), "s3");
  assert.equal(resolveStorageDriver({ STORAGE_DRIVER: "r2" }), "s3");
  assert.equal(resolveStorageDriver({ STORAGE_DRIVER: "bogus" }), "local");
});

test("deterministicStorageKey is stable for the same content hash", () => {
  const a = deterministicStorageKey("photos", "id1", { contentHash: "abc", extension: "jpg" });
  const b = deterministicStorageKey("photos", "id1", { contentHash: "abc", extension: "jpg" });
  assert.equal(a, b);
  assert.match(a, /^photos\/ab\/abc\.jpg$/);
});

test("local storage put/get/delete/metadata/list", async () => {
  const dir = tmpDir("5151-store-");
  const store = createLocalStorage(dir);
  const key = deterministicStorageKey("m", "1", { contentHash: "h" });
  const buf = Buffer.from("hello media");
  const r = await store.put(key, buf, { contentType: "image/jpeg" });
  assert.equal(r.bytes, buf.length);
  assert.equal(await store.exists(key), true);
  assert.deepEqual(await store.get(key), buf);
  assert.equal((await store.getMetadata(key)).bytes, buf.length);
  assert.deepEqual(await store.list(), [key]);

  await store.delete(key);
  assert.equal(await store.exists(key), false);
  assert.equal(await store.get(key), null);
  rmSync(dir, { recursive: true, force: true });
});

test("migrateMedia dry-run then migrate + verify + resume", async () => {
  const srcDir = tmpDir("5151-src-");
  const dstDir = tmpDir("5151-dst-");
  const src = createLocalStorage(srcDir);
  const dst = createLocalStorage(dstDir);
  await src.put("a/1", Buffer.from("A"));
  await src.put("b/2", Buffer.from("BB"));

  const dry = await migrateMedia({ source: src, target: dst, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.count, 2);
  assert.deepEqual(await dst.list(), []);

  const first = await migrateMedia({ source: src, target: dst });
  assert.equal(first.migrated.length, 2);
  assert.ok(first.verify.every((r) => r.ok));

  // resume: second run skips already-migrated keys (no duplication)
  const second = await migrateMedia({ source: src, target: dst });
  assert.equal(second.migrated.length, 0);
  assert.equal(second.skipped.length, 2);
  assert.deepEqual(await dst.list().then((l) => l.sort()), ["a/1", "b/2"]);

  rmSync(srcDir, { recursive: true, force: true });
  rmSync(dstDir, { recursive: true, force: true });
});

test("s3 driver without credentials throws OBJECT_STORAGE_EXTERNAL_SETUP_REQUIRED", async () => {
  const s3 = createStorage({ driver: "s3", s3: {} });
  assert.equal(s3.name, "s3");
  assert.equal(s3.configured, false);
  await assert.rejects(() => s3.put("k", Buffer.from("x")), /OBJECT_STORAGE_EXTERNAL_SETUP_REQUIRED/);
  await assert.rejects(() => s3.get("k"), /OBJECT_STORAGE_EXTERNAL_SETUP_REQUIRED/);
});

test("createStorage(local) requires rootDir", () => {
  assert.throws(() => createStorage({ driver: "local" }), /requires rootDir/);
});
