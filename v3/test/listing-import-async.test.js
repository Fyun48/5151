// 匯入功能說明（`listingImportMeta`）PG 分支的 parity（2026-09-27）。
//
// `importMeta()` 全段只有一句 DB 存取（取「匯入聲明」目前生效的那一版），其餘是純組裝。
// 所以這一檔驗兩件事：**那句取到的是同一版文件**，以及**組裝出來的形狀逐欄相同**。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-listingimport-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const syncDb = await import("../src/db.js");
const asyncMod = await import("../src/listingImportAsync.js");
const { IMPORT_DECLARATION_TYPE } = await import("../src/listingImport.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='content_documents'").get();
  assert.ok(ddl?.sql, "必須抓到 content_documents 的 DDL");
  mem.exec(ddl.sql);
  disk.close();
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

function resetBoth() {
  db.prepare("DELETE FROM content_documents").run();
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name='content_documents'").run(); } catch { /* 沒有 AUTOINCREMENT */ }
  return pgFixture();
}

function seedRow(handle, fields) {
  const info = handle.prepare("PRAGMA table_info(content_documents)").all();
  const provided = { ...fields };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO content_documents(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => {
      if (n in provided) return provided[n];
      const col = info.find((c) => c.name === n);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
}

function seedDeclarationOnDisk(body, status = "published") {
  seedRow(db, {
    document_type: IMPORT_DECLARATION_TYPE, version: 1, title: "匯入聲明", body, format: "plain",
    check_label: "我確認", status, enabled: 1, requires_reacceptance: 0, content_hash: "h",
    created_at: "2026-01-01T00:00:00.000Z", published_at: "2026-01-01T00:00:00.000Z",
  });
}

function seedDeclaration(exec, body, status = "published") {
  const fields = {
    document_type: IMPORT_DECLARATION_TYPE, version: 1, title: "匯入聲明", body, format: "plain",
    check_label: "我確認", status, enabled: 1, requires_reacceptance: 0, content_hash: "h",
    created_at: "2026-01-01T00:00:00.000Z", published_at: "2026-01-01T00:00:00.000Z",
  };
  seedRow(db, fields);
  seedRow(exec.raw, fields);
}

// ---------------------------------------------------------------------------

test("沒有已發布的聲明：declaration 是 null，其餘欄位與同步版逐欄相同", async () => {
  const exec = resetBoth();
  const pg = await asyncMod.importMetaAsync({ ...PG, exec });
  const lite = syncDb.listingImportMeta({});
  assert.deepEqual(pg, lite, "整包必須相同");
  assert.equal(pg.declaration, null, "沒有已發布版本時 declaration 必須是 null");
  assert.ok(pg.check_label.length > 0, "check_label 不得為空（否則比對沒有鑑別力）");
  assert.ok(Array.isArray(pg.providers) && pg.providers.length > 0, "providers 不得是空的");
});

test("有已發布的聲明：declaration 要用那一版，而且 plan 會影響 sponsor／quota", async () => {
  const exec = resetBoth();
  seedDeclaration(exec, "匯入聲明內文");
  const pg = await asyncMod.importMetaAsync({ plan: "sponsor", ...PG, exec });
  const lite = syncDb.listingImportMeta({ plan: "sponsor" });
  assert.deepEqual(pg, lite, "整包必須相同");
  assert.equal(pg.declaration.body, "匯入聲明內文", "必須取到那一版聲明的內容");
  assert.equal(pg.sponsor, true, "sponsor 方案要是 true");
  const free = await asyncMod.importMetaAsync({ plan: "free", ...PG, exec });
  assert.equal(free.sponsor, false);
  assert.notEqual(free.limits.quota, pg.limits.quota, "不同方案的 quota 必須不同（否則這條沒有鑑別力）");
});

test("草稿不算數：只有 draft 時 declaration 必須是 null", async () => {
  const exec = resetBoth();
  seedDeclaration(exec, "草稿內文", "draft");
  const pg = await asyncMod.importMetaAsync({ ...PG, exec });
  assert.deepEqual(pg, syncDb.listingImportMeta({}));
  assert.equal(pg.declaration, null, "草稿不得被當成生效版本");
});

test("非 postgres 模式必須回退同步路徑（只讀磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  // 只種**磁碟**那一份（PG 夾具保持空的）。這樣兩條路會給出**不同**答案：
  //   sqlite 分支讀磁碟 ⇒ 有內文；若誤走 PG 分支 ⇒ 讀到空的夾具 ⇒ null。
  // 第一版反過來（只種夾具），結果「誤走 PG 分支」也算得出 null ⇒ 變異殺不死。
  seedDeclarationOnDisk("磁碟版內文");
  assert.equal((await asyncMod.importMetaAsync({ driver: "sqlite", exec })).declaration.body, "磁碟版內文",
    "sqlite 模式必須讀到磁碟那一份");
  assert.deepEqual(await asyncMod.importMetaAsync({ driver: "sqlite", exec }), syncDb.listingImportMeta({}));
  assert.equal((await asyncMod.importMetaAsync({ ...PG, exec })).declaration, null,
    "PG 分支只能讀夾具（夾具是空的 ⇒ null）");
});
