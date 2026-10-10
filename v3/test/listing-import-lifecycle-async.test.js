// 匯入生命週期（讀取／修改／取消）PG 分支的 parity（2026-09-28，第四十七批）。
//
// 涵蓋的三條路由：
//   `GET   /api/listing-imports/:id`         → `getOwnedListingImportViewAsync`
//   `PATCH /api/listing-imports/:id`         → `reviewListingImportAsync`
//   `POST  /api/listing-imports/:id/cancel`  → `cancelListingImportAsync`
//
// 這一包要釘住四件事：
//
//   1. **`publicImport()` 的 20 個鍵**（含 `listing` 與 `photos`）：投影共用
//      `publicImportShape()`，而 `listing` 那一格在 PG 版是 `getSelfListingAsync()`
//      的 try/catch（同步版是 `safeListing()`）——「查不到就 null」的寬容度必須一致。
//   2. **狀態機**：`reviewListingImport()` 只接受 `ready_for_review`；
//      `cancelListingImport()` 對 `confirmed` 丟 409、對 `cancelled` 直接回同一筆。
//      狀態碼是**共用政策**，parity 抓不到「兩邊一起改壞」，所以對值本身下斷言。
//   3. **取消要一起收掉草稿**：`listings.self_status` 變 `cancelled`，
//      而且**兩個 store 都要寫**（本機的同步瀏覽路徑讀 `listings`）。
//   4. **媒體清理是 best-effort**：逐筆 try/catch（同步版也是），所以「媒體不存在」
//      不該讓取消失敗；反過來說，這一段的正確性由 member-media 那一批的測試負責。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-implife-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/listingImport.js");
const asyncMod = await import("../src/listingImportAsync.js");
const dbMod = await import("../src/db.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-28T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
];

const TABLES = ["users", "settings", "listings", "listing_import", "member_media", "media_tags", "media_tag_map"];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
  }
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    rows.rowCount = Number(mem.prepare("SELECT changes() AS n").get().n) || 0;
    return rows;
  };
  exec.raw = mem;
  return exec;
}

const OWNER = 91;
const OTHER = 92;
const IMPORT_ID = 610001;
const DRAFT_ID = 810001;

function clearWorld(h) {
  h.prepare("DELETE FROM media_tag_map").run();
  h.prepare("DELETE FROM member_media").run();
  h.prepare("DELETE FROM listing_import WHERE id >= 610000").run();
  h.prepare("DELETE FROM listings WHERE post_id >= 810000").run();
  h.prepare("DELETE FROM media_tags WHERE user_id IN (91, 92)").run();
  h.prepare("DELETE FROM users WHERE id IN (91, 92)").run();
}

function seedUsers(h) {
  for (const id of [OWNER, OTHER]) {
    h.prepare(
      "INSERT INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'sponsor', ?)",
    ).run(id, `implife${id}@example.com`, `會員${id}`, OLD);
  }
}

function seedDraft(h, { id = DRAFT_ID, ownerId = OWNER, status = "draft" } = {}) {
  h.prepare(
    `INSERT INTO listings(post_id, source_key, title, url, source, listed_by_user_id, self_status, self_body, self_photos, cover, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'self', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `self-${id}`, `匯入草稿 ${id}`, `https://example.com/${id}`, ownerId, status,
    "草稿內容", JSON.stringify([]), "", OLD, OLD);
}

function seedImport(h, { id = IMPORT_ID, userId = OWNER, status = "ready_for_review", listingId = DRAFT_ID, mediaIds = [] } = {}) {
  h.prepare(
    `INSERT INTO listing_import(id, user_id, provider, original_source_url, normalized_source_url, source_listing_id,
       status, imported_title, imported_text, listing_id, terms_document_id, declaration_version,
       declaration_content_hash, created_at, fetched_at, confirmed_at, failure_code, failure_reason, photo_errors, media_ids)
     VALUES (?, ?, '591', ?, ?, '', ?, ?, ?, ?, NULL, NULL, '', ?, ?, NULL, '', '', '[]', ?)`,
  ).run(id, userId, `https://example.com/${id}`, `https://example.com/${id}`, status,
    `匯入標題 ${id}`, "匯入內容", listingId, OLD, OLD, JSON.stringify(mediaIds));
}

function resetBoth(seedFn) {
  const disk = handle();
  clearWorld(disk);
  seedUsers(disk);
  const exec = pgFixture();
  clearWorld(exec.raw);
  seedUsers(exec.raw);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}

const importRow = (h, id = IMPORT_ID) => h.prepare("SELECT status, imported_title, imported_text, listing_id FROM listing_import WHERE id = ?").get(id);
const draftRow = (h, id = DRAFT_ID) => h.prepare("SELECT title, self_body, self_photos, self_status FROM listings WHERE post_id = ?").get(id);
const plain = (value) => JSON.parse(JSON.stringify(value));
const errorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};
const syncErrorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};

// ---------------------------------------------------------------------------

test("讀取：公開形狀逐鍵相同（含巢狀 listing 與 photos）", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedDraft(h);
    seedImport(h);
  });
  const syncView = plain(dbMod.getOwnedListingImport(OWNER, IMPORT_ID));
  const asyncView = plain(await asyncMod.getOwnedListingImportViewAsync(OWNER, IMPORT_ID, { ...PG, exec, strict: true }));
  assert.deepEqual(asyncView, syncView, "公開形狀必須逐鍵相同");
  assert.equal(asyncView.status, "ready_for_review");
  assert.ok(asyncView.listing, "巢狀 listing 必須在（草稿存在）");
  assert.equal(asyncView.listing.post_id, DRAFT_ID);
  assert.deepEqual(asyncView.photos, [], "photos 由 listing 推導");
  assert.equal(asyncView.live_sync, false);

  // 沒有草稿的那一筆：`listing` 要是 null，不是 undefined
  seedImport(exec.raw, { id: IMPORT_ID + 1, listingId: null });
  seedImport(disk, { id: IMPORT_ID + 1, listingId: null });
  const noDraft = plain(await asyncMod.getOwnedListingImportViewAsync(OWNER, IMPORT_ID + 1, { ...PG, exec, strict: true }));
  assert.deepEqual(noDraft, plain(dbMod.getOwnedListingImport(OWNER, IMPORT_ID + 1)));
  assert.strictEqual(noDraft.listing, null, "沒有草稿時 listing 必須是 null（strictEqual：assert.equal 會放過 undefined）");

  // 別人的／不存在的：錯誤形狀相同
  for (const [uid, id, why] of [[OTHER, IMPORT_ID, "別人的匯入"], [OWNER, 619999, "不存在"]]) {
    const syncErr = syncErrorShape(() => dbMod.getOwnedListingImport(uid, id));
    const asyncErr = await errorShape(() => asyncMod.getOwnedListingImportViewAsync(uid, id, { ...PG, exec, strict: true }));
    assert.ok(syncErr, `同步版應該要丟錯（${why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${why}）`);
  }
});

test("修改：標題與內容會淨化，草稿同步更新；匯入列只寫 PG（不再鏡射本機）", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedDraft(h);
    seedImport(h);
  });
  const input = { title: "  新的匯入標題  ", body: "新的內容 <b>可以</b> 有標記" };
  const syncView = plain(dbMod.reviewListingImportFor(OWNER, IMPORT_ID, input));
  const syncImport = importRow(disk);
  const syncDraft = draftRow(disk);

  clearWorld(disk);
  seedUsers(disk);
  seedDraft(disk);
  seedImport(disk);
  const localBefore = plain(importRow(disk));

  const asyncView = plain(await asyncMod.reviewListingImportAsync(OWNER, IMPORT_ID, input, { ...PG, exec, strict: true }));
  assert.deepEqual(asyncView, syncView, "回傳的公開形狀必須相同");
  assert.deepEqual(plain(importRow(exec.raw)), plain(syncImport), "PG 上的匯入列必須相同");
  // SQLite 退場 P3：這條原本斷言「本機的匯入列也要追上」（PG 寫完再鏡射一次節點本機的
  // `listing_import`）。正式站三隻都開著 `PG_NO_SQLITE_OPEN=1` ⇒ 那句鏡射會直接拋
  // 「business SQLite is closed」，PG 明明寫成功、使用者卻收到失敗。方向是 PG 唯一權威來源，
  // 所以現在改斷言本機那一列**不得被動到**（開閘時任何觸碰都會拋，這裡用「內容不變」等價證明）。
  assert.deepEqual(plain(importRow(disk)), localBefore, "本機的匯入列不得再被鏡射寫入");
  assert.deepEqual(plain(draftRow(exec.raw)), plain(syncDraft), "PG 上的草稿必須相同");
  assert.deepEqual(plain(draftRow(disk)), plain(syncDraft), "本機的草稿也要追上（同步瀏覽路徑讀它）");
  assert.equal(asyncView.imported_title, "新的匯入標題", "標題要 trim（否則這條測試沒有鑑別力）");
});

test("修改：狀態不是 ready_for_review、不是自己的，錯誤形狀都要與同步版相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedDraft(h);
    seedImport(h, { status: "confirmed" });
  });
  const cases = [
    { uid: OWNER, why: "已確認的匯入不能改" },
    { uid: OTHER, why: "不是自己的匯入" },
  ];
  for (const c of cases) {
    const syncErr = syncErrorShape(() => dbMod.reviewListingImportFor(c.uid, IMPORT_ID, { title: "偷改" }));
    const asyncErr = await errorShape(() => asyncMod.reviewListingImportAsync(c.uid, IMPORT_ID, { title: "偷改" }, { ...PG, exec, strict: true }));
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${c.why}）`);
    assert.equal(importRow(exec.raw).imported_title, `匯入標題 ${IMPORT_ID}`, `PG 不得被寫入（${c.why}）`);
  }
  // 狀態碼是共用政策：直接對值下斷言（parity 抓不到「兩邊一起改壞」）
  assert.equal(syncMod.IMPORT_STATUSES.READY_FOR_REVIEW, "ready_for_review");
  assert.equal(syncMod.IMPORT_STATUSES.CANCELLED, "cancelled");
  assert.equal(syncMod.IMPORT_STATUSES.CONFIRMED, "confirmed");
});

test("取消：匯入變 cancelled、草稿變 cancelled；匯入列只寫 PG（草稿仍兩個 store 都寫）", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedDraft(h);
    seedImport(h, { mediaIds: [] });
  });
  const syncResult = plain(await dbMod.cancelListingImportFor(OWNER, IMPORT_ID));
  const syncImport = importRow(disk);
  const syncDraft = draftRow(disk);

  clearWorld(disk);
  seedUsers(disk);
  seedDraft(disk);
  seedImport(disk, { mediaIds: [] });
  const localBefore = plain(importRow(disk));

  const result = plain(await asyncMod.cancelListingImportAsync(OWNER, IMPORT_ID, { ...PG, exec, strict: true, now: NOW }));
  assert.deepEqual(result, syncResult, "回傳值必須相同");
  assert.deepEqual(plain(importRow(exec.raw)), plain(syncImport), "PG 上的匯入狀態必須相同");
  // SQLite 退場 P3：原本斷言「本機的匯入狀態也要追上」；開閘時那句鏡射會拋錯
  // （PG 已取消、使用者卻收到失敗），現在改斷言本機那一列不得被動到。
  assert.deepEqual(plain(importRow(disk)), localBefore, "本機的匯入列不得再被鏡射寫入");
  assert.equal(importRow(exec.raw).status, "cancelled");
  assert.deepEqual(plain(draftRow(exec.raw)), plain(syncDraft), "PG 上的草稿狀態必須相同");
  assert.deepEqual(plain(draftRow(disk)), plain(syncDraft), "本機的草稿也要追上");
  assert.equal(draftRow(exec.raw).self_status, "cancelled", "取消要一起收掉草稿");
});

test("取消：已取消是 idempotent、已確認要 409、不是自己的要 403", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedDraft(h);
    seedImport(h);
  });
  // 先取消一次（兩個 driver 各自一次，驗 idempotent）
  await asyncMod.cancelListingImportAsync(OWNER, IMPORT_ID, { ...PG, exec, strict: true, now: NOW });
  const again = plain(await asyncMod.cancelListingImportAsync(OWNER, IMPORT_ID, { ...PG, exec, strict: true, now: NOW }));
  assert.equal(again.status, "cancelled", "已取消再取消要回同一筆（不得丟錯）");

  // 已確認：409，兩個 driver 相同
  const confirmedId = IMPORT_ID + 5;
  for (const h of [disk, exec.raw]) seedImport(h, { id: confirmedId, status: "confirmed", listingId: null });
  // ⚠️ `cancelListingImport()` 在同步版就是 **async**（它要 await 媒體清理），
  // 所以「同步對照」也要用 await 的錯誤捕捉——用同步的 `syncErrorShape` 會拿到 null
  // （拒絕是非同步發生的），於是斷言看起來像「同步版沒有擋」。
  const syncErr = await errorShape(() => dbMod.cancelListingImportFor(OWNER, confirmedId));
  const asyncErr = await errorShape(() => asyncMod.cancelListingImportAsync(OWNER, confirmedId, { ...PG, exec, strict: true }));
  assert.ok(syncErr, "同步版應該要丟 409");
  assert.deepEqual(asyncErr, syncErr, "已確認的錯誤形狀必須相同");
  assert.equal(importRow(exec.raw, confirmedId).status, "confirmed", "擋下來時不得改狀態");

  // 不是自己的：403
  const otherSyncErr = await errorShape(() => dbMod.cancelListingImportFor(OTHER, IMPORT_ID));
  const otherAsyncErr = await errorShape(() => asyncMod.cancelListingImportAsync(OTHER, IMPORT_ID, { ...PG, exec, strict: true }));
  assert.ok(otherSyncErr, "同步版應該要丟 403");
  assert.deepEqual(otherAsyncErr, otherSyncErr, "不是自己的錯誤形狀必須相同");
});

test("非 postgres 模式必須走同步路徑（不碰傳入的 exec）", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedDraft(h);
    seedImport(h);
  });
  let touched = 0;
  const counting = async (sql, params = []) => { touched += 1; return exec(sql, params); };
  const view = plain(await asyncMod.getOwnedListingImportViewAsync(OWNER, IMPORT_ID, { driver: "sqlite", exec: counting }));
  const reviewed = plain(await asyncMod.reviewListingImportAsync(OWNER, IMPORT_ID, { title: "本機修改" }, { driver: "sqlite", exec: counting }));
  const cancelled = plain(await asyncMod.cancelListingImportAsync(OWNER, IMPORT_ID, { driver: "sqlite", exec: counting, now: NOW }));
  assert.equal(touched, 0, "SQLite 模式不得碰 PG runner");
  assert.equal(view.status, "ready_for_review");
  assert.equal(reviewed.imported_title, "本機修改");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(importRow(disk).status, "cancelled", "要走同步路徑寫本機");
  assert.equal(importRow(exec.raw).status, "ready_for_review", "不得寫 PG 夾具");
});
