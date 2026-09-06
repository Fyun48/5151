import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { openOpsDb, defaultDataDir, defaultDbPath } from "./opsDb.js";
import { makeAuth } from "./auth.js";
import { appendAudit, listAudit, verifyAuditChain, createCheckpoint, listCheckpoints } from "./audit.js";
import { listTransitions } from "./stateMachine.js";
import { verifyIngestRequest, bodyHashHex } from "./ingestSignature.js";
import { ingestFeedback } from "./ingest.js";
import {
  acceptAttachment,
  getAttachmentRow,
  publicAttachmentMeta,
  listAttachments,
  contentDisposition,
  maxUploadBytes,
} from "./attachments.js";
import { LocalPersistentStorage, defaultAttachmentDir } from "./storage/localStorage.js";
import { makeScanner } from "./malwareScan.js";

// 刻意不使用 express：ops 服務維持「零外部相依」，與本 repo 的 CI（不跑 npm install）相容，
// 也縮小攻擊面。所有路由用 node:http 手刻的極小 router。

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const BODY_LIMIT = 256 * 1024;

const STATIC_FILES = {
  "/": { file: "console.html", type: "text/html; charset=utf-8" },
  "/console.html": { file: "console.html", type: "text/html; charset=utf-8" },
  "/console.css": { file: "console.css", type: "text/css; charset=utf-8" },
  "/console.js": { file: "console.js", type: "application/javascript; charset=utf-8" },
};

function securityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  if ((req.url || "").startsWith("/ops/api/")) res.setHeader("Cache-Control", "no-store");
}

// 讓 auth 的 express-style middleware（res.status().json()）能在 node:http 上重用。
function makeReply(res) {
  return {
    _status: 200,
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) { this._status = code; return this; },
    json(obj) {
      res.writeHead(this._status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    },
  };
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 讀取上傳 body（附件）：串流累積並在超過上限時「提早中止」，記憶體用量受 limit 約束。
function readBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// 執行一個 express-style middleware；回傳 true 表示放行（next 被呼叫），false 表示已自行回應。
function runGuard(mw, req, reply) {
  let passed = false;
  mw(req, reply, () => { passed = true; });
  return passed;
}

export function createHandler({ db, auth, publicDir = PUBLIC_DIR, ingestSecret = process.env.OPS_INGEST_SECRET || "", storage = null, scanner = null }) {
  if (!db) throw new Error("createHandler requires db");
  if (!auth) throw new Error("createHandler requires auth");
  const store = storage || new LocalPersistentStorage(defaultAttachmentDir(process.env.OPS_DATA_DIR || process.cwd()));
  const scan = scanner || makeScanner();

  return async function handler(req, res) {
    try {
      securityHeaders(req, res);
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;
      const method = req.method || "GET";
      const reply = makeReply(res);

      // ── 靜態檔（登入前可讀，無需 cookie） ──
      if (method === "GET" && STATIC_FILES[pathname]) {
        const entry = STATIC_FILES[pathname];
        const full = path.join(publicDir, entry.file);
        try {
          const buf = readFileSync(full);
          res.writeHead(200, { "Content-Type": entry.type });
          res.end(buf);
        } catch {
          sendJson(res, 404, { error: "not found" });
        }
        return;
      }

      // ── 公開 API ──
      if (pathname === "/ops/api/health" && method === "GET") {
        sendJson(res, 200, { ok: true, service: "ops", phase: "3", configured: auth.configured });
        return;
      }

      // ── Ingest（HMAC 認證，非 Owner session） ──
      if (pathname === "/ops/api/ingest/feedback" && method === "POST") {
        if (!ingestSecret) {
          sendJson(res, 503, { error: "ingest not configured" });
          return;
        }
        const raw = await readRawBody(req);
        const check = verifyIngestRequest({
          method: "POST",
          path: "/ops/api/ingest/feedback",
          headers: req.headers,
          rawBody: raw,
          secret: ingestSecret,
        });
        if (!check.ok) {
          // 不外洩簽章細節；只回通用錯誤（reason 僅供內部推斷）。
          const status = check.reason === "expired_timestamp" ? 401 : 401;
          sendJson(res, status, { error: "unauthorized" });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        // 防 payload 替換：header 的 delivery 必須與 body 一致（body-hash 已在簽章內驗過）。
        if (String(payload.delivery_id || "") !== check.deliveryId) {
          sendJson(res, 400, { error: "delivery_id mismatch" });
          return;
        }
        try {
          const result = ingestFeedback(db, { deliveryId: check.deliveryId, payload, payloadHash: check.bodyHash });
          if (result.conflict) {
            // delivery_id / idempotency_key 被重用於不同內容 → 409，不覆寫原紀錄。
            sendJson(res, 409, { error: "conflict", reason: result.reason });
            return;
          }
          sendJson(res, 200, { ok: true, id: result.id, duplicate: result.duplicate });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (pathname === "/ops/api/login" && method === "POST") {
        const body = await readBody(req).catch((e) => { throw e; });
        const email = body?.email;
        const key = auth.attemptKey(req, email);
        try {
          auth.assertNotLocked(key);
        } catch (err) {
          sendJson(res, err.status || 429, { error: err.message });
          return;
        }
        if (!auth.configured) {
          sendJson(res, 503, { error: "Owner 身分尚未設定（AUTH_EMAIL / AUTH_PASSWORD / OPS_SESSION_SECRET）" });
          return;
        }
        if (!auth.verify(email, body?.password)) {
          auth.recordFail(key);
          // 稽核只記錄「有一次失敗登入」與來源 IP，不記帳號輸入內容、不記密碼。
          appendAudit(db, { actor: `anon:${auth.clientIp(req)}`, action: "owner.login.fail" });
          sendJson(res, 401, { error: "帳號或密碼不正確" });
          return;
        }
        auth.clearFails(key);
        res.setHeader("Set-Cookie", auth.sessionCookie(req));
        appendAudit(db, { actor: `owner:${auth.ownerEmail}`, action: "owner.login.ok" });
        // 前端登入成功後會呼叫 /ops/api/me 取得 CSRF token（用新 cookie）。
        sendJson(res, 200, { ok: true, email: auth.ownerEmail, role: "owner" });
        return;
      }

      if (pathname === "/ops/api/logout" && method === "POST") {
        // logout 也是 state-changing，但即便 CSRF 失敗也允許清除自身 cookie（降風險、不擴權）。
        res.setHeader("Set-Cookie", auth.clearCookie(req));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/ops/api/me" && method === "GET") {
        const session = auth.readSession(req);
        if (!session) {
          sendJson(res, 200, { ok: false, role: "guest", configured: auth.configured });
          return;
        }
        res.setHeader("Set-Cookie", auth.slideCookie(req, session));
        sendJson(res, 200, { ok: true, email: session.email, role: session.role, csrfToken: auth.csrfTokenFor(session) });
        return;
      }

      // ── Owner-only 讀取 API ──
      if (pathname === "/ops/api/audit" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const page = listAudit(db, { limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") });
        sendJson(res, 200, { ...page, checkpoints: listCheckpoints(db, {}) });
        return;
      }

      if (pathname === "/ops/api/audit/verify" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        sendJson(res, 200, verifyAuditChain(db));
        return;
      }

      if (pathname === "/ops/api/state/transitions" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        sendJson(res, 200, { items: listTransitions(db, { entityId: url.searchParams.get("entityId"), limit: url.searchParams.get("limit") }) });
        return;
      }

      // ── Owner-only mutation API（需 CSRF + 同源） ──
      if (pathname === "/ops/api/audit/checkpoint" && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        const cp = createCheckpoint(db);
        appendAudit(db, { actor: `owner:${req.owner.email}`, action: "audit.checkpoint", data: cp });
        sendJson(res, 200, { ok: true, checkpoint: cp });
        return;
      }

      // ── 附件上傳（Owner + CSRF） ──
      if (pathname === "/ops/api/attachments" && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        const limit = maxUploadBytes();
        const declaredLen = Number(req.headers["content-length"] || 0);
        if (declaredLen && declaredLen > limit) {
          sendJson(res, 413, { error: "payload too large" });
          return;
        }
        let buffer;
        try {
          buffer = await readBinaryBody(req, limit);
        } catch (e) {
          sendJson(res, e.status || 400, { error: e.status === 413 ? "payload too large" : "read error" });
          return;
        }
        const feedbackId = req.headers["x-feedback-id"];
        const declaredMime = req.headers["content-type"] || "";
        const filename = req.headers["x-filename"] || "attachment";
        const piiFlag = String(req.headers["x-pii-flag"] || "") === "1";
        try {
          const result = await acceptAttachment(db, { storage: store, scanner: scan }, {
            feedbackId, declaredMime, filename, buffer, piiFlag,
          });
          sendJson(res, 201, { ok: true, ...result });
        } catch (err) {
          // 稽核拒絕（只記 metadata，不記內容）
          appendAudit(db, {
            actor: `owner:${req.owner?.email || "?"}`,
            action: "attachment.rejected",
            data: { reason: err.message?.slice(0, 120), mime: String(declaredMime).slice(0, 64), bytes: buffer?.length || 0 },
          });
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      // ── 附件 metadata（Owner） ──
      const metaMatch = pathname.match(/^\/ops\/api\/attachments\/(\d+)\/meta$/);
      if (metaMatch && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const row = getAttachmentRow(db, metaMatch[1]);
        if (!row) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, publicAttachmentMeta(row));
        return;
      }

      // ── 附件內容下載（Owner，強制下載、安全標頭） ──
      const dlMatch = pathname.match(/^\/ops\/api\/attachments\/(\d+)$/);
      if (dlMatch && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const row = getAttachmentRow(db, dlMatch[1]);
        if (!row) { sendJson(res, 404, { error: "not found" }); return; }
        let bytes;
        try {
          bytes = await store.get(row.object_key);
        } catch {
          sendJson(res, 410, { error: "object missing" });
          return;
        }
        appendAudit(db, {
          actor: `owner:${req.owner?.email || "?"}`,
          action: "attachment.downloaded",
          entityType: "feedback_attachment",
          entityId: String(row.id),
          data: { feedback_id: row.feedback_id, mime: row.mime, bytes: row.bytes },
        });
        // MVP：所有型別一律強制下載，Ops Console origin 內絕不 inline 執行（HTML/SVG/未知）。
        res.setHeader("Content-Type", row.mime);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Disposition", contentDisposition(row.original_filename, "attachment"));
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(200);
        res.end(bytes);
        return;
      }

      // ── 列出某 feedback 的附件 metadata（Owner） ──
      if (pathname === "/ops/api/attachments" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const items = listAttachments(db, { feedbackId: url.searchParams.get("feedbackId"), limit: url.searchParams.get("limit") });
        sendJson(res, 200, { items: items.map(publicAttachmentMeta) });
        return;
      }

      if (pathname.startsWith("/ops/api/")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const status = err?.status || 500;
      sendJson(res, status, { error: status === 500 ? "internal error" : err.message });
    }
  };
}

// 相容舊測試/呼叫：createApp 回傳一個 { listen } 介面（用 node:http 包裝 handler）。
export function createApp({ db, auth, publicDir = PUBLIC_DIR, ingestSecret = process.env.OPS_INGEST_SECRET || "", storage = null, scanner = null }) {
  const handler = createHandler({ db, auth, publicDir, ingestSecret, storage, scanner });
  return {
    handler,
    listen(...args) {
      return http.createServer(handler).listen(...args);
    },
  };
}

function resolveSessionSecret(dataDir) {
  // 必須與 v3 的 SESSION_SECRET 分離：只吃 OPS_SESSION_SECRET，否則自行產生並持久化。
  if (process.env.OPS_SESSION_SECRET) return process.env.OPS_SESSION_SECRET;
  const file = path.join(dataDir, "ops.session.secret");
  try {
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
    const secret = randomBytes(32).toString("hex");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch {
    return randomBytes(32).toString("hex");
  }
}

export function startServer() {
  const dataDir = defaultDataDir();
  const db = openOpsDb(defaultDbPath());
  const auth = makeAuth({
    ownerEmail: process.env.OPS_OWNER_EMAIL || process.env.AUTH_EMAIL,
    ownerPassword: process.env.OPS_OWNER_PASSWORD || process.env.AUTH_PASSWORD,
    sessionSecret: resolveSessionSecret(dataDir),
    cookieSecure: process.env.COOKIE_SECURE === "1" ? true : undefined,
  });
  const handler = createHandler({ db, auth });
  const host = process.env.OPS_HOST || "127.0.0.1";
  const port = Number(process.env.OPS_PORT || 5154);
  http.createServer(handler).listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Ops console (Phase 3)：http://${host}:${port}  owner=${auth.configured ? auth.ownerEmail : "(未設定)"}  ingest=${process.env.OPS_INGEST_SECRET ? "on" : "off"}`);
  });
  return { db, auth };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  startServer();
}
