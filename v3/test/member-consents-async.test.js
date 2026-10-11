// 會員同意紀錄（consents）＋ 匯入確認 PG 分支的 parity（2026-09-28，第四十八批）。
//
// 涵蓋的四條路由：
//   `GET  /api/consents`                    → `listMyConsentsAsync`
//   `POST /api/consents`                    → `acceptPendingDocumentsAsync`
//   `GET  /api/consents/:id/document`        → `getOwnConsentDocumentAsync`
//   `POST /api/listing-imports/:id/confirm`  → `confirmListingImportAsync`
//
// 這一包要釘住五件事：
//
//   1. **`recordConsent()` 是 idempotent**：同一 `(user, document_id, content_hash)` 已存在就回舊的。
//      PG 沒有那組唯一鍵（SQLite 的 DDL 也只有一般索引）⇒ 靠先查再寫；拿掉那段查詢不會報錯，
//      只會多一列，所以要單獨驗。
//   2. **「已同意目前有效版本」比的是 id ＋ content_hash**，不是「曾經同意過某一版」；
//      而文件若 `requires_reacceptance`，legacy 的 `users.accepted_disclaimer_at` **不算數**。
//   3. **`pendingRequiredDocuments()` 的順序**：`REGISTRATION_DOC_TYPES` 的順序就是回應順序
//      （前端逐份渲染），parity 比對會抓到順序不同。
//   4. **匯入確認的聲明比對**：document_id／version／content_hash 三者都要相同，
//      不一致是 409 `declaration_stale`（使用者要重新閱讀）；這三個條件各自都要有鑑別力。
//   5. **同意列要兩個 store 都寫**：註冊流程（同步）還在讀本機的 `member_consents`。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-consents-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/memberConsents.js");
const asyncMod = await import("../src/memberConsentsAsync.js");
const docsAsync = await import("../src/contentDocumentsAsync.js");
const importsAsync = await import("../src/listingImportAsync.js");
const dbMod = await import("../src/db.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-28T00:00:00.000Z";
const TOKEN = "livetest";
const DECLARATION_TYPE = "external_import_declaration";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
];

const TABLES = ["users", "settings", "member_consents", "content_documents", "listing_import", "listings"];

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

// ⚠️ `member_consents` 是 **append-only**（DDL 有 trigger 擋 DELETE），所以測試不能清它。
// 每個測試配置一組「全新的 user id」，用 id 隔離就夠了（append-only 本來就刪不掉）。
let userSeq = 950;
const nextUserId = () => { userSeq += 1; return userSeq; };
const IMPORT_ID = 620001;

function clearWorld(h) {
  // 不要刪 `member_consents`（append-only 的 trigger 會擋），靠 user id 隔離。
  h.prepare("DELETE FROM listing_import WHERE id >= 620000").run();
  h.prepare("DELETE FROM listings WHERE post_id >= 820000").run();
  // 用 id 範圍清（`content_documents` 有 UNIQUE(document_type, version)，只按類型清會漏掉
  // registration_terms／privacy_notice 那些「正式類型」的測試列，下一個測試就撞唯一鍵）。
  try { h.prepare("DELETE FROM content_document_events WHERE document_id >= 700000").run(); } catch { /* 沒有事件表 */ }
  h.prepare("DELETE FROM content_documents WHERE id >= 700000").run();
  // 也不要刪測試帳號：`member_consents` 是 append-only ⇒ 有同意列的帳號永遠刪不掉（FK）。
  // 每個測試用全新的 id，殘留不影響其他測試。
}

function seedUsers(h, ids) {
  for (const id of ids) {
    h.prepare(
      "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'sponsor', ?)",
    ).run(id, `consent${id}@example.com`, `會員${id}`, OLD);
  }
}

// 已發布且生效中的文件（`inEffect()` 看 status／enabled／effective_from／effective_until）。
// ⚠️ `content_documents` 有 UNIQUE(document_type, version)，而 bootstrap 已經種了
// `registration_terms`／`privacy_notice` 的 v1 ⇒ 測試用 v2（`getEffectiveDocument()` 取版本最高的）。
function seedDoc(h, { id, type = "test_terms", version = 1, hash = "hash-v1", requiresReacceptance = 0, enabled = 1 }) {
  h.prepare(
    `INSERT INTO content_documents(id, document_type, version, title, body, format, check_label, status, enabled,
       requires_reacceptance, effective_from, effective_until, content_hash, created_at, published_at)
     VALUES (?, ?, ?, ?, '內容', 'plain', '', 'published', ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(id, type, version, `文件 ${type} v${version}`, enabled, requiresReacceptance, hash, OLD, OLD);
}

function seedConsent(h, { id, userId, documentId, hash = "hash-v1", type = "test_terms", source = "reaccept" }) {
  h.prepare(
    `INSERT INTO member_consents(id, user_id, document_type, document_id, version, content_hash, source, agreed_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(id, userId, type, documentId, hash, source, OLD);
}

function resetBoth(seedFn) {
  const USER = nextUserId();
  const OTHER = nextUserId();
  const disk = handle();
  clearWorld(disk);
  seedUsers(disk, [USER, OTHER]);
  const exec = pgFixture();
  clearWorld(exec.raw);
  seedUsers(exec.raw, [USER, OTHER]);
  // ⚠️ `content_documents` 在**正式站也有 bootstrap 種的文件**（`registration_terms`／
  // `privacy_notice`／匯入聲明…），而夾具只鏡射 DDL、不含資料 ⇒ 兩邊的「待同意清單」會不一樣
  // （第一版就是這樣紅的：同步版 2 份、PG 版 1 份）。這裡把磁碟上的文件列**原樣複製**一份，
  // 讓兩個 store 的起點相同（這才是 PG 站的真實狀態）。
  const docCols = disk.prepare("PRAGMA table_info(content_documents)").all().map((c) => c.name);
  const docRows = disk.prepare("SELECT * FROM content_documents").all();
  const docInsert = exec.raw.prepare(
    `INSERT INTO content_documents(${docCols.join(",")}) VALUES (${docCols.map(() => "?").join(",")})`,
  );
  for (const row of docRows) docInsert.run(...docCols.map((c) => row[c]));
  if (seedFn) { seedFn(disk, { USER, OTHER }); seedFn(exec.raw, { USER, OTHER }); }
  return [disk, exec, { USER, OTHER }];
}

const consentRows = (h, uid) => h.prepare("SELECT document_type, document_id, version, content_hash, source FROM member_consents WHERE user_id = ? ORDER BY id").all(uid);
const importRow = (h) => h.prepare("SELECT status, terms_document_id, declaration_version, declaration_content_hash, confirmed_at FROM listing_import WHERE id = ?").get(IMPORT_ID);
const plain = (value) => JSON.parse(JSON.stringify(value));
const errorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};
const syncErrorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};

// ---------------------------------------------------------------------------

test("同意紀錄：列表、idempotent、不完整要 400、未登入要 401", async () => {
  const [disk, exec, { USER, OTHER }] = resetBoth((h, { USER, OTHER }) => {
    seedDoc(h, { id: 700001 });
    seedConsent(h, { id: 710001, userId: USER, documentId: 700001 });
  });
  const input = { document_type: "test_terms", document_id: 700001, version: 1, content_hash: "hash-v1", source: "reaccept" };

  // 列表
  const syncList = plain(dbMod.listMyConsents(USER));
  const asyncList = plain(await asyncMod.listMyConsentsAsync(USER, { ...PG, exec, strict: true }));
  assert.deepEqual(asyncList, syncList, "列表必須逐列逐鍵相同");
  assert.equal(asyncList.length, 1);
  assert.equal((await asyncMod.listMyConsentsAsync(0, { ...PG, exec, strict: true })).length, 0, "uid 0 回空陣列");

  // idempotent：同一 (user, document_id, hash) 不寫第二列
  // ⚠️ 同步對照用 `memberConsents.recordConsent(db, …)`：`db.js` 的 `recordMemberConsent`
  // 只是原樣再匯出（沒綁 handle），照包裝的簽章呼叫會把 userId 當成 db。
  const syncAgain = plain(syncMod.recordConsent(disk, USER, input, { now: new Date(NOW) }));
  const asyncAgain = plain(await asyncMod.recordConsentAsync(USER, input, { ...PG, exec, strict: true, now: NOW }));
  assert.deepEqual(asyncAgain, syncAgain, "重複同意的回傳值必須相同");
  assert.equal(consentRows(exec.raw, USER).length, 1, "PG 上不得寫出第二列（先查再寫）");

  // 新的雜湊：要寫進去（兩邊都寫）
  // ⚠️ 同步基準與 PG 版用**不同帳號**：同意列 append-only（不能刪），同一帳號跑兩次時
  // 本機那一列其實是**同步版**寫的，於是「PG 版有沒有鏡射本機」就驗不出來
  // （變異測試抓到的）。
  const fresh = { ...input, document_id: 700002, content_hash: "hash-v2" };
  const syncFresh = plain(syncMod.recordConsent(disk, OTHER, fresh, { now: new Date(NOW) }));
  const asyncFresh = plain(await asyncMod.recordConsentAsync(USER, fresh, { ...PG, exec, strict: true, now: NOW }));
  assert.deepEqual(asyncFresh, syncFresh, "新同意的回傳值必須相同（id 之外的鍵）");
  // USER 本來就有 seed 的那一列（710001），加上新雜湊那一列 = 2。
  assert.equal(consentRows(exec.raw, USER).length, 2, "PG 上要有兩列（seed ＋ 新雜湊）");
  assert.equal(consentRows(disk, USER).length, 2, "本機也要追上（新雜湊那一列是 PG 版自己寫的）");
  assert.equal(consentRows(disk, OTHER).length, 1, "同步基準那一列在本機");

  // 錯誤形狀
  for (const [bad, why] of [[{ document_type: "test_terms" }, "缺欄位"], [{ document_id: 700001, version: 1, content_hash: "x" }, "缺類型"]]) {
    const syncErr = syncErrorShape(() => syncMod.recordConsent(disk, USER, bad, { now: new Date(NOW) }));
    const asyncErr = await errorShape(() => asyncMod.recordConsentAsync(USER, bad, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${why}）`);
  }
  const anonSync = syncErrorShape(() => syncMod.recordConsent(disk, 0, input, { now: new Date(NOW) }));
  const anonAsync = await errorShape(() => asyncMod.recordConsentAsync(0, input, { ...PG, exec, strict: true, now: NOW }));
  assert.deepEqual(anonAsync, anonSync, "未登入的錯誤形狀必須相同");
  assert.equal(anonSync?.status, 401);
});

test("待同意文件：比對 id＋雜湊，requires_reacceptance 時 legacy 同意不算數", async () => {
  const [disk, exec, { USER, OTHER }] = resetBoth((h, { USER, OTHER }) => {
    seedDoc(h, { id: 700011, type: "registration_terms", version: 2, hash: "terms-v2" });
    seedDoc(h, { id: 700012, type: "privacy_notice", version: 2, hash: "privacy-v2" });
  });
  // 沒有任何同意：兩份都要待同意，而且順序照 REGISTRATION_DOC_TYPES
  const syncPending = plain(dbMod.pendingMemberDocuments(USER, { now: new Date(NOW) }));
  const asyncPending = plain(await asyncMod.pendingRequiredDocumentsAsync(USER, { now: NOW, ...PG, exec, strict: true }));
  assert.deepEqual(asyncPending, syncPending, "待同意清單必須逐份相同（含順序）");
  assert.equal(asyncPending.length, 2, "兩份都要待同意（否則這條測試沒有鑑別力）");
  assert.deepEqual(asyncPending.map((d) => d.document_type), syncPending.map((d) => d.document_type));

  // legacy 註冊同意（users.accepted_disclaimer_at）＋ requires_reacceptance=0 → 算已同意
  for (const h of [disk, exec.raw]) {
    h.prepare("UPDATE users SET accepted_disclaimer_at = ? WHERE id = ?").run(OLD, USER);
  }
  const legacySync = plain(dbMod.pendingMemberDocuments(USER, { now: new Date(NOW) }));
  const legacyAsync = plain(await asyncMod.pendingRequiredDocumentsAsync(USER, { now: NOW, ...PG, exec, strict: true }));
  assert.deepEqual(legacyAsync, legacySync, "legacy 同意後兩個 driver 必須相同");
  assert.equal(legacyAsync.length, 0, "legacy 同意要讓兩份都不再要求（requires_reacceptance=0）");

  // ⚠️ `requires_reacceptance=1` 時，legacy 的註冊同意**不算數**——這一條要在
  // `accepted_disclaimer_at` **還在**的時候驗（先清掉 legacy 的話，有沒有這個判斷都一樣，
  // 變異就殺不死）。
  for (const h of [disk, exec.raw]) {
    h.prepare("UPDATE content_documents SET requires_reacceptance = 1 WHERE id = 700012").run();
  }
  const strictSync = plain(dbMod.pendingMemberDocuments(USER, { now: new Date(NOW) }));
  const strictAsync = plain(await asyncMod.pendingRequiredDocumentsAsync(USER, { now: NOW, ...PG, exec, strict: true }));
  assert.deepEqual(strictAsync, strictSync, "requires_reacceptance 之後兩個 driver 必須相同");
  assert.deepEqual(strictAsync.map((d) => d.document_type), ["privacy_notice"], "只有要求重新接受的那一份要回來");

  // ⚠️ 同一份文件但**舊雜湊**的同意不算數（比的是 id ＋ content_hash，不是只有 id）。
  for (const h of [disk, exec.raw]) {
    h.prepare("UPDATE users SET accepted_disclaimer_at = NULL WHERE id = ?").run(USER);
    // ⚠️ id 用 72xxxx：71xxxx 會被前面測試的自動編號用到（SQLite 的 AUTOINCREMENT 會往上跳）。
    seedConsent(h, { id: 720002, userId: USER, documentId: 700011, hash: "terms-v1-old", type: "registration_terms" });
  }
  const staleSync = plain(dbMod.pendingMemberDocuments(USER, { now: new Date(NOW) }));
  const staleAsync = plain(await asyncMod.pendingRequiredDocumentsAsync(USER, { now: NOW, ...PG, exec, strict: true }));
  assert.deepEqual(staleAsync, staleSync, "舊雜湊的同意之後兩個 driver 必須相同");
  assert.deepEqual(
    staleAsync.map((d) => d.document_type).sort(),
    ["privacy_notice", "registration_terms"],
    "舊雜湊不算已同意（terms），privacy 也仍要求重新接受",
  );
});

test("批次同意：缺件要 400、齊件要真的寫入", async () => {
  const [disk, exec, { USER, OTHER }] = resetBoth((h, { USER, OTHER }) => {
    seedDoc(h, { id: 700021, type: "registration_terms", version: 2, hash: "terms-v2" });
  });
  // 同意清單要照**目前的待同意文件**組（bootstrap 的 `privacy_notice` 也還在待同意裡，
  // 只送 terms 會被判缺件——那是正確行為，不是 bug）。
  const pendingSync = plain(dbMod.pendingMemberDocuments(USER, { now: new Date(NOW) }));
  const submitted = pendingSync.map((row) => ({ document_id: row.id, content_hash: row.content_hash }));
  // 沒帶同意清單 → 400（兩邊相同）
  const syncErr = syncErrorShape(() => dbMod.acceptPendingDocuments(USER, [], { source: "reaccept", now: new Date(NOW) }));
  const asyncErr = await errorShape(() => asyncMod.acceptPendingDocumentsAsync(USER, [], { source: "reaccept", now: NOW, ...PG, exec, strict: true }));
  assert.ok(syncErr, "同步版應該要擋下空清單");
  assert.deepEqual(asyncErr, syncErr, "缺件的錯誤形狀必須相同");

  // 帶對的那一份 → 寫入
  const maskIds = (rows) => rows.map((row) => ({ ...row, id: "«id»" }));
  const syncOk = plain(dbMod.acceptPendingDocuments(USER, submitted, { source: "reaccept", now: new Date(NOW) }));
  const syncRows = consentRows(disk, USER);
  // 不能刪同意列（append-only），所以「同步基準」跑在另一個全新的帳號上。
  const asyncOk = plain(await asyncMod.acceptPendingDocumentsAsync(USER, submitted, { source: "reaccept", now: NOW, ...PG, exec, strict: true }));
  // ⚠️ 自增 id 跨 store 一定不同（PG 夾具從 1 開始、磁碟是 7xxxxx）⇒ 比對前遮罩。
  assert.deepEqual(maskIds(asyncOk), maskIds(syncOk), "批次同意的回傳值必須相同（id 遮罩）");
  assert.deepEqual(plain(consentRows(exec.raw, USER)), plain(syncRows), "PG 上的同意列必須相同");
  assert.deepEqual(plain(consentRows(disk, USER)), plain(syncRows), "本機的同意列也要追上");
  assert.ok(consentRows(exec.raw, USER).length >= 1, "至少要有一筆同意列");
  assert.equal(consentRows(exec.raw, USER)[0].source, "reaccept");
});

test("歷史文件：自己的同意要看得到文件、別人的／不存在的回 null", async () => {
  const [disk, exec, { USER, OTHER }] = resetBoth((h, { USER, OTHER }) => {
    seedDoc(h, { id: 700031, hash: "hash-v1" });
    seedConsent(h, { id: 710031, userId: USER, documentId: 700031 });
    seedConsent(h, { id: 710032, userId: OTHER, documentId: 700031 });
  });
  const syncView = plain(dbMod.getOwnConsentDocument(USER, 710031));
  const asyncView = plain(await asyncMod.getOwnConsentDocumentAsync(USER, 710031, { ...PG, exec, strict: true }));
  assert.deepEqual(asyncView, syncView, "歷史文件必須逐鍵相同");
  assert.equal(asyncView.document_type, "test_terms");

  for (const [uid, id, why] of [[USER, 710032, "別人的同意"], [USER, 719999, "不存在"]]) {
    const syncNull = dbMod.getOwnConsentDocument(uid, id);
    const asyncNull = await asyncMod.getOwnConsentDocumentAsync(uid, id, { ...PG, exec, strict: true });
    assert.equal(syncNull, null, `同步版應該回 null（${why}）`);
    assert.strictEqual(asyncNull, null, `PG 版也必須回 null（${why}）`);
  }

  // 文件不是 published（草稿）→ null
  for (const h of [disk, exec.raw]) {
    h.prepare("UPDATE content_documents SET status = 'draft' WHERE id = 700031").run();
  }
  assert.strictEqual(await asyncMod.getOwnConsentDocumentAsync(USER, 710031, { ...PG, exec, strict: true }), null);
  assert.equal(dbMod.getOwnConsentDocument(USER, 710031), null, "同步版也要 null");
});

test("匯入確認：寫入同意 ＋ 更新匯入列，三個聲明欄位都要比對", async () => {
  const [disk, exec, { USER, OTHER }] = resetBoth((h, { USER, OTHER }) => {
    seedDoc(h, { id: 700041, type: DECLARATION_TYPE, version: 2, hash: "decl-v2" });
    h.prepare(
      `INSERT INTO listings(post_id, source_key, title, url, source, listed_by_user_id, self_status, first_seen_at, last_seen_at)
       VALUES (820001, 'self-820001', '匯入草稿', 'https://example.com/820001', 'self', ?, 'draft', ?, ?)`,
    ).run(USER, OLD, OLD);
    h.prepare(
      `INSERT INTO listing_import(id, user_id, provider, original_source_url, normalized_source_url, source_listing_id, status,
         imported_title, imported_text, listing_id, created_at, fetched_at, photo_errors, media_ids)
       VALUES (?, ?, '591', 'u', 'u', '', 'ready_for_review', '標題', '內容', 820001, ?, ?, '[]', '[]')`,
    ).run(IMPORT_ID, USER, OLD, OLD);
    // 同步基準要用**另一個帳號**的另一筆匯入：同意列是 append-only（不能刪），
    // 同一個帳號跑兩次會讓第二次直接命中已存在的同意（idempotent）而驗不到寫入。
    // 另一筆也要有自己的草稿（兩邊的 `listing` 才會都非 null，形狀才比得起來）。
    h.prepare(
      `INSERT INTO listings(post_id, source_key, title, url, source, listed_by_user_id, self_status, first_seen_at, last_seen_at)
       VALUES (820002, 'self-820002', '匯入草稿 2', 'https://example.com/820002', 'self', ?, 'draft', ?, ?)`,
    ).run(OTHER, OLD, OLD);
    h.prepare(
      `INSERT INTO listing_import(id, user_id, provider, original_source_url, normalized_source_url, source_listing_id, status,
         imported_title, imported_text, listing_id, created_at, fetched_at, photo_errors, media_ids)
       VALUES (?, ?, '591', 'u2', 'u2', '', 'ready_for_review', '標題', '內容', 820002, ?, ?, '[]', '[]')`,
    ).run(IMPORT_ID + 1, OTHER, OLD, OLD);
  });
  const current = await docsAsync.getEffectiveDocumentAsync(DECLARATION_TYPE, { now: NOW, ...PG, exec, strict: true });
  const good = { accept: true, document_id: current.id, version: current.version, content_hash: current.content_hash };
  const importOf = (h, id) => h.prepare(
    "SELECT status, terms_document_id, declaration_version, declaration_content_hash FROM listing_import WHERE id = ?",
  ).get(id);

  const syncView = plain(dbMod.confirmListingImportFor(OTHER, IMPORT_ID + 1, good));
  const syncImport = importOf(disk, IMPORT_ID + 1);
  const syncConsents = consentRows(disk, OTHER);
  const localImportBefore = plain(importOf(disk, IMPORT_ID));

  const asyncView = plain(await importsAsync.confirmListingImportAsync(USER, IMPORT_ID, good, { ...PG, exec, strict: true, now: NOW }));
  // `confirmed_at` 是「寫入當下」：同步版沒有注入點（用真的 now），PG 版用注入的 NOW
  // ⇒ 比對前遮罩，另外確認 PG 版真的是注入的那個時間。
  // ⚠️ 兩筆匯入是**不同帳號、不同草稿**（同意列 append-only，不能共用），所以源網址與
  // 巢狀 listing 天生不同。這一條驗的是「確認之後匯入列變成什麼」，所以只比對那一組鍵；
  // 公開形狀的**完整**比對由讀取那條測試與 listing-import-lifecycle 那批負責。
  const pick = (view) => ({
    status: view.status,
    imported_title: view.imported_title,
    imported_text: view.imported_text,
    terms_document_id: view.terms_document_id,
    declaration_version: view.declaration_version,
    declaration_content_hash: view.declaration_content_hash,
    live_sync: view.live_sync,
    has_listing: Boolean(view.listing),
  });
  assert.deepEqual(pick(asyncView), pick(syncView), "確認後的匯入列必須逐鍵相同");
  assert.equal(asyncView.confirmed_at, NOW, "PG 版要用注入的 now 蓋 confirmed_at");
  assert.equal(pick(asyncView).status, "confirmed");
  assert.deepEqual(plain(importOf(exec.raw, IMPORT_ID)), plain(syncImport), "PG 上的匯入列必須與同步版相同");
  // SQLite 退場 P3：原本斷言「本機的匯入列也要追上」；開閘（PG_NO_SQLITE_OPEN=1）時
  // 那句鏡射會直接拋錯（同意紀錄已進 PG，使用者卻收到失敗），現在改斷言本機那一列不得被動到。
  assert.deepEqual(plain(importOf(disk, IMPORT_ID)), localImportBefore, "本機的匯入列不得再被鏡射寫入");
  assert.deepEqual(plain(consentRows(exec.raw, USER)), plain(syncConsents), "PG 上的同意列必須與同步版相同");
  assert.equal(consentRows(exec.raw, USER)[0].source, "import", "來源必須是 import");
  assert.equal(importOf(exec.raw, IMPORT_ID).status, "confirmed");

  // 三個聲明欄位各自都要有鑑別力
  const cases = [
    [{ ...good, document_id: 999999 }, "declaration_stale", "document_id 不符"],
    [{ ...good, version: 99 }, "declaration_stale", "version 不符"],
    [{ ...good, content_hash: "old" }, "declaration_stale", "content_hash 不符"],
  ];
  for (const [input, expectedCode, why] of cases) {
    // 每一輪都把狀態改回 `ready_for_review`，否則會先被狀態守衛擋掉、驗不到聲明比對。
    exec.raw.prepare("UPDATE listing_import SET status='ready_for_review' WHERE id = ?").run(IMPORT_ID);
    const err = await errorShape(() => importsAsync.confirmListingImportAsync(USER, IMPORT_ID, input, { ...PG, exec, strict: true, now: NOW }));
    assert.equal(err?.status, 409, `必須擋下來（${why}）`);
    assert.equal(err?.code, expectedCode, `錯誤碼必須是 ${expectedCode}（${why}）`);
  }
});

test("匯入確認：狀態／同意旗標／不是自己的，錯誤形狀都要與同步版相同", async () => {
  const [disk, exec, { USER, OTHER }] = resetBoth((h, { USER, OTHER }) => {
    seedDoc(h, { id: 700051, type: DECLARATION_TYPE, version: 2, hash: "decl-v2" });
    h.prepare(
      `INSERT INTO listing_import(id, user_id, provider, original_source_url, normalized_source_url, source_listing_id, status,
         imported_title, imported_text, listing_id, created_at, fetched_at, photo_errors, media_ids)
       VALUES (?, ?, '591', 'u', 'u', '', 'draft', '標題', '內容', NULL, ?, ?, '[]', '[]')`,
    ).run(IMPORT_ID, USER, OLD, OLD);
  });
  const current = await docsAsync.getEffectiveDocumentAsync(DECLARATION_TYPE, { now: NOW, ...PG, exec, strict: true });
  const good = { accept: true, document_id: current.id, version: current.version, content_hash: current.content_hash };
  const cases = [
    { uid: USER, input: good, why: "狀態不是 ready_for_review" },
    { uid: OTHER, input: good, why: "不是自己的匯入" },
  ];
  for (const c of cases) {
    const syncErr = syncErrorShape(() => dbMod.confirmListingImportFor(c.uid, IMPORT_ID, c.input));
    const asyncErr = await errorShape(() => importsAsync.confirmListingImportAsync(c.uid, IMPORT_ID, c.input, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${c.why}）`);
  }
  // 沒勾同意旗標 → 400（狀態要先能過，所以先把狀態改成 ready_for_review）
  for (const h of [disk, exec.raw]) h.prepare("UPDATE listing_import SET status='ready_for_review' WHERE id = ?").run(IMPORT_ID);
  const noAccept = syncErrorShape(() => dbMod.confirmListingImportFor(USER, IMPORT_ID, { ...good, accept: false, accepted: false }));
  const noAcceptAsync = await errorShape(() => importsAsync.confirmListingImportAsync(USER, IMPORT_ID, { ...good, accept: false, accepted: false }, { ...PG, exec, strict: true, now: NOW }));
  assert.equal(noAccept?.status, 400, "同步版要 400");
  assert.deepEqual(noAcceptAsync, noAccept, "沒勾同意的錯誤形狀必須相同");
  // 而且不得留下任何同意紀錄
  assert.equal(consentRows(exec.raw, USER).length, 0, "沒勾同意不得寫入同意列");
});

test("非 postgres 模式必須走同步路徑（不碰傳入的 exec）", async () => {
  const [disk, exec, { USER, OTHER }] = resetBoth((h, { USER, OTHER }) => {
    seedDoc(h, { id: 700061, hash: "hash-v1" });
  });
  let touched = 0;
  const counting = async (sql, params = []) => { touched += 1; return exec(sql, params); };
  const pending = await asyncMod.pendingRequiredDocumentsAsync(USER, { now: NOW, driver: "sqlite", exec: counting });
  const recorded = await asyncMod.recordConsentAsync(USER, { document_type: "test_terms", document_id: 700061, version: 1, content_hash: "hash-v1" }, { driver: "sqlite", exec: counting, now: NOW });
  // ⚠️ 清單要在**寫入之後**才比對（第一版在寫入前就抓了 `listed`，於是永遠少一筆）。
  const listed = await asyncMod.listMyConsentsAsync(USER, { driver: "sqlite", exec: counting });
  assert.equal(touched, 0, "SQLite 模式不得碰 PG runner");
  assert.deepEqual(plain(listed), plain(dbMod.listMyConsents(USER)));
  assert.deepEqual(plain(pending), plain(dbMod.pendingMemberDocuments(USER, { now: new Date(NOW) })));
  assert.equal(recorded.content_hash, "hash-v1");
  assert.equal(consentRows(disk, USER).length, 1, "要走同步路徑寫本機");
  assert.equal(consentRows(exec.raw, USER).length, 0, "不得寫 PG 夾具");
});
