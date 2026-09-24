// 極簡 Cloudflare R2（S3 相容）用戶端：只用 node:crypto 做 AWS SigV4 簽章，不引入 AWS SDK。
//
// 為什麼自己做：repo 的依賴刻意保持精簡，而我們只需要 PUT／HEAD／DELETE 三個動作。
// 物件金鑰規則（與本機目錄一致）：`member-media/<檔名>`、`self-photos/<檔名>`。
import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const REGION = "auto";
const SERVICE = "s3";

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

/** 從環境變數解析設定；缺任何必要值就回 null（呼叫端據此決定要不要走 R2）。 */
export function resolveR2Config(env = process.env) {
  const accountId = String(env.R2_ACCOUNT_ID || "").trim();
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = String(env.R2_BUCKET || "").trim();
  const endpoint = String(env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ""))
    .trim()
    .replace(/\/+$/, "");
  const publicBase = String(env.R2_MEDIA_DOMAIN || "").trim().replace(/\/+$/, "");
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint, publicBase };
}

/** 物件金鑰的 URI 編碼（S3 的正規化路徑：逐段編碼，保留 `/`）。 */
function encodeKeyPath(key) {
  return String(key)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** bucket 之路徑式定址（R2 用 `/<bucket>/<key>`，也必須是簽章範圍的一部分）。 */
function bucketPath(config, key) {
  return `/${config.bucket}/${encodeKeyPath(key)}`;
}

/** 產生 SigV4 簽章標頭（PUT／HEAD／DELETE 共用）。 */
export function signR2Request({ config, method, key, body = null, contentType = "", now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? "");
  const path = bucketPath(config, key);
  const host = new URL(config.endpoint).host;

  // 注意：canonical headers 的每一行（含最後一行）都要以 `\n` 結尾 —— R2 的實作會再補一個 `\n`，
  // 因此標頭區塊與 signed headers 之間會有一個空行。這是實測比對 R2 的 CanonicalRequestBytes
  // （`...Z` `0a 0a` `host;...`）得到的結論，與 AWS 文件的敘述略有出入。
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), REGION), SERVICE), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const headers = {
    Authorization:
      `${ALGORITHM} Credential=${config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["content-type"] = contentType;
  return { url: `${config.endpoint}${path}`, headers };
}

const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function r2PutObject(config, key, body, options = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  const signed = signR2Request({
    config,
    method: "PUT",
    key,
    body: buf,
    contentType: options.contentType || "application/octet-stream",
  });
  const headers = { ...signed.headers, "cache-control": options.cacheControl ?? DEFAULT_CACHE_CONTROL };
  const res = await fetch(signed.url, { method: "PUT", headers, body: buf });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`r2 put ${key} -> ${res.status} ${String(detail).slice(0, 200)}`);
  }
  return { key, bytes: buf.length, status: res.status };
}

export async function r2HeadObject(config, key) {
  const signed = signR2Request({ config, method: "HEAD", key });
  const res = await fetch(signed.url, { method: "HEAD", headers: signed.headers });
  return { exists: res.ok, status: res.status, bytes: Number(res.headers.get("content-length") || 0) };
}

export async function r2DeleteObject(config, key) {
  const signed = signR2Request({ config, method: "DELETE", key });
  const res = await fetch(signed.url, { method: "DELETE", headers: signed.headers });
  return { deleted: res.ok || res.status === 404, status: res.status };
}

/** CDN 上的公開網址（僅限可公開的顯示檔；原圖與 self-photos 不應呼叫這個）。 */
export function r2PublicUrl(config, key) {
  if (!config?.publicBase) return "";
  return `${config.publicBase}/${String(key).split("/").map((s) => encodeURIComponent(s)).join("/")}`;
}
