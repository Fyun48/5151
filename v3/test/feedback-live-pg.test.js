// 使用者回饋（`feedbackAsync`）的 **live PG** 驗證（2026-09-28，第五十八批）。
//
// 這一支要證明三件離線證明不了的事：
//   1. 送出時「**feedback ＋ 初始 outbox 事件**」在真 PG 上**同一個交易**成立（不變式）。
//   2. 交易失敗時 feedback **不會**留下來（用一句會失敗的 SQL 逼出來）。
//   3. 後台列表／統計／更新在真 PG 上跑得完，而且 email／nickname 是 join 出來的。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
// 測試資料用可辨識的 user_id／feedback_id，前後都清。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-feedback-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

const EMAIL = "livetest-feedback@example.test";

test("live PG：送出（同交易）→ 列舉／統計／更新；交易失敗時不留半套狀態", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const {
    ensureFeedbackStoreOnce,
    submitFeedbackAsync,
    listFeedbackAsync,
    feedbackStatsAsync,
    updateFeedbackAsync,
  } = await import("../src/feedbackAsync.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  await ensureFeedbackStoreOnce(pgDriver);

  const cleanup = async () => {
    await query("DELETE FROM feedback_outbox WHERE feedback_id IN (SELECT id FROM feedback WHERE user_id IN (SELECT id FROM users WHERE email = $1))", [EMAIL]);
    await query("DELETE FROM feedback WHERE user_id IN (SELECT id FROM users WHERE email = $1)", [EMAIL]);
    await query("DELETE FROM users WHERE email = $1", [EMAIL]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  await cleanup();

  const uid = Number((await query(
    `INSERT INTO users(email, nickname, password_hash, role, plan, created_at)
     VALUES ($1, '回饋測試', '', 'member', 'free', $2) RETURNING id`,
    [EMAIL, new Date().toISOString()],
  ))[0].id);

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };
  const INPUT = { kind: "bug", body: "live PG 的送出驗證：分頁會跳回第一頁", contact: EMAIL, context: { route: "/listings", version: "live-1" } };

  // 1. 送出：feedback ＋ outbox 事件都要在 PG 上
  const out = await submitFeedbackAsync(uid, INPUT, opts);
  assert.equal(out.ok, true);
  const fb = (await query("SELECT * FROM feedback WHERE id = $1", [out.id]))[0];
  assert.ok(fb, "PG 上要有這一筆 feedback");
  assert.equal(Number(fb.user_id), uid);
  assert.equal(fb.kind, "bug");
  assert.equal(fb.status, "new");
  const box = await query("SELECT * FROM feedback_outbox WHERE feedback_id = $1", [out.id]);
  assert.equal(box.length, 1, "同一筆 feedback 只能有一個初始 outbox 事件（不變式）");
  const payload = JSON.parse(box[0].payload);
  assert.equal(payload.external_feedback_id, out.id);
  assert.equal(payload.trust_level, "untrusted");
  assert.deepEqual(payload.context, { route: "/listings", version: "live-1" }, "情境只留白名單欄位");

  // 2. 交易失敗 ⇒ feedback 不得留下（用一句會炸的 SQL 逼出回滾）
  const doomed = { ...opts, exec: async (sql, params = []) => {
    if (/INSERT INTO feedback_outbox/.test(String(sql))) throw new Error("live 交易測試：故意失敗");
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  } };
  const before = Number((await query("SELECT COUNT(*)::int AS n FROM feedback WHERE user_id = $1", [uid]))[0].n);
  const failure = await submitFeedbackAsync(uid, { ...INPUT, body: "這一筆必須被回滾掉（live 交易驗證）" }, doomed)
    .then(() => null, (error) => error);
  assert.ok(failure, "outbox 失敗時必須往上丟");
  const after = Number((await query("SELECT COUNT(*)::int AS n FROM feedback WHERE user_id = $1", [uid]))[0].n);
  assert.equal(after, before, "失敗的那一筆不得留在 PG（否則 Ops 永遠不會知道它）");

  // 3. 後台列表／統計／更新
  const items = await listFeedbackAsync({}, opts);
  const mine = items.filter((row) => Number(row.user_id) === uid);
  assert.equal(mine.length, 1, "列表要看到這一筆");
  assert.equal(mine[0].email, EMAIL, "email 是 join users 出來的");
  assert.equal(mine[0].nickname, "回饋測試");
  assert.deepEqual(mine[0].context, { route: "/listings", version: "live-1" });
  const stats = await feedbackStatsAsync(opts);
  assert.equal(typeof stats.total, "number", "PG 的 COUNT 是字串，必須轉成數字");
  assert.ok(stats.byKind.bug >= 1);
  const updated = await updateFeedbackAsync(out.id, { status: "doing", admin_note: "live 備註" }, opts);
  assert.equal(updated.status, "doing");
  assert.equal(updated.admin_note, "live 備註");
  assert.equal(updated.email, EMAIL, "更新後重讀也要 join users");
  const reread = (await query("SELECT status, admin_note FROM feedback WHERE id = $1", [out.id]))[0];
  assert.equal(reread.status, "doing");
  assert.equal(reread.admin_note, "live 備註");
  // 同一筆再送一次 outbox（idempotency_key 唯一）⇒ 撞唯一鍵（Ops 端才敢去重）
  const { enqueueFeedbackOutboxAsync } = await import("../src/feedbackAsync.js");
  // ⚠️ 預設的 idempotency_key 是 `feedback:<id>`，而送出的那一步已經用掉它了
  // ⇒ 這裡要用另一個明確的鍵（第一版就是撞在這個上面）。
  const extraKey = `live-extra-${Date.now()}`;
  const first = await enqueueFeedbackOutboxAsync({ feedbackId: out.id, data: { source: "v3" }, idempotencyKey: extraKey }, opts);
  assert.ok(first.deliveryId);
  const dup = await enqueueFeedbackOutboxAsync({ feedbackId: out.id, data: { source: "v3" }, idempotencyKey: extraKey }, opts)
    .then(() => null, (error) => error);
  assert.ok(dup, "同一個 feedback 的預設 idempotency_key 只能有一筆");
  assert.match(String(dup.message), /duplicate key|unique/i, `必須是唯一鍵錯誤（實際 ${dup.message}）`);
});
