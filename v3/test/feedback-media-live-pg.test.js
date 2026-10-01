// 回饋附圖（C3）的 **live PostgreSQL** 驗證（第二輪複審 R4／R5）。
//
// 為什麼一定要真 PG、而且要用**不同連線**：
//   離線夾具的 exec 是「一個連線、一次一句」，看不到連線池與交易隔離。
//   審閱用「PG async 原始碼 ＋ 注入 SQLite executor」重現了五張並行全部成功與
//   claim/delete 競態；本檔用真的 PG（連線池 ⇒ 並行請求走不同連線）驗同一批情境。
//
// ⚠️ 安全設計：只認 `PG_LIVE_REPRO_URL`，或 `PG_TEST_URL` **且資料庫名在允許清單內**
//   （CI 的拋棄式容器會同時餵兩者；開發機的 PG_TEST_URL 指向正式庫，會被清單擋掉）。
process.env.PG_TEST_URL = process.env.PG_TEST_URL || "";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const pickUrl = () => {
  const live = String(process.env.PG_LIVE_REPRO_URL || "").trim();
  if (live) return live;
  const shared = String(process.env.PG_TEST_URL || "").trim();
  if (!shared) return "";
  try {
    const db = new URL(shared).pathname.replace(/^\//, "");
    return ALLOWED_DB.has(db) ? shared : "";
  } catch {
    return "";
  }
};
const RAW = pickUrl();
const skip = RAW ? false : "沒有可用的隔離 PG（PG_LIVE_REPRO_URL，或資料庫名在允許清單內的 PG_TEST_URL）";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-feedback-media-live-"));
process.env.DATA_DIR = dataDir;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const fakeProcessor = () => ({
  format: "jpg",
  mime: "image/jpeg",
  digest: "e".repeat(64),
  source_format: "png",
  main: { buffer: Buffer.alloc(64, 9), width: 800, height: 600, bytes: 64 },
  thumb: { buffer: Buffer.alloc(16, 9), bytes: 16 },
});

test("live PG（不同連線）：五張並行上傳最多只會成功四張", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const {
    FEEDBACK_ATTACHMENT_MAX,
    countOpenFeedbackAttachments,
    ensureFeedbackMediaSchema,
  } = await import("../src/feedbackMedia.js");
  const {
    ensureFeedbackMediaStoreOnce,
    saveFeedbackAttachmentAsync,
  } = await import("../src/feedbackMediaAsync.js");
  const { sqliteHandle } = await import("../src/db.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  ensureFeedbackMediaSchema(sqliteHandle());
  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  await ensureFeedbackMediaStoreOnce(pgDriver);
  const one = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const uid = 990001;
  const cleanup = async () => {
    await one("DELETE FROM feedback_attachment WHERE user_id = $1", [uid]);
    const dir = path.join(dataDir, "feedback-media");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).slice()) {
      try { rmSync(path.join(dir, name), { force: true }); } catch { /* 盡力 */ }
    }
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  await cleanup();

  // 五個並行上傳：連線池 ⇒ 這五個請求會落在**不同連線**上。
  const results = await Promise.allSettled(
    Array.from({ length: FEEDBACK_ATTACHMENT_MAX + 1 }, () => saveFeedbackAttachmentAsync(uid, PNG, {
      driver: "postgres",
      pgDriver,
      processor: fakeProcessor,
    })),
  );
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, FEEDBACK_ATTACHMENT_MAX, `真 PG 上應該只有 ${FEEDBACK_ATTACHMENT_MAX} 張成功，實際 ${ok.length}`);
  assert.equal(failed.length, 1, "第 5 張要被拒絕");
  assert.equal(failed[0].reason.status, 409);
  assert.equal(failed[0].reason.code, "attachment_limit");

  const stored = await one(
    "SELECT COUNT(*)::int AS n FROM feedback_attachment WHERE user_id = $1 AND feedback_id = 0 AND deleted_at IS NULL",
    [uid],
  );
  assert.equal(Number(stored[0].n), FEEDBACK_ATTACHMENT_MAX, "PG 上的列數也必須是 4");
  assert.equal(countOpenFeedbackAttachments(sqliteHandle(), uid), 0, "PG 路徑不寫本機 SQLite");

  // 被拒絕的那一張：這次寫出的檔案必須清掉（成功的那四張 = 8 個檔）
  const files = readdirSync(path.join(dataDir, "feedback-media"));
  assert.equal(files.length, FEEDBACK_ATTACHMENT_MAX * 2, `超過上限的檔案要被清掉，實際 ${files.length} 個檔`);
});

test("live PG：claim 之後的 delete 與 sweep 都不可以動到已綁定的附件", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { feedbackMediaFilePath, ensureFeedbackMediaSchema } = await import("../src/feedbackMedia.js");
  const {
    claimFeedbackAttachmentsAsync,
    deleteFeedbackAttachmentAsync,
    ensureFeedbackMediaStoreOnce,
    saveFeedbackAttachmentAsync,
    sweepOrphanFeedbackAttachmentsAsync,
  } = await import("../src/feedbackMediaAsync.js");
  const { sqliteHandle } = await import("../src/db.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  ensureFeedbackMediaSchema(sqliteHandle());
  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  await ensureFeedbackMediaStoreOnce(pgDriver);
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const uid = 990002;
  t.after(async () => {
    try { await query("DELETE FROM feedback_attachment WHERE user_id = $1", [uid]); } catch { /* 盡力 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  await query("DELETE FROM feedback_attachment WHERE user_id = $1", [uid]);

  const options = { driver: "postgres", pgDriver, processor: fakeProcessor };
  const mine = await saveFeedbackAttachmentAsync(uid, PNG, options);
  const bound = await saveFeedbackAttachmentAsync(uid, PNG, options);

  // 在**真 PG 交易**裡 claim（`claimFeedbackAttachmentsAsync` 吃的是交易內的 exec）
  const claimed = await pgDriver.withTransaction(async (client) => {
    // ⚠️ 這個 exec 要跟 `feedbackAsync` 的 `tx` 同一個形狀：**已翻譯方言**。
    // 直接送 `?` 會被 PG 以 `syntax error at or near "=?"` 拒絕（測試自己踩過）。
    const exec = async (sql, params = []) => (await client.query(toPostgresSql(sql), params)).rows;
    return claimFeedbackAttachmentsAsync(exec, uid, [bound.id], 990100);
  });
  assert.equal(claimed, 1);

  // 1) claim 之後再刪同一張 ⇒ 條件式 UPDATE 找不到符合的列 ⇒ 404，列與實體檔都要在
  await assert.rejects(
    () => deleteFeedbackAttachmentAsync(uid, bound.id, options),
    (e) => e.status === 404,
  );
  const afterDelete = await query("SELECT feedback_id, deleted_at FROM feedback_attachment WHERE id = $1", [bound.id]);
  assert.equal(Number(afterDelete[0].feedback_id), 990100);
  assert.equal(afterDelete[0].deleted_at, null);
  const boundRow = await query("SELECT storage_key, thumb_key FROM feedback_attachment WHERE id = $1", [bound.id]);
  assert.ok(existsSync(feedbackMediaFilePath(boundRow[0].storage_key)), "已綁定的實體檔必須還在");

  // 2) 孤兒清理：只清掉那一張未綁定的（把 created_at 調老，讓它符合逾時條件）
  await query("UPDATE feedback_attachment SET created_at = $1 WHERE id = $2", ["2026-09-30T00:00:00.000Z", mine.id]);
  const sweep = await sweepOrphanFeedbackAttachmentsAsync({
    driver: "postgres",
    pgDriver,
    now: new Date("2026-10-01T12:00:00.000Z"),
    olderThanMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(sweep.removed, 1, "只應該清掉那一張孤兒");
  const stillBound = await query("SELECT feedback_id, deleted_at FROM feedback_attachment WHERE id = $1", [bound.id]);
  assert.equal(Number(stillBound[0].feedback_id), 990100, "已綁定的列不可以被孤兒清理刪掉");
  assert.equal(stillBound[0].deleted_at, null);
  assert.ok(existsSync(feedbackMediaFilePath(boundRow[0].storage_key)), "已綁定的實體檔不可以被孤兒清理刪掉");
});

test("live PG：claim 超過四張要整筆失敗（不留部分 claim）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { ensureFeedbackMediaSchema } = await import("../src/feedbackMedia.js");
  const {
    claimFeedbackAttachmentsAsync,
    ensureFeedbackMediaStoreOnce,
  } = await import("../src/feedbackMediaAsync.js");
  const { sqliteHandle } = await import("../src/db.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const { FEEDBACK_ATTACHMENT_MAX } = await import("../src/feedbackMedia.js");

  ensureFeedbackMediaSchema(sqliteHandle());
  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  await ensureFeedbackMediaStoreOnce(pgDriver);
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const uid = 990003;
  t.after(async () => {
    try { await query("DELETE FROM feedback_attachment WHERE user_id = $1", [uid]); } catch { /* 盡力 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  await query("DELETE FROM feedback_attachment WHERE user_id = $1", [uid]);
  // 直接塞 5 列（繞過上傳端的配額，模擬別條路徑寫進來的列）
  const ids = [];
  for (let i = 0; i < FEEDBACK_ATTACHMENT_MAX + 1; i += 1) {
    const rows = await query(
      `INSERT INTO feedback_attachment(user_id, storage_key, thumb_key, mime, format, width, height, bytes, digest, created_at)
       VALUES ($1,$2,$3,'image/jpeg','jpg',1,1,1,'x',$4) RETURNING id`,
      [uid, `live-${uid}-${i}.jpg`, `live-${uid}-${i}_t.jpg`, new Date().toISOString()],
    );
    ids.push(Number(rows[0].id));
  }
  const outcome = await pgDriver.withTransaction(async (client) => {
    const exec = async (sql, params = []) => (await client.query(toPostgresSql(sql), params)).rows;
    try {
      await claimFeedbackAttachmentsAsync(exec, uid, ids, 990200);
      return "claimed";
    } catch (error) {
      return error.code || error.message;
    }
  });
  assert.equal(outcome, "attachment_limit");
  const after = await query("SELECT COUNT(*)::int AS n FROM feedback_attachment WHERE user_id = $1 AND feedback_id <> 0", [uid]);
  assert.equal(Number(after[0].n), 0, "失敗的 claim 不可以留下部分綁定");
});

test("live PG：回饋附圖的預覽 scope（後台讀已送出、會員讀本人未送出）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { ensureFeedbackMediaSchema } = await import("../src/feedbackMedia.js");
  const {
    claimFeedbackAttachmentsAsync,
    ensureFeedbackMediaStoreOnce,
    listFeedbackAttachmentsForAsync,
    listOpenFeedbackAttachmentsAsync,
    saveFeedbackAttachmentAsync,
  } = await import("../src/feedbackMediaAsync.js");
  const { sqliteHandle } = await import("../src/db.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  ensureFeedbackMediaSchema(sqliteHandle());
  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  await ensureFeedbackMediaStoreOnce(pgDriver);
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const uid = 990004;
  const FEEDBACK_ID = 990300;
  t.after(async () => {
    try { await query("DELETE FROM feedback_attachment WHERE user_id = $1", [uid]); } catch { /* 盡力 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  await query("DELETE FROM feedback_attachment WHERE user_id = $1", [uid]);

  const options = { driver: "postgres", pgDriver, processor: fakeProcessor };
  const pending = await saveFeedbackAttachmentAsync(uid, PNG, options);
  const sent = await saveFeedbackAttachmentAsync(uid, PNG, options);
  await pgDriver.withTransaction(async (client) => {
    const exec = async (sql, params = []) => (await client.query(toPostgresSql(sql), params)).rows;
    return claimFeedbackAttachmentsAsync(exec, uid, [sent.id], FEEDBACK_ID);
  });

  // 會員的「未送出」清單 ⇒ owner 路由（admin 路由會員會 403）
  const open = await listOpenFeedbackAttachmentsAsync(uid, { driver: "postgres", pgDriver });
  assert.deepEqual(open.map((row) => row.id), [pending.id]);
  assert.match(open[0].thumb_url, /^\/api\/feedback\/attachments\/\d+\/thumb$/);

  // 後台的「已送出」清單 ⇒ admin 路由（owner 路由要求 feedback_id = 0，會 404）
  const admin = await listFeedbackAttachmentsForAsync([FEEDBACK_ID], { driver: "postgres", pgDriver });
  const adminRow = admin.get(FEEDBACK_ID)[0];
  assert.equal(adminRow.id, sent.id);
  assert.match(adminRow.thumb_url, /^\/api\/feedback-attachments\/\d+\/thumb$/);
});
