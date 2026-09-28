// 匯入清單（`GET /api/listing-imports`、`GET /api/admin/listing-imports`）PG 分支的 parity
// （2026-09-28，第四十五批）。
//
// 兩條都只是**一句 SELECT**（後台那句多一個 `LEFT JOIN users` 取會員 email），所以要釘住的是
// 「列 → 物件的轉換」與「上限夾法」這兩件**共用政策**，以及兩個 driver 的順序一致：
//
//   1. `rowToImport()` 的寬容度（`listing_id == null`、`photo_errors`／`media_ids` 的 JSON、
//      缺欄位時的空字串）——PG 回來的型別與 SQLite 不同（例如 bigint 是字串），
//      轉換共用一份才不會「同一筆資料兩個 driver 長得不一樣」。
//   2. `importListLimit()` 的上限（會員 50、後台 200）：**共用政策的變異 parity 抓不到**
//      （兩邊一起被改壞），所以除了比對兩個 driver，還要對值本身下斷言。
//   3. 順序：`ORDER BY id DESC`，而且會員清單只看得到自己的。
//   4. 後台的 `member_email`：`LEFT JOIN` 之後查不到使用者時要是空字串，不是 undefined。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-imports-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/listingImport.js");
const asyncMod = await import("../src/listingImportAsync.js");
const dbMod = await import("../src/db.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const OLD = "2026-01-01T00:00:00.000Z";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
];

const TABLES = ["users", "listing_import"];

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

function clearWorld(h) {
  h.prepare("DELETE FROM listing_import").run();
  h.prepare("DELETE FROM users WHERE email LIKE 'imp%@example.com'").run();
}

// ⚠️ 刻意**不用 user 1**：它是 `db.js` 開檔時建的 bootstrap 管理員，在磁碟上已經被
// 其他表（`user_settings` 等）以 FK 引用，而且兩個 store 的 email 不一樣
// （磁碟是 `admin@local`、PG 夾具是空的），改它只會製造兩種假紅。
// 用 71／72 這種「一定不存在」的 id，兩個 store 就都只有我們種的那一列。
const USER_A = 71;
const USER_B = 72;

function seedUsers(h) {
  for (const id of [USER_A, USER_B]) {
    h.prepare(
      "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'free', ?)",
    ).run(id, `imp${id}@example.com`, `會員${id}`, OLD);
  }
}

// `rowToImport()` 的每一個「要小心的地方」都放一筆進來：JSON 欄位、null 的 listing_id、
// 缺欄位（用空字串）、以及一個**沒有對應使用者**的 user_id（測 LEFT JOIN 的空值）。
function seedImport(h, { id, userId, status = "draft", listingId = null, photoErrors = [], mediaIds = [] }) {
  h.prepare(
    `INSERT INTO listing_import(id, user_id, provider, original_source_url, normalized_source_url, source_listing_id,
       status, imported_title, imported_text, listing_id, terms_document_id, declaration_version,
       declaration_content_hash, created_at, fetched_at, confirmed_at, failure_code, failure_reason, photo_errors, media_ids)
     VALUES (?, ?, '591', ?, ?, '', ?, ?, '', ?, NULL, NULL, '', ?, ?, NULL, '', '', ?, ?)`,
  ).run(
    id, userId, `https://example.com/${id}`, `https://example.com/${id}`, status,
    `匯入 ${id}`, listingId, OLD, OLD, JSON.stringify(photoErrors), JSON.stringify(mediaIds),
  );
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

const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------

test("會員清單：只看到自己的、順序由新到舊、列的形狀與同步版相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedImport(h, { id: 101, userId: USER_A, status: "draft" });
    seedImport(h, { id: 102, userId: USER_A, status: "confirmed", listingId: 9001, photoErrors: ["photo 1 失敗"], mediaIds: [7, 8] });
    seedImport(h, { id: 103, userId: USER_B, status: "draft" });
    seedImport(h, { id: 104, userId: USER_B, status: "cancelled" });
  });
  const syncRows = plain(syncMod.listMineListingImports(disk, USER_A));
  const asyncRows = plain(await asyncMod.listMineListingImportsAsync(USER_A, {}, { ...PG, exec, strict: true }));

  assert.deepEqual(asyncRows, syncRows, "清單必須逐列逐鍵相同");
  assert.deepEqual(asyncRows.map((row) => row.id), [102, 101], "只有自己的，而且新到舊（否則這條測試沒有鑑別力）");
  const confirmed = asyncRows.find((row) => row.id === 102);
  assert.equal(confirmed.listing_id, 9001, "listing_id 要是數字");
  assert.deepEqual(confirmed.photo_errors, ["photo 1 失敗"], "photo_errors 要從 JSON 還原");
  assert.deepEqual(confirmed.media_ids, [7, 8], "media_ids 要從 JSON 還原");
  assert.equal(asyncRows.find((row) => row.id === 101).listing_id, null, "沒有關聯刊登時要是 null（不是 undefined）");
  assert.equal(typeof asyncRows[0].user_id, "number");
});

test("後台清單：member_email 由 LEFT JOIN 來，查不到使用者時是空字串", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedImport(h, { id: 201, userId: USER_A });
    seedImport(h, { id: 202, userId: USER_B, status: "confirmed" });
    // 沒有對應使用者的那一筆（模擬帳號已被刪除）
    seedImport(h, { id: 203, userId: 999 });
  });
  const syncRows = plain(syncMod.listAdminListingImports(disk));
  const asyncRows = plain(await asyncMod.listAdminListingImportsAsync({}, { ...PG, exec, strict: true }));

  assert.deepEqual(asyncRows, syncRows, "後台清單必須逐列逐鍵相同");
  assert.deepEqual(asyncRows.map((row) => row.id), [203, 202, 201], "新到舊、而且看得到所有人的");
  assert.equal(asyncRows.find((row) => row.id === 201).member_email, `imp${USER_A}@example.com`);
  assert.equal(asyncRows.find((row) => row.id === 203).member_email, "", "LEFT JOIN 查不到時要是空字串");
});

test("上限是共用政策：會員 50、後台 200，而且兩個 driver 都吃同一組值", () => {
  // ⚠️ 這是**共用政策**，parity 比對抓不到「兩邊一起被改壞」，所以直接對值下斷言。
  assert.equal(syncMod.importListLimit(1000, { cap: 50, fallback: 20 }), 50, "會員清單上限 50");
  assert.equal(syncMod.importListLimit(1000, { cap: 200, fallback: 50 }), 200, "後台清單上限 200");
  assert.equal(syncMod.importListLimit(0, { cap: 50, fallback: 20 }), 20, "limit 0 用預設 20");
  assert.equal(syncMod.importListLimit(undefined, { cap: 200, fallback: 50 }), 50, "沒給 limit 用預設 50");
  assert.equal(syncMod.importListLimit("30", { cap: 50, fallback: 20 }), 30, "字串也要能解析");
});

test("上限真的生效：超過上限時只回上限那麼多列", async () => {
  const [disk, exec] = resetBoth((h) => {
    for (let i = 0; i < 6; i += 1) seedImport(h, { id: 300 + i, userId: USER_A });
  });
  const mine = plain(await asyncMod.listMineListingImportsAsync(USER_A, { limit: 3 }, { ...PG, exec, strict: true }));
  assert.equal(mine.length, 3, "limit 3 就只回 3 列");
  assert.deepEqual(mine.map((row) => row.id), [305, 304, 303], "取的是最新的三列");
  const admin = plain(await asyncMod.listAdminListingImportsAsync({ limit: 2 }, { ...PG, exec, strict: true }));
  assert.equal(admin.length, 2);
  // 超過上限的請求要被夾住（不是原封不動送進 SQL）
  const clamped = plain(await asyncMod.listAdminListingImportsAsync({ limit: 9999 }, { ...PG, exec, strict: true }));
  assert.equal(clamped.length, 6, "被夾到 200，所以六列都回得來");
  assert.deepEqual(plain(syncMod.listAdminListingImports(disk, { limit: 9999 })), clamped, "同步版也要相同");
});

test("非 postgres 模式必須走同步路徑（不碰傳入的 exec）", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedImport(h, { id: 401, userId: USER_A });
    seedImport(h, { id: 402, userId: USER_B });
  });
  let touched = 0;
  const counting = async (sql, params = []) => { touched += 1; return exec(sql, params); };
  const mine = plain(await asyncMod.listMineListingImportsAsync(USER_A, {}, { driver: "sqlite", exec: counting }));
  const admin = plain(await asyncMod.listAdminListingImportsAsync({}, { driver: "sqlite", exec: counting }));
  assert.equal(touched, 0, "SQLite 模式不得碰 PG runner");
  assert.deepEqual(mine, plain(syncMod.listMineListingImports(disk, USER_A)));
  assert.deepEqual(admin, plain(syncMod.listAdminListingImports(disk)));
});
