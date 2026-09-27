// 後台稽核紀錄的 PG 分支 parity（2026-09-27）。
//
// 背景：`appendAdminAudit()` 是對 `admin_audit` 的原始 SQLite 寫入，而 `auditReq()` 在 admin
// 路由裡有 **20 個呼叫點**，所以管理操作的稽核軌跡全部寫進回答你那台節點的本機檔案。
// `admin_audit` 在 PG 本來就存在（查過 information_schema），只是 App 從沒寫過。
//
// ⚠️ 這個檔特別釘住一個 PG 差異：同步版清理舊資料用
//      SELECT id FROM admin_audit ORDER BY id DESC LIMIT -1 OFFSET ?
//    `LIMIT -1` 是 SQLite 的「無上限」，PostgreSQL 不接受、toPostgresSql 也不會轉譯。
//    所以 PG 分支必須用不帶 LIMIT 的版本——這一項若寫錯，正式站一寫稽核就會拋錯。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-admin-audit-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = await import("../src/db.js");
const { ADMIN_AUDIT_MAX_ENTRIES, appendAdminAudit } = await import("../src/adminAudit.js");
const { appendAdminAuditAsync, listAdminAuditAsync, lastAuditActionAsync } = await import("../src/adminAuditAsync.js");

const PG = { driver: "postgres" };

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  mem.exec(`CREATE TABLE admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor_id INTEGER NOT NULL DEFAULT 0,
    actor_email TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '',
    before_json TEXT, after_json TEXT)`);
  const exec = async (sql, params = []) => {
    // 模擬 PostgreSQL 對 `LIMIT -1` 的態度：直接拒絕，避免測不到就上線。
    if (/LIMIT\s+-1/i.test(sql)) throw new Error('syntax error at or near "-1"');
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    // node:sqlite 的 run() 才有 changes；這裡統一用 all()，INSERT/DELETE 回空陣列即可。
    return rows;
  };
  exec.raw = mem;
  return exec;
}

test("寫入的位元組必須與同步版相同（含遮蔽與截斷）", async () => {
  const exec = pgFixture();
  const payload = {
    actorId: 7, actorEmail: "a@example.com", action: "smtp_test", target: "mail",
    before: { password: "should-be-redacted", keep: "x" }, after: { n: 1 },
    now: new Date("2026-09-27T00:00:00.000Z"),
  };
  const syncEntry = appendAdminAudit(payload);
  const asyncEntry = await appendAdminAuditAsync(payload, { ...PG, exec });
  assert.deepEqual(asyncEntry, syncEntry, "回傳的 entry 必須完全相同");

  const cols = "at, actor_id, actor_email, action, target, before_json, after_json";
  const fromPg = exec.raw.prepare(`SELECT ${cols} FROM admin_audit`).all();
  const fromSqlite = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true })
    .prepare(`SELECT ${cols} FROM admin_audit`).all();
  assert.deepEqual(fromPg, fromSqlite, "實際落地的欄位必須逐欄相同（含遮蔽後的 JSON）");
  assert.ok(!JSON.stringify(fromPg).includes("should-be-redacted"), "密鑰必須被遮蔽");
});

test("PG 分支不得使用 SQLite 專屬的 LIMIT -1（正式站會直接拋錯）", async () => {
  const exec = pgFixture();
  // 夾具會對 LIMIT -1 拋錯，所以這一項若用了該寫法就會失敗。
  await assert.doesNotReject(
    () => appendAdminAuditAsync({ action: "trim_probe" }, { ...PG, exec }),
    "PG 分支不得送出 LIMIT -1",
  );
});

test("清理：超過上限時要刪掉最舊的，且兩邊保留筆數相同", async () => {
  const exec = pgFixture();
  // 直接塞到超過上限，再寫一筆觸發清理
  const bulkSql = "INSERT INTO admin_audit(at, actor_id, actor_email, action, target, before_json, after_json) VALUES ('t',0,'','bulk','',NULL,NULL)";
  for (let i = 0; i < ADMIN_AUDIT_MAX_ENTRIES + 5; i += 1) exec.raw.prepare(bulkSql).run();
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"));
  for (let i = 0; i < ADMIN_AUDIT_MAX_ENTRIES + 5; i += 1) disk.prepare(bulkSql).run();
  disk.close();

  await appendAdminAuditAsync({ action: "after_trim" }, { ...PG, exec });
  appendAdminAudit({ action: "after_trim" });
  const pgCount = exec.raw.prepare("SELECT count(*) AS n FROM admin_audit").get().n;
  const sqCount = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true })
    .prepare("SELECT count(*) AS n FROM admin_audit").get().n;
  assert.equal(pgCount, sqCount, "清理後的筆數必須相同");
  assert.ok(pgCount <= ADMIN_AUDIT_MAX_ENTRIES + 1, `清理後不應超過上限太多，實際 ${pgCount}`);
});

test("listAdminAuditAsync 的形狀與同步版相同", async () => {
  const exec = pgFixture();
  await appendAdminAuditAsync({ action: "a1", target: "t1" }, { ...PG, exec });
  const items = await listAdminAuditAsync({ limit: 10 }, { ...PG, exec });
  assert.equal(items.length, 1);
  assert.equal(items[0].action, "a1");
  assert.equal(items[0].target, "t1");
  assert.ok(Object.prototype.hasOwnProperty.call(items[0], "at"), "entry 應有 at 欄位");
});

test("lastAuditActionAsync 找不到時回 null（與同步版一致）", async () => {
  const exec = pgFixture();
  assert.equal(await lastAuditActionAsync("never", { ...PG, exec }), null);
});

test("非 postgres driver 走同步分支，不得動用注入的 PG exec", async () => {
  let used = 0;
  const exec = async () => { used += 1; return []; };
  await appendAdminAuditAsync({ action: "sqlite_path" }, { driver: "sqlite", exec });
  await listAdminAuditAsync({ limit: 1 }, { driver: "sqlite", exec });
  await lastAuditActionAsync("x", { driver: "sqlite", exec });
  assert.equal(used, 0, "driver=sqlite 時不得碰 PG exec");
});
