import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import express from "express";
import { openOpsDb, defaultDataDir, defaultDbPath } from "./opsDb.js";
import { makeAuth } from "./auth.js";
import { appendAudit, listAudit, verifyAuditChain, createCheckpoint, listCheckpoints } from "./audit.js";
import { listTransitions } from "./stateMachine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");

// 建立 Ops app（依賴注入 db 與 auth，方便測試）。
export function createApp({ db, auth, publicDir = PUBLIC_DIR } = {}) {
  if (!db) throw new Error("createApp requires db");
  if (!auth) throw new Error("createApp requires auth");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  // 基本安全標頭；API 一律 no-store。
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    if (req.path.startsWith("/ops/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/ops/api/health", (_req, res) => {
    res.json({ ok: true, service: "ops", phase: 1, configured: auth.configured });
  });

  app.post("/ops/api/login", (req, res) => {
    const email = req.body?.email;
    const password = req.body?.password;
    const key = auth.attemptKey(req, email);
    try {
      auth.assertNotLocked(key);
    } catch (err) {
      res.status(err.status || 429).json({ error: err.message });
      return;
    }
    if (!auth.configured) {
      res.status(503).json({ error: "Owner 身分尚未設定（AUTH_EMAIL / AUTH_PASSWORD）" });
      return;
    }
    if (!auth.verify(email, password)) {
      auth.recordFail(key);
      appendAudit(db, { actor: `anon:${auth.attemptKey(req, email)}`, action: "owner.login.fail" });
      res.status(401).json({ error: "帳號或密碼不正確" });
      return;
    }
    auth.clearFails(key);
    res.setHeader("Set-Cookie", auth.sessionCookie(req));
    appendAudit(db, { actor: `owner:${auth.ownerEmail}`, action: "owner.login.ok" });
    res.json({ ok: true, email: auth.ownerEmail, role: "owner" });
  });

  app.post("/ops/api/logout", (req, res) => {
    res.setHeader("Set-Cookie", auth.clearCookie(req));
    res.json({ ok: true });
  });

  app.get("/ops/api/me", (req, res) => {
    const session = auth.readSession(req);
    if (!session) {
      res.json({ ok: false, role: "guest", configured: auth.configured });
      return;
    }
    res.json({ ok: true, email: session.email, role: session.role });
  });

  app.get("/ops/api/audit", auth.requireOwner, (req, res) => {
    res.json({
      items: listAudit(db, { limit: req.query?.limit, offset: req.query?.offset }),
      checkpoints: listCheckpoints(db, {}),
    });
  });

  app.get("/ops/api/audit/verify", auth.requireOwner, (_req, res) => {
    res.json(verifyAuditChain(db));
  });

  app.post("/ops/api/audit/checkpoint", auth.requireOwner, (req, res) => {
    const cp = createCheckpoint(db);
    appendAudit(db, { actor: `owner:${req.owner.email}`, action: "audit.checkpoint", data: cp });
    res.json({ ok: true, checkpoint: cp });
  });

  app.get("/ops/api/state/transitions", auth.requireOwner, (req, res) => {
    res.json({ items: listTransitions(db, { entityId: req.query?.entityId, limit: req.query?.limit }) });
  });

  // 任何未定義的 API 一律 404 JSON（不要掉進靜態檔）。
  app.all("/ops/api/*splat", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  app.use(express.static(publicDir, { index: "console.html" }));
  app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "console.html")));

  return app;
}

function resolveSessionSecret(dataDir) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
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
    // 重用既有 admin identity：預設吃 AUTH_EMAIL / AUTH_PASSWORD，可用 OPS_OWNER_* 覆寫。
    ownerEmail: process.env.OPS_OWNER_EMAIL || process.env.AUTH_EMAIL,
    ownerPassword: process.env.OPS_OWNER_PASSWORD || process.env.AUTH_PASSWORD,
    sessionSecret: resolveSessionSecret(dataDir),
    cookieSecure: process.env.COOKIE_SECURE === "1" ? true : undefined,
  });
  const app = createApp({ db, auth });
  // 預設只綁 127.0.0.1，不對外公開。要對外需明確設定 OPS_HOST。
  const host = process.env.OPS_HOST || "127.0.0.1";
  const port = Number(process.env.OPS_PORT || 5154);
  app.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Ops console (Phase 1)：http://${host}:${port}  owner=${auth.configured ? auth.ownerEmail : "(未設定)"}`);
  });
  return { app, db, auth };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  startServer();
}
