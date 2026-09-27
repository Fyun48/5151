// 內容文件（條款／隱私權）PG 分支的 parity（2026-09-27）。
//
// 這一檔最重要的是**不可變性**。同步版不是用程式碼擋，而是用一個 SQLite TRIGGER：
//
//   BEFORE UPDATE ON content_documents WHEN OLD.status = 'published' AND (NEW.body IS NOT OLD.body OR …)
//   BEGIN SELECT RAISE(ABORT, 'published_document_immutable'); END;
//
// **PG 完全不吃這個語法**（沒有 `IS NOT OLD.x`、沒有 `RAISE(ABORT)`）。要等價得寫 plpgsql
// 函式 ＋ `CREATE TRIGGER ... EXECUTE FUNCTION`，`IS NOT OLD.x` 要換成 `IS DISTINCT FROM`。
// 這不是加固，是一條真的業務規則：已發布的條款不能事後被改掉，否則使用者同意過的版本
// 會跟畫面不一致。
//
// ⚠️ 離線夾具只能證明「SQLite 那一半」與「PG 分支不會去踩它」——**PG 觸發器本身只有 live PG
// 能證明**（見 member-media-live-pg 的教訓：離線取代不了真 PG）。所以這裡另外釘住三件事：
//   1. PG 的觸發器 SQL 用的是 `IS DISTINCT FROM`（不是 `IS NOT OLD.`）。
//   2. bootstrap 的順序是 建函式 → DROP TRIGGER → CREATE TRIGGER（PG 沒有 CREATE TRIGGER IF NOT EXISTS）。
//   3. 每個 pgDriver 只做一次。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-contentdocs-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const sync = await import("../src/contentDocuments.js");
const asyncMod = await import("../src/contentDocumentsAsync.js");

const PG = { driver: "postgres" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const LATER = new Date("2026-06-02T00:00:00.000Z");
const TABLES = ["content_documents", "content_document_events"];
const diskPath = () => path.join(dataDir, "v3.db");

const PG_ILLEGAL = [
  [/\bRAISE\s*\(\s*ABORT/i, 'syntax error at or near "RAISE"'],
  [/\bIS\s+NOT\s+OLD\./i, 'syntax error at or near "OLD"'],
  [/\bIFNULL\s*\(/i, "function ifnull(unknown) does not exist"],
  [/COLLATE\s+NOCASE/i, 'collation "nocase" for encoding "UTF8" does not exist'],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
];

// PG 替身：兩張表 ＋ 索引 ＋ **SQLite 的不可變 trigger** 都從真的 sqlite_master 抄。
// 抄 trigger 是刻意的：這樣「PG 分支有沒有去改到已發布的本文」在離線也測得出來。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const table of TABLES) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  for (const row of disk.prepare(
    "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL AND tbl_name IN (?,?)",
  ).all(...TABLES)) {
    mem.exec(row.sql);
  }
  disk.close();
  const calls = [];
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    calls.push({ sql, params });
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  exec.calls = calls;
  return exec;
}

function resetBoth() {
  const exec = pgFixture();
  for (const table of TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
    exec.raw.prepare(`DELETE FROM ${table}`).run();
  }
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN (?,?)").run(...TABLES); } catch { /* 沒有 AUTOINCREMENT */ }
  return exec;
}

const dump = (handle, table) => handle.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((r) => ({ ...r }));

function assertSameRows(exec, table, why) {
  const a = dump(db, table);
  const b = dump(exec.raw, table);
  assert.deepEqual(b, a, `${why}：PG 分支落地的 ${table} 必須與同步版完全相同`);
  assert.ok(a.length > 0 || why.includes("空"), `${why}：兩邊都是 0 列時這個比對沒有鑑別力`);
}

const reasonOf = (error) => `${error.status}/${error.message}`;
const DRAFT = {
  document_type: "registration_terms",
  title: "使用條款",
  body: "第一版條文",
  check_label: "我同意",
};

// ---------------------------------------------------------------------------
// 草稿生命週期

test("建立草稿：形狀、版本號、落地列與稽核事件都與同步版相同", async () => {
  const exec = resetBoth();
  const pg = await asyncMod.createDraftAsync(DRAFT, { actorId: 7, now: NOW, ...PG, exec });
  const lite = sync.createDraft(db, DRAFT, { actorId: 7, now: NOW });

  assert.equal(pg.id, lite.id);
  assert.equal(pg.version, 1, "第一版必須是 1");
  assert.equal(pg.status, "draft");
  assert.equal(pg.enabled, true, "enabled 是布林 true（不是 1）");
  assert.equal(pg.requires_reacceptance, false);
  assert.equal(pg.title, "使用條款");
  assert.ok(pg.content_hash.length > 0, "content_hash 不得為空，否則比對沒有鑑別力");
  assert.equal(pg.content_hash, lite.content_hash, "指紋必須相同（同樣的輸入要同樣的 hash）");
  assert.equal(pg.created_at, NOW.toISOString());
  assertSameRows(exec, "content_documents", "建立草稿");
  assertSameRows(exec, "content_document_events", "建立草稿的稽核事件");
  assert.equal(dump(exec.raw, "content_document_events")[0].action, "draft_create");
});

test("建立草稿：版本號往上遞增，指紋要跟著版本變（否則兩版會同 hash）", async () => {
  const exec = resetBoth();
  const a1 = await asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec });
  sync.createDraft(db, DRAFT, { now: NOW });
  const a2 = await asyncMod.createDraftAsync({ ...DRAFT, body: "第二版條文" }, { now: NOW, ...PG, exec });
  const l2 = sync.createDraft(db, { ...DRAFT, body: "第二版條文" }, { now: NOW });
  assert.equal(a1.version, 1);
  assert.equal(a2.version, 2, "第二筆要自動進位到 2");
  assert.equal(a2.version, l2.version);
  assert.notEqual(a2.content_hash, a1.content_hash, "內文不同 ⇒ hash 必須不同");
  assert.equal(a2.content_hash, l2.content_hash);
  assertSameRows(exec, "content_documents", "兩版草稿");
});

test("建立草稿：同一個版本號第二次要被擋（409），落地不得多一列", async () => {
  const exec = resetBoth();
  await asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec });
  sync.createDraft(db, DRAFT, { now: NOW });
  let syncErr = null;
  try { sync.createDraft(db, { ...DRAFT, version: 1 }, { now: NOW }); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該擋下重複版本號");
  assert.equal(syncErr.status, 409);
  await assert.rejects(() => asyncMod.createDraftAsync({ ...DRAFT, version: 1 }, { now: NOW, ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr), `PG 分支必須一致（同步版：${reasonOf(syncErr)}）`);
  assert.equal(dump(exec.raw, "content_documents").length, 1, "被擋下就不得落地");
});

test("建立草稿：未知文件類型、空標題、不安全標記都要擋下，且兩邊訊息相同", async () => {
  const exec = resetBoth();
  const cases = [
    { input: { ...DRAFT, document_type: "not_a_type" }, why: "未知類型" },
    { input: { ...DRAFT, title: "   " }, why: "空標題" },
    { input: { ...DRAFT, body: "  " }, why: "空本文" },
    // ⚠️ 不安全標記要放在 **title**，不能放 body。`sanitizeDocumentBody()` 會先把
    // `<script>…</script>` 剝掉（那是它的職責），所以 body 永遠不會觸發後面的
    // `containsUnsafeMarkup()` 檢查——第一版就是放 body，變異測試顯示「拿掉那個檢查照樣過關」。
    // title 走的是 `sanitizeDocumentText()`，只去 NUL／換行，不剝標記 ⇒ 才驗得到那個檢查。
    { input: { ...DRAFT, title: "<script>alert(1)</script>" }, why: "不安全標記（title）" },
    { input: { ...DRAFT, check_label: "<iframe src=x></iframe>" }, why: "不安全標記（check_label）" },
  ];
  for (const c of cases) {
    let syncErr = null;
    try { sync.createDraft(db, c.input, { now: NOW }); } catch (e) { syncErr = e; }
    assert.ok(syncErr, `同步版應該擋下（${c.why}）`);
    await assert.rejects(() => asyncMod.createDraftAsync(c.input, { now: NOW, ...PG, exec }),
      (e) => reasonOf(e) === reasonOf(syncErr), `PG 分支必須一致（${c.why}）`);
  }
  assert.equal(dump(exec.raw, "content_documents").length, 0, "被擋下的都不得落地");
});

test("更新草稿：只改帶到的欄位，沒帶的沿用舊值", async () => {
  const exec = resetBoth();
  const created = await asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec });
  sync.createDraft(db, DRAFT, { now: NOW });
  const pg = await asyncMod.updateDraftAsync(created.id, { body: "改過的內文" }, { actorId: 3, now: LATER, ...PG, exec });
  const lite = sync.updateDraft(db, created.id, { body: "改過的內文" }, { actorId: 3, now: LATER });
  assert.equal(pg.title, "使用條款", "沒帶 title 要沿用舊值");
  assert.equal(pg.body, "改過的內文");
  assert.equal(pg.check_label, "我同意", "沒帶 check_label 要沿用舊值");
  // 指紋要因為內文變了而變——拿自己跟自己比是無意義的斷言（第一版就是那樣寫的，
  // 突變測試／人工複查都會看起來「有驗」，其實什麼都沒驗）。
  assert.notEqual(pg.content_hash, created.content_hash, "內文改了 ⇒ 指紋必須跟著變");
  assert.equal(pg.content_hash, lite.content_hash, "hash 必須兩邊相同");
  assertSameRows(exec, "content_documents", "更新草稿");
  assertSameRows(exec, "content_document_events", "更新草稿的稽核事件");
});

// ---------------------------------------------------------------------------
// 不可變性（這一檔的重點）

test("已發布的文件：改本文必須被擋（409），只改旗標要放行", async () => {
  const exec = resetBoth();
  const draft = await asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec });
  const published = await asyncMod.publishDocumentAsync(draft.id, { actorId: 1, now: NOW, ...PG, exec });
  sync.publishDocument(db, sync.createDraft(db, DRAFT, { now: NOW }).id, { actorId: 1, now: NOW });
  assert.equal(published.status, "published");

  for (const input of [{ body: "偷改" }, { title: "偷改" }, { check_label: "偷改" }, { format: "markdown" }]) {
    let syncErr = null;
    try { sync.updateDraft(db, 1, input, { now: LATER }); } catch (e) { syncErr = e; }
    assert.ok(syncErr, `同步版應該擋下已發布版本的本文變更（${JSON.stringify(input)}）`);
    await assert.rejects(() => asyncMod.updateDraftAsync(1, input, { now: LATER, ...PG, exec }),
      (e) => reasonOf(e) === reasonOf(syncErr),
      `PG 分支必須擋下（${JSON.stringify(input)}；同步版：${reasonOf(syncErr)}）`);
  }
  assert.equal(dump(exec.raw, "content_documents")[0].body, DRAFT.body, "本文不得被改掉");

  // 只改旗標（enabled／effective_until）要放行——這一條證明上面的擋下不是「什麼都擋」。
  const pgFlags = await asyncMod.updateDraftAsync(1, { enabled: false, effective_until: "2026-12-31" }, { now: LATER, ...PG, exec });
  const liteFlags = sync.updateDraft(db, 1, { enabled: false, effective_until: "2026-12-31" }, { now: LATER });
  assert.equal(pgFlags.enabled, false);
  assert.equal(pgFlags.effective_until, "2026-12-31");
  assert.equal(pgFlags.body, DRAFT.body, "改旗標不得動到本文");
  assert.deepEqual(pgFlags, liteFlags);
  assertSameRows(exec, "content_documents", "改已發布版本的旗標");
});

test("PG 的觸發器 SQL 必須用 IS DISTINCT FROM，且 bootstrap 順序是 函式→DROP→CREATE", async () => {
  // 離線夾具證明不了「這段 SQL 在 PG 上合法」，但至少可以釘住**語意等價的寫法**：
  // 用 `IS NOT OLD.x` 是 SQLite 語法，PG 會語法錯誤；`IS DISTINCT FROM` 才是 PG 的寫法。
  assert.match(asyncMod.PG_IMMUTABLE_FUNCTION_SQL, /IS DISTINCT FROM OLD\.body/,
    "PG 的比較必須用 IS DISTINCT FROM（IS NOT 不能比 NULL）");
  assert.doesNotMatch(asyncMod.PG_IMMUTABLE_FUNCTION_SQL, /RAISE\s*\(\s*ABORT/i,
    "RAISE(ABORT) 是 SQLite 語法，PG 要用 RAISE EXCEPTION");
  assert.match(asyncMod.PG_IMMUTABLE_FUNCTION_SQL, /RAISE EXCEPTION 'published_document_immutable'/,
    "例外訊息要與 SQLite 版一致，否則上層辨識不出同一個原因");
  for (const col of ["body", "title", "format", "check_label", "content_hash", "version", "document_type"]) {
    assert.ok(asyncMod.PG_IMMUTABLE_FUNCTION_SQL.includes(`OLD.${col}`),
      `不可變清單必須包含 ${col}（漏掉等於那個欄位可以被偷改）`);
  }

  const driver = recordingDriver();
  await asyncMod.ensureContentDocumentStoreOnce(driver);
  const first = [...driver.statements];
  const fnAt = first.indexOf(asyncMod.PG_IMMUTABLE_FUNCTION_SQL);
  const dropAt = first.indexOf(asyncMod.PG_DROP_TRIGGER_SQL);
  const createAt = first.indexOf(asyncMod.PG_CREATE_TRIGGER_SQL);
  assert.ok(fnAt >= 0 && dropAt > fnAt && createAt > dropAt,
    `順序必須是 建函式 → DROP TRIGGER → CREATE TRIGGER（PG 沒有 CREATE TRIGGER IF NOT EXISTS，重複建立會失敗）。實際：${first.map((s) => s.slice(0, 40))}`);
  assert.ok(first.some((s) => /idx_content_documents_type_version/.test(s)), "版本唯一索引要建");
  await asyncMod.ensureContentDocumentStoreOnce(driver);
  assert.equal(driver.statements.length, first.length, "第二次呼叫不得再跑一次 schema");
});

function recordingDriver() {
  const statements = [];
  return {
    statements,
    async exec(sql) { statements.push(sql); },
    async query(sql, params = []) {
      if (sql.includes("?")) throw new Error(`PG driver 收到未翻譯的 SQL：${sql.slice(0, 60)}`);
      statements.push(sql);
      return { rows: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// 發布與新版本

test("發布：狀態、published_at 與稽核事件都對；重複發布是 no-op 且不再寫稽核", async () => {
  const exec = resetBoth();
  const draft = await asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec });
  sync.createDraft(db, DRAFT, { now: NOW });
  const pg = await asyncMod.publishDocumentAsync(draft.id, { actorId: 5, now: LATER, ...PG, exec });
  const lite = sync.publishDocument(db, 1, { actorId: 5, now: LATER });
  assert.equal(pg.status, "published");
  assert.equal(pg.published_at, LATER.toISOString());
  assert.equal(pg.enabled, true, "發布時要強制啟用");
  assert.deepEqual(pg, lite);
  assertSameRows(exec, "content_documents", "發布");
  assertSameRows(exec, "content_document_events", "發布的稽核事件");
  assert.equal(dump(exec.raw, "content_document_events").filter((e) => e.action === "publish").length, 1);

  const again = await asyncMod.publishDocumentAsync(draft.id, { actorId: 5, now: LATER, ...PG, exec });
  sync.publishDocument(db, 1, { actorId: 5, now: LATER });
  assert.equal(again.status, "published");
  assert.equal(dump(exec.raw, "content_document_events").filter((e) => e.action === "publish").length, 1,
    "重複發布不得再寫一筆稽核（同步版是直接回傳）");
  assertSameRows(exec, "content_document_events", "重複發布後");
});

test("從已發布版本開新草稿：版本 +1、supersedes_id 指回原版、原版不得被動到", async () => {
  const exec = resetBoth();
  const draft = await asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec });
  await asyncMod.publishDocumentAsync(draft.id, { actorId: 1, now: NOW, ...PG, exec });
  sync.publishDocument(db, sync.createDraft(db, DRAFT, { now: NOW }).id, { actorId: 1, now: NOW });

  const pg = await asyncMod.createDraftFromPublishedAsync(draft.id, { actorId: 2, now: LATER, ...PG, exec });
  const lite = sync.createDraftFromPublished(db, 1, { actorId: 2, now: LATER });
  assert.equal(pg.version, 2);
  assert.equal(pg.status, "draft");
  assert.equal(pg.supersedes_id, draft.id, "supersedes_id 必須指回原版");
  assert.equal(pg.id, lite.id);
  assert.deepEqual(pg, lite);
  const rows = dump(exec.raw, "content_documents");
  assert.equal(rows[0].status, "published", "原版必須維持已發布");
  assertSameRows(exec, "content_documents", "開新版本");

  // 只能從「已發布」開新版本。
  let syncErr = null;
  try { sync.createDraftFromPublished(db, pg.id, { now: LATER }); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "草稿不能開新版本");
  await assert.rejects(() => asyncMod.createDraftFromPublishedAsync(pg.id, { now: LATER, ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
});

// ---------------------------------------------------------------------------
// 生效判定

test("目前生效版本：已發布 ＋ 啟用 ＋ 在有效期間內，版本號最高", async () => {
  const exec = resetBoth();
  // v1 已發布但停用；v2 已發布但在未來才生效；v3 草稿。
  const v1 = await asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec });
  sync.createDraft(db, DRAFT, { now: NOW });
  await asyncMod.publishDocumentAsync(v1.id, { now: NOW, ...PG, exec });
  sync.publishDocument(db, 1, { now: NOW });
  await asyncMod.updateDraftAsync(v1.id, { enabled: false }, { now: NOW, ...PG, exec });
  sync.updateDraft(db, 1, { enabled: false }, { now: NOW });
  assert.equal(await asyncMod.getEffectiveDocumentAsync("registration_terms", { now: LATER, ...PG, exec }), null,
    "全部停用 ⇒ 沒有生效版本");

  const v2 = await asyncMod.createDraftAsync({ ...DRAFT, body: "未來版" }, { now: NOW, ...PG, exec });
  sync.createDraft(db, { ...DRAFT, body: "未來版" }, { now: NOW });
  await asyncMod.updateDraftAsync(v2.id, { effective_from: "2027-01-01" }, { now: NOW, ...PG, exec });
  sync.updateDraft(db, 2, { effective_from: "2027-01-01" }, { now: NOW });
  await asyncMod.publishDocumentAsync(v2.id, { now: NOW, ...PG, exec });
  sync.publishDocument(db, 2, { now: NOW });

  const before = await asyncMod.getEffectiveDocumentAsync("registration_terms", { now: LATER, ...PG, exec });
  const beforeLite = sync.getEffectiveDocument(db, "registration_terms", { now: LATER });
  assert.equal(before, null, "還沒到生效日 ⇒ 不生效");
  assert.equal(beforeLite, null);

  const after = await asyncMod.getEffectiveDocumentAsync("registration_terms", { now: new Date("2027-06-01"), ...PG, exec });
  const afterLite = sync.getEffectiveDocument(db, "registration_terms", { now: new Date("2027-06-01") });
  assert.equal(after.id, v2.id, "到生效日之後就要生效");
  assert.equal(after.body, "未來版");
  assert.deepEqual(after, afterLite);

  // 有效期間已過 ⇒ 不生效。
  await asyncMod.updateDraftAsync(v2.id, { effective_until: "2027-02-01" }, { now: NOW, ...PG, exec });
  sync.updateDraft(db, 2, { effective_until: "2027-02-01" }, { now: NOW });
  const expired = await asyncMod.getEffectiveDocumentAsync("registration_terms", { now: new Date("2027-06-01"), ...PG, exec });
  assert.equal(expired, null, "超過 effective_until ⇒ 不生效（邊界是 <=）");
  assert.equal(sync.getEffectiveDocument(db, "registration_terms", { now: new Date("2027-06-01") }), null);
});

test("註冊必要文件與 legalCopy：取不到就退回預設值，兩邊一致", async () => {
  const exec = resetBoth();
  const empty = await asyncMod.getRequiredRegistrationDocumentsAsync({ now: NOW, ...PG, exec });
  assert.deepEqual(empty, [], "沒有任何已發布文件 ⇒ 空陣列");
  const pgCopy = await asyncMod.legalCopyFromDocumentsAsync({ now: NOW, ...PG, exec });
  const { legalCopyFromDocuments } = sync;
  const liteCopy = legalCopyFromDocuments(db, { now: NOW });
  assert.deepEqual(pgCopy, liteCopy, "沒有文件時兩邊都要退回預設法務文案");
  assert.ok(pgCopy.disclaimer.length > 0, "預設文案不得為空，否則比對沒有鑑別力");

  for (const type of ["registration_terms", "privacy_notice"]) {
    const d = await asyncMod.createDraftAsync(
      { document_type: type, title: `${type} 標題`, body: `${type} 內文`, check_label: `${type} 勾選` },
      { now: NOW, ...PG, exec },
    );
    sync.createDraft(db, { document_type: type, title: `${type} 標題`, body: `${type} 內文`, check_label: `${type} 勾選` }, { now: NOW });
    await asyncMod.publishDocumentAsync(d.id, { now: NOW, ...PG, exec });
    sync.publishDocument(db, d.id, { now: NOW });
  }
  const required = await asyncMod.getRequiredRegistrationDocumentsAsync({ now: LATER, ...PG, exec });
  const requiredLite = sync.getRequiredRegistrationDocuments(db, { now: LATER });
  assert.equal(required.length, 2, "兩個必要文件都要回傳");
  assert.deepEqual(required, requiredLite);
  assert.deepEqual(required.map((d) => d.document_type), ["registration_terms", "privacy_notice"], "順序必須固定");

  const pgAfter = await asyncMod.legalCopyFromDocumentsAsync({ now: LATER, ...PG, exec });
  const liteAfter = legalCopyFromDocuments(db, { now: LATER });
  assert.deepEqual(pgAfter, liteAfter);
  assert.equal(pgAfter.disclaimer, "registration_terms 內文", "有發布版本時要用文件內容，不是預設值");
  assert.equal(pgAfter.privacy, "privacy_notice 內文");
  assert.match(pgAfter.version, /^v\d+$/);
});

test("稽核事件列表：limit 會被夾在 1..200（直接驗送進 SQL 的參數）", async () => {
  const exec = resetBoth();
  const d = await asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec });
  sync.createDraft(db, DRAFT, { now: NOW });
  await asyncMod.updateDraftAsync(d.id, { body: "x" }, { now: NOW, ...PG, exec });
  sync.updateDraft(db, 1, { body: "x" }, { now: NOW });
  await asyncMod.publishDocumentAsync(d.id, { now: NOW, ...PG, exec });
  sync.publishDocument(db, 1, { now: NOW });

  const pgAll = await asyncMod.listDocumentEventsAsync({ limit: 999 }, { ...PG, exec });
  const liteAll = sync.listDocumentEvents(db, { limit: 999 });
  assert.deepEqual(pgAll, liteAll);
  assert.equal(pgAll.length, 3, "draft_create／draft_update／publish 各一");
  assert.deepEqual(pgAll.map((e) => e.action), ["publish", "draft_update", "draft_create"], "必須依 id DESC");
  assert.deepEqual(await asyncMod.listDocumentEventsAsync({ limit: 1 }, { ...PG, exec }), sync.listDocumentEvents(db, { limit: 1 }));
  assert.equal((await asyncMod.listDocumentEventsAsync({ limit: 1 }, { ...PG, exec })).length, 1);
  // ⚠️ 只比對回傳值驗不到「夾範圍」：這裡只有 3 筆事件，limit=200 與 limit=999 的結果一樣。
  // 第一版就是這樣寫，變異測試顯示「拿掉夾範圍照樣過關」。改成**直接驗送進 SQL 的參數**。
  const stored = await asyncMod.listDocumentEventsAsync({ limit: 999 }, { ...PG, exec });
  assert.deepEqual(stored, liteAll);
  const limitParam = (calls) => calls.filter((c) => /LIMIT \?/.test(c.sql)).at(-1)?.params?.at(-1);
  const callsFor = async (opts) => {
    const seen = [];
    const wrapped = async (sql, params = []) => { seen.push({ sql, params }); return exec(sql, params); };
    await asyncMod.listDocumentEventsAsync(opts, { ...PG, exec: wrapped });
    return limitParam(seen);
  };
  assert.equal(await callsFor({ limit: 999 }), 200, "上限必須夾在 200");
  // ⚠️ `Number(limit) || 50`：`0` 是 falsy，所以在 `Math.max` 之前就已經變成 50 了
  //（同步版一模一樣）。第一版我寫「0 要夾成 1」是憑印象、不是讀程式碼。
  assert.equal(await callsFor({ limit: 0 }), 50, "0 是 falsy ⇒ 走預設 50（不是 1）");
  assert.equal(await callsFor({ limit: -5 }), 1, "負數才由 Math.max 夾成 1");
  assert.equal(await callsFor({ limit: 7 }), 7, "正常值不得被動到");
  assert.deepEqual(
    await asyncMod.listDocumentEventsAsync({ type: "privacy_notice" }, { ...PG, exec }),
    sync.listDocumentEvents(db, { type: "privacy_notice" }),
  );
});

// ---------------------------------------------------------------------------
// 回退政策

test("非 postgres 模式必須回退同步路徑（讀寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  const pgDoc = await asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec });
  assert.equal(pgDoc.version, 1);
  const lite = await asyncMod.createDraftAsync({ ...DRAFT, title: "磁碟版" }, { now: NOW, driver: "sqlite", exec });
  assert.equal(lite.title, "磁碟版");
  assert.deepEqual(dump(db, "content_documents").map((r) => r.title), ["磁碟版"]);
  assert.deepEqual(dump(exec.raw, "content_documents").map((r) => r.title), ["使用條款"], "sqlite 模式不得改動 PG 夾具");
  assert.equal((await asyncMod.getEffectiveDocumentAsync("registration_terms", { driver: "sqlite", exec })), null);
});

test("strict：PG 寫入失敗時必須往上丟，不得無聲寫進沒人讀的 SQLite", async () => {
  const exec = resetBoth();
  const broken = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(() => asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec: broken, strict: true }), /connection terminated/);
  await assert.rejects(() => asyncMod.createDraftAsync(DRAFT, { now: NOW, ...PG, exec: broken }), /connection terminated/);
  assert.equal(dump(db, "content_documents").length, 0, "寫入失敗不得回退寫 SQLite");
});

test("夾具本身要真的拒絕 RAISE(ABORT)／IS NOT OLD／IFNULL（否則方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT RAISE(ABORT, 'x')"), /RAISE/);
  await assert.rejects(() => exec("SELECT 1 WHERE 1 IS NOT OLD.body"), /OLD/);
  await assert.rejects(() => exec("SELECT IFNULL(title,'') FROM content_documents"), /function ifnull/);
  await assert.doesNotReject(() => exec("SELECT title FROM content_documents"), "普通查詢要放行");
});
