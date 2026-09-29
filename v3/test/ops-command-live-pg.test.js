// Ops 反向指令 ＋ 由回饋建立案件（第五十九批）的 **live PG** 驗證。
//
// 這一支要證明兩件事（離線夾具證明不了）：
//   1. Ops 的 `feedback.patch_handling` 指令在**真 PG** 上被套用、inbox 記 `applied`、
//      而且同一組 command_id／idempotency_key 第二次回 `duplicate`（不再套用）。
//   2. 由回饋建立案件時，聯絡人與案件都落在 **PG**（不是節點本機）。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
// 測試資料用可辨識的 email／feedback_id，前後都清。
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-opscommand-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

const SECRET = "live-ops-command-secret";
const ENV = { V3_OPS_COMMAND_ACCEPT: "1", V3_OPS_COMMAND_SECRET: SECRET };
const MARK = 972000000;
const EMAIL = "livetest-opscommand@example.test";
const TOKEN = `live-cmd-${Date.now()}`;

test("live PG：Ops 指令套用在真 PG（含冪等），由回饋建立案件也落在 PG", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const { signIngestRequest } = await import("../src/opsSignature.js");
  const { APPLY_PATH } = await import("../src/siteCommandApply.js");
  const { ensureSiteCommandStoreOnce, handleApplyRequestAsync } = await import("../src/siteCommandApplyAsync.js");
  const { createCaseFromFeedbackAsync } = await import("../src/crmAsync.js");
  const { ensureFeedbackStoreOnce } = await import("../src/feedbackAsync.js");
  const { ensureCrmStoreOnce } = await import("../src/crmSchemaAsync.js").catch(() => ({ ensureCrmStoreOnce: null }));

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  await ensureSiteCommandStoreOnce(pgDriver);
  await ensureFeedbackStoreOnce(pgDriver);

  // ⚠️ 順序很重要：先刪**案件**（它會指向聯絡人），再刪聯絡人。
  // 只刪聯絡人會留下 `contact_id` 指向不存在聯絡人的孤兒案件 ⇒ 下一次「已存在就沿用」那條路
  // 會在 `snapshotContact()` 裡丟「找不到這位聯絡人」（第一版就是這樣紅的）。
  const cleanup = async () => {
    await query("DELETE FROM site_command_inbox WHERE command_id LIKE $1", [`${TOKEN}%`]);
    await query("DELETE FROM crm_cases WHERE feedback_id >= $1", [MARK]);
    await query("DELETE FROM crm_notes WHERE contact_id IN (SELECT id FROM crm_contacts WHERE email = $1)", [EMAIL]);
    await query("DELETE FROM crm_outbox WHERE contact_id IN (SELECT id FROM crm_contacts WHERE email = $1)", [EMAIL]);
    await query("DELETE FROM crm_contacts WHERE email = $1", [EMAIL]);
    await query("DELETE FROM feedback WHERE id >= $1", [MARK]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  await cleanup();

  await query(
    `INSERT INTO feedback(id, user_id, kind, body, contact, context, status, admin_note, created_at, updated_at)
     VALUES ($1, 0, 'bug', 'live：分頁會跳回第一頁', $2, '{}', 'new', '舊備註', $3, $3)`,
    [MARK, EMAIL, new Date().toISOString()],
  );

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 1. Ops 指令：簽章 → 套用 → inbox
  const rawBody = JSON.stringify({
    command_id: `${TOKEN}-1`,
    idempotency_key: `${TOKEN}-1`,
    command_kind: "feedback.patch_handling",
    payload: { feedback_id: MARK, handling_state: "doing", admin_note: "live Ops 備註" },
  });
  const signed = signIngestRequest({
    method: "POST", path: APPLY_PATH, deliveryId: `${TOKEN}-1`, rawBody, secret: SECRET, now: Date.now(),
  });
  const headers = Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const applied = await handleApplyRequestAsync({ headers, rawBody, env: ENV, now: Date.now() }, opts);
  assert.equal(applied.httpStatus, 200, `必須套用成功（實際 ${JSON.stringify(applied.body)}）`);
  assert.equal(applied.body.apply_state, "applied");
  const row = (await query("SELECT status, admin_note FROM feedback WHERE id = $1", [MARK]))[0];
  assert.equal(row.status, "doing", "PG 的狀態要被改掉");
  assert.equal(row.admin_note, "live Ops 備註");
  const inbox = (await query("SELECT apply_state, result_json FROM site_command_inbox WHERE command_id = $1", [`${TOKEN}-1`]))[0];
  assert.equal(inbox.apply_state, "applied");
  assert.equal(JSON.parse(inbox.result_json).handling_state, "doing");

  // 2. 冪等：同一組 id 再送一次 ⇒ duplicate，而且不再套用
  await query("UPDATE feedback SET status = 'done' WHERE id = $1", [MARK]);
  const again = await handleApplyRequestAsync({ headers, rawBody, env: ENV, now: Date.now() }, opts);
  assert.equal(again.httpStatus, 200);
  assert.equal(again.body.duplicate, true, "第二次必須回 duplicate");
  assert.equal((await query("SELECT status FROM feedback WHERE id = $1", [MARK]))[0].status, "done",
    "duplicate 不得再套用一次");

  // 3. 壞簽章：401 且不得動到任何列
  const badHeaders = { ...headers, "x-ops-signature": "v1=deadbeef" };
  const rejected = await handleApplyRequestAsync({ headers: badHeaders, rawBody, env: ENV, now: Date.now() }, opts);
  assert.equal(rejected.httpStatus, 401);
  assert.equal(rejected.body.reason, "bad_signature");

  // 4. 由回饋建立案件：聯絡人與案件都要在 PG
  const created = await createCaseFromFeedbackAsync(MARK, opts);
  assert.equal(created.reused, false, `必須新建案件（實際 ${JSON.stringify(created).slice(0, 200)}）`);
  const contact = (await query("SELECT id, email FROM crm_contacts WHERE email = $1", [EMAIL]))[0];
  assert.ok(contact, "PG 上要有猜出來的聯絡人");
  const cases = await query("SELECT id, feedback_id, handling_state FROM crm_cases WHERE feedback_id = $1", [MARK]);
  assert.equal(cases.length, 1, "PG 上要有一張對到這筆回饋的案件");
  // ⚠️ 上面為了驗「duplicate 不再套用」把狀態改成了 `done` ⇒ 這裡要跟**當下的**回饋狀態比，
  // 不是跟最一開始的 `doing` 比（`normalizeHandling()` 只認得 CRM 的處理狀態白名單）。
  const currentStatus = (await query("SELECT status FROM feedback WHERE id = $1", [MARK]))[0].status;
  assert.equal(cases[0].handling_state, currentStatus, `處理狀態要對應回饋狀態（${currentStatus}）`);
  const reuse = await createCaseFromFeedbackAsync(MARK, opts);
  assert.equal(reuse.reused, true, "第二次必須沿用");
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM crm_cases WHERE feedback_id = $1", [MARK]))[0].n, 1);
});
