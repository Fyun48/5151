// 會員照片素材庫（member media）的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 涵蓋的 8 條路由：
//   GET    /api/media              列出素材（含配額、標籤）
//   GET    /api/media/tags         列出標籤
//   POST   /api/media/tags         建立標籤
//   PATCH  /api/media/tags/:id     改名
//   DELETE /api/media/tags/:id     刪除標籤
//   PUT    /api/media/:id/tags     設定某張照片的標籤
//   GET    /api/media/by-tags      依標籤取 url
//   DELETE /api/media/:id          刪除素材（soft delete）
//
// **刻意不含 `POST /api/media`（上傳）**：`saveMemberMedia()` 是「影像處理 → 交易內配額檢查
// → 寫檔 → 上傳 R2」，交易橫跨檔案 I/O 與網路。搬到 PG 要重新設計那個交易的邊界
// （PG 的交易不宜橫跨網路 I/O：連線與鎖都會被佔住），那是獨立一批，不混在這裡做。
//
// ⚠️ 方言陷阱：同步版用 `ORDER BY name COLLATE NOCASE`，**`COLLATE NOCASE` 是 SQLite 專屬**，
// PG 沒有這個 collation。PG 這邊用 `ORDER BY lower(name)`（ASCII 大小寫不分；ASCII 以外的
// 字元兩邊都不折疊）。夾具會主動拒絕 `COLLATE NOCASE`，否則寫錯也照樣過關。
//
// ⚠️ 第二個坑（與 budgetGuardAsync 檔案頭記錄的是同一類）：SQLite 的 **表約束**
// `media_tags ... UNIQUE(user_id, name)` 是**隱式索引**，不在 `sqlite_master` 裡，
// 所以 `pgSchema` 鏡射不到。實測正式站 `media_tags` **只有 pkey** ⇒
// 「同名標籤」在 PG 完全沒有約束：`createMediaTag` 的「已存在就重用」與
// `renameMediaTag` 的 409「已有同名標籤」都會失效，而且會生出重複標籤。
// `member_media.idx_member_media_key`（storage_key 唯一）同樣不存在。
// 這裡在第一次使用時補建，程序與 listingToolsAsync 相同（PG 專屬 DDL → 清重複 → 建索引）。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applySiteWatermark, normalizeImage } from "./imageProcess.js";
import { deleteMemberMediaObjects, putMemberMediaObjects } from "./media/mediaStore.js";
import {
  MEDIA_PUBLIC_PREFIX,
  countActiveMedia as countActiveMediaSync,
  createMediaTag as createMediaTagSync,
  deleteMediaTag as deleteMediaTagSync,
  deleteMemberMedia as deleteMemberMediaSync,
  getOwnedMedia as getOwnedMediaSync,
  httpError,
  isMediaReferenced as isMediaReferencedSync,
  listMediaTags as listMediaTagsSync,
  listMemberMedia as listMemberMediaSync,
  mediaKeyFromUrl,
  mediaQuotaForPlan,
  mediaUrlsForTagIds as mediaUrlsForTagIdsSync,
  memberMediaPublicName,
  ownsMediaUrl as ownsMediaUrlSync,
  publicMediaShape,
  publicTag,
  memberMediaDir,
  removeMediaArtifacts,
  renameMediaTag as renameMediaTagSync,
  safeName,
  saveMemberMedia as saveMemberMediaSync,
  watermarkPublicDerivative,
  setMediaTags as setMediaTagsSync,
  tagName,
} from "./memberMedia.js";

// ---- 語句文字（逐字對應 memberMedia.js 的行號；方言差異只有 COLLATE NOCASE）----
export const LIST_MEDIA_SQL =
  "SELECT * FROM member_media WHERE user_id=? AND deleted_at IS NULL ORDER BY id DESC"; // memberMedia.js:173
export const COUNT_ACTIVE_MEDIA_SQL =
  "SELECT COUNT(*) n FROM member_media WHERE user_id=? AND deleted_at IS NULL"; // memberMedia.js:168
export const LIST_TAGS_SQL =
  "SELECT id, name, created_at FROM media_tags WHERE user_id=? ORDER BY lower(name)"; // memberMedia.js:346（COLLATE NOCASE→lower()）
export const TAGS_FOR_MEDIA_SQL =
  `SELECT t.id, t.name FROM media_tag_map m
   JOIN media_tags t ON t.id = m.tag_id
   WHERE m.media_id=?
   ORDER BY lower(t.name)`; // memberMedia.js:142（COLLATE NOCASE→lower()）
// 一次取回多張照片的標籤：同步版是逐張查（N+1），PG 這邊一句取完再分組，
// 結果完全相同（排序規則同上）但少 N 次往返。
export const TAGS_FOR_MEDIA_IDS_SQL =
  `SELECT m.media_id, t.id, t.name FROM media_tag_map m
   JOIN media_tags t ON t.id = m.tag_id
   WHERE m.media_id IN (%s)
   ORDER BY lower(t.name), t.id`;
export const MEDIA_IDS_FOR_TAGS_SQL =
  "SELECT DISTINCT media_id FROM media_tag_map WHERE tag_id IN (%s)"; // memberMedia.js:178
export const MEDIA_BY_ID_OWNED_SQL =
  "SELECT * FROM member_media WHERE id=? AND user_id=? AND deleted_at IS NULL"; // memberMedia.js:186
export const MEDIA_BY_ID_SQL =
  "SELECT * FROM member_media WHERE id=? AND user_id=?"; // memberMedia.js:307
export const OWNS_MEDIA_URL_SQL =
  "SELECT id FROM member_media WHERE storage_key=? AND user_id=? AND deleted_at IS NULL"; // memberMedia.js:194
export const IS_MEDIA_REFERENCED_SQL =
  "SELECT 1 FROM listings WHERE source='self' AND (cover=? OR self_photos LIKE ?) LIMIT 1"; // memberMedia.js:201
export const SOFT_DELETE_MEDIA_SQL =
  "UPDATE member_media SET deleted_at=? WHERE id=? AND user_id=?"; // memberMedia.js:313
export const INSERT_TAG_SQL =
  "INSERT INTO media_tags(user_id, name, created_at) VALUES (?,?,?) RETURNING id"; // memberMedia.js:354（PG 用 RETURNING）
export const TAG_BY_NAME_SQL =
  "SELECT id, name, created_at FROM media_tags WHERE user_id=? AND name=?"; // memberMedia.js:357
export const TAG_BY_ID_OWNED_SQL =
  "SELECT * FROM media_tags WHERE id=? AND user_id=?"; // memberMedia.js:364
export const RENAME_TAG_SQL =
  "UPDATE media_tags SET name=? WHERE id=? AND user_id=?"; // memberMedia.js:368
export const TAG_ID_OWNED_SQL =
  "SELECT id FROM media_tags WHERE id=? AND user_id=?"; // memberMedia.js:376
export const DELETE_TAG_MAP_BY_TAG_SQL =
  "DELETE FROM media_tag_map WHERE tag_id=?"; // memberMedia.js:378
export const DELETE_TAG_SQL =
  "DELETE FROM media_tags WHERE id=? AND user_id=?"; // memberMedia.js:379
export const DELETE_TAG_MAP_BY_MEDIA_SQL =
  "DELETE FROM media_tag_map WHERE media_id=?"; // memberMedia.js:314、391
export const INSERT_TAG_MAP_SQL =
  "INSERT INTO media_tag_map(media_id, tag_id) VALUES (?,?)"; // memberMedia.js:392

// ---- schema ----
// PG 專屬 DDL（不鏡射本機 SQLite：正式節點的本機檔可能過期）。
export const PG_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS member_media (
     id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
     user_id BIGINT NOT NULL,
     storage_key TEXT NOT NULL,
     thumb_key TEXT,
     original_key TEXT,
     original_name TEXT,
     mime TEXT NOT NULL,
     format TEXT NOT NULL,
     width BIGINT,
     height BIGINT,
     bytes BIGINT,
     digest TEXT,
     watermarked BIGINT NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     deleted_at TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS idx_member_media_user ON member_media(user_id, deleted_at, id)",
  `CREATE TABLE IF NOT EXISTS media_tags (
     id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
     user_id BIGINT NOT NULL,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_media_tags_user ON media_tags(user_id, name)",
  `CREATE TABLE IF NOT EXISTS media_tag_map (
     media_id BIGINT NOT NULL,
     tag_id BIGINT NOT NULL,
     PRIMARY KEY (media_id, tag_id)
   )`,
  "CREATE INDEX IF NOT EXISTS idx_media_tag_map_tag ON media_tag_map(tag_id)",
];
// 對應同步版的 try/catch ALTER（memberMedia.js:71-76）。
export const PG_ALTER_STATEMENTS = [
  "ALTER TABLE member_media ADD COLUMN IF NOT EXISTS original_key TEXT",
  "ALTER TABLE member_media ADD COLUMN IF NOT EXISTS watermarked BIGINT NOT NULL DEFAULT 0",
];
// 同步版是「CREATE UNIQUE INDEX idx_member_media_key」與表約束 UNIQUE(user_id,name)。
// 兩個在 PG 正式站都不存在（見檔頭），所以明確補上。
export const PG_CREATE_MEDIA_KEY_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_member_media_key ON member_media(storage_key)";
export const PG_CREATE_TAG_NAME_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS media_tags_user_name_key ON media_tags(user_id, name)";
export const PG_DUPLICATE_TAGS_SQL =
  "SELECT user_id, name, MIN(id) AS keep_id FROM media_tags GROUP BY user_id, name HAVING COUNT(*) > 1";
export const PG_TAGS_WITH_NAME_SQL =
  "SELECT id FROM media_tags WHERE user_id=? AND name=? AND id<>?";
export const PG_REPOINT_TAG_MAP_SQL =
  "INSERT INTO media_tag_map(media_id, tag_id) SELECT media_id, ? FROM media_tag_map WHERE tag_id=? ON CONFLICT DO NOTHING";
export const PG_DELETE_DUPLICATE_TAG_SQL = "DELETE FROM media_tags WHERE id=?";
export const PG_INDEX_EXISTS_SQL =
  "SELECT 1 AS ok FROM pg_indexes WHERE schemaname='public' AND indexname=?";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const firstRow = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
// PG 的 COUNT(*) 是 bigint，node-pg 回字串；同步版也是 `Number(...?.n)`。
const countOf = (rows) => Number(firstRow(rows)?.n) || 0;
const stampOf = (now) => (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
const placeholders = (n) => Array.from({ length: n }, () => "?").join(",");
const uniqIds = (tagIds) => [...new Set((Array.isArray(tagIds) ? tagIds : []).map(Number).filter((n) => n > 0))];

// 注入式 `exec` 有兩種形狀：`pgDriver.query()` 的裸陣列，以及 `crmOutboxAsync` 起的
// `{ rows, rowCount }`。這個模組的呼叫端（`firstRow()`／`for…of`）一律當**裸陣列**用，
// 所以這裡統一轉成裸陣列——2026-09-28 由 listing-import 的 live PG 測試抓到：
// 餵 `{ rows }` 時 `firstRow()` 拿到 undefined ⇒ 媒體刪除靜默地變成 404（被呼叫端的
// try/catch 吞掉），於是「取消匯入時的媒體清理」在 PG 上整個沒作用。
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

async function pgExec(options = {}) {
  if (options.exec) {
    const injected = options.exec;
    return async (sql, params = []) => rowsOf(await injected(sql, params));
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// 每個 pgDriver 只建一次 schema。沿用 budgetGuardAsync／listingToolsAsync 的形狀。
const schemaReady = new WeakMap();
export async function ensureMemberMediaStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = (async () => {
    for (const sql of PG_SCHEMA_STATEMENTS) await pgDriver.exec(sql);
    for (const sql of PG_ALTER_STATEMENTS) await pgDriver.exec(sql);
    await pgDriver.exec(PG_CREATE_MEDIA_KEY_INDEX_SQL);
    await dedupeTags(pgDriver);
    await pgDriver.exec(PG_CREATE_TAG_NAME_INDEX_SQL);
  })();
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver); // 失敗不要快取，下次再試
    throw error;
  }
}

// 補建 `UNIQUE(user_id, name)` 之前必須先把重複的清掉，否則 CREATE UNIQUE INDEX 直接失敗。
// 保留 id 最小那一筆，並把指向重複者的對應改指到保留者（不是直接丟掉使用者的分類）。
// `ON CONFLICT DO NOTHING` 是因為 media_tag_map 的主鍵是 (media_id, tag_id)。
async function dedupeTags(pgDriver) {
  // 🚨 `pgDriver.query()` **不會**翻譯 SQLite 方言（要顯式 `toPostgresSql`，或走
  // `runSqliteSql`）。這裡第一版漏了翻譯，把 `?` 直接送到 PG ⇒ `syntax error at or near "AND"`。
  // **離線測試沒抓到，是 live PG 測試才炸出來的**——因為只有真的有重複資料時這段才會執行，
  // 而離線夾具從來沒有重複。現在離線夾具的假 driver 也會拒絕未翻譯的 `?`。
  const q = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params);
  const dupes = await q(PG_DUPLICATE_TAGS_SQL);
  for (const row of dupes.rows) {
    const extra = await q(PG_TAGS_WITH_NAME_SQL, [row.user_id, row.name, row.keep_id]);
    for (const dup of extra.rows) {
      await q(PG_REPOINT_TAG_MAP_SQL, [row.keep_id, dup.id]);
      await q(DELETE_TAG_MAP_BY_TAG_SQL, [dup.id]);
      await q(PG_DELETE_DUPLICATE_TAG_SQL, [dup.id]);
    }
  }
}

async function pgHandle(options = {}) {
  const exec = await pgExec(options);
  if (!options.exec) await ensureMemberMediaStoreOnce(options.pgDriver || (await sharedPgDriver()));
  return exec;
}

async function withFallback(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres(await pgHandle(options));
  } catch (error) {
    if (!sqliteFallbackAllowed(options)) throw error;
    return runSqlite();
  }
}

async function withFallbackTx(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = options.exec;
      return await runPostgres((sql, params = []) => Promise.resolve(injected(sql, params)).then(rowsOf));
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureMemberMediaStoreOnce(pgDriver);
    return await pgDriver.withTransaction(async (client) => {
      const exec = (sql, params = []) => client.query(toPostgresSql(sql), params).then((res) => res.rows);
      return runPostgres(exec);
    });
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return runSqlite();
  }
}

// 唯一的違反：PG 是 23505，SQLite 夾具是 SQLITE_CONSTRAINT。
// 只有「真的是重複」才轉成 409，其他錯誤照原樣往上丟——同步版是 catch 全部再轉 409，
// 那會把「連線斷了」也報成「已有同名標籤」，在 PG 上不能照抄。
function isDuplicate(error) {
  return error?.code === "23505" || /UNIQUE constraint failed|duplicate key/i.test(String(error?.message || ""));
}

// `memberMedia.js saveMemberMedia()` 的 PG 版（第六十二批）：照片上傳。
//
// 🚨 這是`POST /api/media` 的實作，同步版用 `BEGIN IMMEDIATE` 把「配額檢查 ＋ INSERT」包起來
// （序列化並發上傳）。PG 版用 `withFallbackTx()`（真的交易）；**配額檢查一定要在交易內**，
// 否則兩個並行上傳會各自通過檢查、都寫入 ⇒ 超過方案上限。
//
// ⚠️ 檔案與 CDN 物件的生命週期必須跟著交易成敗：
//   - 交易成功 → 保留
//   - 交易失敗 → 刪掉剛寫的檔與剛上傳的物件（同步版就是這樣，`_o.jpg` 原圖刻意不上 CDN）
// 這一支刻意**不**走 `sqliteFallbackAllowed` 的 fail-open：寫入失敗要往上丟（政策是 fail-closed）。
export const MEDIA_INSERT_SQL = `INSERT INTO member_media(user_id, storage_key, thumb_key, original_key, original_name, mime, format, width, height, bytes, digest, watermarked, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`;

export async function saveMemberMediaAsync(userId, buffer, {
  plan = "free",
  processor = normalizeImage,
  watermarker = applySiteWatermark,
  now = new Date(),
  originalName = "",
  ...options
} = {}) {
  const uid = Number(userId) || 0;
  if (!isPg(options)) {
    return saveMemberMediaSync(sqliteHandle(), uid, buffer, { plan, processor, watermarker, now, originalName });
  }
  const quota = mediaQuotaForPlan(plan);
  const processed = await processor(buffer);
  if (!processed?.main?.buffer?.length || !processed?.thumb?.buffer?.length) {
    const e = new Error("顯示圖處理失敗，未寫入損壞檔案");
    e.status = 500;
    e.code = "watermark_failed";
    throw e;
  }
  const marked = await watermarkPublicDerivative(watermarker, processed.main.buffer, {
    width: processed.main.width,
    height: processed.main.height,
  });
  const markedThumb = await watermarkPublicDerivative(watermarker, processed.thumb.buffer);
  const key = randomBytes(16).toString("hex");
  const mainName = `${key}.jpg`;
  const thumbName = `${key}_t.jpg`;
  const originalNameKey = `${key}_o.jpg`;
  const dir = memberMediaDir();
  const ts = stampOf(now);
  let wroteFiles = false;

  const cleanup = async () => {
    if (wroteFiles) {
      for (const n of [mainName, thumbName, originalNameKey]) {
        try { const p = path.join(dir, n); if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
      }
    }
    await deleteMemberMediaObjects([mainName, thumbName]).catch(() => {});
  };

  try {
    const id = await withFallbackTx(options, async (exec) => {
      const used = countOf(await exec(COUNT_ACTIVE_MEDIA_SQL, [uid]));
      if (used >= quota) {
        // 配額是**業務錯誤**（409），不該被 fallback 吞掉或改判 ⇒ 帶 status 往上丟。
        throw httpError(`照片素材庫已達上限（${quota} 張）。可刪除舊照片或升級贊助會員（100 張）。`, 409, "quota_exceeded");
      }
      writeFileSync(path.join(dir, originalNameKey), processed.main.buffer);
      writeFileSync(path.join(dir, mainName), marked.buffer);
      writeFileSync(path.join(dir, thumbName), markedThumb.buffer);
      wroteFiles = true;
      // r2 模式下失敗＝整筆失敗：寧可請使用者重試，也不要出現「DB 有、CDN 沒有」的圖。
      await putMemberMediaObjects([
        { name: mainName, buffer: marked.buffer },
        { name: thumbName, buffer: markedThumb.buffer },
      ]);
      const row = firstRow(await exec(MEDIA_INSERT_SQL, [
        uid, mainName, thumbName, originalNameKey, safeName(originalName),
        processed.mime, processed.format, processed.main.width, processed.main.height,
        marked.buffer.length, processed.digest, marked.watermarked ? 1 : 0, ts,
      ]));
      return Number(row?.id) || 0;
    }, () => saveMemberMediaSync(sqliteHandle(), uid, buffer, { plan, processor, watermarker, now, originalName }));
    return await getOwnedMediaAsync(uid, id, options);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// ---- 讀取 ----

export async function countActiveMediaAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  return withFallback(
    options,
    async (exec) => countOf(await exec(COUNT_ACTIVE_MEDIA_SQL, [uid])),
    () => countActiveMediaSync(sqliteHandle(), uid),
  );
}

async function tagsByMediaIds(exec, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await exec(TAGS_FOR_MEDIA_IDS_SQL.replace("%s", placeholders(ids.length)), ids);
  for (const row of rows) {
    const key = Number(row.media_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id: Number(row.id), name: row.name });
  }
  return map;
}

export async function listMemberMediaAsync(userId, { plan = "free", tagIds = [], ...options } = {}) {
  const uid = Number(userId);
  return withFallback(
    options,
    async (exec) => {
      let rows = await exec(LIST_MEDIA_SQL, [uid]);
      const wanted = uniqIds(tagIds);
      if (wanted.length) {
        const matched = new Set(
          (await exec(MEDIA_IDS_FOR_TAGS_SQL.replace("%s", placeholders(wanted.length)), wanted))
            .map((r) => Number(r.media_id)),
        );
        rows = rows.filter((row) => matched.has(Number(row.id)));
      }
      const tags = await tagsByMediaIds(exec, rows.map((r) => Number(r.id)));
      return {
        quota: mediaQuotaForPlan(plan),
        used: countOf(await exec(COUNT_ACTIVE_MEDIA_SQL, [uid])),
        items: rows.map((row) => publicMediaShape(row, tags.get(Number(row.id)) || [])).filter(Boolean),
      };
    },
    () => listMemberMediaSync(sqliteHandle(), uid, { plan, tagIds }),
  );
}

export async function listMediaTagsAsync(userId, options = {}) {
  const uid = Number(userId);
  return withFallback(
    options,
    async (exec) => (await exec(LIST_TAGS_SQL, [uid])).map(publicTag),
    () => listMediaTagsSync(sqliteHandle(), uid),
  );
}

export async function mediaUrlsForTagIdsAsync(userId, tagIds = [], options = {}) {
  const uid = Number(userId);
  const wanted = uniqIds(tagIds);
  if (!wanted.length) return [];
  const listed = await listMemberMediaAsync(uid, { ...options, tagIds: wanted });
  return listed.items.map((item) => item.url);
}

export async function getOwnedMediaAsync(userId, id, options = {}) {
  const uid = Number(userId);
  return withFallback(
    options,
    async (exec) => {
      const row = firstRow(await exec(MEDIA_BY_ID_OWNED_SQL, [Number(id), uid]));
      if (!row) return null;
      const tags = await tagsByMediaIds(exec, [Number(row.id)]);
      return publicMediaShape(row, tags.get(Number(row.id)) || []);
    },
    () => getOwnedMediaSync(sqliteHandle(), uid, id),
  );
}

// 供刊登時驗證「這張照片是本人的」（`db.js:assertOwnsMemberMediaUrls` 目前仍是同步版，
// 這一支先備好，等站內刊登的寫入批次一起接）。
export async function ownsMediaUrlAsync(userId, url, options = {}) {
  const key = mediaKeyFromUrl(url);
  if (!key) return false;
  const uid = Number(userId) || 0;
  return withFallback(
    options,
    async (exec) => Boolean(firstRow(await exec(OWNS_MEDIA_URL_SQL, [key, uid]))),
    () => ownsMediaUrlSync(sqliteHandle(), uid, url),
  );
}

// ---- 標籤寫入 ----

export async function createMediaTagAsync(userId, name, { now = new Date(), ...options } = {}) {
  const uid = Number(userId) || 0;
  const label = tagName(name); // 純驗證，兩邊共用同一份
  const ts = stampOf(now);
  return withFallbackTx(options, async (exec) => {
    try {
      const row = firstRow(await exec(INSERT_TAG_SQL, [uid, label, ts]));
      return { id: Number(row.id), name: label, created_at: ts };
    } catch (error) {
      const existing = firstRow(await exec(TAG_BY_NAME_SQL, [uid, label]));
      if (existing) return { ...publicTag(existing), reused: true };
      if (isDuplicate(error)) throw httpError("無法建立標籤");
      throw error;
    }
  }, () => createMediaTagSync(sqliteHandle(), uid, name, now));
}

export async function renameMediaTagAsync(userId, id, name, options = {}) {
  const uid = Number(userId) || 0;
  const label = tagName(name);
  return withFallbackTx(options, async (exec) => {
    const row = firstRow(await exec(TAG_BY_ID_OWNED_SQL, [Number(id), uid]));
    if (!row) throw httpError("找不到標籤或無權限", 404);
    try {
      await exec(RENAME_TAG_SQL, [label, Number(id), uid]);
    } catch (error) {
      if (isDuplicate(error)) throw httpError("已有同名標籤", 409, "tag_exists");
      throw error;
    }
    return { id: Number(id), name: label, created_at: row.created_at };
  }, () => renameMediaTagSync(sqliteHandle(), uid, id, name));
}

export async function deleteMediaTagAsync(userId, id, options = {}) {
  const uid = Number(userId) || 0;
  return withFallbackTx(options, async (exec) => {
    const row = firstRow(await exec(TAG_ID_OWNED_SQL, [Number(id), uid]));
    if (!row) throw httpError("找不到標籤或無權限", 404);
    await exec(DELETE_TAG_MAP_BY_TAG_SQL, [Number(id)]);
    await exec(DELETE_TAG_SQL, [Number(id), uid]);
    return { deleted: true };
  }, () => deleteMediaTagSync(sqliteHandle(), uid, id));
}

export async function setMediaTagsAsync(userId, mediaId, tagIds = [], options = {}) {
  const uid = Number(userId) || 0;
  const ids = uniqIds(tagIds);
  return withFallbackTx(options, async (exec) => {
    const media = firstRow(await exec(MEDIA_BY_ID_OWNED_SQL, [Number(mediaId), uid]));
    if (!media) throw httpError("找不到照片或無權限", 404);
    for (const tagId of ids) {
      const tag = firstRow(await exec(TAG_ID_OWNED_SQL, [tagId, uid]));
      if (!tag) throw httpError("找不到標籤或無權限", 404);
    }
    await exec(DELETE_TAG_MAP_BY_MEDIA_SQL, [Number(mediaId)]);
    // ON CONFLICT DO NOTHING 讓重複的 tag id 不會炸（`uniqIds` 已經去重，這裡是保險）。
    for (const tagId of ids) await exec(`${INSERT_TAG_MAP_SQL} ON CONFLICT DO NOTHING`, [Number(mediaId), tagId]);
    const fresh = firstRow(await exec(MEDIA_BY_ID_OWNED_SQL, [Number(mediaId), uid]));
    const tags = await tagsByMediaIds(exec, [Number(mediaId)]);
    return publicMediaShape(fresh, tags.get(Number(mediaId)) || []);
  }, () => setMediaTagsSync(sqliteHandle(), uid, mediaId, tagIds));
}

// ---- 刪除素材 ----

export async function deleteMemberMediaAsync(userId, id, { now = new Date(), ...options } = {}) {
  const uid = Number(userId) || 0;
  const ts = stampOf(now);
  // 檔案／CDN 的清理是 best-effort，而且**刻意等交易提交之後才做**：
  // 在交易裡刪檔，一旦交易 rollback 就會出現「DB 還留著、檔案已經沒了」的破圖。
  let pendingCleanup = null;
  const result = await withFallbackTx(options, async (exec) => {
    const row = firstRow(await exec(MEDIA_BY_ID_SQL, [Number(id), uid]));
    if (!row) throw httpError("找不到照片或無權限", 404);
    if (row.deleted_at) return { deleted: true, idempotent: true };
    const url = `${MEDIA_PUBLIC_PREFIX}${row.storage_key}`;
    const referenced = Boolean(firstRow(await exec(IS_MEDIA_REFERENCED_SQL, [url, `%${url}%`])));
    await exec(SOFT_DELETE_MEDIA_SQL, [ts, Number(id), uid]);
    await exec(DELETE_TAG_MAP_BY_MEDIA_SQL, [Number(id)]);
    if (!referenced) pendingCleanup = row;
    return { deleted: true, kept_file: referenced };
  }, () => deleteMemberMediaSync(sqliteHandle(), uid, id, { now }));
  // sqlite 分支由同步函式自己清；PG 分支的交易已提交（或根本沒開）才輪到這裡。
  if (pendingCleanup) removeMediaArtifacts(pendingCleanup);
  return result;
}
