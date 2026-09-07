import { createHash } from "node:crypto";

// v3 會員照片素材庫的 server-side 影像處理。
// 重要（部署/CI 相容）：影像處理器 sharp 是「原生相依」，只在 Production（Docker `npm ci`）安裝；
// CI 的 `npm test` 不安裝相依，所以本檔以「動態 import」載入 sharp，且對外的 processImage 可被測試以 fake 注入。
// 所有上傳圖片視為 untrusted：先驗 magic byte、限制大小/像素，再由 sharp 正規化（轉向/縮放/壓縮/去 metadata）。

export const IMAGE_MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // 單檔上傳硬上限（解碼前）
export const IMAGE_MAX_PIXELS = 40 * 1000 * 1000;       // 解壓縮炸彈防護（像素上限 ~40MP）
export const IMAGE_MAX_DIMENSION = 12000;               // 單邊像素上限
export const IMAGE_MAIN_MAX_EDGE = 1600;                // 主圖長邊
export const IMAGE_THUMB_MAX_EDGE = 400;                // 縮圖長邊
export const IMAGE_MAIN_QUALITY = 82;
export const IMAGE_THUMB_QUALITY = 70;

// 只用檔案簽章（magic bytes）判斷格式，不信任副檔名/瀏覽器 MIME。
export function detectImageSignature(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (["avif", "avis", "mif1", "msf1"].includes(brand)) return { ext: "avif", mime: "image/avif" };
  }
  return null;
}

export function assertUploadBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) { const e = new Error("請選擇照片檔案"); e.status = 400; throw e; }
  if (buffer.length > IMAGE_MAX_UPLOAD_BYTES) { const e = new Error("單張照片請在 12MB 以內"); e.status = 413; throw e; }
  const sig = detectImageSignature(buffer);
  if (!sig) { const e = new Error("只接受 JPG、PNG、WebP 或 AVIF 圖片"); e.status = 415; throw e; }
  return sig;
}

let sharpModPromise = null;
export async function loadSharp() {
  if (!sharpModPromise) sharpModPromise = import("sharp").then((m) => m.default || m).catch(() => null);
  return sharpModPromise;
}
export async function sharpAvailable() { return Boolean(await loadSharp()); }

// 以 sharp 正規化：轉向(EXIF)、縮放(長邊上限、不放大)、壓成 JPEG、去除 metadata；另產生縮圖。
// 回傳 { format, mime, digest, main:{buffer,width,height,bytes}, thumb:{buffer,bytes} }。
export async function normalizeImage(buffer, opts = {}) {
  const sig = assertUploadBytes(buffer);
  const sharp = await loadSharp();
  if (!sharp) { const e = new Error("影像處理器尚未就緒，請稍後再試"); e.status = 503; e.code = "processor_unavailable"; throw e; }
  const maxEdge = Number(opts.maxEdge) || IMAGE_MAIN_MAX_EDGE;
  const thumbEdge = Number(opts.thumbEdge) || IMAGE_THUMB_MAX_EDGE;
  const quality = Number(opts.quality) || IMAGE_MAIN_QUALITY;
  const thumbQuality = Number(opts.thumbQuality) || IMAGE_THUMB_QUALITY;
  const limitInputPixels = Number(opts.maxPixels) || IMAGE_MAX_PIXELS;

  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels, failOn: "error" }).metadata();
  } catch { const e = new Error("圖片檔案無法解析或已損毀"); e.status = 400; throw e; }
  if (!meta || !meta.width || !meta.height) { const e = new Error("圖片尺寸無效"); e.status = 400; throw e; }
  if (meta.width > IMAGE_MAX_DIMENSION || meta.height > IMAGE_MAX_DIMENSION) { const e = new Error("圖片尺寸過大"); e.status = 413; throw e; }

  const mainOut = await sharp(buffer, { limitInputPixels, failOn: "error" })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: false })
    .toBuffer({ resolveWithObject: true });
  const thumbOut = await sharp(buffer, { limitInputPixels, failOn: "error" })
    .rotate()
    .resize({ width: thumbEdge, height: thumbEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: thumbQuality, mozjpeg: false })
    .toBuffer({ resolveWithObject: true });

  const main = mainOut.data;
  const thumb = thumbOut.data;
  const digest = createHash("sha256").update(main).digest("hex");
  return {
    format: "jpg", mime: "image/jpeg", digest, source_format: sig.ext,
    main: { buffer: main, width: mainOut.info.width, height: mainOut.info.height, bytes: main.length },
    thumb: { buffer: thumb, bytes: thumb.length },
  };
}
