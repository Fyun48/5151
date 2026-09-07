import { test } from "node:test";
import assert from "node:assert/strict";
import { detectImageSignature, assertUploadBytes, IMAGE_MAX_UPLOAD_BYTES } from "../src/imageProcess.js";

function sig(bytes) { return Buffer.from(bytes); }

test("detects jpeg/png/webp/avif by magic bytes; rejects non-images", () => {
  assert.equal(detectImageSignature(sig([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))?.ext, "jpg");
  assert.equal(detectImageSignature(sig([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))?.ext, "png");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
  assert.equal(detectImageSignature(webp)?.ext, "webp");
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from("ftyp"), Buffer.from("avif")]);
  assert.equal(detectImageSignature(avif)?.ext, "avif");
  // HTML/SVG/text masquerading → null
  assert.equal(detectImageSignature(Buffer.from("<html></html>            ")), null);
  assert.equal(detectImageSignature(Buffer.from("<svg xmlns=...>          ")), null);
  assert.equal(detectImageSignature(Buffer.from("GIF89a not allowed here ")), null);
});

test("assertUploadBytes: empty→400, oversized→413, non-image→415, jpeg→ok", () => {
  assert.throws(() => assertUploadBytes(Buffer.alloc(0)), (e) => e.status === 400);
  assert.throws(() => assertUploadBytes(Buffer.alloc(IMAGE_MAX_UPLOAD_BYTES + 1, 0)), (e) => e.status === 413);
  assert.throws(() => assertUploadBytes(Buffer.from("<html></html>            ")), (e) => e.status === 415);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20, 1)]);
  assert.equal(assertUploadBytes(jpeg).ext, "jpg");
});
