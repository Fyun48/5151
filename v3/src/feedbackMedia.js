/**
 * 意見回饋附圖（C3）。
 *
 * 為什麼不重用 `member_media`：
 *   1. `member_media` 是「會員素材庫」語意（配額、標籤、軟刪、會出現在會員自己的素材庫），
 *      拿來存回饋附件會讓附件跑到會員的素材庫裡。
 *   2. 它的公開檔掛在 `/media/lib/`，而 `auth.js publicPath()` 把該前綴列為**公開**路徑，
 *      R2 bucket 也是公開網域 —— 回饋附件（可能含截圖裡的個資）**不可以**公開。
 *
 * 因此附件自成一張表、自一個目錄，而且：
 *   - 只寫本機 `DATA_DIR/feedback-media/`，**不推 R2**（沒有 CDN 物件要清）。
 *   - **不掛 `express.static`**，`publicPath()` 也不得加入任何 feedback-attachment 字串。
 *   - 唯一的讀取入口是 `requireAdminApi` 的兩條 GET（縮圖／原圖）。
 *
 * 生命週期：先上傳（`feedback_id = 0`）→ 送出回饋時在同一筆交易內 claim 綁定。
 * 中途放棄（關掉對話框、網路斷線）留下的 `feedback_id = 0` 由
 * `sweepOrphanFeedbackAttachments()` 清掉。
 *
 * ⚠️ 與 OPS 服務的 `feedback_attachment` 同名但**不同資料庫、不同 FK**：`ops/src/opsDb.js`
 * 那張表指向 `ingested_feedback(id)`，跟這裡的 v3 `feedback(id)` 沒有關係。
 */

import { createReadStream, existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { detectImageSignature, normalizeImage, IMAGE_MAIN_MAX_EDGE, IMAGE_THUMB_MAX_EDGE } from "./imageProcess.js";

export const FEEDBACK_ATTACHMENT_MAX = 4;
/** 需求指定 1,000,000 bytes（十進位，不是 1 MiB）；剛好等於上限可以接受。 */
export const FEEDBACK_ATTACHMENT_MAX_BYTES = 1000000;
export const FEEDBACK_ATTACHMENT_MIMES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
export const FEEDBACK_ATTACHMENT_ORPHAN_MS = 24 * 60 * 60 * 1000;

function httpError(message, status = 400, code = "") {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), "data-v3");
}

export function feedbackMediaDir() {
  const dir = path.join(dataDir(), "feedback-media");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const MEDIA_NAME_RE = /^([a-f0-9]{32})(_t)?\.jpg$/;

/** 只接受本模組自己產生的檔名，避免路徑穿越（與 memberMedia 的 publicName 同一個做法）。 */
export function feedbackMediaName(name) {
  const m = MEDIA_NAME_RE.exec(String(name || ""));
  if (!m) return "";
  return m[0];
}

export function feedbackMediaFilePath(name) {
  const safe = feedbackMediaName(name);
  if (!safe) return "";
  return path.join(feedbackMediaDir(), safe);
}

export function ensureFeedbackMediaSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_attachment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feedback_id INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      thumb_key TEXT,
      mime TEXT NOT NULL,
      format TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      bytes INTEGER,
      digest TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_attachment_feedback ON feedback_attachment(feedback_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_attachment_user ON feedback_attachment(user_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_attachment_key ON feedback_attachment(storage_key);
  `);
}

/**
 * 權威驗證（不是只看副檔名或瀏覽器宣告的 MIME）：
 *   1. 大小上限；2. magic bytes；3. 只允許 PNG／JPEG／WebP（**明確拒絕 AVIF**）；
 *   4. 交給 sharp 真的解碼（`normalizeImage` 內含 `metadata()` 與兩次 `toBuffer()`）。
 * sharp 不在時 `normalizeImage` 會丟 503；這裡**不降級**成「只驗 magic bytes 就放行」。
 */
export async function validateFeedbackImage(buffer, { processor = normalizeImage } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError("請選擇圖片檔案", 400, "attachment_empty");
  if (buffer.length > FEEDBACK_ATTACHMENT_MAX_BYTES) {
    throw httpError(`每張圖片請在 ${FEEDBACK_ATTACHMENT_MAX_BYTES.toLocaleString("zh-TW")} bytes（約 1MB）以內`, 413, "attachment_too_large");
  }
  const sig = detectImageSignature(buffer);
  if (!sig) throw httpError("只接受 PNG、JPEG、WebP 圖片", 415, "attachment_unsupported");
  if (!FEEDBACK_ATTACHMENT_MIMES.includes(sig.mime)) {
    throw httpError("只接受 PNG、JPEG、WebP 圖片", 415, "attachment_unsupported");
  }
  const processed = await processor(buffer, { maxEdge: IMAGE_MAIN_MAX_EDGE, thumbEdge: IMAGE_THUMB_MAX_EDGE });
  if (!processed?.main?.buffer?.length || !processed?.thumb?.buffer?.length) {
    throw httpError("圖片處理失敗，請換一張再試", 500, "attachment_process_failed");
  }
  // 重壓後仍可能超過上限（極端大圖）：一樣拒絕，前後端用同一個數字。
  if (processed.main.buffer.length > FEEDBACK_ATTACHMENT_MAX_BYTES) {
    throw httpError(`每張圖片請在 ${FEEDBACK_ATTACHMENT_MAX_BYTES.toLocaleString("zh-TW")} bytes（約 1MB）以內`, 413, "attachment_too_large");
  }
  return processed;
}

export function countOpenFeedbackAttachments(db, userId) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM feedback_attachment WHERE user_id=? AND feedback_id=0 AND deleted_at IS NULL",
  ).get(Number(userId));
  return Number(row?.n) || 0;
}

/** 對外的附件形狀（同步版與 PG 島嶼共用同一份，避免兩邊漂移）。 */
export function publicAttachmentShape(row) {
  if (!row) return null;
  const id = Number(row.id);
  return {
    id,
    bytes: Number(row.bytes) || 0,
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    mime: String(row.mime || "image/jpeg"),
    thumb_url: `/api/feedback-attachments/${id}/thumb`,
    url: `/api/feedback-attachments/${id}`,
  };
}

/** 上傳一張：寫檔（主圖＋縮圖）→ 寫一列 `feedback_id = 0`。失敗時把已寫入的檔案清掉。 */
export async function saveFeedbackAttachment(db, userId, buffer, {
  processor = normalizeImage,
  now = new Date(),
} = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能上傳圖片", 401, "login_required");
  if (countOpenFeedbackAttachments(db, uid) >= FEEDBACK_ATTACHMENT_MAX) {
    throw httpError(`每則回饋最多 ${FEEDBACK_ATTACHMENT_MAX} 張圖片，請先刪除再上傳`, 409, "attachment_limit");
  }
  const processed = await validateFeedbackImage(buffer, { processor });
  const key = randomBytes(16).toString("hex");
  const mainName = `${key}.jpg`;
  const thumbName = `${key}_t.jpg`;
  const dir = feedbackMediaDir();
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  const written = [];
  try {
    writeFileSync(path.join(dir, mainName), processed.main.buffer);
    written.push(mainName);
    writeFileSync(path.join(dir, thumbName), processed.thumb.buffer);
    written.push(thumbName);
    const res = db.prepare(
      `INSERT INTO feedback_attachment(user_id, storage_key, thumb_key, mime, format, width, height, bytes, digest, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      uid, mainName, thumbName, processed.mime, processed.format,
      processed.main.width, processed.main.height, processed.main.buffer.length, processed.digest, ts,
    );
    return publicAttachmentShape(db.prepare("SELECT * FROM feedback_attachment WHERE id=?").get(Number(res.lastInsertRowid)));
  } catch (err) {
    for (const name of written) {
      try { unlinkSync(path.join(dir, name)); } catch { /* 清不掉就算了，sweep 會處理 */ }
    }
    throw err;
  }
}

/** 一次抓多則回饋的附件（後台列表用；避免 N+1）。回傳 Map<feedbackId, rows>。 */
export function listFeedbackAttachmentsFor(db, feedbackIds) {
  const ids = [...new Set((Array.isArray(feedbackIds) ? feedbackIds : []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map();
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM feedback_attachment WHERE feedback_id IN (${marks}) AND deleted_at IS NULL ORDER BY id ASC`,
  ).all(...ids);
  for (const row of rows) {
    const key = Number(row.feedback_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(publicAttachmentShape(row));
  }
  return out;
}

/** 我目前還沒送出的附件（依 id 排序）。用於「已達上限」時讓使用者自己挑要刪的。 */
export function listOpenFeedbackAttachments(db, userId) {
  return db.prepare(
    "SELECT * FROM feedback_attachment WHERE user_id=? AND feedback_id=0 AND deleted_at IS NULL ORDER BY id ASC",
  ).all(Number(userId)).map(publicAttachmentShape);
}

export function getFeedbackAttachment(db, id) {
  return db.prepare("SELECT * FROM feedback_attachment WHERE id=? AND deleted_at IS NULL").get(Number(id)) || null;
}

export function listFeedbackAttachments(db, feedbackId) {
  return db.prepare(
    "SELECT * FROM feedback_attachment WHERE feedback_id=? AND deleted_at IS NULL ORDER BY id ASC",
  ).all(Number(feedbackId)).map(publicAttachmentShape);
}

/**
 * 送出回饋時，把「自己的、還沒綁定的」附件綁到這則回饋上。
 * 必須在 createFeedback 的**同一個交易**內呼叫；影響列數不等於要求數量時整筆 rollback，
 * 這樣就不會出現「回饋有寫、附件沒綁」的半套狀態。
 */
export function claimFeedbackAttachments(db, userId, ids, feedbackId, now = new Date()) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!list.length) return 0;
  const marks = list.map(() => "?").join(",");
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  const res = db.prepare(
    `UPDATE feedback_attachment SET feedback_id=?, claimed_at=?
     WHERE id IN (${marks}) AND user_id=? AND feedback_id=0 AND deleted_at IS NULL`,
    // ⚠️ 參數順序必須對上 SQL 的 `?` 出現順序：feedback_id、claimed_at、id IN (…)、user_id。
    // 這裡踩過一次：把 userId 寫在 ...list 前面，於是 id 收到 userId、user_id 收到第一個附件 id，
    // 影響列數永遠是 0 ⇒ 每一筆回饋送出都被誤判成「附件已失效」。
  ).run(Number(feedbackId), ts, ...list, Number(userId));
  if (Number(res.changes) !== list.length) {
    throw httpError("附件已失效，請重新上傳", 409, "attachment_stale");
  }
  return list.length;
}

/** 刪除單張（只有本人、且還沒綁到回饋上時可以刪）。 */
export function deleteFeedbackAttachment(db, userId, id, { now = new Date() } = {}) {
  const row = db.prepare(
    "SELECT * FROM feedback_attachment WHERE id=? AND user_id=? AND feedback_id=0 AND deleted_at IS NULL",
  ).get(Number(id), Number(userId));
  if (!row) throw httpError("找不到這張圖片，或已經送出回饋", 404, "attachment_not_found");
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  db.prepare("UPDATE feedback_attachment SET deleted_at=? WHERE id=?").run(ts, Number(row.id));
  removeFeedbackAttachmentFiles(row);
  return { ok: true, id: Number(row.id) };
}

export function removeFeedbackAttachmentFiles(row) {
  const dir = feedbackMediaDir();
  for (const name of [row?.storage_key, row?.thumb_key]) {
    const safe = feedbackMediaName(name);
    if (!safe) continue;
    try { unlinkSync(path.join(dir, safe)); } catch { /* 檔案可能已不存在 */ }
  }
}

/** 站方讀取用的檔案路徑（路由必須先過 `requireAdminApi`；私有快取，不進 CDN）。 */
export function feedbackAttachmentFilePath(row, { thumb = false } = {}) {
  const name = thumb ? row?.thumb_key : row?.storage_key;
  const full = name ? feedbackMediaFilePath(name) : "";
  return full && existsSync(full) ? full : "";
}

/** 串流一張附件給回應；找不到檔案就 404 空 body。 */
export function streamFeedbackAttachment(row, res, { thumb = false } = {}) {
  const full = feedbackAttachmentFilePath(row, { thumb });
  if (!full) {
    res.statusCode = 404;
    res.end();
    return false;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", String(row?.mime || "image/jpeg"));
  res.setHeader("Cache-Control", "private, no-store");
  createReadStream(path.resolve(full)).pipe(res);
  return true;
}

/** 清掉逾時未綁定的孤兒（使用者中途放棄）。已綁定的一律不動。 */
export function sweepOrphanFeedbackAttachments(db, { olderThanMs = FEEDBACK_ATTACHMENT_ORPHAN_MS, now = new Date() } = {}) {
  const ts = (now instanceof Date ? now : new Date(now)).getTime();
  const cutoff = new Date(ts - Math.max(0, Number(olderThanMs) || 0)).toISOString();
  const rows = db.prepare(
    "SELECT * FROM feedback_attachment WHERE feedback_id=0 AND deleted_at IS NULL AND created_at < ?",
  ).all(cutoff);
  let removed = 0;
  for (const row of rows) {
    try {
      db.prepare("UPDATE feedback_attachment SET deleted_at=? WHERE id=?").run(new Date(ts).toISOString(), Number(row.id));
      removeFeedbackAttachmentFiles(row);
      removed += 1;
    } catch { /* 單列失敗不影響其他列 */ }
  }
  return { scanned: rows.length, removed };
}
