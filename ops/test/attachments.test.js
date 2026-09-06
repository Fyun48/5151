import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { openOpsDb } from "../src/opsDb.js";
import { LocalPersistentStorage } from "../src/storage/localStorage.js";
import { makeNoopScanner } from "../src/malwareScan.js";
import {
  validateAttachment,
  sanitizeFilename,
  detectType,
  acceptAttachment,
  getAttachmentRow,
  contentDisposition,
} from "../src/attachments.js";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(16, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 1)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(32, 1)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(32, 1)]);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 1)]);
const TEXTLOG = Buffer.from("2026-01-01 ERROR something happened\n");
const JSONLOG = Buffer.from('{"level":"error","msg":"x"}');
const UNKNOWN = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);

function tmpStorage() {
  const dir = path.join(os.tmpdir(), `ops-attach-${process.pid}-${randomBytes(6).toString("hex")}`);
  return { storage: new LocalPersistentStorage(dir), dir };
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
function seedFeedback(db, id = 1) {
  db.prepare(
    `INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, received_at)
     VALUES (?, ?, 'v3', ?)`,
  ).run(`d${id}`, `k${id}`, new Date().toISOString());
  return Number(db.prepare("SELECT id FROM ingested_feedback ORDER BY id DESC LIMIT 1").get().id);
}

test("detectType recognizes magic bytes and dangerous types", () => {
  assert.equal(detectType(JPEG), "jpeg");
  assert.equal(detectType(PNG), "png");
  assert.equal(detectType(WEBP), "webp");
  assert.equal(detectType(WEBM), "webm");
  assert.equal(detectType(OGG), "ogg");
  assert.equal(detectType(MP3), "mp3");
  assert.equal(detectType(HTML), "html");
  assert.equal(detectType(SVG), "svg");
  assert.equal(detectType(ZIP), "zip");
});

test("validateAttachment accepts allowed image/audio/log types", () => {
  assert.equal(validateAttachment({ declaredMime: "image/jpeg", buffer: JPEG }).category, "image");
  assert.equal(validateAttachment({ declaredMime: "image/png", buffer: PNG }).category, "image");
  assert.equal(validateAttachment({ declaredMime: "image/webp", buffer: WEBP }).category, "image");
  assert.equal(validateAttachment({ declaredMime: "audio/webm", buffer: WEBM }).category, "audio");
  assert.equal(validateAttachment({ declaredMime: "audio/ogg", buffer: OGG }).category, "audio");
  assert.equal(validateAttachment({ declaredMime: "audio/mpeg", buffer: MP3 }).category, "audio");
  assert.equal(validateAttachment({ declaredMime: "text/plain", buffer: TEXTLOG }).category, "log");
  assert.equal(validateAttachment({ declaredMime: "application/json", buffer: JSONLOG }).category, "log");
});

test("validateAttachment rejects oversize (per-category limit)", () => {
  const big = Buffer.concat([JPEG, Buffer.alloc(200, 1)]);
  assert.throws(() => validateAttachment({ declaredMime: "image/jpeg", buffer: big, env: { OPS_ATTACH_MAX_IMAGE: "50" } }), (e) => e.status === 413);
});

test("MIME spoofing rejected (declared png, jpeg bytes)", () => {
  assert.throws(() => validateAttachment({ declaredMime: "image/png", buffer: JPEG }), (e) => e.status === 415);
});

test("dangerous HTML/SVG rejected regardless of declared type", () => {
  assert.throws(() => validateAttachment({ declaredMime: "text/html", buffer: HTML }), (e) => e.status === 415); // not allowlisted
  assert.throws(() => validateAttachment({ declaredMime: "image/svg+xml", buffer: SVG }), (e) => e.status === 415); // not allowlisted
  // declared allowed log type but content is html/svg → detected dangerous
  assert.throws(() => validateAttachment({ declaredMime: "text/plain", buffer: HTML }), (e) => e.status === 415);
  assert.throws(() => validateAttachment({ declaredMime: "text/plain", buffer: SVG }), (e) => e.status === 415);
});

test("unknown binary and zip/executable rejected", () => {
  assert.throws(() => validateAttachment({ declaredMime: "image/png", buffer: UNKNOWN }), (e) => e.status === 415);
  assert.throws(() => validateAttachment({ declaredMime: "text/plain", buffer: ZIP }), (e) => e.status === 415);
  assert.throws(() => validateAttachment({ declaredMime: "application/octet-stream", buffer: UNKNOWN }), (e) => e.status === 415);
});

test("sanitizeFilename strips control chars / path separators / limits length", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(sanitizeFilename("a\u0000b\nc"), "abc");
  assert.equal(sanitizeFilename(""), "attachment");
  assert.equal(sanitizeFilename("x".repeat(500)).length, 200);
});

test("contentDisposition is always attachment and encodes unicode safely", () => {
  const cd = contentDisposition("報告 photo.png");
  assert.match(cd, /^attachment;/);
  assert.match(cd, /filename\*=UTF-8''/);
  assert.doesNotMatch(cd, /\r|\n/);
});

test("storage rejects path-traversal / non-uuid object keys", async () => {
  const { storage, dir } = tmpStorage();
  await assert.rejects(() => storage.putBuffer("../evil", JPEG), (e) => e.status === 400);
  await assert.rejects(() => storage.putBuffer("%2e%2e%2fevil", JPEG), (e) => e.status === 400);
  await assert.rejects(() => storage.putBuffer("/etc/passwd", JPEG), (e) => e.status === 400);
  cleanup(dir);
});

test("acceptAttachment stores file + row, sha256 correct, key is opaque uuid, scan skipped", async () => {
  const db = openOpsDb(":memory:");
  const fid = seedFeedback(db);
  const { storage, dir } = tmpStorage();
  const r = await acceptAttachment(db, { storage, scanner: makeNoopScanner() }, {
    feedbackId: fid, declaredMime: "image/jpeg", filename: "../../etc/passwd", buffer: JPEG,
  });
  assert.ok(r.id > 0);
  assert.equal(r.scan_status, "skipped"); // 絕不是 clean
  const row = getAttachmentRow(db, r.id);
  assert.match(row.object_key, /^[0-9a-f-]{36}$/); // 隨機 uuid，非使用者檔名
  assert.equal(row.original_filename, ".._.._etc_passwd"); // 只當 metadata
  const { createHash } = await import("node:crypto");
  assert.equal(row.sha256, createHash("sha256").update(JPEG).digest("hex"));
  assert.equal(await storage.exists(row.object_key), true);
  cleanup(dir);
  db.close();
});

test("object_key is unique across attachments", async () => {
  const db = openOpsDb(":memory:");
  const fid = seedFeedback(db);
  const { storage, dir } = tmpStorage();
  const a = await acceptAttachment(db, { storage, scanner: makeNoopScanner() }, { feedbackId: fid, declaredMime: "image/png", filename: "a.png", buffer: PNG });
  const b = await acceptAttachment(db, { storage, scanner: makeNoopScanner() }, { feedbackId: fid, declaredMime: "image/png", filename: "b.png", buffer: PNG });
  assert.notEqual(getAttachmentRow(db, a.id).object_key, getAttachmentRow(db, b.id).object_key);
  cleanup(dir);
  db.close();
});

test("attachment to non-existent feedback is rejected (FK/existence)", async () => {
  const db = openOpsDb(":memory:");
  const { storage, dir } = tmpStorage();
  await assert.rejects(
    () => acceptAttachment(db, { storage, scanner: makeNoopScanner() }, { feedbackId: 9999, declaredMime: "image/png", filename: "x.png", buffer: PNG }),
    (e) => e.status === 404,
  );
  cleanup(dir);
  db.close();
});

test("audit records metadata only — never raw content", async () => {
  const db = openOpsDb(":memory:");
  const fid = seedFeedback(db);
  const { storage, dir } = tmpStorage();
  const marker = Buffer.from("SUPER_SECRET_LOG_TOKEN ghp_abc\n");
  const logBuf = Buffer.concat([TEXTLOG, marker]);
  await acceptAttachment(db, { storage, scanner: makeNoopScanner() }, { feedbackId: fid, declaredMime: "text/plain", filename: "app.log", buffer: logBuf });
  const audits = db.prepare("SELECT data FROM audit_log WHERE action LIKE 'attachment.%'").all();
  assert.ok(audits.length >= 2);
  for (const a of audits) assert.doesNotMatch(a.data || "", /SUPER_SECRET_LOG_TOKEN/);
  cleanup(dir);
  db.close();
});

test("storage failure leaves no DB attachment row", async () => {
  const db = openOpsDb(":memory:");
  const fid = seedFeedback(db);
  const failingStorage = { name: "fail", async putBuffer() { throw new Error("disk full"); }, async delete() { return true; } };
  await assert.rejects(
    () => acceptAttachment(db, { storage: failingStorage, scanner: makeNoopScanner() }, { feedbackId: fid, declaredMime: "image/png", filename: "x.png", buffer: PNG }),
    /disk full/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feedback_attachment").get().n, 0);
  db.close();
});

test("DB failure leaves no untracked permanent file (cleanup)", async () => {
  const db = openOpsDb(":memory:");
  const fid = seedFeedback(db);
  const { storage, dir } = tmpStorage();
  let storedKey = null;
  const recording = {
    name: storage.name,
    async putBuffer(k, b) { storedKey = k; return storage.putBuffer(k, b); },
    async delete(k) { return storage.delete(k); },
    async exists(k) { return storage.exists(k); },
    async get(k) { return storage.get(k); },
  };
  // Proxy db：讓 feedback_attachment 的 INSERT 失敗
  const failingDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql) => {
          if (/INSERT\s+INTO\s+feedback_attachment/i.test(sql)) return { run: () => { throw new Error("db boom"); } };
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await assert.rejects(
    () => acceptAttachment(failingDb, { storage: recording, scanner: makeNoopScanner() }, { feedbackId: fid, declaredMime: "image/png", filename: "x.png", buffer: PNG }),
    /db boom/,
  );
  assert.ok(storedKey);
  assert.equal(await storage.exists(storedKey), false); // 檔案已被清理
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feedback_attachment").get().n, 0);
  cleanup(dir);
  db.close();
});
