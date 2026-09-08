import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "os";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "wm-data-"));

import {
  applySiteWatermark,
  bufferHasWatermarkMarker,
  shouldApplyWatermark,
  WATERMARK_MARKER,
} from "../src/imageProcess.js";
import {
  ensureMemberMediaSchema,
  saveMemberMedia,
  reprocessMemberMediaDisplay,
  memberMediaDir,
} from "../src/memberMedia.js";

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(24, 2)]);
const fakeProcessor = async (buf) => ({
  format: "jpg",
  mime: "image/jpeg",
  digest: "d" + (buf?.length || 0),
  main: { buffer: Buffer.from("MAIN-RAW-IMAGE"), width: 800, height: 600, bytes: 14 },
  thumb: { buffer: Buffer.from("thumb"), bytes: 5 },
});

function open() {
  const db = new DatabaseSync(":memory:");
  ensureMemberMediaSchema(db);
  db.exec("CREATE TABLE listings (post_id INTEGER, source TEXT, cover TEXT, self_photos TEXT)");
  return db;
}

test("shouldApplyWatermark skips already marked rows", () => {
  assert.equal(shouldApplyWatermark({ watermarked: 0 }), true);
  assert.equal(shouldApplyWatermark({ watermarked: 1 }), false);
  assert.equal(shouldApplyWatermark({}), true);
});

test("applySiteWatermark is idempotent and does not stack overlays", async () => {
  let calls = 0;
  const overlay = async (buf) => {
    calls += 1;
    return Buffer.concat([buf, Buffer.from("-LOGO")]);
  };
  const first = await applySiteWatermark(Buffer.from("PHOTO"), { overlay });
  assert.equal(first.skipped, false);
  assert.equal(first.watermarked, 1);
  assert.ok(first.buffer.includes(Buffer.from("-LOGO")));
  assert.ok(bufferHasWatermarkMarker(first.buffer));
  const second = await applySiteWatermark(first.buffer, { overlay });
  assert.equal(second.skipped, true);
  assert.equal(calls, 1);
  assert.equal(second.buffer.toString("utf8").split("-LOGO").length - 1, 1);
  const flagged = await applySiteWatermark(Buffer.from("PHOTO"), { overlay, watermarked: 1 });
  assert.equal(flagged.skipped, true);
  assert.equal(calls, 1);
});

test("failed watermark does not write a damaged display file", async () => {
  const db = open();
  await assert.rejects(
    () => saveMemberMedia(db, 1, jpeg(), {
      processor: fakeProcessor,
      watermarker: async () => { throw Object.assign(new Error("overlay boom"), { code: "watermark_failed" }); },
    }),
    (e) => e.code === "watermark_failed",
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM member_media").get().n, 0);
});

test("save + retry keeps a single watermark and preserves original bytes", async () => {
  const db = open();
  let overlays = 0;
  const watermarker = async (buf) => {
    overlays += 1;
    return { buffer: Buffer.concat([buf, Buffer.from("-W"), Buffer.from(`\n${WATERMARK_MARKER}\n`)]), watermarked: 1, skipped: false };
  };
  const item = await saveMemberMedia(db, 3, jpeg(), { processor: fakeProcessor, watermarker });
  assert.equal(item.watermarked, true);
  const display = readFileSync(path.join(memberMediaDir(), item.url.replace("/media/lib/", "")));
  const original = readFileSync(path.join(memberMediaDir(), item.url.replace("/media/lib/", "").replace(".jpg", "_o.jpg")));
  assert.equal(original.toString(), "MAIN-RAW-IMAGE");
  assert.ok(display.includes(Buffer.from("-W")));
  const retry = await reprocessMemberMediaDisplay(db, 3, item.id, { watermarker });
  assert.equal(retry.skipped, true);
  assert.equal(overlays, 1);
});
