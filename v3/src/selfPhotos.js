import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const SELF_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const SELF_PHOTO_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const SELF_PHOTO_MAX_COUNT = 100;
export const SELF_PHOTO_PUBLIC_PREFIX = "/media/self/";

function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), "data-v3");
}

export function selfPhotosDir() {
  const dir = path.join(dataDir(), "self-photos");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function detectImageKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  if (
    buf.length >= 12
    && buf.toString("ascii", 0, 4) === "RIFF"
    && buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

export function selfPhotoDiskName(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  return /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(base) ? base : "";
}

export function isSelfPhotoPublicUrl(value) {
  return /^\/media\/self\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(String(value || "").trim());
}

export function mimeForSelfPhoto(name) {
  const file = selfPhotoDiskName(name) || String(name || "");
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

export function selfPhotoFilePath(name) {
  const file = selfPhotoDiskName(name);
  if (!file) return "";
  const full = path.join(selfPhotosDir(), file);
  return existsSync(full) ? full : "";
}

export function saveSelfPhoto(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error("請選擇照片檔案");
    err.status = 400;
    throw err;
  }
  if (buffer.length > SELF_PHOTO_MAX_BYTES) {
    const err = new Error("每張照片請在 2MB 以內");
    err.status = 400;
    throw err;
  }
  const kind = detectImageKind(buffer);
  if (!kind) {
    const err = new Error("只接受 JPG、PNG 或 WebP");
    err.status = 400;
    throw err;
  }
  const name = `${randomBytes(16).toString("hex")}.${kind.ext}`;
  writeFileSync(path.join(selfPhotosDir(), name), buffer);
  return { url: `${SELF_PHOTO_PUBLIC_PREFIX}${name}`, mime: kind.mime, bytes: buffer.length };
}
