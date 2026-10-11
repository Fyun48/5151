// 591 座標／社區補齊掃描的「輪轉起點」。
//
// 為什麼需要隨機起點：正式站有 3 個進程（`5151-web-A`／`5151-web-B`／`591-tracker-v3`）各自跑自己的
// `queueGeoBackfill()`；輪轉游標是模組層級的（`watcher.js:geo591ScanCursor`），若三個進程每次都從 0
// 開始，重啟後會一起從最小 `post_id` 低頭，對**同一批**欠補物件重複發外部 591 抓取
// （正式庫欠補 29,901 列 ⇒ 最壞白燒 3 倍配額）。起點隨機之後三個進程自然散開；覆蓋性不受影響，
// 因為掃到結尾會回 0 再走一次（完整循環仍會走遍每一列）。
//
// ⚠️ `post_id` 是 bigint，正式庫 2026-10-11 實測 `max(post_id) = 2,699,975,575`，**超過 2^31-1**。
// 所以這裡**不能**用 32 位元的亂數（`Int32Array`／`| 0`／`Math.floor(Math.random() * 2 ** 31)`）：
// 那一類做法只涵蓋到 2^31-1，2^31 以上的鍵段永遠只會從 0 開始（等於高 `post_id` 的欠補列排不到）。
// 作法：`randomBytes(6)` ＝ 48 位元（2^48 ≫ 2.7e9，取模偏誤 ≈ 2.7e9 / 2^48 ≈ 1e-5），
// 用 BigInt 組出整數後對「鍵段上界 + 1」取模，最後才 `Number()`——結果 < 2^53 ⇒ 轉換精確、
// 不會像 `| 0` 那樣把 2,147,483,648 折成負數或 0。
import { randomBytes } from "node:crypto";

/** 正式庫（2026-10-11）觀察到的 `max(listings.post_id)`；起點的鍵段上界。 */
export const GEO591_KEY_CAP = 2699975575n;

/** 48 位元的亂數位元組數（見檔首：一定要 > 32 位元才涵蓋得到 2^31 以上的鍵段）。 */
export const GEO591_SEED_BYTES = 6;

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * 48 位元亂數 ⇒ `[0, GEO591_KEY_CAP]` 的整數起點。`bytes` 只給測試注入（不傳就自己抽）。
 */
export function randomGeo591CursorStart({ bytes } = {}) {
  const raw = bytes === undefined ? randomBytes(GEO591_SEED_BYTES) : Buffer.from(bytes);
  if (!raw.length) throw new Error("geo591 起點：亂數位元組不可以是空的");
  return Number(bytesToBigInt(raw) % (GEO591_KEY_CAP + 1n));
}

/**
 * 進程啟動時的輪轉起點。
 *   • `GEO591_CURSOR_SEED` 有設且是 0..2^53-1 的整數字串 ⇒ **逐字使用該值**（測試／量測要可重現）。
 *   • 沒設（或設了不合法）⇒ 隨機起點。
 */
export function geo591CursorStart({ env = process.env, bytes } = {}) {
  const raw = String(env?.GEO591_CURSOR_SEED ?? "").trim();
  if (raw) {
    if (/^\d+$/.test(raw) && BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(BigInt(raw));
    // 講出來，不要靜默忽略（設了種子卻拿到隨機起點會讓量測對不起來）。
    console.warn("[geo591] GEO591_CURSOR_SEED 不是 0..2^53-1 的整數字串 ⇒ 改用隨機起點");
  }
  return randomGeo591CursorStart({ bytes });
}

/**
 * 下一輪的游標：有回傳列就接在最後一列（查詢本身是 `ORDER BY post_id ASC`）之後，
 * 沒有回傳列代表這個循環走完了 ⇒ 歸零重來（`watcher.backfillListingCoords()` 用）。
 */
export function nextGeo591Cursor(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 0;
  const last = Number(list[list.length - 1]?.post_id);
  return Number.isFinite(last) && last > 0 ? last : 0;
}
