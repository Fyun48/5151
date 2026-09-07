import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { normalizeImage } from "./imageProcess.js";

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
      original_name TEXT,
      mime TEXT NOT NULL,
      format TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      bytes INTEGER,
      digest TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_member_media_user ON member_media(user_id, deleted_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_member_media_key ON member_media(storage_key);
  `);
}

const KEY_RE = /^[a-f0-9]{32}(_t)?\.jpg$/;
export function memberMediaDiskName(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  return KEY_RE.test(base) ? base : "";
}
export function isMemberMediaUrl(value) {
  return /^\/media\/lib\/[a-f0-9]{32}\.jpg$/.test(String(value || "").trim());
}
export function mediaKeyFromUrl(url) {
  const m = String(url || "").trim().match(/^\/media\/lib\/([a-f0-9]{32}\.jpg)$/);
  return m ? m[1] : "";
}
export function memberMediaFilePath(name) {
  const file = memberMediaDiskName(name);
  if (!file) return "";
  const full = path.join(memberMediaDir(), file);
  return existsSync(full) ? full : "";
}
function publicMedia(row) {
  const key = row.storage_key;
  const id = String(key).replace(/\.jpg$/, "");
  return {
    id: Number(row.id),
    url: `${MEDIA_PUBLIC_PREFIX}${key}`,
    thumb_url: `${MEDIA_PUBLIC_PREFIX}${id}_t.jpg`,
    mime: row.mime, format: row.format,
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    bytes: row.bytes == null ? null : Number(row.bytes),
    created_at: row.created_at,
  };
}

export function countActiveMedia(db, userId) {
  return Number(db.prepare("SELECT COUNT(*) n FROM member_media WHERE user_id=? AND deleted_at IS NULL").get(Number(userId)).n) || 0;
}

export function listMemberMedia(db, userId, { plan = "free" } = {}) {
  const rows = db.prepare("SELECT * FROM member_media WHERE user_id=? AND deleted_at IS NULL ORDER BY id DESC").all(Number(userId));
  return { quota: mediaQuotaForPlan(plan), used: rows.length, items: rows.map(publicMedia) };
}

export function getOwnedMedia(db, userId, id) {
  const row = db.prepare("SELECT * FROM member_media WHERE id=? AND user_id=? AND deleted_at IS NULL").get(Number(id), Number(userId));
  return row ? publicMedia(row) : null;
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
export async function saveMemberMedia(db, userId, buffer, { plan = "free", processor = normalizeImage, now = new Date(), originalName = "" } = {}) {
  const quota = mediaQuotaForPlan(plan);
  const processed = await processor(buffer);
  const key = randomBytes(16).toString("hex");
  const mainName = `${key}.jpg`;
  const thumbName = `${key}_t.jpg`;
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
    writeFileSync(path.join(dir, mainName), processed.main.buffer);
    writeFileSync(path.join(dir, thumbName), processed.thumb.buffer);
    const res = db.prepare(
      `INSERT INTO member_media(user_id, storage_key, thumb_key, original_name, mime, format, width, height, bytes, digest, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(Number(userId), mainName, thumbName, safeName(originalName), processed.mime, processed.format, processed.main.width, processed.main.height, processed.main.bytes, processed.digest, ts);
    id = Number(res.lastInsertRowid);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    // 清理可能已落的檔，避免孤兒檔。
    for (const n of [mainName, thumbName]) { try { const p = path.join(dir, n); if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ } }
    throw err;
  }
  return getOwnedMedia(db, userId, id);
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
  if (!referenced) {
    for (const n of [row.storage_key, row.thumb_key].filter(Boolean)) {
      try { const p = path.join(memberMediaDir(), n); if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
  }
  return { deleted: true, kept_file: referenced };
}

function safeName(name) {
  return String(name || "").replace(/[\r\n\t]/g, " ").replace(/[^\w.\-\u4e00-\u9fff ]/g, "").slice(0, 120);
}
