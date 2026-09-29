// 複製站內刊登（`POST /api/self-listings/:id/copy`）PG 島嶼的 parity（2026-09-29，第八十二批）。
//
// 同步版整條讀寫節點本機：來源列（`listings`）、冪等表（`listing_copy_idempotency`）、
// **素材所有權**（`member_media`）與新草稿列。PG 模式下刊登與素材都在 PG ⇒
//
//   - 別的節點建立的刊登**複製不到**（404）；
//   - 複製出來的草稿落在這台節點，別的節點看不到；
//   - 素材所有權會誤判成「不是自己的」⇒ 照片整批被丟掉（`reusableCopyPhotos()`）。
//
// 這一包釘住：兩個 driver 的複製結果（草稿列 ＋ 回傳的表單）逐欄位相同、**列／素材只放在 PG 時
// PG 版照樣複製得出來**、冪等鍵重用、403／404 錯誤形狀，以及路由接線。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-copy82-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

const dbMod = await import("../src/db.js");
const selfAsync = await import("../src/selfListingsAsync.js");
const selfListings = await import("../src/selfListings.js");
const listingTools = await import("../src/listingTools.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const diskPath = () => path.join(dataDir, "v3.db");
const OWNER = 820001;
const OTHER = 820002;
const DISTRICT = "1-2";
const STAMP = "2026-01-01T00:00:00.000Z";
const MEDIA_KEY = `${"a".repeat(32)}.jpg`;
const MEDIA_URL = `/media/lib/${MEDIA_KEY}`;
const FOREIGN_KEY = `${"b".repeat(32)}.jpg`;

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\bAUTOINCREMENT\b/i, "syntax error at or near \"AUTOINCREMENT\""],
];
const TABLES = ["users", "settings", "user_settings", "listings", "member_media", "listing_copy_idempotency"];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const row = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.ok(row?.sql, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(row.sql);
  }
  for (const t of TABLES) {
    const cols = disk.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const rows = disk.prepare(`SELECT * FROM ${t}`).all();
    if (!rows.length) continue;
    const insert = mem.prepare(`INSERT INTO ${t}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const row of rows) insert.run(...cols.map((c) => row[c]));
  }
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    try {
      return mem.prepare(sql).all(...params);
    } catch (error) {
      throw new Error(`夾具無法執行這句 SQL：${error.message}\n${sql}`);
    }
  };
  exec.raw = mem;
  return exec;
}

const errorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, code: error.code || "", message: error.message }; }
};
const syncErrorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, code: error.code || "", message: error.message }; }
};
const plain = (value) => JSON.parse(JSON.stringify(value));
// 兩個 driver 的 `post_id` 由各自的序列決定 ⇒ 比對時投影掉「編號」與「網址」（都含編號）。
const shapeOf = (result) => ({
  original_id: Number(result.original_id),
  unpublished: result.unpublished,
  copied: result.copied,
  inherited_import: result.inherited_import,
  reused: result.reused === true,
  title: result.listing?.title,
  self_status: result.listing?.self_status,
  self_body: result.listing?.self_body,
  self_photos: result.listing?.self_photos,
  form_title: result.form?.title,
  form_body: result.form?.body,
  form_photos: result.form?.photos,
  form_rent: Number(result.form?.rent) || 0,
  form_floor: result.form?.floor_name,
  form_kind: result.form?.kind_name,
});

/** 屋主 ＋ 一則已公開的站內刊登（含一張自己的素材照片）。 */
function seedWorld() {
  const h = handle();
  h.prepare("DELETE FROM listings WHERE COALESCE(source, '591') = 'self'").run();
  h.prepare("DELETE FROM listing_copy_idempotency").run();
  h.prepare("DELETE FROM member_media").run();
  for (const uid of [OWNER, OTHER]) {
    h.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
      .run(uid, `c${uid}@example.test`, `會員${uid}`, STAMP);
  }
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true } });
  const listing = selfListings.createSelfListing(h, OWNER, {
    district: DISTRICT, street: "民生西路 100 號", rent: 28000, ping: "25", accept_pledge: true,
    body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
    floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
    title: "複製來源刊登", kind: "apartment", role: "owner", contact_name: "測試屋主",
  }, new Date(), { maturity: true });
  // 自己的素材 ＋ 別人的素材各一張（都指向同一個 storage_key 風格）
  const media = (uid, key) => h.prepare(
    "INSERT INTO member_media(user_id, storage_key, mime, format, created_at, deleted_at) VALUES (?,?,?,?,?,NULL)",
  ).run(uid, key, "image/jpeg", "jpg", STAMP);
  media(OWNER, MEDIA_KEY);
  media(OTHER, FOREIGN_KEY);
  h.prepare("UPDATE listings SET self_photos = ?, cover = ? WHERE post_id = ?")
    .run(JSON.stringify([MEDIA_URL, `/media/lib/${FOREIGN_KEY}`]), MEDIA_URL, listing.post_id);
  return { postId: Number(listing.post_id) };
}

test("複製：PG 版與同步版的草稿與回傳表單逐欄位相同", async () => {
  const { postId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  const sync = plain(listingTools.copyOwnListing(handle(), OWNER, postId, {}));
  const async_ = plain(await selfAsync.copyOwnListingAsync(OWNER, postId, {}, opts));
  assert.deepEqual(shapeOf(async_), shapeOf(sync), "複製結果必須逐欄位相同");
  // ⚠️ `getSelfListing()` 回的是**裝飾過的視圖**（欄位名與原始列不同）⇒ 用實際存在的鍵斷言。
  assert.ok(async_.listing.post_id, "要有草稿編號");
  assert.equal(
    exec.raw.prepare("SELECT self_status FROM listings WHERE post_id = ?").get(async_.listing.post_id).self_status, "draft",
    "PG 上的草稿狀態要是 draft",
  );
  assert.equal(async_.unpublished, true);
  // 素材所有權：自己的留著、別人的丟掉（兩個 driver 都一樣）
  assert.deepEqual(async_.form.photos, [MEDIA_URL], `只保留自己的素材（實際 ${JSON.stringify(async_.form.photos)}）`);
  assert.deepEqual(async_.form.photos, sync.form.photos);
  // 草稿確實落在 PG（`source='self'` ＋ `self_status='draft'`）
  const draft = exec.raw.prepare(
    "SELECT * FROM listings WHERE listed_by_user_id = ? AND self_status = 'draft' ORDER BY post_id DESC LIMIT 1",
  ).get(OWNER);
  assert.ok(draft, "PG 上要有草稿列");
  assert.equal(draft.title, async_.listing.title);
});

test("列／素材只放在 PG 時：同步版複製不到，PG 版照樣複製得出來", async () => {
  const { postId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  const before = plain(await selfAsync.copyOwnListingAsync(OWNER, postId, {}, opts));
  // 把來源列從本機刪掉（模擬「刊登是別的節點建立的」）
  handle().prepare("DELETE FROM listings WHERE post_id = ?").run(postId);
  assert.equal(syncErrorShape(() => listingTools.copyOwnListing(handle(), OWNER, postId, {}))?.status, 404,
    "前提：同步版讀本機 ⇒ 找不到來源");
  const after = plain(await selfAsync.copyOwnListingAsync(OWNER, postId, {}, opts));
  assert.deepEqual(shapeOf(after), { ...shapeOf(before), reused: false }, "PG 版必須不受本機有沒有來源影響");

  // 素材所有權也只看 PG：把本機的素材列刪掉，PG 版仍然保留照片
  const exec2 = pgFixture();   // 重新取一份（此時本機已無來源列，改直接驗素材）
  void exec2;
  handle().prepare("DELETE FROM member_media").run();
  const pgOnlyMedia = plain(await selfAsync.copyOwnListingAsync(OWNER, postId, {}, opts));
  assert.deepEqual(pgOnlyMedia.form.photos, [MEDIA_URL], "素材所有權必須讀 PG（本機沒有也留得住）");
});

test("冪等鍵：第二次複製回同一份草稿（兩個 driver 一致）", async () => {
  const { postId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  const first = plain(await selfAsync.copyOwnListingAsync(OWNER, postId, { idempotency_key: "copy-key-1" }, opts));
  const again = plain(await selfAsync.copyOwnListingAsync(OWNER, postId, { idempotency_key: "copy-key-1" }, opts));
  assert.equal(again.reused, true, "第二次要標記 reused");
  assert.equal(Number(again.listing.post_id), Number(first.listing.post_id), "要回同一份草稿");
  assert.equal(
    exec.raw.prepare("SELECT COUNT(*) AS n FROM listings WHERE listed_by_user_id = ? AND self_status = 'draft'").get(OWNER).n,
    1,
    "PG 上不得多出第二份草稿",
  );
  // 同步基準（同一組語意；本機自己的一份）
  const syncFirst = plain(listingTools.copyOwnListing(handle(), OWNER, postId, { idempotency_key: "copy-key-2" }));
  const syncAgain = plain(listingTools.copyOwnListing(handle(), OWNER, postId, { idempotency_key: "copy-key-2" }));
  assert.equal(syncAgain.reused, true, "前提：同步版也是 reused");
  assert.equal(Number(syncAgain.listing.post_id), Number(syncFirst.listing.post_id));
});

test("錯誤形狀：不是自己的 403 not_owner、找不到 404（兩個 driver 一致）", async () => {
  const { postId } = seedWorld();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  const otherSync = syncErrorShape(() => listingTools.copyOwnListing(handle(), OTHER, postId, {}));
  const otherAsync = await errorShape(() => selfAsync.copyOwnListingAsync(OTHER, postId, {}, opts));
  assert.equal(otherSync?.status, 403, "前提：同步版對別人的刊登丟 403");
  assert.deepEqual(otherAsync, otherSync, "錯誤形狀必須相同");
  assert.equal(otherAsync?.code, "not_owner");

  const missingSync = syncErrorShape(() => listingTools.copyOwnListing(handle(), OWNER, 123456, {}));
  const missingAsync = await errorShape(() => selfAsync.copyOwnListingAsync(OWNER, 123456, {}, opts));
  assert.equal(missingSync?.status, 404);
  assert.deepEqual(missingAsync, missingSync);

  const anonSync = syncErrorShape(() => listingTools.copyOwnListing(handle(), 0, postId, {}));
  const anonAsync = await errorShape(() => selfAsync.copyOwnListingAsync(0, postId, {}, opts));
  assert.equal(anonSync?.status, 401, "前提：未登入是 401");
  assert.deepEqual(anonAsync, anonSync);
});

test("寫入是 fail-closed：PG 失敗時 strict 與預設模式都要丟，fallback: open 才回退；sqlite 模式不碰 exec", async () => {
  const { postId } = seedWorld();
  const boom = async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); };
  await assert.rejects(
    () => selfAsync.copyOwnListingAsync(OWNER, postId, {}, { ...PG, exec: boom }),
    /ECONNREFUSED/, "strict 時要往上丟",
  );
  await assert.rejects(
    () => selfAsync.copyOwnListingAsync(OWNER, postId, {}, { driver: "postgres", exec: boom }),
    /ECONNREFUSED/, "預設模式（寫入）也不得回退本機",
  );
  const fallen = plain(await selfAsync.copyOwnListingAsync(OWNER, postId, {}, { driver: "postgres", exec: boom, fallback: "open" }));
  assert.equal(fallen.copied, true, "fallback: open 時才回退同步版");

  let calls = 0;
  const spy = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const lite = plain(await selfAsync.copyOwnListingAsync(OWNER, postId, {}, { driver: "sqlite", exec: spy }));
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.equal(lite.copied, true, "sqlite 模式走同步路徑");
});

test("路由接線：複製路由用 PG 島嶼（而且真的有 import）", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const start = server.indexOf('app.post("/api/self-listings/:id/copy"');
  assert.ok(start > 0, "找得到複製路由");
  const body = server.slice(start, server.indexOf("\n});", start));
  assert.ok(body.includes("await copyOwnListingAsync(session.userId, req.params.id, req.body || {})"), "要用島嶼");
  assert.ok(!/copyOwnListingFor\(/.test(body), "不得再用同步的 copyOwnListingFor()");
  // ⚠️ 尺規只看「有沒有提到已 import 的名字」⇒ 這裡明確驗 island 名稱真的被 import 進來
  // （否則會出現「判定 PG、實際上 undefined」的假綠）。
  assert.ok(
    /import \{ copyOwnListingAsync \} from "\.\/selfListingsAsync\.js";/.test(server),
    "copyOwnListingAsync 必須真的被 import",
  );
});
