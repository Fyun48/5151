// 媒體儲存策略（2026-09-24）：把「會員素材庫的公開顯示檔」放上 Cloudflare R2，由 CDN 直送瀏覽器。
//
// 原則（資安與著作權一起考量）：
//   1. 只有**公開顯示檔**（`<hash>.jpg`、`<hash>_t.jpg`）會進 CDN。
//      `_o.jpg`（未浮水印原圖）與 `self-photos`（身分自拍）**永不**上傳（維持私有、只在本機）。
//   2. 開關 `MEDIA_SERVE=local|r2`（預設 local＝行為與現在完全相同）；沒設 R2 憑證時一律 local。
//   3. 寫入採「本機 ＋ R2」雙寫：本機那份是備援（也是 `_o.jpg` 的所在），R2 那份供 CDN 讀取。
//      在 r2 模式下 R2 上傳失敗會讓整筆上傳失敗（寧可請使用者重試，也不要產生讀不到的圖）；
//      在 local 模式下只是盡力而為（不影響既有行為）。
//   4. CDN 物件快取 7 天（`max-age=604800`），並在刪除／重新浮水印後**主動清除 CF 快取**；
//      即使清除失敗，最慢 7 天後邊緣也會自己失效。
import { r2DeleteObject, r2HeadObject, r2PublicUrl, r2PutObject, resolveR2Config } from "./r2Client.js";

/** 7 天。不用 `immutable`：素材庫的照片可以「重新浮水印／刪除」，需要保留失效空間。 */
export const MEMBER_MEDIA_CACHE_CONTROL = "public, max-age=604800";

/** `local`（預設）或 `r2`。 */
export function mediaServeMode(env = process.env) {
  return String(env.MEDIA_SERVE || "local").trim().toLowerCase() === "r2" ? "r2" : "local";
}

/** r2 模式且憑證齊全時才回設定，否則 null（＝走本機）。 */
export function mediaStoreConfig(env = process.env) {
  if (mediaServeMode(env) !== "r2") return null;
  return resolveR2Config(env);
}

export function isCdnServing(env = process.env) {
  return Boolean(mediaStoreConfig(env));
}

/** 只有公開顯示檔能對應到 R2 物件；`_o.jpg` 一律回空字串（永不外流）。 */
const PUBLIC_MEDIA_RE = /^[a-f0-9]{32}(_t)?\.jpg$/;
export function r2KeyForMemberMedia(name) {
  const file = String(name || "").split(/[/\\]/).pop() || "";
  return PUBLIC_MEDIA_RE.test(file) ? `member-media/${file}` : "";
}

/** 公開顯示檔在 CDN 上的網址；未啟用 CDN 時回空字串（呼叫端改回相對路徑）。 */
export function memberMediaCdnUrl(name, env = process.env) {
  const config = mediaStoreConfig(env);
  const key = r2KeyForMemberMedia(name);
  return config && key ? r2PublicUrl(config, key) : "";
}

function logStore(message) {
  console.log(`[mediaStore] ${message}`);
}

/**
 * 把公開顯示檔寫進 R2。
 * @param {{name:string, buffer:Buffer}[]} objects
 * @param {{env?:object, required?:boolean}} options required=true 時任何失敗都往外丟。
 */
export async function putMemberMediaObjects(objects, { env = process.env, required } = {}) {
  const config = mediaStoreConfig(env);
  if (!config) return { skipped: true, uploaded: 0 };
  const strict = required ?? true;
  let uploaded = 0;
  for (const { name, buffer } of objects) {
    const key = r2KeyForMemberMedia(name);
    if (!key) continue;
    try {
      await r2PutObject(config, key, buffer, {
        contentType: "image/jpeg",
        cacheControl: MEMBER_MEDIA_CACHE_CONTROL,
      });
      uploaded += 1;
    } catch (error) {
      if (strict) throw error;
      logStore(`R2 上傳失敗（忽略）：${key} ${String(error?.message || error).slice(0, 160)}`);
    }
  }
  return { skipped: false, uploaded };
}

/** 從 R2 移除公開顯示檔（best-effort，預設不拋錯）。 */
export async function deleteMemberMediaObjects(names, { env = process.env, required = false } = {}) {
  const config = mediaStoreConfig(env);
  if (!config) return { skipped: true, deleted: 0 };
  let deleted = 0;
  const keys = [];
  for (const name of names) {
    const key = r2KeyForMemberMedia(name);
    if (key) keys.push(key);
  }
  const results = await Promise.allSettled(keys.map((key) => r2DeleteObject(config, key)));
  results.forEach((res, i) => {
    if (res.status !== "fulfilled") {
      // 例外（連線等）→ required 時往外丟，否則記錄後忽略。
      if (required) throw res.reason;
      logStore(`R2 刪除例外（忽略）：${keys[i]} ${String(res.reason?.message || res.reason).slice(0, 160)}`);
      return;
    }
    if (res.value.deleted) {
      deleted += 1;
      return;
    }
    // 有回應但沒刪掉（非 2xx／404）→ required 時視為失敗。
    if (required) throw new Error(`r2 delete ${keys[i]} -> ${res.value.status}`);
    logStore(`R2 刪除未成功（忽略）：${keys[i]} status=${res.value.status}`);
  });
  return { skipped: false, deleted };
}

/** 物件是否存在於 R2（診斷用；需要憑證的讀取權限）。 */
export async function memberMediaObjectExists(name, { env = process.env } = {}) {
  const config = mediaStoreConfig(env);
  const key = r2KeyForMemberMedia(name);
  if (!config || !key) return null;
  return r2HeadObject(config, key);
}

/**
 * 清除 Cloudflare 邊緣快取（刪圖／重新浮水印後立即生效）。
 * 需要 `R2_PURGE_TOKEN`（僅 Cache Purge 權限的 scoped token）；沒有就略過（交給 7 天 TTL 自然失效）。
 */
export async function purgeMediaUrls(urls, { env = process.env } = {}) {
  const zoneId = String(env.R2_ZONE_ID || "").trim();
  const token = String(env.R2_PURGE_TOKEN || "").trim();
  const files = [...new Set((urls || []).map((u) => String(u || "").trim()).filter((u) => u.startsWith("https://")))]
    .slice(0, 25); // CF 單次上限
  if (!zoneId || !token || !files.length) return { skipped: true, purged: 0 };
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    const body = await res.json().catch(() => null);
    const ok = res.ok && body?.success !== false;
    if (!ok) logStore(`清除快取失敗（忽略）：${JSON.stringify(body?.errors || res.status).slice(0, 160)}`);
    return { skipped: false, purged: ok ? files.length : 0 };
  } catch (error) {
    logStore(`清除快取例外（忽略）：${String(error?.message || error).slice(0, 160)}`);
    return { skipped: false, purged: 0 };
  }
}

/** 依「檔名」清快取（內部先轉成 CDN 網址）。 */
export async function purgeMemberMediaNames(names, { env = process.env } = {}) {
  const config = mediaStoreConfig(env);
  if (!config) return { skipped: true, purged: 0 };
  const urls = names.map((name) => {
    const key = r2KeyForMemberMedia(name);
    return key ? r2PublicUrl(config, key) : "";
  });
  return purgeMediaUrls(urls, { env });
}
