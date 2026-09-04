import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { APP_NAME, APP_NAME_EN } from "./brand.js";

export const BRAND_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const BRAND_PUBLIC_PREFIX = "/media/brand/";
export const BRAND_SLOTS = ["mark", "welcome", "register", "sponsor", "confused"];

const BUNDLED = {
  mark: "/brand/mark.png",
  welcome: "/brand/walk.gif",
  register: "/brand/duo.png",
  sponsor: "/brand/heads.png",
  confused: "/brand/confused.webm",
};

export function defaultBrandMascot() {
  return {
    enabled: true,
    englishName: APP_NAME_EN,
    header: true,
    login: true,
    markUrl: BUNDLED.mark,
    confusedThreshold: 6,
    clips: {
      welcome: clip("welcome", "歡迎", "吉比租房物件追蹤 · JibbyRentH"),
      register: clip("register", "謝謝你註冊", "請到信箱點確認連結，之後就能存自己的篩選。"),
      sponsor: clip("sponsor", "謝謝贊助", "你的支持讓共用抓取庫可以一直開著。"),
      confused: clip("confused", "這步現在做不到", "可能要先登入，或換一個還開著的操作。"),
    },
  };
}

function clip(slot, title, body) {
  const url = BUNDLED[slot];
  return {
    enabled: true,
    url,
    kind: kindFromUrl(url),
    title,
    body,
  };
}

export function kindFromUrl(url) {
  const text = String(url || "").toLowerCase();
  if (/\.(webm|mp4)(\?|$)/.test(text)) return "video";
  return "image";
}

export function isSafeBrandUrl(value) {
  const url = String(value || "").trim();
  if (/^\/brand\/[a-zA-Z0-9._-]+$/.test(url)) return true;
  return /^\/media\/brand\/[a-f0-9]{32}\.(png|jpe?g|gif|webp|webm|mp4)$/.test(url);
}

function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), "data-v3");
}

export function brandMediaDir() {
  const dir = path.join(dataDir(), "brand");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function detectBrandKind(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: "gif", mime: "image/gif" };
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { ext: "webm", mime: "video/webm" };
  }
  if (buf.toString("ascii", 4, 8) === "ftyp") return { ext: "mp4", mime: "video/mp4" };
  return null;
}

export function brandDiskName(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  return /^[a-f0-9]{32}\.(jpg|png|gif|webp|webm|mp4)$/.test(base) ? base : "";
}

export function brandFilePath(name) {
  const file = brandDiskName(name);
  if (!file) return "";
  const full = path.join(brandMediaDir(), file);
  return existsSync(full) ? full : "";
}

export function mimeForBrandFile(name) {
  const file = brandDiskName(name) || String(name || "");
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".gif")) return "image/gif";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".webm")) return "video/webm";
  if (file.endsWith(".mp4")) return "video/mp4";
  return "image/jpeg";
}

export function saveBrandUpload(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const err = new Error("請選擇圖片或短片");
    err.status = 400;
    throw err;
  }
  if (buffer.length > BRAND_UPLOAD_MAX_BYTES) {
    const err = new Error("檔案請在 8MB 以內");
    err.status = 400;
    throw err;
  }
  const kind = detectBrandKind(buffer);
  if (!kind) {
    const err = new Error("只接受 JPG、PNG、GIF、WebP、WebM 或 MP4");
    err.status = 400;
    throw err;
  }
  const name = `${randomBytes(16).toString("hex")}.${kind.ext}`;
  writeFileSync(path.join(brandMediaDir(), name), buffer);
  return { url: `${BRAND_PUBLIC_PREFIX}${name}`, mime: kind.mime, bytes: buffer.length, kind: kind.ext === "webm" || kind.ext === "mp4" ? "video" : "image" };
}

function cleanText(value, fallback, max = 80) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.slice(0, max);
}

export function normalizeBrandMascot(raw = {}) {
  const base = defaultBrandMascot();
  const src = raw && typeof raw === "object" ? raw : {};
  const clips = {};
  for (const slot of ["welcome", "register", "sponsor", "confused"]) {
    const incoming = src.clips?.[slot] && typeof src.clips[slot] === "object" ? src.clips[slot] : {};
    const url = isSafeBrandUrl(incoming.url) ? String(incoming.url).trim() : base.clips[slot].url;
    clips[slot] = {
      enabled: incoming.enabled !== false,
      url,
      kind: kindFromUrl(url),
      title: cleanText(incoming.title, base.clips[slot].title, 40),
      body: cleanText(incoming.body, base.clips[slot].body, 120),
    };
  }
  const markUrl = isSafeBrandUrl(src.markUrl) ? String(src.markUrl).trim() : base.markUrl;
  const threshold = Number(src.confusedThreshold);
  return {
    enabled: src.enabled !== false,
    englishName: cleanText(src.englishName, APP_NAME_EN, 24).replace(/pawprints/i, APP_NAME_EN) || APP_NAME_EN,
    header: src.header !== false,
    login: src.login !== false,
    markUrl,
    confusedThreshold: Number.isFinite(threshold) ? Math.max(3, Math.min(20, Math.round(threshold))) : 6,
    clips,
    productName: APP_NAME,
  };
}

export function publicBrandMascot(stored) {
  return normalizeBrandMascot(stored);
}
