// 站內公告與贊助活動（comms）的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 涵蓋的路由：
//   GET    /api/admin/announcements            後台列表
//   POST   /api/admin/announcements            建立
//   PATCH  /api/admin/announcements/:id        更新
//   POST   /api/admin/announcements/:id/publish
//   GET    /api/admin/campaigns                後台列表
//   POST   /api/admin/campaigns                建立
//   PATCH  /api/admin/campaigns/:id            更新
//   GET    /api/announcements                  公開（進行中 ＋ 橫幅）
//   GET    /api/announcements/inbox            個人收件匣（已讀／已關閉）
//   POST   /api/announcements/:id/read
//   POST   /api/announcements/:id/dismiss
//   POST   /api/sponsored/:id/event            曝光／點擊
//
// 這一批的方言陷阱比前幾批少（`ON CONFLICT … DO UPDATE SET … excluded` 與
// `version=version+1` 兩邊都合法），真正要自己補的是**索引**：
// 實測正式站這五張表**只有 pkey**（匯入時 indexes:false），`idx_announcements_active`、
// `idx_campaigns_active`、`idx_sponsored_events_bucket` 都不存在。它們不是唯一約束，
// 少了不會壞，但公告／活動的「生效中」查詢與事件統計會退化成全表掃描——而
// `/api/announcements` 是**每個訪客都會打的**端點，所以補起來。
//
// ⚠️ 唯一一個刻意的差異：`recordSponsoredEvent` 在同步版是「INSERT 事件 → UPDATE 計數」
// 兩句、**沒有交易**。PG 這邊包在一個交易裡（曝光數與事件列不該只成立一半）。
// 回傳值與判斷完全不變。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import {
  INSERT_COMMS_AUDIT_SQL,
  announcementInboxForUser as announcementInboxForUserSync,
  announcementRow,
  bannerAnnouncements as bannerAnnouncementsSync,
  campaignRow,
  commsAuditParams,
  createAnnouncement as createAnnouncementSync,
  createCampaign as createCampaignSync,
  dismissAnnouncement as dismissAnnouncementSync,
  emptyCommsConfig,
  getAnnouncement as getAnnouncementSync,
  getCampaign as getCampaignSync,
  hourBucket,
  httpError,
  isWithinWindow,
  iso,
  listAnnouncementsAdmin as listAnnouncementsAdminSync,
  listCampaignsAdmin as listCampaignsAdminSync,
  listingCampaigns as listingCampaignsSync,
  markAnnouncementRead as markAnnouncementReadSync,
  normalizeAnnouncementInput,
  normalizeCampaignInput,
  normalizeCommsConfig,
  publicCommsBundle as publicCommsBundleSync,
  publicActiveAnnouncements as publicActiveAnnouncementsSync,
  publicActiveCampaigns as publicActiveCampaignsSync,
  publicAnnouncementView,
  publicCampaignView,
  publishAnnouncement as publishAnnouncementSync,
  recordSponsoredEvent as recordSponsoredEventSync,
  resolveActiveAnnouncements as resolveActiveAnnouncementsSync,
  resolveActiveCampaigns as resolveActiveCampaignsSync,
  SPONSORED_SESSION_CAP,
  supportPresentation,
  updateAnnouncement as updateAnnouncementSync,
  updateCampaign as updateCampaignSync,
} from "./comms.js";

// ---- 語句文字（逐字對應 comms.js 的行號）----
export const ANN_BY_ID_SQL = "SELECT * FROM system_announcements WHERE id=?"; // comms.js:443
export const ANN_LIST_SQL = "SELECT * FROM system_announcements ORDER BY pinned DESC, id DESC"; // comms.js:447
export const ANN_ACTIVE_SQL =
  "SELECT * FROM system_announcements WHERE enabled=1 AND status='published' ORDER BY pinned DESC, updated_at DESC, id DESC"; // comms.js:453
export const ANN_INSERT_SQL = `
    INSERT INTO system_announcements(
      title, body, severity, status, enabled, pinned, banner,
      start_at, end_at, cta_label, cta_url, document_type,
      created_by, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) RETURNING *`; // comms.js:387
export const ANN_UPDATE_SQL = `
    UPDATE system_announcements SET
      title=?, body=?, severity=?, status=?, enabled=?, pinned=?, banner=?,
      start_at=?, end_at=?, cta_label=?, cta_url=?, document_type=?,
      updated_at=?, version=version+1
    WHERE id=?`; // comms.js:415
export const ANN_STATE_UPSERT_READ_SQL = `
    INSERT INTO announcement_member_state(announcement_id, user_id, read_at, dismissed_at)
    VALUES (?, ?, ?, NULL)
    ON CONFLICT(announcement_id, user_id) DO UPDATE SET read_at=excluded.read_at`; // comms.js:470
export const ANN_STATE_UPSERT_DISMISS_SQL = `
    INSERT INTO announcement_member_state(announcement_id, user_id, read_at, dismissed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(announcement_id, user_id) DO UPDATE SET dismissed_at=excluded.dismissed_at, read_at=COALESCE(announcement_member_state.read_at, excluded.read_at)`; // comms.js:481
export const ANN_STATES_FOR_USER_SQL = "SELECT * FROM announcement_member_state WHERE user_id=?"; // comms.js:498
export const CAMP_BY_ID_SQL = "SELECT * FROM sponsored_campaigns WHERE id=?"; // comms.js:574
export const CAMP_LIST_SQL = "SELECT * FROM sponsored_campaigns ORDER BY id DESC"; // comms.js:578
export const CAMP_ACTIVE_SQL =
  "SELECT * FROM sponsored_campaigns WHERE enabled=1 AND status='published' ORDER BY id DESC"; // comms.js:583
export const CAMP_INSERT_SQL = `
    INSERT INTO sponsored_campaigns(
      sponsor_name, title, text, image_url, cta_label, destination_url, content_type,
      enabled, status, start_at, end_at, listing_placement, listing_interval,
      channel_inapp, channel_webhook, channel_email, channel_push,
      created_by, created_at, updated_at, impressions, clicks
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0) RETURNING *`; // comms.js:513
export const CAMP_UPDATE_SQL = `
    UPDATE sponsored_campaigns SET
      sponsor_name=?, title=?, text=?, image_url=?, cta_label=?, destination_url=?,
      enabled=?, status=?, start_at=?, end_at=?, listing_placement=?, listing_interval=?,
      channel_inapp=?, channel_webhook=?, channel_email=?, channel_push=?, updated_at=?
    WHERE id=?`; // comms.js:549
export const EVENT_INSERT_SQL = `
    INSERT INTO sponsored_events(campaign_id, kind, placement, bucket, created_at)
    VALUES (?, ?, ?, ?, ?)`; // comms.js:651
export const IMPRESSION_BUMP_SQL = "UPDATE sponsored_campaigns SET impressions=impressions+1 WHERE id=?"; // comms.js:656
export const CLICK_BUMP_SQL = "UPDATE sponsored_campaigns SET clicks=clicks+1 WHERE id=?"; // comms.js:658

// ---- schema ----
// 對應 comms.js:115 `ensureCommsSchema()`。索引名稱逐字相同（PG 正式站目前沒有這三個）。
export const PG_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS system_announcements (
     id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
     title TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     severity TEXT NOT NULL DEFAULT 'info',
     status TEXT NOT NULL DEFAULT 'draft',
     enabled BIGINT NOT NULL DEFAULT 0,
     pinned BIGINT NOT NULL DEFAULT 0,
     banner BIGINT NOT NULL DEFAULT 0,
     start_at TEXT,
     end_at TEXT,
     cta_label TEXT NOT NULL DEFAULT '',
     cta_url TEXT NOT NULL DEFAULT '',
     document_type TEXT NOT NULL DEFAULT '',
     created_by BIGINT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     version BIGINT NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS announcement_member_state (
     announcement_id BIGINT NOT NULL,
     user_id BIGINT NOT NULL,
     read_at TEXT,
     dismissed_at TEXT,
     PRIMARY KEY (announcement_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS sponsored_campaigns (
     id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
     sponsor_name TEXT NOT NULL,
     title TEXT NOT NULL,
     text TEXT NOT NULL DEFAULT '',
     image_url TEXT NOT NULL DEFAULT '',
     cta_label TEXT NOT NULL DEFAULT '',
     destination_url TEXT NOT NULL DEFAULT '',
     content_type TEXT NOT NULL DEFAULT 'sponsored',
     enabled BIGINT NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'draft',
     start_at TEXT,
     end_at TEXT,
     listing_placement BIGINT NOT NULL DEFAULT 1,
     listing_interval BIGINT,
     channel_inapp BIGINT NOT NULL DEFAULT 1,
     channel_webhook BIGINT NOT NULL DEFAULT 0,
     channel_email BIGINT NOT NULL DEFAULT 0,
     channel_push BIGINT NOT NULL DEFAULT 0,
     created_by BIGINT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     impressions BIGINT NOT NULL DEFAULT 0,
     clicks BIGINT NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS sponsored_events (
     id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
     campaign_id BIGINT NOT NULL,
     kind TEXT NOT NULL,
     placement TEXT NOT NULL,
     bucket TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS comms_audit (
     id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
     entity_type TEXT NOT NULL,
     entity_id BIGINT NOT NULL,
     action TEXT NOT NULL,
     actor_id BIGINT,
     detail TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_announcements_active ON system_announcements(enabled, status, start_at, end_at)",
  "CREATE INDEX IF NOT EXISTS idx_campaigns_active ON sponsored_campaigns(enabled, status, start_at, end_at)",
  "CREATE INDEX IF NOT EXISTS idx_sponsored_events_bucket ON sponsored_events(campaign_id, kind, bucket)",
];

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const firstRow = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

// 🚨 注入式 `exec` 要正規化成**裸陣列**（這個模組的 PG runner 一律吃陣列）；
// 照 `crmOutboxAsync` 慣例傳 `{ rows, rowCount }` 時會被當成「沒有資料列」而靜默少讀。
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

async function pgExec(options = {}) {
  if (options.exec) {
    const injected = options.exec;
    return async (sql, params = []) => rowsOf(await injected(sql, params));
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

const schemaReady = new WeakMap();
export async function ensureCommsStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = (async () => {
    for (const sql of PG_SCHEMA_STATEMENTS) await pgDriver.exec(sql);
  })();
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

async function pgHandle(options = {}) {
  const exec = await pgExec(options);
  if (!options.exec) await ensureCommsStoreOnce(options.pgDriver || (await sharedPgDriver()));
  return exec;
}

async function withFallback(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres(await pgHandle(options));
  } catch (error) {
    if (!sqliteFallbackAllowed(options)) throw error;
    return runSqlite();
  }
}

async function withFallbackTx(options, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) return await runPostgres(await pgExec(options));
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureCommsStoreOnce(pgDriver);
    return await pgDriver.withTransaction(async (client) => {
      const exec = (sql, params = []) => client.query(toPostgresSql(sql), params).then((res) => res.rows);
      return runPostgres(exec);
    });
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return runSqlite();
  }
}

// 稽核：同步版是 `writeCommsAudit()`；參數組法共用 `commsAuditParams()`，只有 SQL 那一句是新的。
const writeAudit = (exec, entry) => exec(INSERT_COMMS_AUDIT_SQL, commsAuditParams(entry));

const stampOf = (now) => iso(now instanceof Date ? now : new Date(now || Date.now()));
const asDate = (now) => (now instanceof Date ? now : new Date(now || Date.now()));

const readAnnouncement = async (exec, id) => announcementRow(firstRow(await exec(ANN_BY_ID_SQL, [Number(id) || 0])));
const readCampaign = async (exec, id) => campaignRow(firstRow(await exec(CAMP_BY_ID_SQL, [Number(id) || 0])));

// ---- 公告：讀取 ----

export async function getAnnouncementAsync(id, options = {}) {
  return withFallback(
    options,
    (exec) => readAnnouncement(exec, id),
    () => getAnnouncementSync(sqliteHandle(), id),
  );
}

export async function listAnnouncementsAdminAsync(options = {}) {
  return withFallback(
    options,
    async (exec) => (await exec(ANN_LIST_SQL)).map(announcementRow),
    () => listAnnouncementsAdminSync(sqliteHandle()),
  );
}

export async function resolveActiveAnnouncementsAsync({ now = new Date(), ...options } = {}) {
  return withFallback(
    options,
    async (exec) => (await exec(ANN_ACTIVE_SQL))
      .map(announcementRow)
      .filter((row) => isWithinWindow(row, asDate(now))),
    () => resolveActiveAnnouncementsSync(sqliteHandle(), asDate(now)),
  );
}

export async function publicActiveAnnouncementsAsync({ now = new Date(), ...options } = {}) {
  if (!isPg(options)) return publicActiveAnnouncementsSync(sqliteHandle(), asDate(now));
  const rows = await resolveActiveAnnouncementsAsync({ now, ...options });
  return rows.map((row) => publicAnnouncementView(row));
}

export async function bannerAnnouncementsAsync({ now = new Date(), ...options } = {}) {
  if (!isPg(options)) return bannerAnnouncementsSync(sqliteHandle(), asDate(now));
  const rows = await publicActiveAnnouncementsAsync({ now, ...options });
  return rows.filter((row) => row.banner);
}

export async function announcementInboxForUserAsync(userId, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return announcementInboxForUserSync(sqliteHandle(), userId, asDate(now));
  const active = await resolveActiveAnnouncementsAsync({ now, ...options });
  if (!userId) {
    return active.map((row) => ({ ...publicAnnouncementView(row), read: false, dismissed: false }));
  }
  const exec = await pgHandle(options);
  const states = await exec(ANN_STATES_FOR_USER_SQL, [Number(userId)]);
  const map = new Map(states.map((row) => [row.announcement_id, row]));
  return active.map((row) => {
    const state = map.get(row.id);
    return { ...publicAnnouncementView(row), read: Boolean(state?.read_at), dismissed: Boolean(state?.dismissed_at) };
  }).filter((row) => !row.dismissed);
}

// ---- 公告：寫入 ----

export async function createAnnouncementAsync(actorId, input, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return createAnnouncementSync(sqliteHandle(), actorId, input, asDate(now));
  const data = normalizeAnnouncementInput(input); // 純驗證，兩邊共用同一份
  const stamp = stampOf(now);
  return withFallbackTx(options, async (exec) => {
    const row = firstRow(await exec(ANN_INSERT_SQL, [
      data.title, data.body, data.severity, data.status || "draft",
      data.enabled ? 1 : 0, data.pinned ? 1 : 0, data.banner ? 1 : 0,
      data.start_at || null, data.end_at || null, data.cta_label, data.cta_url,
      data.document_type || "", actorId || null, stamp, stamp,
    ]));
    const doc = announcementRow(row);
    await writeAudit(exec, {
      entity_type: "announcement", entity_id: doc.id, action: "create",
      actor_id: actorId, detail: data.status, now: asDate(now),
    });
    return doc;
  }, () => createAnnouncementSync(sqliteHandle(), actorId, input, asDate(now)));
}

export async function updateAnnouncementAsync(actorId, id, input, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return updateAnnouncementSync(sqliteHandle(), actorId, id, input, asDate(now));
  const stamp = stampOf(now);
  return withFallbackTx(options, async (exec) => {
    const current = await readAnnouncement(exec, id);
    if (!current) throw httpError("找不到公告", 404);
    // 同步版是 `{ ...current, ...input }` ⇒ 沒帶的欄位沿用目前值。
    const data = normalizeAnnouncementInput({ ...current, ...input });
    const status = data.status || current.status;
    await exec(ANN_UPDATE_SQL, [
      data.title, data.body, data.severity, status,
      data.enabled ? 1 : 0, data.pinned ? 1 : 0, data.banner ? 1 : 0,
      data.start_at || null, data.end_at || null, data.cta_label, data.cta_url,
      data.document_type || "", stamp, Number(id),
    ]);
    await writeAudit(exec, {
      entity_type: "announcement", entity_id: Number(id), action: "update",
      actor_id: actorId, detail: status, now: asDate(now),
    });
    return readAnnouncement(exec, id);
  }, () => updateAnnouncementSync(sqliteHandle(), actorId, id, input, asDate(now)));
}

export async function publishAnnouncementAsync(actorId, id, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return publishAnnouncementSync(sqliteHandle(), actorId, id, asDate(now));
  return updateAnnouncementAsync(actorId, id, { status: "published", enabled: true }, { now, ...options });
}

export async function markAnnouncementReadAsync(userId, id, { now = new Date(), ...options } = {}) {
  if (!userId) return { ok: true, anonymous: true }; // 未登入：不動 DB（同步版同義）
  if (!isPg(options)) return markAnnouncementReadSync(sqliteHandle(), userId, id, asDate(now));
  const stamp = stampOf(now);
  return withFallbackTx(options, async (exec) => {
    await exec(ANN_STATE_UPSERT_READ_SQL, [Number(id), Number(userId), stamp]);
    return { ok: true };
  }, () => markAnnouncementReadSync(sqliteHandle(), userId, id, asDate(now)));
}

export async function dismissAnnouncementAsync(userId, id, { now = new Date(), ...options } = {}) {
  if (!userId) return { ok: true, anonymous: true };
  if (!isPg(options)) return dismissAnnouncementSync(sqliteHandle(), userId, id, asDate(now));
  const stamp = stampOf(now);
  return withFallbackTx(options, async (exec) => {
    await exec(ANN_STATE_UPSERT_DISMISS_SQL, [Number(id), Number(userId), stamp, stamp]);
    return { ok: true };
  }, () => dismissAnnouncementSync(sqliteHandle(), userId, id, asDate(now)));
}

// ---- 贊助活動 ----

export async function getCampaignAsync(id, options = {}) {
  return withFallback(options, (exec) => readCampaign(exec, id), () => getCampaignSync(sqliteHandle(), id));
}

export async function listCampaignsAdminAsync(options = {}) {
  return withFallback(
    options,
    async (exec) => (await exec(CAMP_LIST_SQL)).map(campaignRow),
    () => listCampaignsAdminSync(sqliteHandle()),
  );
}

export async function resolveActiveCampaignsAsync(options = {}) {
  const { config = emptyCommsConfig(), now = new Date(), ...rest } = options;
  return withFallback(
    rest,
    async (exec) => {
      if (config.sponsored_master_enabled === false) return [];
      return (await exec(CAMP_ACTIVE_SQL)).map(campaignRow).filter((row) => isWithinWindow(row, asDate(now)));
    },
    () => resolveActiveCampaignsSync(sqliteHandle(), config, asDate(now)),
  );
}

export async function publicActiveCampaignsAsync(options = {}) {
  const { config = emptyCommsConfig(), now = new Date(), ...rest } = options;
  if (!isPg(rest)) return publicActiveCampaignsSync(sqliteHandle(), config, asDate(now));
  const rows = await resolveActiveCampaignsAsync({ config, now, ...rest });
  return rows.map((row) => publicCampaignView(row));
}

export async function listingCampaignsAsync(options = {}) {
  const { config = emptyCommsConfig(), now = new Date(), ...rest } = options;
  if (!isPg(rest)) return listingCampaignsSync(sqliteHandle(), config, asDate(now));
  if (config.listing_placement_enabled === false) return [];
  const rows = await resolveActiveCampaignsAsync({ config, now, ...rest });
  return rows.filter((row) => row.listing_placement);
}

export async function createCampaignAsync(actorId, input, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return createCampaignSync(sqliteHandle(), actorId, input, asDate(now));
  const data = normalizeCampaignInput(input);
  const stamp = stampOf(now);
  return withFallbackTx(options, async (exec) => {
    const row = firstRow(await exec(CAMP_INSERT_SQL, [
      data.sponsor_name, data.title, data.text, data.image_url, data.cta_label, data.destination_url,
      "sponsored", data.enabled ? 1 : 0, data.status,
      data.start_at || null, data.end_at || null, data.listing_placement ? 1 : 0, data.listing_interval,
      data.channel_inapp ? 1 : 0, data.channel_webhook ? 1 : 0, data.channel_email ? 1 : 0, data.channel_push ? 1 : 0,
      actorId || null, stamp, stamp,
    ]));
    const doc = campaignRow(row);
    await writeAudit(exec, {
      entity_type: "campaign", entity_id: doc.id, action: "create",
      actor_id: actorId, detail: data.status, now: asDate(now),
    });
    return doc;
  }, () => createCampaignSync(sqliteHandle(), actorId, input, asDate(now)));
}

export async function updateCampaignAsync(actorId, id, input, { now = new Date(), ...options } = {}) {
  if (!isPg(options)) return updateCampaignSync(sqliteHandle(), actorId, id, input, asDate(now));
  const stamp = stampOf(now);
  return withFallbackTx(options, async (exec) => {
    const current = await readCampaign(exec, id);
    if (!current) throw httpError("找不到贊助活動", 404);
    const data = normalizeCampaignInput({
      ...current,
      ...input,
      sponsor_name: input.sponsor_name ?? current.sponsor_name,
      destination_url: input.destination_url ?? input.url ?? current.destination_url,
      channels: { ...current.channels, ...(input.channels || {}) },
    });
    await exec(CAMP_UPDATE_SQL, [
      data.sponsor_name, data.title, data.text, data.image_url, data.cta_label, data.destination_url,
      data.enabled ? 1 : 0, data.status, data.start_at || null, data.end_at || null,
      data.listing_placement ? 1 : 0, data.listing_interval,
      data.channel_inapp ? 1 : 0, data.channel_webhook ? 1 : 0, data.channel_email ? 1 : 0, data.channel_push ? 1 : 0,
      stamp, Number(id),
    ]);
    await writeAudit(exec, {
      entity_type: "campaign", entity_id: Number(id), action: "update",
      actor_id: actorId, detail: data.status, now: asDate(now),
    });
    return readCampaign(exec, id);
  }, () => updateCampaignSync(sqliteHandle(), actorId, id, input, asDate(now)));
}

// `/api/comms` 用的整包。同步版是 `publicCommsBundle()`（comms.js:769），它自己呼叫
// `announcementInboxForUser`／`listingCampaigns`／`resolveActiveCampaigns`——那三個都已經有
// PG 版了，所以這裡只是把它們接起來；設定正規化與 `supportPresentation` 仍用**同一份純函式**。
export async function publicCommsBundleAsync({
  config,
  sponsorOffer,
  sponsorLinks,
  user,
  now = new Date(),
  ...options
} = {}) {
  if (!isPg(options)) return publicCommsBundleSync(sqliteHandle(), { config, sponsorOffer, sponsorLinks, user, now });
  const cfg = normalizeCommsConfig(config);
  const announcements = await announcementInboxForUserAsync(user?.id || null, { now, ...options });
  const cards = await listingCampaignsAsync({ config: cfg, now, ...options });
  const notify = user?.id ? await resolveActiveCampaignsAsync({ config: cfg, now, ...options }) : [];
  return {
    announcements: announcements.map((row) => ({ ...row, created_by: undefined })),
    banner: announcements.find((row) => row.banner && !row.dismissed) || null,
    sponsored: {
      master_enabled: cfg.sponsored_master_enabled,
      listing_enabled: cfg.listing_placement_enabled && cfg.sponsored_master_enabled,
      interval: cfg.listing_ad_interval,
      session_cap: SPONSORED_SESSION_CAP,
      cards: cards.map((row) => publicCampaignView(row)),
      notify: notify.filter((row) => row.channels.inapp).map((row) => publicCampaignView(row)),
    },
    support: supportPresentation(cfg, sponsorOffer, { ...(user || {}), sponsorLinks }),
  };
}

export async function recordSponsoredEventAsync(campaignId, kind, placement = "listing", { now = new Date(), ...options } = {}) {
  const allowed = kind === "impression" || kind === "click";
  if (!allowed) throw httpError("事件類型不正確");
  if (!isPg(options)) return recordSponsoredEventSync(sqliteHandle(), campaignId, kind, placement, asDate(now));
  const at = asDate(now);
  return withFallbackTx(options, async (exec) => {
    const campaign = await readCampaign(exec, campaignId);
    if (!campaign || !campaign.enabled || campaign.status !== "published") return { ok: false };
    // 同步版這兩句沒有包交易；PG 這邊包起來——事件列與計數不該只成立一半。
    await exec(EVENT_INSERT_SQL, [
      Number(campaignId), kind, String(placement || "listing").slice(0, 40), hourBucket(at), iso(at),
    ]);
    await exec(kind === "impression" ? IMPRESSION_BUMP_SQL : CLICK_BUMP_SQL, [Number(campaignId)]);
    return { ok: true };
  }, () => recordSponsoredEventSync(sqliteHandle(), campaignId, kind, placement, at));
}
