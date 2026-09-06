// Storage Provider 抽象。業務/API 程式碼只依賴此介面，不直接碰檔案系統路徑。
// 資料庫只存不透明的 object_key；物理路徑/檔名絕不由使用者輸入推導。
//
// 介面（概念）：
//   putBuffer(key, buffer)      → { key, bytes, sha256 }   原子寫入
//   get(key)                    → Buffer                    （Range 讀取為未來能力，見 README/報告）
//   exists(key)                 → boolean
//   delete(key)                 → boolean
//   getMetadata(key)            → { bytes } | null
//
// 未來可加：S3 / GCS / Azure Blob 等，只要實作相同介面即可，無需改動 attachments 業務碼。

// object_key 一律由伺服器產生的隨機 UUID；此正規表達式用來驗證，杜絕 path traversal。
export const OBJECT_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertValidObjectKey(key) {
  if (typeof key !== "string" || !OBJECT_KEY_RE.test(key)) {
    const err = new Error("invalid object key");
    err.status = 400;
    throw err;
  }
  return key;
}
