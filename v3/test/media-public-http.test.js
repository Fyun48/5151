import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "os";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "media-http-"));

import { bufferHasWatermarkMarker, WATERMARK_MARKER } from "../src/imageProcess.js";
import {
  ensureMemberMediaSchema,
  memberMediaDir,
  memberMediaInternalOriginalPath,
  saveMemberMedia,
  servePublicMemberMedia,
} from "../src/memberMedia.js";

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(24, 2)]);
const fakeProcessor = async (buf) => ({
  format: "jpg",
  mime: "image/jpeg",
  digest: "d" + (buf?.length || 0),
  main: { buffer: Buffer.from("MAIN-RAW-IMAGE"), width: 800, height: 600, bytes: 14 },
  thumb: { buffer: Buffer.from("THUMB-RAW"), bytes: 9 },
});
const watermarker = async (buf) => ({
  buffer: Buffer.concat([buf, Buffer.from("-W"), Buffer.from(`\n${WATERMARK_MARKER}\n`)]),
  watermarked: 1,
  skipped: false,
});

function open() {
  const db = new DatabaseSync(":memory:");
  ensureMemberMediaSchema(db);
  db.exec("CREATE TABLE listings (post_id INTEGER, source TEXT, cover TEXT, self_photos TEXT)");
  return db;
}

function listenPublicMedia() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 3 && parts[0] === "media" && parts[1] === "lib") {
      servePublicMemberMedia({ params: { file: decodeURIComponent(parts[2]) } }, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    }).on("error", reject);
  });
}

test("public media HTTP serves watermarked main/thumb and 404s the internal original", async () => {
  const db = open();
  const item = await saveMemberMedia(db, 9, jpeg(), { processor: fakeProcessor, watermarker });
  assert.equal("original_key" in item, false);
  assert.equal(JSON.stringify(item).includes("original_key"), false);
  assert.equal(JSON.stringify(item).includes("_o.jpg"), false);

  const baseName = item.url.replace("/media/lib/", "").replace(/\.jpg$/, "");
  const originalName = `${baseName}_o.jpg`;
  assert.ok(existsSync(path.join(memberMediaDir(), originalName)));
  assert.ok(memberMediaInternalOriginalPath(originalName));
  assert.equal(readFileSync(path.join(memberMediaDir(), originalName)).toString(), "MAIN-RAW-IMAGE");

  const { server, base } = await listenPublicMedia();
  try {
    const main = await httpGet(`${base}${item.url}`);
    assert.equal(main.status, 200);
    assert.match(main.headers["content-type"], /image\/jpeg/);
    assert.ok(bufferHasWatermarkMarker(main.body));
    assert.ok(main.body.includes(Buffer.from("-W")));
    assert.notEqual(main.body.toString(), "MAIN-RAW-IMAGE");

    const thumb = await httpGet(`${base}${item.thumb_url}`);
    assert.equal(thumb.status, 200);
    assert.ok(bufferHasWatermarkMarker(thumb.body));
    assert.ok(thumb.body.includes(Buffer.from("-W")));
    assert.notEqual(thumb.body.toString(), "THUMB-RAW");

    const original = await httpGet(`${base}/media/lib/${originalName}`);
    assert.equal(original.status, 404);
    assert.equal(original.body.length, 0);
    assert.notEqual(original.body.toString(), "MAIN-RAW-IMAGE");

    const queryOnPublic = [
      `${item.url}?variant=original`,
      `${item.url}?file=${originalName}`,
      `${item.url}?download=1`,
    ];
    for (const rel of queryOnPublic) {
      const res = await httpGet(`${base}${rel}`);
      assert.equal(res.status, 200, rel);
      assert.ok(bufferHasWatermarkMarker(res.body), rel);
      assert.notEqual(res.body.toString(), "MAIN-RAW-IMAGE", rel);
    }

    const blocked = [
      item.url.replace(".jpg", "_o.jpg"),
      item.url.replace(".jpg", "_O.jpg"),
      item.url.replace(".jpg", "_orig.jpg"),
      item.url.replace(".jpg", "_original.jpg"),
      `/media/lib/${encodeURIComponent(originalName)}`,
      `/media/lib/${baseName}.jpg/../${originalName}`,
      `/media/lib/../${originalName}`,
      `/media/lib/${baseName}%5Fo.jpg`,
    ];
    for (const rel of blocked) {
      const res = await httpGet(`${base}${rel}`);
      assert.notEqual(res.status, 200, rel);
      assert.notEqual(res.body.toString(), "MAIN-RAW-IMAGE", rel);
      assert.equal(bufferHasWatermarkMarker(res.body), false, rel);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(() => {
  try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
