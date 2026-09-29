// 建立匯入（`POST /api/listing-imports`）的 **live PG** 驗證（2026-09-29，第八十六批）。
//
// 離線 parity 用的是「借本機 DDL 建的記憶體 PG 替身」，它證明不了四件事：
//
//   1. **匯入列真的寫進 PG**：`INSERT ... RETURNING id` 在真 PG 上要回得出 id
//      （同步版靠 `lastInsertRowid`，PG 沒有那個東西）。
//   2. **草稿列真的寫進 PG**：`listings` 的 `source_key`／`source_id`／`self_status='draft'`、
//      `self_photos` 與 `cover`（照片 URL 來自 PG 素材庫）。
//   3. **照片真的存進 PG 的會員素材庫**：`member_media` 有對應的 storage_key，
//      而且草稿的 `self_photos` 與之對得上（同步版存本機 ⇒ 別的節點看不到那張照片）。
//   4. **本機沒有被寫**：PG 模式下這一列不該出現在節點本機（跨店錯位的來源）。
//
// ⚠️ 安全設計照抄 `member-consents-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-impstart-live-"));
process.env.DATA_DIR = dataDir;

const dir = path.dirname(fileURLToPath(import.meta.url));
const readFix = (name) => readFileSync(path.join(dir, "fixtures", name), "utf8");
const STAMP = "2026-01-01T00:00:00.000Z";
const URL_591 = "https://rent.591.com.tw/15801234";
const MARK = `livetest-impstart-${Date.now()}`;

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd8]), Buffer.alloc(32, 7)]);
const fakeProcessor = async () => ({
  format: "jpg",
  mime: "image/jpeg",
  digest: "live" + Math.random().toString(16).slice(2),
  main: { buffer: Buffer.from("main-bytes"), width: 800, height: 600, bytes: 10 },
  thumb: { buffer: Buffer.from("thumb"), bytes: 5 },
});

function mockFetch(pages, images = {}) {
  return async (url) => {
    const href = String(url);
    if (pages[href]) {
      const body = Buffer.from(pages[href].text || "", "utf8");
      return { status: 200, headers: { get: () => null }, arrayBuffer: async () => body };
    }
    if (images[href]) return { status: 200, headers: { get: () => null }, arrayBuffer: async () => images[href] };
    return { status: 404, headers: { get: () => null }, arrayBuffer: async () => Buffer.from("not found") };
  };
}

test("live PG：匯入列與草稿都落在 PG（本機鏡射跟上），照片進 PG 素材庫", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const asyncMod = await import("../src/listingImportAsync.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  const opts = { driver: "postgres", pgDriver, exec, strict: true };
  const local = dbMod.sqliteHandle();
  let userId = 0;

  t.after(async () => {
    if (userId) {
      try { await query("DELETE FROM member_media WHERE user_id = $1", [userId]); } catch { /* 盡力而為 */ }
      try { await query("DELETE FROM listings WHERE listed_by_user_id = $1", [userId]); } catch { /* 盡力而為 */ }
      try { await query("DELETE FROM listing_import WHERE user_id = $1", [userId]); } catch { /* 盡力而為 */ }
      try { await query("DELETE FROM users WHERE id = $1", [userId]); } catch { /* 盡力而為 */ }
    }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  const email = `${MARK}@example.test`;
  assert.equal(dbMod.findUserByEmail(email), null, "前提：本機 SQLite 不該有這個帳號");
  await query("SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM users), 1))");
  userId = Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'PG 匯入會員','member','sponsor',$2) RETURNING id",
    [email, STAMP],
  ))[0].id);

  const row = await asyncMod.startListingImportAsync(userId, { url: URL_591 }, {
    ...opts,
    plan: "sponsor",
    role: "member",
    now: new Date(STAMP),
    processor: fakeProcessor,
    lookupImpl: async () => [{ address: "203.0.113.10", family: 4 }],
    fetchImpl: mockFetch({ [URL_591]: { text: readFix("import-591-public.html") } }, {
      "https://img1.591.com.tw/house/demo-a.jpg": jpeg(),
      "https://img2.591.com.tw/house/demo-b.jpg": jpeg(),
    }),
  });

  assert.equal(row.status, "ready_for_review");
  const imports = await query("SELECT * FROM listing_import WHERE user_id = $1", [userId]);
  assert.equal(imports.length, 1, "PG 要有一筆匯入列");
  assert.equal(imports[0].provider, "591");
  assert.equal(imports[0].normalized_source_url, URL_591);
  assert.ok(Number(imports[0].listing_id) > 0, "匯入列要指向草稿");

  const drafts = await query("SELECT * FROM listings WHERE listed_by_user_id = $1", [userId]);
  assert.equal(drafts.length, 1, "草稿要落在 PG");
  assert.equal(drafts[0].source, "self");
  assert.equal(drafts[0].self_status, "draft");
  assert.equal(drafts[0].source_id, `import:${userId}:${drafts[0].post_id}`);
  assert.equal(Number(imports[0].listing_id), Number(drafts[0].post_id));

  const mediaIds = JSON.parse(imports[0].media_ids || "[]");
  assert.ok(mediaIds.length >= 1, "照片要匯入 PG 素材庫");
  const media = await query("SELECT id, storage_key FROM member_media WHERE user_id = $1", [userId]);
  assert.equal(media.length, mediaIds.length, "member_media 的列數要與 media_ids 一致");
  const photos = JSON.parse(drafts[0].self_photos || "[]");
  assert.equal(photos.length, media.length);
  const keys = new Set(media.map((m) => String(m.storage_key)));
  for (const url of photos) assert.ok([...keys].some((k) => String(url).includes(k)), `照片 URL 要指向 PG 的 storage_key：${url}`);
  assert.equal(row.listing.post_id, Number(drafts[0].post_id), "回傳的 listing 要是 PG 那一列");

  // 本機鏡射（與第四十七／四十八／八十三批同一個紀律）：PG 是權威，本機那一份是給
  // 「還沒搬完的同步讀者」看的，失敗不影響結果——所以這裡驗它**有**跟上，而不是沒有寫。
  const mirrored = local.prepare("SELECT id, status FROM listing_import WHERE user_id = ?").get(userId);
  assert.ok(mirrored, "本機要有鏡射列");
  assert.equal(Number(mirrored.id), Number(imports[0].id), "鏡射要用 PG 配到的 id");
  assert.equal(mirrored.status, "ready_for_review");
});
