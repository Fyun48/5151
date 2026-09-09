import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "os";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mtag-"));

import {
  ensureMemberMediaSchema,
  saveMemberMedia,
  listMemberMedia,
  deleteMemberMedia,
  createMediaTag,
  renameMediaTag,
  deleteMediaTag,
  setMediaTags,
  listMediaTags,
  mediaUrlsForTagIds,
} from "../src/memberMedia.js";

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12, 3)]);
const fakeProcessor = async (buf) => ({
  format: "jpg", mime: "image/jpeg", digest: "d" + (buf?.length || 0),
  main: { buffer: Buffer.from("main"), width: 100, height: 80, bytes: 4 },
  thumb: { buffer: Buffer.from("t"), bytes: 1 },
});
const passthroughWm = async (buf) => ({ buffer: buf, watermarked: 1, skipped: false });

function open() {
  const db = new DatabaseSync(":memory:");
  ensureMemberMediaSchema(db);
  db.exec("CREATE TABLE listings (post_id INTEGER, source TEXT, cover TEXT, self_photos TEXT)");
  return db;
}

async function saveOne(db, userId = 1) {
  return saveMemberMedia(db, userId, jpeg(), { processor: fakeProcessor, watermarker: passthroughWm });
}

test("create rename delete tags without deleting photos", async () => {
  const db = open();
  const photo = await saveOne(db);
  const kitchen = createMediaTag(db, 1, "廚房");
  const living = createMediaTag(db, 1, "客廳");
  setMediaTags(db, 1, photo.id, [kitchen.id, living.id]);
  assert.deepEqual(getNames(db, photo.id), ["客廳", "廚房"]);
  renameMediaTag(db, 1, kitchen.id, "開放式廚房");
  assert.deepEqual(getNames(db, photo.id), ["客廳", "開放式廚房"]);
  deleteMediaTag(db, 1, living.id);
  assert.deepEqual(getNames(db, photo.id), ["開放式廚房"]);
  assert.equal(listMemberMedia(db, 1).items.length, 1);
});

test("duplicate tag names reuse the same row; other users cannot see tags", async () => {
  const db = open();
  const a = createMediaTag(db, 1, "陽台");
  const again = createMediaTag(db, 1, "陽台");
  assert.equal(again.id, a.id);
  assert.equal(again.reused, true);
  createMediaTag(db, 2, "陽台");
  assert.equal(listMediaTags(db, 1).length, 1);
  assert.equal(listMediaTags(db, 2).length, 1);
  const photo = await saveOne(db, 1);
  assert.throws(() => setMediaTags(db, 2, photo.id, [a.id]), (e) => e.status === 404);
});

test("selecting tags returns the union of tagged photos; removed photos drop maps", async () => {
  const db = open();
  const a = await saveOne(db);
  const b = await saveOne(db);
  const c = await saveOne(db);
  const day = createMediaTag(db, 1, "採光");
  const quiet = createMediaTag(db, 1, "安靜");
  setMediaTags(db, 1, a.id, [day.id]);
  setMediaTags(db, 1, b.id, [day.id, quiet.id]);
  setMediaTags(db, 1, c.id, [quiet.id]);
  const urls = mediaUrlsForTagIds(db, 1, [day.id]);
  assert.equal(urls.length, 2);
  assert.ok(urls.includes(a.url) && urls.includes(b.url));
  const both = mediaUrlsForTagIds(db, 1, [day.id, quiet.id]);
  assert.equal(both.length, 3);
  deleteMemberMedia(db, 1, a.id);
  assert.equal(mediaUrlsForTagIds(db, 1, [day.id]).length, 1);
  assert.deepEqual(getNames(db, a.id), []);
});

function getNames(db, mediaId) {
  return db.prepare(
    `SELECT t.name FROM media_tag_map m JOIN media_tags t ON t.id=m.tag_id WHERE m.media_id=? ORDER BY t.name COLLATE NOCASE`,
  ).all(mediaId).map((row) => row.name);
}
