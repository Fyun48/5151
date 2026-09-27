// 會員照片素材庫（member media）PG 分支的 parity（2026-09-27）。
//
// 這一檔要釘住四件事，每一件都對應一個真的會壞掉的地方：
//
//   1. **方言：`COLLATE NOCASE` 是 SQLite 專屬**，PG 沒有這個 collation。同步版在標籤列表與
//      照片的標籤 JOIN 都用它排序，照抄到 PG 會直接語法錯誤。PG 分支改用 `lower(name)`。
//      夾具會主動拒絕 `COLLATE NOCASE`，另有一條測試掃過整組 `*_SQL` 常數。
//   2. **PG 少兩個約束**（與 budgetGuardAsync 記錄的是同一類）：`media_tags` 的
//      `UNIQUE(user_id, name)` 是**表約束**（隱式索引，不在 `sqlite_master`）所以 pgSchema
//      鏡射不到；`idx_member_media_key`（storage_key 唯一）在正式站也不存在。
//      少了它們，「同名標籤重用」「改名撞名 409」都會失效。測試用假 pgDriver 驗證補建順序。
//   3. **刪除的檔案清理必須在交易之後**：在交易裡刪檔，一旦 rollback 就會出現
//      「DB 還留著、檔案已經沒了」的破圖。
//   4. **只有真的是重複才轉 409**：同步版的 `catch { throw 409 }` 會把「連線斷了」
//      也報成「已有同名標籤」。PG 分支刻意收斂成只認唯一性違反——這是**刻意的行為差異**，
//      下面有一條測試專門證明非重複的錯誤會原樣往上丟。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-membermedia-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const sync = await import("../src/memberMedia.js");
const asyncMod = await import("../src/memberMediaAsync.js");

const PG = { driver: "postgres" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const LATER = new Date("2026-06-02T00:00:00.000Z");
const TABLES = ["member_media", "media_tags", "media_tag_map"];
const diskPath = () => path.join(dataDir, "v3.db");

const PG_ILLEGAL = [
  // 🚨 這一輪的頭號陷阱：PG 沒有 NOCASE collation。
  [/COLLATE\s+NOCASE/i, 'collation "nocase" for encoding "UTF8" does not exist'],
  [/\bIFNULL\s*\(/i, "function ifnull(unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
];

// PG 替身：DDL 與索引都從真的 sqlite_master 抄（含 `media_tags` 的表約束 UNIQUE(user_id,name)
// ——它就在 CREATE TABLE 的文字裡，所以夾具**有**這個約束，跟 PG 正式站不一樣；
// 正式站那邊是靠 ensureMemberMediaStoreOnce 補建，由假 pgDriver 那一條測試守著）。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const table of [...TABLES, "listings"]) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  for (const row of disk.prepare(
    `SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name IN (?,?,?)`,
  ).all(...TABLES)) {
    if (/\bON\s+sqlite_/i.test(row.sql)) continue;
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
  db.prepare("DELETE FROM listings WHERE source='self'").run();
  exec.raw.prepare("DELETE FROM listings WHERE source='self'").run();
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN (?,?,?)").run(...TABLES); } catch { /* 沒有 AUTOINCREMENT */ }
  return exec;
}

// 只補 NOT NULL 且沒有 DEFAULT 的欄位，欄位清單從 PRAGMA 推導（不手寫）。
function seedRow(handle, table, fields) {
  const info = handle.prepare(`PRAGMA table_info(${table})`).all();
  const provided = { ...fields };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO ${table}(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => {
      if (n in provided) return provided[n];
      const col = info.find((c) => c.name === n);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
}

const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);
const mediaFields = (handle, { userId, key, deletedAt = null, created = "2026-01-01T00:00:00.000Z" }) =>
  seedRow(handle, "member_media", {
    user_id: userId, storage_key: `${key}.jpg`, thumb_key: `${key}_t.jpg`, original_key: `${key}_o.jpg`,
    original_name: "p.jpg", mime: "image/jpeg", format: "jpeg", width: 800, height: 600, bytes: 1234,
    digest: "d", watermarked: 1, created_at: created, deleted_at: deletedAt,
  });

const dump = (handle, table) => handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r }));

function assertSameRows(exec, table, why) {
  const a = dump(db, table);
  const b = dump(exec.raw, table);
  assert.deepEqual(b, a, `${why}：PG 分支落地的 ${table} 必須與同步版完全相同`);
  assert.ok(a.length > 0 || why.includes("空"), `${why}：兩邊都是 0 列時這個比對沒有鑑別力`);
}

const reasonOf = (error) => `${error.status}/${error.code || "-"}/${error.message}`;

// ---------------------------------------------------------------------------
// 讀取

test("列出素材：形狀、配額、used 與標籤都與同步版相同（逐欄比對）", async () => {
  const exec = resetBoth();
  mediaFields(db, { userId: 11, key: KEY_A });
  mediaFields(exec.raw, { userId: 11, key: KEY_A });
  mediaFields(db, { userId: 11, key: KEY_B, created: "2026-01-02T00:00:00.000Z" });
  mediaFields(exec.raw, { userId: 11, key: KEY_B, created: "2026-01-02T00:00:00.000Z" });
  for (const h of [db, exec.raw]) {
    seedRow(h, "media_tags", { user_id: 11, name: "客廳", created_at: "2026-01-03T00:00:00.000Z" });
    seedRow(h, "media_tag_map", { media_id: 1, tag_id: 1 });
  }

  const pg = await asyncMod.listMemberMediaAsync(11, { plan: "sponsor", ...PG, exec });
  const lite = sync.listMemberMedia(db, 11, { plan: "sponsor" });
  assert.deepEqual(pg, lite, "整包必須相同");
  assert.equal(pg.used, 2);
  assert.equal(pg.quota, sync.MEDIA_QUOTA.sponsor);
  assert.equal(pg.items.length, 2);
  assert.equal(pg.items[0].id, 2, "必須依 id DESC（最新的在最前面）");
  assert.equal(pg.items[0].tags.length, 0);
  assert.deepEqual(pg.items[1].tags, [{ id: 1, name: "客廳" }], "標籤要掛在對的那一張上");
  assert.equal(pg.items[1].url, `${sync.MEDIA_PUBLIC_PREFIX}${KEY_A}.jpg`);
  assert.equal(pg.items[1].watermarked, true, "watermarked 必須是布林 true（不是 1）");
  assert.equal(pg.items[1].width, 800);
});

test("列出素材：免費配額、軟刪除的不算、tagIds 篩選，兩邊一致", async () => {
  const exec = resetBoth();
  mediaFields(db, { userId: 12, key: KEY_A });
  mediaFields(exec.raw, { userId: 12, key: KEY_A });
  mediaFields(db, { userId: 12, key: KEY_B, deletedAt: "2026-02-01T00:00:00.000Z" });
  mediaFields(exec.raw, { userId: 12, key: KEY_B, deletedAt: "2026-02-01T00:00:00.000Z" });
  for (const h of [db, exec.raw]) {
    seedRow(h, "media_tags", { user_id: 12, name: "A", created_at: "2026-01-03T00:00:00.000Z" });
    seedRow(h, "media_tags", { user_id: 12, name: "B", created_at: "2026-01-03T00:00:00.000Z" });
    seedRow(h, "media_tag_map", { media_id: 1, tag_id: 1 });
    seedRow(h, "media_tag_map", { media_id: 2, tag_id: 2 });
  }
  const pgAll = await asyncMod.listMemberMediaAsync(12, { ...PG, exec });
  const liteAll = sync.listMemberMedia(db, 12, {});
  assert.deepEqual(pgAll, liteAll);
  assert.equal(pgAll.used, 1, "軟刪除的不算在 used 裡");
  assert.equal(pgAll.items.length, 1, "軟刪除的不列出來");
  assert.equal(pgAll.quota, sync.MEDIA_QUOTA.free);

  const pgFiltered = await asyncMod.listMemberMediaAsync(12, { tagIds: [1], ...PG, exec });
  const liteFiltered = sync.listMemberMedia(db, 12, { tagIds: [1] });
  assert.deepEqual(pgFiltered, liteFiltered);
  assert.equal(pgFiltered.items.length, 1, "tag 1 對到 media 1");
  // tag 2 只對到被軟刪除的 media 2 ⇒ 應為空。這一條證明篩選真的有作用。
  const pgNone = await asyncMod.listMemberMediaAsync(12, { tagIds: [2], ...PG, exec });
  assert.deepEqual(pgNone.items, []);
  assert.equal(pgNone.used, 1, "used 不受 tagIds 影響（同步版也是）");
});

test("列出標籤：排序忽略大小寫（lower() 取代 COLLATE NOCASE）", async () => {
  const exec = resetBoth();
  for (const h of [db, exec.raw]) {
    for (const [i, name] of ["banana", "Apple", "cherry"].entries()) {
      seedRow(h, "media_tags", { user_id: 13, name, created_at: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
  }
  const pg = await asyncMod.listMediaTagsAsync(13, { ...PG, exec });
  const lite = sync.listMediaTags(db, 13);
  assert.deepEqual(pg, lite);
  assert.deepEqual(pg.map((t) => t.name), ["Apple", "banana", "cherry"],
    "不折疊大小寫的話會排成 Apple/banana/cherry 之外的順序（B 在 a 前面）");
});

test("依標籤取 url：空輸入回空陣列，有輸入則只回對到的", async () => {
  const exec = resetBoth();
  mediaFields(db, { userId: 14, key: KEY_A });
  mediaFields(exec.raw, { userId: 14, key: KEY_A });
  for (const h of [db, exec.raw]) {
    seedRow(h, "media_tags", { user_id: 14, name: "客廳", created_at: "2026-01-03T00:00:00.000Z" });
    seedRow(h, "media_tag_map", { media_id: 1, tag_id: 1 });
  }
  assert.deepEqual(await asyncMod.mediaUrlsForTagIdsAsync(14, [], { ...PG, exec }), []);
  assert.deepEqual(await asyncMod.mediaUrlsForTagIdsAsync(14, ["x", 0, null], { ...PG, exec }), [],
    "非數字與 0 都要被濾掉（濾光就回空，不該去查 DB）");
  const urls = await asyncMod.mediaUrlsForTagIdsAsync(14, [1], { ...PG, exec });
  assert.deepEqual(urls, sync.mediaUrlsForTagIds(db, 14, [1]));
  assert.equal(urls.length, 1, "必須真的回一個 url（否則這條測試沒有鑑別力）");
  assert.match(urls[0], /^\/media\/lib\/[a-f0-9]{32}\.jpg$/);
});

test("單張取用：別人的、已刪除的都回 null", async () => {
  const exec = resetBoth();
  mediaFields(db, { userId: 15, key: KEY_A });
  mediaFields(exec.raw, { userId: 15, key: KEY_A });
  mediaFields(db, { userId: 15, key: KEY_B, deletedAt: "2026-02-01T00:00:00.000Z" });
  mediaFields(exec.raw, { userId: 15, key: KEY_B, deletedAt: "2026-02-01T00:00:00.000Z" });
  assert.deepEqual(await asyncMod.getOwnedMediaAsync(15, 1, { ...PG, exec }), sync.getOwnedMedia(db, 15, 1));
  assert.equal((await asyncMod.getOwnedMediaAsync(15, 1, { ...PG, exec })).id, 1);
  assert.equal(await asyncMod.getOwnedMediaAsync(16, 1, { ...PG, exec }), null, "別人的要 null");
  assert.equal(await asyncMod.getOwnedMediaAsync(15, 2, { ...PG, exec }), null, "軟刪除的要 null");
});

// ---------------------------------------------------------------------------
// 標籤寫入

test("建立標籤：同名會重用既有的（reused），落地列數不變", async () => {
  const exec = resetBoth();
  const pg1 = await asyncMod.createMediaTagAsync(21, "  客廳  ", { now: NOW, ...PG, exec });
  const lite1 = sync.createMediaTag(db, 21, "  客廳  ", NOW);
  assert.deepEqual(pg1, lite1);
  assert.equal(pg1.name, "客廳", "名稱要去空白");
  assert.equal(pg1.id, 1);
  assert.equal(pg1.created_at, NOW.toISOString());
  assert.equal(pg1.reused, undefined);

  const pg2 = await asyncMod.createMediaTagAsync(21, "客廳", { now: LATER, ...PG, exec });
  const lite2 = sync.createMediaTag(db, 21, "客廳", LATER);
  assert.deepEqual(pg2, lite2);
  assert.equal(pg2.id, 1, "同名要重用原本那一筆");
  assert.equal(pg2.reused, true);
  assert.equal(dump(exec.raw, "media_tags").length, 1, "不得新增第二筆同名標籤");
  assertSameRows(exec, "media_tags", "建立同名標籤");
});

test("建立標籤：空名稱被擋下，兩邊訊息相同", async () => {
  const exec = resetBoth();
  let syncErr = null;
  try { sync.createMediaTag(db, 22, "   ", NOW); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該擋下空名稱");
  await assert.rejects(() => asyncMod.createMediaTagAsync(22, "   ", { now: NOW, ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
  assert.equal(dump(exec.raw, "media_tags").length, 0);
});

test("標籤改名：撞名 → 409 tag_exists；改名成功要落地的名字也對", async () => {
  const exec = resetBoth();
  for (const h of [db, exec.raw]) {
    seedRow(h, "media_tags", { user_id: 23, name: "甲", created_at: "2026-01-01T00:00:00.000Z" });
    seedRow(h, "media_tags", { user_id: 23, name: "乙", created_at: "2026-01-02T00:00:00.000Z" });
  }
  const pg = await asyncMod.renameMediaTagAsync(23, 1, "丙", { ...PG, exec });
  const lite = sync.renameMediaTag(db, 23, 1, "丙");
  assert.deepEqual(pg, lite);
  assert.equal(pg.name, "丙");
  assert.equal(pg.created_at, "2026-01-01T00:00:00.000Z", "created_at 必須沿用舊值");

  let syncErr = null;
  try { sync.renameMediaTag(db, 23, 1, "乙"); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版撞名應該要丟錯");
  assert.equal(syncErr.code, "tag_exists");
  await assert.rejects(() => asyncMod.renameMediaTagAsync(23, 1, "乙", { ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr), `PG 分支必須給同樣的 409 tag_exists（同步版：${reasonOf(syncErr)}）`);
  assertSameRows(exec, "media_tags", "標籤改名");
});

test("標籤改名：不是自己的 → 404，且不得改到別人的", async () => {
  const exec = resetBoth();
  for (const h of [db, exec.raw]) seedRow(h, "media_tags", { user_id: 24, name: "別人的", created_at: "2026-01-01T00:00:00.000Z" });
  let syncErr = null;
  try { sync.renameMediaTag(db, 99, 1, "偷改"); } catch (e) { syncErr = e; }
  await assert.rejects(() => asyncMod.renameMediaTagAsync(99, 1, "偷改", { ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
  assert.equal(dump(exec.raw, "media_tags")[0].name, "別人的", "別人的標籤不得被改");
});

test("刪除標籤：連同對應一起刪（media_tag_map 不得留孤兒）", async () => {
  const exec = resetBoth();
  mediaFields(db, { userId: 25, key: KEY_A });
  mediaFields(exec.raw, { userId: 25, key: KEY_A });
  // ⚠️ 刻意留一個**不會被刪**的標籤與它的對應：只種一個的話刪完兩邊都是 0 列，
  // `assertSameRows` 會變成「空的等於空的」——那正是本系列反覆踩到的空比對。
  // 這一條第一次寫就是被我自己加的守衛擋下來的（「兩邊都是 0 列時這個比對沒有鑑別力」）。
  for (const h of [db, exec.raw]) {
    seedRow(h, "media_tags", { user_id: 25, name: "客廳", created_at: "2026-01-01T00:00:00.000Z" });
    seedRow(h, "media_tags", { user_id: 25, name: "保留", created_at: "2026-01-02T00:00:00.000Z" });
    seedRow(h, "media_tag_map", { media_id: 1, tag_id: 1 });
    seedRow(h, "media_tag_map", { media_id: 1, tag_id: 2 });
  }
  const pg = await asyncMod.deleteMediaTagAsync(25, 1, { ...PG, exec });
  const lite = sync.deleteMediaTag(db, 25, 1);
  assert.deepEqual(pg, lite);
  assert.deepEqual({ deleted: true }, pg, "回傳形狀必須是 { deleted: true }");
  assert.deepEqual(dump(exec.raw, "media_tags").map((r) => r.name), ["保留"], "只刪掉被指定的那一個");
  assert.deepEqual(dump(exec.raw, "media_tag_map").map((r) => r.tag_id), [2], "孤兒對應必須一起刪掉");
  assertSameRows(exec, "media_tags", "刪除標籤");
  assertSameRows(exec, "media_tag_map", "刪除標籤的對應");
});

test("設定照片標籤：整批取代，回傳的照片帶著新標籤", async () => {
  const exec = resetBoth();
  mediaFields(db, { userId: 26, key: KEY_A });
  mediaFields(exec.raw, { userId: 26, key: KEY_A });
  for (const h of [db, exec.raw]) {
    seedRow(h, "media_tags", { user_id: 26, name: "甲", created_at: "2026-01-01T00:00:00.000Z" });
    seedRow(h, "media_tags", { user_id: 26, name: "乙", created_at: "2026-01-02T00:00:00.000Z" });
    seedRow(h, "media_tag_map", { media_id: 1, tag_id: 1 });
  }
  const pg = await asyncMod.setMediaTagsAsync(26, 1, [2, 2, 0, "x"], { ...PG, exec });
  const lite = sync.setMediaTags(db, 26, 1, [2, 2, 0, "x"]);
  assert.deepEqual(pg, lite);
  assert.deepEqual(pg.tags, [{ id: 2, name: "乙" }], "舊的 tag 1 要被取代掉，重複／無效的要去掉");
  assertSameRows(exec, "media_tag_map", "設定標籤");
});

test("設定照片標籤：照片或標籤不是自己的 → 404，且對應不得被動到", async () => {
  const exec = resetBoth();
  mediaFields(db, { userId: 27, key: KEY_A });
  mediaFields(exec.raw, { userId: 27, key: KEY_A });
  for (const h of [db, exec.raw]) {
    seedRow(h, "media_tags", { user_id: 28, name: "別人的", created_at: "2026-01-01T00:00:00.000Z" });
    seedRow(h, "media_tag_map", { media_id: 1, tag_id: 1 });
  }
  const cases = [
    { uid: 99, mediaId: 1, tags: [], why: "照片不是自己的" },
    { uid: 27, mediaId: 1, tags: [1], why: "標籤不是自己的" },
  ];
  for (const c of cases) {
    let syncErr = null;
    try { sync.setMediaTags(db, c.uid, c.mediaId, c.tags); } catch (e) { syncErr = e; }
    assert.ok(syncErr, `同步版應該丟錯（${c.why}）`);
    await assert.rejects(() => asyncMod.setMediaTagsAsync(c.uid, c.mediaId, c.tags, { ...PG, exec }),
      (e) => reasonOf(e) === reasonOf(syncErr), `PG 分支必須一致（${c.why}）`);
  }
  assert.deepEqual(dump(exec.raw, "media_tag_map"), [{ media_id: 1, tag_id: 1 }], "驗證失敗時不得先清掉對應");
});

// ---------------------------------------------------------------------------
// 刪除素材

test("刪除素材：軟刪除 ＋ 清對應，未被引用時 kept_file=false", async () => {
  const exec = resetBoth();
  mediaFields(db, { userId: 31, key: KEY_A });
  mediaFields(exec.raw, { userId: 31, key: KEY_A });
  for (const h of [db, exec.raw]) {
    seedRow(h, "media_tags", { user_id: 31, name: "甲", created_at: "2026-01-01T00:00:00.000Z" });
    seedRow(h, "media_tag_map", { media_id: 1, tag_id: 1 });
  }
  const pg = await asyncMod.deleteMemberMediaAsync(31, 1, { now: LATER, ...PG, exec });
  const lite = sync.deleteMemberMedia(db, 31, 1, { now: LATER });
  assert.deepEqual(pg, lite);
  assert.equal(pg.kept_file, false, "沒有被引用 ⇒ 實體檔應該被清掉");
  assert.equal(dump(exec.raw, "member_media")[0].deleted_at, LATER.toISOString(), "必須是軟刪除（列還在）");
  assert.equal(dump(exec.raw, "media_tag_map").length, 0, "對應要一起清掉");
  assertSameRows(exec, "member_media", "刪除素材");
});

test("刪除素材：被站內刊登引用時保留實體檔（kept_file=true），且已刪除的重複呼叫是 idempotent", async () => {
  const exec = resetBoth();
  const url = `${sync.MEDIA_PUBLIC_PREFIX}${KEY_A}.jpg`;
  for (const h of [db, exec.raw]) {
    mediaFields(h, { userId: 32, key: KEY_A });
    seedRow(h, "listings", {
      post_id: 9001, source: "self", title: "t", url: "/go/9001", cover: url,
      self_photos: JSON.stringify([url]), self_status: "open", listed_by_user_id: 32,
    });
  }
  const pg = await asyncMod.deleteMemberMediaAsync(32, 1, { now: LATER, ...PG, exec });
  const lite = sync.deleteMemberMedia(db, 32, 1, { now: LATER });
  assert.deepEqual(pg, lite);
  assert.equal(pg.kept_file, true, "被引用 ⇒ 必須保留實體檔，否則歷史頁面會破圖");

  const again = await asyncMod.deleteMemberMediaAsync(32, 1, { now: LATER, ...PG, exec });
  const againLite = sync.deleteMemberMedia(db, 32, 1, { now: LATER });
  assert.deepEqual(again, againLite);
  assert.deepEqual(again, { deleted: true, idempotent: true }, "第二次呼叫必須是 idempotent");
});

test("刪除素材：不是自己的 → 404，且那一列不得被動到", async () => {
  const exec = resetBoth();
  mediaFields(db, { userId: 33, key: KEY_A });
  mediaFields(exec.raw, { userId: 33, key: KEY_A });
  let syncErr = null;
  try { sync.deleteMemberMedia(db, 99, 1, { now: LATER }); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該丟 404");
  await assert.rejects(() => asyncMod.deleteMemberMediaAsync(99, 1, { now: LATER, ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
  assert.equal(dump(exec.raw, "member_media")[0].deleted_at, null, "別人的素材不得被刪");
});

// ---------------------------------------------------------------------------
// schema／索引／方言

function recordingDriver({ duplicates = [], extraTags = [] } = {}) {
  const statements = [];
  return {
    statements,
    async exec(sql) { statements.push(sql); },
    async query(sql, params = []) {
      // 🚨 真的 `pgDriver.query()` **不翻譯** SQLite 方言，所以送進來的字串一定要是
      // `$n`。第一版這裡只記錄不檢查，於是「忘記 toPostgresSql」的 bug 一路活到
      // live PG 測試才炸（`syntax error at or near "AND"`）。這裡主動拒絕 `?`，
      // 讓同一個錯誤在**離線**就看得見。
      if (sql.includes("?")) {
        throw new Error(`PG driver 收到未翻譯的 SQL（還有 ? 佔位符）：${sql.slice(0, 80)}`);
      }
      statements.push(sql);
      if (/GROUP BY user_id, name\s+HAVING COUNT/.test(sql)) return { rows: duplicates };
      if (/SELECT id FROM media_tags WHERE user_id=\$1 AND name=\$2/.test(sql)) return { rows: extraTags };
      return { rows: [] };
    },
  };
}

test("ensureMemberMediaStoreOnce：補建 storage_key 唯一索引與 UNIQUE(user_id,name)，且每個 driver 只做一次", async () => {
  const driver = recordingDriver({ duplicates: [{ user_id: 5, name: "客廳", keep_id: 1 }], extraTags: [{ id: 9 }] });
  await asyncMod.ensureMemberMediaStoreOnce(driver);
  const first = [...driver.statements];

  assert.ok(first.includes(asyncMod.PG_CREATE_MEDIA_KEY_INDEX_SQL),
    "storage_key 的唯一索引必須補建（正式站沒有）");
  assert.ok(first.includes(asyncMod.PG_CREATE_TAG_NAME_INDEX_SQL),
    "media_tags 的 UNIQUE(user_id,name) 是表約束、pgSchema 鏡射不到，必須明確補建");
  const dupAt = first.findIndex((s) => /HAVING COUNT/.test(s));
  const tagIndexAt = first.findIndex((s) => s === asyncMod.PG_CREATE_TAG_NAME_INDEX_SQL);
  assert.ok(dupAt >= 0 && tagIndexAt > dupAt,
    `標籤唯一索引必須在清完重複之後才建（有重複時 CREATE UNIQUE INDEX 會直接失敗）。順序：${first.map((s) => s.slice(0, 45))}`);
  // 重複的標籤不是直接丟掉：先把指向它的對應改指到保留者，再刪。
  assert.ok(first.some((s) => /INSERT INTO media_tag_map\(media_id, tag_id\) SELECT media_id/.test(s)),
    "重複標籤的對應必須改指到保留者，不能直接丟掉使用者的分類");
  // 注意這裡是 `$1`：真的 pgDriver 收到的一定是翻譯過的 SQL（假 driver 也會擋 `?`）。
  assert.ok(first.some((s) => /^DELETE FROM media_tags WHERE id=\$1/.test(s)), "重複的標籤列要刪掉");
  assert.ok(first.some((s) => /ADD COLUMN IF NOT EXISTS original_key/.test(s)));
  assert.ok(first.some((s) => /ADD COLUMN IF NOT EXISTS watermarked/.test(s)));

  await asyncMod.ensureMemberMediaStoreOnce(driver);
  assert.equal(driver.statements.length, first.length, "第二次呼叫不得再跑一次 schema");
});

test("PG 分支的語句不得出現 COLLATE NOCASE（PG 沒有這個 collation）", async () => {
  const sqls = Object.entries(asyncMod).filter(([k, v]) => k.endsWith("_SQL") && typeof v === "string");
  assert.ok(sqls.length >= 18, `應該要抓到整組語句常數，實際 ${sqls.length} 條`);
  const bad = sqls.filter(([, sql]) => /COLLATE\s+NOCASE/i.test(sql)).map(([k]) => k);
  assert.deepEqual(bad, [], `PG 分支的語句不得使用 COLLATE NOCASE：${bad.join(", ")}`);
  assert.match(asyncMod.LIST_TAGS_SQL, /ORDER BY lower\(name\)/, "排序必須保留（拿掉就變成無序）");
  assert.match(asyncMod.TAGS_FOR_MEDIA_SQL, /ORDER BY lower\(t\.name\)/);
});

test("夾具本身要真的拒絕 COLLATE NOCASE／IFNULL／LIMIT -1（否則方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT name FROM media_tags ORDER BY name COLLATE NOCASE"), /collation "nocase"/);
  await assert.rejects(() => exec("SELECT IFNULL(name,'') FROM media_tags"), /function ifnull/);
  await assert.rejects(() => exec("SELECT name FROM media_tags LIMIT -1"), /LIMIT must not be negative/);
  await assert.doesNotReject(() => exec("SELECT name FROM media_tags ORDER BY lower(name)"), "lower() 必須放行");
});

// ---------------------------------------------------------------------------
// 回退政策

test("非 postgres 模式必須回退同步路徑（讀寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  const pgItem = await asyncMod.createMediaTagAsync(41, "夾具版", { now: NOW, ...PG, exec });
  assert.equal(pgItem.name, "夾具版");
  const lite = await asyncMod.createMediaTagAsync(41, "磁碟版", { now: NOW, driver: "sqlite", exec });
  assert.equal(lite.name, "磁碟版");
  assert.deepEqual(dump(db, "media_tags").map((r) => r.name), ["磁碟版"]);
  assert.deepEqual(dump(exec.raw, "media_tags").map((r) => r.name), ["夾具版"], "sqlite 模式不得改動 PG 夾具");
  const listed = await asyncMod.listMediaTagsAsync(41, { driver: "sqlite", exec });
  assert.deepEqual(listed.map((t) => t.name), ["磁碟版"]);
});

test("strict：PG 寫入失敗時必須往上丟，不得無聲寫進沒人讀的 SQLite", async () => {
  const exec = resetBoth();
  const broken = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    () => asyncMod.createMediaTagAsync(42, "x", { now: NOW, ...PG, exec: broken, strict: true }),
    /connection terminated/,
  );
  await assert.rejects(
    () => asyncMod.createMediaTagAsync(42, "x", { now: NOW, ...PG, exec: broken }),
    /connection terminated/,
  );
  assert.equal(dump(db, "media_tags").length, 0, "寫入失敗不得回退寫 SQLite");
});

test("非重複的錯誤不得被誤報成 409 tag_exists（與同步版的 catch-all 刻意不同）", async () => {
  // 同步版的 `renameMediaTag` 是 `catch { throw 409 tag_exists }`——連「連線斷了」都會被
  // 報成「已有同名標籤」。PG 分支只認唯一性違反，其餘原樣往上丟，讓故障看得見。
  // 這一條是**刻意的行為差異**，所以要有一條測試把它釘住。
  const exec = resetBoth();
  for (const h of [db, exec.raw]) seedRow(h, "media_tags", { user_id: 43, name: "甲", created_at: "2026-01-01T00:00:00.000Z" });
  const failingExec = async (sql, params = []) => {
    if (/INSERT INTO media_tags|UPDATE media_tags SET name/.test(sql)) {
      const e = new Error("connection terminated unexpectedly");
      e.code = "08006";
      throw e;
    }
    return exec(sql, params);
  };
  await assert.rejects(() => asyncMod.renameMediaTagAsync(43, 1, "乙", { ...PG, exec: failingExec }),
    /connection terminated/);
  await assert.rejects(() => asyncMod.createMediaTagAsync(43, "乙", { now: NOW, ...PG, exec: failingExec }),
    /connection terminated/);
});
