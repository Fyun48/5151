import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectImageKind,
  isSelfPhotoPublicUrl,
  saveSelfPhoto,
  SELF_PHOTO_MAX_BYTES,
  selfPhotoDiskName,
} from "../src/selfPhotos.js";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

test("self photos only accept jpeg/png/webp magic bytes", () => {
  assert.equal(detectImageKind(PNG_1X1)?.ext, "png");
  assert.equal(detectImageKind(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))?.ext, "jpg");
  assert.equal(detectImageKind(Buffer.from("GIF89a....")), null);
  assert.equal(detectImageKind(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
  assert.equal(isSelfPhotoPublicUrl("/media/self/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"), true);
  assert.equal(isSelfPhotoPublicUrl("/media/self/../aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"), false);
  assert.equal(selfPhotoDiskName("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png");
  assert.equal(selfPhotoDiskName("../aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png");
  assert.equal(selfPhotoDiskName("not-a-photo.png"), "");
});

test("saveSelfPhoto writes under DATA_DIR and rejects oversized junk", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "self-photos-"));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const saved = saveSelfPhoto(PNG_1X1);
    assert.match(saved.url, /^\/media\/self\/[a-f0-9]{32}\.png$/);
    const name = saved.url.slice("/media/self/".length);
    const onDisk = readFileSync(path.join(dir, "self-photos", name));
    assert.equal(onDisk.equals(PNG_1X1), true);
    assert.throws(() => saveSelfPhoto(Buffer.from("not-an-image")), /JPG/);
    assert.throws(
      () => saveSelfPhoto(Buffer.alloc(SELF_PHOTO_MAX_BYTES + 1, 0xff)),
      /2MB/,
    );
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth allows public media self paths", async () => {
  const { publicPath } = await import("../src/auth.js");
  assert.equal(publicPath({ path: "/media/self/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg" }), true);
  assert.equal(publicPath({ path: "/api/self-listings/photos" }), false);
});
