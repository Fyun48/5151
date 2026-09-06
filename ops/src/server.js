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

export function createHandler({ db, auth, publicDir = PUBLIC_DIR, ingestSecret = process.env.OPS_INGEST_SECRET || "" }) {
  if (!db) throw new Error("createHandler requires db");
  if (!auth) throw new Error("createHandler requires auth");

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
        sendJson(res, 200, { ok: true, service: "ops", phase: "2", configured: auth.configured });
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
export function createApp({ db, auth, publicDir = PUBLIC_DIR, ingestSecret = process.env.OPS_INGEST_SECRET || "" }) {
  const handler = createHandler({ db, auth, publicDir, ingestSecret });
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
    console.log(`Ops console (Phase 2)：http://${host}:${port}  owner=${auth.configured ? auth.ownerEmail : "(未設定)"}  ingest=${process.env.OPS_INGEST_SECRET ? "on" : "off"}`);
  });
  return { db, auth };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  startServer();
}
