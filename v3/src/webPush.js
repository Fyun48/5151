import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { APP_NAME } from "./brand.js";
import { trackedListingUrl } from "./openLink.js";

function eventLabel(type) {
  if (type === "new") return "全新物件";
  if (type === "same_source") return "同屋源更新";
  if (type === "relist") return "重新上架";
  if (type === "offline") return "591 已下架";
  if (type === "price_drop") return "價格調降";
  if (type === "price_update") return "價格變更";
  if (type === "title_update") return "標題更新";
  if (type === "fee_update") return "費用變更";
  if (type === "update") return "內容更新";
  return type || "更新";
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data-v3");

export function ensurePushSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
  `);
}

function vapidFilePath() {
  return path.join(DATA_DIR, "vapid.json");
}

function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const uncompressed = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pub.x, "base64url"),
    Buffer.from(pub.y, "base64url"),
  ]);
  return {
    publicKey: uncompressed.toString("base64url"),
    privateKey: String(priv.d || ""),
  };
}

function readStoredVapid() {
  const file = vapidFilePath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.publicKey && parsed?.privateKey) return parsed;
  } catch {
    return null;
  }
  return null;
}

export function loadVapidKeys() {
  const fromEnv = {
    publicKey: String(process.env.VAPID_PUBLIC_KEY || "").trim(),
    privateKey: String(process.env.VAPID_PRIVATE_KEY || "").trim(),
  };
  if (fromEnv.publicKey && fromEnv.privateKey) return fromEnv;
  const stored = readStoredVapid();
  if (stored) return stored;
  mkdirSync(DATA_DIR, { recursive: true });
  const generated = generateVapidKeys();
  writeFileSync(vapidFilePath(), JSON.stringify(generated, null, 2), { encoding: "utf8", mode: 0o600 });
  return generated;
}

export function publicVapidKey() {
  try {
    return loadVapidKeys().publicKey;
  } catch {
    return "";
  }
}

export function vapidConfigured() {
  const keys = loadVapidKeys();
  return Boolean(keys.publicKey && keys.privateKey);
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function savePushSubscription(db, userId, sub = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const endpoint = String(sub.endpoint || "").trim();
  const p256dh = String(sub.keys?.p256dh || sub.p256dh || "").trim();
  const auth = String(sub.keys?.auth || sub.auth || "").trim();
  if (!/^https:\/\//i.test(endpoint) || !p256dh || !auth) {
    throw httpError("推播訂閱格式不正確");
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       last_seen_at = excluded.last_seen_at`,
  ).run(uid, endpoint, p256dh, auth, now, now);
  return { ok: true };
}

export function deletePushSubscription(db, userId, endpoint) {
  const uid = Number(userId) || 0;
  const url = String(endpoint || "").trim();
  if (!uid || !url) return { ok: true };
  db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(uid, url);
  return { ok: true };
}

export function listPushSubscriptions(db, userId) {
  return db.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?",
  ).all(Number(userId) || 0);
}

function dropEndpoint(db, endpoint) {
  try {
    db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  } catch {
    // ignore
  }
}

async function loadWebPushLib() {
  try {
    const mod = await import("web-push");
    return mod.default || mod;
  } catch {
    return null;
  }
}

export function pushPayloadFromEvents(events = []) {
  const list = Array.isArray(events) ? events : [];
  const first = list[0] || {};
  const title = APP_NAME;
  const kind = eventLabel(first.type);
  const body = list.length > 1
    ? `${kind}等 ${list.length} 則更新`
    : `${kind}：${String(first.title || "物件").slice(0, 80)}`;
  return {
    title,
    body,
    url: trackedListingUrl(first.post_id, first.url) || "/",
  };
}

export async function sendWebPush(db, userId, payload) {
  const subs = listPushSubscriptions(db, userId);
  if (!subs.length) return { sent: 0, skipped: "no-sub" };
  const keys = loadVapidKeys();
  if (!keys.publicKey || !keys.privateKey) return { sent: 0, skipped: "no-vapid" };
  const webpush = await loadWebPushLib();
  if (!webpush) return { sent: 0, skipped: "no-lib" };
  const subject = String(process.env.VAPID_SUBJECT || process.env.PUBLIC_BASE_URL_V3 || "mailto:admin@localhost");
  try {
    webpush.setVapidDetails(/^mailto:|^https?:\/\//i.test(subject) ? subject : `mailto:${subject}`, keys.publicKey, keys.privateKey);
  } catch {
    return { sent: 0, skipped: "vapid-invalid" };
  }
  const body = JSON.stringify(payload || { title: APP_NAME, body: "有新的物件更新", url: "/" });
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 60 * 60 },
      );
      sent += 1;
    } catch (error) {
      const status = Number(error?.statusCode || error?.status || 0);
      if (status === 404 || status === 410) dropEndpoint(db, sub.endpoint);
    }
  }
  return { sent };
}
