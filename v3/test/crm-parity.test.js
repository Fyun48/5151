// 2.2a parity：CRM 的 admin 讀取在兩個 driver 上必須給出同一份答案。
//
// crm.js 的語句只跑 SQLite → `DB_DRIVER=postgres` 時後台讀的是本機 v3.db。crmAsync.js 讓那幾條
// 路徑在 PostgreSQL 上跑同一份語句文字；這條測試把兩邊的輸出釘在一起（作法同 ④ 的 parity 測試）。
// 離線那段的 PostgreSQL exec 是「$n 還原成 ? 再跑同一個 SQLite fixture」，所以真正的 SQL 文字與
// 組裝都會被跑到。
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-crm-parity-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const app = await import("../src/db.js");
const crm = await import("../src/crm.js");
const crmAsync = await import("../src/crmAsync.js");

const db = app.sqliteHandle();
crm.ensureCrmSchema(db);

const STAMP = "2026-09-23T00:00:00.000Z";
const WHEN = new Date(STAMP);

// 用同步 API 播種（欄位完整性由 crm.js 自己保證，測試不必手寫 INSERT）。
let FIRST_ID = 0;
function seed() {
  for (const table of ["crm_todos", "crm_notes", "crm_cases", "crm_contact_tags", "crm_tags", "crm_contacts"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM settings WHERE key = ?").run(crm.CRM_ENABLED_KEY);
  const created = crm.createContact(db, {
    display_name: "甲客戶",
    company_name: "甲公司",
    email: "a@example.test",
    phone: "0900",
    tags: ["vip", "新客"],
  }, { now: WHEN });
  const first = { id: created?.contact?.id ?? created?.id };
  crm.createContact(db, { display_name: "乙客戶" }, { now: WHEN });
  crm.createCase(db, first.id, { title: "看屋問題", handling_state: "doing" }, { now: WHEN });
  assert.equal(Number.isInteger(first.id), true, "fixture：createContact 必須回可用的 id");
  crm.addNote(db, first.id, { body: "客戶來電" }, { actorUserId: 5, now: WHEN });
  crm.addTodo(db, first.id, { title: "回電" }, { now: WHEN });
  FIRST_ID = first.id;
}
seed();
beforeEach(seed);

// PostgreSQL exec 的離線替身：$n → ?，SELECT 回列，其餘當寫入。
function pgShimOn(handle) {
  return async (sql, params = []) => {
    const text = String(sql).replace(/\$(\d+)/g, "?");
    const statement = handle.prepare(text);
    try {
      return statement.all(...params);
    } catch {
      statement.run(...params);
      return [];
    }
  };
}
const pgOptions = { driver: "postgres", exec: pgShimOn(db), strict: true };

test("sqlite 模式：async 入口與原本的同步函式輸出完全相同", async () => {
  assert.deepEqual(await crmAsync.crmModuleAsync({ driver: "sqlite" }), crm.crmModule(db));
  assert.deepEqual(await crmAsync.crmOverviewAsync({ q: "" }, { driver: "sqlite" }), crm.crmOverview(db, { q: "" }));
  assert.deepEqual(await crmAsync.getCrmContactAsync(FIRST_ID, { driver: "sqlite" }), crm.getContact(db, FIRST_ID));
  assert.deepEqual(await crmAsync.listCrmContactsAsync({ q: "" }, { driver: "sqlite" }), crm.listContacts(db, { q: "" }));
});

test("postgres 路徑（離線 exec）給出與 sqlite 相同的 payload", async () => {
  const viaPg = await crmAsync.crmOverviewAsync({ q: "" }, pgOptions);
  assert.deepEqual(viaPg, crm.crmOverview(db, { q: "" }));
  assert.equal(viaPg.module.enabled, crm.crmModule(db).enabled);
  assert.equal(Array.isArray(viaPg.contacts), true);
  assert.deepEqual(await crmAsync.getCrmContactAsync(FIRST_ID, pgOptions), crm.getContact(db, FIRST_ID));
  assert.deepEqual(await crmAsync.crmModuleAsync(pgOptions), crm.crmModule(db));
});

test("postgres 路徑：搜尋與標籤都要與 sqlite 相同", async () => {
  assert.deepEqual(await crmAsync.listCrmContactsAsync({ q: "甲" }, pgOptions), crm.listContacts(db, { q: "甲" }));
  assert.deepEqual(await crmAsync.listCrmContactsAsync({ q: "沒有這個人" }, pgOptions), crm.listContacts(db, { q: "沒有這個人" }));
  const viaPg = await crmAsync.getCrmContactAsync(FIRST_ID, pgOptions);
  assert.deepEqual(viaPg.contact.tags, crm.getContact(db, FIRST_ID).contact.tags);
  assert.equal(viaPg.cases.length, 1);
  assert.equal(viaPg.notes.length, 1);
  assert.equal(viaPg.todos.length, 1);
});

test("postgres 路徑：CRM 關閉時 module 的旗標與 sqlite 相同", async () => {
  crm.setCrmEnabled(db, false);
  assert.deepEqual(await crmAsync.crmModuleAsync(pgOptions), crm.crmModule(db));
  crm.setCrmEnabled(db, true);
});

test("postgres 路徑：找不到聯絡人時的行為與 sqlite 相同", async () => {
  let syncError = null;
  let pgError = null;
  try {
    crm.getContact(db, 999999);
  } catch (error) {
    syncError = { message: error.message, status: error.status };
  }
  try {
    await crmAsync.getCrmContactAsync(999999, pgOptions);
  } catch (error) {
    pgError = { message: error.message, status: error.status };
  }
  assert.deepEqual(pgError, syncError);
  assert.equal(pgError.status, 404);
});

test("live shadow PostgreSQL：同一組 CRM 讀取斷言", async (t) => {
  const url = process.env.PG_TEST_URL;
  if (!url) {
    t.skip("PG_TEST_URL is not set (live CRM admin reads)");
    return;
  }
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const driver = createPostgresDriver(url);
  const options = { driver: "postgres", pgDriver: driver, strict: true };
  try {
    // 影子站是空的也沒關係：只要求兩邊「形狀與語意」一致，逐列比對在 SQLite fixture 那幾條。
    const module = await crmAsync.crmModuleAsync(options);
    assert.equal(typeof module.enabled, "boolean");
    assert.equal(module.handling.length, crm.CRM_HANDLING.length);
    const overview = await crmAsync.crmOverviewAsync({ q: "" }, options);
    assert.equal(Array.isArray(overview.contacts), true);
    assert.deepEqual(Object.keys(overview).sort(), ["contacts", "module"]);
  } finally {
    await driver.close?.();
  }
});

