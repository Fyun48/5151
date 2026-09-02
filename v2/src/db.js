import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { shouldKeepListing, passesAttributeFilters, passesDisplayFilters, listingHasElevator, matchesHousingKind, normalizeListQuery, housingTypeLabel } from "./floors.js";
import { isTrustedGeoSource, listingCommunityId } from "./location.js";
import { makeRouteKey } from "./route.js";
import {
  bindGoogleDirectionsEnabled,
  bindMapsUsageSink,
  googleDirectionsAllowed,
  googleDirectionsBlockState,
  hasGoogleMapsKey,
  isCommuteRushEnabled,
  isGoogleDirectionsEnabled,
  mapsAdminWarning,
  summarizeMapsUsage,
  pacificYmd,
} from "./mapsBilling.js";
import { sameSearch } from "./client591.js";
import { districtNameFromListing } from "./regions.js";
import { preferPrimaryListing } from "./match.js";
import { commuteWorkJobs, hasWorkPoint, needsListingGeo, normalizeCommuteMode } from "./geo.js";
import { demoCommutePatch } from "./demo.js";
import { estimateMrtAccessForPoint, makeMrtKey } from "./mrt.js";
import { applySettingPatch, hydrateSettings, parseSettingRows, snapshotSettings, planIntervalMinutes, resolveSaveAsProfileAction, normalizeProfileName, MEMBER_MAX_PROFILES, ADMIN_MAX_PROFILES } from "./settingsState.js";
import { defaultNotifyMatrix } from "./notifyMatrix.js";
import { DATA_EPOCH, shouldResetForEpoch } from "./dataEpoch.js";
import { countsTowardAllTotal, isConfirmedOffline, isPendingOffline } from "./offline.js";
import { coveringJobsFromMembers, coveringJobsFromSettings, coversFromMemberSettings, listingInMemberScope } from "./covering.js";
import { listCrawlCovers } from "./crawlCovers.js";
import { ensurePersonalSchema } from "./personalSchema.js";
import { importV1CacheIfNeeded } from "./importV1.js";
import {
  adminEmailForUser,
  anyoneWatched as anyoneWatchedOn,
  copyUserFlagsForRelist as copyUserFlagsForRelistOn,
  ensureUser as ensureUserOn,
  listingMatchesListFilter,
  loadAnyoneFlagMap,
  loadFlagMap,
  loadFlags,
  mergeFlagsOnConfirm as mergeFlagsOnConfirmOn,
  migrateListingFlagsIfNeeded,
  overlayPersonal,
  overlayRowsPersonal,
  setUserListingFlags,
} from "./personalFlags.js";
import {
  bootstrapAdminUser as bootstrapAdminUserOn,
  changeUserPassword as changeUserPasswordOn,
  findUserByEmail as findUserByEmailOn,
  getUserById as getUserByIdOn,
  listUserIds as listUserIdsOn,
  listUsers as listUsersOn,
  publicUser,
  registerUser as registerUserOn,
  setUserPassword as setUserPasswordOn,
  setUserPlan as setUserPlanOn,
  verifyUserPassword as verifyUserPasswordOn,
} from "./members.js";
import { requestTempPassword as requestTempPasswordOn } from "./forgotPassword.js";
import { shouldDeliverNotify, formatNotifyFacts, isSameNotifyDetail } from "./notify.js";
import {
  applySmtpEnv,
  composeForgotPasswordMail,
  mergeEnvMap,
  normalizeMailTemplates,
  normalizeSmtp,
  parseEnvFileText,
  publicSmtp,
  serializeEnvMap,
  smtpFromEnv,
} from "./siteMail.js";
import {
  listingMailPresetById,
  normalizeMemberMailTemplates,
  publicMemberMail,
  smtpReady,
} from "./memberMail.js";
import {
  normalizeSponsorConfig,
  publicSponsorOffer,
  sponsorCatalog,
} from "./sponsorLinks.js";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data-v2");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "v2.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 8000");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS listings (
    post_id INTEGER PRIMARY KEY,
    source_key TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    price TEXT,
    price_num INTEGER,
    address TEXT,
    area_name TEXT,
    layout TEXT,
    floor_name TEXT,
    kind_name TEXT,
    role_name TEXT,
    cover TEXT,
    tags TEXT,
    refresh_time TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_event TEXT NOT NULL DEFAULT 'new',
    viewed INTEGER NOT NULL DEFAULT 0,
    watched INTEGER NOT NULL DEFAULT 0,
    viewed_at TEXT,
    watched_at TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    source_key TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL,
    notified INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source_key);
  CREATE INDEX IF NOT EXISTS idx_listings_watched ON listings(watched);
  CREATE INDEX IF NOT EXISTS idx_listings_viewed ON listings(viewed);
  CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
`);

try {
  db.exec("ALTER TABLE listings ADD COLUMN search_key TEXT NOT NULL DEFAULT ''");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN hidden_at TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN lat REAL");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN lng REAL");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN geo_source TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN watch_note TEXT NOT NULL DEFAULT ''");
} catch {
  // already migrated
}
db.exec(`
  CREATE TABLE IF NOT EXISTS geo_cache (
    address TEXT PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS route_cache (
    route_key TEXT PRIMARY KEY,
    distances TEXT NOT NULL,
    min_km REAL NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS maps_usage_daily (
    day TEXT PRIMARY KEY,
    essentials INTEGER NOT NULL DEFAULT 0,
    advanced INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS mrt_cache (
    geo_key TEXT PRIMARY KEY,
    station TEXT NOT NULL,
    walk_km REAL,
    walk_min REAL,
    ride_km REAL,
    ride_min REAL,
    updated_at TEXT NOT NULL
  );
`);
try {
  db.exec("ALTER TABLE route_cache ADD COLUMN rush_am_min REAL");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE route_cache ADD COLUMN rush_pm_min REAL");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE route_cache ADD COLUMN rush_updated_at TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_post_id INTEGER");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_level TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_detail TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_rejected INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN extra_fee INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN extra_fee_text TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN price_contain_text TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN extra_fees TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN extra_fees_fetched INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN contact_name TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN contact_role TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN agency TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN mobile TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN phone TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN line_url TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN avatar TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN contact_uid INTEGER");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN contact_fetched INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN community_id INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN community_name TEXT NOT NULL DEFAULT ''");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN offline INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN offline_at TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN last_checked_at TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN offline_confirmed INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_verdict TEXT");
} catch {
  // already migrated
}
db.exec(`
  CREATE TABLE IF NOT EXISTS community_cache (
    community_id INTEGER PRIMARY KEY,
    name TEXT,
    address TEXT,
    lat REAL,
    lng REAL,
    updated_at TEXT NOT NULL
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_search ON listings(search_key)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_hidden ON listings(hidden)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_match ON listings(match_level)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_offline ON listings(offline)");
ensurePersonalSchema(db);

let cachedDefaultUserId = 0;

export function ensureUser(email, opts) {
  return ensureUserOn(db, email, opts);
}

export function defaultUserId() {
  if (cachedDefaultUserId) return cachedDefaultUserId;
  cachedDefaultUserId = ensureUserOn(db, adminEmailForUser(), { role: "admin" });
  return cachedDefaultUserId;
}

export function anyoneWatched(postId) {
  return anyoneWatchedOn(db, postId);
}

export function copyUserFlags(fromPostId, toPostId) {
  return copyUserFlagsForRelistOn(db, fromPostId, toPostId);
}

export function findUserByEmail(email) {
  return findUserByEmailOn(db, email);
}

export function getUserById(userId) {
  return getUserByIdOn(db, userId);
}

export function listUsers() {
  return listUsersOn(db);
}

function settingKey(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

function writeSettingKey(key, value) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

function publicAdminMember(user) {
  if (!user) return null;
  const settings = getSettings(user.id);
  return {
    id: Number(user.id),
    email: user.email,
    role: user.role || "member",
    plan: user.plan || "free",
    created_at: user.created_at || "",
    accepted_disclaimer_at: user.accepted_disclaimer_at || "",
    intervalMinutes: Number(settings.intervalMinutes) || planIntervalMinutes(user.plan),
    intervalAdminSet: settings.intervalAdminSet === true,
  };
}

export function listAdminMembers() {
  return listUsersOn(db).map((user) => publicAdminMember(user));
}

export function adminPatchMember(userId, patch = {}) {
  const uid = Number(userId) || 0;
  const user = getUserById(uid);
  if (!user) {
    const err = new Error("找不到這位會員");
    err.status = 404;
    throw err;
  }
  const body = patch && typeof patch === "object" ? patch : {};
  if (body.plan === "free" || body.plan === "sponsor") {
    setUserPlanOn(db, uid, body.plan);
  }
  const fresh = getUserById(uid);
  const settingsPatch = {};
  if (body.intervalMinutes != null && body.intervalMinutes !== "") {
    settingsPatch.intervalMinutes = Number(body.intervalMinutes);
    settingsPatch.intervalAdminSet = true;
  } else if ((body.plan === "free" || body.plan === "sponsor") && fresh?.role !== "admin") {
    settingsPatch.intervalMinutes = planIntervalMinutes(fresh.plan);
    settingsPatch.intervalAdminSet = false;
  }
  if (Object.keys(settingsPatch).length) {
    saveSettings(settingsPatch, uid, { forceAdmin: true });
  }
  return publicAdminMember(getUserById(uid));
}

function authEnvPath() {
  return path.join(DATA_DIR, "auth.env");
}

function persistSmtpToAuthEnv(config) {
  const file = authEnvPath();
  const existing = existsSync(file) ? parseEnvFileText(readFileSync(file, "utf8")) : {};
  const merged = mergeEnvMap(existing, applySmtpEnv(config));
  writeFileSync(file, serializeEnvMap(merged), { encoding: "utf8", mode: 0o600 });
}

function persistGoogleKeyToAuthEnv(key, { unset = false } = {}) {
  const file = authEnvPath();
  if (unset) {
    delete process.env.GOOGLE_MAPS_API_KEY;
    try {
      const existing = existsSync(file) ? parseEnvFileText(readFileSync(file, "utf8")) : {};
      delete existing.GOOGLE_MAPS_API_KEY;
      writeFileSync(file, serializeEnvMap(existing), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      console.warn("寫入 auth.env 清除 Google 金鑰失敗：", error.message);
    }
    return;
  }
  const trimmed = String(key || "").trim();
  if (!trimmed) return;
  const existing = existsSync(file) ? parseEnvFileText(readFileSync(file, "utf8")) : {};
  const merged = mergeEnvMap(existing, { GOOGLE_MAPS_API_KEY: trimmed });
  writeFileSync(file, serializeEnvMap(merged), { encoding: "utf8", mode: 0o600 });
  process.env.GOOGLE_MAPS_API_KEY = trimmed;
}

function bumpMapsUsage(sku, count = 1) {
  const day = pacificYmd();
  const essentials = sku === "essentials" ? count : 0;
  const advanced = sku === "advanced" ? count : 0;
  db.prepare(
    `INSERT INTO maps_usage_daily(day, essentials, advanced) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       essentials = essentials + excluded.essentials,
       advanced = advanced + excluded.advanced`,
  ).run(day, essentials, advanced);
}

bindMapsUsageSink(bumpMapsUsage);

export function commuteRushEnabled() {
  return isCommuteRushEnabled(settingKey("commuteRushEnabled"));
}

export function googleDirectionsEnabled() {
  return isGoogleDirectionsEnabled(settingKey("googleDirectionsEnabled"));
}

bindGoogleDirectionsEnabled(() => googleDirectionsEnabled());

export function collectCommuteSettings() {
  const list = listUserIds().map((id) => getSettings(id));
  list.push(getSettings());
  list.push(demoCommutePatch());
  return list;
}

export function settingsForGeoBackfill(preferred) {
  if (preferred && needsListingGeo(preferred)) return preferred;
  for (const settings of collectCommuteSettings()) {
    if (needsListingGeo(settings)) return settings;
  }
  return preferred || getSettings();
}

export function getAdminMapsSettings() {
  const googleEnabled = googleDirectionsEnabled();
  const enabled = commuteRushEnabled();
  const hasKey = hasGoogleMapsKey();
  const block = googleDirectionsBlockState();
  const daily = db.prepare("SELECT day, essentials, advanced FROM maps_usage_daily ORDER BY day").all();
  const usage = summarizeMapsUsage(daily);
  return {
    enabled,
    googleEnabled,
    hasKey,
    googleBlocked: block.blocked,
    googleBlockReason: block.reason,
    googleBlockUntil: block.until,
    provider: googleDirectionsAllowed() ? "google" : "osrm",
    warning: mapsAdminWarning({ googleEnabled, rushEnabled: enabled, hasKey, block }),
    usage,
  };
}

export function saveAdminMapsSettings(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  if (src.clearKey === true) {
    persistGoogleKeyToAuthEnv("", { unset: true });
    writeSettingKey("googleDirectionsEnabled", false);
    writeSettingKey("commuteRushEnabled", false);
    return getAdminMapsSettings();
  }
  if (Object.prototype.hasOwnProperty.call(src, "googleEnabled")) {
    writeSettingKey("googleDirectionsEnabled", Boolean(src.googleEnabled));
  }
  if (Object.prototype.hasOwnProperty.call(src, "enabled")) {
    writeSettingKey("commuteRushEnabled", Boolean(src.enabled));
  }
  if (Object.prototype.hasOwnProperty.call(src, "apiKey")) {
    persistGoogleKeyToAuthEnv(src.apiKey);
  }
  return getAdminMapsSettings();
}

export function getMailTemplates() {
  return normalizeMailTemplates(settingKey("mailTemplates"));
}

export function getStoredSmtp() {
  const stored = settingKey("smtp");
  if (stored && typeof stored === "object" && String(stored.host || "").trim()) {
    return normalizeSmtp(stored);
  }
  return smtpFromEnv();
}

export function getAdminMailSettings() {
  const smtp = getStoredSmtp();
  return {
    smtp: publicSmtp(smtp),
    templates: getMailTemplates(),
    configured: Boolean(smtp.host && (smtp.from || smtp.user)),
  };
}

export function saveAdminMailSettings(partial = {}) {
  const current = getStoredSmtp();
  const smtp = normalizeSmtp(partial.smtp || {}, current);
  const templates = normalizeMailTemplates({
    ...getMailTemplates(),
    ...(partial.templates && typeof partial.templates === "object" ? partial.templates : {}),
  });
  writeSettingKey("smtp", smtp);
  writeSettingKey("mailTemplates", templates);
  persistSmtpToAuthEnv(smtp);
  return getAdminMailSettings();
}

export function applyStoredSmtp() {
  const smtp = getStoredSmtp();
  if (smtp.host) applySmtpEnv(smtp);
  return smtp;
}

function userSettingKey(userId, key) {
  const uid = Number(userId) || 0;
  if (!uid) return undefined;
  const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").get(uid, key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

function writeUserSettingKey(userId, key, value) {
  const uid = Number(userId) || 0;
  if (!uid) return;
  db.prepare(
    "INSERT INTO user_settings(user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
  ).run(uid, key, JSON.stringify(value));
}

export function getMemberSmtp(userId) {
  return normalizeSmtp(userSettingKey(userId, "memberSmtp") || {});
}

export function getMemberMailSettings(userId) {
  const smtp = getMemberSmtp(userId);
  const templates = normalizeMemberMailTemplates(userSettingKey(userId, "memberMailTemplates"));
  const preset = String(userSettingKey(userId, "mailPreset") || "detailed");
  return publicMemberMail(smtp, templates, preset);
}

export function getMemberMailBundle(userId) {
  const smtp = getMemberSmtp(userId);
  const templates = normalizeMemberMailTemplates(userSettingKey(userId, "memberMailTemplates"));
  const siteTemplates = getMailTemplates();
  const ready = smtpReady(smtp);
  return {
    smtp: ready ? smtp : null,
    templates: {
      listing_notify: templates.listing_notify || siteTemplates.listing_notify,
    },
    configured: ready,
  };
}

export function saveMemberMailSettings(userId, partial = {}) {
  const uid = Number(userId) || 0;
  if (!uid) {
    const err = new Error("請先登入");
    err.status = 401;
    throw err;
  }
  const src = partial && typeof partial === "object" ? partial : {};
  if (src.smtp && typeof src.smtp === "object") {
    writeUserSettingKey(uid, "memberSmtp", normalizeSmtp(src.smtp, getMemberSmtp(uid)));
  }
  if (src.templates && typeof src.templates === "object") {
    writeUserSettingKey(uid, "memberMailTemplates", normalizeMemberMailTemplates(src.templates));
  }
  if (Object.prototype.hasOwnProperty.call(src, "preset")) {
    const preset = listingMailPresetById(src.preset);
    writeUserSettingKey(uid, "mailPreset", preset.id);
    if (!src.templates) {
      writeUserSettingKey(uid, "memberMailTemplates", normalizeMemberMailTemplates(preset));
    }
  }
  return getMemberMailSettings(uid);
}

export function getSponsorConfig() {
  return normalizeSponsorConfig(settingKey("sponsorLinks"));
}

export function getAdminSponsorSettings() {
  return {
    catalog: sponsorCatalog(),
    config: getSponsorConfig(),
  };
}

export function saveAdminSponsorSettings(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  const current = getSponsorConfig();
  const next = normalizeSponsorConfig({
    intro: Object.prototype.hasOwnProperty.call(src, "intro") ? src.intro : current.intro,
    thanks: Object.prototype.hasOwnProperty.call(src, "thanks") ? src.thanks : current.thanks,
    providers: src.providers && typeof src.providers === "object" ? { ...current.providers, ...src.providers } : current.providers,
    extras: Array.isArray(src.extras) ? src.extras : current.extras,
  });
  writeSettingKey("sponsorLinks", next);
  return getAdminSponsorSettings();
}

export function publicSponsorSettings(user = {}) {
  return publicSponsorOffer(getSponsorConfig(), { role: user.role, plan: user.plan });
}

export function listUserIds() {
  return listUserIdsOn(db);
}

export function registerUser(input) {
  return registerUserOn(db, input);
}

export function verifyUserPassword(email, password) {
  return verifyUserPasswordOn(db, email, password);
}

export function setUserPassword(userId, password) {
  return setUserPasswordOn(db, userId, password);
}

export function changeUserPassword(userId, currentPassword, nextPassword) {
  return changeUserPasswordOn(db, userId, currentPassword, nextPassword);
}

export function requestTempPassword(email, opts = {}) {
  return requestTempPasswordOn(db, email, {
    compose: (vars) => composeForgotPasswordMail(getMailTemplates(), vars),
    ...opts,
  });
}

export { publicUser };

const SITE_SETTING_KEYS = new Set([
  "dataEpoch",
  "hasBaseline",
  "personalFlagsMigrated",
  "personalSettingsMigrated",
  "eventsMigrated",
  "v1CacheImported",
]);

const DEFAULTS = {
  searchUrls: [],
  intervalMinutes: 8,
  pagesPerWatch: 40,
  notifyNew: true,
  notifySameSource: true,
  notifyViewed: false,
  notifyWatchedAlways: true,
  discordWebhook: "",
  webhookNotifyNew: true,
  webhookNotifyPriceDrop: true,
  webhookNotifyTitleUpdate: true,
  notifyMatrix: defaultNotifyMatrix(),
  windowsToast: true,
  hasBaseline: false,
  excludeLowFloors: true,
  wholeFloorOnly: true,
  minBuildingFloors: 4,
  excludeKeywords: [],
  excludeAgents: [],
  excludeAgentIds: [],
  excludeBoxes: [],
  workAddress: "",
  commuteKm: 0,
  commuteMode: "scooter",
  showMrt: true,
  workLat: null,
  workLng: null,
  settingProfiles: [],
  activeProfileId: "",
  watchDistricts: [],
  priceMin: 0,
  priceMax: 36000,
  areaMax: 0,
  excludeRooftop: true,
  offlineConfirmDays: 7,
  dataEpoch: DATA_EPOCH,
};

function omitSiteMail(stored) {
  if (!stored || typeof stored !== "object") return stored;
  const next = { ...stored };
  delete next.smtp;
  delete next.mailTemplates;
  delete next.sponsorLinks;
  delete next.memberSmtp;
  delete next.memberMailTemplates;
  delete next.mailPreset;
  return next;
}

export function getSettings(userId) {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const global = hydrateSettings(omitSiteMail(parseSettingRows(rows)), DEFAULTS, { admin: true, plan: "free" });
  const uid = Number(userId) || 0;
  if (!uid) return global;
  const userRows = db.prepare("SELECT key, value FROM user_settings WHERE user_id = ?").all(uid);
  const user = getUserById(uid);
  const admin = user?.role === "admin";
  const plan = user?.plan || "free";
  if (!userRows.length) {
    if (user?.role === "admin") return global;
    return hydrateSettings({
      dataEpoch: global.dataEpoch,
      hasBaseline: global.hasBaseline,
    }, DEFAULTS, { admin: false, plan });
  }
  return hydrateSettings(omitSiteMail({ ...global, ...parseSettingRows(userRows) }), DEFAULTS, { admin, plan });
}

export function saveSettings(partial, userId, { forceAdmin = false } = {}) {
  const uid = userId == null ? defaultUserId() : Number(userId) || defaultUserId();
  const current = getSettings(uid);
  const user = getUserById(uid);
  const admin = forceAdmin || user?.role === "admin";
  const plan = user?.plan || "free";
  const next = applySettingPatch(current, partial, { admin, plan });
  const userUpsert = db.prepare(
    "INSERT INTO user_settings(user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
  );
  const globalUpsert = db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) continue;
      if (
        key === "smtp"
        || key === "mailTemplates"
        || key === "sponsorLinks"
        || key === "memberSmtp"
        || key === "memberMailTemplates"
        || key === "mailPreset"
      ) continue;
      const encoded = JSON.stringify(value);
      if (SITE_SETTING_KEYS.has(key)) globalUpsert.run(key, encoded);
      else userUpsert.run(uid, key, encoded);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return next;
}

export function saveAsProfile(name, livePatch, userId, { overwrite = false } = {}) {
  const uid = userId == null ? defaultUserId() : Number(userId) || defaultUserId();
  const admin = getUserById(uid)?.role === "admin";
  const current = livePatch && typeof livePatch === "object" ? saveSettings(livePatch, uid) : getSettings(uid);
  const profiles = [...(current.settingProfiles || [])];
  const label = normalizeProfileName(name);
  const decision = resolveSaveAsProfileAction(profiles, label, { overwrite, admin });
  if (decision.action === "empty") {
    const err = new Error("請先填設定檔名稱");
    err.status = 400;
    throw err;
  }
  if (decision.action === "confirm_overwrite") {
    const err = new Error("同名設定檔已存在，請確認是否覆蓋");
    err.status = 409;
    err.code = "confirm_overwrite";
    throw err;
  }
  if (decision.action === "full") {
    const err = new Error(
      admin
        ? `設定檔已滿，最多 ${ADMIN_MAX_PROFILES} 個`
        : `設定檔已滿，最多 ${MEMBER_MAX_PROFILES} 個。請先刪除一個，或覆蓋現有同名設定檔。`,
    );
    err.status = 400;
    err.code = "full";
    throw err;
  }
  if (decision.action === "overwrite") {
    const id = decision.existing.id;
    const next = profiles.map((item) => (
      item.id === id
        ? { ...item, name: label, saved_at: new Date().toISOString(), data: snapshotSettings(current) }
        : item
    ));
    return saveSettings({
      settingProfiles: next,
      activeProfileId: id,
    }, uid);
  }
  const id = `p-${Date.now()}`;
  profiles.push({
    id,
    name: label,
    saved_at: new Date().toISOString(),
    data: snapshotSettings(current),
  });
  return saveSettings({
    settingProfiles: profiles,
    activeProfileId: id,
  }, uid);
}

export function loadProfile(id, userId) {
  const uid = userId == null ? defaultUserId() : Number(userId) || defaultUserId();
  const current = getSettings(uid);
  const profile = (current.settingProfiles || []).find((item) => item.id === id);
  if (!profile) {
    const err = new Error("找不到這個設定檔");
    err.status = 404;
    throw err;
  }
  return saveSettings({
    ...snapshotSettings({ ...DEFAULTS, ...profile.data }),
    settingProfiles: current.settingProfiles,
    activeProfileId: profile.id,
  }, uid);
}

export function deleteProfile(id, userId) {
  const uid = userId == null ? defaultUserId() : Number(userId) || defaultUserId();
  const current = getSettings(uid);
  const profiles = (current.settingProfiles || []).filter((item) => item.id !== id);
  const active = current.activeProfileId === id ? (profiles[0]?.id || "") : current.activeProfileId;
  return saveSettings({ settingProfiles: profiles, activeProfileId: active }, uid);
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function decorateListing(row, settings) {
  if (!row) return row;
  settings = settings || getSettings();
  row = applyCachedCoords(row, settings);
  const commute = Number.isFinite(Number(row.route_km)) ? Number(row.route_km) : null;
  const commuteMode = normalizeCommuteMode(settings.commuteMode);
  const matchPostId = Number(row.match_post_id) || 0;
  const matchPeer = matchPostId
    ? db.prepare("SELECT post_id, title, url, price, offline FROM listings WHERE post_id = ?").get(matchPostId)
    : null;
  return {
    ...row,
    extra_fees: Array.isArray(row.extra_fees) ? row.extra_fees : parseJson(row.extra_fees, []),
    has_elevator: listingHasElevator(row),
    commute_km: commute == null ? null : Math.round(commute * 10) / 10,
    commute_mode: commuteMode,
    commute_routes: Array.isArray(row.route_kms) ? row.route_kms : [],
    commute_min_am: Number.isFinite(Number(row.rush_am_min)) && Number(row.rush_am_min) > 0 ? Math.round(Number(row.rush_am_min)) : null,
    commute_min_pm: Number.isFinite(Number(row.rush_pm_min)) && Number(row.rush_pm_min) > 0 ? Math.round(Number(row.rush_pm_min)) : null,
    district: districtNameFromListing(row),
    match_peer: matchPeer || null,
    ...mrtFields(row, settings),
  };
}

function resolveUserId(userId) {
  return userId == null ? defaultUserId() : Number(userId) || defaultUserId();
}

function withPersonal(row, userId) {
  if (!row) return row;
  return overlayPersonal(row, loadFlags(db, resolveUserId(userId), row.post_id));
}

export function getListing(postId, userId) {
  const row = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(postId);
  if (!row) return row;
  const uid = resolveUserId(userId);
  return decorateListing(withPersonal(row, uid), getSettings(uid));
}

export function findBySourceKey(sourceKey, excludePostId) {
  const anyone = loadAnyoneFlagMap(db);
  return db
    .prepare(
      "SELECT * FROM listings WHERE source_key = ? AND post_id != ? ORDER BY last_seen_at DESC",
    )
    .all(sourceKey, excludePostId)
    .map((row) => decorateListing(overlayPersonal(row, anyone.get(Number(row.post_id)))));
}

export function listMatchCandidates(excludePostId) {
  const anyone = loadAnyoneFlagMap(db);
  return db
    .prepare(
      `SELECT * FROM listings
       WHERE post_id != ?
       ORDER BY IFNULL(offline, 0) DESC, hidden DESC, viewed DESC, last_seen_at DESC
       LIMIT 4000`,
    )
    .all(excludePostId)
    .map((row) => decorateListing(overlayPersonal(row, anyone.get(Number(row.post_id)))));
}

export function setListingMatch(postId, match) {
  db.prepare(
    `UPDATE listings
     SET match_post_id = ?, match_level = ?, match_detail = ?, match_rejected = 0
     WHERE post_id = ?`,
  ).run(match.match_post_id || null, match.match_level || null, match.match_detail || "", postId);
  return getListing(postId);
}

export function rejectSuspectedMatch(postId, userId) {
  const listing = getListing(postId, userId);
  if (!listing) return null;
  db.prepare(
    `UPDATE listings
     SET match_verdict = 'no', match_rejected = 1, hidden = 0
     WHERE post_id = ?`,
  ).run(postId);
  return getListing(postId, userId);
}

export function confirmSuspectedMatch(postId, userId) {
  const listing = getListing(postId, userId);
  if (!listing?.match_post_id) return null;
  const peer = getListing(listing.match_post_id, userId);
  if (!peer) return null;
  const primary = preferPrimaryListing(listing, peer);
  const duplicate = Number(primary.post_id) === Number(listing.post_id) ? peer : listing;
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE listings
       SET match_verdict = 'yes', match_rejected = 0, hidden = 1,
           match_post_id = ?, hidden_at = COALESCE(hidden_at, ?)
       WHERE post_id = ?`,
    ).run(primary.post_id, now, duplicate.post_id);
    db.prepare(
      `UPDATE listings
       SET match_verdict = '', match_rejected = 0, hidden = 0, match_level = NULL,
           match_detail = ?, match_post_id = ?
       WHERE post_id = ?`,
    ).run(
      `已確認同一間，保留較低價／較新刊登，隱藏 #${duplicate.post_id}`,
      duplicate.post_id,
      primary.post_id,
    );
    mergeFlagsOnConfirmOn(db, primary.post_id, duplicate.post_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getListing(postId, userId);
}

export function coveringJobsFromAllUsers() {
  const ids = listUserIds();
  const covers = [];
  let excludeRooftop = true;
  for (const id of ids) {
    const settings = getSettings(id);
    const memberCovers = coversFromMemberSettings(settings);
    if (memberCovers.length) covers.push(...memberCovers);
    if (settings.excludeRooftop === false) excludeRooftop = false;
  }
  if (!covers.length) return coveringJobsFromSettings(getSettings());
  return coveringJobsFromMembers(covers, { excludeRooftop });
}

export function currentSearchKeys() {
  const urls = [];
  for (const id of listUserIds()) {
    urls.push(...(getSettings(id).searchUrls || []));
  }
  urls.push(...(getSettings().searchUrls || []));
  const coverUrls = coveringJobsFromMembers(listCrawlCovers(db), {
    excludeRooftop: true,
  }).map((job) => job.searchUrl);
  return [...new Set([...urls, ...coverUrls].map((url) => String(url || "").trim()).filter(Boolean))];
}

function expandSearchKeys(keys) {
  if (!keys?.length) return keys;
  const stored = db
    .prepare("SELECT DISTINCT search_key FROM listings")
    .all()
    .map((row) => row.search_key)
    .filter(Boolean);
  const out = new Set(keys);
  for (const key of stored) {
    if (keys.some((url) => sameSearch(url, key))) out.add(key);
  }
  return [...out];
}

function searchWhere(searchKeys, clauses, params) {
  const keys = expandSearchKeys(searchKeys === undefined ? currentSearchKeys() : searchKeys);
  if (keys?.length) {
    clauses.push(`search_key IN (${keys.map(() => "?").join(",")})`);
    params.push(...keys);
  }
}

export function upsertListing(listing) {
  const extraFees =
    typeof listing.extra_fees === "string"
      ? listing.extra_fees
      : JSON.stringify(listing.extra_fees || []);
  const communityId = Number(listing.community_id) || listingCommunityId(listing) || 0;
  const communityName = String(listing.community_name || "").trim();
  db.prepare(`
    INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num, extra_fee, extra_fee_text,
      price_contain_text, extra_fees, extra_fees_fetched, address, area_name,
      layout, floor_name, kind_name, role_name, cover, tags, refresh_time,
      first_seen_at, last_seen_at, last_event, viewed, watched, lat, lng,
      community_id, community_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      source_key = excluded.source_key,
      search_key = excluded.search_key,
      title = excluded.title,
      url = excluded.url,
      price = excluded.price,
      price_num = excluded.price_num,
      extra_fee = excluded.extra_fee,
      extra_fee_text = excluded.extra_fee_text,
      price_contain_text = excluded.price_contain_text,
      extra_fees = CASE
        WHEN listings.extra_fees_fetched = 1 AND IFNULL(listings.extra_fees, '') NOT IN ('', '[]')
        THEN listings.extra_fees
        ELSE excluded.extra_fees
      END,
      address = CASE
        WHEN IFNULL(listings.geo_source, '') = 'community' AND IFNULL(listings.address, '') != ''
        THEN listings.address
        ELSE excluded.address
      END,
      area_name = excluded.area_name,
      layout = excluded.layout,
      floor_name = excluded.floor_name,
      kind_name = excluded.kind_name,
      role_name = excluded.role_name,
      cover = excluded.cover,
      tags = excluded.tags,
      refresh_time = excluded.refresh_time,
      last_seen_at = excluded.last_seen_at,
      last_event = CASE
        WHEN IFNULL(listings.offline, 0) = 1 AND excluded.last_event IN ('seen', 'offline', '') THEN 'same_source'
        ELSE excluded.last_event
      END,
      last_checked_at = excluded.last_seen_at,
      offline = 0,
      offline_at = NULL,
      offline_confirmed = 0,
      lat = CASE
        WHEN IFNULL(listings.geo_source, '') IN ('591', 'community') THEN listings.lat
        ELSE COALESCE(excluded.lat, listings.lat)
      END,
      lng = CASE
        WHEN IFNULL(listings.geo_source, '') IN ('591', 'community') THEN listings.lng
        ELSE COALESCE(excluded.lng, listings.lng)
      END,
      community_id = CASE
        WHEN excluded.community_id > 0 THEN excluded.community_id
        ELSE listings.community_id
      END,
      community_name = CASE
        WHEN IFNULL(excluded.community_name, '') != '' THEN excluded.community_name
        ELSE listings.community_name
      END
  `).run(
    listing.post_id,
    listing.source_key,
    listing.search_key || "",
    listing.title,
    listing.url,
    listing.price,
    listing.price_num,
    Number(listing.extra_fee) || 0,
    listing.extra_fee_text || "",
    listing.price_contain_text || "",
    extraFees,
    Number(listing.extra_fees_fetched) || 0,
    listing.address,
    listing.area_name,
    listing.layout,
    listing.floor_name,
    listing.kind_name,
    listing.role_name,
    listing.cover,
    listing.tags,
    listing.refresh_time,
    listing.first_seen_at,
    listing.last_seen_at,
    listing.last_event,
    listing.lat ?? null,
    listing.lng ?? null,
    communityId,
    communityName,
  );
}

export function setListingFees(postId, extraFees, fetched = 1) {
  return setListingDetail(postId, { extraFees, fetched });
}

export function setListingDetail(postId, { extraFees, contact, fetched = 1, lat, lng, address, community_id, community_name, geo_source } = {}) {
  const listing = getListing(postId);
  if (!listing) return null;
  const fees =
    extraFees === undefined
      ? JSON.stringify(listing.extra_fees || [])
      : JSON.stringify(extraFees || []);
  const next = {
    contact_name: contact?.contact_name ?? listing.contact_name ?? "",
    contact_role: contact?.contact_role ?? listing.contact_role ?? "",
    agency: contact?.agency ?? listing.agency ?? "",
    mobile: contact?.mobile ?? listing.mobile ?? "",
    phone: contact?.phone ?? listing.phone ?? "",
    line_url: contact?.line_url ?? listing.line_url ?? "",
    avatar: contact?.avatar ?? listing.avatar ?? "",
    contact_uid: contact?.contact_uid ?? listing.contact_uid ?? null,
  };
  const latNum = Number(lat);
  const lngNum = Number(lng);
  const hasCoords = Number.isFinite(latNum) && Number.isFinite(lngNum) && latNum !== 0 && lngNum !== 0;
  const upgradingToCommunity = hasCoords && geo_source === "community";
  const keepCommunity = listing.geo_source === "community" && !upgradingToCommunity;
  const applyCoords = hasCoords && !keepCommunity;
  const source = applyCoords ? (geo_source === "community" ? "community" : "591") : null;
  const nextAddress = String(address || "").trim();
  const keepAddress = !nextAddress || keepCommunity;
  const nextCommunityId = Number(community_id) || listing.community_id || 0;
  const nextCommunityName = String(community_name || listing.community_name || "").trim();
  db.prepare(
    `UPDATE listings SET
      extra_fees = ?, extra_fees_fetched = ?,
      contact_name = ?, contact_role = ?, agency = ?, mobile = ?, phone = ?,
      line_url = ?, avatar = ?, contact_uid = ?, contact_fetched = ?,
      lat = CASE WHEN ? IS NOT NULL THEN ? ELSE lat END,
      lng = CASE WHEN ? IS NOT NULL THEN ? ELSE lng END,
      geo_source = CASE WHEN ? IS NOT NULL THEN ? ELSE geo_source END,
      address = CASE WHEN ? THEN listings.address ELSE ? END,
      community_id = CASE WHEN ? > 0 THEN ? ELSE community_id END,
      community_name = CASE WHEN ? != '' THEN ? ELSE community_name END
     WHERE post_id = ?`,
  ).run(
    fees,
    Number(Boolean(fetched)),
    next.contact_name,
    next.contact_role,
    next.agency,
    next.mobile,
    next.phone,
    next.line_url,
    next.avatar,
    next.contact_uid,
    Number(Boolean(fetched)),
    applyCoords ? latNum : null,
    applyCoords ? latNum : null,
    applyCoords ? lngNum : null,
    applyCoords ? lngNum : null,
    source,
    source,
    keepAddress ? 1 : 0,
    nextAddress,
    nextCommunityId,
    nextCommunityId,
    nextCommunityName,
    nextCommunityName,
    postId,
  );
  return getListing(postId);
}

export function listingsNeedingFeeDetail(limit = 12) {
  return db
    .prepare(
      `SELECT post_id FROM listings
       WHERE IFNULL(hidden, 0) = 0 AND IFNULL(offline, 0) = 0 AND (
         IFNULL(contact_fetched, 0) = 0
         OR IFNULL(extra_fees_fetched, 0) = 0
         OR lat IS NULL OR lng IS NULL
       )
       ORDER BY CASE WHEN lat IS NULL OR lng IS NULL THEN 0 ELSE 1 END, last_seen_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Number(limit) || 12));
}

export function listingsNeeding591Geo(limit = 20) {
  const cap = Math.max(1, Number(limit) || 20);
  const rows = db
    .prepare(
      `SELECT post_id, community_id, source_key, lat, lng, geo_source FROM listings
       WHERE IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
       ORDER BY last_seen_at DESC`,
    )
    .all();
  const out = [];
  for (const row of rows) {
    const trusted = isTrustedGeoSource(row.geo_source);
    const missing = row.lat == null || row.lng == null || !trusted;
    const commId = listingCommunityId(row);
    const needsCommunity = commId > 0 && row.geo_source !== "community" && !hasCommunityCache(commId);
    if (missing || needsCommunity) {
      out.push({ post_id: row.post_id });
      if (out.length >= cap) break;
    }
  }
  return out;
}

export function hideMany(ids, userId) {
  const uid = resolveUserId(userId);
  const list = [...new Set((ids || []).map(Number).filter((id) => id > 0))];
  db.exec("BEGIN");
  try {
    for (const id of list) {
      const listing = getListing(id, uid);
      if (!listing) continue;
      setUserListingFlags(db, uid, id, { hidden: true }, listing);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { count: list.length, stats: stats(undefined, uid) };
}

export function markListingOffline(postId) {
  const listing = getListing(postId);
  if (!listing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE listings
     SET offline = 1,
         offline_at = COALESCE(offline_at, ?),
         offline_confirmed = 0,
         last_event = 'offline',
         last_checked_at = ?
     WHERE post_id = ?`,
  ).run(now, now, postId);
  return getListing(postId);
}

export function restoreListingOnline(postId) {
  const listing = getListing(postId);
  if (!listing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE listings
     SET offline = 0,
         offline_at = NULL,
         offline_confirmed = 0,
         last_checked_at = ?
     WHERE post_id = ?`,
  ).run(now, postId);
  return getListing(postId);
}

export function confirmListingOffline(postId) {
  const listing = getListing(postId);
  if (!listing?.offline) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE listings
     SET offline = 1,
         offline_confirmed = 1,
         last_event = 'offline',
         last_checked_at = ?
     WHERE post_id = ?`,
  ).run(now, postId);
  return getListing(postId);
}

export function confirmExpiredOfflineListings(days = 7) {
  const n = Math.max(1, Math.min(Number(days) || 7, 30));
  const cutoff = new Date(Date.now() - n * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE listings
       SET offline_confirmed = 1,
           last_event = 'offline',
           last_checked_at = ?
       WHERE IFNULL(offline, 0) = 1
         AND IFNULL(offline_confirmed, 0) = 0
         AND IFNULL(offline_at, '') != ''
         AND offline_at <= ?`,
    )
    .run(now, cutoff);
  return Number(info.changes) || 0;
}

export function touchListingChecked(postId) {
  db.prepare("UPDATE listings SET last_checked_at = ? WHERE post_id = ?").run(new Date().toISOString(), postId);
}

export function listingsNeedingAliveCheck({ excludeIds = [], limit = 20 } = {}) {
  const cap = Math.max(1, Number(limit) || 20);
  const skip = new Set((excludeIds || []).map(Number).filter((id) => id > 0));
  const rows = db
    .prepare(
      `SELECT post_id FROM listings
       WHERE IFNULL(hidden, 0) = 0 AND IFNULL(offline, 0) = 0
       ORDER BY CASE WHEN last_checked_at IS NULL THEN 0 ELSE 1 END,
                IFNULL(last_checked_at, last_seen_at) ASC
       LIMIT 800`,
    )
    .all();
  const out = [];
  for (const row of rows) {
    if (skip.has(Number(row.post_id))) continue;
    out.push(row);
    if (out.length >= cap) break;
  }
  return out;
}

export function listingsNeedingOfflineRecheck({ limit = 8 } = {}) {
  const cap = Math.max(1, Number(limit) || 8);
  return db
    .prepare(
      `SELECT post_id, offline, offline_at, offline_confirmed, last_checked_at
       FROM listings
       WHERE IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 1
         AND IFNULL(offline_confirmed, 0) = 0
       ORDER BY CASE WHEN last_checked_at IS NULL THEN 0 ELSE 1 END,
                IFNULL(last_checked_at, offline_at) ASC
       LIMIT ?`,
    )
    .all(Math.max(cap, 40));
}

export function resetListings() {
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM user_events");
  db.exec("DELETE FROM user_listing_flags");
  db.exec("DELETE FROM listings");
  return saveSettings({ hasBaseline: false });
}

export { DATA_EPOCH };

export function resetAllData() {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM events");
    db.exec("DELETE FROM user_events");
    db.exec("DELETE FROM user_listing_flags");
    db.exec("DELETE FROM user_settings");
    db.exec("DELETE FROM crawl_covers");
    db.exec("DELETE FROM listings");
    db.exec("DELETE FROM settings");
    db.exec("DELETE FROM geo_cache");
    db.exec("DELETE FROM route_cache");
    db.exec("DELETE FROM community_cache");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // ignore checkpoint failures; rows are already gone
  }
  return saveSettings({
    dataEpoch: DATA_EPOCH,
    searchUrls: [],
    watchDistricts: [],
    settingProfiles: [],
    activeProfileId: "",
    hasBaseline: false,
    discordWebhook: "",
    workAddress: "",
    commuteKm: 0,
    commuteMode: "scooter",
    showMrt: true,
    workLat: null,
    workLng: null,
    excludeBoxes: [],
    excludeKeywords: [],
    excludeAgents: [],
    excludeAgentIds: [],
  });
}

function readDataEpoch() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'dataEpoch'").get();
    return row ? JSON.parse(row.value) : "";
  } catch {
    return "";
  }
}

function stampDataEpoch() {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("dataEpoch", JSON.stringify(DATA_EPOCH));
}

if (shouldResetForEpoch(readDataEpoch(), DATA_EPOCH)) {
  console.warn(`[5151] DATA_EPOCH 變更（${readDataEpoch()} → ${DATA_EPOCH}），執行整庫重置`);
  resetAllData();
} else if (readDataEpoch() !== DATA_EPOCH) {
  stampDataEpoch();
}

try {
  const migrated = migrateListingFlagsIfNeeded(db, defaultUserId());
  if (migrated.migrated && migrated.copied) {
    console.log(`[5151] 已把 ${migrated.copied} 筆刊登標記搬到個人資料表`);
  }
} catch (error) {
  console.warn("個人標記遷移失敗：", error.message);
}

export function addUserEvent(event) {
  const result = db.prepare(`
    INSERT INTO user_events (user_id, post_id, type, title, detail, source_key, created_at, notified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.user_id,
    event.post_id,
    event.type,
    event.title,
    event.detail,
    event.source_key || "",
    event.created_at,
    event.notified || 0,
  );
  return Number(result.lastInsertRowid);
}

export function addEvent(event, userId) {
  const uid = userId == null ? defaultUserId() : Number(userId) || defaultUserId();
  return addUserEvent({ ...event, user_id: uid });
}

export function markEventNotified(id) {
  db.prepare("UPDATE user_events SET notified = 1 WHERE id = ?").run(id);
}

export function enqueueListingEvent(listing, event) {
  const stamp = event?.created_at || new Date().toISOString();
  const payload = {
    post_id: listing.post_id,
    source_key: listing.source_key || event?.source_key || "",
    type: event.type,
    title: listing.title || event.title || "",
    detail: event.detail || "",
    created_at: stamp,
    notified: 0,
  };
  const ids = [];
  for (const userId of listUserIds()) {
    const settings = getSettings(userId);
    const row = decorateListing(overlayPersonal(listing, loadFlags(db, userId, listing.post_id)), settings);
    const watched = Number(row.watched) === 1;
    if (!watched && event.type === "new" && !listingInMemberScope(row, settings)) continue;
    if (!shouldDeliverNotify(settings, row, event, {
      to: getUserById(userId)?.email,
      configured: getMemberMailBundle(userId).configured,
    })) continue;
    const last = db.prepare(
      "SELECT detail FROM user_events WHERE user_id = ? AND post_id = ? AND type = ? ORDER BY id DESC LIMIT 1",
    ).get(userId, payload.post_id, payload.type);
    if (last && isSameNotifyDetail(last.detail, payload.detail)) continue;
    ids.push(addUserEvent({ ...payload, user_id: userId }));
  }
  return ids;
}

export function crawlIntervalMinutes() {
  const mins = listUserIds().map((id) => Number(getSettings(id).intervalMinutes) || planIntervalMinutes(getUserById(id)?.plan));
  if (!mins.length) return Math.max(1, Number(getSettings().intervalMinutes) || 8);
  return Math.max(1, Math.min(...mins));
}

export function setFlags(postId, flags, userId) {
  const uid = resolveUserId(userId);
  const listing = getListing(postId, uid);
  if (!listing) return null;
  setUserListingFlags(db, uid, postId, flags || {}, listing);
  return getListing(postId, uid);
}

export function applyCachedCoords(row, settings) {
  if (!row) return row;
  if (!isTrustedGeoSource(row.geo_source)) return row;
  const conf = settings || getSettings();
  const workLat = Number(conf.workLat);
  const workLng = Number(conf.workLng);
  if (
    Number(conf.commuteKm) > 0 &&
    hasWorkPoint(conf) &&
    Number.isFinite(Number(row.lat)) &&
    Number.isFinite(Number(row.lng))
  ) {
    const route = getCachedRoute(row.lat, row.lng, workLat, workLng, conf.commuteMode);
    if (route) {
      return {
        ...row,
        route_kms: route.distances,
        route_km: route.min_km,
        rush_am_min: route.rush_am_min,
        rush_pm_min: route.rush_pm_min,
      };
    }
  }
  return row;
}

export function getCachedRoute(fromLat, fromLng, toLat, toLng, mode = "scooter") {
  const key = makeRouteKey(fromLat, fromLng, toLat, toLng, mode);
  const row = db.prepare("SELECT distances, min_km, rush_am_min, rush_pm_min, rush_updated_at FROM route_cache WHERE route_key = ?").get(key);
  if (!row) return null;
  const distances = parseJson(row.distances, []);
  if (!Array.isArray(distances) || !distances.length) return null;
  const rushAm = Number(row.rush_am_min);
  const rushPm = Number(row.rush_pm_min);
  return {
    distances: distances.map(Number).filter(Number.isFinite),
    min_km: Number(row.min_km),
    rush_am_min: Number.isFinite(rushAm) ? rushAm : null,
    rush_pm_min: Number.isFinite(rushPm) ? rushPm : null,
    rush_updated_at: row.rush_updated_at || "",
  };
}

export function getCachedMrt(lat, lng) {
  const key = makeMrtKey(lat, lng);
  if (!key.includes("NaN")) {
    const row = db.prepare("SELECT station, walk_km, walk_min, ride_km, ride_min FROM mrt_cache WHERE geo_key = ?").get(key);
    if (row?.station) {
      return {
        station: row.station,
        walk_km: Number(row.walk_km) || null,
        walk_min: Number(row.walk_min) || null,
        ride_km: Number(row.ride_km) || null,
        ride_min: Number(row.ride_min) || null,
      };
    }
  }
  return null;
}

export function setCachedMrt(lat, lng, access) {
  if (!access?.station) return;
  const key = makeMrtKey(lat, lng);
  if (key.includes("NaN")) return;
  db.prepare(
    `INSERT INTO mrt_cache(geo_key, station, walk_km, walk_min, ride_km, ride_min, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(geo_key) DO UPDATE SET
       station = excluded.station,
       walk_km = excluded.walk_km,
       walk_min = excluded.walk_min,
       ride_km = excluded.ride_km,
       ride_min = excluded.ride_min,
       updated_at = excluded.updated_at`,
  ).run(
    key,
    String(access.station),
    Number(access.walk_km) || null,
    Number(access.walk_min) || null,
    Number(access.ride_km) || null,
    Number(access.ride_min) || null,
    new Date().toISOString(),
  );
}

export function listingsNeedingMrt(limit = 20) {
  const cap = Math.max(1, Math.min(Number(limit) || 20, 80));
  const rows = db
    .prepare(
      `SELECT lat, lng FROM listings
       WHERE lat IS NOT NULL AND lng IS NOT NULL
         AND IFNULL(geo_source, '') IN ('591', 'community')
         AND IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
       ORDER BY last_seen_at DESC
       LIMIT 2000`,
    )
    .all();
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = makeMrtKey(row.lat, row.lng);
    if (seen.has(key) || key.includes("NaN")) continue;
    seen.add(key);
    if (getCachedMrt(row.lat, row.lng)) continue;
    out.push({ lat: row.lat, lng: row.lng });
    if (out.length >= cap) break;
  }
  return out;
}

function mrtFields(row, settings) {
  if (settings?.showMrt === false) {
    return { mrt_station: null, mrt_walk_km: null, mrt_walk_min: null, mrt_ride_km: null, mrt_ride_min: null };
  }
  if (!isTrustedGeoSource(row.geo_source) || !Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lng))) {
    return { mrt_station: null, mrt_walk_km: null, mrt_walk_min: null, mrt_ride_km: null, mrt_ride_min: null };
  }
  const cached = getCachedMrt(row.lat, row.lng) || estimateMrtAccessForPoint(row.lat, row.lng);
  if (!cached) {
    return { mrt_station: "", mrt_walk_km: null, mrt_walk_min: null, mrt_ride_km: null, mrt_ride_min: null };
  }
  return {
    mrt_station: cached.station,
    mrt_walk_km: cached.walk_km,
    mrt_walk_min: cached.walk_min,
    mrt_ride_km: cached.ride_km,
    mrt_ride_min: cached.ride_min,
  };
}

export function setCachedRoute(fromLat, fromLng, toLat, toLng, distances, rush = null, mode = "scooter") {
  const list = (Array.isArray(distances) ? distances : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!list.length) return;
  const key = makeRouteKey(fromLat, fromLng, toLat, toLng, mode);
  const minKm = Math.min(...list);
  const stamp = new Date().toISOString();
  const rushAm = Number(rush?.rushAm ?? rush?.am);
  const rushPm = Number(rush?.rushPm ?? rush?.pm);
  const hasRush = Number.isFinite(rushAm) && Number.isFinite(rushPm);
  if (hasRush) {
    db.prepare(
      `INSERT INTO route_cache(route_key, distances, min_km, updated_at, rush_am_min, rush_pm_min, rush_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(route_key) DO UPDATE SET
         distances = excluded.distances,
         min_km = excluded.min_km,
         updated_at = excluded.updated_at,
         rush_am_min = excluded.rush_am_min,
         rush_pm_min = excluded.rush_pm_min,
         rush_updated_at = excluded.rush_updated_at`,
    ).run(key, JSON.stringify(list), minKm, stamp, rushAm, rushPm, stamp);
    return;
  }
  db.prepare(
    `INSERT INTO route_cache(route_key, distances, min_km, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(route_key) DO UPDATE SET
       distances = excluded.distances,
       min_km = excluded.min_km,
       updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(list), minKm, stamp);
}

export function listingsNeedingRoute(limit = 40) {
  const jobs = commuteWorkJobs(collectCommuteSettings());
  if (!jobs.length) return [];
  const rows = db
    .prepare(
      `SELECT post_id, lat, lng FROM listings
       WHERE lat IS NOT NULL AND lng IS NOT NULL
         AND IFNULL(geo_source, '') IN ('591', 'community')
         AND IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
       ORDER BY last_seen_at DESC
       LIMIT 2000`,
    )
    .all();
  const out = [];
  const wantRush = commuteRushEnabled() && googleDirectionsAllowed();
  for (const row of rows) {
    for (const job of jobs) {
      const cached = getCachedRoute(row.lat, row.lng, job.workLat, job.workLng, job.commuteMode);
      if (cached && (!wantRush || (Number.isFinite(cached.rush_am_min) && Number.isFinite(cached.rush_pm_min)))) {
        continue;
      }
      out.push({ ...row, workLat: job.workLat, workLng: job.workLng, commuteMode: job.commuteMode });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function applyListingFilter(rows, settings = getSettings()) {
  // 列表用非嚴格通勤：還沒算完路線的先顯示（排在離公司排序末端），避免新北等區整批空白
  return rows
    .map((row) => applyCachedCoords(row, settings))
    .filter((row) => shouldKeepListing(row, settings, { strict: false }));
}

export function addressesMissingGeo() {
  return db
    .prepare(
      `SELECT address, COUNT(*) AS n
       FROM listings
       WHERE (lat IS NULL OR lng IS NULL)
         AND IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
         AND IFNULL(address, '') != ''
       GROUP BY address`,
    )
    .all();
}

export function updateListingsGeoByAddress(address, lat, lng) {
  setCachedGeo(address, lat, lng);
  const key = String(address || "").replace(/\s+/g, "").replace(/-/g, "");
  if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
  db.prepare(
    `UPDATE listings
     SET lat = ?, lng = ?
     WHERE replace(replace(IFNULL(address, ''), ' ', ''), '-', '') = ?`,
  ).run(Number(lat), Number(lng), key);
}

function priceSortKey(row) {
  const n = Number(row?.price_num) || 0;
  return n > 0 ? n : Number.MAX_SAFE_INTEGER;
}

function descIso(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.localeCompare(left);
}

export function sortListingsRows(rows, sort = "price_asc", { filter } = {}) {
  const list = [...(rows || [])];
  if (sort === "commute_asc") {
    list.sort((a, b) => (Number(a.commute_km) || 9999) - (Number(b.commute_km) || 9999) || priceSortKey(a) - priceSortKey(b));
  } else if (sort === "commute_desc") {
    list.sort((a, b) => (Number(b.commute_km) || 0) - (Number(a.commute_km) || 0) || priceSortKey(a) - priceSortKey(b));
  } else if (sort === "price_desc") {
    list.sort((a, b) => {
      const pa = Number(a.price_num) || 0;
      const pb = Number(b.price_num) || 0;
      if ((pa > 0) !== (pb > 0)) return pa > 0 ? -1 : 1;
      return pb - pa || String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || ""));
    });
  } else if (sort === "newest") {
    list.sort((a, b) => {
      if (filter === "watched") {
        const byWatch = descIso(a.watched_at, b.watched_at);
        if (byWatch) return byWatch;
      }
      return descIso(a.first_seen_at, b.first_seen_at) || Number(b.post_id) - Number(a.post_id);
    });
  } else {
    list.sort((a, b) => priceSortKey(a) - priceSortKey(b) || String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || "")));
  }
  return list;
}

export function listListings({
  filter = "all",
  kind = "",
  q = "",
  sort = "price_asc",
  limit = 500,
  searchKeys,
  districts = [],
  userId,
  settings: settingsOverride,
} = {}) {
  const uid = resolveUserId(userId);
  ({ filter, kind } = normalizeListQuery(filter, kind));
  const clauses = [];
  const params = [];
  searchWhere(searchKeys, clauses, params);
  if (filter === "suspected") {
    clauses.push("match_level IN ('high', 'medium')");
    clauses.push("IFNULL(offline, 0) = 0");
  } else if (filter === "offline") {
    clauses.push("IFNULL(offline, 0) = 1");
    clauses.push("IFNULL(offline_confirmed, 0) = 0");
  } else if (filter === "hidden") {
    clauses.push(`(
      IFNULL(match_verdict, '') = 'yes'
      OR IFNULL(hidden, 0) = 1
      OR EXISTS (
        SELECT 1 FROM user_listing_flags f
        WHERE f.post_id = listings.post_id AND f.user_id = ? AND f.hidden = 1
      )
    )`);
    params.push(uid);
  } else {
    clauses.push("IFNULL(offline, 0) = 0");
    clauses.push("(IFNULL(match_verdict, '') != 'yes')");
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM user_listing_flags f
      WHERE f.post_id = listings.post_id AND f.user_id = ? AND f.hidden = 1
    )`);
    params.push(uid);
  }
  if (filter === "all") {
    clauses.push(`IFNULL((
      SELECT watched FROM user_listing_flags f
      WHERE f.post_id = listings.post_id AND f.user_id = ?
    ), 0) = 0`);
    params.push(uid);
  }
  if (filter === "unseen") {
    clauses.push(`IFNULL((
      SELECT viewed FROM user_listing_flags f
      WHERE f.post_id = listings.post_id AND f.user_id = ?
    ), 0) = 0`);
    params.push(uid);
  }
  if (filter === "viewed") {
    clauses.push(`IFNULL((
      SELECT viewed FROM user_listing_flags f
      WHERE f.post_id = listings.post_id AND f.user_id = ?
    ), 0) = 1`);
    params.push(uid);
  }
  if (filter === "watched") {
    clauses.push(`IFNULL((
      SELECT watched FROM user_listing_flags f
      WHERE f.post_id = listings.post_id AND f.user_id = ?
    ), 0) = 1`);
    params.push(uid);
  }
  if (filter === "same_source") clauses.push("last_event IN ('same_source', 'update', 'price_drop', 'title_update')");
  if (q) {
    const like = `%${q}%`;
    clauses.push(`(
      title LIKE ? OR address LIKE ? OR CAST(post_id AS TEXT) LIKE ?
      OR IFNULL((
        SELECT watch_note FROM user_listing_flags f
        WHERE f.post_id = listings.post_id AND f.user_id = ?
      ), '') LIKE ?
    )`);
    params.push(like, like, like, uid, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const raw = db.prepare(`SELECT * FROM listings ${where}`).all(...params);
  const settings = settingsOverride || getSettings(uid);
  const flagMap = loadFlagMap(db, uid);
  let rows =
    filter === "offline" || filter === "suspected"
      ? overlayRowsPersonal(raw, flagMap).map((row) => decorateListing(row, settings))
      : applyListingFilter(overlayRowsPersonal(raw, flagMap), settings).map((row) => decorateListing(row, settings));

  rows = rows.filter((row) => listingMatchesListFilter(row, filter));

  // 整層／1F、行政區要在 limit 前套用，否則「全庫最便宜 500 筆」再前端篩選會漏掉新北等區
  rows = rows.filter((row) => passesDisplayFilters(row, settings, { skipWholeFloor: kind === "suite" }));
  const districtSet = new Set(
    (Array.isArray(districts) ? districts : String(districts || "").split(","))
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  );
  if (districtSet.size) {
    rows = rows.filter((row) => districtSet.has(row.district));
  }

  rows = rows.filter((row) => matchesHousingKind(row, kind));

  rows = sortListingsRows(rows, sort, { filter });

  const totalMatched = rows.length;
  return { listings: rows.slice(0, limit), totalMatched };
}

export function sourceHistory(sourceKey, userId) {
  const flagMap = loadFlagMap(db, resolveUserId(userId));
  return overlayRowsPersonal(
    db
      .prepare(
        `SELECT post_id, title, price, url, first_seen_at, last_seen_at, last_event, viewed, watched, hidden, watch_note
         FROM listings WHERE source_key = ? ORDER BY last_seen_at DESC`,
      )
      .all(sourceKey),
    flagMap,
  );
}

export function recentEvents(limit = 40, userId) {
  const uid = resolveUserId(userId);
  return db.prepare("SELECT * FROM user_events WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(uid, Math.max(1, Number(limit) || 40));
}

export function pendingNotifyEvents(limit = 80) {
  return db
    .prepare("SELECT * FROM user_events WHERE IFNULL(notified, 0) = 0 ORDER BY id ASC LIMIT ?")
    .all(Math.max(1, Number(limit) || 80));
}

export function eventPayloadFromListing(event, listing) {
  if (!event) return event;
  const row = listing || {};
  const merged = {
    ...event,
    title: row.title || event.title,
    url: row.url || event.url,
    price: row.price || event.price,
    extra_fee: row.extra_fee,
    extra_fee_text: row.extra_fee_text,
    extra_fees: row.extra_fees,
    address: row.address || event.address,
    layout: row.layout,
    floor_name: row.floor_name,
    kind_name: row.kind_name,
    area_name: row.area_name || event.area_name,
    tags: row.tags || event.tags,
    cover: row.cover,
    commute_km: row.commute_km,
    commute_mode: row.commute_mode,
    commute_min_am: row.commute_min_am,
    commute_min_pm: row.commute_min_pm,
    commute_routes: row.commute_routes,
    route_km: row.route_km,
    rush_am_min: row.rush_am_min,
    rush_pm_min: row.rush_pm_min,
  };
  return {
    ...merged,
    housing_type: housingTypeLabel(merged),
    notify_facts: formatNotifyFacts(merged),
  };
}

export function getCommunityCache(communityId) {
  const id = Number(communityId);
  if (!id) return null;
  const row = db.prepare("SELECT community_id AS id, name, address, lat, lng FROM community_cache WHERE community_id = ?").get(id);
  if (!row) return null;
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  return {
    id: row.id,
    name: row.name || "",
    address: row.address || "",
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
  };
}

export function hasCommunityCache(communityId) {
  const id = Number(communityId);
  if (!id) return false;
  return Boolean(db.prepare("SELECT 1 AS ok FROM community_cache WHERE community_id = ?").get(id));
}

export function setCommunityCache(community) {
  const id = Number(community?.id || community?.community_id);
  if (!id) return;
  const lat = Number(community.lat);
  const lng = Number(community.lng);
  db.prepare(
    `INSERT INTO community_cache(community_id, name, address, lat, lng, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(community_id) DO UPDATE SET
       name = excluded.name,
       address = excluded.address,
       lat = excluded.lat,
       lng = excluded.lng,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    String(community.name || "").trim(),
    String(community.address || "").trim(),
    Number.isFinite(lat) ? lat : null,
    Number.isFinite(lng) ? lng : null,
    new Date().toISOString(),
  );
}

export function stats(searchKeys, userId, settingsOverride) {
  const uid = resolveUserId(userId);
  const settings = settingsOverride || getSettings(uid);
  const clauses = [];
  const params = [];
  searchWhere(searchKeys, clauses, params);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const raw = db
    .prepare(
      `SELECT viewed, watched, hidden, offline, offline_confirmed, last_event, floor_name, kind_name, title, address, area_name, lat, lng, geo_source, tags, match_level, match_rejected, match_verdict, post_id FROM listings ${where}`,
    )
    .all(...params);
  const flagMap = loadFlagMap(db, uid);
  const overlaid = overlayRowsPersonal(raw, flagMap);
  const attrRows = overlaid.filter((row) => passesAttributeFilters(row, settings));
  const base = attrRows.filter((row) => !row.hidden && !isPendingOffline(row) && !isConfirmedOffline(row) && row.match_verdict !== "yes");
  const browse = attrRows.filter(countsTowardAllTotal);
  const geoRows = applyListingFilter(overlaid, settings).filter((row) => !row.hidden && !isPendingOffline(row) && !isConfirmedOffline(row) && row.match_verdict !== "yes" && !row.watched);
  return {
    total: browse.length,
    unseen: browse.filter((row) => !row.viewed).length,
    watched: base.filter((row) => row.watched).length,
    same_source: browse.filter((row) => ["same_source", "update", "price_drop", "title_update"].includes(row.last_event)).length,
    hidden: attrRows.filter((row) => row.hidden).length,
    offline: raw.filter((row) => isPendingOffline(row)).length,
    offlineConfirmed: raw.filter((row) => isConfirmedOffline(row)).length,
    suspected: attrRows.filter((row) => row.match_level && !row.offline).length,
    suspectedPending: attrRows.filter((row) => row.match_level && !row.match_verdict && !row.offline).length,
    elevator: browse.filter((row) => listingHasElevator(row)).length,
    stored: geoRows.length,
    filteredOut: Math.max(0, browse.length - geoRows.length),
    missingGeo: attrRows.filter((row) => !row.hidden && !isPendingOffline(row) && !isConfirmedOffline(row) && !row.watched && row.match_verdict !== "yes" && (!isTrustedGeoSource(row.geo_source) || row.lat == null || row.lng == null)).length,
    missingRoute: attrRows.filter((row) => {
      if (row.hidden || isPendingOffline(row) || isConfirmedOffline(row) || row.watched || row.match_verdict === "yes") return false;
      const geo = applyCachedCoords(row, settings);
      return (
        Number(settings.commuteKm) > 0 &&
        isTrustedGeoSource(geo.geo_source) &&
        Number.isFinite(Number(geo.lat)) &&
        Number.isFinite(Number(geo.lng)) &&
        !(Array.isArray(geo.route_kms) && geo.route_kms.length)
      );
    }).length,
    dbTotal: listingCount(),
  };
}

export function listingCount() {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM listings").get().n || 0);
}

export function listingCountForSearch(searchKey) {
  const keys = expandSearchKeys([searchKey].filter(Boolean));
  if (!keys.length) return 0;
  return Number(
    db
      .prepare(`SELECT COUNT(*) AS n FROM listings WHERE search_key IN (${keys.map(() => "?").join(",")})`)
      .get(...keys).n || 0,
  );
}

export function getCachedGeo(address) {
  const key = String(address || "").replace(/\s+/g, "").replace(/-/g, "");
  if (!key) return null;
  return db.prepare("SELECT lat, lng FROM geo_cache WHERE address = ?").get(key) || null;
}

export function setCachedGeo(address, lat, lng) {
  const key = String(address || "").replace(/\s+/g, "").replace(/-/g, "");
  if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
  db.prepare(
    "INSERT INTO geo_cache(address, lat, lng, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, updated_at = excluded.updated_at",
  ).run(key, Number(lat), Number(lng), new Date().toISOString());
}

export { db };

function settingTrue(key) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) === true : false;
  } catch {
    return false;
  }
}

function writeSettingTrue(key) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(true));
}

export function bootstrapAdminFromEnv() {
  const email = adminEmailForUser();
  const password = String(process.env.AUTH_PASSWORD || "");
  const uid = bootstrapAdminUserOn(db, email, password, { ensureUser: ensureUserOn });
  if (uid) cachedDefaultUserId = uid;
  return uid || defaultUserId();
}

export function migrateGlobalSettingsToUser(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return;
  const existing = db.prepare("SELECT 1 AS ok FROM user_settings WHERE user_id = ? LIMIT 1").get(uid);
  if (existing) return;
  const global = getSettings();
  const upsert = db.prepare(
    "INSERT INTO user_settings(user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
  );
  db.exec("BEGIN");
  try {
    for (const [key, value] of Object.entries(global)) {
      if (value === undefined || SITE_SETTING_KEYS.has(key)) continue;
      upsert.run(uid, key, JSON.stringify(value));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrateEventsToUser(userId) {
  const uid = Number(userId) || 0;
  if (!uid || settingTrue("eventsMigrated")) return;
  const events = db.prepare("SELECT * FROM events").all();
  db.exec("BEGIN");
  try {
    const insert = db.prepare(
      `INSERT INTO user_events (user_id, post_id, type, title, detail, source_key, created_at, notified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      insert.run(
        uid,
        event.post_id,
        event.type,
        event.title,
        event.detail,
        event.source_key || "",
        event.created_at,
        event.notified || 0,
      );
    }
    writeSettingTrue("eventsMigrated");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

try {
  const adminId = bootstrapAdminFromEnv();
  migrateGlobalSettingsToUser(adminId);
  migrateEventsToUser(adminId);
  try {
    applyStoredSmtp();
  } catch (error) {
    console.warn("套用 SMTP 設定失敗：", error.message);
  }
  try {
    const imported = importV1CacheIfNeeded(db, { adminUserId: adminId });
    if (imported.imported) {
      console.log(
        `[5151] 已從 v1 只讀匯入刊登 ${imported.listings} 筆、標記 ${imported.flags} 筆、社區 ${imported.communities}、座標 ${imported.geo}、路線 ${imported.routes}`,
      );
    }
  } catch (error) {
    console.warn("從 v1 匯入刊登快取失敗：", error.message);
  }
} catch (error) {
  console.warn("會員帳號初始化失敗：", error.message);
}
