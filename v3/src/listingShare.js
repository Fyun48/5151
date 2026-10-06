// 物件一鍵分享（Phase 1）。第一方歸因，不接第三方追蹤。
//
// 與許願房分享（rentalShareGrowth.js）共用 bot 偵測、訪客雜湊、view 突發限流
// （`looksLikeBot`／`visitorHash`／`allowView`），但事件寫到獨立的
// `listing_share_events`，**不碰 `rental_share_events`**。
import { randomBytes } from "node:crypto";
import { bumpAnalytics, rentalNotifyHttpError } from "./rentalNotify.js";
import { allowView, looksLikeBot, visitorHash } from "./rentalShareGrowth.js";
import { isSelfListingId } from "./selfListings.js";
import { publicBaseUrl } from "./openLink.js";

export const LISTING_SHARE_EVENT_TYPES = Object.freeze(["view", "cta"]);
export const LISTING_SHARE_FLAGS_KEY = "listingShareFlags";
export const DEFAULT_LISTING_SHARE_DAILY_LIMIT = 20;
export const LISTING_SHARE_TABLES = ["listing_share_tokens", "listing_share_events"];

function iso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

export function normalizeListingShareFlags(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const dailyLimit = Number(src.dailyLimit);
  return {
    // Owner 已要求此功能：預設 enabled=true；flag 只做回滾開關。
    enabled: src.enabled !== false,
    dailyLimit: Number.isFinite(dailyLimit) && dailyLimit > 0
      ? Math.floor(dailyLimit)
      : DEFAULT_LISTING_SHARE_DAILY_LIMIT,
  };
}

export function getListingShareFlags(db) {
  let raw;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(LISTING_SHARE_FLAGS_KEY);
    raw = row?.value ? JSON.parse(row.value) : undefined;
  } catch {
    raw = undefined;
  }
  return normalizeListingShareFlags(raw);
}

export function ensureListingShareSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_share_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL,
      share_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listing_share_token_actor
      ON listing_share_tokens(actor_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_listing_share_token_listing
      ON listing_share_tokens(listing_id, created_at);

    CREATE TABLE IF NOT EXISTS listing_share_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER,
      share_token TEXT NOT NULL,
      event_type TEXT NOT NULL,
      channel TEXT,
      user_id INTEGER,
      visitor_hash TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listing_share_lookup
      ON listing_share_events(share_token, event_type, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_share_dedup_user
      ON listing_share_events(share_token, event_type, channel, user_id, created_at)
      WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_share_dedup_visitor
      ON listing_share_events(share_token, event_type, visitor_hash, created_at)
      WHERE event_type = 'view' AND user_id IS NULL;
  `);
}

// ---- token 產生 ----

export const LISTING_PUBLIC_ROW_SQL = "SELECT source, self_status, hidden FROM listings WHERE post_id = ?";

export function listingIsPublicRow(row, listingId) {
  if (!row) return false;
  if (Number(row.hidden) === 1) return false;
  const source = String(row.source || "591");
  if (source === "self" || isSelfListingId(listingId)) {
    return String(row.self_status || "open") === "open";
  }
  return true;
}

function listingExistsPublic(db, listingId) {
  const id = Number(listingId) || 0;
  if (!id) return false;
  let row;
  try {
    row = db.prepare(LISTING_PUBLIC_ROW_SQL).get(id);
  } catch {
    return false;
  }
  return listingIsPublicRow(row, id);
}

export const LISTING_SHARE_TOKEN_INSERT_SQL =
  "INSERT INTO listing_share_tokens(listing_id, actor_id, share_token, created_at) VALUES (?, ?, ?, ?)";
export const LISTING_SHARE_DAILY_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM listing_share_tokens WHERE actor_id = ? AND created_at >= ?";
export const LISTING_SHARE_TOKEN_ROW_SQL =
  "SELECT share_token, listing_id FROM listing_share_tokens WHERE share_token = ?";

export function countListingShareLinksForActor(db, actorId, now = new Date()) {
  const uid = Number(actorId) || 0;
  const since = `${iso(now).slice(0, 10)}T00:00:00.000Z`;
  const row = db.prepare(LISTING_SHARE_DAILY_COUNT_SQL).get(uid, since);
  return Number(row?.n) || 0;
}

export function createListingShareLink(db, { listingId, actorId, now = new Date(), flags } = {}) {
  const cfg = normalizeListingShareFlags(flags);
  const id = Number(listingId) || 0;
  const uid = Number(actorId) || 0;
  if (!id || !uid) return { ok: false, code: "listing_not_found" };
  if (!listingExistsPublic(db, id)) return { ok: false, code: "listing_not_found" };
  const dailyLimit = cfg.dailyLimit;
  const dailyUsed = countListingShareLinksForActor(db, uid, now);
  if (dailyUsed >= dailyLimit) return { ok: false, code: "daily_limit", dailyUsed, dailyLimit };
  const token = randomBytes(12).toString("base64url");
  db.prepare(LISTING_SHARE_TOKEN_INSERT_SQL).run(id, uid, token, iso(now));
  return { ok: true, shareToken: token, dailyUsed: dailyUsed + 1, dailyLimit };
}

// ---- 事件記錄 ----

export const LISTING_SHARE_DUP_BY_USER_SQL = `SELECT id, channel FROM listing_share_events
   WHERE share_token = ? AND event_type = ? AND user_id = ? AND created_at >= ?`;
export const LISTING_SHARE_DUP_BY_VISITOR_SQL = `SELECT id FROM listing_share_events
   WHERE share_token = ? AND event_type = ? AND visitor_hash = ? AND created_at >= ?
   LIMIT 1`;
export const LISTING_SHARE_EVENT_INSERT_SQL = `INSERT INTO listing_share_events
   (listing_id, share_token, event_type, channel, user_id, visitor_hash, is_bot, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

// 同日去重：view 一日一筆；cta 則「同一管道」一日一筆（不同管道各自保留歸因）。
export function pickListingShareDup(rows, eventType, channel = "") {
  const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
  if (!list.length) return null;
  if (eventType !== "cta") return list[0] || null;
  const want = channel ? String(channel).slice(0, 40) : "";
  return list.find((r) => String(r?.channel || "") === want) || null;
}

export function resolveValidListingShareToken(db, token) {
  const raw = String(token || "").trim();
  if (!raw || /^\d+$/.test(raw) || raw.length < 8) return "";
  try {
    const row = db.prepare(LISTING_SHARE_TOKEN_ROW_SQL).get(raw);
    return row?.share_token ? String(row.share_token) : "";
  } catch {
    return "";
  }
}

function listingShareTokenRow(db, token) {
  try {
    return db.prepare(LISTING_SHARE_TOKEN_ROW_SQL).get(String(token || "").trim()) || null;
  } catch {
    return null;
  }
}

export function recordListingShareEvent(db, {
  shareToken,
  eventType,
  channel = "",
  userId = null,
  ip = "",
  userAgent = "",
  now = new Date(),
  source = "public",
} = {}) {
  const type = LISTING_SHARE_EVENT_TYPES.includes(eventType) ? eventType : "";
  const token = String(shareToken || "").trim();
  if (!token || /^\d+$/.test(token)) throw rentalNotifyHttpError("無法記錄", 404, "share_not_found");
  if (!type) throw rentalNotifyHttpError("無法記錄轉換", 403, "share_conversion_forbidden");
  const row = listingShareTokenRow(db, token);
  if (!row) throw rentalNotifyHttpError("找不到分享", 404, "share_not_found");
  const valid = String(row.share_token);
  const listingId = Number(row.listing_id) || 0;
  const bot = looksLikeBot(userAgent);
  const hash = visitorHash(ip, userAgent);
  if (type === "view" && !allowView(hash, now)) throw rentalNotifyHttpError("請稍後再試", 429, "RATE_LIMITED");
  const since = `${iso(now).slice(0, 10)}T00:00:00.000Z`;
  if (userId) {
    const rows = db.prepare(LISTING_SHARE_DUP_BY_USER_SQL).all(valid, type, Number(userId), since);
    const dup = pickListingShareDup(rows, type, channel);
    if (dup) return { recorded: false, reason: "deduped", is_bot: bot };
  } else if (type === "view") {
    const dup = db.prepare(LISTING_SHARE_DUP_BY_VISITOR_SQL).get(valid, type, hash, since);
    if (dup) return { recorded: false, reason: "deduped", is_bot: bot };
  }
  db.prepare(LISTING_SHARE_EVENT_INSERT_SQL).run(
    listingId,
    valid,
    type,
    channel ? String(channel).slice(0, 40) : null,
    userId ? Number(userId) : null,
    hash,
    bot ? 1 : 0,
    iso(now),
  );
  bumpAnalytics(db, bot ? `listing_share_${type}_bot` : `listing_share_${type}`, now);
  return { recorded: true, is_bot: bot };
}

// `recordListingShareEvent()` 的 async 版（PG 島嶼用）。規則與同步版共用同一份，
// 只有「跑哪幾句 SQL」換成注入的 exec。`bump` 由呼叫端注入（PG 用 bumpAnalyticsAsync）。
export async function recordListingShareEventAsync(exec, {
  shareToken,
  eventType,
  channel = "",
  userId = null,
  ip = "",
  userAgent = "",
  now = new Date(),
  source = "public",
} = {}, { bump } = {}) {
  const type = LISTING_SHARE_EVENT_TYPES.includes(eventType) ? eventType : "";
  const token = String(shareToken || "").trim();
  if (!token || /^\d+$/.test(token)) throw rentalNotifyHttpError("無法記錄", 404, "share_not_found");
  if (!type) throw rentalNotifyHttpError("無法記錄轉換", 403, "share_conversion_forbidden");
  const rows = await exec(LISTING_SHARE_TOKEN_ROW_SQL, [token]);
  const row = (Array.isArray(rows) ? rows : (rows?.rows || []))[0] || null;
  if (!row?.share_token) throw rentalNotifyHttpError("找不到分享", 404, "share_not_found");
  const valid = String(row.share_token);
  const listingId = Number(row.listing_id) || 0;
  const bot = looksLikeBot(userAgent);
  const hash = visitorHash(ip, userAgent);
  if (type === "view" && !allowView(hash, now)) throw rentalNotifyHttpError("請稍後再試", 429, "RATE_LIMITED");
  const since = `${iso(now).slice(0, 10)}T00:00:00.000Z`;
  if (userId) {
    const dupRows = await exec(LISTING_SHARE_DUP_BY_USER_SQL, [valid, type, Number(userId), since]);
    const dup = pickListingShareDup(Array.isArray(dupRows) ? dupRows : dupRows?.rows, type, channel);
    if (dup) return { recorded: false, reason: "deduped", is_bot: bot };
  } else if (type === "view") {
    const dup = (await exec(LISTING_SHARE_DUP_BY_VISITOR_SQL, [valid, type, hash, since]))[0] || null;
    if (dup) return { recorded: false, reason: "deduped", is_bot: bot };
  }
  await exec(LISTING_SHARE_EVENT_INSERT_SQL, [
    listingId,
    valid,
    type,
    channel ? String(channel).slice(0, 40) : null,
    userId ? Number(userId) : null,
    hash,
    bot ? 1 : 0,
    iso(now),
  ]);
  if (typeof bump === "function") await bump(bot ? `listing_share_${type}_bot` : `listing_share_${type}`, now);
  return { recorded: true, is_bot: bot };
}

// ---- URL ----

export function listingSharePath(listingId, source) {
  const id = Number(listingId) || 0;
  const isSelf = String(source || "").trim() === "self" || isSelfListingId(id);
  return isSelf ? `/l/${id}` : `/go/${id}`;
}

export function listingShareUrl(listingId, shareToken, baseUrl, source) {
  const base = String(baseUrl || publicBaseUrl()).trim();
  const path = listingSharePath(listingId, source);
  return `${base}${path}?ref=${encodeURIComponent(String(shareToken || ""))}`;
}

// ---- 統計 ----

function daysAgoIso(days, now = new Date()) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return new Date(at - Number(days || 0) * 86400000).toISOString();
}

export const LISTING_SHARE_TOTALS_SQL = `SELECT
  SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END) AS views,
  SUM(CASE WHEN event_type = 'cta' THEN 1 ELSE 0 END) AS ctas
  FROM listing_share_events WHERE created_at >= ?`;
export const LISTING_SHARE_DAILY_SQL = `SELECT substr(created_at, 1, 10) AS day,
  SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END) AS views,
  SUM(CASE WHEN event_type = 'cta' THEN 1 ELSE 0 END) AS ctas
  FROM listing_share_events
  WHERE created_at >= ?
  GROUP BY substr(created_at, 1, 10)
  ORDER BY day ASC`;
export const LISTING_SHARE_TOP_SQL = `SELECT listing_id,
  SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END) AS views,
  SUM(CASE WHEN event_type = 'cta' THEN 1 ELSE 0 END) AS ctas
  FROM listing_share_events
  WHERE created_at >= ? AND listing_id IS NOT NULL
  GROUP BY listing_id
  ORDER BY views DESC, ctas DESC
  LIMIT 10`;
export const LISTING_SHARE_LINKS_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM listing_share_tokens WHERE created_at >= ?";
export const LISTING_SHARE_USER_TOKENS_SQL =
  "SELECT listing_id, share_token, created_at FROM listing_share_tokens WHERE actor_id = ? ORDER BY id DESC";
export const LISTING_SHARE_TOKEN_EVENTS_SQL =
  "SELECT event_type, COUNT(*) AS n FROM listing_share_events WHERE share_token = ? GROUP BY event_type";

function readTotals(db, sql, since) {
  const row = db.prepare(sql).get(since);
  return { views: Number(row?.views) || 0, ctas: Number(row?.ctas) || 0 };
}

export function listingShareStatsForUser(db, userId, { now = new Date(), baseUrl = "", flags } = {}) {
  const cfg = normalizeListingShareFlags(flags);
  const uid = Number(userId) || 0;
  const base = String(baseUrl || publicBaseUrl()).trim();
  if (!uid) return { dailyLimit: cfg.dailyLimit, dailyUsed: 0, totals: { views: 0, ctas: 0 }, items: [] };
  const dailyUsed = countListingShareLinksForActor(db, uid, now);
  const tokens = db.prepare(LISTING_SHARE_USER_TOKENS_SQL).all(uid);
  const counts = new Map();
  let views = 0;
  let ctas = 0;
  for (const t of tokens) {
    let v = 0;
    let c = 0;
    for (const r of db.prepare(LISTING_SHARE_TOKEN_EVENTS_SQL).all(t.share_token)) {
      if (r.event_type === "view") v = Number(r.n) || 0;
      if (r.event_type === "cta") c = Number(r.n) || 0;
    }
    views += v;
    ctas += c;
    counts.set(t.share_token, { v, c });
  }
  const items = tokens.map((t) => ({
    shareToken: t.share_token,
    listingId: Number(t.listing_id) || 0,
    url: listingShareUrl(Number(t.listing_id), t.share_token, base),
    views: counts.get(t.share_token)?.v || 0,
    ctas: counts.get(t.share_token)?.c || 0,
    createdAt: t.created_at,
  }));
  return { dailyLimit: cfg.dailyLimit, dailyUsed, totals: { views, ctas }, items };
}

export function listingShareStatsForAdmin(db, days = 7, { now = new Date() } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const since = daysAgoIso(n, now);
  const totals = readTotals(db, LISTING_SHARE_TOTALS_SQL, since);
  const daily = db.prepare(LISTING_SHARE_DAILY_SQL).all(since).map((r) => ({
    day: String(r.day),
    views: Number(r.views) || 0,
    ctas: Number(r.ctas) || 0,
  }));
  const top = db.prepare(LISTING_SHARE_TOP_SQL).all(since).map((r) => ({
    listingId: Number(r.listing_id) || 0,
    views: Number(r.views) || 0,
    ctas: Number(r.ctas) || 0,
  }));
  return { totals, daily, top };
}

export function listingShareOverview(db, days = 7, { now = new Date() } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 7));
  const since = daysAgoIso(n, now);
  const totals = readTotals(db, LISTING_SHARE_TOTALS_SQL, since);
  const linkRow = db.prepare(LISTING_SHARE_LINKS_COUNT_SQL).get(since);
  return {
    views7d: totals.views,
    ctas7d: totals.ctas,
    links7d: Number(linkRow?.n) || 0,
  };
}

// ---- OG meta（公開內頁 server-render）----

export function escapeHtmlAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function stripHtml(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function listingShareDescription(view) {
  const body = stripHtml(view?.body || "");
  if (body) return body.slice(0, 160);
  const traits = Array.isArray(view?.trait_labels) ? view.trait_labels : [];
  const fromTraits = traits.map((t) => String(t)).filter(Boolean).join("、");
  return fromTraits ? fromTraits.slice(0, 160) : "";
}

export function absoluteAssetUrl(rel, baseUrl) {
  const raw = String(rel || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) {
    const base = String(baseUrl || publicBaseUrl()).trim();
    return base ? `${base}${raw}` : "";
  }
  return "";
}

export function firstListingShareImage(view, baseUrl) {
  const cover = String(view?.cover || "").trim();
  const photos = Array.isArray(view?.photos) ? view.photos : [];
  const first = cover || (photos.length ? String(photos[0] || "").trim() : "");
  return absoluteAssetUrl(first, baseUrl);
}

// 組出 `og:*` 與 `<link rel="canonical">` 的 meta 區塊（不含 `<title>`，
// `<title>` 由 `injectListingShareMeta()` 取代既有標籤）。`image` 為空時省略 `og:image`。
export function buildListingShareOgMeta({ title, description, image, url }) {
  const t = escapeHtmlAttr(title || "");
  const d = escapeHtmlAttr(description || "");
  const u = escapeHtmlAttr(url || "");
  const tags = [
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:url" content="${u}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="吉比租房物件追蹤" />`,
    `<link rel="canonical" href="${u}" />`,
  ];
  const img = escapeHtmlAttr(image || "");
  if (img) tags.push(`<meta property="og:image" content="${img}" />`);
  return tags.join("\n  ");
}

// 把 meta 區塊塞進既有 HTML 範本的 <head>，並取代既有的 <title>（若沒有就補一個）。
export function injectListingShareMeta(template, metaBlock, title) {
  const html = String(template ?? "");
  const block = String(metaBlock ?? "");
  let out = html;
  const head = /<head[^>]*>/i.exec(out);
  if (head) {
    out = out.slice(0, head.index + head[0].length) + `\n  ${block}\n` + out.slice(head.index + head[0].length);
  }
  const newTitle = `<title>${escapeHtmlAttr(title || "")}</title>`;
  if (/<title>[\s\S]*?<\/title>/i.test(out)) {
    out = out.replace(/<title>[\s\S]*?<\/title>/i, newTitle);
  } else if (title) {
    out = out.replace(/<head[^>]*>/i, (match) => `${match}\n  ${newTitle}`);
  }
  return out;
}
