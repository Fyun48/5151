// C3：意見回饋附圖（離線）。
//
// 驗證重點（對應工作單的「統一限制與互動」）：
//   - 張數上限 4（貼上與上傳共用同一個總數）
//   - 每張 1,000,000 bytes（十進位）；剛好等於上限可接受、超過拒絕
//   - 只收 PNG／JPEG／WebP（**明確拒絕 AVIF**，不能沿用 /api/media 的允許清單）
//   - 權威判定是「真的解碼」，不是只看 magic bytes 或副檔名
//   - claim 綁定與回饋列同一個交易；數量不符就整筆失敗
//   - 孤兒（feedback_id = 0）逾期清理；已綁定的不動
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FEEDBACK_ATTACHMENT_MAX,
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  claimFeedbackAttachments,
  countOpenFeedbackAttachments,
  deleteFeedbackAttachment,
  ensureFeedbackMediaSchema,
  feedbackMediaFilePath,
  getFeedbackAttachment,
  getOpenFeedbackAttachment,
  listFeedbackAttachments,
  listFeedbackAttachmentsFor,
  saveFeedbackAttachment,
  sweepOrphanFeedbackAttachments,
  validateFeedbackImage,
} from "../src/feedbackMedia.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WEBP"), Buffer.alloc(32, 1),
]);
const AVIF = Buffer.concat([Buffer.alloc(4, 0), Buffer.from("ftypavif"), Buffer.alloc(32, 2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32, 4)]);

/** 測試用的假處理器：不做真的解碼，只回形狀正確的輸出（CI 沒有 sharp）。 */
function fakeProcessor(buffer) {
  return {
    format: "jpg",
    mime: "image/jpeg",
    digest: "d".repeat(64),
    source_format: "png",
    main: { buffer: Buffer.alloc(64, 9), width: 800, height: 600, bytes: 64 },
    thumb: { buffer: Buffer.alloc(16, 9), bytes: 16 },
  };
}

// ⚠️ 一定要 `await fn()`：第一版寫成同步 try/finally，`DATA_DIR` 在非同步內文真正跑之前
// 就被還原，於是附件寫到預設目錄、測試卻去暫存目錄找檔案（ENOENT）。
async function withTempDataDir(fn) {
  const prev = process.env.DATA_DIR;
  const dir = mkdtempSync(path.join(os.tmpdir(), "fbmedia-"));
  process.env.DATA_DIR = dir;
  try { return await fn(dir); } finally {
    if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev;
  }
}

function open() {
  const db = new DatabaseSync(":memory:");
  ensureFeedbackMediaSchema(db);
  return db;
}

test("C3：大小邊界——剛好 1,000,000 bytes 可接受、1,000,001 拒絕", async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(FEEDBACK_ATTACHMENT_MAX_BYTES - PNG.length, 1)]);
  assert.equal(big.length, FEEDBACK_ATTACHMENT_MAX_BYTES);
  const ok = await validateFeedbackImage(big, { processor: fakeProcessor });
  assert.equal(ok.format, "jpg");

  const tooBig = Buffer.concat([big, Buffer.alloc(1, 1)]);
  await assert.rejects(() => validateFeedbackImage(tooBig, { processor: fakeProcessor }), (e) => e.status === 413);
});

test("C3：格式由 magic bytes 決定，AVIF／GIF／文字／空檔一律拒絕", async () => {
  assert.ok(await validateFeedbackImage(PNG, { processor: fakeProcessor }));
  assert.ok(await validateFeedbackImage(JPEG, { processor: fakeProcessor }));
  assert.ok(await validateFeedbackImage(WEBP, { processor: fakeProcessor }));
  // AVIF 是 /api/media 有收、但回饋附件**明確不收**的格式
  await assert.rejects(() => validateFeedbackImage(AVIF, { processor: fakeProcessor }), (e) => e.status === 415);
  await assert.rejects(() => validateFeedbackImage(GIF, { processor: fakeProcessor }), (e) => e.status === 415);
  await assert.rejects(() => validateFeedbackImage(Buffer.from("not an image at all")), (e) => e.status === 415);
  await assert.rejects(() => validateFeedbackImage(Buffer.alloc(0)), (e) => e.status === 400);
});

test("C3：後端要真的解碼——處理器說檔案壞掉時要往外丟，不可放行", async () => {
  const broken = async () => { const e = new Error("圖片檔案無法解析或已損毀"); e.status = 400; throw e; };
  await assert.rejects(() => validateFeedbackImage(PNG, { processor: broken }), (e) => e.status === 400);
  // 處理器不在（CI 沒有 sharp 時 normalizeImage 會丟 503）⇒ fail-closed，不降級成只驗 magic bytes
  const unavailable = async () => { const e = new Error("影像處理器尚未就緒"); e.status = 503; throw e; };
  await assert.rejects(() => validateFeedbackImage(PNG, { processor: unavailable }), (e) => e.status === 503);
});

test("C3：上傳、列出、刪除，且第 5 張被拒絕", async () => {
  await withTempDataDir(async (dir) => {
    const db = open();
    const rows = [];
    for (let i = 0; i < FEEDBACK_ATTACHMENT_MAX; i += 1) {
      rows.push(await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor }));
    }
    assert.equal(rows.length, 4);
    assert.equal(countOpenFeedbackAttachments(db, 7), 4);
    assert.ok(rows[0].thumb_url.endsWith("/thumb"));
    // 檔案真的落地（主圖＋縮圖），而且不是公開目錄
    assert.equal(readdirSync(path.join(dir, "feedback-media")).length, 8);
    assert.ok(existsSync(path.join(dir, "feedback-media")));

    await assert.rejects(
      () => saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor }),
      (e) => e.status === 409 && e.code === "attachment_limit",
    );

    // 刪掉一張就能再傳一張
    deleteFeedbackAttachment(db, 7, rows[0].id);
    assert.equal(countOpenFeedbackAttachments(db, 7), 3);
    const again = await saveFeedbackAttachment(db, 7, JPEG, { processor: fakeProcessor });
    assert.equal(countOpenFeedbackAttachments(db, 7), 4);

    // 別人的附件刪不掉（404，不是 200）
    assert.throws(() => deleteFeedbackAttachment(db, 8, again.id), (e) => e.status === 404);
    db.close();
  });
});

test("C3：送出回饋時在同一交易內 claim；數量不符要整筆失敗", async () => {
  await withTempDataDir(async () => {
    const db = open();
    const a = await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor });
    const b = await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor });
    const other = await saveFeedbackAttachment(db, 9, PNG, { processor: fakeProcessor });

    assert.equal(claimFeedbackAttachments(db, 7, [a.id, b.id], 100), 2);
    assert.equal(countOpenFeedbackAttachments(db, 7), 0);
    assert.deepEqual(listFeedbackAttachments(db, 100).map((row) => row.id), [a.id, b.id]);
    // 已綁定的不能再被別人 claim
    assert.throws(() => claimFeedbackAttachments(db, 7, [a.id], 101), (e) => e.status === 409);
    // 別人的附件不能綁進我的回饋
    assert.throws(() => claimFeedbackAttachments(db, 7, [other.id], 101), (e) => e.status === 409);
    // 沒有附件時是 no-op（沒有附件也能送出回饋）
    assert.equal(claimFeedbackAttachments(db, 7, [], 102), 0);

    const map = listFeedbackAttachmentsFor(db, [100, 101]);
    assert.deepEqual([...map.keys()], [100]);
    assert.equal(map.get(100).length, 2);
    db.close();
  });
});

test("C3：孤兒清理只動逾時未綁定的，已綁定的一律保留", async () => {
  await withTempDataDir(async () => {
    const db = open();
    const now = new Date("2026-10-01T12:00:00.000Z");
    const old = new Date("2026-09-30T00:00:00.000Z");
    const fresh = await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor, now });
    const stale = await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor, now: old });
    const claimed = await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor, now: old });
    claimFeedbackAttachments(db, 7, [claimed.id], 500, old);

    const res = sweepOrphanFeedbackAttachments(db, { now, olderThanMs: 24 * 60 * 60 * 1000 });
    assert.equal(res.removed, 1);
    assert.equal(getFeedbackAttachment(db, stale.id), null);
    assert.ok(getFeedbackAttachment(db, fresh.id));
    assert.ok(getFeedbackAttachment(db, claimed.id), "已綁定到回饋的附件不能被清掉");
    db.close();
  });
});

test("C3：附件是站方專屬——公開路徑白名單不得出現任何回饋附件字串", async () => {
  const { readFileSync } = await import("node:fs");
  const auth = readFileSync(new URL("../src/auth.js", import.meta.url), "utf8");
  assert.doesNotMatch(auth, /feedback-attachment/);
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  // 兩條讀取路由都必須掛 requireAdminApi，而且不掛 express.static
  assert.match(server, /app\.get\("\/api\/feedback-attachments\/:id\/thumb", requireAdminApi/);
  assert.match(server, /app\.get\("\/api\/feedback-attachments\/:id", requireAdminApi/);
  assert.doesNotMatch(server, /express\.static\([^)]*feedback-media/);
  // 站方讀取是私有快取，不可進 CDN
  const media = readFileSync(new URL("../src/feedbackMedia.js", import.meta.url), "utf8");
  assert.match(media, /"Cache-Control", "private, no-store"/);
  // 「要先登入」與「只有本人可以刪」都要在路由層
  assert.match(server, /app\.post\("\/api\/feedback\/attachments",/);
  assert.match(server, /app\.delete\("\/api\/feedback\/attachments\/:id",/);
});

test("R4：配額是原子的——並行上傳不可以超過 4 張", async () => {
  await withTempDataDir(async () => {
    const db = open();
    // 5 個並行上傳（每一個都有自己的非同步解碼），只有 4 個可以成功。
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, FEEDBACK_ATTACHMENT_MAX, `應該只有 4 張成功，實際 ${ok.length}`);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.status, 409);
    assert.equal(rejected[0].reason.code, "attachment_limit");
    assert.equal(countOpenFeedbackAttachments(db, 7), FEEDBACK_ATTACHMENT_MAX);
    db.close();
  });
});

test("R4：claim 自己也要擋上限（去重後仍只允許 4 張）", async () => {
  await withTempDataDir(async () => {
    const db = open();
    const rows = [];
    for (let i = 0; i < 4; i += 1) rows.push(await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor }));
    // 硬塞第 5 張（繞過 API，模擬「別條路徑寫進來的列」）
    db.prepare(
      `INSERT INTO feedback_attachment(user_id, storage_key, thumb_key, mime, format, width, height, bytes, digest, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(7, "f".repeat(32) + ".jpg", "f".repeat(32) + "_t.jpg", "image/jpeg", "jpg", 1, 1, 1, "x", new Date().toISOString());
    const ids = [1, 2, 3, 4, 5];
    assert.throws(() => claimFeedbackAttachments(db, 7, ids, 900), (e) => e.status === 400 && e.code === "attachment_limit");
    // 去重後不超過 4 張就沒問題
    assert.equal(claimFeedbackAttachments(db, 7, [1, 1, 2, 2, 3], 901), 3);
    db.close();
  });
});

test("R5：claim 之後的 delete 不可以刪掉已綁定的附件", async () => {
  await withTempDataDir(async () => {
    const db = open();
    const row = await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor });
    // 先 claim（模擬另一個交易在中間成功）
    assert.equal(claimFeedbackAttachments(db, 7, [row.id], 200), 1);
    // 再刪同一張：條件式 UPDATE 找不到符合的列 ⇒ 404，而且實體檔與列都不能被動到
    assert.throws(() => deleteFeedbackAttachment(db, 7, row.id), (e) => e.status === 404);
    const after = db.prepare("SELECT feedback_id, deleted_at FROM feedback_attachment WHERE id=?").get(row.id);
    assert.equal(Number(after.feedback_id), 200);
    assert.equal(after.deleted_at, null);
    assert.ok(getFeedbackAttachment(db, row.id), "已綁定的附件必須還在");
    assert.ok(existsSync(feedbackMediaFilePath(getFeedbackAttachment(db, row.id).storage_key)), "實體檔不可以被刪掉");
    db.close();
  });
});

test("R5：孤兒清理不可以刪掉已綁定的附件（含清理過程中被 claim 的情況）", async () => {
  await withTempDataDir(async () => {
    const db = open();
    const now = new Date("2026-10-01T12:00:00.000Z");
    const old = new Date("2026-09-30T00:00:00.000Z");
    const orphan = await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor, now: old });
    const bound = await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor, now: old });
    claimFeedbackAttachments(db, 7, [bound.id], 300, old);
    // 清理前一刻才被 claim 的那一張：模擬方式是先讓 sweep 看到它，再在掃描與刪除之間 claim。
    // 這裡直接驗條件式 UPDATE 的效果：sweep 只動 feedback_id = 0 的列。
    const res = sweepOrphanFeedbackAttachments(db, { now, olderThanMs: 24 * 60 * 60 * 1000 });
    assert.equal(res.removed, 1, "只應該清掉那一張孤兒");
    assert.equal(getFeedbackAttachment(db, orphan.id), null);
    const boundRow = getFeedbackAttachment(db, bound.id);
    assert.ok(boundRow, "已綁定的附件不能被孤兒清理刪掉");
    assert.equal(Number(boundRow.feedback_id), 300);
    assert.ok(existsSync(feedbackMediaFilePath(boundRow.storage_key)), "已綁定的實體檔必須還在");
    db.close();
  });
});

test("R3：一般會員的預覽路由只認「本人、還沒送出」的附件", async () => {
  await withTempDataDir(async () => {
    const db = open();
    const mine = await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor });
    const bound = await saveFeedbackAttachment(db, 7, PNG, { processor: fakeProcessor });
    claimFeedbackAttachments(db, 7, [bound.id], 500);
    const other = await saveFeedbackAttachment(db, 9, PNG, { processor: fakeProcessor });

    // 本人未送出 ⇒ 讀得到
    assert.ok(getOpenFeedbackAttachment(db, 7, mine.id));
    // 已送出 ⇒ 一般會員讀不到（只有管理員的 /api/feedback-attachments 讀得到）
    assert.equal(getOpenFeedbackAttachment(db, 7, bound.id), null);
    assert.ok(getFeedbackAttachment(db, bound.id), "管理員路徑仍讀得到已送出的附件");
    // 別人的未送出附件 ⇒ 讀不到
    assert.equal(getOpenFeedbackAttachment(db, 7, other.id), null);
    // 回傳給前台的網址要是**本人路由**，不是 admin 路由（會員拿 admin 路由只會 403）
    assert.match(mine.thumb_url, /^\/api\/feedback\/attachments\/\d+\/thumb$/);
    assert.doesNotMatch(mine.thumb_url, /^\/api\/feedback-attachments/);
    db.close();
  });
});

test("R3：前台預覽用本機 blob、上傳中鎖住送出、換世代丟棄延遲結果", async () => {
  const { readFileSync } = await import("node:fs");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  // 本機 blob 預覽（不依賴伺服器權限）
  assert.match(html, /URL\.createObjectURL\(file\)/);
  assert.match(html, /row\.preview_url \|\| row\.thumb_url/);
  assert.match(html, /URL\.revokeObjectURL/);
  // 上傳中鎖住送出
  assert.match(html, /if \(submit\) submit\.disabled = feedbackImageBusy;/);
  assert.match(html, /if \(feedbackImageBusy\) \{\s*\n\s*if \(msg\) \{ msg\.textContent = "圖片還在上傳/);
  // 換世代：關閉／重開對話框之後，較早的回應要被丟棄
  assert.match(html, /let feedbackImageGeneration = 0;/);
  assert.match(html, /if \(generation !== feedbackImageGeneration\) \{/);
  assert.match(html, /feedbackImageGeneration \+= 1;/);
});
