// Ops 反向指令（`applySiteCommandAsync`／`handleApplyRequestAsync`）的 parity（2026-09-28，第五十九批）。
//
// 這是 Ops Console 把處理結果**套回產品端**的入口。PG 模式下同步版套在節點本機的
// feedback／CRM，而使用者看到的是 PG 的資料 ⇒ **Ops 改了狀態、產品端完全沒變**，
// 而且 Ops 收到的是「已套用」。
//
// 這一支把三件事釘死：
//   1. 驗章與三道開關（env／secret／本地停止鍵）的狀態碼與 reason 與同步版相同；
//   2. `feedback.patch_handling`／`crm.add_note` 兩個指令的規則；
//   3. **冪等**：同一組 command_id／idempotency_key 第二次回 `duplicate: true`，而且不再套用一次。
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-sitecmd-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const app = await import("../src/db.js");
const crm = await import("../src/crm.js");
const siteCommand = await import("../src/siteCommandApply.js");
const siteCommandAsync = await import("../src/siteCommandApplyAsync.js");
const { signIngestRequest } = await import("../src/opsSignature.js");

const db = app.sqliteHandle();
crm.ensureCrmSchema(db);
siteCommand.ensureSiteCommandInbox(db);

const SECRET = "test-ops-command-secret";
const ENV = { V3_OPS_COMMAND_ACCEPT: "1", V3_OPS_COMMAND_SECRET: SECRET };
const STAMP = "2026-09-23T00:00:00.000Z";
const WHEN = new Date(STAMP);
const FEEDBACK_ID = 991001;

// ⚠️ 停止鍵 `ops_remote_cs_stop` 是**原生字串**（比對 `"1"`），不可以 JSON 化。
function setStop(value) {
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").run(siteCommand.REMOTE_CS_STOP_KEY, value);
}

function seed() {
  siteCommand.ensureSiteCommandInbox(db);
  db.prepare("DELETE FROM site_command_inbox").run();
  db.prepare("DELETE FROM feedback WHERE id = ?").run(FEEDBACK_ID);
  db.prepare(
    `INSERT INTO feedback(id, user_id, kind, body, contact, context, status, admin_note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(FEEDBACK_ID, 0, "bug", "分頁怪怪的", "", "{}", "new", "舊備註", STAMP, STAMP);
  for (const table of ["crm_outbox", "crm_notes", "crm_cases", "crm_contacts"]) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM settings WHERE key = ?").run(siteCommand.REMOTE_CS_STOP_KEY);
  db.prepare("DELETE FROM settings WHERE key = ?").run(crm.CRM_ENABLED_KEY);
}
seed();
beforeEach(seed);

// PostgreSQL exec 的離線替身（與 crm-parity 同一招）：`$n` → `?`，SELECT 回列，其餘當寫入。
function pgShimOn(handle) {
  return async (sql, params = []) => {
    const text = String(sql).replace(/\$(\d+)/g, "?");
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(text.trim())) { handle.exec(text.trim()); return []; }
    const statement = handle.prepare(text);
    if (/^\s*(select|with)/i.test(text) || /returning/i.test(text)) {
      const rows = statement.all(...params);
      return rows;
    }
    statement.run(...params);
    return [];
  };
}
const pgOptions = { driver: "postgres", exec: pgShimOn(db), strict: true };

function applyBody(overrides = {}) {
  return JSON.stringify({
    command_id: "cmd-1",
    idempotency_key: "idem-1",
    command_kind: "feedback.patch_handling",
    payload: { feedback_id: FEEDBACK_ID, handling_state: "doing", admin_note: "Ops 說處理中" },
    ...overrides,
  });
}

function requestFor(rawBody, { secret = SECRET, deliveryId = "cmd-1" } = {}) {
  const signed = signIngestRequest({
    method: "POST",
    path: siteCommand.APPLY_PATH,
    deliveryId,
    rawBody,
    secret,
    now: Date.parse(STAMP),
  });
  // ⚠️ `verifyIngestRequest()` 讀的是**小寫**標頭名（Express 會把標頭轉小寫），
  // 而 `signIngestRequest()` 回的是 `X-Ops-Signature` 這種寫法 ⇒ 測試要自己轉一次。
  const headers = Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers, rawBody, env: ENV, now: Date.parse(STAMP) };
}

test("驗章與開關：env 關閉／沒有 secret／本地停止／壞簽章，狀態碼與 reason 都與同步版相同", async () => {
  const rawBody = applyBody();
  const cases = [
    [{ ...requestFor(rawBody), env: {} }, "accept_off"],
    [{ ...requestFor(rawBody), env: { V3_OPS_COMMAND_ACCEPT: "1" } }, "no_secret"],
    [{ ...requestFor(rawBody, { secret: "wrong-secret" }) }, "bad_signature"],
  ];
  for (const [request, expectedReason] of cases) {
    const viaSync = siteCommand.handleApplyRequest(db, request);
    const viaPg = await siteCommandAsync.handleApplyRequestAsync(request, pgOptions);
    assert.equal(viaPg.httpStatus, viaSync.httpStatus, `${expectedReason}：狀態碼必須相同`);
    assert.equal(viaPg.body.reason, expectedReason);
    assert.equal(viaPg.body.reason, viaSync.body.reason);
  }
  // 本地停止鍵（原生字串 "1"）
  setStop("1");
  const stoppedSync = siteCommand.handleApplyRequest(db, requestFor(rawBody));
  const stoppedPg = await siteCommandAsync.handleApplyRequestAsync(requestFor(rawBody), pgOptions);
  assert.equal(stoppedPg.httpStatus, 403);
  assert.equal(stoppedPg.body.reason, "local_stopped");
  assert.equal(stoppedPg.body.reason, stoppedSync.body.reason);
  // JSON 化的 '"1"' **不算**停止（那個坑會讓開關永遠失效）
  setStop('"1"');
  const jsonStop = await siteCommandAsync.isRemoteCsStoppedAsync(pgOptions);
  assert.equal(jsonStop, false, "JSON 化的值不算停止");
  // 寫入端也要存**原始字串**：存成 JSON 的話，下一次讀就會是 false（開關失效）。
  // ⚠️ 必須看**PG 那一份**的位元組，不能只看應用程式 DB——`setRemoteCsStoppedAsync()` 會
  // 在本機鏡射一份（raw "1"），那會把「PG 存成 JSON」的缺陷蓋掉（變異因此存活過一次）。
  const memSettings = new DatabaseSync(":memory:");
  memSettings.exec(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'").get().sql);
  const pgStore = { driver: "postgres", exec: pgShimOn(memSettings), strict: true };
  assert.equal(await siteCommandAsync.setRemoteCsStoppedAsync(true, pgStore), true);
  const pgRaw = memSettings.prepare("SELECT value FROM settings WHERE key = ?").get(siteCommand.REMOTE_CS_STOP_KEY).value;
  assert.equal(pgRaw, "1", `PG 那一份必須是原始字串 '1'（實際 ${JSON.stringify(pgRaw)}）`);
  assert.equal(await siteCommandAsync.isRemoteCsStoppedAsync(pgStore), true, "剛寫進去的停止鍵要讀得到");
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = ?").get(siteCommand.REMOTE_CS_STOP_KEY).value, "1",
    "本機也要鏡射一份（同步讀者還在用）");
  await siteCommandAsync.setRemoteCsStoppedAsync(false, pgStore);
  assert.equal(memSettings.prepare("SELECT value FROM settings WHERE key = ?").get(siteCommand.REMOTE_CS_STOP_KEY).value, "0");
  setStop("0"); // 讓後面的測試不受影響
});

test("套用 feedback.patch_handling：PG 的列被改、inbox 記 applied、第二次回 duplicate", async () => {
  const request = requestFor(applyBody());
  const viaSync = siteCommand.handleApplyRequest(db, request);
  assert.equal(viaSync.httpStatus, 200, "前提：同步版可以套用");
  // 把 feedback 還原，讓 async 版再套一次（inbox 也要清掉，否則會走 duplicate）
  db.prepare("DELETE FROM site_command_inbox").run();
  db.prepare("UPDATE feedback SET status='new', admin_note='舊備註' WHERE id = ?").run(FEEDBACK_ID);

  const viaPg = await siteCommandAsync.handleApplyRequestAsync(request, pgOptions);
  assert.equal(viaPg.httpStatus, 200);
  assert.deepEqual(viaPg.body, viaSync.body, "回傳內容必須與同步版相同");
  const row = db.prepare("SELECT status, admin_note FROM feedback WHERE id = ?").get(FEEDBACK_ID);
  assert.equal(row.status, "doing", "PG 的狀態要被改掉");
  assert.equal(row.admin_note, "Ops 說處理中");
  const inbox = db.prepare("SELECT * FROM site_command_inbox WHERE command_id = ?").get("cmd-1");
  assert.equal(inbox.apply_state, "applied");
  assert.equal(JSON.parse(inbox.result_json).handling_state, "doing");

  // 冪等：再送一次 ⇒ duplicate，而且不得再套用（把欄位改掉再看有沒有被覆蓋）
  db.prepare("UPDATE feedback SET status='done' WHERE id = ?").run(FEEDBACK_ID);
  const again = await siteCommandAsync.handleApplyRequestAsync(request, pgOptions);
  assert.equal(again.httpStatus, 200);
  assert.equal(again.body.duplicate, true, "第二次必須回 duplicate");
  assert.equal(again.body.apply_state, "applied");
  assert.equal(db.prepare("SELECT status FROM feedback WHERE id = ?").get(FEEDBACK_ID).status, "done",
    "duplicate 不得再套用一次（狀態維持我們剛改的 done）");
});

test("被拒絕的指令：狀態碼、reason 與同步版相同，而且 rejected 也要寫進 inbox", async () => {
  const rawBody = applyBody({ payload: { feedback_id: FEEDBACK_ID } }); // 空 patch
  const viaSync = siteCommand.handleApplyRequest(db, requestFor(rawBody));
  db.prepare("DELETE FROM site_command_inbox").run();
  const viaPg = await siteCommandAsync.handleApplyRequestAsync(requestFor(rawBody), pgOptions);
  assert.equal(viaSync.httpStatus, 400, "前提：同步版回 400（`empty_patch` 是 400，不是 409）");
  assert.equal(viaPg.httpStatus, viaSync.httpStatus);
  assert.equal(viaPg.body.reason, "empty_patch");
  assert.equal(viaPg.body.reason, viaSync.body.reason);
  const inbox = db.prepare("SELECT apply_state, result_json FROM site_command_inbox WHERE command_id = ?").get("cmd-1");
  assert.equal(inbox.apply_state, "rejected", "被拒絕的也要留紀錄（Ops 才看得到）");
  assert.equal(JSON.parse(inbox.result_json).reason, "empty_patch");
});

test("格式錯誤：invalid_json 400、command_id 不一致 400（與同步版相同）", async () => {
  const notJson = "{not json";
  const syncJson = siteCommand.handleApplyRequest(db, requestFor(notJson));
  const pgJson = await siteCommandAsync.handleApplyRequestAsync(requestFor(notJson), pgOptions);
  assert.equal(pgJson.httpStatus, 400);
  assert.equal(pgJson.body.reason, "invalid_json");
  assert.equal(pgJson.body.reason, syncJson.body.reason);

  const mismatch = applyBody({ command_id: "cmd-2" }); // 簽章用的 deliveryId 還是 cmd-1
  const syncMismatch = siteCommand.handleApplyRequest(db, requestFor(mismatch));
  const pgMismatch = await siteCommandAsync.handleApplyRequestAsync(requestFor(mismatch), pgOptions);
  assert.equal(pgMismatch.httpStatus, 400);
  assert.equal(pgMismatch.body.reason, "command_id_mismatch");
  assert.equal(pgMismatch.body.reason, syncMismatch.body.reason);
});

test("crm.add_note：備註要落在 PG 那一份，而且回傳形狀與同步版相同", async () => {
  const contact = crm.createContact(db, { display_name: "丙客戶", email: "c@example.test" }, { now: WHEN });
  const contactId = contact?.contact?.id ?? contact?.id;
  const rawBody = JSON.stringify({
    command_id: "cmd-note",
    idempotency_key: "idem-note",
    command_kind: "crm.add_note",
    payload: { contact_id: contactId, body: "Ops 加了一則備註" },
  });
  const request = requestFor(rawBody, { deliveryId: "cmd-note" });
  const viaSync = siteCommand.handleApplyRequest(db, request);
  db.prepare("DELETE FROM site_command_inbox").run();
  db.prepare("DELETE FROM crm_notes").run();
  const viaPg = await siteCommandAsync.handleApplyRequestAsync(request, pgOptions);
  assert.equal(viaPg.httpStatus, 200, `必須套用成功（實際 ${JSON.stringify(viaPg.body)}）`);
  assert.deepEqual(viaPg.body, viaSync.body, "回傳形狀必須與同步版相同");
  const notes = db.prepare("SELECT body FROM crm_notes WHERE contact_id = ?").all(contactId);
  assert.equal(notes.length, 1, "備註要落在 store 裡");
  assert.equal(notes[0].body, "Ops 加了一則備註");
});

test("crm.add_note 少了 contact_id：400 missing_contact_id（與同步版相同）", async () => {
  const rawBody = JSON.stringify({
    command_id: "cmd-nonote",
    idempotency_key: "idem-nonote",
    command_kind: "crm.add_note",
    payload: { body: "沒有指定聯絡人" },
  });
  const request = requestFor(rawBody, { deliveryId: "cmd-nonote" });
  const viaSync = siteCommand.handleApplyRequest(db, request);
  db.prepare("DELETE FROM site_command_inbox").run();
  const viaPg = await siteCommandAsync.handleApplyRequestAsync(request, pgOptions);
  assert.equal(viaPg.httpStatus, 400, `必須是 400（實際 ${viaPg.httpStatus}/${JSON.stringify(viaPg.body)}）`);
  assert.equal(viaPg.body.reason, "missing_contact_id");
  assert.equal(viaPg.body.reason, viaSync.body.reason);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM crm_notes").get().n, 0, "不得寫入任何備註");
});

test("非 postgres：兩個入口都走同步版（不碰傳入的 exec）", async () => {
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const sqlite = { driver: "sqlite", exec: boom };
  const result = await siteCommandAsync.handleApplyRequestAsync(requestFor(applyBody()), sqlite);
  assert.equal(result.httpStatus, 200);
  assert.equal(db.prepare("SELECT status FROM feedback WHERE id = ?").get(FEEDBACK_ID).status, "doing");
  assert.equal(await siteCommandAsync.setRemoteCsStoppedAsync(true, sqlite), true);
  assert.equal(await siteCommandAsync.isRemoteCsStoppedAsync(sqlite), true);
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  await siteCommandAsync.setRemoteCsStoppedAsync(false, sqlite);
});
