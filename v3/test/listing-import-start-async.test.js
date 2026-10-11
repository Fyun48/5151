// 建立匯入（`POST /api/listing-imports`）PG 分支的 parity（2026-09-29，第八十六批）。
//
// 為什麼這一包重要：同步版 `startListingImport()`（`db.js:startListingImportFor()`）把**匯入列與
// 匯入草稿**都寫進節點本機 ⇒ PG 模式下別的節點看不到這筆匯入、`GET /api/listing-imports/:id`
// 的 `listing` 永遠是 null、確認後的公開也找不到草稿。
//
// 這一包釘住六件事：
//
//   1. **匯入列與草稿都落在 PG**：`listing_import` 一列（`ready_for_review`）＋ `listings` 一列
//      （`source='self'`／`self_status='draft'`／`source_id='import:{uid}:{postId}'`）。
//   2. **`publicImport()` 的形狀**：20 個鍵共用 `publicImportShape()`，`listing`／`photos`
//      由 `getSelfListingAsync()` 補上（同步版是 `safeListing()`）。
//   3. **同來源重複匯入回同一筆**（`reused: true`），PG 不得長出第二列。
//   4. **贊助條件在寫入之前**：非贊助會員 403，PG 不留任何列。
//   5. **失敗會落地**：抓取被擋 → `FETCH_BLOCKED`、解析不出內容 → `PARSE_FAILED`，
//      而且錯誤照樣往上丟（route 靠它回 400）。
//   6. **寫入 fail-closed**：PG 連線失敗時**不得**回退本機（否則「匯入看起來成功、站上沒有」）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-impstart-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const asyncMod = await import("../src/listingImportAsync.js");
const dbMod = await import("../src/db.js");

const dir = path.dirname(fileURLToPath(import.meta.url));
const readFix = (name) => readFileSync(path.join(dir, "fixtures", name), "utf8");
const SRC = path.join(dir, "../src");
const handle = () => dbMod.sqliteHandle();
const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const NOW = "2026-09-29T00:00:00.000Z";
const URL_591 = "https://rent.591.com.tw/15801234";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\bAUTOINCREMENT\b/i, "syntax error at or near \"AUTOINCREMENT\""],
];

const TABLES = ["users", "listings", "listing_import", "member_media", "media_tags", "media_tag_map"];

/** PG 替身：借本機的 DDL 建一張記憶體庫，把 PG 的 SQL 直接跑在它上面（順便擋 PG 不接受的方言）。 */
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

const USER = 86;
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd8]), Buffer.alloc(32, 7)]);
const fakeProcessor = async (buf) => ({
  format: "jpg",
  mime: "image/jpeg",
  digest: "d" + (buf?.length || 0),
  main: { buffer: Buffer.from("main-bytes"), width: 800, height: 600, bytes: 10 },
  thumb: { buffer: Buffer.from("thumb"), bytes: 5 },
});

function mockFetch(pages, images = {}) {
  return async (url) => {
    const href = String(url);
    if (pages[href]) {
      const body = Buffer.from(pages[href].text || "", "utf8");
      return { status: pages[href].status || 200, headers: { get: () => null }, arrayBuffer: async () => body };
    }
    if (images[href]) return { status: 200, headers: { get: () => null }, arrayBuffer: async () => images[href] };
    return { status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.from("not found") };
  };
}

const publicLookup = () => async () => [{ address: "203.0.113.10", family: 4 }];

// ⚠️ 用 `user_id` 清，不要用 id 範圍：本機鏡射寫的是 **PG 替身配到的 id**（從 1 起算），
// 用 `id >= 860000` 會清不到，測試之間會互相污染（實測踩過）。
function clearWorld(h) {
  h.prepare("DELETE FROM listing_import WHERE user_id = ?").run(USER);
  h.prepare("DELETE FROM listings WHERE listed_by_user_id = ?").run(USER);
  h.prepare("DELETE FROM member_media WHERE user_id = ?").run(USER);
  h.prepare("DELETE FROM media_tags WHERE user_id = ?").run(USER);
  h.prepare("DELETE FROM users WHERE id = ?").run(USER);
}

function seedUser(h, { plan = "sponsor", role = "member" } = {}) {
  h.prepare("INSERT INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(USER, `impstart${USER}@example.com`, "匯入會員", role, plan, NOW);
}

/** 每個測試都自己一組「本機 ＋ PG 替身」，兩邊的世界一致。 */
function resetBoth({ plan = "sponsor", role = "member" } = {}) {
  const disk = handle();
  clearWorld(disk);
  seedUser(disk, { plan, role });
  const exec = pgFixture();
  clearWorld(exec.raw);
  seedUser(exec.raw, { plan, role });
  return exec;
}

const startArgs = (extra = {}) => ({
  plan: extra.plan || "sponsor",
  role: extra.role || "member",
  now: new Date(NOW),
  processor: extra.processor === null ? undefined : fakeProcessor,
  lookupImpl: publicLookup(),
  fetchImpl: extra.fetchImpl || mockFetch(
    { [URL_591]: { text: extra.html ?? readFix("import-591-public.html"), status: extra.status || 200 } },
    {
      "https://img1.591.com.tw/house/demo-a.jpg": jpeg(),
      "https://img2.591.com.tw/house/demo-b.jpg": jpeg(),
    },
  ),
});

const plain = (value) => JSON.parse(JSON.stringify(value));

async function errorShape(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return { status: error.status || 0, code: error.code || "", message: error.message };
  }
}

const pgImports = (exec) => exec.raw.prepare("SELECT * FROM listing_import WHERE user_id = ? ORDER BY id").all(USER);
const pgDrafts = (exec) => exec.raw.prepare("SELECT * FROM listings WHERE listed_by_user_id = ? ORDER BY post_id").all(USER);
const localImports = () => handle().prepare("SELECT * FROM listing_import WHERE user_id = ? ORDER BY id").all(USER);

test("PG 分支：591 匯入建立 ready_for_review 的草稿，而且匯入列與草稿都落在 PG", async () => {
  const exec = resetBoth();
  const row = plain(await asyncMod.startListingImportAsync(USER, { url: URL_591 }, { ...PG, exec, ...startArgs() }));

  assert.equal(row.status, "ready_for_review");
  assert.equal(row.reused, false);
  assert.equal(row.live_sync, false, "外部匯入一律不即時同步");
  assert.match(row.imported_title, /設計師|裝潢|捷運|房/);
  assert.ok(String(row.imported_text || "").length > 0, "說明要有內容");

  const imports = pgImports(exec);
  assert.equal(imports.length, 1, "PG 只能有一筆匯入列");
  assert.equal(imports[0].status, "ready_for_review");
  assert.equal(imports[0].user_id, USER);
  assert.equal(imports[0].provider, "591");
  assert.equal(imports[0].normalized_source_url, "https://rent.591.com.tw/15801234");

  const drafts = pgDrafts(exec);
  assert.equal(drafts.length, 1, "草稿要落在 PG");
  assert.equal(drafts[0].source, "self");
  assert.equal(drafts[0].self_status, "draft");
  assert.equal(drafts[0].source_id, `import:${USER}:${drafts[0].post_id}`);
  assert.equal(Number(imports[0].listing_id), Number(drafts[0].post_id), "匯入列要指向那筆草稿");
  const mediaIds = JSON.parse(imports[0].media_ids || "[]");
  assert.ok(mediaIds.length >= 1, "照片要存進 PG 的會員素材庫");
  assert.equal(JSON.parse(drafts[0].self_photos).length, mediaIds.length, "草稿的照片與 media_ids 一致");
  assert.equal(row.listing.post_id, Number(drafts[0].post_id), "回傳的 listing 要是 PG 那一列");
  assert.deepEqual(row.photos, JSON.parse(drafts[0].self_photos));

  // 本機鏡射：`listing_import` 那一列還是（屬另一包的收斂）；
  // 🚫 但**草稿列**（`listings`）的本機鏡射已隨 SQLite 退場 P5a
  // （`selfListingsAsync.insertImportedDraftListingAsync()`）刪除 ⇒ 本機不得有那一列
  //（原本的斷言是「本機也要有鏡射列」＝ 1）。
  assert.equal(localImports().length, 1, "本機也要有鏡射列（listing_import 那一列）");
  assert.equal(
    handle().prepare("SELECT COUNT(*) AS n FROM listings WHERE listed_by_user_id = ?").get(USER).n, 0,
    "草稿不得再鏡射到本機（PG 是唯一來源）",
  );
});

test("同來源重複匯入回同一筆（reused），PG 不長第二列", async () => {
  const exec = resetBoth();
  const first = plain(await asyncMod.startListingImportAsync(USER, { url: URL_591 }, { ...PG, exec, ...startArgs() }));
  const again = plain(await asyncMod.startListingImportAsync(USER, { url: URL_591 }, { ...PG, exec, ...startArgs() }));

  assert.equal(again.id, first.id);
  assert.equal(again.reused, true);
  assert.equal(pgImports(exec).length, 1, "進行中的匯入不得再建一列");
  assert.equal(pgDrafts(exec).length, 1, "也不得再建草稿");
  assert.equal(localImports().length, 1);
});

test("非贊助會員 403，PG 不留下任何匯入列（贊助條件在寫入之前）", async () => {
  const exec = resetBoth({ plan: "free" });
  const err = await errorShape(() => asyncMod.startListingImportAsync(USER, { url: URL_591 }, { ...PG, exec, ...startArgs({ plan: "free" }) }));
  assert.equal(err?.status, 403);
  assert.equal(err?.code, "sponsor_required");
  assert.equal(pgImports(exec).length, 0);
  assert.equal(localImports().length, 0);
});

test("抓取被擋 → 匯入列落 failed（SOURCE_UNAVAILABLE）且錯誤往上丟", async () => {
  const exec = resetBoth();
  const err = await errorShape(() => asyncMod.startListingImportAsync(USER, { url: URL_591 },
    { ...PG, exec, ...startArgs({ status: 403 }) }));
  assert.ok(err, "必須往外丟");
  const imports = pgImports(exec);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].status, "failed");
  assert.equal(imports[0].failure_code, err.code, "落地的 failure_code 要是抓取層丟出來的碼");
  assert.equal(err.code, "SOURCE_UNAVAILABLE", "591 回 403 時的碼（與同步版同一支 fetchParsedListing）");
  assert.equal(pgDrafts(exec).length, 0, "抓不到就不該有草稿");
});

// ⚠️ 這一條走的是**解析層**的 `PARSE_FAILED`（`import591.js` 在標題與說明都空時就丟）。
// 島嶼裡那一行「標題與說明都空」是與同步版對稱的防守性重複，目前兩個 provider 都到不了
// ⇒ 變異清單把對應那一條記為等價變異（見 `IMPORTSTART_MUTATIONS` 的註解）。
test("解析不出標題與說明 → PARSE_FAILED 落 failed", async () => {
  const exec = resetBoth();
  const err = await errorShape(() => asyncMod.startListingImportAsync(USER, { url: URL_591 },
    { ...PG, exec, ...startArgs({ html: "<html><body><div>nothing</div></body></html>" }) }));
  assert.equal(err?.status, 400);
  assert.equal(err?.code, "PARSE_FAILED");
  const imports = pgImports(exec);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].status, "failed");
  assert.equal(imports[0].failure_code, "PARSE_FAILED");
});

test("寫入 fail-closed：PG 連線失敗不得回退本機（匯入看起來成功、站上沒有）", async () => {
  const exec = resetBoth();
  const boom = async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); };
  await assert.rejects(
    () => asyncMod.startListingImportAsync(USER, { url: URL_591 }, { ...PG, exec: boom, ...startArgs() }),
    /ECONNREFUSED/, "strict 時要往上丟",
  );
  await assert.rejects(
    () => asyncMod.startListingImportAsync(USER, { url: URL_591 }, { driver: "postgres", exec: boom, ...startArgs() }),
    /ECONNREFUSED/, "預設模式（寫入）也不得回退本機",
  );
  void exec;
  assert.equal(localImports().length, 0, "不得在本機留下匯入列");
  assert.equal(handle().prepare("SELECT COUNT(*) AS n FROM listings WHERE listed_by_user_id = ?").get(USER).n, 0);
});

test("路由接線：建立匯入走 PG 島嶼（而且島嶼真的有 import）", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const start = server.indexOf('app.post("/api/listing-imports",');
  assert.ok(start > 0, "找得到建立匯入路由");
  const body = server.slice(start, server.indexOf('app.get("/api/listing-imports/:id"', start));
  assert.ok(body.includes("await startListingImportAsync(session.userId, req.body || {}, { plan: session.plan || \"free\", role: session.role || \"\" })"),
    "要用島嶼版");
  assert.ok(!body.includes("startListingImportFor("), "不得再用同步的 startListingImportFor");
  // ⚠️ `lastIndexOf`：這個模組有兩處 import（單行的 `publishConfirmedImportAsync` 在前面），
  // 用 `indexOf` 會切到那一行前面的區塊，斷言會永遠找不到名字。
  const close = server.lastIndexOf('} from "./listingImportAsync.js";');
  const importBlock = server.slice(Math.max(0, close - 400), close);
  assert.ok(importBlock.includes("startListingImportAsync"), "startListingImportAsync 必須真的被 import");
  assert.ok(!server.includes("  startListingImportFor,\n"), "同步的 startListingImportFor 不該再被 import");
});
