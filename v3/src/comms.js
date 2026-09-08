/** 系統公告、贊助活動、支持本站：三個概念分開，不共用標籤／通知類型。 */

import { containsUnsafeMarkup, sanitizeDocumentText } from "./safeContent.js";
import { CURRENT_SPONSOR_BENEFITS, sanitizeHttpUrl } from "./sponsorLinks.js";
import { notifyChannelOn } from "./notifyMatrix.js";

export const ANNOUNCEMENT_SEVERITIES = [
  { id: "info", label: "一般" },
  { id: "maintenance", label: "維護" },
  { id: "warning", label: "警示" },
  { id: "important", label: "重要" },
];

export const ANNOUNCEMENT_STATUSES = ["draft", "published", "disabled"];
export const CAMPAIGN_STATUSES = ["draft", "published", "disabled"];

export const SPONSORED_CONTENT_TYPE = "sponsored";
export const SUPPORT_CONTENT_TYPE = "support";
export const SYSTEM_ANNOUNCEMENT_TYPE = "system";

export const SPONSORED_LABEL = "贊助內容";
export const SYSTEM_ANNOUNCEMENT_LABEL = "系統公告";
export const SUPPORT_LABEL = "支持本站";

export const LISTING_AD_INTERVALS = [4, 5, 6, 8, 10];
export const DEFAULT_LISTING_AD_INTERVAL = 5;
export const DEFAULT_SUPPORT_CARD_INTERVAL = 24;
export const SPONSORED_SESSION_CAP = 3;
export const ANNOUNCEMENT_TITLE_MAX = 80;
export const ANNOUNCEMENT_BODY_MAX = 800;
export const CAMPAIGN_TITLE_MAX = 60;
export const CAMPAIGN_TEXT_MAX = 160;
export const CAMPAIGN_SPONSOR_MAX = 40;
export const CTA_LABEL_MAX = 24;

export { CURRENT_SPONSOR_BENEFITS };

export const FORBIDDEN_TARGETING_FIELDS = Object.freeze([
  "race", "nationality", "religion", "health", "orientation",
  "migrant", "gender", "age", "disability", "ethnicity",
]);

const SEVERITY_IDS = new Set(ANNOUNCEMENT_SEVERITIES.map((row) => row.id));

function iso(now = new Date()) {
  return new Date(now).toISOString();
}

function httpError(message, status = 400, code = "") {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function cleanText(value, max) {
  return sanitizeDocumentText(value, max);
}

function requireSafeText(value, max, label) {
  const text = cleanText(value, max);
  if (containsUnsafeMarkup(text)) throw httpError(`${label}含有不安全內容`, 400, "unsafe_markup");
  return text;
}

function parseTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isWithinWindow(row, now = new Date()) {
  const start = parseTime(row?.start_at);
  const end = parseTime(row?.end_at);
  const at = now instanceof Date ? now : new Date(now);
  if (start && at < start) return false;
  if (end && at > end) return false;
  return true;
}

export function normalizeListingInterval(value, fallback = DEFAULT_LISTING_AD_INTERVAL) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (LISTING_AD_INTERVALS.includes(rounded)) return rounded;
  return Math.max(3, Math.min(20, rounded || fallback));
}

export function emptyCommsConfig() {
  return {
    sponsored_master_enabled: true,
    listing_placement_enabled: true,
    listing_ad_interval: DEFAULT_LISTING_AD_INTERVAL,
    support_entry_enabled: true,
    support_card_enabled: false,
    support_card_interval: DEFAULT_SUPPORT_CARD_INTERVAL,
    support_copy: "支持是自願的。沒贊助也能繼續找房與看許願房。",
  };
}

export function normalizeCommsConfig(input = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const fallback = emptyCommsConfig();
  return {
    sponsored_master_enabled: src.sponsored_master_enabled !== false,
    listing_placement_enabled: src.listing_placement_enabled !== false,
    listing_ad_interval: normalizeListingInterval(src.listing_ad_interval, fallback.listing_ad_interval),
    support_entry_enabled: src.support_entry_enabled !== false,
    support_card_enabled: src.support_card_enabled === true,
    support_card_interval: Math.max(8, Math.min(80, Number(src.support_card_interval) || fallback.support_card_interval)),
    support_copy: requireSafeText(src.support_copy || fallback.support_copy, 280, "支持說明"),
  };
}

export function ensureCommsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'info',
      status TEXT NOT NULL DEFAULT 'draft',
      enabled INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      banner INTEGER NOT NULL DEFAULT 0,
      start_at TEXT,
      end_at TEXT,
      cta_label TEXT NOT NULL DEFAULT '',
      cta_url TEXT NOT NULL DEFAULT '',
      document_type TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS announcement_member_state (
      announcement_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      read_at TEXT,
      dismissed_at TEXT,
      PRIMARY KEY (announcement_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS sponsored_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sponsor_name TEXT NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      cta_label TEXT NOT NULL DEFAULT '',
      destination_url TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL DEFAULT 'sponsored',
      enabled INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      start_at TEXT,
      end_at TEXT,
      listing_placement INTEGER NOT NULL DEFAULT 1,
      listing_interval INTEGER,
      channel_inapp INTEGER NOT NULL DEFAULT 1,
      channel_webhook INTEGER NOT NULL DEFAULT 0,
      channel_email INTEGER NOT NULL DEFAULT 0,
      channel_push INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sponsored_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      placement TEXT NOT NULL,
      bucket TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comms_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      user_id INTEGER,
      channel TEXT NOT NULL,
      state TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comms_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_id INTEGER,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_announcements_active
      ON system_announcements(enabled, status, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_campaigns_active
      ON sponsored_campaigns(enabled, status, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_sponsored_events_bucket
      ON sponsored_events(campaign_id, kind, bucket);
  `);
}

export function writeCommsAudit(db, {
  entity_type,
  entity_id,
  action,
  actor_id = null,
  detail = "",
  now = new Date(),
}) {
  db.prepare(`
    INSERT INTO comms_audit(entity_type, entity_id, action, actor_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(entity_type, entity_id, action, actor_id, String(detail || "").slice(0, 400), iso(now));
}

function announcementRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    status: row.status,
    enabled: Number(row.enabled) === 1,
    pinned: Number(row.pinned) === 1,
    banner: Number(row.banner) === 1,
    start_at: row.start_at || "",
    end_at: row.end_at || "",
    cta_label: row.cta_label || "",
    cta_url: row.cta_url || "",
    document_type: row.document_type || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
    type: SYSTEM_ANNOUNCEMENT_TYPE,
    label: SYSTEM_ANNOUNCEMENT_LABEL,
  };
}

function campaignRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sponsor_name: row.sponsor_name,
    title: row.title,
    text: row.text,
    image_url: row.image_url,
    cta_label: row.cta_label,
    destination_url: row.destination_url,
    content_type: SPONSORED_CONTENT_TYPE,
    enabled: Number(row.enabled) === 1,
    status: row.status,
    start_at: row.start_at || "",
    end_at: row.end_at || "",
    listing_placement: Number(row.listing_placement) === 1,
    listing_interval: row.listing_interval == null ? null : Number(row.listing_interval),
    channels: {
      inapp: Number(row.channel_inapp) === 1,
      webhook: Number(row.channel_webhook) === 1,
      email: Number(row.channel_email) === 1,
      push: Number(row.channel_push) === 1,
    },
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    label: SPONSORED_LABEL,
  };
}

export function publicAnnouncementView(row, { includeAdmin = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    type: SYSTEM_ANNOUNCEMENT_TYPE,
    label: SYSTEM_ANNOUNCEMENT_LABEL,
    title: row.title,
    body: row.body,
    severity: row.severity,
    pinned: row.pinned,
    banner: row.banner && (row.severity === "important" || row.severity === "maintenance" || row.severity === "warning"),
    start_at: row.start_at,
    end_at: row.end_at,
    cta_label: row.cta_label,
    cta_url: row.cta_url,
    updated_at: row.updated_at,
  };
  if (includeAdmin) {
    out.status = row.status;
    out.enabled = row.enabled;
    out.created_by = row.created_by;
    out.version = row.version;
  }
  return out;
}

export function publicCampaignView(row, { includeAdmin = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    content_type: SPONSORED_CONTENT_TYPE,
    label: SPONSORED_LABEL,
    sponsor: row.sponsor_name,
    title: row.title,
    text: row.text,
    image_url: row.image_url,
    cta_label: row.cta_label || "了解更多",
    url: row.destination_url,
    listing_placement: row.listing_placement,
  };
  if (includeAdmin) {
    out.status = row.status;
    out.enabled = row.enabled;
    out.channels = row.channels;
    out.start_at = row.start_at;
    out.end_at = row.end_at;
    out.listing_interval = row.listing_interval;
    out.impressions = row.impressions;
    out.clicks = row.clicks;
    out.created_by = row.created_by;
  }
  return out;
}

function normalizeAnnouncementInput(input = {}, { partial = false } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const title = requireSafeText(src.title, ANNOUNCEMENT_TITLE_MAX, "標題");
  if (!partial && !title) throw httpError("請填公告標題");
  const severity = SEVERITY_IDS.has(src.severity) ? src.severity : "info";
  const status = ANNOUNCEMENT_STATUSES.includes(src.status) ? src.status : (partial ? undefined : "draft");
  return {
    title,
    body: requireSafeText(src.body, ANNOUNCEMENT_BODY_MAX, "內文"),
    severity,
    status,
    enabled: src.enabled === true || src.enabled === 1,
    pinned: src.pinned === true || src.pinned === 1,
    banner: src.banner === true || src.banner === 1,
    start_at: parseTime(src.start_at) ? iso(parseTime(src.start_at)) : "",
    end_at: parseTime(src.end_at) ? iso(parseTime(src.end_at)) : "",
    cta_label: requireSafeText(src.cta_label, CTA_LABEL_MAX, "按鈕文字"),
    cta_url: sanitizeHttpUrl(src.cta_url),
    document_type: String(src.document_type || "").trim() === "wish_room_rules" ? "" : String(src.document_type || "").trim().slice(0, 40),
  };
}

function normalizeCampaignInput(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const title = requireSafeText(src.title, CAMPAIGN_TITLE_MAX, "標題");
  if (!title) throw httpError("請填贊助標題");
  const destination_url = sanitizeHttpUrl(src.destination_url || src.url);
  if (src.destination_url || src.url) {
    const raw = String(src.destination_url || src.url || "").trim();
    if (raw && !destination_url) throw httpError("贊助連結只接受 http/https", 400, "unsafe_url");
  }
  const channels = src.channels && typeof src.channels === "object" ? src.channels : {};
  return {
    sponsor_name: requireSafeText(src.sponsor_name || src.sponsor, CAMPAIGN_SPONSOR_MAX, "贊助名稱") || "合作夥伴",
    title,
    text: requireSafeText(src.text, CAMPAIGN_TEXT_MAX, "說明"),
    image_url: sanitizeHttpUrl(src.image_url),
    cta_label: requireSafeText(src.cta_label, CTA_LABEL_MAX, "按鈕文字") || "了解更多",
    destination_url,
    content_type: SPONSORED_CONTENT_TYPE,
    enabled: src.enabled === true || src.enabled === 1,
    status: CAMPAIGN_STATUSES.includes(src.status) ? src.status : "draft",
    start_at: parseTime(src.start_at) ? iso(parseTime(src.start_at)) : "",
    end_at: parseTime(src.end_at) ? iso(parseTime(src.end_at)) : "",
    listing_placement: src.listing_placement !== false && src.listing_placement !== 0,
    listing_interval: src.listing_interval == null || src.listing_interval === ""
      ? null
      : normalizeListingInterval(src.listing_interval),
    channel_inapp: channels.inapp !== false,
    channel_webhook: channels.webhook === true,
    channel_email: channels.email === true,
    channel_push: channels.push === true,
  };
}

export function createAnnouncement(db, actorId, input, now = new Date()) {
  const data = normalizeAnnouncementInput(input);
  const stamp = iso(now);
  const info = db.prepare(`
    INSERT INTO system_announcements(
      title, body, severity, status, enabled, pinned, banner,
      start_at, end_at, cta_label, cta_url, document_type,
      created_by, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    data.title, data.body, data.severity, data.status || "draft",
    data.enabled ? 1 : 0, data.pinned ? 1 : 0, data.banner ? 1 : 0,
    data.start_at || null, data.end_at || null, data.cta_label, data.cta_url,
    data.document_type || "", actorId || null, stamp, stamp,
  );
  writeCommsAudit(db, {
    entity_type: "announcement",
    entity_id: info.lastInsertRowid,
    action: "create",
    actor_id: actorId,
    detail: data.status,
    now,
  });
  return getAnnouncement(db, info.lastInsertRowid);
}

export function updateAnnouncement(db, actorId, id, input, now = new Date()) {
  const current = getAnnouncement(db, id);
  if (!current) throw httpError("找不到公告", 404);
  const data = normalizeAnnouncementInput({ ...current, ...input });
  const stamp = iso(now);
  db.prepare(`
    UPDATE system_announcements SET
      title=?, body=?, severity=?, status=?, enabled=?, pinned=?, banner=?,
      start_at=?, end_at=?, cta_label=?, cta_url=?, document_type=?,
      updated_at=?, version=version+1
    WHERE id=?
  `).run(
    data.title, data.body, data.severity, data.status || current.status,
    data.enabled ? 1 : 0, data.pinned ? 1 : 0, data.banner ? 1 : 0,
    data.start_at || null, data.end_at || null, data.cta_label, data.cta_url,
    data.document_type || "", stamp, id,
  );
  writeCommsAudit(db, {
    entity_type: "announcement",
    entity_id: id,
    action: "update",
    actor_id: actorId,
    detail: data.status || current.status,
    now,
  });
  return getAnnouncement(db, id);
}

export function publishAnnouncement(db, actorId, id, now = new Date()) {
  return updateAnnouncement(db, actorId, id, { status: "published", enabled: true }, now);
}

export function getAnnouncement(db, id) {
  return announcementRow(db.prepare("SELECT * FROM system_announcements WHERE id=?").get(id));
}

export function listAnnouncementsAdmin(db) {
  return db.prepare("SELECT * FROM system_announcements ORDER BY pinned DESC, id DESC")
    .all()
    .map(announcementRow);
}

export function resolveActiveAnnouncements(db, now = new Date()) {
  return db.prepare("SELECT * FROM system_announcements WHERE enabled=1 AND status='published' ORDER BY pinned DESC, updated_at DESC, id DESC")
    .all()
    .map(announcementRow)
    .filter((row) => isWithinWindow(row, now));
}

export function publicActiveAnnouncements(db, now = new Date()) {
  return resolveActiveAnnouncements(db, now).map((row) => publicAnnouncementView(row));
}

export function bannerAnnouncements(db, now = new Date()) {
  return publicActiveAnnouncements(db, now).filter((row) => row.banner);
}

export function markAnnouncementRead(db, userId, id, now = new Date()) {
  if (!userId) return { ok: true, anonymous: true };
  const stamp = iso(now);
  db.prepare(`
    INSERT INTO announcement_member_state(announcement_id, user_id, read_at, dismissed_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at=excluded.read_at
  `).run(id, userId, stamp);
  return { ok: true };
}

export function dismissAnnouncement(db, userId, id, now = new Date()) {
  if (!userId) return { ok: true, anonymous: true };
  const stamp = iso(now);
  db.prepare(`
    INSERT INTO announcement_member_state(announcement_id, user_id, read_at, dismissed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(announcement_id, user_id) DO UPDATE SET dismissed_at=excluded.dismissed_at, read_at=COALESCE(announcement_member_state.read_at, excluded.read_at)
  `).run(id, userId, stamp, stamp);
  return { ok: true };
}

export function announcementInboxForUser(db, userId, now = new Date()) {
  const active = resolveActiveAnnouncements(db, now);
  if (!userId) {
    return active.map((row) => ({
      ...publicAnnouncementView(row),
      read: false,
      dismissed: false,
    }));
  }
  const states = db.prepare("SELECT * FROM announcement_member_state WHERE user_id=?").all(userId);
  const map = new Map(states.map((row) => [row.announcement_id, row]));
  return active.map((row) => {
    const state = map.get(row.id);
    return {
      ...publicAnnouncementView(row),
      read: Boolean(state?.read_at),
      dismissed: Boolean(state?.dismissed_at),
    };
  }).filter((row) => !row.dismissed);
}

export function createCampaign(db, actorId, input, now = new Date()) {
  const data = normalizeCampaignInput(input);
  const stamp = iso(now);
  const info = db.prepare(`
    INSERT INTO sponsored_campaigns(
      sponsor_name, title, text, image_url, cta_label, destination_url, content_type,
      enabled, status, start_at, end_at, listing_placement, listing_interval,
      channel_inapp, channel_webhook, channel_email, channel_push,
      created_by, created_at, updated_at, impressions, clicks
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `).run(
    data.sponsor_name, data.title, data.text, data.image_url, data.cta_label, data.destination_url,
    SPONSORED_CONTENT_TYPE, data.enabled ? 1 : 0, data.status,
    data.start_at || null, data.end_at || null, data.listing_placement ? 1 : 0, data.listing_interval,
    data.channel_inapp ? 1 : 0, data.channel_webhook ? 1 : 0, data.channel_email ? 1 : 0, data.channel_push ? 1 : 0,
    actorId || null, stamp, stamp,
  );
  writeCommsAudit(db, {
    entity_type: "campaign",
    entity_id: info.lastInsertRowid,
    action: "create",
    actor_id: actorId,
    detail: data.status,
    now,
  });
  return getCampaign(db, info.lastInsertRowid);
}

export function updateCampaign(db, actorId, id, input, now = new Date()) {
  const current = getCampaign(db, id);
  if (!current) throw httpError("找不到贊助活動", 404);
  const data = normalizeCampaignInput({
    ...current,
    ...input,
    sponsor_name: input.sponsor_name ?? current.sponsor_name,
    destination_url: input.destination_url ?? input.url ?? current.destination_url,
    channels: { ...current.channels, ...(input.channels || {}) },
  });
  const stamp = iso(now);
  db.prepare(`
    UPDATE sponsored_campaigns SET
      sponsor_name=?, title=?, text=?, image_url=?, cta_label=?, destination_url=?,
      enabled=?, status=?, start_at=?, end_at=?, listing_placement=?, listing_interval=?,
      channel_inapp=?, channel_webhook=?, channel_email=?, channel_push=?, updated_at=?
    WHERE id=?
  `).run(
    data.sponsor_name, data.title, data.text, data.image_url, data.cta_label, data.destination_url,
    data.enabled ? 1 : 0, data.status, data.start_at || null, data.end_at || null,
    data.listing_placement ? 1 : 0, data.listing_interval,
    data.channel_inapp ? 1 : 0, data.channel_webhook ? 1 : 0, data.channel_email ? 1 : 0, data.channel_push ? 1 : 0,
    stamp, id,
  );
  writeCommsAudit(db, {
    entity_type: "campaign",
    entity_id: id,
    action: "update",
    actor_id: actorId,
    detail: data.status,
    now,
  });
  return getCampaign(db, id);
}

export function getCampaign(db, id) {
  return campaignRow(db.prepare("SELECT * FROM sponsored_campaigns WHERE id=?").get(id));
}

export function listCampaignsAdmin(db) {
  return db.prepare("SELECT * FROM sponsored_campaigns ORDER BY id DESC").all().map(campaignRow);
}

export function resolveActiveCampaigns(db, config = emptyCommsConfig(), now = new Date()) {
  if (config.sponsored_master_enabled === false) return [];
  return db.prepare("SELECT * FROM sponsored_campaigns WHERE enabled=1 AND status='published' ORDER BY id DESC")
    .all()
    .map(campaignRow)
    .filter((row) => isWithinWindow(row, now));
}

export function publicActiveCampaigns(db, config = emptyCommsConfig(), now = new Date()) {
  return resolveActiveCampaigns(db, config, now).map((row) => publicCampaignView(row));
}

export function listingCampaigns(db, config = emptyCommsConfig(), now = new Date()) {
  if (config.listing_placement_enabled === false) return [];
  return resolveActiveCampaigns(db, config, now).filter((row) => row.listing_placement);
}

/**
 * 把贊助卡插入顯示列，不改動 organic listings 本體。
 * organicCount / organicIds / sort 保持原陣列。
 */
export function buildSponsoredListingFeed(listings, campaigns, {
  interval = DEFAULT_LISTING_AD_INTERVAL,
  sessionCap = SPONSORED_SESSION_CAP,
} = {}) {
  const organic = Array.isArray(listings) ? listings : [];
  const cards = Array.isArray(campaigns) ? campaigns.filter((row) => row && (row.content_type || SPONSORED_CONTENT_TYPE) === SPONSORED_CONTENT_TYPE) : [];
  const step = normalizeListingInterval(interval);
  const display = [];
  let adCursor = 0;
  let shown = 0;
  for (let i = 0; i < organic.length; i += 1) {
    display.push({ kind: "listing", listing: organic[i] });
    if (cards.length && step > 0 && (i + 1) % step === 0 && shown < sessionCap) {
      const campaign = cards[adCursor % cards.length];
      display.push({
        kind: "sponsored",
        content_type: SPONSORED_CONTENT_TYPE,
        label: SPONSORED_LABEL,
        campaign: publicCampaignView(campaign.id ? campaign : { ...campaign, id: campaign.id || adCursor + 1 }) || {
          ...campaign,
          content_type: SPONSORED_CONTENT_TYPE,
          label: SPONSORED_LABEL,
        },
      });
      adCursor += 1;
      shown += 1;
    }
  }
  return {
    display,
    organicCount: organic.length,
    organicIds: organic.map((row) => row.post_id ?? row.id),
    inserted: shown,
    interval: step,
  };
}

export function hourBucket(now = new Date()) {
  return iso(now).slice(0, 13);
}

export function recordSponsoredEvent(db, campaignId, kind, placement = "listing", now = new Date()) {
  const allowed = kind === "impression" || kind === "click";
  if (!allowed) throw httpError("事件類型不正確");
  const campaign = getCampaign(db, campaignId);
  if (!campaign || !campaign.enabled || campaign.status !== "published") return { ok: false };
  const stamp = iso(now);
  db.prepare(`
    INSERT INTO sponsored_events(campaign_id, kind, placement, bucket, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(campaignId, kind, String(placement || "listing").slice(0, 40), hourBucket(now), stamp);
  if (kind === "impression") {
    db.prepare("UPDATE sponsored_campaigns SET impressions=impressions+1 WHERE id=?").run(campaignId);
  } else {
    db.prepare("UPDATE sponsored_campaigns SET clicks=clicks+1 WHERE id=?").run(campaignId);
  }
  return { ok: true };
}

export function sponsoredWebhookPayload(campaign) {
  const view = publicCampaignView(campaign) || campaign;
  return {
    type: SPONSORED_CONTENT_TYPE,
    campaign_id: String(view.id ?? campaign.id ?? ""),
    sponsor: view.sponsor || campaign.sponsor_name || "",
    title: view.title || "",
    text: view.text || "",
    url: view.url || campaign.destination_url || "",
    label: SPONSORED_LABEL,
    content: `**${SPONSORED_LABEL}**`,
    embeds: [{
      title: String(view.title || "").slice(0, 250),
      url: view.url || campaign.destination_url || "",
      description: `**${SPONSORED_LABEL}** · ${view.sponsor || campaign.sponsor_name || ""}\n${view.text || ""}`.slice(0, 1000),
    }],
  };
}

export function canDeliverSponsoredChannel(campaign, channel, settings = {}, extras = {}) {
  if (!campaign || campaign.content_type !== SPONSORED_CONTENT_TYPE) return { ok: false, state: "skipped", detail: "not_sponsored" };
  if (!campaign.enabled || campaign.status !== "published") return { ok: false, state: "skipped", detail: "inactive" };
  if (settings.notificationsPaused === true) return { ok: false, state: "skipped", detail: "paused" };
  if (!notifyChannelOn(settings, channel === "inapp" ? "dock" : channel, "sponsored")) {
    return { ok: false, state: "skipped", detail: "user_pref_off" };
  }
  const flag = campaign.channels?.[channel];
  if (!flag) return { ok: false, state: "skipped", detail: "campaign_channel_off" };
  if (channel === "webhook" && !String(settings.discordWebhook || extras.webhook || "").trim()) {
    return { ok: false, state: "skipped", detail: "no_webhook" };
  }
  if (channel === "mail" && extras.mailConfigured !== true) {
    return { ok: false, state: "unsupported", detail: "mail_not_configured" };
  }
  if (channel === "push") {
    if (extras.pushPermission && extras.pushPermission !== "granted") {
      return { ok: false, state: "skipped", detail: "push_permission" };
    }
    if (extras.pushSubscribed === false) {
      return { ok: false, state: "skipped", detail: "push_unsubscribed" };
    }
    if (extras.pushConfigured === false) {
      return { ok: false, state: "unsupported", detail: "push_not_configured" };
    }
  }
  return { ok: true, state: "ready" };
}

export async function deliverSponsoredWebhook(db, {
  campaign,
  userId = null,
  settings = {},
  sender,
  now = new Date(),
} = {}) {
  const gate = canDeliverSponsoredChannel(campaign, "webhook", settings);
  if (!gate.ok) {
    db.prepare(`
      INSERT INTO comms_deliveries(entity_type, entity_id, user_id, channel, state, detail, created_at)
      VALUES ('campaign', ?, ?, 'webhook', ?, ?, ?)
    `).run(campaign?.id || 0, userId, gate.state, gate.detail, iso(now));
    return { delivered: false, state: gate.state, detail: gate.detail };
  }
  if (typeof sender !== "function") {
    db.prepare(`
      INSERT INTO comms_deliveries(entity_type, entity_id, user_id, channel, state, detail, created_at)
      VALUES ('campaign', ?, ?, 'webhook', 'unsupported', 'no_adapter', ?)
    `).run(campaign.id, userId, iso(now));
    return { delivered: false, state: "unsupported", detail: "no_adapter" };
  }
  try {
    await sender(settings.discordWebhook, sponsoredWebhookPayload(campaign));
    db.prepare(`
      INSERT INTO comms_deliveries(entity_type, entity_id, user_id, channel, state, detail, created_at)
      VALUES ('campaign', ?, ?, 'webhook', 'sent', '', ?)
    `).run(campaign.id, userId, iso(now));
    return { delivered: true, state: "sent" };
  } catch (error) {
    db.prepare(`
      INSERT INTO comms_deliveries(entity_type, entity_id, user_id, channel, state, detail, created_at)
      VALUES ('campaign', ?, ?, 'webhook', 'failed', ?, ?)
    `).run(campaign.id, userId, String(error.message || "send_failed").slice(0, 200), iso(now));
    return { delivered: false, state: "failed", detail: error.message };
  }
}

export function supportPresentation(config, sponsorOffer = {}, { plan, role } = {}) {
  const cfg = normalizeCommsConfig(config);
  const sponsored = plan === "sponsor" || sponsorOffer.sponsored === true;
  const admin = role === "admin";
  return {
    content_type: SUPPORT_CONTENT_TYPE,
    label: SUPPORT_LABEL,
    enabled: cfg.support_entry_enabled && !admin,
    show_entry: cfg.support_entry_enabled && !admin && !sponsored,
    show_card: cfg.support_card_enabled && cfg.support_entry_enabled && !admin && !sponsored,
    card_interval: cfg.support_card_interval,
    copy: cfg.support_copy,
    benefits: CURRENT_SPONSOR_BENEFITS.map((row) => ({ ...row })),
    sponsored,
    blocking: false,
    modal: false,
  };
}

export function publicCommsBundle(db, {
  config,
  sponsorOffer,
  user,
  now = new Date(),
} = {}) {
  const cfg = normalizeCommsConfig(config);
  const announcements = announcementInboxForUser(db, user?.id || null, now);
  return {
    announcements: announcements.map((row) => ({
      ...row,
      created_by: undefined,
    })),
    banner: announcements.find((row) => row.banner && !row.dismissed) || null,
    sponsored: {
      master_enabled: cfg.sponsored_master_enabled,
      listing_enabled: cfg.listing_placement_enabled && cfg.sponsored_master_enabled,
      interval: cfg.listing_ad_interval,
      session_cap: SPONSORED_SESSION_CAP,
      cards: listingCampaigns(db, cfg, now).map((row) => publicCampaignView(row)),
      notify: user?.id
        ? resolveActiveCampaigns(db, cfg, now)
          .filter((row) => row.channels.inapp)
          .map((row) => publicCampaignView(row))
        : [],
    },
    support: supportPresentation(cfg, sponsorOffer, user || {}),
  };
}

export function commsMeta() {
  return {
    announcement_severities: ANNOUNCEMENT_SEVERITIES,
    listing_intervals: LISTING_AD_INTERVALS,
    sponsor_benefits: CURRENT_SPONSOR_BENEFITS,
    labels: {
      system: SYSTEM_ANNOUNCEMENT_LABEL,
      sponsored: SPONSORED_LABEL,
      support: SUPPORT_LABEL,
    },
    forbidden_targeting: FORBIDDEN_TARGETING_FIELDS,
  };
}
