import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { passesGeoFilters, passesAttributeFilters, passesDisplayFilters, listingHasElevator, matchesHousingKind, matchesListingSources, normalizeListQuery, housingTypeLabel, formatFloorDisplay, sanitizeFloorName } from "./floors.js";
import { listingKitFrom, mergeKitColumns, parseStoredFurnish } from "./listingKit.js";
import { addressPrecision, isTrustedGeoSource, listingCommunityId, preferListingAddress, sourceCommunityLinked, sqlTrustedGeoSource } from "./location.js";
import { commuteNetworkHint, makeRouteKey } from "./route.js";
import {
  COMMUTE_STATES,
  commuteSettingsFingerprint,
  commuteStateLabel,
  resolveCommuteState,
} from "./commuteState.js";
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
import { CITIES, districtNameFromListing, districtsFromSearchUrls, lookupDistrict, normalizeWatchDistricts } from "./regions.js";
import { appendDistrictCandidates, ensureDistrictCandidateIndex } from "./listDistrictSql.js";
import { appendPriceCeilingCandidates } from "./listPriceSql.js";
import { listingRefreshAt, matchFocusHints, preferPrimaryListing } from "./match.js";
import {
  ensureUserSameHouseSchema,
  loadPersonalSameHouseIds,
  loadPersonalSameHouseIndex,
  mergePersonalSameHouse,
  normalizeMergeIds,
  personalGroupAgrees,
  personalGroupKeyFor,
  splitPersonalSameHouse,
} from "./userSameHouse.js";
import { canAddWatch, countWatched } from "./watchLimits.js";
import {
  alreadyNotifiedGroup,
  bindListingsToGroup,
  bindWatchToGroup,
  ensureListingGroupSchema,
  groupIdForPost,
  watchedInGroup,
} from "./listingGroups.js";
import {
  activateSearchProfile,
  ensureSearchProfileSchema,
  getActiveSearchProfile,
  notifySnapshotFromProfile,
} from "./searchProfiles.js";
import { addressVersion, ensureGeoCacheSchema, inferGeoQuality } from "./geoQueue.js";
import {
  canUseForRoadDistance,
  commutePrecisionText,
  effectiveNotifyLocationClass,
  eventFullyHandled,
  kmListToMinMeters,
  resolveLocationClass,
  shouldAcceptGeoUpdate,
} from "./geoPrecision.js";
import { listingCompareCost, passesPriceFilter } from "./listingCost.js";
import {
  costChangePayload,
  feeChangeDetail,
  feeSignature,
  sameHouseBundle,
} from "./listingCompare.js";
import {
  MATCH_SPLIT_DAILY_LIMIT,
  pairConfidence,
  shouldPromoteGlobalSplit,
  votePair,
  votePairKey,
} from "./matchVotes.js";
import { commuteWorkJobs, hasWorkPoint, needsListingGeo, normalizeCommuteMode } from "./geo.js";
import { demoCommutePatch } from "./demo.js";
import { isWalkableMrtDistance, makeMrtKey } from "./mrt.js";
import { applySettingPatch, hydrateSettings, parseSettingRows, snapshotSettings, planIntervalMinutes, resolveSaveAsProfileAction, profileNameOrDraft, MEMBER_MAX_PROFILES, ADMIN_MAX_PROFILES, clampIntervalMinutes, memberShouldContributeCrawl, memberFetchCollision, memberHasCrawlScope } from "./settingsState.js";
import { defaultLegalCopy, normalizeLegalCopy, publicLegalCopy } from "./legalCopy.js";
import { defaultSpirit, normalizeSpirit, publicSpirit } from "./spirit.js";
import { defaultHousingData, normalizeHousingData, publicHousingData } from "./housingData.js";
import { applyIdlePauseToMembers, applyIdleResume } from "./idlePause.js";
import { defaultNotifyMatrix } from "./notifyMatrix.js";
import {
  ensureCommsSchema,
  normalizeCommsConfig,
  emptyCommsConfig,
} from "./comms.js";
import { DATA_EPOCH, shouldResetForEpoch } from "./dataEpoch.js";
import { countsTowardAllTotal, isConfirmedOffline, isPendingOffline } from "./offline.js";
import { coveringJobsFromMembers, coversFromMemberSettings, coversFromWatchDistricts, listingInMemberScope } from "./covering.js";
import { listCrawlCovers } from "./crawlCovers.js";
import { SYSTEM_CRAWL_INTERVAL_MINUTES } from "./crawlPolicy.js";
import { ensurePersonalSchema } from "./personalSchema.js";
import { importV1CacheIfNeeded, importV2CacheIfNeeded } from "./importV1.js";
import { listingFitFields } from "./listingScore.js";
import { defaultBrandMascot, normalizeBrandMascot, publicBrandMascot, BRAND_SLOTS } from "./brandMascot.js";
import {
  confirmVerifyToken as confirmVerifyTokenOn,
  expireStaleVerifyTokens as expireStaleVerifyTokensOn,
  issueVerifyToken as issueVerifyTokenOn,
} from "./emailVerify.js";
import {
  crawlSourceEnabled,
  defaultCrawlSources,
  normalizeCrawlSources,
  publicCrawlSources,
} from "./crawlSources.js";
import {
  ensureDemandSchema,
  listDemandPosts as listDemandPostsOn,
  getDemandPost as getDemandPostOn,
  createDemandPost as createDemandPostOn,
  closeDemandPost as closeDemandPostOn,
  addDemandReply as addDemandReplyOn,
  reportDemand as reportDemandOn,
  updateWishRoom as updateWishRoomOn,
  publishWishRoom as publishWishRoomOn,
  reopenWishRoom as reopenWishRoomOn,
  getWishExample as getWishExampleOn,
  saveWishExample as saveWishExampleOn,
  deleteWishExample as deleteWishExampleOn,
  wishRoomOwnerSummary as wishRoomOwnerSummaryOn,
  publicWishRoomView,
  demandMeta,
} from "./demand.js";
import {
  DEFAULT_WISH_CONDITIONS,
  mergeWishConditions,
  normalizeWishConditionItems,
  publicWishConditions,
  setWishConditionCatalog,
} from "./wishConditions.js";
import {
  ensureFeedbackSchema,
  createFeedback as createFeedbackOn,
  createFeedbackWithOutbox as createFeedbackWithOutboxOn,
  listFeedback as listFeedbackOn,
  updateFeedback as updateFeedbackOn,
  feedbackStats as feedbackStatsOn,
  feedbackMeta,
} from "./feedback.js";
import {
  ensureFeedbackOutboxSchema,
  listOutbox as listOutboxOn,
  outboxStats as outboxStatsOn,
} from "./feedbackOutbox.js";
import {
  closeSelfListing as closeSelfListingOn,
  createSelfListing as createSelfListingOn,
  createImportedDraftListing as createImportedDraftListingOn,
  ensureSelfListingSchema,
  expireOpenSelfListings as expireOpenSelfListingsOn,
  getSelfListing as getSelfListingOn,
  hideSelfListing as hideSelfListingOn,
  keepSelfListingForViewer,
  listMineSelfListings as listMineSelfListingsOn,
  listingPhotoUrls,
  publishImportedDraftListing as publishImportedDraftListingOn,
  publishOwnedDraftListing as publishOwnedDraftListingOn,
  reportSelfListing as reportSelfListingOn,
  selfListingMeta,
  selfSourceLabel,
  sqlNotSelfSource,
  sql591Source,
  sqlOpenSelfListing,
  isSelfListingId,
} from "./selfListings.js";
import {
  ensureMemberMediaSchema,
  saveMemberMedia as saveMemberMediaOn,
  listMemberMedia as listMemberMediaOn,
  deleteMemberMedia as deleteMemberMediaOn,
  ownsMediaUrl as ownsMediaUrlOn,
  isMemberMediaUrl,
  listMediaTags as listMediaTagsOn,
  createMediaTag as createMediaTagOn,
  renameMediaTag as renameMediaTagOn,
  deleteMediaTag as deleteMediaTagOn,
  setMediaTags as setMediaTagsOn,
  mediaUrlsForTagIds as mediaUrlsForTagIdsOn,
} from "./memberMedia.js";
import {
  ensureContentDocumentSchema,
  seedDefaultDocuments,
  legalCopyFromDocuments,
  getEffectiveDocument as getEffectiveDocumentOn,
  getRequiredRegistrationDocuments as getRequiredRegistrationDocumentsOn,
  listDocuments as listDocumentsOn,
  getDocumentById as getDocumentByIdOn,
  createDraft as createDraftOn,
  updateDraft as updateDraftOn,
  publishDocument as publishDocumentOn,
  createDraftFromPublished as createDraftFromPublishedOn,
  listDocumentEvents as listDocumentEventsOn,
  publicDocumentView,
  DOC_TYPES,
} from "./contentDocuments.js";
import {
  ensureMemberConsentSchema,
  listMemberConsents as listMemberConsentsOn,
  recordConsent as recordConsentOn,
  hasAcceptedRequiredDocument as hasAcceptedRequiredDocumentOn,
  pendingRequiredDocuments as pendingRequiredDocumentsOn,
  assertRegistrationConsents as assertRegistrationConsentsOn,
  recordRegistrationConsents as recordRegistrationConsentsOn,
  recordExactSubmittedConsents as recordExactSubmittedConsentsOn,
  historicalDocumentForConsent as historicalDocumentForConsentOn,
} from "./memberConsents.js";
import {
  cancelListingImport as cancelListingImportOn,
  confirmListingImport as confirmListingImportOn,
  ensureListingImportSchema,
  getOwnedListingImport as getOwnedListingImportOn,
  importMeta as importMetaOn,
  listAdminListingImports as listAdminListingImportsOn,
  listMineListingImports as listMineListingImportsOn,
  publicImport,
  publishConfirmedImport as publishConfirmedImportOn,
  reviewListingImport as reviewListingImportOn,
  startListingImport as startListingImportOn,
} from "./listingImport.js";
import {
  copyOwnListing as copyOwnListingOn,
  createContactProfile as createContactProfileOn,
  createDescriptionTemplate as createDescriptionTemplateOn,
  ensureAccountContactProfile as ensureAccountContactProfileOn,
  deleteContactProfile as deleteContactProfileOn,
  deleteDescriptionTemplate as deleteDescriptionTemplateOn,
  ensureListingToolsSchema,
  getOwnedContactProfile as getOwnedContactProfileOn,
  getOwnedDescriptionTemplate as getOwnedDescriptionTemplateOn,
  listContactProfiles as listContactProfilesOn,
  listDescriptionTemplates as listDescriptionTemplatesOn,
  listingToolsMeta,
  updateContactProfile as updateContactProfileOn,
  updateDescriptionTemplate as updateDescriptionTemplateOn,
} from "./listingTools.js";
import {
  ensurePushSchema,
  savePushSubscription as savePushSubscriptionOn,
  deletePushSubscription as deletePushSubscriptionOn,
  sendWebPush,
  publicVapidKey,
  vapidConfigured,
  pushPayloadFromEvents,
} from "./webPush.js";
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
  ADMIN_DELETE_REASONS,
  bootstrapAdminUser as bootstrapAdminUserOn,
  changeUserPassword as changeUserPasswordOn,
  deleteUser as deleteUserOn,
  findUserByEmail as findUserByEmailOn,
  getUserById as getUserByIdOn,
  isUserDeleted,
  listUserIds as listUserIdsOn,
  listUsers as listUsersOn,
  publicUser,
  registerUser as registerUserOn,
  resolveDeleteReason,
  restoreUser as restoreUserOn,
  setUserPassword as setUserPasswordOn,
  setUserPlan as setUserPlanOn,
  verifyUserPassword as verifyUserPasswordOn,
  touchLastLogin as touchLastLoginOn,
  listIdleMemberIds as listIdleMemberIdsOn,
  linkOauthIdentity as linkOauthIdentityOn,
  IDLE_PAUSE_MS,
} from "./members.js";
import { publicProfile, updateUserProfile as updateUserProfileOn } from "./profile.js";
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
  applyOauthEnv,
  normalizeOauthConfig,
  publicOauthConfig,
} from "./oauth.js";
import { defaultHelpQaItems, mergeMissingDefaultHelpQa, normalizeHelpQaItems, publicHelpQa } from "./helpQa.js";
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
import { adminSiteAdsView, normalizeSiteAds, publicSiteAdsRuntime, rejectLegacySiteAdMutation } from "./siteAds.js";
import { adminBroadcastsView, normalizeBroadcasts, publicBroadcastsRuntime, rejectLegacyBroadcastMutation } from "./broadcasts.js";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data-v3");
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "v3.db"));
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
  db.exec("ALTER TABLE route_cache ADD COLUMN min_m INTEGER");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE route_cache ADD COLUMN location_class TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE route_cache ADD COLUMN route_version INTEGER");
} catch {
  // already migrated
}
for (const sql of [
  "ALTER TABLE listings ADD COLUMN location_class TEXT",
  "ALTER TABLE listings ADD COLUMN address_norm TEXT",
  "ALTER TABLE listings ADD COLUMN address_raw TEXT",
  "ALTER TABLE listings ADD COLUMN coord_version INTEGER",
  "ALTER TABLE listings ADD COLUMN geo_provider TEXT",
  "ALTER TABLE listings ADD COLUMN geo_approx INTEGER",
  "ALTER TABLE listings ADD COLUMN geo_error TEXT",
  "ALTER TABLE listings ADD COLUMN geo_job_state TEXT",
]) {
  try { db.exec(sql); } catch { /* already migrated */ }
}
db.exec(`
  CREATE TABLE IF NOT EXISTS route_jobs (
    job_key TEXT PRIMARY KEY,
    post_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL,
    commute_mode TEXT NOT NULL,
    work_lat REAL,
    work_lng REAL,
    job_state TEXT NOT NULL,
    fail_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_route_jobs_post ON route_jobs(post_id, job_state, next_retry_at);
`);
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
  db.exec("ALTER TABLE listings ADD COLUMN contact_fetched_at TEXT");
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
  db.exec("ALTER TABLE listings ADD COLUMN alive_checked_at TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN has_natural_gas INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN furnish_items TEXT NOT NULL DEFAULT '[]'");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN has_balcony INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN kit_fetched INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN kit_refetch_v1 INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN kit_error TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN kit_next_retry_at TEXT");
} catch {
  // already migrated
}
try {
  db.exec(`UPDATE listings SET kit_fetched = 0, kit_refetch_v1 = 1
    WHERE source = 'hbhousing'
      AND IFNULL(kit_refetch_v1, 0) = 0
      AND IFNULL(furnish_items, '[]') IN ('[]', '')`);
} catch {
  // ignore
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN match_verdict TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN source TEXT NOT NULL DEFAULT '591'");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN source_id TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN model_score REAL");
} catch {
  // already migrated
}
try {
  db.exec("UPDATE listings SET source = '591' WHERE IFNULL(source, '') = ''");
  db.exec("UPDATE listings SET source_id = CAST(post_id AS TEXT) WHERE IFNULL(source_id, '') = ''");
} catch {
  // ignore
}
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_origin ON listings(source, source_id)");
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
try {
  db.exec("ALTER TABLE listings ADD COLUMN cost_changed_at TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN cost_change_detail TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN cost_change_type TEXT");
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE listings ADD COLUMN community_linked INTEGER NOT NULL DEFAULT 0");
} catch {
  // already migrated
}
try {
  db.exec(`UPDATE listings SET community_linked = 1
    WHERE IFNULL(community_linked, 0) = 0
      AND community_id > 0
      AND IFNULL(community_name, '') != ''`);
} catch {
  // optional backfill
}
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_match_peer ON listings(match_post_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_listings_list_scan ON listings(search_key, offline, match_verdict, hidden)");
ensureDistrictCandidateIndex(db);
db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_offline_counts
  ON listings(offline_confirmed) WHERE COALESCE(offline, 0) != 0`);
try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_user_listing_flags_user_watched ON user_listing_flags(user_id, watched)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_user_listing_flags_user_hidden ON user_listing_flags(user_id, hidden)");
} catch {
  // older fixtures
}
ensurePersonalSchema(db);
ensureUserSameHouseSchema(db);
ensureListingGroupSchema(db);
ensureSearchProfileSchema(db);
ensureGeoCacheSchema(db);
try { markLegacyNotifiedUnknown(); } catch { /* user_events columns arrive with personal schema */ }
try {
  const already = db.prepare("SELECT value FROM settings WHERE key = 'profileOnboardedBackfill'").get();
  if (!already) {
    db.prepare(`
      UPDATE users
      SET profile_onboarded_at = COALESCE(NULLIF(last_login_at, ''), datetime('now'))
      WHERE (profile_onboarded_at IS NULL OR profile_onboarded_at = '')
        AND IFNULL(email_verified, 1) != 0
    `).run();
    db.prepare(
      "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("profileOnboardedBackfill", "1");
  }
} catch {
  // ignore
}
ensureDemandSchema(db);
ensureFeedbackSchema(db);
ensureFeedbackOutboxSchema(db);
ensureSelfListingSchema(db);
ensureMemberMediaSchema(db);
ensureContentDocumentSchema(db);
ensureMemberConsentSchema(db);
ensureListingImportSchema(db);
ensureListingToolsSchema(db);
try {
  seedDefaultDocuments(db, { legalCopy: settingKey("legalCopy") ?? defaultLegalCopy() });
} catch {
  // 種子失敗不擋開站；註冊會 fail-closed
}
ensurePushSchema(db);
ensureCommsSchema(db);

try {
  const already = db.prepare("SELECT value FROM settings WHERE key = 'costChangeBackfill'").get();
  if (!already) {
    const latest = db.prepare(`
      SELECT e.post_id, e.type, e.detail, e.created_at
      FROM user_events e
      JOIN (
        SELECT post_id, MAX(id) AS id
        FROM user_events
        WHERE type IN ('price_drop', 'price_update', 'fee_update')
        GROUP BY post_id
      ) latest ON latest.id = e.id
    `).all();
    const upd = db.prepare(`
      UPDATE listings
      SET cost_changed_at = COALESCE(NULLIF(cost_changed_at, ''), ?),
          cost_change_type = COALESCE(NULLIF(cost_change_type, ''), ?),
          cost_change_detail = COALESCE(NULLIF(cost_change_detail, ''), ?)
      WHERE post_id = ?
    `);
    db.exec("BEGIN");
    for (const row of latest) {
      upd.run(row.created_at, row.type, row.detail || "", row.post_id);
    }
    db.exec("COMMIT");
    db.prepare(
      "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("costChangeBackfill", "1");
  }
} catch {
  try { db.exec("ROLLBACK"); } catch { /* ignore */ }
}

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
    signup_count: Number(user.signup_count) || 1,
    deleted: isUserDeleted(user),
    deleted_at: user.deleted_at || "",
    deleted_by: user.deleted_by || "",
    deleted_reason: user.deleted_reason || "",
    intervalMinutes: Number(settings.intervalMinutes) || planIntervalMinutes(user.plan),
    intervalAdminSet: settings.intervalAdminSet === true,
  };
}

export function listAdminMembers(query = {}) {
  return listUsersOn(db, query).map((user) => publicAdminMember(user));
}

export function adminDeleteMember(userId, { reasonCode, reasonText } = {}) {
  const resolved = resolveDeleteReason(reasonCode, reasonText);
  const user = deleteUserOn(db, userId, {
    by: "admin",
    reason: resolved.text,
    reasonCode: resolved.code,
  });
  return { member: publicAdminMember(user), reason: resolved };
}

export function adminRestoreMember(userId) {
  return publicAdminMember(restoreUserOn(db, userId));
}

export function deleteOwnAccount(userId, reason = "") {
  return publicAdminMember(deleteUserOn(db, userId, {
    by: "self",
    reason: String(reason || "").trim().slice(0, 2000),
    reasonCode: "self",
  }));
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

function persistOauthToAuthEnv(config) {
  const file = authEnvPath();
  const existing = existsSync(file) ? parseEnvFileText(readFileSync(file, "utf8")) : {};
  const merged = mergeEnvMap(existing, applyOauthEnv(config));
  writeFileSync(file, serializeEnvMap(merged), { encoding: "utf8", mode: 0o600 });
}

export function getStoredOauth() {
  const stored = settingKey("oauth");
  return normalizeOauthConfig(stored && typeof stored === "object" ? stored : {}, {}, process.env);
}

export function getAdminOauthSettings() {
  const oauth = getStoredOauth();
  return { oauth: publicOauthConfig(oauth) };
}

export function saveAdminOauthSettings(partial = {}) {
  const current = getStoredOauth();
  const oauth = normalizeOauthConfig(partial.oauth || {}, current);
  writeSettingKey("oauth", oauth);
  persistOauthToAuthEnv(oauth);
  return getAdminOauthSettings();
}

export function applyStoredOauth() {
  const oauth = getStoredOauth();
  applyOauthEnv(oauth);
  return oauth;
}

export function touchLastLogin(userId, opts) {
  return touchLastLoginOn(db, userId, opts);
}

export function resumeIdleIfNeeded(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return getSettings(uid);
  return applyIdleResume(uid, {
    getSettings,
    saveSettings: (id, patch) => saveSettings(patch, id),
    armFetch: armMemberExternalFetch,
  }).settings;
}

export function pauseIdleMembers({ now = Date.now() } = {}) {
  const ids = listIdleMemberIdsOn(db, { now, idleMs: IDLE_PAUSE_MS });
  return applyIdlePauseToMembers(ids, {
    getSettings,
    saveSettings: (id, patch) => saveSettings(patch, id),
  });
}

export { IDLE_PAUSE_MS };

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

export function getSiteAdsConfig() {
  return normalizeSiteAds(settingKey("siteAds"));
}

export function getAdminAdsSettings() {
  return adminSiteAdsView(getSiteAdsConfig());
}

export function saveAdminAdsSettings(_partial = {}) {
  rejectLegacySiteAdMutation();
}

export function publicAdsSettings() {
  return publicSiteAdsRuntime();
}

export function getBrandMascot() {
  return publicBrandMascot(settingKey("brandMascot") || defaultBrandMascot());
}

export function saveBrandMascot(partial = {}) {
  const current = getBrandMascot();
  const src = partial && typeof partial === "object" ? partial : {};
  const clipPatch = src.clips && typeof src.clips === "object" ? src.clips : {};
  const next = normalizeBrandMascot({
    ...current,
    ...src,
    clips: {
      welcome: { ...current.clips.welcome, ...clipPatch.welcome },
      register: { ...current.clips.register, ...clipPatch.register },
      sponsor: { ...current.clips.sponsor, ...clipPatch.sponsor },
      confused: { ...current.clips.confused, ...clipPatch.confused },
    },
  });
  writeSettingKey("brandMascot", next);
  return getBrandMascot();
}

export function applyBrandUpload(slot, upload) {
  const key = String(slot || "").trim();
  if (!BRAND_SLOTS.includes(key)) {
    const err = new Error("請選擇要套用的位置");
    err.status = 400;
    throw err;
  }
  const current = getBrandMascot();
  if (key === "mark") {
    return saveBrandMascot({ ...current, markUrl: upload.url });
  }
  return saveBrandMascot({
    ...current,
    clips: {
      ...current.clips,
      [key]: { ...current.clips[key], url: upload.url, kind: upload.kind },
    },
  });
}

export function getBroadcastsConfig() {
  return normalizeBroadcasts(settingKey("broadcasts"));
}

export function getAdminBroadcastsSettings() {
  return adminBroadcastsView(getBroadcastsConfig());
}

export function saveAdminBroadcastsSettings(_partial = {}) {
  rejectLegacyBroadcastMutation();
}

export function publicBroadcastsSettings() {
  return publicBroadcastsRuntime();
}

export function getCommsConfig() {
  return normalizeCommsConfig(settingKey("commsConfig") || emptyCommsConfig());
}

export function saveCommsConfig(partial = {}) {
  const current = getCommsConfig();
  const src = partial && typeof partial === "object" ? partial : {};
  const next = normalizeCommsConfig({ ...current, ...src });
  writeSettingKey("commsConfig", next);
  return next;
}

export function getHelpQa() {
  const stored = settingKey("helpQa");
  const items = stored == null ? defaultHelpQaItems() : mergeMissingDefaultHelpQa(stored.items ?? stored);
  return publicHelpQa(items);
}

export function getWishConditions() {
  const stored = settingKey("wishConditions");
  const items = stored == null ? DEFAULT_WISH_CONDITIONS : mergeWishConditions(stored);
  setWishConditionCatalog(items);
  return publicWishConditions(items);
}

export function saveWishConditions(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  if (src.reset === true) {
    writeSettingKey("wishConditions", { items: normalizeWishConditionItems(DEFAULT_WISH_CONDITIONS) });
    return getWishConditions();
  }
  writeSettingKey("wishConditions", { items: normalizeWishConditionItems(src.items) });
  return getWishConditions();
}

export function saveHelpQa(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  if (src.reset === true) {
    writeSettingKey("helpQa", { items: defaultHelpQaItems() });
    return getHelpQa();
  }
  writeSettingKey("helpQa", { items: normalizeHelpQaItems(src.items) });
  return getHelpQa();
}

export function getHousingData() {
  return publicHousingData(settingKey("housingData") ?? defaultHousingData());
}

export function saveHousingData(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  if (src.reset === true) {
    writeSettingKey("housingData", defaultHousingData());
    return getHousingData();
  }
  writeSettingKey("housingData", normalizeHousingData(src));
  return getHousingData();
}

export function getHousingDataRaw() {
  return normalizeHousingData(settingKey("housingData") ?? defaultHousingData());
}

export function writeHousingData(data) {
  writeSettingKey("housingData", normalizeHousingData(data));
  return getHousingData();
}

export function getSpirit() {
  return publicSpirit(settingKey("spirit") ?? defaultSpirit());
}

export function saveSpirit(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  if (src.reset === true) {
    writeSettingKey("spirit", defaultSpirit());
    return getSpirit();
  }
  writeSettingKey("spirit", normalizeSpirit({ ...getSpirit(), ...src }));
  return getSpirit();
}

export function getLegalCopy() {
  try {
    const fromDocs = legalCopyFromDocuments(db);
    if (fromDocs?.disclaimer && fromDocs?.privacy) return publicLegalCopy(fromDocs);
  } catch {
    // 回退 settings
  }
  return publicLegalCopy(settingKey("legalCopy") ?? defaultLegalCopy());
}

export function saveLegalCopy(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  const next = src.reset === true
    ? defaultLegalCopy()
    : normalizeLegalCopy({ ...getLegalCopy(), ...src });
  writeSettingKey("legalCopy", next);
  try {
    const now = new Date();
    for (const [type, body, title, check] of [
      ["registration_terms", next.disclaimer, "免責聲明", next.disclaimerCheck],
      ["privacy_notice", next.privacy, "個資說明", next.privacyCheck],
    ]) {
      const current = getEffectiveDocumentOn(db, type, { now });
      if (current && current.body === body && current.check_label === check) continue;
      const draft = createDraftOn(db, {
        document_type: type,
        title: current?.title || title,
        body,
        check_label: check,
        format: "plain",
        requires_reacceptance: false,
        supersedes_id: current?.id,
      }, { actorId: 0, now });
      publishDocumentOn(db, draft.id, { actorId: 0, now });
    }
  } catch {
    // 舊路徑仍寫 settings；CMS 寫入失敗不擋
  }
  return getLegalCopy();
}

function withLegalProfile(profile) {
  const copy = getLegalCopy();
  return {
    ...profile,
    privacy_text: copy.privacy,
    disclaimer_text: copy.disclaimer,
    privacy_check: copy.privacyCheck,
    disclaimer_check: copy.disclaimerCheck,
    legal_version: copy.version,
  };
}

function migrateSelfCrawlSourceOn() {
  const raw = settingKey("crawlSources");
  if (raw == null) return;
  const stored = Array.isArray(raw) ? raw : raw.items;
  if (!Array.isArray(stored)) return;
  const self = stored.find((row) => row?.id === "self");
  if (!self || self.stub !== true) return;
  writeSettingKey(
    "crawlSources",
    normalizeCrawlSources(stored.map((row) => (
      row?.id === "self" ? { ...row, enabled: true, stub: false } : row
    ))),
  );
}

migrateSelfCrawlSourceOn();

export function getCrawlSources() {
  return publicCrawlSources(settingKey("crawlSources") ?? defaultCrawlSources());
}

export function saveCrawlSources(partial = {}) {
  const src = partial && typeof partial === "object" ? partial : {};
  const next = normalizeCrawlSources(src.items ?? src);
  writeSettingKey("crawlSources", next);
  return getCrawlSources();
}

export function isCrawlSourceEnabled(id) {
  return crawlSourceEnabled(getCrawlSources().items, id);
}

export function getRakuyaPageCursors() {
  return settingKey("rakuyaPageCursors") || {};
}

export function saveRakuyaPageCursors(progress) {
  const next = { ...getRakuyaPageCursors() };
  for (const row of progress || []) {
    if (Number(row.regionId) > 0 && Number.isFinite(Number(row.nextPage))) {
      next[Number(row.regionId)] = Math.max(2, Math.floor(Number(row.nextPage)));
    }
  }
  writeSettingKey("rakuyaPageCursors", next);
}

export function listDemand(opts = {}) {
  getWishConditions();
  return listDemandPostsOn(db, opts);
}

export function getDemand(postId, opts = {}) {
  getWishConditions();
  return getDemandPostOn(db, postId, opts);
}

export function createDemand(userId, input) {
  getWishConditions();
  return createDemandPostOn(db, userId, input);
}

export function closeDemand(userId, postId, opts = {}) {
  return closeDemandPostOn(db, userId, postId, opts);
}

export function replyDemand(userId, postId, body) {
  return addDemandReplyOn(db, userId, postId, body);
}

export function reportDemandItem(userId, input) {
  return reportDemandOn(db, userId, input);
}

export function updateWishRoomFor(userId, postId, input) {
  getWishConditions();
  return updateWishRoomOn(db, userId, postId, input);
}

export function publishWishRoomFor(userId, postId, input) {
  getWishConditions();
  return publishWishRoomOn(db, userId, postId, input);
}

export function reopenWishRoomFor(userId, postId) {
  getWishConditions();
  return reopenWishRoomOn(db, userId, postId);
}

export function getWishExampleFor(userId) {
  return getWishExampleOn(db, userId);
}

export function saveWishExampleFor(userId, input) {
  getWishConditions();
  return saveWishExampleOn(db, userId, input);
}

export function deleteWishExampleFor(userId) {
  return deleteWishExampleOn(db, userId);
}

export function wishRoomOwnerSummaryFor(userId) {
  return wishRoomOwnerSummaryOn(db, userId);
}

export { demandMeta, publicWishRoomView, selfListingMeta, isSelfListingId };

// Phase 2：feedback 與其初始 outbox 事件永遠在同一交易原子建立（不變式：accepted feedback ⇔ outbox 事件）。
// 傳輸開關（OPS_FEEDBACK_DELIVERY）只影響背景 worker 是否遞送，不影響 outbox 是否建立。
export function submitFeedback(userId, input) {
  return createFeedbackWithOutboxOn(db, userId, input);
}

export function listFeedbackOutbox(opts = {}) {
  return listOutboxOn(db, opts);
}

export function feedbackOutboxStats() {
  return outboxStatsOn(db);
}

export function opsDeliveryDb() {
  return db;
}

export function listFeedbackItems(opts = {}) {
  return listFeedbackOn(db, opts);
}

export function updateFeedbackItem(id, patch) {
  return updateFeedbackOn(db, id, patch);
}

export function getFeedbackStats() {
  return feedbackStatsOn(db);
}

export { feedbackMeta };

export function listMineSelfListings(userId) {
  return listMineSelfListingsOn(db, userId);
}

export function getSelfListing(postId, opts = {}) {
  return getSelfListingOn(db, postId, opts);
}

export function createSelfListing(userId, input) {
  return createSelfListingOn(db, userId, input, new Date(), {
    matchCandidates: (listing) => listMatchCandidates(listing.post_id, listing),
  });
}

export function listingToolsInfo(userId) {
  const user = userId ? getUserById(userId) : null;
  return listingToolsMeta({ plan: user?.plan, role: user?.role });
}
export function copyOwnListingFor(userId, sourceId, input = {}) {
  return copyOwnListingOn(db, userId, sourceId, input);
}
export function publishOwnedDraftFor(userId, postId, input = {}) {
  return publishOwnedDraftListingOn(db, userId, postId, input, new Date(), {
    matchCandidates: (listing) => listMatchCandidates(listing.post_id, listing),
  });
}
export function listDescriptionTemplatesFor(userId) {
  return listDescriptionTemplatesOn(db, userId);
}
export function createDescriptionTemplateFor(userId, input) {
  const user = getUserById(userId);
  return createDescriptionTemplateOn(db, userId, input, new Date(), { plan: user?.plan, role: user?.role });
}
export function getOwnedDescriptionTemplateFor(userId, id) {
  return getOwnedDescriptionTemplateOn(db, userId, id);
}
export function updateDescriptionTemplateFor(userId, id, input) {
  return updateDescriptionTemplateOn(db, userId, id, input);
}
export function deleteDescriptionTemplateFor(userId, id) {
  return deleteDescriptionTemplateOn(db, userId, id);
}
export function listContactProfilesFor(userId) {
  ensureAccountContactProfileOn(db, userId);
  return listContactProfilesOn(db, userId);
}
export function createContactProfileFor(userId, input) {
  return createContactProfileOn(db, userId, input);
}
export function getOwnedContactProfileFor(userId, id) {
  return getOwnedContactProfileOn(db, userId, id);
}
export function updateContactProfileFor(userId, id, input) {
  return updateContactProfileOn(db, userId, id, input);
}
export function deleteContactProfileFor(userId, id) {
  return deleteContactProfileOn(db, userId, id);
}

export function listingImportMeta(opts) {
  return importMetaOn(db, opts);
}
export function listMineListingImports(userId) {
  return listMineListingImportsOn(db, userId);
}
export function getOwnedListingImport(userId, id) {
  return publicImport(db, getOwnedListingImportOn(db, userId, id));
}
export function startListingImportFor(userId, input, opts = {}) {
  return startListingImportOn(db, userId, input, opts);
}
export function reviewListingImportFor(userId, id, input) {
  return reviewListingImportOn(db, userId, id, input);
}
export function cancelListingImportFor(userId, id) {
  return cancelListingImportOn(db, userId, id);
}
export function confirmListingImportFor(userId, id, input) {
  return confirmListingImportOn(db, userId, id, input);
}
export function publishConfirmedImportFor(userId, id, input) {
  return publishConfirmedImportOn(db, userId, id, input, {
    matchCandidates: (listing) => listMatchCandidates(listing.post_id, listing),
  });
}
export function listAdminListingImports(opts) {
  return listAdminListingImportsOn(db, opts);
}
export { createImportedDraftListingOn as createImportedDraftListing };
export { publishImportedDraftListingOn as publishImportedDraftListing };

// 會員照片素材庫（member media library）：綁定本 db 的包裝。
export function saveMemberMediaFor(userId, buffer, opts = {}) {
  return saveMemberMediaOn(db, userId, buffer, opts);
}
export function listMemberMediaFor(userId, opts = {}) {
  return listMemberMediaOn(db, userId, opts);
}
export function deleteMemberMediaFor(userId, id, opts = {}) {
  return deleteMemberMediaOn(db, userId, id, opts);
}
export function listMediaTagsFor(userId) {
  return listMediaTagsOn(db, userId);
}
export function createMediaTagFor(userId, name, now) {
  return createMediaTagOn(db, userId, name, now);
}
export function renameMediaTagFor(userId, id, name) {
  return renameMediaTagOn(db, userId, id, name);
}
export function deleteMediaTagFor(userId, id) {
  return deleteMediaTagOn(db, userId, id);
}
export function setMediaTagsFor(userId, mediaId, tagIds) {
  return setMediaTagsOn(db, userId, mediaId, tagIds);
}
export function mediaUrlsForTagIdsFor(userId, tagIds) {
  return mediaUrlsForTagIdsOn(db, userId, tagIds);
}
export function ownsMemberMediaUrl(userId, url) {
  return ownsMediaUrlOn(db, userId, url);
}
export function assertOwnsMemberMediaUrls(userId, urls) {
  for (const u of Array.isArray(urls) ? urls : []) {
    if (isMemberMediaUrl(u) && !ownsMediaUrlOn(db, userId, u)) {
      const e = new Error("只能使用自己素材庫的照片");
      e.status = 403;
      throw e;
    }
  }
  return true;
}

export function closeSelfListing(userId, postId, opts = {}) {
  return closeSelfListingOn(db, userId, postId, opts);
}

export function hideSelfListing(postId) {
  return hideSelfListingOn(db, postId);
}

export function reportSelfListing(userId, postId, reason) {
  return reportSelfListingOn(db, userId, postId, reason);
}

export function saveUserPushSubscription(userId, sub) {
  return savePushSubscriptionOn(db, userId, sub);
}

export function deleteUserPushSubscription(userId, endpoint) {
  return deletePushSubscriptionOn(db, userId, endpoint);
}

export async function sendUserWebPush(userId, payload) {
  return sendWebPush(db, userId, payload);
}

export { publicVapidKey, vapidConfigured, pushPayloadFromEvents };

export function listUserIds() {
  return listUserIdsOn(db);
}

export { ADMIN_DELETE_REASONS };

export function registerUser(input) {
  return registerUserOn(db, input);
}

export function registerUserWithConsents(input, { now = new Date(), source = "registration" } = {}) {
  const docs = assertRegistrationConsentsOn(db, input?.consents, { now });
  db.exec("BEGIN");
  try {
    const user = registerUserOn(db, input);
    recordRegistrationConsentsOn(db, user.id, docs, { source, now });
    db.exec("COMMIT");
    return user;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

export function getEffectiveDocument(type, opts) {
  return getEffectiveDocumentOn(db, type, opts);
}
export function getRequiredRegistrationDocuments(opts) {
  return getRequiredRegistrationDocumentsOn(db, opts).map(publicDocumentView);
}
export function listContentDocuments(opts) {
  return listDocumentsOn(db, opts);
}
export function getContentDocument(id) {
  return getDocumentByIdOn(db, id);
}
export function createContentDraft(input, opts) {
  return createDraftOn(db, input, opts);
}
export function updateContentDraft(id, input, opts) {
  return updateDraftOn(db, id, input, opts);
}
export function publishContentDocument(id, opts) {
  return publishDocumentOn(db, id, opts);
}
export function newContentVersion(id, opts) {
  return createDraftFromPublishedOn(db, id, opts);
}
export function listContentEvents(opts) {
  return listDocumentEventsOn(db, opts);
}
export function listMyConsents(userId) {
  return listMemberConsentsOn(db, userId);
}
export function pendingMemberDocuments(userId, opts) {
  return pendingRequiredDocumentsOn(db, userId, opts);
}
export function acceptPendingDocuments(userId, submitted, opts) {
  return recordExactSubmittedConsentsOn(db, userId, submitted, opts);
}
export function hasAcceptedRequiredDocument(userId, type, opts) {
  return hasAcceptedRequiredDocumentOn(db, userId, type, opts);
}
export function getOwnConsentDocument(userId, consentId) {
  return historicalDocumentForConsentOn(db, userId, consentId);
}
export { DOC_TYPES, publicDocumentView, recordConsentOn as recordMemberConsent };

export function linkOauthIdentity(userId, opts) {
  return linkOauthIdentityOn(db, userId, opts);
}

export function updateUserProfile(userId, input) {
  const row = updateUserProfileOn(db, userId, input);
  return withLegalProfile({ ...publicUser(row), ...publicProfile(row) });
}

export function countOpenSelfListings(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  expireOpenSelfListingsOn(db);
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM listings
     WHERE listed_by_user_id = ?
       AND COALESCE(source, '591') = 'self'
       AND COALESCE(self_status, 'open') = 'open'`,
  ).get(uid);
  return Number(row?.n) || 0;
}

export function issueVerifyToken(userId, opts) {
  return issueVerifyTokenOn(db, userId, opts);
}

export function confirmVerifyToken(token, opts) {
  return confirmVerifyTokenOn(db, token, opts);
}

export function expireStaleVerifyTokens(opts) {
  return expireStaleVerifyTokensOn(db, opts);
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
    smtp: getStoredSmtp(),
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
  "v2CacheImported",
  "crawlSources",
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
  webhookNotifyNew: false,
  webhookNotifyPriceDrop: false,
  webhookNotifyTitleUpdate: false,
  notifyMatrix: defaultNotifyMatrix(),
  windowsToast: true,
  hasBaseline: false,
  excludeLowFloors: true,
  wholeFloorOnly: false,
  minBuildingFloors: 0,
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
  workLocationClass: "",
  notifyIncludeStreetEstimate: false,
  settingProfiles: [],
  activeProfileId: "",
  watchDistricts: [],
  hiddenCityIds: [],
  priceMin: 0,
  priceMax: 0,
  priceMaxIncludesExtras: false,
  areaMax: 0,
  excludeRooftop: true,
  offlineConfirmDays: 7,
  notificationsPaused: false,
  inactivityPaused: false,
  memberFetchDueAt: "",
  dataEpoch: DATA_EPOCH,
};

function omitSiteMail(stored) {
  if (!stored || typeof stored !== "object") return stored;
  const next = { ...stored };
  delete next.smtp;
  delete next.mailTemplates;
  delete next.sponsorLinks;
  delete next.siteAds;
  delete next.broadcasts;
  delete next.commsConfig;
  delete next.memberSmtp;
  delete next.memberMailTemplates;
  delete next.mailPreset;
  delete next.brandMascot;
  return next;
}

function withSystemCrawl(settings) {
  if (!settings) return settings;
  const system = getSystemCrawl();
  return {
    ...settings,
    systemCrawlIntervalMinutes: system.intervalMinutes,
    showListRefreshBar: system.showListRefreshBar === true,
  };
}

const settingsMemo = new Map();

function rememberSettings(uid, value) {
  const key = Number(uid) || 0;
  settingsMemo.set(key, value);
  queueMicrotask(() => {
    if (settingsMemo.get(key) === value) settingsMemo.delete(key);
  });
  return value;
}

function forgetSettings(uid) {
  if (uid == null) {
    settingsMemo.clear();
    return;
  }
  settingsMemo.delete(Number(uid) || 0);
}

export function getSettings(userId) {
  const uid = Number(userId) || 0;
  if (settingsMemo.has(uid)) return settingsMemo.get(uid);
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const global = hydrateSettings(omitSiteMail(parseSettingRows(rows)), DEFAULTS, { admin: true, plan: "free" });
  if (!uid) return rememberSettings(0, withSystemCrawl(global));
  const userRows = db.prepare("SELECT key, value FROM user_settings WHERE user_id = ?").all(uid);
  const user = getUserById(uid);
  const admin = user?.role === "admin";
  const plan = user?.plan || "free";
  if (!userRows.length) {
    if (user?.role === "admin") return rememberSettings(uid, withSystemCrawl(global));
    return rememberSettings(uid, withSystemCrawl(hydrateSettings({
      dataEpoch: global.dataEpoch,
      hasBaseline: global.hasBaseline,
    }, DEFAULTS, { admin: false, plan })));
  }
  return rememberSettings(uid, withSystemCrawl(hydrateSettings(omitSiteMail({ ...global, ...parseSettingRows(userRows) }), DEFAULTS, { admin, plan })));
}

export function saveSettings(partial, userId, { forceAdmin = false } = {}) {
  const uid = userId == null ? defaultUserId() : Number(userId) || defaultUserId();
  forgetSettings(uid);
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
        || key === "siteAds"
        || key === "broadcasts"
        || key === "commsConfig"
        || key === "memberSmtp"
        || key === "memberMailTemplates"
        || key === "systemWatchDistricts"
        || key === "systemCrawlIntervalMinutes"
        || key === "systemCrawlIntervalMinutesDisplay"
        || key === "brandMascot"
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
  persistSearchProfileFromSettings(uid, next);
  rememberSettings(uid, next);
  return next;
}

function persistSearchProfileFromSettings(userId, settings) {
  const uid = Number(userId) || 0;
  if (!uid || !settings) return;
  const profileId = String(settings.activeProfileId || settings.settingProfiles?.[0]?.id || "live");
  const profile = (settings.settingProfiles || []).find((item) => String(item.id) === profileId);
  try {
    activateSearchProfile(db, uid, profileId, {
      name: profile?.name || "目前搜尋",
      data: snapshotSettings(settings),
    });
  } catch {
    // isolated fixtures without profile table
  }
}

export function saveAsProfile(name, livePatch, userId, { overwrite = false } = {}) {
  const uid = userId == null ? defaultUserId() : Number(userId) || defaultUserId();
  const admin = getUserById(uid)?.role === "admin";
  const current = livePatch && typeof livePatch === "object" ? saveSettings(livePatch, uid) : getSettings(uid);
  const profiles = [...(current.settingProfiles || [])];
  const label = profileNameOrDraft(name);
  const decision = resolveSaveAsProfileAction(profiles, label, { overwrite, admin });
  if (decision.action === "empty") {
    const err = new Error("請先填設定檔名稱");
    err.status = 400;
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
    saveSettings({
      settingProfiles: next,
      activeProfileId: id,
    }, uid);
    return armMemberExternalFetch(uid);
  }
  const id = `p-${Date.now()}`;
  profiles.push({
    id,
    name: label,
    saved_at: new Date().toISOString(),
    data: snapshotSettings(current),
  });
  saveSettings({
    settingProfiles: profiles,
    activeProfileId: id,
  }, uid);
  return armMemberExternalFetch(uid);
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
  saveSettings({
    ...snapshotSettings({ ...DEFAULTS, ...profile.data }),
    settingProfiles: current.settingProfiles,
    activeProfileId: profile.id,
  }, uid);
  return armMemberExternalFetch(uid);
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

function decorateSameHousePeer(raw) {
  if (!raw) return null;
  const source = String(raw.source || "591") || "591";
  return {
    ...raw,
    extra_fees: Array.isArray(raw.extra_fees) ? raw.extra_fees : parseJson(raw.extra_fees, []),
    source,
    source_label: selfSourceLabel(source),
  };
}

function loadSameHousePeers(row, userId) {
  const selfId = Number(row?.post_id) || 0;
  if (!selfId) return [];
  const seed = new Set([selfId, Number(row.match_post_id) || 0].filter(Boolean));
  for (const id of loadPersonalSameHouseIds(db, userId, selfId)) seed.add(id);
  const found = new Map();
  for (let hop = 0; hop < 2 && seed.size; hop += 1) {
    const ids = [...seed];
    seed.clear();
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT post_id, source_id, title, url, price, price_num, extra_fee, extra_fees, extra_fee_text,
              price_contain_text, floor_name, area_name, layout, source, offline, offline_confirmed,
              hidden, match_post_id, match_level, match_verdict, match_detail,
              cost_changed_at, cost_change_detail, cost_change_type, last_seen_at, refresh_time
       FROM listings
       WHERE post_id IN (${placeholders}) OR match_post_id IN (${placeholders})
       LIMIT 8`,
    ).all(...ids, ...ids);
    for (const item of rows) {
      const id = Number(item.post_id);
      if (!id || found.has(id)) continue;
      found.set(id, item);
      const peer = Number(item.match_post_id) || 0;
      if (peer && !found.has(peer)) seed.add(peer);
    }
  }
  try {
    const gid = groupIdForPost(db, selfId);
    if (gid) {
      const extras = db.prepare(
        `SELECT l.post_id, l.source_id, l.title, l.url, l.price, l.price_num, l.extra_fee, l.extra_fees, l.extra_fee_text,
                l.price_contain_text, l.floor_name, l.area_name, l.layout, l.source, l.offline, l.offline_confirmed,
                l.hidden, l.match_post_id, l.match_level, l.match_verdict, l.match_detail,
                l.cost_changed_at, l.cost_change_detail, l.cost_change_type, l.last_seen_at, l.refresh_time
         FROM listing_group_members m
         JOIN listings l ON l.post_id = m.post_id
         WHERE m.group_id = ?`,
      ).all(gid);
      for (const item of extras) {
        const id = Number(item.post_id);
        if (!id || found.has(id)) continue;
        found.set(id, item);
      }
    }
  } catch {
    // group tables optional in older isolated fixtures
  }
  return [...found.values()]
    .filter((item) => Number(item.post_id) !== selfId)
    .map(decorateSameHousePeer);
}

function decorateListingLite(row, settings, userId) {
  if (!row) return row;
  settings = settings || getSettings();
  if (!Array.isArray(row.route_kms) && !Number.isFinite(Number(row.route_km))) {
    row = applyCachedCoords(row, settings);
  }
  const locationClass = effectiveNotifyLocationClass(row, settings);
  const showRoadKm = canUseForRoadDistance(locationClass);
  const commute = showRoadKm && Number.isFinite(Number(row.route_km)) ? Number(row.route_km) : null;
  const commuteKm = commute == null ? null : Math.round(commute * 10) / 10;
  const returnKm = showRoadKm && Number.isFinite(Number(row.route_return_km)) ? Math.round(Number(row.route_return_km) * 10) / 10 : null;
  const extraFees = Array.isArray(row.extra_fees) ? row.extra_fees : parseJson(row.extra_fees, []);
  const source = String(row.source || "591") || "591";
  const uid = Number(userId) || 0;
  const listedBy = Number(row.listed_by_user_id) || 0;
  const commuteOn = Number(settings.commuteKm) > 0 && hasWorkPoint(settings);
  const hasCoords = isTrustedGeoSource(row.geo_source)
    && Number.isFinite(Number(row.lat))
    && Number.isFinite(Number(row.lng))
    && showRoadKm;
  const job = commuteOn && commuteKm == null
    ? getRouteJob(makeRouteJobKey(row.post_id, "to_work", "distance", settings.commuteMode, settings.workLat, settings.workLng))
    : null;
  const commuteState = resolveCommuteState({ commuteOn, hasCoords, commuteKm, job });
  const routeMinM = showRoadKm ? kmListToMinMeters(row.route_kms, row.route_min_m ?? row.min_m) : null;
  const fit = listingFitFields({ ...row, extra_fees: extraFees, commute_km: commuteKm }, settings);
  const out = {
    ...row,
    extra_fees: extraFees,
    has_elevator: listingHasElevator(row),
    commute_km: commuteKm,
    commute_return_km: returnKm,
    commute_state: commuteState,
    commute_state_label: commuteStateLabel(commuteState),
    commute_mode: normalizeCommuteMode(settings.commuteMode),
    commute_hint: commuteOn ? commuteNetworkHint(settings.commuteMode) : "",
    commute_routes: Array.isArray(row.route_kms) ? row.route_kms : [],
    location_class: locationClass,
    commute_precision: commuteOn ? commutePrecisionText({ ...row, location_class: locationClass, commute_state: commuteState }, commuteKm) : "",
    commute_approx: locationClass === "street" || settings.workLocationClass === "street",
    route_min_m: routeMinM,
    work_location_class: settings.workLocationClass || "",
    commute_min_am: Number.isFinite(Number(row.rush_am_min)) && Number(row.rush_am_min) > 0 ? Math.round(Number(row.rush_am_min)) : null,
    commute_min_pm: Number.isFinite(Number(row.rush_pm_min)) && Number(row.rush_pm_min) > 0 ? Math.round(Number(row.rush_pm_min)) : null,
    district: districtNameFromListing(row),
    floor_display: formatFloorDisplay(row.floor_name),
    has_natural_gas: Number(row.has_natural_gas) === 1 || listingKitFrom(row).has_natural_gas,
    has_balcony: Number(row.has_balcony) === 1 || listingKitFrom(row).has_balcony,
    furnish_items: (() => {
      const stored = parseStoredFurnish(row.furnish_items);
      return listingKitFrom({
        ...row,
        furnish_items: stored.length ? stored : row.furnish_items,
      }).furnish_items;
    })(),
    community_linked: Number(row.community_linked) === 1 || Number(row.community_id) > 0,
    source,
    source_label: selfSourceLabel(source),
    mine: uid > 0 && listedBy === uid,
    ...fit,
  };
  return out;
}

function loadUserSplitPairSet(userId) {
  const uid = Number(userId) || 0;
  if (!uid) return new Set();
  try {
    return new Set(
      db.prepare(
        `SELECT post_id, peer_id FROM user_match_votes WHERE user_id = ? AND vote = 'split'`,
      ).all(uid).map((row) => `${row.post_id}:${row.peer_id}`),
    );
  } catch {
    return new Set();
  }
}

function attachSameHouseRoles(rows, voteUserId) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;
  const personal = loadPersonalSameHouseIndex(db, voteUserId);
  const byId = new Map(list.map((row) => [Number(row.post_id), row]));
  const missing = new Set();
  for (const row of list) {
    if (String(row.match_verdict || "") === "no") continue;
    const mid = Number(row.match_post_id) || 0;
    if (mid && !byId.has(mid)) missing.add(mid);
    if (voteUserId) {
      for (const pid of personal.peers(row.post_id)) {
        if (!byId.has(pid)) missing.add(pid);
      }
    }
  }
  const extras = new Map();
  if (missing.size) {
    const ids = [...missing];
    const placeholders = ids.map(() => "?").join(",");
    const found = db.prepare(
      `SELECT post_id, source, source_id, url, price, price_num, extra_fee, extra_fees, extra_fee_text, price_contain_text,
              refresh_time, last_seen_at, hidden, offline, match_verdict, match_level
       FROM listings WHERE post_id IN (${placeholders})`,
    ).all(...ids);
    for (const item of found) extras.set(Number(item.post_id), item);
  }
  const resolve = (id) => byId.get(id) || extras.get(id) || null;
  const splits = loadUserSplitPairSet(voteUserId);
  for (const row of list) {
    const mid = Number(row.match_post_id) || 0;
    if (!mid || String(row.match_verdict || "") === "no") continue;
    const peer = resolve(mid);
    if (!peer || String(peer.match_verdict || "") === "no") continue;
    if (splits.has(votePairKey(row.post_id, mid))) {
      row.same_house_split = true;
      continue;
    }
    const primary = preferPrimaryListing(row, peer);
    const primaryId = Number(primary.post_id);
    const primaryOffline = Number(primary.offline) === 1;
    // 疑似／確定同源都是成對關係。即使只有其中一側存 match_post_id，
    // 也要把「非主卡」那側標成 affiliate 收進展開列，避免同一對在主列表出現兩次。
    const assignRole = (target) => {
      if (!target || target.same_house_split || target.same_house_role) return;
      target.same_house_role = Number(target.post_id) === primaryId ? "primary" : "affiliate";
      target.same_house_primary_id = primaryId;
      target.same_house_primary_offline = primaryOffline;
    };
    assignRole(row);
    assignRole(byId.get(mid));
  }
  if (voteUserId) {
    const grouped = new Map();
    for (const row of list) {
      const key = personal.groupKey(row.post_id);
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    for (const members of grouped.values()) {
      const pool = [];
      const seen = new Set();
      const add = (item) => {
        const id = Number(item?.post_id) || 0;
        if (!id || seen.has(id) || item.same_house_split) return;
        seen.add(id);
        pool.push(item);
      };
      for (const row of members) {
        add(row);
        for (const pid of personal.peers(row.post_id)) add(resolve(pid));
      }
      if (pool.length < 2) continue;
      const primary = pool.reduce((best, item) => preferPrimaryListing(best, item), pool[0]);
      const primaryId = Number(primary.post_id);
      const primaryOffline = Number(primary.offline) === 1;
      for (const target of pool) {
        target.same_house_role = Number(target.post_id) === primaryId ? "primary" : "affiliate";
        target.same_house_primary_id = primaryId;
        target.same_house_primary_offline = primaryOffline;
        target.same_house_personal = true;
      }
    }
  }
  return list;
}

function attachListingPeers(row, settings, voteUserId) {
  if (!row) return row;
  const splits = loadUserSplitPairSet(voteUserId);
  const selfId = Number(row.post_id) || 0;
  const sameHousePeers = loadSameHousePeers(row, voteUserId).filter((peer) => (
    peer.match_verdict !== "no" && !splits.has(votePairKey(selfId, peer.post_id))
  ));
  const matchPostId = Number(row.match_post_id) || 0;
  const splitFromMatch = matchPostId > 0 && splits.has(votePairKey(selfId, matchPostId));
  const matchPeer = splitFromMatch
    ? null
    : sameHousePeers.find((item) => Number(item.post_id) === matchPostId) || sameHousePeers[0] || null;
  const extraFees = Array.isArray(row.extra_fees) ? row.extra_fees : parseJson(row.extra_fees, []);
  const source = String(row.source || "591") || "591";
  const decoratedSelf = {
    ...row,
    extra_fees: extraFees,
    source,
    source_label: row.source_label || selfSourceLabel(source),
  };
  const same_house = (row.match_verdict === "no" || Number(row.match_rejected) === 1 || splitFromMatch)
    ? null
    : sameHouseBundle(decoratedSelf, sameHousePeers);
  if (same_house && voteUserId && personalGroupKeyFor(db, voteUserId, selfId)) {
    same_house.personal_only = true;
    same_house.system_agrees = personalGroupAgrees(db, voteUserId, selfId);
    if (!same_house.system_agrees) same_house.status = "personal";
  }
  return { ...row, match_peer: matchPeer || null, same_house };
}

function finalizeListingDecorate(row, settings, userId, { sameHouse = true, matchVoteUserId } = {}) {
  if (!row) return row;
  settings = settings || getSettings();
  const uid = Number(userId) || 0;
  const voteUid = matchVoteUserId == null ? uid : Number(matchVoteUserId) || 0;
  const listedBy = Number(row.listed_by_user_id) || 0;
  const extraFees = Array.isArray(row.extra_fees) ? row.extra_fees : parseJson(row.extra_fees, []);
  const source = String(row.source || "591") || "591";
  const withPeers = sameHouse
    ? attachListingPeers({ ...row, extra_fees: extraFees, source, source_label: row.source_label || selfSourceLabel(source) }, settings, voteUid)
    : { ...row, extra_fees: extraFees, source, source_label: row.source_label || selfSourceLabel(source), match_peer: null, same_house: null };
  const {
    listed_by_user_id: _listedBy,
    model_score: _modelScore,
    ...publicRow
  } = withPeers;
  return {
    ...publicRow,
    extra_fees: extraFees,
    cost_change: costChangePayload(row),
    source,
    source_label: withPeers.source_label,
    self_body: String(row.self_body || ""),
    photos: listingPhotoUrls(row),
    mine: uid > 0 && listedBy === uid,
    ...mrtFields(row, settings),
  };
}

function decorateListing(row, settings, userId, options = {}) {
  if (!row) return row;
  settings = settings || getSettings();
  return finalizeListingDecorate(decorateListingLite(row, settings, userId), settings, userId, options);
}

function resolveUserId(userId) {
  return userId == null ? defaultUserId() : Number(userId) || defaultUserId();
}

function withPersonal(row, userId) {
  if (!row) return row;
  return overlayPersonal(row, loadFlags(db, resolveUserId(userId), row.post_id));
}

export function getListing(postId, userId, options = {}) {
  const row = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(postId);
  if (!row) return row;
  const uid = resolveUserId(userId);
  return decorateListing(withPersonal(row, uid), getSettings(uid), uid, options);
}

export function findBySourceKey(sourceKey, excludePostId) {
  const anyone = loadAnyoneFlagMap(db);
  return db
    .prepare(
      "SELECT * FROM listings WHERE source_key = ? AND post_id != ? ORDER BY last_seen_at DESC",
    )
    .all(sourceKey, excludePostId)
    .map((row) => overlayPersonal(row, anyone.get(Number(row.post_id))));
}

function sqlWatchedFirst() {
  return `CASE WHEN EXISTS (
    SELECT 1 FROM user_listing_flags f WHERE f.post_id = listings.post_id AND f.watched = 1
  ) THEN 0 ELSE 1 END`;
}

export function listMatchCandidates(excludePostId, incoming = null) {
  const anyone = loadAnyoneFlagMap(db);
  const pid = Number(excludePostId) || 0;
  const hints = incoming ? matchFocusHints(incoming) : { street: "", community: "", cover: "" };
  const rows = hints.street || hints.community || hints.cover
    ? db.prepare(
      `SELECT * FROM listings
       WHERE post_id != ?
         AND (
           (? != '' AND replace(replace(IFNULL(address, ''), ' ', ''), '-', '') LIKE '%' || ? || '%')
           OR (? != '' AND IFNULL(community_name, '') = ?)
           OR (? != '' AND IFNULL(cover, '') != '' AND IFNULL(cover, '') = ?)
         )
       ORDER BY ${sqlWatchedFirst()}, IFNULL(offline, 0) DESC, last_seen_at DESC
       LIMIT 400`,
    ).all(pid, hints.street, hints.street, hints.community, hints.community, hints.cover, hints.cover)
    : db.prepare(
      `SELECT * FROM listings
       WHERE post_id != ?
       ORDER BY ${sqlWatchedFirst()}, IFNULL(offline, 0) DESC, hidden DESC, viewed DESC, last_seen_at DESC
       LIMIT 800`,
    ).all(pid);
  return rows.map((row) => overlayPersonal(row, anyone.get(Number(row.post_id))));
}

export function setListingMatch(postId, match) {
  db.prepare(
    `UPDATE listings
     SET match_post_id = ?, match_level = ?, match_detail = ?, match_rejected = 0
     WHERE post_id = ?`,
  ).run(match.match_post_id || null, match.match_level || null, match.match_detail || "", postId);
  if (match.match_post_id) {
    const a = getListing(postId);
    const b = getListing(match.match_post_id);
    if (a && b) {
      try {
        bindListingsToGroup(db, [a, b], {
          evidence: match.evidence || { detail: match.match_detail || "" },
          confidence: match.match_level === "high" ? 0.9 : 0.7,
        });
      } catch {
        // isolated tests without group tables
      }
    }
  }
  return getListing(postId);
}

function countPairVotes(lo, hi) {
  const rows = db.prepare(
    `SELECT vote, COUNT(DISTINCT user_id) AS n
     FROM user_match_votes
     WHERE post_id = ? AND peer_id = ?
     GROUP BY vote`,
  ).all(lo, hi);
  const out = { split: 0, same: 0 };
  for (const row of rows) {
    if (row.vote === "split") out.split = Number(row.n) || 0;
    if (row.vote === "keep" || row.vote === "same") out.same = Number(row.n) || 0;
  }
  return out;
}

function dayStartIso(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

export function rejectSuspectedMatch(postId, userId, { peerId } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) {
    return { ok: false, code: "guest", error: "請先登入才能拆開同屋源" };
  }
  const listing = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(postId);
  if (!listing) return { ok: false, code: "not_found", error: "找不到這筆物件" };

  let otherId = Number(peerId) || Number(listing.match_post_id) || 0;
  if (!otherId) {
    const incoming = db.prepare(
      `SELECT post_id FROM listings
       WHERE match_post_id = ? AND IFNULL(match_verdict, '') != 'no'
       LIMIT 1`,
    ).get(postId);
    otherId = Number(incoming?.post_id) || 0;
  }
  if (!otherId || otherId === Number(postId)) {
    return { ok: false, code: "no_peer", error: "找不到要拆開的同屋源" };
  }

  const [lo, hi] = votePair(postId, otherId);
  const existing = db.prepare(
    `SELECT vote FROM user_match_votes WHERE user_id = ? AND post_id = ? AND peer_id = ?`,
  ).get(uid, lo, hi);
  const used = Number(db.prepare(
    `SELECT COUNT(*) AS n FROM user_match_votes
     WHERE user_id = ? AND vote = 'split' AND created_at >= ?`,
  ).get(uid, dayStartIso())?.n) || 0;
  if (existing?.vote !== "split" && used >= MATCH_SPLIT_DAILY_LIMIT) {
    return {
      ok: false,
      code: "rate_limit",
      error: "今天拆開次數已達上限。請先看展開列的差異再決定，明天再試。",
    };
  }

  const now = new Date().toISOString();
  if (existing?.vote !== "split") {
    const peer = db.prepare("SELECT match_level FROM listings WHERE post_id = ?").get(otherId);
    db.prepare(
      `INSERT INTO user_match_votes (user_id, post_id, peer_id, vote, confidence, created_at, updated_at)
       VALUES (?, ?, ?, 'split', ?, ?, ?)
       ON CONFLICT(user_id, post_id, peer_id) DO UPDATE SET
         vote = 'split',
         confidence = excluded.confidence,
         updated_at = excluded.updated_at`,
    ).run(uid, lo, hi, pairConfidence(listing, peer), now, now);
    db.prepare(
      `INSERT INTO user_match_signals (user_id, post_id, peer_id, type, weight, created_at)
       VALUES (?, ?, ?, 'split', 1, ?)`,
    ).run(uid, lo, hi, now);
    addUserEvent({
      user_id: uid,
      post_id: Number(postId),
      type: "match_split",
      title: listing.title || `刊登 #${postId}`,
      detail: `個人拆開 #${postId} 與 #${otherId}`,
      source_key: listing.source_key || "",
      created_at: now,
      notified: 1,
    });
    try { splitPersonalSameHouse(db, uid, postId, otherId); } catch { /* 個人併入表可能尚未建立 */ }
  }

  const peer = db.prepare("SELECT match_level FROM listings WHERE post_id = ?").get(otherId);
  const tally = countPairVotes(lo, hi);
  const promoted = shouldPromoteGlobalSplit({
    ...tally,
    confidence: pairConfidence(listing, peer),
  });
  if (promoted) {
    db.prepare(
      `UPDATE listings
       SET match_verdict = 'no', match_rejected = 1, hidden = 0
       WHERE post_id IN (?, ?)`,
    ).run(lo, hi);
  }

  return {
    ok: true,
    listing: getListing(postId, uid),
    personal: true,
    promoted,
    remaining: Math.max(0, MATCH_SPLIT_DAILY_LIMIT - (existing?.vote === "split" ? used : used + 1)),
    already: existing?.vote === "split",
  };
}

export function mergeSameHouseForUser(userId, postIds) {
  const ids = normalizeMergeIds(postIds);
  const listings = ids
    .map((id) => db.prepare("SELECT * FROM listings WHERE post_id = ?").get(id))
    .filter(Boolean);
  const result = mergePersonalSameHouse(db, userId, listings);
  if (!result.ok) return result;
  return {
    ...result,
    listing: getListing(ids[0], userId),
  };
}

/** 舊 API 改走個人併入，不再寫全站 match_verdict，避免把使用者判斷分享出去。 */
export function confirmSuspectedMatch(postId, userId) {
  const listing = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(postId);
  if (!listing) return null;
  const peerId = Number(listing.match_post_id) || 0;
  if (!peerId) return null;
  const result = mergeSameHouseForUser(userId, [postId, peerId]);
  return result?.ok ? result.listing : null;
}

export function coveringJobsFromAllUsers(opts = {}) {
  return coveringPlan(opts).jobs;
}

export function coveringPlan({ now = Date.now(), includeSystem = true } = {}) {
  const covers = [];
  const includedUserIds = [];
  const postponedUserIds = [];
  const lastCoveringAt = getLastCoveringAt();
  if (includeSystem) {
    const system = getSystemCrawl();
    covers.push(...coversFromWatchDistricts({ watchDistricts: system.watchDistricts }));
  }
  for (const id of listUserIds()) {
    const settings = getSettings(id);
    if (settings.notificationsPaused === true || !memberHasCrawlScope(settings)) continue;
    if (memberFetchCollision(settings, { now, lastCoveringAt })) {
      armMemberExternalFetch(id, { from: now });
      postponedUserIds.push(id);
      continue;
    }
    if (!memberShouldContributeCrawl(settings, { now, lastCoveringAt })) continue;
    const memberCovers = coversFromMemberSettings(settings);
    if (!memberCovers.length) continue;
    covers.push(...memberCovers);
    includedUserIds.push(id);
  }
  const jobs = covers.length ? coveringJobsFromMembers(covers, { excludeRooftop: false }) : [];
  return { jobs, includedUserIds, postponedUserIds, includeSystem };
}

export function armMemberExternalFetch(userId, { from = Date.now() } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return getSettings(uid);
  const current = getSettings(uid);
  if (current.notificationsPaused === true) {
    if (current.memberFetchDueAt) return saveSettings({ memberFetchDueAt: "" }, uid);
    return current;
  }
  const minutes = planIntervalMinutes(getUserById(uid)?.plan);
  const due = new Date(Number(from) + minutes * 60 * 1000).toISOString();
  return saveSettings({ memberFetchDueAt: due }, uid);
}

function getLastCoveringAt() {
  return String(settingKey("lastCoveringAt") || "");
}

function getLastSystemCoveringAt() {
  return String(settingKey("lastSystemCoveringAt") || "");
}

export function isSystemCoveringDue(now = Date.now()) {
  const last = Date.parse(getLastSystemCoveringAt());
  if (!Number.isFinite(last)) return true;
  return now - last >= crawlIntervalMinutes() * 60 * 1000;
}

export function markCoveringCompleted({
  includedUserIds = [],
  includeSystem = false,
  at = new Date().toISOString(),
} = {}) {
  writeSettingKey("lastCoveringAt", at);
  if (includeSystem) writeSettingKey("lastSystemCoveringAt", at);
  const from = Date.parse(at) || Date.now();
  for (const id of includedUserIds) {
    armMemberExternalFetch(id, { from });
  }
}

// 此使用者「自己設定」的行政區名稱集合（watchDistricts 的核取方塊 ∪ 貼上的 591 搜尋網址所含區）。
// 用於把預設列表（未點特定行政區時）限縮在使用者自己的區域，避免看到共用池裡別人/系統抓的其它縣市。
export function memberRegionDistrictNames(settings = {}) {
  const keys = new Set([
    ...normalizeWatchDistricts(settings.watchDistricts),
    ...districtsFromSearchUrls(settings.searchUrls),
  ]);
  const names = [];
  for (const key of keys) {
    const name = lookupDistrict(key)?.name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function currentSearchKeys() {
  const urls = [];
  for (const id of listUserIds()) {
    urls.push(...(getSettings(id).searchUrls || []));
  }
  urls.push(...(getSettings().searchUrls || []));
  const coverUrls = coveringJobsFromMembers(listCrawlCovers(db), {
    excludeRooftop: false,
  }).map((job) => job.searchUrl);
  return [...new Set([...urls, ...coverUrls].map((url) => String(url || "").trim()).filter(Boolean))];
}

let searchKeyMemo = { at: 0, stored: null };

function invalidateSearchKeyMemo() {
  searchKeyMemo = { at: 0, stored: null };
}

function expandSearchKeys(keys) {
  if (!keys?.length) return keys;
  const now = Date.now();
  let stored = searchKeyMemo.stored;
  if (!stored || now - searchKeyMemo.at > 8000) {
    stored = db
      .prepare("SELECT DISTINCT search_key FROM listings")
      .all()
      .map((row) => row.search_key)
      .filter(Boolean);
    searchKeyMemo = { at: now, stored };
  }
  const out = new Set(keys);
  for (const key of stored) {
    if (keys.some((url) => sameSearch(url, key))) out.add(key);
  }
  return [...out];
}

function searchWhere(searchKeys, clauses, params) {
  const keys = expandSearchKeys(searchKeys === undefined ? currentSearchKeys() : searchKeys);
  if (keys?.length) {
    clauses.push(`(
      search_key IN (${keys.map(() => "?").join(",")})
      OR COALESCE(source, '591') = 'self'
    )`);
    params.push(...keys);
  }
}

function listingVisibilityClauses(clauses, params) {
  // The expiry predicate below is sufficient for reads. An UPDATE here would
  // wait up to busy_timeout for a crawler/importer even when no row expires.
  const stamp = new Date().toISOString();
  const openSelf = sqlOpenSelfListing(stamp);
  clauses.push(openSelf.sql);
  params.push(...openSelf.params);
  const disabled = (getCrawlSources().items || [])
    .filter((row) => !row.enabled)
    .map((row) => row.id);
  if (disabled.length) {
    clauses.push(`COALESCE(source, '591') NOT IN (${disabled.map(() => "?").join(",")})`);
    params.push(...disabled);
  }
}

export function upsertListing(listing) {
  const extraFees =
    typeof listing.extra_fees === "string"
      ? listing.extra_fees
      : JSON.stringify(listing.extra_fees || []);
  const communityId = Number(listing.community_id) || listingCommunityId(listing) || 0;
  const communityName = String(listing.community_name || "").trim();
  const communityLinked = sourceCommunityLinked({
    communityId,
    hasAnchor: Number(listing.community_linked) === 1,
  }) ? 1 : 0;
  const costChangedAt = String(listing.cost_changed_at || "").trim();
  const costChangeType = String(listing.cost_change_type || "").trim();
  const costChangeDetail = String(listing.cost_change_detail || "").trim();
  let existing = null;
  try {
    existing = db.prepare("SELECT address, geo_source, floor_name, has_natural_gas, has_balcony, furnish_items FROM listings WHERE post_id = ?").get(listing.post_id);
  } catch {
    existing = db.prepare("SELECT address, geo_source, floor_name FROM listings WHERE post_id = ?").get(listing.post_id);
  }
  const address = preferListingAddress(listing.address, existing?.address, existing?.geo_source);
  const floorName = sanitizeFloorName(listing.floor_name) || sanitizeFloorName(existing?.floor_name) || "";
  db.prepare(`
    INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num, extra_fee, extra_fee_text,
      price_contain_text, extra_fees, extra_fees_fetched, address, area_name,
      layout, floor_name, kind_name, role_name, cover, tags, refresh_time,
      first_seen_at, last_seen_at, last_event, viewed, watched, lat, lng,
      community_id, community_name, community_linked, cost_changed_at, cost_change_type, cost_change_detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      source_key = excluded.source_key,
      search_key = excluded.search_key,
      title = excluded.title,
      url = excluded.url,
      price = CASE WHEN IFNULL(excluded.price, '') != '' THEN excluded.price ELSE listings.price END,
      price_num = CASE WHEN excluded.price_num > 0 THEN excluded.price_num ELSE listings.price_num END,
      extra_fee = excluded.extra_fee,
      extra_fee_text = CASE WHEN IFNULL(excluded.extra_fee_text, '') != '' THEN excluded.extra_fee_text ELSE listings.extra_fee_text END,
      price_contain_text = CASE WHEN IFNULL(excluded.price_contain_text, '') != '' THEN excluded.price_contain_text ELSE listings.price_contain_text END,
      extra_fees = CASE
        WHEN listings.extra_fees_fetched = 1 AND IFNULL(listings.extra_fees, '') NOT IN ('', '[]')
        THEN listings.extra_fees
        ELSE excluded.extra_fees
      END,
      address = CASE
        WHEN IFNULL(excluded.address, '') != '' THEN excluded.address
        ELSE listings.address
      END,
      area_name = CASE WHEN IFNULL(excluded.area_name, '') != '' THEN excluded.area_name ELSE listings.area_name END,
      layout = CASE WHEN IFNULL(excluded.layout, '') != '' THEN excluded.layout ELSE listings.layout END,
      floor_name = CASE WHEN IFNULL(excluded.floor_name, '') != '' THEN excluded.floor_name ELSE listings.floor_name END,
      kind_name = CASE WHEN IFNULL(excluded.kind_name, '') != '' THEN excluded.kind_name ELSE listings.kind_name END,
      role_name = CASE WHEN IFNULL(excluded.role_name, '') != '' THEN excluded.role_name ELSE listings.role_name END,
      cover = CASE WHEN IFNULL(excluded.cover, '') != '' THEN excluded.cover ELSE listings.cover END,
      tags = excluded.tags,
      refresh_time = CASE WHEN IFNULL(excluded.refresh_time, '') != '' THEN excluded.refresh_time ELSE listings.refresh_time END,
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
        WHEN ${sqlTrustedGeoSource("listings.geo_source")} THEN listings.lat
        ELSE COALESCE(excluded.lat, listings.lat)
      END,
      lng = CASE
        WHEN ${sqlTrustedGeoSource("listings.geo_source")} THEN listings.lng
        ELSE COALESCE(excluded.lng, listings.lng)
      END,
      community_id = CASE
        WHEN excluded.community_id > 0 THEN excluded.community_id
        ELSE listings.community_id
      END,
      community_name = CASE
        WHEN IFNULL(excluded.community_name, '') != '' THEN excluded.community_name
        ELSE listings.community_name
      END,
      community_linked = CASE
        WHEN excluded.community_linked > 0 OR excluded.community_id > 0 THEN 1
        ELSE listings.community_linked
      END,
      cost_changed_at = CASE
        WHEN IFNULL(excluded.cost_changed_at, '') != '' THEN excluded.cost_changed_at
        ELSE listings.cost_changed_at
      END,
      cost_change_type = CASE
        WHEN IFNULL(excluded.cost_change_type, '') != '' THEN excluded.cost_change_type
        ELSE listings.cost_change_type
      END,
      cost_change_detail = CASE
        WHEN IFNULL(excluded.cost_change_detail, '') != '' THEN excluded.cost_change_detail
        ELSE listings.cost_change_detail
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
    address,
    listing.area_name,
    listing.layout,
    floorName,
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
    communityLinked,
    costChangedAt,
    costChangeType,
    costChangeDetail,
  );
  invalidateSearchKeyMemo();
  const origin = String(listing.source || "591").trim() || "591";
  const originId = String(listing.source_id || listing.post_id || "").trim() || String(listing.post_id);
  try {
    db.prepare("UPDATE listings SET source = ?, source_id = COALESCE(NULLIF(source_id, ''), ?) WHERE post_id = ?")
      .run(origin, originId, listing.post_id);
  } catch {
    // ignore
  }
  const kit = mergeKitColumns(existing || {}, listingKitFrom({
    ...listing,
    tags: listing.tags,
  }));
  try {
    db.prepare(`
      UPDATE listings
         SET has_natural_gas = ?,
             has_balcony = ?,
             furnish_items = ?
       WHERE post_id = ?
    `).run(
      kit.has_natural_gas,
      kit.has_balcony,
      JSON.stringify(kit.furnish_items),
      listing.post_id,
    );
  } catch {
    // older isolated fixtures without kit columns
  }
  const geoSource = String(listing.geo_source || "").trim();
  if (geoSource) {
    try {
      db.prepare(
        "UPDATE listings SET geo_source = COALESCE(NULLIF(geo_source, ''), ?) WHERE post_id = ?",
      ).run(geoSource, listing.post_id);
    } catch {
      // ignore
    }
  }
}

export function setListingFees(postId, extraFees, fetched = 1) {
  return setListingDetail(postId, { extraFees, fetched });
}

function preferFilledContact(next, prev) {
  const incoming = String(next ?? "").trim();
  return incoming || String(prev ?? "").trim();
}

function contactPayloadHasValue(contact) {
  if (!contact || typeof contact !== "object") return false;
  return [
    contact.contact_name,
    contact.contact_role,
    contact.agency,
    contact.mobile,
    contact.phone,
    contact.line_url,
    contact.avatar,
    contact.contact_uid,
  ].some((value) => String(value ?? "").trim() !== "");
}

export function setListingDetail(postId, { extraFees, contact, fetched = 1, lat, lng, address, community_id, community_name, community_linked, geo_source, has_natural_gas, has_balcony, furnish_items, kit_fetched } = {}) {
  const listing = getListing(postId);
  if (!listing) return null;
  const fees =
    extraFees === undefined
      ? JSON.stringify(listing.extra_fees || [])
      : JSON.stringify(extraFees || []);
  const next = {
    contact_name: preferFilledContact(contact?.contact_name, listing.contact_name),
    contact_role: preferFilledContact(contact?.contact_role, listing.contact_role),
    agency: preferFilledContact(contact?.agency, listing.agency),
    mobile: preferFilledContact(contact?.mobile, listing.mobile),
    phone: preferFilledContact(contact?.phone, listing.phone),
    line_url: preferFilledContact(contact?.line_url, listing.line_url),
    avatar: preferFilledContact(contact?.avatar, listing.avatar),
    contact_uid: contact?.contact_uid || listing.contact_uid || null,
  };
  const latNum = Number(lat);
  const lngNum = Number(lng);
  const hasCoords = Number.isFinite(latNum) && Number.isFinite(lngNum) && latNum !== 0 && lngNum !== 0;
  const upgradingToCommunity = hasCoords && geo_source === "community";
  const keepCommunity = listing.geo_source === "community" && !upgradingToCommunity;
  const applyCoords = hasCoords && !keepCommunity;
  const source = applyCoords ? (geo_source === "community" ? "community" : "591") : null;
  const nextAddress = preferListingAddress(address, listing.address, listing.geo_source);
  const keepAddress = !String(address || "").trim();
  const nextCommunityId = Number(community_id) || listing.community_id || 0;
  const nextCommunityName = String(community_name || listing.community_name || "").trim();
  const nextCommunityLinked = sourceCommunityLinked({
    communityId: nextCommunityId,
    hasAnchor: Number(community_linked) === 1 || Number(listing.community_linked) === 1,
  }) ? 1 : Number(listing.community_linked) || 0;
  // 有實際帶入非空聯絡資料（非只補社區座標／空字串）才更新 contact_fetched_at。
  const contactRefreshed = Boolean(fetched) && contactPayloadHasValue(contact);
  const contactStamp = new Date().toISOString();
  db.prepare(
    `UPDATE listings SET
      extra_fees = ?, extra_fees_fetched = ?,
      contact_name = ?, contact_role = ?, agency = ?, mobile = ?, phone = ?,
      line_url = ?, avatar = ?, contact_uid = ?, contact_fetched = ?,
      contact_fetched_at = CASE WHEN ? = 1 THEN ? ELSE contact_fetched_at END,
      lat = CASE WHEN ? IS NOT NULL THEN ? ELSE lat END,
      lng = CASE WHEN ? IS NOT NULL THEN ? ELSE lng END,
      geo_source = CASE WHEN ? IS NOT NULL THEN ? ELSE geo_source END,
      address = CASE WHEN ? THEN listings.address ELSE ? END,
      community_id = CASE WHEN ? > 0 THEN ? ELSE community_id END,
      community_name = CASE WHEN ? != '' THEN ? ELSE community_name END,
      community_linked = CASE WHEN ? > 0 THEN 1 ELSE community_linked END
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
    contactRefreshed ? 1 : 0,
    contactRefreshed ? contactStamp : null,
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
    nextCommunityLinked,
    postId,
  );
  try {
    const kit = mergeKitColumns(listing, listingKitFrom({
      ...listing,
      has_natural_gas: has_natural_gas ?? listing.has_natural_gas,
      has_balcony: has_balcony ?? listing.has_balcony,
      furnish_items: furnish_items ?? listing.furnish_items,
      kit_complete: Number(kit_fetched) === 1,
    }));
    db.prepare(`
      UPDATE listings
         SET has_natural_gas = ?,
             has_balcony = ?,
             furnish_items = ?,
             kit_fetched = CASE WHEN ? = 1 THEN 1 ELSE kit_fetched END,
             kit_error = CASE WHEN ? = 1 THEN NULL ELSE kit_error END,
             kit_next_retry_at = CASE WHEN ? = 1 THEN NULL ELSE kit_next_retry_at END
       WHERE post_id = ?
    `).run(
      kit.has_natural_gas,
      kit.has_balcony,
      JSON.stringify(kit.furnish_items),
      Number(kit_fetched) === 1 ? 1 : 0,
      Number(kit_fetched) === 1 ? 1 : 0,
      Number(kit_fetched) === 1 ? 1 : 0,
      postId,
    );
  } catch {
    // older isolated fixtures without kit columns
  }
  if (
    extraFees !== undefined
    && Number(listing.extra_fees_fetched) === 1
    && feeSignature(listing) !== feeSignature({ ...listing, extra_fees: extraFees })
  ) {
    const stamp = new Date().toISOString();
    const detail = feeChangeDetail(listing, { ...listing, extra_fees: extraFees });
    db.prepare(
      `UPDATE listings
       SET cost_changed_at = ?, cost_change_type = 'fee_update', cost_change_detail = ?, last_event = 'update'
       WHERE post_id = ?`,
    ).run(stamp, detail, postId);
    const saved = getListing(postId);
    if (saved) enqueueListingEvent(saved, { type: "fee_update", detail, created_at: stamp });
  }
  if (applyCoords) {
    applyListingLocation(postId, {
      lat: latNum,
      lng: lngNum,
      geo_source: source,
      location_class: source === "community" ? "community" : "source",
      coord_version: Date.now(),
      geo_job_state: "done",
    });
  }
  return getListing(postId);
}

// 聯絡資料過期重抓：591 刊登可能換仲介／換電話，但我們只抓過一次就快取。
// 用最低優先序、且每輪硬上限 CONTACT_REFRESH_CAP 筆補抓，總量不超過原本的明細補抓預算，避免加重 591 負載。
const CONTACT_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const CONTACT_REFRESH_CAP = 6;

export function listingsNeedingFeeDetail(limit = 12) {
  const cap = Math.max(1, Number(limit) || 12);
  const needy = db
    .prepare(
      `SELECT post_id FROM listings
       WHERE IFNULL(hidden, 0) = 0 AND IFNULL(offline, 0) = 0
         AND ${sql591Source()} AND (
         IFNULL(contact_fetched, 0) = 0
         OR IFNULL(extra_fees_fetched, 0) = 0
         OR IFNULL(kit_fetched, 0) = 0
         OR lat IS NULL OR lng IS NULL
       )
       ORDER BY CASE WHEN lat IS NULL OR lng IS NULL THEN 0 ELSE 1 END, last_seen_at DESC
       LIMIT ?`,
    )
    .all(cap);
  if (needy.length >= cap) return needy;
  // 只用剩餘預算補「聯絡資料過期」的線上 591 物件（最舊的先），且不超過小上限。
  const room = Math.min(cap - needy.length, CONTACT_REFRESH_CAP);
  if (room <= 0) return needy;
  const staleBefore = new Date(Date.now() - CONTACT_REFRESH_MS).toISOString();
  const seen = new Set(needy.map((r) => Number(r.post_id)));
  const stale = db
    .prepare(
      `SELECT post_id FROM listings
       WHERE IFNULL(hidden, 0) = 0 AND IFNULL(offline, 0) = 0
         AND ${sql591Source()}
         AND IFNULL(contact_fetched, 0) = 1
         AND IFNULL(contact_fetched_at, '') < ?
       ORDER BY IFNULL(contact_fetched_at, '') ASC
       LIMIT ?`,
    )
    .all(staleBefore, room + needy.length);
  const out = [...needy];
  for (const r of stale) {
    if (out.length >= needy.length + room) break;
    if (!seen.has(Number(r.post_id))) out.push(r);
  }
  return out;
}

export function listingsNeedingSourceKit(limit = 8) {
  const cap = Math.max(1, Number(limit) || 8);
  const sources = ["hbhousing", "sinyi", "housefun", "rakuya"];
  const now = new Date().toISOString();
  const perSource = Math.max(1, Math.ceil(cap / sources.length));
  const out = [];
  const seen = new Set();
  for (const source of sources) {
    let rows = [];
    try {
      rows = db
        .prepare(
          `SELECT post_id, source, source_id, url FROM listings
           WHERE IFNULL(hidden, 0) = 0 AND IFNULL(offline, 0) = 0
             AND source = ?
             AND IFNULL(kit_fetched, 0) = 0
             AND (kit_next_retry_at IS NULL OR kit_next_retry_at <= ?)
           ORDER BY ${sqlWatchedFirst()}, last_seen_at DESC
           LIMIT ?`,
        )
        .all(source, now, perSource);
    } catch {
      rows = db
        .prepare(
          `SELECT post_id, source, source_id, url FROM listings
           WHERE IFNULL(hidden, 0) = 0 AND IFNULL(offline, 0) = 0
             AND source = ?
             AND IFNULL(kit_fetched, 0) = 0
           ORDER BY last_seen_at DESC
           LIMIT ?`,
        )
        .all(source, perSource);
    }
    for (const row of rows) {
      if (seen.has(row.post_id) || out.length >= cap) continue;
      seen.add(row.post_id);
      out.push(row);
    }
  }
  return out;
}

export function markSourceKitRetry(postId, { error = "", delayMs = 15 * 60 * 1000 } = {}) {
  const next = new Date(Date.now() + Math.max(60_000, Number(delayMs) || 0)).toISOString();
  try {
    db.prepare(
      `UPDATE listings
          SET kit_error = ?, kit_next_retry_at = ?
        WHERE post_id = ?`,
    ).run(String(error || "").slice(0, 200), next, postId);
    return true;
  } catch {
    return false;
  }
}

export function listingsNeeding591Geo(limit = 20) {
  const cap = Math.max(1, Number(limit) || 20);
  const rows = db
    .prepare(
      `SELECT post_id, community_id, source_key, lat, lng, geo_source FROM listings
       WHERE IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
         AND ${sql591Source()}
       ORDER BY ${sqlWatchedFirst()}, last_seen_at DESC`,
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

/** 該物件是否已有可信座標（供外站爬蟲跳過已定位者，把補明細的預算留給還沒座標的物件）。 */
export function listingHasTrustedGeo(postId) {
  const row = db.prepare("SELECT lat, lng, geo_source FROM listings WHERE post_id = ?").get(Number(postId));
  return !!row && row.lat != null && row.lng != null && isTrustedGeoSource(row.geo_source);
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

// 探測確認「還在」：打上 alive_checked_at（供 30 分鐘全站鎖）＋ last_checked_at；若原本 offline 則回復上架。
export function markListingAlive(postId) {
  const listing = getListing(postId);
  if (!listing) return null;
  const now = new Date().toISOString();
  const wasOffline = Number(listing.offline) === 1;
  db.prepare(
    `UPDATE listings
     SET alive_checked_at = ?,
         last_checked_at = ?,
         offline = CASE WHEN offline = 1 THEN 0 ELSE offline END,
         offline_at = CASE WHEN offline = 1 THEN NULL ELSE offline_at END,
         offline_confirmed = 0
     WHERE post_id = ?`,
  ).run(now, now, postId);
  return { listing: getListing(postId), restored: wasOffline };
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
         AND ${sqlNotSelfSource()}
       ORDER BY ${sqlWatchedFirst()},
                CASE WHEN last_checked_at IS NULL THEN 0 ELSE 1 END,
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
         AND ${sqlNotSelfSource()}
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
  const id = Number(result.lastInsertRowid);
  if (event.group_id || event.notify_profile_id) {
    try {
      db.prepare("UPDATE user_events SET group_id = ?, notify_profile_id = ?, notify_profile_version = ? WHERE id = ?")
        .run(event.group_id || "", event.notify_profile_id || "", Number(event.notify_profile_version) || 0, id);
    } catch {
      // older fixtures
    }
  }
  return id;
}

export function addEvent(event, userId) {
  const uid = userId == null ? defaultUserId() : Number(userId) || defaultUserId();
  return addUserEvent({ ...event, user_id: uid });
}

export function markEventNotified(id) {
  db.prepare("UPDATE user_events SET notified = 1 WHERE id = ?").run(id);
}

const notifyJobByUser = new Map();

export function bindNotifyJobSnapshots(now = new Date()) {
  notifyJobByUser.clear();
  for (const uid of listUserIds()) {
    try {
      const row = getActiveSearchProfile(db, uid);
      notifyJobByUser.set(Number(uid), {
        ...notifySnapshotFromProfile(row),
        bound_at: (now instanceof Date ? now : new Date(now)).toISOString(),
      });
    } catch {
      notifyJobByUser.set(Number(uid), notifySnapshotFromProfile(null));
    }
  }
  return notifyJobByUser.size;
}

export function notifyJobSnapshotFor(userId) {
  const uid = Number(userId);
  if (notifyJobByUser.has(uid)) return notifyJobByUser.get(uid);
  try {
    return notifySnapshotFromProfile(getActiveSearchProfile(db, uid));
  } catch {
    return notifySnapshotFromProfile(null);
  }
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
    const snap = notifyJobSnapshotFor(userId);
    const scoped = snap.data && Object.keys(snap.data).length
      ? { ...settings, ...snap.data }
      : settings;
    const row = decorateListing(overlayPersonal(listing, loadFlags(db, userId, listing.post_id)), scoped, userId, { sameHouse: false });
    let groupId = "";
    try { groupId = groupIdForPost(db, payload.post_id); } catch { groupId = ""; }
    const watched = Number(row.watched) === 1 || Boolean(groupId && watchedInGroup(db, userId, groupId));
    if (!watched && event.type === "new" && !listingInMemberScope(row, scoped)) continue;
    if (!shouldDeliverNotify(scoped, row, event, {
      to: getUserById(userId)?.email,
      configured: getMemberMailBundle(userId).configured,
    })) continue;
    if (groupId && alreadyNotifiedGroup(db, userId, groupId, payload.type, payload.detail)) continue;
    if (payload.type === "new") {
      const alreadyNew = db.prepare(
        "SELECT id FROM user_events WHERE user_id = ? AND post_id = ? AND type = 'new' LIMIT 1",
      ).get(userId, payload.post_id);
      if (alreadyNew) continue;
    }
    const last = db.prepare(
      "SELECT detail FROM user_events WHERE user_id = ? AND post_id = ? AND type = ? ORDER BY id DESC LIMIT 1",
    ).get(userId, payload.post_id, payload.type);
    if (last && isSameNotifyDetail(last.detail, payload.detail)) continue;
    ids.push(addUserEvent({
      ...payload,
      user_id: userId,
      group_id: groupId,
      notify_profile_id: snap.notify_profile_id || "",
      notify_profile_version: snap.notify_profile_version || 0,
    }));
  }
  return ids;
}

export function getSystemCrawl() {
  const stored = parseSettingRows(db.prepare("SELECT key, value FROM settings").all());
  const intervalRaw = Number(stored.systemCrawlIntervalMinutes);
  return {
    watchDistricts: normalizeWatchDistricts(stored.systemWatchDistricts),
    intervalMinutes: Number.isFinite(intervalRaw) && intervalRaw > 0
      ? clampIntervalMinutes(intervalRaw, { admin: true, fallback: SYSTEM_CRAWL_INTERVAL_MINUTES })
      : SYSTEM_CRAWL_INTERVAL_MINUTES,
    showMrt: stored.systemShowMrt !== false,
    showListRefreshBar: stored.systemShowListRefreshBar === true,
    cities: CITIES,
  };
}

export function saveSystemCrawl(partial = {}) {
  const current = getSystemCrawl();
  const watchDistricts = Object.prototype.hasOwnProperty.call(partial, "watchDistricts")
    ? normalizeWatchDistricts(partial.watchDistricts)
    : current.watchDistricts;
  const intervalMinutes = Object.prototype.hasOwnProperty.call(partial, "intervalMinutes")
    ? clampIntervalMinutes(partial.intervalMinutes, { admin: true, fallback: current.intervalMinutes })
    : current.intervalMinutes;
  const upsert = db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const showMrt = Object.prototype.hasOwnProperty.call(partial, "showMrt")
    ? partial.showMrt !== false
    : current.showMrt !== false;
  const showListRefreshBar = Object.prototype.hasOwnProperty.call(partial, "showListRefreshBar")
    ? partial.showListRefreshBar === true
    : current.showListRefreshBar === true;
  upsert.run("systemWatchDistricts", JSON.stringify(watchDistricts));
  upsert.run("systemCrawlIntervalMinutes", JSON.stringify(intervalMinutes));
  upsert.run("systemShowMrt", JSON.stringify(showMrt));
  upsert.run("systemShowListRefreshBar", JSON.stringify(showListRefreshBar));
  const next = getSystemCrawl();
  next.catalog = refreshSiteCatalogStats();
  return next;
}

export function crawlIntervalMinutes() {
  return Math.max(1, Number(getSystemCrawl().intervalMinutes) || SYSTEM_CRAWL_INTERVAL_MINUTES);
}

export function listingsNeedingAddressGeo(limit = 20) {
  const cap = Math.max(1, Number(limit) || 20);
  const rows = db
    .prepare(
      `SELECT post_id, address, lat, lng, geo_source
       FROM listings
       WHERE IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
         AND IFNULL(address, '') != ''
       ORDER BY ${sqlWatchedFirst()}, last_seen_at DESC
       LIMIT 800`,
    )
    .all();
  const out = [];
  for (const row of rows) {
    if (row.lat != null && row.lng != null && isTrustedGeoSource(row.geo_source)) continue;
    if (inferGeoQuality({ address: row.address }) === "unknown") continue;
    out.push(row);
    if (out.length >= cap) break;
  }
  return out;
}

export function listingsNeedingAddressEnrich(limit = 12) {
  const cap = Math.max(1, Number(limit) || 12);
  const rows = db
    .prepare(
      `SELECT post_id, source, source_id, address, url
       FROM listings
       WHERE IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
         AND source IN ('houseprice', '591', 'ddroom', 'rakuya')
       ORDER BY ${sqlWatchedFirst()}, last_seen_at DESC
       LIMIT 400`,
    )
    .all();
  return rows.filter((row) => addressPrecision(row.address) < 25).slice(0, cap);
}

export function setFlags(postId, flags, userId) {
  const uid = resolveUserId(userId);
  const listing = getListing(postId, uid);
  if (!listing) return null;
  const turningOn = flags && (flags.watched === true || flags.watched === 1);
  if (turningOn && !Number(listing.watched)) {
    const user = getUserById(uid) || {};
    const gate = canAddWatch(db, uid, user);
    if (!gate.ok) {
      const err = new Error(gate.error);
      err.status = 409;
      err.code = "WATCH_LIMIT";
      err.limit = gate.limit;
      err.count = gate.count;
      throw err;
    }
  }
  setUserListingFlags(db, uid, postId, flags || {}, listing);
  if (flags && (flags.watched === true || flags.watched === 1)) {
    try { bindWatchToGroup(db, uid, postId); } catch { /* optional */ }
  }
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
    const toWork = getCachedRoute(row.lat, row.lng, workLat, workLng, conf.commuteMode, "to_work");
    const fromWork = getCachedRoute(workLat, workLng, row.lat, row.lng, conf.commuteMode, "from_work");
    if (toWork || fromWork) {
      return {
        ...row,
        route_kms: toWork?.distances || row.route_kms,
        route_km: toWork?.min_km ?? row.route_km,
        route_min_m: toWork?.min_m ?? row.route_min_m,
        route_return_km: fromWork?.min_km ?? row.route_return_km,
        rush_am_min: toWork?.rush_am_min ?? fromWork?.rush_am_min ?? row.rush_am_min,
        rush_pm_min: toWork?.rush_pm_min ?? fromWork?.rush_pm_min ?? row.rush_pm_min,
      };
    }
  }
  return row;
}

let routeCacheMemo = null;
let routeCacheMemoAt = 0;
const ROUTE_CACHE_MEMO_MS = 60_000;
let routeByKeyStmt = null;

function parseRouteCacheRow(row) {
  if (!row) return null;
  const distances = parseJson(row.distances, []);
  if (!Array.isArray(distances) || !distances.length) return null;
  const rushAm = Number(row.rush_am_min);
  const rushPm = Number(row.rush_pm_min);
  return {
    distances: distances.map(Number).filter(Number.isFinite),
    min_km: Number(row.min_km),
    min_m: Number.isFinite(Number(row.min_m)) ? Number(row.min_m) : kmListToMinMeters(distances, null),
    rush_am_min: Number.isFinite(rushAm) ? rushAm : null,
    rush_pm_min: Number.isFinite(rushPm) ? rushPm : null,
    rush_updated_at: row.rush_updated_at || "",
  };
}

export function warmRouteCache() {
  const stamp = Date.now();
  if (routeCacheMemo && stamp - routeCacheMemoAt < ROUTE_CACHE_MEMO_MS) return routeCacheMemo;
  if (!routeCacheMemo) routeCacheMemo = new Map();
  routeCacheMemoAt = stamp;
  return routeCacheMemo;
}

export function getCachedRoute(fromLat, fromLng, toLat, toLng, mode = "scooter", direction = "to_work") {
  const key = makeRouteKey(fromLat, fromLng, toLat, toLng, mode, direction);
  const stamp = Date.now();
  if (!routeCacheMemo || stamp - routeCacheMemoAt >= ROUTE_CACHE_MEMO_MS) {
    routeCacheMemo = new Map();
    routeCacheMemoAt = stamp;
  }
  if (routeCacheMemo.has(key)) return routeCacheMemo.get(key);
  if (!routeByKeyStmt) {
    routeByKeyStmt = db.prepare(
      "SELECT distances, min_km, min_m, rush_am_min, rush_pm_min, rush_updated_at FROM route_cache WHERE route_key = ?",
    );
  }
  const parsed = parseRouteCacheRow(routeByKeyStmt.get(key));
  routeCacheMemo.set(key, parsed);
  return parsed;
}

export function getCachedMrt(lat, lng) {
  const key = makeMrtKey(lat, lng);
  if (!key.includes("NaN")) {
    const row = db.prepare("SELECT station, walk_km, walk_min, ride_km, ride_min FROM mrt_cache WHERE geo_key = ?").get(key);
    if (row) {
      return {
        station: String(row.station || ""),
        walk_km: Number(row.walk_km) || null,
        walk_min: Number(row.walk_min) || null,
        ride_km: Number(row.ride_km) || null,
        ride_min: Number(row.ride_min) || null,
        resolved: true,
      };
    }
  }
  return null;
}

export function setCachedMrt(lat, lng, access) {
  if (!access || access.pending || access.resolved === false) return;
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
    String(access.station || ""),
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
         AND ${sqlTrustedGeoSource()}
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
  const showMrt = getSystemCrawl().showMrt !== false;
  if (!showMrt) {
    return { mrt_station: null, mrt_walk_km: null, mrt_walk_min: null, mrt_ride_km: null, mrt_ride_min: null };
  }
  if (!isTrustedGeoSource(row.geo_source) || !Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lng))) {
    return { mrt_station: null, mrt_walk_km: null, mrt_walk_min: null, mrt_ride_km: null, mrt_ride_min: null };
  }
  const cached = getCachedMrt(row.lat, row.lng);
  if (!cached) {
    return { mrt_station: "", mrt_walk_km: null, mrt_walk_min: null, mrt_ride_km: null, mrt_ride_min: null };
  }
  if (!cached.station || !isWalkableMrtDistance(cached.walk_km)) {
    return { mrt_station: null, mrt_walk_km: null, mrt_walk_min: null, mrt_ride_km: null, mrt_ride_min: null };
  }
  return {
    mrt_station: cached.station,
    mrt_walk_km: cached.walk_km,
    mrt_walk_min: null,
    mrt_ride_km: null,
    mrt_ride_min: null,
  };
}

export function setCachedRoute(fromLat, fromLng, toLat, toLng, distances, rush = null, mode = "scooter", direction = "to_work") {
  const list = (Array.isArray(distances) ? distances : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!list.length) return;
  const key = makeRouteKey(fromLat, fromLng, toLat, toLng, mode, direction);
  const minKm = Math.min(...list);
  const minM = kmListToMinMeters(list, null);
  const stamp = new Date().toISOString();
  const rushAm = Number(rush?.rushAm ?? rush?.am);
  const rushPm = Number(rush?.rushPm ?? rush?.pm);
  const hasRush = Number.isFinite(rushAm) && Number.isFinite(rushPm);
  if (hasRush) {
    db.prepare(
      `INSERT INTO route_cache(route_key, distances, min_km, min_m, updated_at, rush_am_min, rush_pm_min, rush_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(route_key) DO UPDATE SET
         distances = excluded.distances,
         min_km = excluded.min_km,
         min_m = excluded.min_m,
         updated_at = excluded.updated_at,
         rush_am_min = excluded.rush_am_min,
         rush_pm_min = excluded.rush_pm_min,
         rush_updated_at = excluded.rush_updated_at`,
    ).run(key, JSON.stringify(list), minKm, minM, stamp, rushAm, rushPm, stamp);
  } else {
    db.prepare(
      `INSERT INTO route_cache(route_key, distances, min_km, min_m, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(route_key) DO UPDATE SET
         distances = excluded.distances,
         min_km = excluded.min_km,
         min_m = excluded.min_m,
         updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(list), minKm, minM, stamp);
  }
  if (routeCacheMemo && Date.now() - routeCacheMemoAt < ROUTE_CACHE_MEMO_MS) {
    const prev = routeCacheMemo.get(key);
    routeCacheMemo.set(key, {
      distances: list,
      min_km: minKm,
      min_m: minM,
      rush_am_min: hasRush ? rushAm : prev?.rush_am_min ?? null,
      rush_pm_min: hasRush ? rushPm : prev?.rush_pm_min ?? null,
      rush_updated_at: hasRush ? stamp : prev?.rush_updated_at || "",
    });
  }
}

function makeRouteJobKey(postId, direction, kind, mode, workLat, workLng) {
  return [
    Number(postId) || 0,
    String(direction || "to_work"),
    String(kind || "distance"),
    normalizeCommuteMode(mode),
    `${Math.round(Number(workLat) * 1e5) / 1e5},${Math.round(Number(workLng) * 1e5) / 1e5}`,
  ].join("|");
}

let routeJobByKeyStmt;
export function getRouteJob(jobKey) {
  if (!jobKey) return null;
  try {
    routeJobByKeyStmt ||= db.prepare("SELECT * FROM route_jobs WHERE job_key = ?");
    return routeJobByKeyStmt.get(jobKey) || null;
  } catch {
    return null;
  }
}

export function upsertRouteJob(partial = {}) {
  const postId = Number(partial.post_id) || 0;
  const direction = String(partial.direction || "to_work");
  const kind = String(partial.kind || "distance");
  const mode = normalizeCommuteMode(partial.commuteMode || partial.commute_mode);
  const workLat = Number(partial.workLat ?? partial.work_lat);
  const workLng = Number(partial.workLng ?? partial.work_lng);
  const jobKey = partial.job_key || makeRouteJobKey(postId, direction, kind, mode, workLat, workLng);
  const stamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO route_jobs(job_key, post_id, direction, kind, commute_mode, work_lat, work_lng, job_state, fail_reason, attempts, next_retry_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_key) DO UPDATE SET
       job_state = excluded.job_state,
       fail_reason = excluded.fail_reason,
       attempts = excluded.attempts,
       next_retry_at = excluded.next_retry_at,
       updated_at = excluded.updated_at,
       work_lat = excluded.work_lat,
       work_lng = excluded.work_lng`,
  ).run(
    jobKey,
    postId,
    direction,
    kind,
    mode,
    Number.isFinite(workLat) ? workLat : null,
    Number.isFinite(workLng) ? workLng : null,
    String(partial.job_state || COMMUTE_STATES.WAIT_ROUTE),
    String(partial.fail_reason || ""),
    Number(partial.attempts) || 0,
    partial.next_retry_at || "",
    stamp,
  );
  return getRouteJob(jobKey);
}

function routeJobBlocks(row, job, kind, now) {
  const rec = getRouteJob(makeRouteJobKey(row.post_id, "to_work", kind, job.commuteMode, job.workLat, job.workLng));
  if (!rec) return false;
  if (rec.job_state === COMMUTE_STATES.COMPUTING) return true;
  if (rec.job_state === COMMUTE_STATES.FAILED) return kind === "distance";
  if (rec.job_state === COMMUTE_STATES.RETRY && rec.next_retry_at && Date.parse(rec.next_retry_at) > now) return true;
  return false;
}

function listingNeedsRoute(row, job, wantRush, now) {
  if (routeJobBlocks(row, job, "distance", now)) return null;
  const toWork = getCachedRoute(row.lat, row.lng, job.workLat, job.workLng, job.commuteMode, "to_work");
  const fromWork = getCachedRoute(job.workLat, job.workLng, row.lat, row.lng, job.commuteMode, "from_work");
  const needBasic = !toWork;
  const needReturn = !fromWork;
  const needRush = wantRush && (!toWork || !Number.isFinite(toWork.rush_am_min) || !Number.isFinite(toWork.rush_pm_min));
  if (needRush && routeJobBlocks(row, job, "rush", now) && !needBasic && !needReturn) return null;
  if (!needBasic && !needReturn && !needRush) return null;
  return {
    ...row,
    workLat: job.workLat,
    workLng: job.workLng,
    commuteMode: job.commuteMode,
    needBasic,
    needReturn,
    needRush,
  };
}

export function listingsNeedingRoute(limit = 40, options = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 40, 80));
  const jobs = commuteWorkJobs(collectCommuteSettings());
  if (!jobs.length) {
    listingsNeedingRoute.lastCursor = 0;
    return [];
  }
  const wantRush = commuteRushEnabled() && googleDirectionsAllowed();
  const now = Number(options.now) || Date.now();
  const priorityIds = [...new Set((options.priorityIds || []).map(Number).filter((id) => id > 0))];
  const cursor = Number(options.cursor ?? listingsNeedingRoute.lastCursor) || 0;
  const out = [];
  const seen = new Set();

  const pushRow = (row) => {
    for (const job of jobs) {
      const key = `${row.post_id}|${job.workLat}|${job.workLng}|${job.commuteMode}`;
      if (seen.has(key)) continue;
      const need = listingNeedsRoute(row, job, wantRush, now);
      if (!need) continue;
      seen.add(key);
      out.push(need);
      if (out.length >= cap) return true;
    }
    return false;
  };

  if (priorityIds.length) {
    const placeholders = priorityIds.map(() => "?").join(",");
    const priorityRows = db.prepare(
      `SELECT post_id, lat, lng FROM listings
       WHERE post_id IN (${placeholders})
         AND lat IS NOT NULL AND lng IS NOT NULL
         AND ${sqlTrustedGeoSource()}
         AND IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0`,
    ).all(...priorityIds);
    const order = new Map(priorityIds.map((id, index) => [id, index]));
    priorityRows.sort((a, b) => (order.get(a.post_id) ?? 1e9) - (order.get(b.post_id) ?? 1e9));
    for (const row of priorityRows) {
      if (pushRow(row)) {
        listingsNeedingRoute.lastCursor = cursor;
        return out;
      }
    }
  }

  const watched = db.prepare(
    `SELECT l.post_id, l.lat, l.lng FROM listings l
     WHERE l.lat IS NOT NULL AND l.lng IS NOT NULL
       AND ${sqlTrustedGeoSource("l.geo_source")}
       AND IFNULL(l.hidden, 0) = 0
       AND IFNULL(l.offline, 0) = 0
       AND EXISTS (SELECT 1 FROM user_listing_flags f WHERE f.post_id = l.post_id AND f.watched = 1)
     ORDER BY l.last_seen_at DESC
     LIMIT ?`,
  ).all(Math.max(cap, 40));
  for (const row of watched) {
    if (pushRow(row)) {
      listingsNeedingRoute.lastCursor = cursor;
      return out;
    }
  }

  let scanCursor = cursor;
  const pageSize = 250;
  let scanned = 0;
  while (out.length < cap && scanned < 20) {
    const rows = db.prepare(
      `SELECT post_id, lat, lng FROM listings
       WHERE lat IS NOT NULL AND lng IS NOT NULL
         AND ${sqlTrustedGeoSource()}
         AND IFNULL(hidden, 0) = 0
         AND IFNULL(offline, 0) = 0
         AND post_id > ?
       ORDER BY post_id ASC
       LIMIT ?`,
    ).all(scanCursor, pageSize);
    if (!rows.length) {
      scanCursor = 0;
      break;
    }
    scanCursor = Number(rows[rows.length - 1].post_id) || scanCursor;
    scanned += 1;
    for (const row of rows) {
      if (pushRow(row)) {
        listingsNeedingRoute.lastCursor = scanCursor;
        return out;
      }
    }
    if (rows.length < pageSize) {
      scanCursor = 0;
      break;
    }
  }
  listingsNeedingRoute.lastCursor = scanCursor;
  return out;
}
listingsNeedingRoute.lastCursor = 0;

export function listingCommutePatch(postId, userId, settingsOverride) {
  const uid = userId == null ? defaultUserId() : Number(userId) || 0;
  const row = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(Number(postId));
  if (!row) return null;
  const settings = settingsOverride || getSettings(uid);
  const lite = decorateListing(withPersonal(row, uid), settings, uid, { sameHouse: false });
  return {
    post_id: lite.post_id,
    lat: lite.lat,
    lng: lite.lng,
    geo_source: lite.geo_source,
    commute_km: lite.commute_km,
    commute_return_km: lite.commute_return_km,
    commute_state: lite.commute_state,
    commute_state_label: lite.commute_state_label,
    commute_mode: lite.commute_mode,
    commute_hint: lite.commute_hint,
    commute_routes: lite.commute_routes,
    commute_min_am: lite.commute_min_am,
    commute_min_pm: lite.commute_min_pm,
    location_class: lite.location_class,
    commute_precision: lite.commute_precision,
    commute_approx: lite.commute_approx,
    route_min_m: lite.route_min_m,
    mrt_station: lite.mrt_station,
    mrt_walk_km: lite.mrt_walk_km,
    fingerprint: commuteSettingsFingerprint(settings),
  };
}

function applyListingFilter(rows, settings = getSettings()) {
  // 列表用非嚴格通勤：還沒算完路線的先顯示（排在離公司排序末端），避免新北等區整批空白
  const commuteOn = Number(settings.commuteKm) > 0 && hasWorkPoint(settings);
  if (commuteOn) warmRouteCache();
  // Price/keyword/agent/area checks do not depend on routes. Avoid fetching
  // cached routes and cloning wide rows that these checks already exclude.
  const candidates = rows.filter((row) => passesAttributeFilters(row, settings));
  const prepared = commuteOn ? candidates.map((row) => applyCachedCoords(row, settings)) : candidates;
  return prepared.filter((row) => passesGeoFilters(row, settings, { strict: false }));
}

function listingDistrictName(row) {
  return row?.district || districtNameFromListing(row);
}

/** 設定檔結果：租金／關鍵字／通勤／樓層／行政區，與列表「全部」同一套範圍。 */
function applyProfileScope(rows, settings) {
  const districtNames = memberRegionDistrictNames(settings);
  const districtSet = new Set(districtNames);
  const scoped = districtSet.size ? rows.filter(row => districtSet.has(listingDistrictName(row))) : rows;
  return applyListingFilter(scoped, settings).filter((row) => {
    if (!passesDisplayFilters(row, settings)) return false;
    return true;
  });
}

function listingMatchesDistrictKeys(row, keySet, nameSet) {
  if (!keySet.size) return false;
  const bits = String(row?.source_key || "").split("|");
  if (bits.length >= 2 && bits[0] !== "" && bits[1] !== "") {
    if (keySet.has(`${bits[0]}-${bits[1]}`)) return true;
  }
  const name = districtNameFromListing(row);
  return Boolean(name && nameSet.has(name));
}

export function refreshSiteCatalogStats() {
  const system = getSystemCrawl();
  const keys = normalizeWatchDistricts(system.watchDistricts);
  const keySet = new Set(keys);
  const nameSet = new Set(keys.map((key) => lookupDistrict(key)?.name).filter(Boolean));
  const rows = db.prepare("SELECT source, source_key, address, title FROM listings").all();
  const bySource = {};
  let total = 0;
  for (const row of rows) {
    if (!listingMatchesDistrictKeys(row, keySet, nameSet)) continue;
    total += 1;
    const source = String(row.source || "591");
    bySource[source] = (bySource[source] || 0) + 1;
  }
  const self = Number(bySource.self) || 0;
  const snapshot = {
    at: new Date().toISOString(),
    total,
    self,
    sources: Math.max(0, total - self),
    bySource,
    districtCount: keys.length,
    bySourceLabels: Object.fromEntries(
      Object.entries(bySource).map(([id, count]) => [selfSourceLabel(id), count]),
    ),
  };
  writeSettingKey("siteCatalogStats", snapshot);
  return snapshot;
}

export function readSiteCatalogStats() {
  const stored = parseSettingRows(db.prepare("SELECT key, value FROM settings").all());
  const snap = stored.siteCatalogStats;
  return snap && typeof snap === "object" ? snap : null;
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

export function updateListingsGeoByAddress(address, lat, lng, meta = {}) {
  setCachedGeo(address, lat, lng, meta);
  const key = String(address || "").replace(/\s+/g, "");
  if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return 0;
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT post_id, address, lat, lng, geo_source, location_class, coord_version
       FROM listings
       WHERE replace(IFNULL(address, ''), ' ', '') = ?
          OR replace(IFNULL(address_norm, ''), ' ', '') = ?`,
    ).all(key, key);
  } catch {
    rows = db.prepare(
      `SELECT post_id, address, lat, lng, geo_source
       FROM listings
       WHERE replace(IFNULL(address, ''), ' ', '') = ?`,
    ).all(key);
  }
  let updated = 0;
  for (const row of rows) {
    if (applyListingLocation(row.post_id, {
      lat,
      lng,
      geo_source: meta.geo_source || "geocode",
      location_class: meta.location_class,
      address_norm: meta.address_used || address,
      coord_version: (Number(row.coord_version) || 0) + 1,
      provider: meta.provider || "",
      geo_job_state: "done",
    }, row)) updated += 1;
  }
  return updated;
}

function listingCommuteKm(row) {
  const decorated = Number(row?.commute_km);
  if (Number.isFinite(decorated)) return decorated;
  const raw = Number(row?.route_km);
  if (Number.isFinite(raw)) return Math.round(raw * 10) / 10;
  return null;
}

function rentSortValue(row, settings = {}) {
  return listingCompareCost(row, { includeExtras: settings?.priceMaxIncludesExtras === true });
}

function priceSortKey(row, settings = {}) {
  const n = rentSortValue(row, settings);
  return n > 0 ? n : Number.MAX_SAFE_INTEGER;
}

export function listingEffectiveUpdatedAt(row, now = Date.now()) {
  const sourceUpdated = Date.parse(row?.source_updated_at || "");
  if (Number.isFinite(sourceUpdated)) return sourceUpdated;
  const published = Date.parse(row?.source_published_at || "");
  if (Number.isFinite(published)) return published;
  const raw = String(row?.refresh_time || "").trim();
  if (raw && !/剛剛|秒前|分鐘前|小時|今日|今天|昨日|昨天|天前/.test(raw)) {
    const abs = Date.parse(raw);
    if (Number.isFinite(abs)) return abs;
  }
  const first = Date.parse(row?.first_seen_at || "");
  if (Number.isFinite(first)) return first;
  return listingRefreshAt({ ...row, refresh_time: "", last_seen_at: row?.first_seen_at }, now) || 0;
}

function commuteMissingLast(a, b, dir = 1) {
  const left = listingCommuteKm(a);
  const right = listingCommuteKm(b);
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return (left - right) * dir;
}

export function sortListingsRows(rows, sort = "price_asc", { filter, settings, now = Date.now() } = {}) {
  const list = [...(rows || [])];
  const updated = new Map(list.map(row => [row, listingEffectiveUpdatedAt(row, now)]));
  const prices = /^(price_asc|price_desc)$/.test(sort)
    ? new Map(list.map(row => [row, rentSortValue(row, settings)])) : null;
  const byId = (a, b) => (Number(a.post_id) || 0) - (Number(b.post_id) || 0);
  const byUpdated = (a, b) => updated.get(b) - updated.get(a) || byId(a, b);
  if (sort === "commute_asc") {
    list.sort((a, b) => commuteMissingLast(a, b, 1) || byUpdated(a, b));
  } else if (sort === "commute_desc") {
    list.sort((a, b) => commuteMissingLast(a, b, -1) || byUpdated(a, b));
  } else if (sort === "price_desc") {
    list.sort((a, b) => {
      const pa = prices.get(a);
      const pb = prices.get(b);
      if ((pa > 0) !== (pb > 0)) return pa > 0 ? -1 : 1;
      return pb - pa || byUpdated(a, b);
    });
  } else if (sort === "newest") {
    list.sort(byUpdated);
  } else if (sort === "fit_desc") {
    list.sort((a, b) => {
      const sa = Number(a.fit_score);
      const sb = Number(b.fit_score);
      const aKnown = Number.isFinite(sa) && sa > 0;
      const bKnown = Number.isFinite(sb) && sb > 0;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return (sb || 0) - (sa || 0) || byUpdated(a, b);
    });
  } else {
    const key = row => prices ? prices.get(row) > 0 ? prices.get(row) : Number.MAX_SAFE_INTEGER : priceSortKey(row, settings);
    list.sort((a, b) => key(a) - key(b) || byUpdated(a, b));
  }
  return list;
}

// All fields used by profile filters, grouping and sorting. Large bodies, photos,
// contact details and equipment are loaded only for the selected page.
const LIST_CANDIDATE_COLUMNS = `post_id, source, source_id, source_key, url, price, price_num,
  extra_fee, extra_fees, extra_fee_text, price_contain_text,
  title, address, address_norm, area_name, layout, floor_name, kind_name, tags,
  role_name, contact_name, contact_role, contact_uid, agency,
  lat, lng, geo_source, location_class, match_post_id, match_level,
  match_verdict, match_rejected, offline, offline_confirmed, hidden, hidden_at,
  last_event, first_seen_at, last_seen_at, refresh_time, listed_by_user_id, self_status`;

export function listListings({
  filter = "all",
  kind = "",
  sources = "",
  q = "",
  sort = "price_asc",
  limit = 500,
  offset = 0,
  searchKeys,
  districts = [],
  userId,
  matchVoteUserId,
  settings: settingsOverride,
  sameHouse = true,
} = {}) {
  const queryDetails = {};
  let stageStarted = performance.now();
  const markStage = (name) => {
    const now = performance.now();
    queryDetails[name] = Math.round(now - stageStarted);
    stageStarted = now;
  };
  const uid = resolveUserId(userId);
  const voteUid = matchVoteUserId == null ? uid : Number(matchVoteUserId) || 0;
  ({ filter, kind, sources } = normalizeListQuery(filter, kind, sources));
  const settings = settingsOverride || getSettings(uid);
  const requestedDistricts = (Array.isArray(districts) ? districts : String(districts || "").split(","))
    .map(name => String(name || "").trim()).filter(Boolean);
  const districtNames = requestedDistricts.length ? requestedDistricts : memberRegionDistrictNames(settings);
  const districtSet = new Set(districtNames);
  const clauses = [];
  const params = [];
  searchWhere(searchKeys, clauses, params);
  listingVisibilityClauses(clauses, params);
  appendDistrictCandidates(districtNames, clauses, params, { preserveRelationsFor: voteUid });
  appendPriceCeilingCandidates(settings, clauses, params);
  if (filter === "suspected") {
    clauses.push("match_level IN ('high', 'medium')");
    clauses.push("IFNULL(offline, 0) = 0");
    clauses.push("(IFNULL(match_verdict, '') != 'yes')");
    clauses.push("IFNULL(hidden, 0) = 0");
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
    // 只排除「確認已下架」；「下架確認中」的物件仍留在一般列表（前端灰階呈現）。
    clauses.push("NOT (IFNULL(offline, 0) = 1 AND IFNULL(offline_confirmed, 0) = 1)");
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
  markStage("prepare_ms");
  const raw = db.prepare(`SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings ${where}`).all(...params);
  markStage("sql_ms");
  queryDetails.candidates = raw.length;
  const flagMap = loadFlagMap(db, uid);
  const overlaid = overlayRowsPersonal(raw, flagMap, { inPlace: true });
  let rows =
    filter === "offline" || filter === "suspected"
      ? overlaid.filter((row) => passesPriceFilter(row, settings))
      : applyListingFilter(overlaid, settings);
  markStage("profile_ms");

  rows = attachSameHouseRoles(rows, voteUid);
  markStage("relations_ms");
  rows = rows.filter((row) => listingMatchesListFilter(row, filter));
  rows = rows.filter((row) => keepSelfListingForViewer(row, uid, settings, listingInMemberScope));

  // 整層／1F、行政區要在 limit 前套用，否則「全庫最便宜 500 筆」再前端篩選會漏掉新北等區
  rows = rows.filter((row) => passesDisplayFilters(row, settings, { skipWholeFloor: Boolean(kind) }));
  // 「全部」（未指定行政區）＝只顯示此使用者自己設定的行政區（watchDistricts ∪ searchUrls），
  // 而不是整個共用資料庫（listings 是跨使用者共用池；否則會看到別人／系統抓的其它縣市，如台中西屯）。
  if (districtSet.size) {
    rows = rows.filter((row) => districtSet.has(row.district || districtNameFromListing(row)));
  }

  rows = rows.filter((row) => matchesHousingKind(row, kind));
  rows = rows.filter((row) => matchesListingSources(row, sources));
  markStage("display_ms");

  const needFit = sort === "fit_desc";
  if (needFit) {
    for (const row of rows) {
      const located = applyCachedCoords(row, settings);
      const km = canUseForRoadDistance(effectiveNotifyLocationClass(located, settings))
        && Number.isFinite(Number(located.route_km)) ? Math.round(Number(located.route_km) * 10) / 10 : null;
      row.fit_score = listingFitFields({ ...located, commute_km: km }, settings).fit_score;
    }
  }
  rows = sortListingsRows(rows, sort, { filter, settings });
  markStage("sort_ms");

  const totalMatched = rows.length;
  const pageSize = Math.max(1, Math.min(Number(limit) || 500, 500));
  const start = Math.max(0, Number(offset) || 0);
  const page = rows.slice(start, start + pageSize);
  const fullRows = page.length ? db.prepare(
    `SELECT * FROM listings WHERE post_id IN (${page.map(() => "?").join(",")})`,
  ).all(...page.map(row => row.post_id)) : [];
  const fullById = new Map(fullRows.map(row => [Number(row.post_id), row]));
  // A separate importer may remove a row between the candidate and page reads.
  const listings = page.filter(row => fullById.has(Number(row.post_id))).map((row) => {
    const lite = decorateListingLite(Object.assign(fullById.get(Number(row.post_id)), row), settings, uid);
    const needPeers = sameHouse !== false && Boolean(row.match_post_id || row.same_house_role);
    return finalizeListingDecorate(lite, settings, uid, { sameHouse: needPeers, matchVoteUserId: voteUid });
  });
  markStage("hydrate_ms");
  return {
    listings,
    totalMatched,
    hasMore: start + pageSize < totalMatched,
    nextOffset: start + pageSize,
    queryVersion: 2,
    queryDetails,
  };
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

export function pendingNotifyEvents(limit = 80, now = Date.now()) {
  const cap = Math.max(1, Number(limit) || 80);
  const stamp = Number(now) || Date.now();
  try {
    return db.prepare(`
      SELECT e.*
      FROM user_events e
      LEFT JOIN listings l ON l.post_id = e.post_id
      WHERE IFNULL(e.notified, 0) = 0
        AND IFNULL(e.notify_decide, '') NOT IN ('cancelled', 'superseded')
        AND (e.notify_next_at IS NULL OR e.notify_next_at <= ?)
      ORDER BY
        CASE
          WHEN IFNULL(e.notify_decide, '') = 'ready' THEN 0
          WHEN IFNULL(e.line_job_state, '') IN ('retry', 'unknown')
            OR IFNULL(e.email_job_state, '') IN ('retry', 'unknown')
            OR IFNULL(e.push_job_state, '') IN ('retry', 'unknown') THEN 1
          WHEN l.lat IS NOT NULL AND IFNULL(l.location_class, '') NOT IN ('admin', 'unknown') THEN 2
          ELSE 3
        END,
        COALESCE(e.notify_next_at, 0) ASC,
        e.id ASC
      LIMIT ?
    `).all(stamp, cap);
  } catch {
    return db.prepare("SELECT * FROM user_events WHERE IFNULL(notified, 0) = 0 ORDER BY id ASC LIMIT ?").all(cap);
  }
}

const CHANNEL_DONE = new Set(["accepted", "skipped", "legacy_handled_unknown"]);

export function channelJobDone(state) {
  return CHANNEL_DONE.has(String(state || ""));
}

export function updateEventNotify(id, patch = {}) {
  const row = db.prepare("SELECT * FROM user_events WHERE id = ?").get(Number(id));
  if (!row) return null;
  const next = { ...row, ...patch };
  try {
    db.prepare(`
      UPDATE user_events SET
        notify_decide = ?,
        notify_reason = ?,
        notify_retry_count = ?,
        notify_last_error = ?,
        notify_next_at = ?,
        notify_ready_at = ?,
        notify_coord_version = ?,
        dock_job_state = ?,
        line_job_state = ?,
        email_job_state = ?,
        push_job_state = ?,
        notified = ?
      WHERE id = ?
    `).run(
      String(next.notify_decide || ""),
      String(next.notify_reason || ""),
      Number(next.notify_retry_count) || 0,
      String(next.notify_last_error || ""),
      next.notify_next_at == null ? null : Number(next.notify_next_at),
      next.notify_ready_at == null ? null : Number(next.notify_ready_at),
      Number(next.notify_coord_version) || 0,
      String(next.dock_job_state || ""),
      String(next.line_job_state || ""),
      String(next.email_job_state || ""),
      String(next.push_job_state || ""),
      Number(next.notified) || 0,
      Number(id),
    );
  } catch {
    if (Number(next.notified) === 1) markEventNotified(id);
  }
  return { ...next, id: Number(id) };
}

export function markLegacyNotifiedUnknown() {
  try {
    db.prepare(`
      UPDATE user_events
      SET dock_job_state = CASE WHEN IFNULL(dock_job_state, '') = '' THEN 'legacy_handled_unknown' ELSE dock_job_state END,
          line_job_state = CASE WHEN IFNULL(line_job_state, '') = '' THEN 'legacy_handled_unknown' ELSE line_job_state END,
          email_job_state = CASE WHEN IFNULL(email_job_state, '') = '' THEN 'legacy_handled_unknown' ELSE email_job_state END,
          notify_decide = CASE WHEN IFNULL(notify_decide, '') = '' THEN 'legacy_handled_unknown' ELSE notify_decide END
      WHERE IFNULL(notified, 0) = 1
        AND IFNULL(dock_job_state, '') = ''
        AND IFNULL(line_job_state, '') = ''
        AND IFNULL(email_job_state, '') = ''
    `).run();
  } catch {
    // older fixtures
  }
}

export function eventChannelsHandled(event = {}, needed = {}) {
  const jobs = [];
  if (needed.dock) jobs.push({ job_state: event.dock_job_state });
  if (needed.hook) jobs.push({ job_state: event.line_job_state });
  if (needed.mail) jobs.push({ job_state: event.email_job_state });
  if (needed.push) jobs.push({ job_state: event.push_job_state });
  if (!jobs.length) return true;
  return eventFullyHandled(jobs);
}

export function applyListingLocation(postId, next = {}, prev = null) {
  const current = prev || db.prepare("SELECT lat, lng, geo_source, location_class, coord_version, address FROM listings WHERE post_id = ?").get(Number(postId));
  if (!current) return false;
  if (!shouldAcceptGeoUpdate(current, next)) return false;
  const cls = resolveLocationClass({ ...current, ...next });
  const version = Number(next.coord_version || current.coord_version || 0) || Date.now();
  try {
    db.prepare(`
      UPDATE listings SET
        lat = COALESCE(?, lat),
        lng = COALESCE(?, lng),
        geo_source = COALESCE(?, geo_source),
        location_class = ?,
        address_norm = COALESCE(?, address_norm),
        coord_version = ?,
        geo_provider = COALESCE(?, geo_provider),
        geo_approx = ?,
        geo_error = ?,
        geo_job_state = COALESCE(?, geo_job_state)
      WHERE post_id = ?
    `).run(
      next.lat ?? null,
      next.lng ?? null,
      next.geo_source || null,
      cls,
      next.address_norm || null,
      version,
      next.provider || next.geo_provider || null,
      cls === "street" || cls === "admin" ? 1 : 0,
      next.geo_error || "",
      next.geo_job_state || null,
      Number(postId),
    );
  } catch {
    return false;
  }
  reopenNotifyAfterGeo(postId, { ...current, ...next, coord_version: version });
  return true;
}

export function reopenNotifyAfterGeo(postId, listing = {}) {
  try {
    db.prepare(`
      UPDATE user_events
      SET notified = 0,
          notify_decide = CASE WHEN notify_decide IN ('skip_distance', 'wait_precision') THEN 'wait_route' ELSE notify_decide END
      WHERE post_id = ?
        AND type = 'new'
        AND IFNULL(notified, 0) = 1
        AND notify_decide IN ('skip_distance', 'wait_precision')
        AND IFNULL(line_job_state, '') NOT IN ('accepted', 'legacy_handled_unknown')
        AND IFNULL(dock_job_state, '') NOT IN ('accepted', 'legacy_handled_unknown')
        AND IFNULL(notify_coord_version, 0) < ?
    `).run(Number(postId), Number(listing.coord_version) || 0);
  } catch {
    // older fixtures
  }
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
    source: row.source || event.source || "591",
    source_label: selfSourceLabel(row.source || event.source || "591"),
    offline: row.offline,
    offline_confirmed: row.offline_confirmed,
    same_house_primary_id: row.same_house_primary_id || row.same_house?.primary_id || 0,
    same_house_role: row.same_house_role || "",
    cover: row.cover,
    commute_km: row.commute_km,
    commute_mode: row.commute_mode,
    location_class: row.location_class,
    commute_approx: row.commute_approx,
    notify_note: row.notify_note || (row.location_class === "street" || row.commute_approx ? "依路段位置估算，實際距離可能不同" : ""),
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

let statsHoldUntil = 0;
const statsMemo = new Map();
const STATS_MEMO_MS = 15_000;
const STATS_MEMO_LIMIT = 32;

export function holdStatsCache(ms = 15000) {
  statsHoldUntil = Date.now() + Math.max(0, Number(ms) || 0);
}

function statsCacheKey(uid, searchKeys, settingsOverride) {
  // Settings overrides include prices, exclusions and district scope as well as commute.
  return {
    key: JSON.stringify([uid, searchKeys || null, settingsOverride || getSettings(uid)]),
    revision: `${db.prepare("SELECT total_changes() AS n").get().n}:${db.prepare("PRAGMA data_version").get().data_version}`,
  };
}

export function stats(searchKeys, userId, settingsOverride, diagnostics) {
  let stageStarted = performance.now();
  const markStage = (name) => {
    const now = performance.now();
    if (diagnostics) diagnostics[name] = Math.round(now - stageStarted);
    stageStarted = now;
  };
  if (diagnostics) Object.assign(diagnostics, { cache_hit: false, cache_age_ms: 0, cache_miss_reason: null });
  const uid = resolveUserId(userId);
  const { key: holdKey, revision } = statsCacheKey(uid, searchKeys, settingsOverride);
  const now = Date.now();
  const cached = statsMemo.get(holdKey);
  if (cached && cached.revision === revision && now < cached.expiresAt) {
    statsMemo.delete(holdKey);
    statsMemo.set(holdKey, cached);
    if (diagnostics) Object.assign(diagnostics, { cache_hit: true, cache_age_ms: Math.max(0, now - cached.at) });
    markStage("prepare_ms");
    return { ...cached.value };
  }
  if (diagnostics) diagnostics.cache_miss_reason = !cached ? "empty"
    : cached.revision !== revision ? "data_changed" : "expired";
  statsMemo.delete(holdKey);
  const settings = settingsOverride || getSettings(uid);
  if (Number(settings.commuteKm) > 0 && hasWorkPoint(settings)) warmRouteCache();
  const clauses = [];
  const params = [];
  searchWhere(searchKeys, clauses, params);
  listingVisibilityClauses(clauses, params);
  markStage("prepare_ms");
  // These two counters historically cover the shared search pool, including
  // other districts. Count them in SQL before narrowing profile candidates.
  const statusWhere = `WHERE ${[...clauses, "COALESCE(offline, 0) != 0"].join(" AND ")}`;
  const statusCounts = db.prepare(`SELECT
    SUM(CASE WHEN COALESCE(offline, 0) != 0 AND COALESCE(offline_confirmed, 0) = 0 THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN COALESCE(offline, 0) != 0 AND COALESCE(offline_confirmed, 0) != 0 THEN 1 ELSE 0 END) AS confirmed
    FROM listings ${statusWhere}`).get(...params);
  appendDistrictCandidates(memberRegionDistrictNames(settings), clauses, params);
  appendPriceCeilingCandidates(settings, clauses, params);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const raw = db
    .prepare(
      `SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings ${where}`,
    )
    .all(...params);
  markStage("sql_ms");
  if (diagnostics) diagnostics.candidates = raw.length;
  const flagMap = loadFlagMap(db, uid);
  const overlaid = overlayRowsPersonal(raw, flagMap, { inPlace: true })
    .filter((row) => keepSelfListingForViewer(row, uid, settings, listingInMemberScope));
  const profileRows = applyProfileScope(overlaid, settings);
  markStage("profile_ms");
  const browse = profileRows.filter(countsTowardAllTotal);
  const failedRouteJobs = new Set(db.prepare("SELECT job_key FROM route_jobs WHERE job_state = 'failed'").all().map(row => row.job_key));
  const out = {
    total: browse.length,
    unseen: browse.filter((row) => !row.viewed).length,
    watched: profileRows.filter((row) => row.watched && !isConfirmedOffline(row)).length,
    watchedTotal: countWatched(db, uid),
    same_source: browse.filter((row) => ["same_source", "update", "price_drop", "title_update"].includes(row.last_event)).length,
    hidden: profileRows.filter((row) => row.hidden).length,
    offline: Number(statusCounts.pending) || 0,
    offlineConfirmed: Number(statusCounts.confirmed) || 0,
    suspected: profileRows.filter((row) => row.match_level && !row.offline && row.match_verdict !== "yes" && !row.hidden).length,
    suspectedPending: profileRows.filter((row) => row.match_level && !row.match_verdict && !row.offline && !row.hidden).length,
    elevator: browse.filter((row) => listingHasElevator(row)).length,
    stored: browse.length,
    filteredOut: 0,
    missingGeo: profileRows.filter((row) => !row.hidden && !isPendingOffline(row) && !isConfirmedOffline(row) && !row.watched && row.match_verdict !== "yes" && (!isTrustedGeoSource(row.geo_source) || row.lat == null || row.lng == null)).length,
    missingRoute: profileRows.filter((row) => {
      if (row.hidden || isPendingOffline(row) || isConfirmedOffline(row) || row.watched || row.match_verdict === "yes") return false;
      const geo = applyCachedCoords(row, settings);
      if (!(
        Number(settings.commuteKm) > 0 &&
        isTrustedGeoSource(geo.geo_source) &&
        Number.isFinite(Number(geo.lat)) &&
        Number.isFinite(Number(geo.lng)) &&
        !(Array.isArray(geo.route_kms) && geo.route_kms.length)
      )) return false;
      const jobKey = makeRouteJobKey(
        row.post_id,
        "to_work",
        "distance",
        settings.commuteMode,
        settings.workLat,
        settings.workLng,
      );
      return !failedRouteJobs.has(jobKey);
    }).length,
    dbTotal: listingCount(),
  };
  markStage("count_ms");
  const computedAt = Date.now();
  // Each entry is scoped to the member/profile AND both SQLite writer versions.
  // Keep only scalar counters; caller mutations must not alter the cached copy.
  statsMemo.set(holdKey, { value: { ...out }, at: computedAt, revision,
    expiresAt: Math.max(computedAt + STATS_MEMO_MS, statsHoldUntil) });
  while (statsMemo.size > STATS_MEMO_LIMIT) statsMemo.delete(statsMemo.keys().next().value);
  return out;
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
  const key = addressVersion(address);
  if (!key) return null;
  try {
    return db.prepare(
      "SELECT lat, lng, quality, geo_source, address_used, address_version, location_class, city, district, cache_kind, provider, updated_at FROM geo_cache WHERE address = ?",
    ).get(key) || null;
  } catch {
    try {
      return db.prepare(
        "SELECT lat, lng, quality, geo_source, address_used, address_version, updated_at FROM geo_cache WHERE address = ?",
      ).get(key) || null;
    } catch {
      return db.prepare("SELECT lat, lng FROM geo_cache WHERE address = ?").get(key) || null;
    }
  }
}

export function setCachedGeo(address, lat, lng, meta = {}) {
  const key = addressVersion(address);
  if (!key || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
  const quality = meta.quality || inferGeoQuality({ address: meta.address_used || address });
  const source = String(meta.geo_source || meta.source || "");
  const used = String(meta.address_used || address || "");
  const stamp = new Date().toISOString();
  const locationClass = String(meta.location_class || "");
  const city = String(meta.city || "");
  const district = String(meta.district || "");
  const cacheKind = String(meta.cache_kind || (locationClass === "street" ? "street" : locationClass === "address" ? "house" : quality));
  const provider = String(meta.provider || "");
  try {
    db.prepare(
      `INSERT INTO geo_cache(address, lat, lng, updated_at, quality, geo_source, address_used, address_version, location_class, city, district, cache_kind, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET
         lat = excluded.lat,
         lng = excluded.lng,
         updated_at = excluded.updated_at,
         quality = excluded.quality,
         geo_source = excluded.geo_source,
         address_used = excluded.address_used,
         address_version = excluded.address_version,
         location_class = excluded.location_class,
         city = excluded.city,
         district = excluded.district,
         cache_kind = excluded.cache_kind,
         provider = excluded.provider`,
    ).run(key, Number(lat), Number(lng), stamp, quality, source, used, key, locationClass, city, district, cacheKind, provider);
  } catch {
    db.prepare(
      "INSERT INTO geo_cache(address, lat, lng, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, updated_at = excluded.updated_at",
    ).run(key, Number(lat), Number(lng), stamp);
  }
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
    applyStoredOauth();
  } catch (error) {
    console.warn("套用社群登入設定失敗：", error.message);
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
  try {
    const importedV2 = importV2CacheIfNeeded(db);
    if (importedV2.imported) {
      console.log(
        `[5151] 已從 v2 只讀匯入刊登 ${importedV2.listings} 筆、社區 ${importedV2.communities}、座標 ${importedV2.geo}、路線 ${importedV2.routes}`,
      );
    }
  } catch (error) {
    console.warn("從 v2 匯入刊登快取失敗：", error.message);
  }
} catch (error) {
  console.warn("會員帳號初始化失敗：", error.message);
}
