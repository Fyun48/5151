import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { openOpsDb } from "../src/opsDb.js";
import { makeAuth } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { LocalPersistentStorage } from "../src/storage/localStorage.js";
import { makeNoopScanner } from "../src/malwareScan.js";

const CFG = { ownerEmail: "owner@example.com", ownerPassword: "pw", sessionSecret: "s" };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNGBYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const UNKNOWN = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

async function withServer(run) {
  const db = openOpsDb(":memory:");
  const auth = makeAuth(CFG);
  const dir = path.join(os.tmpdir(), `ops-api-attach-${process.pid}-${randomBytes(6).toString("hex")}`);
  const storage = new LocalPersistentStorage(dir);
  const server = createApp({ db, auth, storage, scanner: makeNoopScanner() }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // seed a feedback row
  db.prepare(`INSERT INTO ingested_feedback(delivery_id, idempotency_key, source, received_at) VALUES ('d1','k1','v3',?)`).run(new Date().toISOString());
  const fid = Number(db.prepare("SELECT id FROM ingested_feedback LIMIT 1").get().id);
  try {
    await run({ base, db, fid });
  } finally {
    server.close();
    db.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function login(base) {
  const res = await fetch(`${base}/ops/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "pw" }),
  });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const me = await (await fetch(`${base}/ops/api/me`, { headers: { cookie } })).json();
  return { cookie, csrf: me.csrfToken };
}

function upload(base, { cookie, csrf, fid, mime, filename = "a.bin", body, origin }) {
  return fetch(`${base}/ops/api/attachments`, {
    method: "POST",
    headers: {
      cookie,
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(origin ? { Origin: origin } : {}),
      "Content-Type": mime,
      "X-Feedback-Id": String(fid),
      "X-Filename": filename,
    },
    body,
  });
}

test("valid JPEG upload accepted (201), scan skipped", async () => {
  await withServer(async ({ base, fid }) => {
    const { cookie, csrf } = await login(base);
    const res = await upload(base, { cookie, csrf, fid, mime: "image/jpeg", filename: "photo.jpg", body: JPEG, origin: base });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.scan_status, "skipped");
    assert.ok(data.sha256.length === 64);
  });
});

test("upload requires CSRF (mutation guard)", async () => {
  await withServer(async ({ base, fid }) => {
    const { cookie } = await login(base);
    const res = await upload(base, { cookie, csrf: null, fid, mime: "image/jpeg", body: JPEG, origin: base });
    assert.equal(res.status, 403);
  });
});

test("MIME spoof (declared png, jpeg bytes) rejected 415", async () => {
  await withServer(async ({ base, fid }) => {
    const { cookie, csrf } = await login(base);
    const res = await upload(base, { cookie, csrf, fid, mime: "image/png", body: JPEG, origin: base });
    assert.equal(res.status, 415);
  });
});

test("unknown/octet-stream rejected 415", async () => {
  await withServer(async ({ base, fid }) => {
    const { cookie, csrf } = await login(base);
    const res = await upload(base, { cookie, csrf, fid, mime: "application/octet-stream", body: UNKNOWN, origin: base });
    assert.equal(res.status, 415);
  });
});

test("upload to non-existent feedback → 404", async () => {
  await withServer(async ({ base }) => {
    const { cookie, csrf } = await login(base);
    const res = await upload(base, { cookie, csrf, fid: 99999, mime: "image/jpeg", body: JPEG, origin: base });
    assert.equal(res.status, 404);
  });
});

test("oversize upload rejected 413 (early limit)", async () => {
  const prev = { i: process.env.OPS_ATTACH_MAX_IMAGE, a: process.env.OPS_ATTACH_MAX_AUDIO, l: process.env.OPS_ATTACH_MAX_LOG };
  process.env.OPS_ATTACH_MAX_IMAGE = "40";
  process.env.OPS_ATTACH_MAX_AUDIO = "40";
  process.env.OPS_ATTACH_MAX_LOG = "40";
  try {
    await withServer(async ({ base, fid }) => {
      const { cookie, csrf } = await login(base);
      const big = Buffer.concat([JPEG, Buffer.alloc(200, 7)]);
      const res = await upload(base, { cookie, csrf, fid, mime: "image/jpeg", body: big, origin: base });
      assert.equal(res.status, 413);
    });
  } finally {
    process.env.OPS_ATTACH_MAX_IMAGE = prev.i; process.env.OPS_ATTACH_MAX_AUDIO = prev.a; process.env.OPS_ATTACH_MAX_LOG = prev.l;
    if (prev.i === undefined) delete process.env.OPS_ATTACH_MAX_IMAGE;
    if (prev.a === undefined) delete process.env.OPS_ATTACH_MAX_AUDIO;
    if (prev.l === undefined) delete process.env.OPS_ATTACH_MAX_LOG;
  }
});

test("unauthorized retrieval rejected; owner retrieval succeeds with safe headers", async () => {
  await withServer(async ({ base, fid }) => {
    const { cookie, csrf } = await login(base);
    const up = await upload(base, { cookie, csrf, fid, mime: "image/jpeg", filename: "report.jpg", body: JPEG, origin: base });
    const { id } = await up.json();

    // 未授權
    const anon = await fetch(`${base}/ops/api/attachments/${id}`);
    assert.equal(anon.status, 401);

    // Owner 下載
    const res = await fetch(`${base}/ops/api/attachments/${id}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-disposition") || "", /^attachment;/);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(JPEG));

    // meta 不含 object_key / 物理路徑
    const meta = await (await fetch(`${base}/ops/api/attachments/${id}/meta`, { headers: { cookie } })).json();
    assert.equal(meta.id, id);
    assert.equal(meta.object_key, undefined);
    assert.equal(meta.scan_status, "skipped");
  });
});

test("retrieval requires auth for meta and list too", async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/ops/api/attachments/1/meta`)).status, 401);
    assert.equal((await fetch(`${base}/ops/api/attachments`)).status, 401);
  });
});
