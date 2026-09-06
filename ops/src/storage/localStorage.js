import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, rename, unlink, stat, chmod } from "node:fs/promises";
import path from "node:path";
import { assertValidObjectKey } from "./provider.js";

// LocalPersistentStorage：MVP 本機持久化儲存。
// - 專用附件目錄，位於 Ops 資料目錄下（不在任何 public 靜態根目錄，不會被靜態伺服）。
// - object_key 為隨機、不透明；物理路徑僅由「已驗證的 key」推導，杜絕 ../、絕對路徑、編碼穿越、null byte。
// - 以暫存檔寫入後 atomic rename；檔案權限 0600、目錄 0700。
// - 物理路徑絕不出現在 API 回應。

export class LocalPersistentStorage {
  constructor(rootDir) {
    this.name = "local";
    this.root = rootDir;
    this.tmpDir = path.join(rootDir, "tmp");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
  }

  // 以 2 字元分片子目錄，避免單一目錄過多檔案。路徑只由已驗證 key 推導。
  physicalPath(key) {
    assertValidObjectKey(key);
    const shard = key.slice(0, 2);
    const dir = path.join(this.root, shard);
    const full = path.join(dir, key);
    // 防禦性檢查：最終路徑必須仍在 root 內。
    const rel = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      const err = new Error("path escapes storage root");
      err.status = 400;
      throw err;
    }
    return { dir, full };
  }

  async putBuffer(key, buffer) {
    assertValidObjectKey(key);
    const { dir, full } = this.physicalPath(key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.tmpDir, `${randomBytes(16).toString("hex")}.part`);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    await writeFile(tmp, buffer, { mode: 0o600 });
    try {
      await rename(tmp, full); // 同檔系統 atomic rename
      await chmod(full, 0o600).catch(() => {});
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return { key, bytes: buffer.length, sha256 };
  }

  async get(key) {
    const { full } = this.physicalPath(key);
    return readFile(full);
  }

  async exists(key) {
    try {
      const { full } = this.physicalPath(key);
      return existsSync(full);
    } catch {
      return false;
    }
  }

  async delete(key) {
    try {
      const { full } = this.physicalPath(key);
      await unlink(full);
      return true;
    } catch {
      return false;
    }
  }

  async getMetadata(key) {
    try {
      const { full } = this.physicalPath(key);
      const s = await stat(full);
      return { bytes: s.size };
    } catch {
      return null;
    }
  }
}

export function defaultAttachmentDir(dataDir) {
  return process.env.OPS_ATTACHMENT_DIR || path.join(dataDir, "attachments");
}
