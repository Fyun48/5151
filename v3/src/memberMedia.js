import { createReadStream, existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { applySiteWatermark, normalizeImage } from "./imageProcess.js";

// 會員照片素材庫（member media library）。
// 配額為「素材庫總量」：一般會員 30、贊助會員 100（≠ 單一物件照片數）。
// 所有權明確：只有本人可瀏覽/使用/刪除自己的素材；不信任 client 傳來的 media id/url。

export const MEDIA_QUOTA = { free: 30, sponsor: 100 };
export const MEDIA_PUBLIC_PREFIX = "/media/lib/";

export function mediaQuotaForPlan(plan) {
  return plan === "sponsor" ? MEDIA_QUOTA.sponsor : MEDIA_QUOTA.free;
}

function dataDir() { return process.env.DATA_DIR || path.join(process.cwd(), "data-v3"); }
export function memberMediaDir() {
  const dir = path.join(dataDir(), "member-media");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureMemberMediaSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      thumb_key TEXT,
      original_key TEXT,
      original_name TEXT,
      mime TEXT NOT NULL,
      format TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      bytes INTEGER,
      digest TEXT,
      watermarked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_member_media_user ON member_media(user_id, deleted_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_member_media_key ON member_media(storage_key);
    CREATE TABLE IF NOT EXISTS media_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, name)
    );
    CREATE TABLE IF NOT EXISTS media_tag_map (
      media_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (media_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_tags_user ON media_tags(user_id, name);
    CREATE INDEX IF NOT EXISTS idx_media_tag_map_tag ON media_tag_map(tag_id);
  `);
  for (const sql of [
    "ALTER TABLE member_media ADD COLUMN original_key TEXT",
    "ALTER TABLE member_media ADD COLUMN watermarked INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { db.exec(sql); } catch { /* already exists */ }
  }
}

const PUBLIC_KEY_RE = /^[a-f0-9]{32}(_t)?\.jpg$/;
const INTERNAL_ORIGINAL_RE = /^[a-f0-9]{32}_o\.jpg$/;

function safeMediaName(name, re) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  return re.test(base) ? base : "";
}

function resolveMediaFile(name, re) {
  const file = safeMediaName(name, re);
  if (!file) return "";
  const full = path.join(memberMediaDir(), file);
  return existsSync(full) ? full : "";
}

// 公開可服務的顯示檔（主圖／縮圖）。不含未浮水印 original。
export function memberMediaDiskName(name) {
  return safeMediaName(name, PUBLIC_KEY_RE);
}
export function memberMediaPublicName(name) {
  return memberMediaDiskName(name);
}
export function memberMediaInternalOriginalName(name) {
  return safeMediaName(name, INTERNAL_ORIGINAL_RE);
}
export function isMemberMediaUrl(value) {
  return /^\/media\/lib\/[a-f0-9]{32}\.jpg$/.test(String(value || "").trim());
}
export function mediaKeyFromUrl(url) {
  const m = String(url || "").trim().match(/^\/media\/lib\/([a-f0-9]{32}\.jpg)$/);
  return m ? m[1] : "";
}
export function memberMediaPublicFilePath(name) {
  return resolveMediaFile(name, PUBLIC_KEY_RE);
}
// 公開路由專用；與 memberMediaPublicFilePath 相同，絕不解析 *_o.jpg。
export function memberMediaFilePath(name) {
  return memberMediaPublicFilePath(name);
}
// 僅供內部重處理讀取未浮水印 original；不得接到公開路由。
export function memberMediaInternalOriginalPath(name) {
  return resolveMediaFile(name, INTERNAL_ORIGINAL_RE);
}

export function servePublicMemberMedia(req, res) {
  const full = memberMediaPublicFilePath(req.params?.file);
  if (!full) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  createReadStream(path.resolve(full)).pipe(res);
}

function mediaTagsFor(db, mediaId) {
  return db.prepare(
    `SELECT t.id, t.name FROM media_tag_map m
     JOIN media_tags t ON t.id = m.tag_id
     WHERE m.media_id=?
     ORDER BY t.name COLLATE NOCASE`,
  ).all(Number(mediaId)).map((row) => ({ id: Number(row.id), name: row.name }));
}

function publicMedia(row, db = null) {
  const key = memberMediaPublicName(row.storage_key);
  if (!key) return null;
  const id = String(key).replace(/\.jpg$/, "");
  return {
    id: Number(row.id),
    url: `${MEDIA_PUBLIC_PREFIX}${key}`,
    thumb_url: `${MEDIA_PUBLIC_PREFIX}${id}_t.jpg`,
    mime: row.mime, format: row.format,
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    bytes: row.bytes == null ? null : Number(row.bytes),
    watermarked: Number(row.watermarked) === 1,
    created_at: row.created_at,
    tags: db ? mediaTagsFor(db, row.id) : [],
  };
}

export function countActiveMedia(db, userId) {
  return Number(db.prepare("SELECT COUNT(*) n FROM member_media WHERE user_id=? AND deleted_at IS NULL").get(Number(userId)).n) || 0;
}

export function listMemberMedia(db, userId, { plan = "free", tagIds = [] } = {}) {
  const uid = Number(userId);
  let rows = db.prepare("SELECT * FROM member_media WHERE user_id=? AND deleted_at IS NULL ORDER BY id DESC").all(uid);
  const wanted = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(Number).filter((n) => n > 0))];
  if (wanted.length) {
    const placeholders = wanted.map(() => "?").join(",");
    const matched = new Set(
      db.prepare(`SELECT DISTINCT media_id FROM media_tag_map WHERE tag_id IN (${placeholders})`).all(...wanted).map((r) => Number(r.media_id)),
    );
    rows = rows.filter((row) => matched.has(Number(row.id)));
  }
  return { quota: mediaQuotaForPlan(plan), used: countActiveMedia(db, uid), items: rows.map((row) => publicMedia(row, db)).filter(Boolean) };
}

export function getOwnedMedia(db, userId, id) {
  const row = db.prepare("SELECT * FROM member_media WHERE id=? AND user_id=? AND deleted_at IS NULL").get(Number(id), Number(userId));
  return row ? publicMedia(row, db) : null;
}

// 依 url 驗證「本人擁有且有效」的素材（供刊登時挑選、擋盜連他人 media）。
export function ownsMediaUrl(db, userId, url) {
  const key = mediaKeyFromUrl(url);
  if (!key) return false;
  const row = db.prepare("SELECT id FROM member_media WHERE storage_key=? AND user_id=? AND deleted_at IS NULL").get(key, Number(userId));
  return Boolean(row);
}

// 是否被任何站內刊登（含已關閉/歷史）引用 → 引用中則保留實體檔，避免破壞歷史顯示。
export function isMediaReferenced(db, url) {
  const like = `%${url}%`;
  const row = db.prepare("SELECT 1 FROM listings WHERE source='self' AND (cover=? OR self_photos LIKE ?) LIMIT 1").get(url, like);
  return Boolean(row);
}

// 建立素材：先處理（CPU，於交易外）→ 交易內再檢查配額並寫入（避免並發超額）→ 落檔。
export async function saveMemberMedia(db, userId, buffer, {
  plan = "free",
  processor = normalizeImage,
  watermarker = applySiteWatermark,
  now = new Date(),
  originalName = "",
} = {}) {
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
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();

  // 交易內配額檢查 + insert（BEGIN IMMEDIATE 取寫鎖，序列化並發上傳）。
  db.exec("BEGIN IMMEDIATE");
  let id;
  try {
    const used = countActiveMedia(db, userId);
    if (used >= quota) {
      db.exec("ROLLBACK");
      const e = new Error(`照片素材庫已達上限（${quota} 張）。可刪除舊照片或升級贊助會員（100 張）。`);
      e.status = 409; e.code = "quota_exceeded";
      throw e;
    }
    writeFileSync(path.join(dir, originalNameKey), processed.main.buffer);
    writeFileSync(path.join(dir, mainName), marked.buffer);
    writeFileSync(path.join(dir, thumbName), markedThumb.buffer);
    const res = db.prepare(
      `INSERT INTO member_media(user_id, storage_key, thumb_key, original_key, original_name, mime, format, width, height, bytes, digest, watermarked, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      Number(userId), mainName, thumbName, originalNameKey, safeName(originalName),
      processed.mime, processed.format, processed.main.width, processed.main.height,
      marked.buffer.length, processed.digest, marked.watermarked ? 1 : 0, ts,
    );
    id = Number(res.lastInsertRowid);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    for (const n of [mainName, thumbName, originalNameKey]) { try { const p = path.join(dir, n); if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ } }
    throw err;
  }
  return getOwnedMedia(db, userId, id);
}

// 重試顯示圖：已浮水印則略過；失敗不覆寫既有成功檔。
export async function reprocessMemberMediaDisplay(db, userId, id, { watermarker = applySiteWatermark } = {}) {
  const row = db.prepare("SELECT * FROM member_media WHERE id=? AND user_id=? AND deleted_at IS NULL").get(Number(id), Number(userId));
  if (!row) { const e = new Error("找不到照片或無權限"); e.status = 404; throw e; }
  if (Number(row.watermarked) === 1) return { ...publicMedia(row, db), skipped: true };
  const srcPath = resolveInternalOriginalSource(row);
  if (!srcPath) { const e = new Error("找不到原始檔，無法重試"); e.status = 404; throw e; }
  const src = readFileSync(srcPath);
  const marked = await watermarkPublicDerivative(watermarker, src, { width: row.width, height: row.height });
  const thumbKey = memberMediaPublicName(row.thumb_key) || "";
  const existingThumb = thumbKey ? memberMediaPublicFilePath(thumbKey) : "";
  const markedThumb = existingThumb
    ? await watermarkPublicDerivative(watermarker, readFileSync(existingThumb))
    : null;
  const dir = memberMediaDir();
  writeFileSync(path.join(dir, row.storage_key), marked.buffer);
  if (thumbKey && markedThumb) writeFileSync(path.join(dir, thumbKey), markedThumb.buffer);
  db.prepare("UPDATE member_media SET watermarked=1, bytes=? WHERE id=? AND user_id=?").run(marked.buffer.length, Number(id), Number(userId));
  return { ...getOwnedMedia(db, userId, id), skipped: false };
}

// 刪除：驗本人；釋放配額（soft delete）；若無任何刊登引用才移除實體檔（引用中則保留，維持歷史顯示）。
export function deleteMemberMedia(db, userId, id, { now = new Date() } = {}) {
  const row = db.prepare("SELECT * FROM member_media WHERE id=? AND user_id=?").get(Number(id), Number(userId));
  if (!row) { const e = new Error("找不到照片或無權限"); e.status = 404; throw e; }
  if (row.deleted_at) return { deleted: true, idempotent: true };
  const url = `${MEDIA_PUBLIC_PREFIX}${row.storage_key}`;
  const referenced = isMediaReferenced(db, url);
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  db.prepare("UPDATE member_media SET deleted_at=? WHERE id=? AND user_id=?").run(ts, Number(id), Number(userId));
  db.prepare("DELETE FROM media_tag_map WHERE media_id=?").run(Number(id));
  if (!referenced) {
    for (const n of [
      memberMediaPublicName(row.storage_key),
      memberMediaPublicName(row.thumb_key),
      memberMediaInternalOriginalName(row.original_key),
    ].filter(Boolean)) {
      try { const p = path.join(memberMediaDir(), n); if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
  }
  return { deleted: true, kept_file: referenced };
}

function httpError(message, status = 400, code = "") {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function tagName(value) {
  const name = String(value || "").replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) throw httpError("請填標籤名稱");
  return name;
}

export function listMediaTags(db, userId) {
  return db.prepare("SELECT id, name, created_at FROM media_tags WHERE user_id=? ORDER BY name COLLATE NOCASE").all(Number(userId))
    .map((row) => ({ id: Number(row.id), name: row.name, created_at: row.created_at }));
}

export function createMediaTag(db, userId, name, now = new Date()) {
  const label = tagName(name);
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  try {
    const res = db.prepare("INSERT INTO media_tags(user_id, name, created_at) VALUES (?,?,?)").run(Number(userId), label, ts);
    return { id: Number(res.lastInsertRowid), name: label, created_at: ts };
  } catch {
    const row = db.prepare("SELECT id, name, created_at FROM media_tags WHERE user_id=? AND name=?").get(Number(userId), label);
    if (row) return { id: Number(row.id), name: row.name, created_at: row.created_at, reused: true };
    throw httpError("無法建立標籤");
  }
}

export function renameMediaTag(db, userId, id, name) {
  const row = db.prepare("SELECT * FROM media_tags WHERE id=? AND user_id=?").get(Number(id), Number(userId));
  if (!row) throw httpError("找不到標籤或無權限", 404);
  const label = tagName(name);
  try {
    db.prepare("UPDATE media_tags SET name=? WHERE id=? AND user_id=?").run(label, Number(id), Number(userId));
  } catch {
    throw httpError("已有同名標籤", 409, "tag_exists");
  }
  return { id: Number(id), name: label, created_at: row.created_at };
}

export function deleteMediaTag(db, userId, id) {
  const row = db.prepare("SELECT id FROM media_tags WHERE id=? AND user_id=?").get(Number(id), Number(userId));
  if (!row) throw httpError("找不到標籤或無權限", 404);
  db.prepare("DELETE FROM media_tag_map WHERE tag_id=?").run(Number(id));
  db.prepare("DELETE FROM media_tags WHERE id=? AND user_id=?").run(Number(id), Number(userId));
  return { deleted: true };
}

export function setMediaTags(db, userId, mediaId, tagIds = []) {
  const media = db.prepare("SELECT id FROM member_media WHERE id=? AND user_id=? AND deleted_at IS NULL").get(Number(mediaId), Number(userId));
  if (!media) throw httpError("找不到照片或無權限", 404);
  const ids = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(Number).filter((n) => n > 0))];
  for (const tagId of ids) {
    const tag = db.prepare("SELECT id FROM media_tags WHERE id=? AND user_id=?").get(tagId, Number(userId));
    if (!tag) throw httpError("找不到標籤或無權限", 404);
  }
  db.prepare("DELETE FROM media_tag_map WHERE media_id=?").run(Number(mediaId));
  const ins = db.prepare("INSERT INTO media_tag_map(media_id, tag_id) VALUES (?,?)");
  for (const tagId of ids) ins.run(Number(mediaId), tagId);
  return getOwnedMedia(db, userId, mediaId);
}

export function mediaUrlsForTagIds(db, userId, tagIds = []) {
  const wanted = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(Number).filter((n) => n > 0))];
  if (!wanted.length) return [];
  const listed = listMemberMedia(db, userId, { tagIds: wanted });
  return listed.items.map((item) => item.url);
}

function safeName(name) {
  return String(name || "").replace(/[\r\n\t]/g, " ").replace(/[^\w.\-\u4e00-\u9fff ]/g, "").slice(0, 120);
}

async function watermarkPublicDerivative(watermarker, buffer, dims = {}) {
  const marked = await watermarker(buffer, { ...dims, watermarked: 0 });
  if (!marked?.buffer?.length) {
    const e = new Error("顯示圖處理失敗，未寫入損壞檔案");
    e.status = 500;
    e.code = "watermark_failed";
    throw e;
  }
  return marked;
}

function resolveInternalOriginalSource(row) {
  const fromPrivate = memberMediaInternalOriginalPath(row.original_key);
  if (fromPrivate) return fromPrivate;
  return memberMediaPublicFilePath(row.storage_key);
}

