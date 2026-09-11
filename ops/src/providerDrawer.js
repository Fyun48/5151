// 第 6 包：OPS 供應商抽屜。金鑰只存在 OPS 資料目錄／ops.db，不進 v3、不進 git。
// 全部預設關。關閉＝該抽屜回到環境變數／未設定（不假裝做完）。

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

export const DRAWER_PACK = "pack6-ops-provider-drawer-v1";

export const OPS_DRAWERS = Object.freeze([
  { id: "analysis", label: "分析", envKey: "AI_PROVIDER", codes: ["none", "stub", "local", "openai", "anthropic", "gemini"] },
  { id: "clustering", label: "分群", envKey: "EMBEDDING_PROVIDER", codes: ["none", "stub", "local", "openai"] },
  { id: "evaluation", label: "評估", envKey: "EVALUATION_PROVIDER", codes: ["none", "stub", "local", "openai"] },
  { id: "proposal", label: "提案", envKey: "PROPOSAL_PROVIDER", codes: ["none", "stub", "local", "openai"] },
  { id: "coding", label: "製作", envKey: "CODING_PROVIDER", codes: ["none", "stub", "cursor", "local"] },
  { id: "review", label: "審查", envKey: "QA_REVIEW_PROVIDER", codes: ["none", "stub", "local"] },
]);

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function deriveKey(secret) {
  return createHash("sha256").update(String(secret || "ops-local-provider-secret")).digest();
}

function activeKey() {
  return deriveKey(process.env.OPS_PROVIDER_SECRET || process.env.OPS_OWNER_PASSWORD || process.env.AUTH_PASSWORD);
}

function encryptSecret(plain) {
  const text = String(plain || "");
  if (!text) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", activeKey(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce: iv.toString("base64"), ciphertext: Buffer.concat([enc, tag]).toString("base64") };
}

export function ensureProviderDrawerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_provider_drawer (
      drawer_id TEXT PRIMARY KEY,
      is_enabled INTEGER NOT NULL DEFAULT 0,
      provider_code TEXT NOT NULL DEFAULT 'none',
      credential_ref TEXT,
      notes TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ops_provider_secrets (
      credential_ref TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const now = iso();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO ops_provider_drawer(drawer_id, is_enabled, provider_code, credential_ref, notes, updated_at)
    VALUES (?, 0, 'none', NULL, '', ?)
  `);
  for (const drawer of OPS_DRAWERS) insert.run(drawer.id, now);
  return db;
}

export function resolveDrawerKind(db, drawerId, envKey, env = process.env) {
  try {
    const row = db?.prepare?.("SELECT is_enabled, provider_code FROM ops_provider_drawer WHERE drawer_id = ?")?.get(drawerId);
    if (row && Number(row.is_enabled) === 1 && row.provider_code && row.provider_code !== "none") {
      return String(row.provider_code).toLowerCase();
    }
  } catch { /* schema 未建則退回 env */ }
  return String(env[envKey] || "").toLowerCase();
}

export function listDrawers(db, env = process.env) {
  ensureProviderDrawerSchema(db);
  return OPS_DRAWERS.map((meta) => {
    const row = db.prepare("SELECT * FROM ops_provider_drawer WHERE drawer_id = ?").get(meta.id);
    const resolved = resolveDrawerKind(db, meta.id, meta.envKey, env);
    return {
      id: meta.id,
      label: meta.label,
      env_key: meta.envKey,
      codes: meta.codes,
      is_enabled: Number(row?.is_enabled) === 1,
      provider_code: row?.provider_code || "none",
      has_credential: Boolean(row?.credential_ref),
      resolved_kind: resolved || "none",
      env_kind: String(env[meta.envKey] || "") || "none",
      notes: row?.notes || "",
      updated_at: row?.updated_at || null,
    };
  });
}

export function saveDrawer(db, drawerId, input = {}, { now = new Date(), env = process.env } = {}) {
  ensureProviderDrawerSchema(db);
  const meta = OPS_DRAWERS.find((row) => row.id === drawerId);
  if (!meta) throw httpError("unknown drawer");
  const code = String(input.provider_code || input.providerCode || "none").toLowerCase();
  if (!meta.codes.includes(code)) throw httpError("unsupported provider");
  const enabled = input.is_enabled === true || input.is_enabled === 1 || input.is_enabled === "1";
  const existing = db.prepare("SELECT * FROM ops_provider_drawer WHERE drawer_id = ?").get(drawerId);
  let credentialRef = existing?.credential_ref || null;
  if (Object.prototype.hasOwnProperty.call(input, "credential") && String(input.credential || "").trim()) {
    const packed = encryptSecret(String(input.credential).trim());
    credentialRef = `drawer:${drawerId}:${randomUUID()}`;
    db.prepare("INSERT INTO ops_provider_secrets(credential_ref, nonce, ciphertext, created_at) VALUES (?, ?, ?, ?)")
      .run(credentialRef, packed.nonce, packed.ciphertext, iso(now));
  }
  if (input.clear_credential === true) credentialRef = null;
  db.prepare(`
    UPDATE ops_provider_drawer
    SET is_enabled = ?, provider_code = ?, credential_ref = ?, notes = ?, updated_at = ?
    WHERE drawer_id = ?
  `).run(enabled ? 1 : 0, code, credentialRef, String(input.notes || existing?.notes || "").slice(0, 500), iso(now), drawerId);
  return listDrawers(db, env).find((row) => row.id === drawerId);
}

export function drawersAdminView(db, env = process.env) {
  return {
    baseline: DRAWER_PACK,
    legal: "金鑰只存在 OPS 資料目錄，不進 v3、不進 git。關閉抽屜＝該關停住，前面的回饋照常進。製作端不能 push master、不能自己合 PR。",
    items: listDrawers(db, env),
  };
}
