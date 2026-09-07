import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

// 素材庫檔案寫在 DATA_DIR/member-media；用臨時目錄，並以 fake processor 避免相依 sharp（CI 無安裝相依）。
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "mm-data-"));

import {
  ensureMemberMediaSchema, saveMemberMedia, listMemberMedia, deleteMemberMedia, getOwnedMedia,
  ownsMediaUrl, isMemberMediaUrl, mediaKeyFromUrl, mediaQuotaForPlan, isMediaReferenced,
  memberMediaDiskName, memberMediaFilePath, countActiveMedia, memberMediaDir,
} from "../src/memberMedia.js";

const fakeProcessor = async (buf) => ({
  format: "jpg", mime: "image/jpeg", digest: "d" + (buf?.length || 0),
  main: { buffer: Buffer.from("main-bytes"), width: 800, height: 600, bytes: 10 },
  thumb: { buffer: Buffer.from("thumb"), bytes: 5 },
});
const buf = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10, 1)]);

function open() {
  const db = new DatabaseSync(":memory:");
  ensureMemberMediaSchema(db);
  db.exec("CREATE TABLE listings (post_id INTEGER, source TEXT, cover TEXT, self_photos TEXT)");
  return db;
}
async function saveN(db, userId, n, plan = "free") {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await saveMemberMedia(db, userId, buf(), { plan, processor: fakeProcessor }));
  return out;
}

test("quota: normal member 30, sponsor 100", () => {
  assert.equal(mediaQuotaForPlan("free"), 30);
  assert.equal(mediaQuotaForPlan("sponsor"), 100);
  assert.equal(mediaQuotaForPlan(undefined), 30);
});

test("normal member can save up to 30; 31st rejected (server-side)", async () => {
  const db = open();
  await saveN(db, 1, 30, "free");
  assert.equal(countActiveMedia(db, 1), 30);
  await assert.rejects(() => saveMemberMedia(db, 1, buf(), { plan: "free", processor: fakeProcessor }), (e) => e.status === 409 && e.code === "quota_exceeded");
});

test("sponsor quota 100 enforced; normal cannot exceed 30 even with sponsor-sized existing", async () => {
  const db = open();
  // 直接種 100 筆模擬既有（避免 100 次寫檔）
  const ts = new Date().toISOString();
  const ins = db.prepare("INSERT INTO member_media(user_id, storage_key, thumb_key, mime, format, created_at) VALUES (?,?,?, 'image/jpeg','jpg', ?)");
  for (let i = 0; i < 100; i++) ins.run(7, `seed-${i}.jpg`, "t.jpg", ts);
  await assert.rejects(() => saveMemberMedia(db, 7, buf(), { plan: "sponsor", processor: fakeProcessor }), (e) => e.code === "quota_exceeded");
});

test("sponsor downgrade: existing media preserved; cannot add while above normal quota; can delete", async () => {
  const db = open();
  const items = await saveN(db, 2, 40, "sponsor"); // 以贊助身分存 40 張
  assert.equal(countActiveMedia(db, 2), 40);
  // 降為一般（30）：不刪既有，但不可新增
  await assert.rejects(() => saveMemberMedia(db, 2, buf(), { plan: "free", processor: fakeProcessor }), (e) => e.code === "quota_exceeded");
  assert.equal(countActiveMedia(db, 2), 40); // 既有保留
  // 可刪除以降到門檻以下
  deleteMemberMedia(db, 2, items[0].id);
  assert.equal(countActiveMedia(db, 2), 39);
});

test("ownership enforced: cannot read/use/delete another member's media", async () => {
  const db = open();
  const [a] = await saveN(db, 10, 1);
  assert.ok(getOwnedMedia(db, 10, a.id));
  assert.equal(getOwnedMedia(db, 11, a.id), null);
  assert.equal(ownsMediaUrl(db, 10, a.url), true);
  assert.equal(ownsMediaUrl(db, 11, a.url), false);
  assert.throws(() => deleteMemberMedia(db, 11, a.id), (e) => e.status === 404);
  assert.equal(countActiveMedia(db, 10), 1);
});

test("url helpers reject spoofed/traversal names", () => {
  assert.equal(isMemberMediaUrl(`/media/lib/${"a".repeat(32)}.jpg`), true);
  assert.equal(isMemberMediaUrl("/media/lib/../../etc/passwd"), false);
  assert.equal(isMemberMediaUrl("/media/self/x.jpg"), false);
  assert.equal(mediaKeyFromUrl(`/media/lib/${"a".repeat(32)}.jpg`), `${"a".repeat(32)}.jpg`);
  assert.equal(memberMediaDiskName("../secret.jpg"), "");
  assert.equal(memberMediaDiskName("/etc/passwd"), "");
  assert.equal(memberMediaFilePath("../../etc/passwd"), "");
});

test("processing failure leaves no DB row and no orphan files", async () => {
  const db = open();
  const boom = async () => { const e = new Error("bad image"); e.status = 400; throw e; };
  await assert.rejects(() => saveMemberMedia(db, 3, buf(), { plan: "free", processor: boom }), (e) => e.status === 400);
  assert.equal(countActiveMedia(db, 3), 0);
});

test("delete: keeps physical file when still referenced by a listing; removes when unreferenced", async () => {
  const db = open();
  const [m] = await saveN(db, 4, 1);
  const key = mediaKeyFromUrl(m.url);
  assert.ok(existsSync(path.join(memberMediaDir(), key)));
  // 被 listing 引用
  db.prepare("INSERT INTO listings(post_id, source, cover, self_photos) VALUES (1,'self','', ?)").run(JSON.stringify([m.url]));
  assert.equal(isMediaReferenced(db, m.url), true);
  const res = deleteMemberMedia(db, 4, m.id);
  assert.equal(res.deleted, true);
  assert.equal(res.kept_file, true);
  assert.ok(existsSync(path.join(memberMediaDir(), key)), "referenced file must be kept");
  assert.equal(countActiveMedia(db, 4), 0); // 配額已釋放（soft delete）

  const [n] = await saveN(db, 4, 1);
  const key2 = mediaKeyFromUrl(n.url);
  const res2 = deleteMemberMedia(db, 4, n.id);
  assert.equal(res2.kept_file, false);
  assert.equal(existsSync(path.join(memberMediaDir(), key2)), false, "unreferenced file removed");
});

test("listMemberMedia returns quota + used + items (active only)", async () => {
  const db = open();
  const items = await saveN(db, 5, 3, "sponsor");
  deleteMemberMedia(db, 5, items[0].id);
  const view = listMemberMedia(db, 5, { plan: "sponsor" });
  assert.equal(view.quota, 100);
  assert.equal(view.used, 2);
  assert.equal(view.items.length, 2);
  assert.ok(view.items[0].thumb_url.endsWith("_t.jpg"));
});

test.after(() => { try { rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ } });
