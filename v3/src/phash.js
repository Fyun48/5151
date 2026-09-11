// 圖片感知雜湊。失敗當沒有指紋，不擋入庫。漢明距離是相似證據，不是同戶判決。

import { coverKey } from "./match.js";

export const PHASH_ALGO = "phash-dct-8-v1";
export const PHASH_SIMILAR_MAX = 10;
export const PHASH_MAX_BYTES = 2 * 1024 * 1024;
export const PHASH_TIMEOUT_MS = 8000;
export const PHASH_MAX_EDGE = 4096;
export const PHASH_CONCURRENCY = 2;

const HEX64 = /^[0-9a-f]{16}$/i;

export function normalizePhashHex(value) {
  const hex = String(value || "").trim().toLowerCase();
  return HEX64.test(hex) ? hex : "";
}

export function hexHashFromBits(bits) {
  const list = Array.from(bits || []).slice(0, 64).map((bit) => (bit ? 1 : 0));
  while (list.length < 64) list.push(0);
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    const nibble = (list[i] << 3) | (list[i + 1] << 2) | (list[i + 2] << 1) | list[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
}

export function bitsFromHexHash(hex) {
  const clean = normalizePhashHex(hex);
  if (!clean) return [];
  const bits = [];
  for (const ch of clean) {
    const n = Number.parseInt(ch, 16);
    bits.push((n >> 3) & 1, (n >> 2) & 1, (n >> 1) & 1, n & 1);
  }
  return bits;
}

export function hammingDistance(a, b) {
  const left = normalizePhashHex(a);
  const right = normalizePhashHex(b);
  if (!left || !right) return null;
  const bitsA = bitsFromHexHash(left);
  const bitsB = bitsFromHexHash(right);
  let dist = 0;
  for (let i = 0; i < 64; i += 1) {
    if (bitsA[i] !== bitsB[i]) dist += 1;
  }
  return dist;
}

export function hashesAreSimilar(a, b, max = PHASH_SIMILAR_MAX) {
  const dist = hammingDistance(a, b);
  return dist != null && dist <= max;
}

export function flipHexBits(hex, indexes) {
  const bits = bitsFromHexHash(hex);
  if (!bits.length) return "";
  for (const index of indexes || []) {
    const i = Number(index);
    if (i >= 0 && i < bits.length) bits[i] = bits[i] ? 0 : 1;
  }
  return hexHashFromBits(bits);
}

function dct1d(vector) {
  const n = vector.length;
  const out = new Array(n);
  const scale = Math.PI / (2 * n);
  for (let k = 0; k < n; k += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += vector[i] * Math.cos((2 * i + 1) * k * scale);
    }
    out[k] = sum * (k === 0 ? Math.SQRT1_2 : 1);
  }
  return out;
}

export function dctPhashFromGray32(pixels) {
  const n = 32;
  const src = Array.from(pixels || [], (v) => Number(v) || 0);
  if (src.length < n * n) return "";
  const rows = [];
  for (let y = 0; y < n; y += 1) {
    rows.push(dct1d(src.slice(y * n, y * n + n)));
  }
  const cols = Array.from({ length: n }, () => new Array(n));
  for (let x = 0; x < n; x += 1) {
    const column = dct1d(rows.map((row) => row[x]));
    for (let y = 0; y < n; y += 1) cols[y][x] = column[y];
  }
  const vals = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (x === 0 && y === 0) continue;
      vals.push(cols[y][x]);
    }
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const bits = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      bits.push(cols[y][x] > median ? 1 : 0);
    }
  }
  return hexHashFromBits(bits);
}

export function imageKeyFromUrl(url) {
  return coverKey(url);
}

export function isAllowedImageUrl(url) {
  const raw = String(url || "").trim();
  if (!raw || raw.length > 2000) return false;
  if (/^(javascript|data|file|blob):/i.test(raw)) return false;
  try {
    const parsed = new URL(raw, "https://example.invalid");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = String(parsed.hostname || "").toLowerCase();
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
    if (host.endsWith(".localhost") || host.endsWith(".local")) return false;
    return true;
  } catch {
    return false;
  }
}

export async function computePhashFromBuffer(buffer) {
  if (!buffer || !buffer.byteLength) return "";
  if (buffer.byteLength > PHASH_MAX_BYTES) return "";
  try {
    const sharp = (await import("sharp")).default;
    const image = sharp(buffer, { failOn: "none", limitInputPixels: PHASH_MAX_EDGE * PHASH_MAX_EDGE });
    const meta = await image.metadata();
    const mime = String(meta.format || "").toLowerCase();
    if (mime && !["jpeg", "jpg", "png", "webp", "gif", "avif"].includes(mime)) return "";
    const { data } = await image
      .resize(32, 32, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return dctPhashFromGray32(data);
  } catch {
    return "";
  }
}

let inflight = 0;
const waiters = [];

async function withImageSlot(fn) {
  if (inflight >= PHASH_CONCURRENCY) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  inflight += 1;
  try {
    return await fn();
  } finally {
    inflight -= 1;
    waiters.shift()?.();
  }
}

export async function fetchImageBuffer(url, { fetchImpl = fetch, timeoutMs = PHASH_TIMEOUT_MS } = {}) {
  if (!isAllowedImageUrl(url)) return null;
  return withImageSlot(async () => {
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "image/*,*/*;q=0.8" },
      });
      if (!res.ok) return null;
      const mime = String(res.headers.get("content-type") || "").toLowerCase();
      if (mime && !mime.startsWith("image/") && !mime.includes("octet-stream")) return null;
      const length = Number(res.headers.get("content-length") || 0);
      if (length > PHASH_MAX_BYTES) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > PHASH_MAX_BYTES) return null;
      return buf;
    } catch {
      return null;
    }
  });
}

export async function phashFromImageUrl(url, opts = {}) {
  if (opts.phashHex) return normalizePhashHex(opts.phashHex);
  const fetchImage = opts.fetchImage || ((target) => fetchImageBuffer(target, opts));
  const buf = await fetchImage(url);
  if (!buf) return "";
  return computePhashFromBuffer(buf);
}

/** 只產生「直接相似」的成對關係；A≈B、B≈C 不會自動補 A≈C。 */
export function pairwiseSimilarHashes(rows, { maxDistance = PHASH_SIMILAR_MAX } = {}) {
  const items = (rows || []).filter((row) => Number(row?.post_id) > 0 && normalizePhashHex(row.phash));
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (Number(a.post_id) === Number(b.post_id)) continue;
      const dist = hammingDistance(a.phash, b.phash);
      if (dist == null || dist > maxDistance) continue;
      const lo = Math.min(Number(a.post_id), Number(b.post_id));
      const hi = Math.max(Number(a.post_id), Number(b.post_id));
      const key = `${lo}:${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        listing_a: lo,
        listing_b: hi,
        hamming: dist,
        phash_a: Number(a.post_id) === lo ? normalizePhashHex(a.phash) : normalizePhashHex(b.phash),
        phash_b: Number(b.post_id) === hi ? normalizePhashHex(b.phash) : normalizePhashHex(a.phash),
      });
    }
  }
  return pairs;
}
