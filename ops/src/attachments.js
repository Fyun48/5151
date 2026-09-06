import { createHash, randomUUID } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";

// 附件安全模型（Ops 端）。所有附件內容一律 UNTRUSTED。
// 只負責：驗證、儲存、授權、metadata、安全下載、掃描抽象。不做 OCR/STT/AI。

// 每類上限（可用環境變數覆寫）。語音約 1 分鐘 → 10MB 足夠。
export function attachmentLimits(env = process.env) {
  return {
    image: Number(env.OPS_ATTACH_MAX_IMAGE || 5 * 1024 * 1024),
    audio: Number(env.OPS_ATTACH_MAX_AUDIO || 10 * 1024 * 1024),
    log: Number(env.OPS_ATTACH_MAX_LOG || 2 * 1024 * 1024),
  };
}

// HTTP 讀取時的硬上限（early reject）：取各類最大值。
export function maxUploadBytes(env = process.env) {
  const l = attachmentLimits(env);
  return Math.max(l.image, l.audio, l.log);
}

// 明確 allowlist：declared MIME → 類別 + 允許的偵測家族。
const ALLOWED = {
  "image/jpeg": { category: "image", family: "jpeg", inlineSafe: false },
  "image/png": { category: "image", family: "png", inlineSafe: false },
  "image/webp": { category: "image", family: "webp", inlineSafe: false },
  "audio/webm": { category: "audio", family: "webm", inlineSafe: false },
  "audio/ogg": { category: "audio", family: "ogg", inlineSafe: false },
  "audio/mpeg": { category: "audio", family: "mp3", inlineSafe: false },
  "text/plain": { category: "log", family: "text", inlineSafe: false },
  "application/json": { category: "log", family: "json", inlineSafe: false },
};

export function isAllowedMime(mime) {
  return Object.prototype.hasOwnProperty.call(ALLOWED, String(mime || "").toLowerCase().split(";")[0].trim());
}

function normalizeMime(mime) {
  return String(mime || "").toLowerCase().split(";")[0].trim();
}

function startsWith(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

// 由 magic bytes 偵測實際型別（含危險型別，用來一律拒絕）。
export function detectType(buf) {
  if (!buf || buf.length === 0) return "empty";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return "webm"; // Matroska/WebM (EBML)
  if (startsWith(buf, [0x4f, 0x67, 0x67, 0x53])) return "ogg"; // 'OggS'
  if (startsWith(buf, [0x49, 0x44, 0x33])) return "mp3"; // 'ID3'
  if (buf.length > 1 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3"; // MPEG frame sync
  // 危險/可執行/腳本型別
  if (startsWith(buf, [0x4d, 0x5a])) return "mz"; // Windows PE
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return "elf";
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) return "gif"; // GIF8
  const head = buf.slice(0, 512).toString("utf8").replace(/^\uFEFF/, "").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  if (head.startsWith("<?xml")) return "xml";
  return "unknown";
}

function isProbablyUtf8Text(buf) {
  // 含 NUL 視為二進位
  for (let i = 0; i < Math.min(buf.length, 4096); i++) if (buf[i] === 0x00) return false;
  const decoded = buf.toString("utf8");
  // 若往返不一致，代表有無效 UTF-8 序列
  return Buffer.from(decoded, "utf8").equals(buf) || decoded.length > 0;
}

const DANGEROUS_DETECTED = new Set(["html", "svg", "xml", "mz", "elf", "zip", "pdf"]);

// 驗證附件：回 { mime, category }；不合法則丟錯（帶 status）。
export function validateAttachment({ declaredMime, buffer, env = process.env }) {
  const mime = normalizeMime(declaredMime);
  const spec = ALLOWED[mime];
  if (!spec) throw httpError(`unsupported media type: ${mime || "(none)"}`, 415);
  if (!buffer || buffer.length === 0) throw httpError("empty upload", 400);
  const limits = attachmentLimits(env);
  if (buffer.length > limits[spec.category]) throw httpError(`file too large for ${spec.category}`, 413);

  const detected = detectType(buffer);
  if (DANGEROUS_DETECTED.has(detected)) {
    throw httpError(`dangerous content detected (${detected})`, 415);
  }

  if (spec.category === "image" || spec.category === "audio") {
    if (detected !== spec.family) {
      throw httpError(`declared ${mime} but content looks like ${detected}`, 415);
    }
  } else if (spec.category === "log") {
    if (!isProbablyUtf8Text(buffer)) throw httpError("log/trace must be UTF-8 text", 415);
    if (mime === "application/json") {
      try { JSON.parse(buffer.toString("utf8")); } catch { throw httpError("invalid JSON", 415); }
    }
  }
  return { mime, category: spec.category };
}

// 原始檔名僅供顯示/metadata：Unicode 正規化、去控制字元、去路徑分隔、限長。
export function sanitizeFilename(name) {
  let s = String(name || "").normalize("NFC");
  s = s.replace(/[\u0000-\u001f\u007f]/g, ""); // 控制字元（含 null）
  s = s.replace(/[\\/]/g, "_"); // 路徑分隔
  s = s.replace(/[\r\n]/g, "");
  s = s.trim();
  if (s.length > 200) s = s.slice(0, 200);
  return s || "attachment";
}

// 安全的 Content-Disposition（RFC5987，處理 Unicode 檔名，避免標頭注入）。
export function contentDisposition(filename, disposition = "attachment") {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(safe);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function feedbackExists(db, feedbackId) {
  return Boolean(db.prepare("SELECT id FROM ingested_feedback WHERE id = ?").get(Number(feedbackId) || 0));
}

// 接受附件：安全寫入順序 = 先寫檔（storage.putBuffer）→ 再寫 DB（tx）；DB 失敗則刪檔清理，避免孤兒。
// storage 失敗 → 不會有 DB 列。掃描為 no-op（skipped，絕不 clean）。稽核只記 metadata。
export async function acceptAttachment(db, { storage, scanner }, { feedbackId, declaredMime, filename, buffer, piiFlag = false, now = new Date() }) {
  if (!feedbackExists(db, feedbackId)) throw httpError("feedback not found", 404);
  const { mime, category } = validateAttachment({ declaredMime, buffer });
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const key = randomUUID();
  const cleanName = sanitizeFilename(filename);

  // 1) 先寫檔
  await storage.putBuffer(key, buffer);

  // 2) 掃描（no-op → skipped）
  let scan = { status: "skipped" };
  try {
    scan = await scanner.scan({ buffer, key });
  } catch {
    scan = { status: "failed" };
  }

  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  try {
    return withImmediateTx(db, () => {
      const res = db.prepare(
        `INSERT INTO feedback_attachment
           (feedback_id, object_key, original_filename, mime, category, bytes, sha256, storage_provider, scan_status, pii_flag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Number(feedbackId),
        key,
        cleanName,
        mime,
        category,
        buffer.length,
        sha256,
        storage.name,
        scan.status,
        piiFlag ? 1 : 0,
        ts,
      );
      const id = Number(res.lastInsertRowid);
      // 稽核只記 metadata，絕不記原始內容。
      appendAuditRow(db, {
        actor: "owner",
        action: "attachment.accepted",
        entityType: "feedback_attachment",
        entityId: String(id),
        data: { feedback_id: Number(feedbackId), mime, category, bytes: buffer.length, sha256, scan_status: scan.status },
        now,
      });
      appendAuditRow(db, {
        actor: "system",
        action: "attachment.scan_result",
        entityType: "feedback_attachment",
        entityId: String(id),
        data: { scan_status: scan.status, scanner: scan.scanner || scanner.name },
        now,
      });
      return { id, mime, category, bytes: buffer.length, sha256, scan_status: scan.status };
    });
  } catch (err) {
    // DB 失敗 → 清掉剛寫的檔，避免「檔在但無 DB 列」的孤兒。
    await storage.delete(key).catch(() => {});
    throw err;
  }
}

export function getAttachmentRow(db, id) {
  return db.prepare("SELECT * FROM feedback_attachment WHERE id = ?").get(Number(id) || 0) || null;
}

export function listAttachments(db, { feedbackId = null, limit = 100 } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 100, 500));
  if (feedbackId) {
    return db.prepare("SELECT * FROM feedback_attachment WHERE feedback_id = ? ORDER BY id DESC LIMIT ?").all(Number(feedbackId), cap);
  }
  return db.prepare("SELECT * FROM feedback_attachment ORDER BY id DESC LIMIT ?").all(cap);
}

// 對外 metadata：絕不含 object_key / 物理路徑。
export function publicAttachmentMeta(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    feedback_id: Number(row.feedback_id),
    original_filename: row.original_filename,
    mime: row.mime,
    category: row.category,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    storage_provider: row.storage_provider,
    scan_status: row.scan_status,
    pii_flag: Number(row.pii_flag) === 1,
    created_at: row.created_at,
  };
}

// 一致性回收：刪除「有檔但無 DB 列」的孤兒（crash between put 與 insert 的極少數情況）。
// 此為文件化的回收機制；Phase 3 提供函式，未來可由排程呼叫。
export async function reconcileOrphans(db, storage, keys) {
  let removed = 0;
  for (const key of keys) {
    const row = db.prepare("SELECT id FROM feedback_attachment WHERE object_key = ?").get(key);
    if (!row && await storage.exists(key)) {
      await storage.delete(key).catch(() => {});
      removed += 1;
    }
  }
  return { removed };
}
