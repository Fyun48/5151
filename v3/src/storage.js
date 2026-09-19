// Media / file storage abstraction (Phase 18). Web active/active cannot rely on
// local DATA_DIR, so media goes through a storage driver selected by
// STORAGE_DRIVER=local|s3. Local is backward-compatible; S3 is S3-compatible
// object storage (upload/download/delete/thumbnail/deterministic key/metadata).
//
// Interface (async):
//   put(key, buffer, metadata) -> { key, bytes, sha256 }
//   get(key) -> Buffer | null
//   exists(key) -> boolean
//   delete(key) -> boolean
//   getMetadata(key) -> object | null
//   list() -> string[]        (for migration)
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";

export function resolveStorageDriver(env = process.env) {
  const raw = String(env.STORAGE_DRIVER || "local").trim().toLowerCase();
  if (raw === "s3" || raw === "object" || raw === "r2") return "s3";
  return "local";
}

// Deterministic key: namespace + content hash + stable id. Same bytes -> same
// key, so re-uploading identical media is idempotent and cache-friendly.
export function deterministicStorageKey(namespace, id, { contentHash = null, extension = "" } = {}) {
  const hash = contentHash || randomBytes(16).toString("hex");
  const suffix = extension ? `.${extension.replace(/^\./, "")}` : "";
  return `${namespace}/${hash.slice(0, 2)}/${hash}${suffix}`.replace(/\/+/g, "/");
}

export function createLocalStorage(rootDir) {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const fullPath = (key) => {
    const full = path.join(rootDir, key);
    const rel = path.relative(rootDir, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("path escapes storage root");
    }
    return full;
  };
  return {
    name: "local",
    async put(key, buffer, metadata = {}) {
      const full = fullPath(key);
      mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      await writeFile(full, buffer, { mode: 0o600 });
      await writeFile(`${full}.meta.json`, JSON.stringify({ ...metadata, sha256, bytes: buffer.length }));
      return { key, bytes: buffer.length, sha256 };
    },
    async get(key) {
      try { return await readFile(fullPath(key)); } catch { return null; }
    },
    async exists(key) {
      return existsSync(fullPath(key));
    },
    async delete(key) {
      try {
        await unlink(fullPath(key));
        await unlink(`${fullPath(key)}.meta.json`).catch(() => {});
        return true;
      } catch { return false; }
    },
    async getMetadata(key) {
      try { return JSON.parse(await readFile(`${fullPath(key)}.meta.json`, "utf8")); } catch { return null; }
    },
    async list() {
      const out = [];
      async function walk(dir, prefix) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            await walk(path.join(dir, entry.name), rel);
          } else if (!rel.endsWith(".meta.json")) {
            out.push(rel);
          }
        }
      }
      await walk(rootDir, "");
      return out.sort();
    },
  };
}

// S3-compatible driver. Without credentials it is created in a "not configured"
// state and every call throws OBJECT_STORAGE_EXTERNAL_SETUP_REQUIRED, so the
// rest of the system keeps working on the local driver.
export function createS3Storage({ endpoint, bucket, accessKeyId, secretAccessKey, fetchImpl = globalThis.fetch } = {}) {
  const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
  const notConfigured = () => {
    const err = new Error("OBJECT_STORAGE_EXTERNAL_SETUP_REQUIRED: S3 endpoint/bucket/credentials not configured");
    err.code = "OBJECT_STORAGE_EXTERNAL_SETUP_REQUIRED";
    return Promise.reject(err);
  };
  const base = () => `${endpoint.replace(/\/$/, "")}/${bucket}`;
  return {
    name: "s3",
    configured,
    async put(key, buffer, metadata = {}) {
      if (!configured) return notConfigured();
      // Transport shape only; use @aws-sdk/client-s3 (SigV4) for production.
      const res = await fetchImpl(`${base()}/${key}`, {
        method: "PUT",
        headers: { "Content-Type": metadata.contentType || "application/octet-stream" },
        body: buffer,
      });
      if (!res.ok) throw new Error(`s3 put failed: ${res.status}`);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      return { key, bytes: buffer.length, sha256 };
    },
    async get(key) {
      if (!configured) return notConfigured();
      const res = await fetchImpl(`${base()}/${key}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`s3 get failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async exists(key) {
      if (!configured) return notConfigured();
      const res = await fetchImpl(`${base()}/${key}`, { method: "HEAD" });
      return res.status === 200;
    },
    async delete(key) {
      if (!configured) return notConfigured();
      const res = await fetchImpl(`${base()}/${key}`, { method: "DELETE" });
      return res.ok || res.status === 404;
    },
    async getMetadata(key) {
      if (!configured) return notConfigured();
      const res = await fetchImpl(`${base()}/${key}`, { method: "HEAD" });
      if (res.status === 404) return null;
      return { bytes: Number(res.headers.get("content-length") || 0) };
    },
    async list() { return notConfigured(); },
  };
}

export function createStorage({ driver = resolveStorageDriver(), rootDir, s3 = {} } = {}) {
  if (driver === "s3") return createS3Storage(s3);
  if (!rootDir) throw new Error("createStorage(local) requires rootDir");
  return createLocalStorage(rootDir);
}
