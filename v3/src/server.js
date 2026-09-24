import "./env.js";
import { resolveAppRole, roleRunsWeb, roleRunsCrawler, roleRunsWorker } from "./appRole.js";
import { searchListingsAsync } from "./listingSearchAsync.js";
import { listingStatsAsync } from "./listingStatsAsync.js";
import {
  armMemberExternalFetchAsync,
  deleteProfileAsync,
  getSettingsAsync,
  loadProfileAsync,
  saveAsProfileAsync,
  saveSettingsAsync,
} from "./settingsAsync.js";
import { getListingAsync } from "./listingDetailAsync.js";
import { markListingAliveAsync, markListingOfflineAsync } from "./crawlerWrites.js";
import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  coveringJobsFromAllUsers,
  coveringPlan,
  crawlIntervalMinutes,
  defaultUserId,
  listUserIds,
  deleteProfile,
  getCachedGeo,
  confirmExpiredOfflineFromSettings,
  getSettings,
  hideMany,
  listListings,
  loadProfile,
  recentEvents,
  registerUser,
  updateUserProfile,
  countOpenSelfListings,
  issueVerifyToken,
  confirmVerifyToken,
  expireStaleVerifyTokens,
  rejectSuspectedMatch,
  confirmSuspectedMatch,
  listPublicListings,
  listPublicListingsFast,
  publicSearchSettings,
  GUEST_MAX_DISTRICTS,
  runSameHouseBackfill,
  sameHouseBackfillStatus,
  mergeSameHouseForUser,
  resetListings,
  resetAllData,
  saveAsProfile,
  saveSettings,
  setCachedGeo,
  setFlags,
  sourceHistory,
  stats,
  holdStatsCache,
  requestTempPassword,
  listAdminMembers,
  adminPatchMember,
  adminDeleteMember,
  adminRestoreMember,
  deleteOwnAccount,
  ADMIN_DELETE_REASONS,
  getUserById,
  findUserByEmail,
  getMailTemplates,
  changeUserPassword,
  getAdminMailSettings,
  getStoredSmtp,
  saveAdminMailSettings,
  getAdminOauthSettings,
  saveAdminOauthSettings,
  getStoredOauth,
  getAdminSponsorSettings,
  saveAdminSponsorSettings,
  publicSponsorSettings,
  getAdminAdsSettings,
  saveAdminAdsSettings,
  publicAdsSettings,
  getBrandMascot,
  saveBrandMascot,
  applyBrandUpload,
  getAdminBroadcastsSettings,
  saveAdminBroadcastsSettings,
  publicBroadcastsSettings,
  getAdminMapsSettings,
  saveAdminMapsSettings,
  getAdminProviderSettings,
  saveAdminProviderSettings,
  saveAdminSiteBudget,
  testAdminProvider,
  getAdminSimilaritySettings,
  saveAdminPhashSettings,
  reviewAdminSimilarity,
  settingsForGeoBackfill,
  listingCommutePatch,
  getMemberMailSettings,
  getMemberSmtp,
  saveMemberMailSettings,
  getHelpQa,
  saveHelpQa,
  getWishConditions,
  saveWishConditions,
  getRentalCatalog,
  saveRentalCatalog,
  getRentalCatalogDraft,
  publishRentalCatalogDraft,
  getRentalCatalogTemplates,
  saveRentalCatalogTemplate,
  renameRentalCatalogTemplate,
  deleteRentalCatalogTemplate,
  applyRentalCatalogTemplate,
  mutateRentalCatalog,
  getRentalMarketplaceFlags,
  saveRentalMarketplaceFlags,
  applyWishLifecycleFor,
  runWishLifecycleWorkerTick,
  getLegalCopy,
  saveLegalCopy,
  getSpirit,
  saveSpirit,
  getHousingData,
  saveHousingData,
  getHousingDataRaw,
  writeHousingData,
  getCrawlSources,
  saveCrawlSources,
  getSystemCrawl,
  saveSystemCrawl,
  refreshSiteCatalogStats,
  armMemberExternalFetch,
  touchLastLogin,
  resumeIdleIfNeeded,
  pauseIdleMembers,
  linkOauthIdentity,
  listDemand,
  getDemand,
  createDemand,
  closeDemand,
  replyDemand,
  reportDemandItem,
  updateWishRoomFor,
  publishWishRoomFor,
  reopenWishRoomFor,
  getWishExampleFor,
  saveWishExampleFor,
  deleteWishExampleFor,
  wishRoomOwnerSummaryFor,
  publicWishRoomView,
  demandMeta,
  submitFeedback,
  listFeedbackItems,
  updateFeedbackItem,
  getFeedbackStats,
  getOpsDeliveryControl,
  setOpsDeliveryStop,
  applyOpsSiteCommand,
  getRemoteCsControl,
  setRemoteCsStop,
  compactOpsOutbox,
  getCrmOverview,
  getCrmContact,
  createCrmContact,
  updateCrmContact,
  createCrmCase,
  updateCrmCase,
  addCrmNote,
  addCrmTodo,
  setCrmTodoDone,
  setCrmModuleEnabled,
  getCrmDeliveryControl,
  setCrmDeliveryStop,
  createCrmFromFeedback,
  feedbackMeta,
  listMineSelfListings,
  getSelfListing,
  ownerListingMatchSummary,
  ownerListingMatches,
  aggregateDemand,
  homepageDemandExposure,
  rentalMatchAdminRules,
  rentalMatchOwnerMeta,
  createWishOfferFor,
  getWishOfferFor,
  listOwnerWishOffersFor,
  listTenantWishOffersFor,
  acceptWishOfferFor,
  declineWishOfferFor,
  withdrawWishOfferFor,
  blockWishOfferFor,
  reportWishOfferFor,
  readWishOfferContactFor,
  listMyWishOfferBlocksFor,
  unblockWishOfferFor,
  listAdminWishOfferReportsFor,
  runWishOfferExpiryWorkerTick,
  getRentalNotifyPrefsFor,
  saveRentalNotifyPrefsFor,
  getMatchSubscriptionFor,
  saveMatchSubscriptionFor,
  applyUnsubscribeTokenFor,
  recordShareEventFor,
  getCompletionSurveyFor,
  submitCompletionSurveyFor,
  rentalOpsSummaryFor,
  rentalOpsDrilldownFor,
  sharePageExtrasFor,
  runRentalNotifyWorkerTick,
  createSelfListing,
  listingToolsInfo,
  copyOwnListingFor,
  publishOwnedDraftFor,
  listDescriptionTemplatesFor,
  createDescriptionTemplateFor,
  getOwnedDescriptionTemplateFor,
  updateDescriptionTemplateFor,
  deleteDescriptionTemplateFor,
  listContactProfilesFor,
  createContactProfileFor,
  getOwnedContactProfileFor,
  updateContactProfileFor,
  deleteContactProfileFor,
  listingImportMeta,
  listMineListingImports,
  getOwnedListingImport,
  startListingImportFor,
  reviewListingImportFor,
  cancelListingImportFor,
  confirmListingImportFor,
  publishConfirmedImportFor,
  listAdminListingImports,
  saveMemberMediaFor,
  listMemberMediaFor,
  deleteMemberMediaFor,
  listMediaTagsFor,
  createMediaTagFor,
  renameMediaTagFor,
  deleteMediaTagFor,
  setMediaTagsFor,
  mediaUrlsForTagIdsFor,
  assertOwnsMemberMediaUrls,
  closeSelfListing,
  hideSelfListing,
  reportSelfListing,
  selfListingMeta,
  saveUserPushSubscription,
  deleteUserPushSubscription,
  publicVapidKey,
  vapidConfigured,
  registerUserWithConsents,
  getRequiredRegistrationDocuments,
  getEffectiveDocument,
  getContentDocument,
  listContentDocuments,
  createContentDraft,
  updateContentDraft,
  publishContentDocument,
  newContentVersion,
  listContentEvents,
  listMyConsents,
  pendingMemberDocuments,
  acceptPendingDocuments,
  getOwnConsentDocument,
  DOC_TYPES,
  publicDocumentView,
  getCommsConfig,
  saveCommsConfig,
  db,
} from "./db.js";
import { currentRevision, changesSince } from "./dataRevision.js";
import {
  announcementInboxForUser,
  bannerAnnouncements,
  commsMeta,
  createAnnouncement,
  createCampaign,
  dismissAnnouncement,
  getAnnouncement,
  getCampaign,
  listAnnouncementsAdmin,
  listCampaignsAdmin,
  listingCampaigns,
  markAnnouncementRead,
  publicActiveAnnouncements,
  publicCampaignView,
  publicCommsBundle,
  publishAnnouncement,
  recordSponsoredEvent,
  supportPresentation,
  updateAnnouncement,
  updateCampaign,
} from "./comms.js";
import { renderSafeContent } from "./safeContent.js";
import { adminEmail, clearSessionCookie, envAdminConfigured, readSession, requireAuth, sessionCookie, verifyLogin } from "./auth.js";
import { boxFromRoadDescription, geocodeAddress, needsListingGeo, hasWorkPoint } from "./geo.js";
import { isTaiwanCoord } from "./geoPrecision.js";
import { listingRedirectTarget } from "./openLink.js";
import { publicListingView } from "./selfListings.js";
import { authorizedListingSources } from "./floors.js";
import {
  mimeForSelfPhoto,
  saveSelfPhoto,
  SELF_PHOTO_UPLOAD_MAX_BYTES,
  selfPhotoFilePath,
} from "./selfPhotos.js";
import { IMAGE_MAX_UPLOAD_BYTES } from "./imageProcess.js";
import { servePublicMemberMedia } from "./memberMedia.js";
import { CITIES } from "./regions.js";
import { mailConfigured, sendMail } from "./mail.js";
import { queueAccountMail } from "./systemMail.js";
import { assertHuman, issueCaptcha } from "./captcha.js";
import { assertCaptchaIssuable, assertDemoReadable, assertImportAllowed, assertPublicListingsReadable, authAttemptKeys, clientIp } from "./rateLimit.js";
import { getCachedPublicListings } from "./publicListings.js";
import { buildDemoState } from "./demo.js";
import { backfillAddressGeo, backfillIncompleteAddresses, backfillListingCoords, backfillListingMrt, backfillListingRoutes, flushPendingNotifications, isWatchIntervalPending, listingEnrichHelpers, runWatch } from "./watcher.js";
import { LIST_PAGE_SIZE, isListingGoneError, probeListingAlive } from "./client591.js";
import { probeListingAliveBySource } from "./probe.js";
import { PROBE_ALIVE, PROBE_GONE, PROBE_INCONCLUSIVE, classifyListingProbeWrite } from "./probeOutcomes.js";
import { processListingEnrichBatch, wakeListingEnrichWorker, WATCH_PRIORITY } from "./listingEnrichQueue.js";
// 2.3b 第二段：入列與點擊複查走 driver-aware 版本（PG 模式才不會寫到本機 SQLite）。
import { enqueueListingEnrichAsync, requestClickRefreshAsync } from "./listingEnrichQueueAsync.js";
import { deliveryConfigFromEnv, startDeliveryLoop } from "./opsDelivery.js";
import { startWishLifecycleLoop } from "./wishLifecycleLoop.js";
import { startWishOfferExpiryLoop } from "./wishOfferWorker.js";
import { startRentalNotifyLoop } from "./rentalNotifyWorker.js";
import { catalogDiff, isSystemCatalogTemplate, publicAdminCatalog } from "./rentalCatalog.js";
import { isRentalCatalogV2Enabled, publicRentalMarketplaceFlags } from "./rentalMarketplaceFlags.js";
import { startCrmDeliveryLoop } from "./crmDelivery.js";
import { opsDeliveryDb } from "./db.js";
import { crmOutboxOps } from "./crmOutboxAsync.js";
import { refreshHousingData } from "./housingFetch.js";
import {
  TICK_BUDGET_MS,
  createTickGate,
  humanTimeoutMessage,
  withBudget,
} from "./crawlWatchdog.js";
import { APP_NAME, APP_VERSION } from "./brand.js";
import { appendAdminAudit, listAdminAudit } from "./adminAudit.js";
import {
  adminSupportConfig,
  assertSupportCheckoutAllowed,
  createManualTransaction,
  createSupportCheckout,
  createSupportCost,
  createSupportSponsor,
  createSupportTier,
  dismissSupportCta,
  getSupportFlags,
  handleSupportCtaRequest,
  initSupportDomain,
  listCtaRules,
  listSupportCosts,
  listSupportProviders,
  listSupportSponsors,
  listSupportTiers,
  listSupportTransactions,
  previewSupportConfig,
  publicSupportConfig,
  publishSupportConfig,
  recordSupportEvent,
  saveSupportConfig,
  supportDashboard,
  updateCtaRule,
  updateSupportCost,
  updateSupportProvider,
  updateSupportSponsor,
  updateSupportTier,
  updateSupportTransaction,
  verifySupportWebhook,
} from "./support.js";
import { crawlSourceHealth, getAdminDataHealthAsync, getAdminOverviewAsync, searchAdminListings } from "./adminOverview.js";
import { commuteSettingsFingerprint, finishBackfillRequest, rememberBackfillRequest } from "./commuteState.js";
import { profileNameOrDraft, resolveWorkPointForSave } from "./settingsState.js";
import {
  OAUTH_PROVIDERS,
  OAUTH_STATE_COOKIE,
  createOauthState,
  readOauthState,
  oauthStateCookie,
  providerAuthorizeUrl,
  exchangeOauthCode,
  randomOauthPassword,
  planOauthSignup,
  planOauthSession,
} from "./oauth.js";
import { isEmailVerified } from "./emailVerify.js";
import { nicknameFromOauthName, needsProfileOnboard } from "./profile.js";
import {
  BRAND_UPLOAD_MAX_BYTES,
  mimeForBrandFile,
  saveBrandUpload,
  brandFilePath,
} from "./brandMascot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
initSupportDomain(db);
const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 5153);
const HOST = process.env.HOST || "0.0.0.0";
const INDEX_HTML = readFileSync(path.join(__dirname, "../public/index.html"));
const LOGIN_HTML = readFileSync(path.join(__dirname, "../public/login.html"));

function sendHtmlBuffer(res, buf) {
  res.status(200);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", String(buf.length));
  res.end(buf);
}

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

app.use(express.json({
  limit: "1mb",
  verify(req, _res, buf) {
    if ((req.originalUrl || req.url || "").startsWith("/api/ops/commands/apply")) {
      req.rawBody = buf.toString("utf8");
    }
  },
}));

app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: APP_VERSION });
});

app.get("/support", (_req, res) => {
  res.redirect(302, "/support.html");
});

app.get("/manifest.webmanifest", (_req, res) => {
  res.setHeader("Content-Type", "application/manifest+json");
  res.sendFile(path.join(__dirname, "../public/manifest.webmanifest"));
});

app.get("/sw.js", (_req, res) => {
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.setHeader("Service-Worker-Allowed", "/");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "../public/sw.js"));
});

app.get("/api/push/vapid", (_req, res) => {
  res.json({ publicKey: publicVapidKey(), configured: vapidConfigured() });
});

app.get("/", (_req, res) => {
  sendHtmlBuffer(res, INDEX_HTML);
});

app.get("/index.html", (_req, res) => {
  sendHtmlBuffer(res, INDEX_HTML);
});

app.get("/login.html", (_req, res) => {
  sendHtmlBuffer(res, LOGIN_HTML);
});

app.get("/api/demo", async (req, res) => {
  await yieldEventLoop();
  try {
    if (readSession(req)) {
      res.redirect(302, "/api/state");
      return;
    }
    assertDemoReadable(clientIp(req));
    res.json(buildDemoState({
      listUserIds,
      getSettings,
      defaultUserId,
      listListings,
      stats,
    }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

async function resolveGuestWorkPoint(workAddress, commuteKm) {
  const address = String(workAddress || "").trim().slice(0, 120);
  const kmRaw = Number(commuteKm);
  const km = Number.isFinite(kmRaw) ? Math.max(0, Math.min(Math.round(kmRaw * 10) / 10, 80)) : 0;
  if (!address || !(km > 0)) {
    return { workAddress: address, commuteKm: km, workLat: null, workLng: null, error: "" };
  }
  const cached = getCachedGeo(address);
  if (cached && isTaiwanCoord(cached.lat, cached.lng)) {
    return {
      workAddress: address,
      commuteKm: km,
      workLat: Number(cached.lat),
      workLng: Number(cached.lng),
      error: "",
    };
  }
  try {
    const geo = await geocodeAddress(address, getCachedGeo, {
      strict: false,
      maxAttempts: 2,
      allowAdmin: false,
    });
    if (geo?.busy) {
      return {
        workAddress: address,
        commuteKm: km,
        workLat: null,
        workLng: null,
        error: "地圖定位服務暫時忙碌，距離篩選這次沒套用。",
      };
    }
    if (geo && isTaiwanCoord(geo.lat, geo.lng)) {
      setCachedGeo(address, geo.lat, geo.lng, geo);
      return {
        workAddress: address,
        commuteKm: km,
        workLat: Number(geo.lat),
        workLng: Number(geo.lng),
        error: "",
      };
    }
  } catch {
    /* guest search never throws the member save geocode errors */
  }
  return {
    workAddress: address,
    commuteKm: km,
    workLat: null,
    workLng: null,
    error: "找不到這個上班地址，距離篩選沒有套用。請改成更完整的地址。",
  };
}

app.get("/api/public/listings", async (req, res) => {
  await yieldEventLoop();
  try {
    assertPublicListingsReadable(clientIp(req));
    const districts = String(req.query.districts || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (districts.length > GUEST_MAX_DISTRICTS) {
      const err = new Error(`訪客最多同時選 ${GUEST_MAX_DISTRICTS} 個行政區`);
      err.status = 400;
      throw err;
    }
    const work = await resolveGuestWorkPoint(req.query.workAddress, req.query.commuteKm);
    const query = {
      districts,
      kind: req.query.kind || "",
      sources: req.query.sources || "",
      q: req.query.q || "",
      sort: req.query.sort || "newest",
      limit: Number(req.query.limit) || 40,
      offset: Number(req.query.offset) || 0,
      priceMin: req.query.priceMin,
      priceMax: req.query.priceMax,
      priceMaxIncludesExtras: req.query.priceMaxIncludesExtras,
      areaMax: req.query.areaMax,
      excludeRooftop: req.query.excludeRooftop,
      excludeLowFloors: req.query.excludeLowFloors,
      minBuildingFloors: req.query.minBuildingFloors,
      wholeFloorOnly: req.query.wholeFloorOnly,
      hasParking: req.query.hasParking,
      workAddress: work.workAddress,
      commuteKm: work.commuteKm,
      workLat: work.workLat,
      workLng: work.workLng,
    };
    const listed = getCachedPublicListings(query, () => listPublicListingsFast({
      ...query,
      settings: publicSearchSettings(query),
    }));
    res.setHeader("Cache-Control", "public, max-age=15");
    res.json({
      listings: listed.listings,
      hasMore: listed.hasMore === true,
      nextOffset: listed.nextOffset || 0,
      totalMatched: listed.totalMatched,
      queryVersion: listed.queryVersion || 2,
      cache_hit: listed.cache_hit === true,
      guest: true,
      commute_error: work.error || undefined,
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

function actorUserId(req) {
  const session = readSession(req);
  if (session?.userId) return session.userId;
  return defaultUserId();
}

function sessionUserId(req) {
  return Number(readSession(req)?.userId) || 0;
}

function requireMember(req, res) {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入", login: true });
    return null;
  }
  return session;
}

function actorIsAdmin(req) {
  return readSession(req)?.role === "admin";
}

function setSession(req, res, email) {
  const cookie = sessionCookie(req, email);
  res.setHeader("Set-Cookie", cookie);
}

function listingEnrichHelpersWithEvents() {
  const base = listingEnrichHelpers();
  return {
    ...base,
    onListingUpdated: (listing, meta = {}) => {
      broadcast({
        type: "listing_updated",
        post_id: listing?.post_id,
        outcome: meta.outcome || "",
        display_ready: meta.displayReady === true,
        becoming_ready: meta.becomingReady === true,
        gone: Number(listing?.offline) === 1,
      });
    },
  };
}

function kickListingEnrich() {
  return wakeListingEnrichWorker(() =>
    processListingEnrichBatch(db, listingEnrichHelpersWithEvents(), { limit: 4 }).catch((error) => {
      console.warn("5168 補抓失敗：", error.message);
    }),
  );
}

/** 點通知／Discord 連結：已登入才標記已瀏覽，再導向原站。站內刊登：會員開站內詳情、訪客開公開分享頁。訪客只轉址、不寫入。 */
app.get("/go/:id", async (req, res) => {
  const id = Number(req.params.id);
  let listing = null;
  const session = readSession(req);
  if (Number.isFinite(id) && id > 0) {
    try {
      // Awaited so the redirect follows the store the list came from (listingDetailAsync.js).
      listing = await getListingAsync(id);
      if (session?.userId && await getListingAsync(id, session.userId)) {
        setFlags(id, { viewed: true }, session.userId);
      }
      if (listing && String(listing.source || "") === "houseprice") {
        const queued = await requestClickRefreshAsync(db, listing, "go");
        if (queued.wakeWorker) kickListingEnrich();
      }
    } catch (error) {
      console.warn("標記已瀏覽失敗：", error.message);
    }
  }
  res.redirect(302, listingRedirectTarget(listing, id, { loggedIn: Boolean(session?.userId) }));
});

app.use("/vendor", express.static(path.join(__dirname, "../public/vendor"), { maxAge: "7d" }));
app.use("/icons", express.static(path.join(__dirname, "../public/icons"), { maxAge: "7d" }));

app.get("/api/me", (req, res) => {
  const session = readSession(req);
  if (session?.userId) touchLastLogin(session.userId, { minIntervalMs: 12 * 60 * 60 * 1000 });
  const user = session?.userId ? getUserById(session.userId) : null;
  const nickname = String(user?.nickname || "").trim();
  res.json({
    ok: Boolean(session),
    email: session?.email || "",
    role: session?.role || "",
    plan: session?.plan || "",
    nickname,
    avatar_url: String(user?.avatar_url || "").trim(),
    display_name: nickname || session?.email || "",
    home_address: String(user?.home_address || "").trim(),
    company_address: String(user?.company_address || "").trim(),
    contact_phone: String(user?.contact_phone || "").trim(),
    line_id: String(user?.line_id || "").trim(),
    line_qr_url: String(user?.line_qr_url || "").trim(),
    contact_email: String(user?.contact_email || "").trim(),
    birth_date: String(user?.birth_date || "").trim(),
    gender: String(user?.gender || "").trim(),
    residence: String(user?.residence || "").trim(),
    privacy_accepted: Boolean(String(user?.profile_privacy_at || user?.accepted_disclaimer_at || "").trim()),
    needs_profile: needsProfileOnboard(user),
    privacy_text: getLegalCopy().privacy,
    disclaimer_text: getLegalCopy().disclaimer,
    privacy_check: getLegalCopy().privacyCheck,
    disclaimer_check: getLegalCopy().disclaimerCheck,
    pending_documents: session?.userId ? pendingMemberDocuments(session.userId) : [],
    consents: session?.userId ? listMyConsents(session.userId) : [],
    open_self_listings: session?.userId ? countOpenSelfListings(session.userId) : 0,
    configured: true,
    canRegister: true,
    hint: "",
    version: APP_VERSION,
    vapidPublicKey: publicVapidKey(),
    sponsor: session ? publicSponsorSettings(session) : { show: false, links: [], sponsored: false, intro: "", thanks: "" },
  });
});

app.patch("/api/profile", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    const user = updateUserProfile(session.userId, req.body || {});
    res.json({ ok: true, ...user });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/disclaimer", (_req, res) => {
  res.json(getLegalCopy());
});

app.get("/api/public/documents", (_req, res) => {
  try {
    res.json({
      types: Object.values(DOC_TYPES).map((row) => ({ id: row.id, label: row.label, required_at: row.required_at })),
      required: getRequiredRegistrationDocuments(),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/public/documents/:type", (req, res) => {
  try {
    const doc = getEffectiveDocument(req.params.type);
    if (!doc || doc.status !== "published" || !doc.enabled) {
      res.status(404).json({ error: "找不到目前有效的文件" });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json({ ...publicDocumentView(doc), html: renderSafeContent(doc.body, doc.format) });
  } catch (error) {
    res.status(error.status === 400 ? 404 : (error.status || 400)).json({ error: error.message });
  }
});

app.get("/terms.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/terms.html"));
});

app.post("/api/consents", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json({
      ok: true,
      consents: acceptPendingDocuments(session.userId, req.body?.consents, { source: "reaccept" }),
      pending_documents: pendingMemberDocuments(session.userId),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/consents", (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入" });
    return;
  }
  res.json({ items: listMyConsents(session.userId), pending_documents: pendingMemberDocuments(session.userId) });
});

app.get("/api/consents/:id/document", (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入" });
    return;
  }
  const doc = getOwnConsentDocument(session.userId, req.params.id);
  if (!doc) {
    res.status(404).json({ error: "找不到這筆同意對應的文件" });
    return;
  }
  res.json({ ...doc, html: renderSafeContent(doc.body, doc.format) });
});

app.get("/api/help-qa", (_req, res) => {
  res.json(getHelpQa());
});

function wishListQuery(req) {
  const session = readSession(req);
  const mine = String(req.query?.mine || "") === "1" && Boolean(session?.userId);
  return {
    viewerId: session?.userId || 0,
    mine,
    city: req.query?.city,
    district: req.query?.district,
    rent_min: req.query?.rent_min,
    rent_max: req.query?.rent_max,
    housing_type: req.query?.housing_type,
  };
}

function wishListPayload(req) {
  const session = readSession(req);
  const query = wishListQuery(req);
  getWishConditions();
  const posts = listDemand(query);
  return {
    ...demandMeta(),
    posts,
    rooms: posts,
    mine: query.mine ? wishRoomOwnerSummaryFor(session.userId) : undefined,
  };
}

app.get("/api/demand", (req, res) => {
  try {
    res.json(wishListPayload(req));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/wish-rooms", (req, res) => {
  try {
    res.json(wishListPayload(req));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/demand/aggregate", (req, res) => {
  try {
    const query = req.query || {};
    const districts = String(query.districts || query.district || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const conditions = String(query.conditions || query.condition || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    res.json(aggregateDemand({
      districts,
      city: query.city,
      rent_min: query.rent_min,
      rent_max: query.rent_max,
      layout: query.layout,
      housing_type: query.housing_type,
      conditions,
    }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.get("/api/demand/exposure", (req, res) => {
  try {
    res.json(homepageDemandExposure());
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.get("/api/wish-rooms/mine", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json({
      ...demandMeta(),
      ...wishRoomOwnerSummaryFor(session.userId),
      posts: listDemand({ viewerId: session.userId, mine: true }),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/wish-rooms/example", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json({ example: getWishExampleFor(session.userId) });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.put("/api/wish-rooms/example", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json({ example: saveWishExampleFor(session.userId, req.body || {}) });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.delete("/api/wish-rooms/example", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(deleteWishExampleFor(session.userId));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/demand/:id", (req, res) => {
  try {
    const session = readSession(req);
    res.json(getDemand(req.params.id, { viewerId: session?.userId || 0 }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/wish-rooms/:id", (req, res) => {
  try {
    const session = readSession(req);
    const viewerId = session?.userId || 0;
    res.json(getDemand(req.params.id, { viewerId, publicOnly: !viewerId }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/public/wish-room/:id", (req, res) => {
  try {
    const post = getDemand(req.params.id, { viewerId: 0, publicOnly: true });
    const extras = sharePageExtrasFor();
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ ...(publicWishRoomView(post) || post), ...extras });
  } catch (error) {
    res.status(error.status === 404 ? 404 : 400).json({ error: error.message });
  }
});

app.post("/api/public/wish-room/:id/share-events", (req, res) => {
  try {
    const extras = sharePageExtrasFor();
    if (!extras.share_v2) {
      res.status(404).json({ error: "分享追蹤尚未開放", code: "share_disabled" });
      return;
    }
    const post = getDemand(req.params.id, { viewerId: 0, publicOnly: true });
    const token = post?.public_token || post?.public_ref || req.params.id;
    const eventType = String(req.body?.event_type || "view");
    if (!["view", "cta"].includes(eventType)) {
      res.status(403).json({ error: "無法記錄轉換", code: "share_conversion_forbidden" });
      return;
    }
    const session = readSession(req);
    setShareCookie(res, token);
    res.json(recordShareEventFor({
      shareToken: token,
      eventType,
      userId: session?.userId || null,
      ip: clientIp(req),
      userAgent: req.get("user-agent") || "",
      source: "public",
    }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.post("/api/public/unsubscribe/:token", (req, res) => {
  try {
    res.json(applyUnsubscribeTokenFor(req.params.token));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

function captchaPayload() {
  try {
    return issueCaptcha();
  } catch {
    return null;
  }
}

function sendAuthError(res, error) {
  const body = { error: error.message };
  const captcha = captchaPayload();
  if (captcha) body.captcha = captcha;
  res.status(error.status || 400).json(body);
}

app.get("/api/captcha", (req, res) => {
  try {
    assertCaptchaIssuable(clientIp(req));
    res.json(issueCaptcha());
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/login", (req, res) => {
  const keys = authAttemptKeys(req, req.body?.email);
  try {
    assertHuman(req.body);
    const user = verifyLogin(req.body?.email, req.body?.password, { keys });
    afterMemberSession(user);
    setSession(req, res, user.email);
    res.json({ ok: true, email: user.email, role: user.role, plan: user.plan });
  } catch (error) {
    sendAuthError(res, error);
  }
});

function queueSystemMail(kind, to, vars = {}) {
  queueAccountMail({
    kind,
    to,
    vars,
    templates: getMailTemplates(),
    smtp: getStoredSmtp(),
  });
}

function publicBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim() || "https";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) return "";
  return `${proto}://${host}`;
}

app.post("/api/register", (req, res) => {
  try {
    assertHuman(req.body);
    if (!mailConfigured(getStoredSmtp())) {
      const err = new Error("尚未設定寄信，無法寄出註冊確認信。請聯絡管理員到後台填 SMTP。");
      err.status = 503;
      throw err;
    }
    const user = registerUserWithConsents({
      email: req.body?.email,
      password: req.body?.password,
      acceptDisclaimer: req.body?.acceptDisclaimer === true,
      acceptPrivacy: req.body?.acceptPrivacy,
      consents: req.body?.consents,
      emailVerified: false,
    });
    const issued = issueVerifyToken(user.id);
    const base = publicBaseUrl(req);
    queueSystemMail("welcome", user.email, {
      verifyUrl: `${base}/verify-email?token=${encodeURIComponent(issued.token)}`,
    });
    res.json({
      ok: true,
      pending: true,
      email: user.email,
      message: "請到信箱點確認連結才算註冊成功。連結只能用一次，3 天內未點會失效。",
    });
  } catch (error) {
    sendAuthError(res, error);
  }
});

function cookieNamed(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const value = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return "";
}

function afterMemberSession(user) {
  const id = Number(user?.id) || 0;
  if (!id) return;
  touchLastLogin(id);
  resumeIdleIfNeeded(id);
}

function shareTokenFrom(req) {
  return String(cookieNamed(req, "jr_share") || "").trim();
}

function setShareCookie(res, token) {
  const raw = String(token || "").trim();
  if (!raw || /^\d+$/.test(raw)) return;
  res.append("Set-Cookie", `jr_share=${encodeURIComponent(raw)}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax`);
}

function attributeShare(req, userId, eventType) {
  const token = shareTokenFrom(req);
  if (!token || !userId) return;
  try {
    recordShareEventFor({
      shareToken: token,
      eventType,
      userId,
      ip: clientIp(req),
      userAgent: req.get("user-agent") || "",
      source: "server",
    });
  } catch { /* attribution never blocks */ }
}

app.get("/verify-email", (req, res) => {
  try {
    const user = confirmVerifyToken(String(req.query?.token || ""));
    afterMemberSession(user);
    attributeShare(req, user.id, "signup");
    setSession(req, res, user.email);
    const base = publicBaseUrl(req);
    try {
      queueSystemMail("verified_welcome", user.email, {
        spiritUrl: `${base}/spirit.html`,
      });
    } catch (error) {
      console.warn("開通歡迎信排隊失敗：", error?.message || error);
    }
    res.redirect(303, "/?welcome=1");
  } catch (error) {
    const code = error.code === "expired" ? "expired" : error.code === "used" ? "used" : error.code === "missing" ? "missing" : "invalid";
    res.redirect(303, `/login.html?verify=${code}`);
  }
});

app.get("/api/oauth", (_req, res) => {
  res.json(getAdminOauthSettings());
});

app.get("/auth/:provider", (req, res) => {
  try {
    const provider = String(req.params.provider || "");
    if (!OAUTH_PROVIDERS.includes(provider)) {
      const err = new Error("不支援的登入方式");
      err.status = 404;
      throw err;
    }
    const cfg = getStoredOauth()[provider];
    if (!cfg?.enabled || !cfg.clientId || !cfg.clientSecret) {
      const err = new Error("管理員尚未開通這個社群登入");
      err.status = 503;
      throw err;
    }
    const accept = String(req.query.accept || "") === "1";
    const consents = accept ? getRequiredRegistrationDocuments() : [];
    const state = createOauthState({ provider, accept, consents });
    const base = publicBaseUrl(req);
    const redirectUri = `${base}/auth/${provider}/callback`;
    const url = providerAuthorizeUrl(provider, { clientId: cfg.clientId, redirectUri, state });
    res.setHeader("Set-Cookie", oauthStateCookie(req, state));
    res.redirect(302, url);
  } catch (error) {
    res.redirect(303, `/login.html?oauth=${encodeURIComponent(error.message || "授權失敗")}`);
  }
});

app.get("/auth/:provider/callback", async (req, res) => {
  try {
    const provider = String(req.params.provider || "");
    const state = readOauthState(cookieNamed(req, OAUTH_STATE_COOKIE) || String(req.query.state || ""));
    if (!state || state.provider !== provider) {
      const err = new Error("授權已過期，請再試一次");
      err.status = 400;
      throw err;
    }
    if (req.query.error) {
      const err = new Error("已取消社群登入");
      err.status = 400;
      throw err;
    }
    const cfg = getStoredOauth()[provider];
    const base = publicBaseUrl(req);
    const redirectUri = `${base}/auth/${provider}/callback`;
    const profile = await exchangeOauthCode(provider, {
      code: String(req.query.code || ""),
      redirectUri,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
    });
    let user = findUserByEmail(profile.email);
    const signup = planOauthSignup({ user, accept: state.accept === true });
    const oauthIsNewRegister = signup.action === "register";
    if (signup.action === "closed") {
      const err = new Error("這個 Email 的帳號已關閉");
      err.status = 409;
      throw err;
    }
    if (signup.action === "need_accept") {
      res.redirect(303, `/login.html?register=1&oauth=${encodeURIComponent("請先勾選免責與個資說明，再用社群帳號註冊")}`);
      return;
    }
    if (signup.action === "register") {
      if (!mailConfigured(getStoredSmtp())) {
        const err = new Error("尚未設定寄信，無法完成社群註冊開通信。請聯絡管理員到後台填 SMTP。");
        err.status = 503;
        throw err;
      }
      user = registerUserWithConsents({
        email: profile.email,
        password: randomOauthPassword(),
        acceptDisclaimer: true,
        acceptPrivacy: true,
        consents: state.consents,
        emailVerified: false,
      });
    }
    linkOauthIdentity(user.id, { provider, subject: profile.subject });
    if (!String(user.nickname || "").trim()) {
      const nick = nicknameFromOauthName(profile.name);
      if (nick) {
        try {
          updateUserProfile(user.id, { nickname: nick });
          user = { ...user, nickname: nick };
        } catch {
          // 顯示名不合暱稱規則就略過，不擋開通信
        }
      }
    }
    if (planOauthSession(user, { verified: isEmailVerified(user) }).action === "pending_verify") {
      if (!mailConfigured(getStoredSmtp())) {
        const err = new Error("尚未設定寄信，無法寄出開通信。請改用信箱註冊或聯絡管理員。");
        err.status = 503;
        throw err;
      }
      const issued = issueVerifyToken(user.id);
      queueSystemMail("welcome", user.email, {
        verifyUrl: `${base}/verify-email?token=${encodeURIComponent(issued.token)}`,
      });
      res.setHeader("Set-Cookie", oauthStateCookie(req, "", { clear: true }));
      res.redirect(303, `/login.html?oauth=pending&email=${encodeURIComponent(user.email)}`);
      return;
    }
    afterMemberSession(user);
    if (oauthIsNewRegister) attributeShare(req, user.id, "signup");
    res.setHeader("Set-Cookie", [
      oauthStateCookie(req, "", { clear: true }),
      sessionCookie(req, user.email),
    ]);
    res.redirect(303, "/");
  } catch (error) {
    res.setHeader("Set-Cookie", oauthStateCookie(req, "", { clear: true }));
    res.redirect(303, `/login.html?oauth=${encodeURIComponent(error.message || "授權失敗")}`);
  }
});

app.post("/api/forgot-password", async (req, res) => {
  try {
    assertHuman(req.body);
    const result = await requestTempPassword(req.body?.email);
    res.json({ ...result, captcha: captchaPayload() });
  } catch (error) {
    sendAuthError(res, error);
  }
});

function sendLogout(req, res) {
  res.setHeader("Set-Cookie", clearSessionCookie(req));
}

app.post("/api/logout", (req, res) => {
  sendLogout(req, res);
  res.json({ ok: true });
});

app.get("/logout", (req, res) => {
  sendLogout(req, res);
  res.redirect(303, "/login.html?logout=1");
});

app.post("/api/ops/commands/apply", (req, res) => {
  const result = applyOpsSiteCommand(req.headers, req.rawBody || JSON.stringify(req.body || {}));
  res.status(result.httpStatus).json(result.body);
});

app.use(requireAuth);

function requireAdminApi(req, res, next) {
  if (actorIsAdmin(req)) return next();
  res.status(403).json({ error: "只有管理員可以做這個" });
}

function auditReq(req, action, target, before, after) {
  try {
    const session = readSession(req);
    appendAdminAudit({
      actorId: session?.userId,
      actorEmail: session?.email,
      action,
      target,
      before,
      after,
    });
  } catch {
    // 稽核失敗不得擋住管理操作
  }
}

app.get("/admin.html", (req, res, next) => {
  if (!actorIsAdmin(req)) {
    res.redirect("/");
    return;
  }
  next();
});

app.get("/api/admin/members", requireAdminApi, (req, res) => {
  const members = listAdminMembers({
    q: req.query?.q,
    sort: req.query?.sort,
    order: req.query?.order,
  });
  const payload = { members, deleteReasons: ADMIN_DELETE_REASONS };
  if (/password_hash|"password"|scrypt:/.test(JSON.stringify(payload))) {
    res.status(500).json({ error: "會員列表不得含密碼" });
    return;
  }
  res.json(payload);
});

app.post("/api/admin/members/:id/delete", requireAdminApi, (req, res) => {
  try {
    const result = adminDeleteMember(req.params.id, {
      reasonCode: req.body?.reasonCode,
      reasonText: req.body?.reasonText,
    });
    schedule();
    queueSystemMail("account_deleted", result.member.email, { reason: result.reason.text || result.reason.label });
    auditReq(req, "member_delete", result.member.email, { id: result.member.id }, { deleted: true });
    res.json({ member: result.member, reason: result.reason });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/members/:id/restore", requireAdminApi, (req, res) => {
  try {
    const member = adminRestoreMember(req.params.id);
    schedule();
    res.json({ member });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/account/delete", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      const err = new Error("請先登入");
      err.status = 401;
      throw err;
    }
    deleteOwnAccount(session.userId, req.body?.reason);
    schedule();
    sendLogout(req, res);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.patch("/api/admin/members/:id", requireAdminApi, (req, res) => {
  try {
    const before = getUserById(req.params.id);
    const member = adminPatchMember(req.params.id, req.body || {});
    schedule();
    if ((before?.plan || "free") !== "sponsor" && member.plan === "sponsor") {
      queueSystemMail("sponsor_thanks", member.email);
    }
    res.json({ member });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/mail", requireAdminApi, (_req, res) => {
  res.json(getAdminMailSettings());
});

app.put("/api/admin/mail", requireAdminApi, (req, res) => {
  try {
    res.json(saveAdminMailSettings(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/oauth", requireAdminApi, (_req, res) => {
  res.json(getAdminOauthSettings());
});

app.put("/api/admin/oauth", requireAdminApi, (req, res) => {
  try {
    res.json(saveAdminOauthSettings(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/sponsor", requireAdminApi, (_req, res) => {
  res.json(getAdminSponsorSettings());
});

app.put("/api/admin/sponsor", requireAdminApi, (req, res) => {
  try {
    res.json(saveAdminSponsorSettings(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/ads", requireAdminApi, (_req, res) => {
  res.json(getAdminAdsSettings());
});

app.put("/api/admin/ads", requireAdminApi, (req, res) => {
  try {
    res.json(saveAdminAdsSettings(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/ads", (_req, res) => {
  res.json(publicAdsSettings());
});

app.get("/api/brand", (_req, res) => {
  res.json(getBrandMascot());
});

app.get("/api/admin/brand", requireAdminApi, (_req, res) => {
  res.json(getBrandMascot());
});

app.put("/api/admin/brand", requireAdminApi, (req, res) => {
  try {
    res.json(saveBrandMascot(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/brand/file", requireAdminApi, express.raw({ type: () => true, limit: BRAND_UPLOAD_MAX_BYTES }), (req, res) => {
  try {
    const upload = saveBrandUpload(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    const slot = String(req.query.slot || req.headers["x-brand-slot"] || "").trim();
    res.json({ ...upload, brand: applyBrandUpload(slot, upload) });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/media/brand/:file", (req, res) => {
  const full = brandFilePath(req.params.file);
  if (!full) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", mimeForBrandFile(req.params.file));
  res.setHeader("Cache-Control", "public, max-age=604800");
  res.sendFile(path.resolve(full));
});

app.get("/api/admin/broadcasts", requireAdminApi, (_req, res) => {
  res.json(getAdminBroadcastsSettings());
});

app.put("/api/admin/broadcasts", requireAdminApi, (req, res) => {
  try {
    res.json(saveAdminBroadcastsSettings(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/broadcasts", (_req, res) => {
  res.json({ items: publicBroadcastsSettings() });
});

function commsActor(req) {
  return readSession(req)?.userId || 0;
}

function sendCommsError(res, error) {
  res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
}

app.get("/api/admin/announcements", requireAdminApi, (_req, res) => {
  res.json({ items: listAnnouncementsAdmin(db), meta: commsMeta() });
});

app.post("/api/admin/announcements", requireAdminApi, (req, res) => {
  try {
    res.status(201).json(createAnnouncement(db, commsActor(req), req.body || {}));
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.patch("/api/admin/announcements/:id", requireAdminApi, (req, res) => {
  try {
    res.json(updateAnnouncement(db, commsActor(req), Number(req.params.id), req.body || {}));
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.post("/api/admin/announcements/:id/publish", requireAdminApi, (req, res) => {
  try {
    const published = publishAnnouncement(db, commsActor(req), Number(req.params.id));
    auditReq(req, "announcement_publish", published?.title || req.params.id, { status: "draft" }, { status: "published" });
    res.json(published);
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.get("/api/admin/campaigns", requireAdminApi, (_req, res) => {
  res.json({ items: listCampaignsAdmin(db), config: getCommsConfig(), meta: commsMeta() });
});

app.post("/api/admin/campaigns", requireAdminApi, (req, res) => {
  try {
    res.status(201).json(createCampaign(db, commsActor(req), req.body || {}));
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.patch("/api/admin/campaigns/:id", requireAdminApi, (req, res) => {
  try {
    res.json(updateCampaign(db, commsActor(req), Number(req.params.id), req.body || {}));
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.get("/api/admin/comms-config", requireAdminApi, (_req, res) => {
  res.json({ config: getCommsConfig(), meta: commsMeta() });
});

app.put("/api/admin/comms-config", requireAdminApi, (req, res) => {
  try {
    res.json({ config: saveCommsConfig(req.body || {}), meta: commsMeta() });
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.get("/api/announcements", (_req, res) => {
  res.json({ items: publicActiveAnnouncements(db), banner: bannerAnnouncements(db) });
});

app.get("/api/announcements/inbox", (req, res) => {
  const session = readSession(req);
  res.json({ items: announcementInboxForUser(db, session?.userId || null) });
});

app.post("/api/announcements/:id/read", (req, res) => {
  const session = readSession(req);
  res.json(markAnnouncementRead(db, session?.userId || null, Number(req.params.id)));
});

app.post("/api/announcements/:id/dismiss", (req, res) => {
  const session = readSession(req);
  res.json(dismissAnnouncement(db, session?.userId || null, Number(req.params.id)));
});

app.get("/api/sponsored", (_req, res) => {
  const config = getCommsConfig();
  res.json({
    interval: config.listing_ad_interval,
    listing_enabled: config.sponsored_master_enabled && config.listing_placement_enabled,
    session_cap: 3,
    cards: listingCampaigns(db, config).map((row) => publicCampaignView(row)),
  });
});

app.post("/api/sponsored/:id/event", (req, res) => {
  try {
    const kind = String(req.body?.kind || "");
    const placement = String(req.body?.placement || "listing");
    res.json(recordSponsoredEvent(db, Number(req.params.id), kind, placement));
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.get("/api/comms", (req, res) => {
  const session = readSession(req);
  // 支持方式（後台「贊助連結」）是公開資訊：未登入訪客也要拿得到，才不會在「支持本站」看到死路。
  const publicSponsorOffer = publicSponsorSettings({});
  res.json(publicCommsBundle(db, {
    config: getCommsConfig(),
    sponsorOffer: session ? publicSponsorSettings(session) : {},
    sponsorLinks: publicSponsorOffer.links,
    user: session ? { id: session.userId, plan: session.plan, role: session.role } : {},
  }));
});

function sendSupportError(res, error) {
  res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
}

function publicSupportFallback() {
  return {
    enabled: false,
    flags: getSupportFlags(db),
    entry: { show: false, label: "支持本站", href: "/support.html" },
    cta: { enabled: false },
  };
}

app.get("/api/support/public", (_req, res) => {
  try {
    res.json(publicSupportConfig(db));
  } catch {
    res.json(publicSupportFallback());
  }
});

app.get("/api/support/tiers", (_req, res) => {
  try {
    const pub = publicSupportConfig(db);
    res.json({ items: pub.tiers || [] });
  } catch {
    res.json({ items: [] });
  }
});

app.post("/api/support/checkout", async (req, res) => {
  try {
    assertSupportCheckoutAllowed(clientIp(req));
    const result = await createSupportCheckout(db, {
      tierId: req.body?.tierId,
      amount: req.body?.amount,
    });
    const session = readSession(req);
    recordSupportEvent(db, "support_checkout_opened", {
      userId: session?.userId || null,
      meta: { tierId: req.body?.tierId },
    });
    res.json(result);
  } catch (error) {
    if (error.code === "RATE_LIMITED") {
      res.status(429).json({ available: false, message: error.message, code: error.code });
      return;
    }
    res.json({ available: false, message: "目前支持付款服務暫時無法使用，稍後再試即可。" });
  }
});

app.post("/api/support/cta", (req, res) => {
  try {
    const session = readSession(req);
    const result = handleSupportCtaRequest(db, {
      userId: session?.userId || null,
      usage: req.body?.usage,
      clientState: req.body?.clientState,
    });
    res.json(result);
  } catch {
    res.json({ show: false, reason: "unavailable" });
  }
});

app.post("/api/support/cta/dismiss", (req, res) => {
  try {
    const session = readSession(req);
    const state = dismissSupportCta(db, {
      userId: session?.userId || null,
      days: req.body?.days,
      clientState: req.body?.clientState,
    });
    recordSupportEvent(db, "support_cta_dismissed", {
      userId: session?.userId || null,
      meta: { days: req.body?.days },
    });
    res.json({ ok: true, state });
  } catch {
    res.json({ ok: true, state: req.body?.clientState || {} });
  }
});

app.post("/api/support/event", (req, res) => {
  try {
    const session = readSession(req);
    res.json(recordSupportEvent(db, String(req.body?.kind || ""), {
      userId: session?.userId || null,
      guestKey: String(req.body?.guestKey || "").slice(0, 80),
      meta: req.body?.meta,
    }));
  } catch {
    res.json({ ok: false });
  }
});

app.post("/api/support/webhook/:provider", async (req, res) => {
  try {
    const result = await verifySupportWebhook(req.params.provider, req.body, req.headers);
    res.status(result.ok ? 200 : 501).json(result);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/dashboard", requireAdminApi, (req, res) => {
  try {
    res.json(supportDashboard(db, {
      period: String(req.query.period || "month"),
      from: req.query.from,
      to: req.query.to,
    }));
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/config", requireAdminApi, (_req, res) => {
  res.json(adminSupportConfig(db));
});

app.get("/api/admin/support/preview", requireAdminApi, (_req, res) => {
  res.json(previewSupportConfig(db));
});

app.put("/api/admin/support/config", requireAdminApi, (req, res) => {
  try {
    const before = adminSupportConfig(db);
    const after = saveSupportConfig(db, req.body || {});
    auditReq(req, "support.config.update", "support_page_config", before, after);
    res.json(after);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.post("/api/admin/support/config/publish", requireAdminApi, (req, res) => {
  try {
    const before = adminSupportConfig(db);
    const after = publishSupportConfig(db);
    auditReq(req, "support.page.publish", "support_page_config", before, after);
    res.json(after);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/costs", requireAdminApi, (_req, res) => {
  res.json({ items: listSupportCosts(db) });
});

app.post("/api/admin/support/costs", requireAdminApi, (req, res) => {
  try {
    const row = createSupportCost(db, req.body || {});
    auditReq(req, "support.cost.create", `support_operating_cost:${row.id}`, null, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.put("/api/admin/support/costs/:id", requireAdminApi, (req, res) => {
  try {
    const before = listSupportCosts(db).find((row) => Number(row.id) === Number(req.params.id));
    const row = updateSupportCost(db, Number(req.params.id), req.body || {});
    auditReq(req, "support.cost.update", `support_operating_cost:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/tiers", requireAdminApi, (_req, res) => {
  res.json({ items: listSupportTiers(db) });
});

app.post("/api/admin/support/tiers", requireAdminApi, (req, res) => {
  try {
    const row = createSupportTier(db, req.body || {});
    auditReq(req, "support.tier.create", `support_tier:${row.id}`, null, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.put("/api/admin/support/tiers/:id", requireAdminApi, (req, res) => {
  try {
    const before = listSupportTiers(db).find((row) => Number(row.id) === Number(req.params.id));
    const row = updateSupportTier(db, Number(req.params.id), req.body || {});
    auditReq(req, "support.tier.update", `support_tier:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/providers", requireAdminApi, (_req, res) => {
  res.json({ items: listSupportProviders(db) });
});

app.put("/api/admin/support/providers/:id", requireAdminApi, (req, res) => {
  try {
    const before = listSupportProviders(db).find((row) => Number(row.id) === Number(req.params.id));
    const row = updateSupportProvider(db, Number(req.params.id), req.body || {});
    auditReq(req, before?.page_url !== row.page_url ? "support.checkout_url.update" : "support.provider.update", `support_provider:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/transactions", requireAdminApi, (req, res) => {
  res.json({
    items: listSupportTransactions(db, { from: req.query.from, to: req.query.to }),
  });
});

app.post("/api/admin/support/transactions/manual", requireAdminApi, (req, res) => {
  try {
    const row = createManualTransaction(db, req.body || {});
    auditReq(req, "support.transaction.manual", `support_transaction:${row.id}`, null, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.put("/api/admin/support/transactions/:id", requireAdminApi, (req, res) => {
  try {
    const before = listSupportTransactions(db).find((row) => Number(row.id) === Number(req.params.id));
    const row = updateSupportTransaction(db, Number(req.params.id), req.body || {});
    const action = row.status === "refunded" ? "support.transaction.refund" : "support.transaction.update";
    auditReq(req, action, `support_transaction:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/sponsors", requireAdminApi, (_req, res) => {
  res.json({ items: listSupportSponsors(db) });
});

app.post("/api/admin/support/sponsors", requireAdminApi, (req, res) => {
  try {
    const row = createSupportSponsor(db, req.body || {});
    auditReq(req, "support.sponsor.create", `support_sponsor:${row.id}`, null, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.put("/api/admin/support/sponsors/:id", requireAdminApi, (req, res) => {
  try {
    const before = listSupportSponsors(db).find((row) => Number(row.id) === Number(req.params.id));
    const row = updateSupportSponsor(db, Number(req.params.id), req.body || {});
    const action = ["active", "disabled"].includes(row.status) ? "support.sponsor.publish" : "support.sponsor.update";
    auditReq(req, action, `support_sponsor:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/cta-rules", requireAdminApi, (_req, res) => {
  res.json({ items: listCtaRules(db) });
});

app.put("/api/admin/support/cta-rules/:id", requireAdminApi, (req, res) => {
  try {
    const before = listCtaRules(db).find((row) => Number(row.id) === Number(req.params.id));
    const row = updateCtaRule(db, Number(req.params.id), req.body || {});
    auditReq(req, "support.cta.update", `support_cta_rule:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/help-qa", requireAdminApi, (_req, res) => {
  res.json(getHelpQa());
});

app.put("/api/admin/help-qa", requireAdminApi, (req, res) => {
  try {
    res.json(saveHelpQa(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/wish-conditions", requireAdminApi, (_req, res) => {
  res.json(getWishConditions());
});

app.put("/api/admin/wish-conditions", requireAdminApi, (req, res) => {
  try {
    res.json(saveWishConditions(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/rental-catalog", requireAdminApi, (_req, res) => {
  const published = getRentalCatalog();
  const draft = getRentalCatalogDraft();
  res.json({
    published: publicAdminCatalog(published, { revealIds: true }),
    draft,
    diff: draft ? catalogDiff(published, draft) : null,
    templates: getRentalCatalogTemplates().map((row) => ({
      id: row.id,
      label: row.label,
      system: isSystemCatalogTemplate(row.id),
    })),
    flags: publicRentalMarketplaceFlags(getRentalMarketplaceFlags()),
  });
});

app.put("/api/admin/rental-catalog", requireAdminApi, (req, res) => {
  try {
    res.json(saveRentalCatalog(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/rental-catalog/mutate", requireAdminApi, (req, res) => {
  try {
    res.json(mutateRentalCatalog(req.body?.action, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/rental-catalog/templates", requireAdminApi, (req, res) => {
  try {
    res.json(saveRentalCatalogTemplate(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.patch("/api/admin/rental-catalog/templates/:id", requireAdminApi, (req, res) => {
  try {
    res.json(renameRentalCatalogTemplate(req.params.id, req.body?.label));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.delete("/api/admin/rental-catalog/templates/:id", requireAdminApi, (req, res) => {
  try {
    res.json(deleteRentalCatalogTemplate(req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/rental-catalog/templates/:id/apply", requireAdminApi, (req, res) => {
  try {
    res.json(applyRentalCatalogTemplate(req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/rental-catalog/draft/publish", requireAdminApi, (_req, res) => {
  try {
    res.json(publishRentalCatalogDraft());
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/rental-marketplace-flags", requireAdminApi, (_req, res) => {
  res.json(publicRentalMarketplaceFlags(getRentalMarketplaceFlags()));
});

app.put("/api/admin/rental-marketplace-flags", requireAdminApi, (req, res) => {
  try {
    res.json(saveRentalMarketplaceFlags(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/rental-match-rules", requireAdminApi, (_req, res) => {
  res.json(rentalMatchAdminRules());
});

app.get("/api/admin/wish-offer-reports", requireAdminApi, (_req, res) => {
  res.json(listAdminWishOfferReportsFor());
});

app.get("/api/admin/feedback", requireAdminApi, (req, res) => {
  res.json({
    ...feedbackMeta(),
    stats: getFeedbackStats(),
    items: listFeedbackItems({ status: req.query?.status, kind: req.query?.kind }),
    ops_delivery: getOpsDeliveryControl(),
  });
});

app.patch("/api/admin/feedback/:id", requireAdminApi, (req, res) => {
  try {
    res.json(updateFeedbackItem(req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/ops-delivery", requireAdminApi, (_req, res) => {
  res.json(getOpsDeliveryControl());
});

app.put("/api/admin/ops-delivery", requireAdminApi, (req, res) => {
  const stop = req.body?.stop === true || req.body?.stop === 1 || req.body?.stop === "1";
  res.json(setOpsDeliveryStop(stop));
});

app.get("/api/admin/remote-cs", requireAdminApi, (_req, res) => {
  res.json(getRemoteCsControl());
});

app.put("/api/admin/remote-cs", requireAdminApi, (req, res) => {
  const stop = req.body?.stop === true || req.body?.stop === 1 || req.body?.stop === "1";
  res.json(setRemoteCsStop(stop));
});

app.post("/api/admin/ops-delivery/compact-outbox", requireAdminApi, (req, res) => {
  const olderThanMs = Number(req.body?.older_than_ms);
  res.json({ ok: true, ...compactOpsOutbox({ olderThanMs: Number.isFinite(olderThanMs) && olderThanMs >= 0 ? olderThanMs : undefined }) });
});

app.get("/api/admin/crm", requireAdminApi, async (req, res) => {
  try {
      res.json({
        ...(await await getCrmOverview({ q: req.query?.q })),
        sync: await getCrmDeliveryControl(),
      });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.put("/api/admin/crm/module", requireAdminApi, async (req, res) => {
  const enabled = !(req.body?.enabled === false || req.body?.enabled === 0 || req.body?.enabled === "0");
  res.json({ module: await setCrmModuleEnabled(enabled), sync: await getCrmDeliveryControl() });
});

app.put("/api/admin/crm/sync", requireAdminApi, async (req, res) => {
  const stop = req.body?.stop === true || req.body?.stop === 1 || req.body?.stop === "1";
  res.json(await setCrmDeliveryStop(stop));
});

app.get("/api/admin/crm/contacts/:id", requireAdminApi, async (req, res) => {
  try {
      try {
        res.json(await await getCrmContact(req.params.id));
      } catch (error) {
        res.status(error.status || 400).json({ error: error.message });
      }
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post("/api/admin/crm/contacts", requireAdminApi, async (req, res) => {
  try {
    res.status(201).json(await createCrmContact(req.body || {}, { actorUserId: actorUserId(req) }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.patch("/api/admin/crm/contacts/:id", requireAdminApi, async (req, res) => {
  try {
    res.json(await updateCrmContact(req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/contacts/:id/cases", requireAdminApi, async (req, res) => {
  try {
    res.status(201).json(await createCrmCase(req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.patch("/api/admin/crm/cases/:id", requireAdminApi, async (req, res) => {
  try {
    res.json(await updateCrmCase(req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/contacts/:id/notes", requireAdminApi, async (req, res) => {
  try {
    res.status(201).json(await addCrmNote(req.params.id, req.body || {}, { actorUserId: actorUserId(req) }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/contacts/:id/todos", requireAdminApi, async (req, res) => {
  try {
    res.status(201).json(await addCrmTodo(req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/todos/:id/done", requireAdminApi, async (req, res) => {
  try {
    res.json(await setCrmTodoDone(req.params.id, req.body?.done !== false));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/from-feedback/:id", requireAdminApi, async (req, res) => {
  try {
    res.status(201).json(await createCrmFromFeedback(req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/spirit", (_req, res) => {
  res.json(getSpirit());
});

app.get("/api/housing-data", (_req, res) => {
  res.json(getHousingData());
});

app.get("/api/admin/housing-data", requireAdminApi, (_req, res) => {
  res.json(getHousingData());
});

app.put("/api/admin/housing-data", requireAdminApi, (req, res) => {
  try {
    res.json(saveHousingData(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/housing-data/refresh", requireAdminApi, async (_req, res) => {
  try {
    const summary = await refreshHousingData({ getData: getHousingDataRaw, writeData: writeHousingData });
    res.json({ ok: true, ...summary, data: getHousingData() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/admin/spirit", requireAdminApi, (_req, res) => {
  res.json(getSpirit());
});

app.put("/api/admin/spirit", requireAdminApi, (req, res) => {
  try {
    res.json(saveSpirit(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/legal-copy", requireAdminApi, (_req, res) => {
  res.json(getLegalCopy());
});

app.put("/api/admin/legal-copy", requireAdminApi, (req, res) => {
  try {
    res.json(saveLegalCopy(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/documents", requireAdminApi, (req, res) => {
  res.json({
    types: Object.values(DOC_TYPES),
    items: listContentDocuments({ type: req.query?.type, includeDrafts: true }),
  });
});

app.get("/api/admin/documents/:id/events", requireAdminApi, (req, res) => {
  res.json({ items: listContentEvents({ documentId: req.params.id }) });
});

app.get("/api/admin/documents/:id", requireAdminApi, (req, res) => {
  const doc = getContentDocument(req.params.id);
  if (!doc) {
    res.status(404).json({ error: "找不到文件" });
    return;
  }
  res.json({ ...doc, html: renderSafeContent(doc.body, doc.format), events: listContentEvents({ documentId: doc.id }) });
});

app.post("/api/admin/documents", requireAdminApi, (req, res) => {
  try {
    const session = readSession(req);
    res.status(201).json(createContentDraft(req.body || {}, { actorId: session?.userId || 0 }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.patch("/api/admin/documents/:id", requireAdminApi, (req, res) => {
  try {
    const session = readSession(req);
    res.json(updateContentDraft(req.params.id, req.body || {}, { actorId: session?.userId || 0 }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/documents/:id/publish", requireAdminApi, (req, res) => {
  try {
    const session = readSession(req);
    res.json(publishContentDocument(req.params.id, { actorId: session?.userId || 0 }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/documents/:id/new-version", requireAdminApi, (req, res) => {
  try {
    const session = readSession(req);
    res.status(201).json(newContentVersion(req.params.id, { actorId: session?.userId || 0 }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/providers", requireAdminApi, async (_req, res) => {
  try {
    res.json(await getAdminProviderSettings());
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法讀取外掛設定" });
  }
});

app.put("/api/admin/providers/site-budget", requireAdminApi, async (req, res) => {
  try {
    const saved = await saveAdminSiteBudget(req.body || {});
    res.json({ ok: true, ...saved, overview: await getAdminProviderSettings() });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.put("/api/admin/providers", requireAdminApi, async (req, res) => {
  try {
    const item = await saveAdminProviderSettings(req.body || {});
    res.json({ ok: true, item, overview: await getAdminProviderSettings() });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/providers/test", requireAdminApi, async (req, res) => {
  try {
    res.json(await testAdminProvider(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/providers/usage", requireAdminApi, async (_req, res) => {
  try {
    res.json(await getAdminProviderSettings());
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法讀取用量" });
  }
});

app.get("/api/admin/similarity", requireAdminApi, async (_req, res) => {
  try {
    res.json(await getAdminSimilaritySettings());
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.put("/api/admin/phash", requireAdminApi, async (req, res) => {
  try {
    const saved = await saveAdminPhashSettings(req.body || {});
    res.json({ ok: true, ...saved, overview: await getAdminSimilaritySettings() });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/similarity/:id/review", requireAdminApi, async (req, res) => {
  try {
    res.json({
      ok: true,
      item: await reviewAdminSimilarity(req.params.id, req.body || {}, actorUserId(req)),
      overview: await getAdminSimilaritySettings(),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/maps", requireAdminApi, (_req, res) => {
  res.json(getAdminMapsSettings());
});

app.put("/api/admin/maps", requireAdminApi, (req, res) => {
  try {
    const body = req.body || {};
    const before = getAdminMapsSettings();
    const settings = saveAdminMapsSettings(body);
    if (settings.enabled && body.clearKey !== true) queueGeoBackfill();
    auditReq(req, body.clearKey === true ? "maps_clear_key" : "maps_save", "maps", {
      googleEnabled: before.googleEnabled,
      hasKey: before.hasKey,
    }, {
      googleEnabled: settings.googleEnabled,
      hasKey: settings.hasKey,
    });
    res.json(settings);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/crawl-sources", requireAdminApi, (_req, res) => {
  const base = getCrawlSources();
  const health = Object.fromEntries(crawlSourceHealth().map((row) => [row.id, row]));
  res.json({
    items: (base.items || []).map((row) => ({ ...health[row.id], ...row, label: row.label })),
  });
});

app.put("/api/admin/crawl-sources", requireAdminApi, (req, res) => {
  try {
    const before = getCrawlSources();
    const saved = saveCrawlSources(req.body || {});
    auditReq(req, "crawl_sources_save", "crawl-sources", before.items, saved.items);
    res.json(saved);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/system-crawl", requireAdminApi, (_req, res) => {
  res.json({ ...getSystemCrawl(), catalog: refreshSiteCatalogStats() });
});

app.put("/api/admin/system-crawl", requireAdminApi, (req, res) => {
  try {
    res.json(saveSystemCrawl(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/same-house/reconcile", requireAdminApi, (_req, res) => {
  res.json({
    ...sameHouseBackfillStatus(),
    note: "POST 此路徑執行一批歷史 reconciliation，可中斷續跑。",
  });
});

app.post("/api/admin/same-house/reconcile", requireAdminApi, (req, res) => {
  try {
    const result = runSameHouseBackfill({
      limit: Number(req.body?.limit) || 50,
      cursor: req.body?.cursor,
    });
    auditReq(req, "same_house_reconcile", `limit=${Number(req.body?.limit) || 50}`, null, {
      scanned: result.scanned,
      auto_confirmed: result.auto_confirmed,
      suspected: result.suspected,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/overview", requireAdminApi, async (_req, res) => {
  try {
    res.json(await getAdminOverviewAsync());
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法讀取後台總覽" });
  }
});

app.get("/api/admin/data-health", requireAdminApi, async (_req, res) => {
  try {
    res.json(await getAdminDataHealthAsync());
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法讀取資料健康度" });
  }
});

app.get("/api/admin/audit", requireAdminApi, (req, res) => {
  res.json({ items: listAdminAudit({ limit: Number(req.query?.limit) || 80 }) });
});

app.get("/api/admin/listings/search", requireAdminApi, (req, res) => {
  res.json({ items: searchAdminListings(req.query?.q, Number(req.query?.limit) || 20) });
});

app.post("/api/admin/same-house/confirm", requireAdminApi, (req, res) => {
  try {
    const session = readSession(req);
    const ids = req.body?.postIds || req.body?.ids || [];
    const result = mergeSameHouseForUser(session.userId, ids, { admin: true });
    auditReq(req, "same_house_confirm", (Array.isArray(ids) ? ids : []).join(","), null, {
      group_id: result?.group_id,
      shared: result?.shared,
      admin_confirmed: result?.admin_confirmed,
    });
    res.json(result);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/demand", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能刊登許願房" });
      return;
    }
    res.json(createDemand(session.userId, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.post("/api/wish-rooms", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能刊登許願房" });
      return;
    }
    res.json(createDemand(session.userId, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.patch("/api/wish-rooms/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(updateWishRoomFor(session.userId, req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.post("/api/wish-rooms/:id/publish", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(publishWishRoomFor(session.userId, req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.post("/api/wish-rooms/:id/reopen", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(reopenWishRoomFor(session.userId, req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

["extend", "pause", "resume", "complete", "confirm", "full_reconfirm"].forEach((action) => {
  app.post(`/api/wish-rooms/:id/${action}`, (req, res) => {
    try {
      const session = readSession(req);
      if (!session?.userId) {
        res.status(401).json({ error: "請先登入" });
        return;
      }
      res.json(applyWishLifecycleFor(session.userId, req.params.id, action));
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
    }
  });
});

app.post("/api/demand/:id/reply", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能回覆" });
      return;
    }
    res.json(replyDemand(session.userId, req.params.id, req.body?.body));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/demand/:id/close", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(closeDemand(session.userId, req.params.id, { admin: session.role === "admin" }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/demand/:id/report", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能檢舉" });
      return;
    }
    res.json(reportDemandItem(session.userId, {
      targetType: req.body?.targetType || "post",
      targetId: req.body?.targetId || req.params.id,
      reason: req.body?.reason,
    }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/feedback/meta", (_req, res) => {
  res.json(feedbackMeta());
});

app.post("/api/feedback", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能送出回饋" });
      return;
    }
    const body = req.body || {};
    const context = {
      ...(body.context && typeof body.context === "object" ? body.context : {}),
      role: session.role || "member",
    };
    res.json(submitFeedback(session.userId, { ...body, context }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/self-listings", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能看自己的刊登" });
      return;
    }
    res.json({
      ...selfListingMeta(
        isRentalCatalogV2Enabled(getRentalMarketplaceFlags())
          ? { catalog: getRentalCatalog() }
          : {},
      ),
      tools: listingToolsInfo(session.userId),
      owner_matching: rentalMatchOwnerMeta(),
      listings: listMineSelfListings(session.userId),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/self-listings/:id/matches/summary", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(ownerListingMatchSummary(req.params.id, session.userId));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.get("/api/self-listings/:id/matches", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(ownerListingMatches(req.params.id, session.userId, {
      limit: req.query?.limit,
      cursor: req.query?.cursor,
    }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

function sendOfferError(res, error) {
  const body = { error: error.message, code: error.code || "" };
  if (error.retry_after) body.retry_after = error.retry_after;
  res.status(error.status || 400).json(body);
}

app.post("/api/self-listings/:id/matches/:wishRef/offers", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    const created = createWishOfferFor(session.userId, req.params.id, req.params.wishRef, {
      idempotencyKey: req.body?.idempotency_key || req.get("idempotency-key"),
      actorKey: `owner:${session.userId}`,
    });
    attributeShare(req, session.userId, "offer");
    res.json(created);
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/rental-notify/prefs", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(getRentalNotifyPrefsFor(session.userId));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.put("/api/rental-notify/prefs", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(saveRentalNotifyPrefsFor(session.userId, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.get("/api/self-listings/:id/match-subscription", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(getMatchSubscriptionFor(session.userId, req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.put("/api/self-listings/:id/match-subscription", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(saveMatchSubscriptionFor(session.userId, req.params.id, req.body?.mode));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.get("/api/wish-rooms/:id/survey", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(getCompletionSurveyFor(session.userId, req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.post("/api/wish-rooms/:id/survey", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(submitCompletionSurveyFor(session.userId, req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.get("/api/admin/rental-ops", requireAdminApi, (req, res) => {
  try {
    res.json(rentalOpsSummaryFor({ from: req.query?.from, to: req.query?.to }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.get("/api/admin/rental-ops/drill", requireAdminApi, (req, res) => {
  try {
    res.json(rentalOpsDrilldownFor({
      kind: req.query?.kind,
      cursor: req.query?.cursor,
      limit: req.query?.limit,
      from: req.query?.from,
      to: req.query?.to,
    }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.get("/api/wish-offers/inbox", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(listTenantWishOffersFor(session.userId, {
      status: req.query?.status,
      limit: req.query?.limit,
      cursor: req.query?.cursor,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/wish-offers/owner", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(listOwnerWishOffersFor(session.userId, {
      status: req.query?.status,
      limit: req.query?.limit,
      cursor: req.query?.cursor,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/wish-offers/blocks", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(listMyWishOfferBlocksFor(session.userId));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/blocks/:blockRef/remove", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(unblockWishOfferFor(session.userId, req.params.blockRef));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/wish-offers/:offerRef/contact", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(readWishOfferContactFor(session.userId, req.params.offerRef, {
      actorKey: `contact:${session.userId}`,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/wish-offers/:offerRef", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(getWishOfferFor(session.userId, req.params.offerRef));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/:offerRef/accept", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(acceptWishOfferFor(session.userId, req.params.offerRef, {
      actorKey: `tenant:${session.userId}`,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/:offerRef/decline", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(declineWishOfferFor(session.userId, req.params.offerRef, {
      actorKey: `tenant:${session.userId}`,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/:offerRef/withdraw", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(withdrawWishOfferFor(session.userId, req.params.offerRef, {
      actorKey: `owner:${session.userId}`,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/:offerRef/block", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(blockWishOfferFor(session.userId, req.params.offerRef, {
      actorKey: `tenant:${session.userId}`,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/:offerRef/report", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(reportWishOfferFor(session.userId, req.params.offerRef, {
      reason: req.body?.reason,
      detail: req.body?.detail,
    }, { actorKey: `report:${session.userId}` }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/self-listings/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(getSelfListing(req.params.id, { viewerId: session.userId }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/self-listings", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能刊登" });
      return;
    }
    // 安全：素材庫照片必須屬於本人（擋以猜測 URL 盜連他人 media）。
    const body = req.body || {};
    assertOwnsMemberMediaUrls(session.userId, [...(Array.isArray(body.photos) ? body.photos : []), body.cover].filter(Boolean));
    const created = createSelfListing(session.userId, body);
    attributeShare(req, session.userId, "listing");
    res.json(created);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/self-listings/photos", express.raw({ type: () => true, limit: SELF_PHOTO_UPLOAD_MAX_BYTES }), (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能上傳照片" });
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    res.json(saveSelfPhoto(body));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/media/self/:file", (req, res) => {
  const full = selfPhotoFilePath(req.params.file);
  if (!full) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", mimeForSelfPhoto(req.params.file));
  res.setHeader("Cache-Control", "public, max-age=604800");
  res.sendFile(path.resolve(full));
});

// ── 會員照片素材庫（member media library） ──
app.get("/api/media", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    const tagIds = String(req.query.tag_ids || "").split(",").map(Number).filter((n) => n > 0);
    res.json(listMemberMediaFor(session.userId, { plan: session.plan || "free", tagIds }));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.get("/api/media/tags", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json({ items: listMediaTagsFor(session.userId) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.post("/api/media/tags", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(createMediaTagFor(session.userId, req.body?.name));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.patch("/api/media/tags/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(renameMediaTagFor(session.userId, req.params.id, req.body?.name));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.delete("/api/media/tags/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(deleteMediaTagFor(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.put("/api/media/:id/tags", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(setMediaTagsFor(session.userId, req.params.id, req.body?.tag_ids || req.body?.tags));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.get("/api/media/by-tags", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    const tagIds = String(req.query.tag_ids || "").split(",").map(Number).filter((n) => n > 0);
    res.json({ urls: mediaUrlsForTagIdsFor(session.userId, tagIds) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.post("/api/media", express.raw({ type: () => true, limit: IMAGE_MAX_UPLOAD_BYTES }), async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入才能上傳照片" }); return; }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const item = await saveMemberMediaFor(session.userId, buf, { plan: session.plan || "free", originalName: String(req.query.name || "") });
    res.json(item);
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.delete("/api/media/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(deleteMemberMediaFor(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

// 素材庫公開顯示檔（主圖／已浮水印縮圖）。未浮水印 original 不經此路由解析。
app.get("/media/lib/:file", servePublicMemberMedia);

// ── 公開分享：站內會員刊登（未登入可看主要內容；只輸出白名單公開欄位） ──
app.get("/api/public/self-listing/:id", (req, res) => {
  try {
    const listing = getSelfListing(req.params.id, { viewerId: 0 });
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(publicListingView(listing, req.params.id));
  } catch (error) {
    res.status(error.status === 404 ? 404 : 400).json({ error: error.message });
  }
});
app.get("/l/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/listing.html"));
});
app.get("/w/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/wish.html"));
});

app.get("/api/listing-imports/meta", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(listingImportMeta({ plan: session.plan || "free" }));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.get("/api/listing-imports", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json({ items: listMineListingImports(session.userId) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.post("/api/listing-imports", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    assertImportAllowed(session.userId, clientIp(req));
    const row = await startListingImportFor(session.userId, req.body || {}, { plan: session.plan || "free", role: session.role || "" });
    res.json(row);
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.get("/api/listing-imports/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(getOwnedListingImport(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.patch("/api/listing-imports/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(reviewListingImportFor(session.userId, req.params.id, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.post("/api/listing-imports/:id/cancel", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await cancelListingImportFor(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.post("/api/listing-imports/:id/confirm", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(confirmListingImportFor(session.userId, req.params.id, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.post("/api/listing-imports/:id/publish", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入才能刊登" }); return; }
    const body = req.body || {};
    assertOwnsMemberMediaUrls(session.userId, [...(Array.isArray(body.photos) ? body.photos : []), body.cover].filter(Boolean));
    res.json(publishConfirmedImportFor(session.userId, req.params.id, body));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.get("/api/admin/listing-imports", requireAdminApi, (req, res) => {
  try {
    res.json({ items: listAdminListingImports({ limit: Number(req.query?.limit) || 50 }) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.post("/api/self-listings/:id/copy", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(copyOwnListingFor(session.userId, req.params.id, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.post("/api/self-listings/:id/publish", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入才能刊登" }); return; }
    const body = req.body || {};
    assertOwnsMemberMediaUrls(session.userId, [...(Array.isArray(body.photos) ? body.photos : []), body.cover].filter(Boolean));
    res.json(publishOwnedDraftFor(session.userId, req.params.id, body));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.get("/api/listing-description-templates", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json({ items: listDescriptionTemplatesFor(session.userId), limit: listingToolsInfo(session.userId).description_template_limit });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.post("/api/listing-description-templates", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(createDescriptionTemplateFor(session.userId, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.get("/api/listing-description-templates/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(getOwnedDescriptionTemplateFor(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.patch("/api/listing-description-templates/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(updateDescriptionTemplateFor(session.userId, req.params.id, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.delete("/api/listing-description-templates/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(deleteDescriptionTemplateFor(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.get("/api/listing-contact-profiles", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json({ items: listContactProfilesFor(session.userId), limit: listingToolsInfo().contact_profile_limit });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.post("/api/listing-contact-profiles", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(createContactProfileFor(session.userId, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.get("/api/listing-contact-profiles/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(getOwnedContactProfileFor(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.patch("/api/listing-contact-profiles/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(updateContactProfileFor(session.userId, req.params.id, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.delete("/api/listing-contact-profiles/:id", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(deleteContactProfileFor(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.post("/api/self-listings/:id/close", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(closeSelfListing(session.userId, req.params.id, { admin: session.role === "admin" }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/self-listings/:id/report", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能檢舉" });
      return;
    }
    res.json(reportSelfListing(session.userId, req.params.id, req.body?.reason));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/self-listings/:id/hide", requireAdminApi, (req, res) => {
  try {
    res.json(hideSelfListing(req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/push/subscribe", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(saveUserPushSubscription(session.userId, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/push/unsubscribe", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(deleteUserPushSubscription(session.userId, req.body?.endpoint));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/mail/test", requireAdminApi, async (req, res) => {
  try {
    const session = readSession(req);
    const to = String(req.body?.to || session?.email || "").trim();
    if (!to) throw new Error("請先填收件信箱");
    const smtp = getStoredSmtp();
    if (!mailConfigured(smtp)) throw Object.assign(new Error("請先儲存 SMTP 設定"), { status: 400 });
    await sendMail({
      to,
      smtp,
      subject: `${APP_NAME}：測試信`,
      text: `這是後台管理寄出的測試信。若你看得到這封，SMTP 已可用。\n\n——${APP_NAME}\n`,
    });
    auditReq(req, "smtp_test", to, null, { ok: true });
    res.json({ ok: true, to });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.use(express.static(path.join(__dirname, "../public")));

let timer = null;
let lastRun = null;
const tickGate = createTickGate({ budgetMs: TICK_BUDGET_MS });
const clients = new Set();

function broadcast(payload, userId) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    if (userId && client.userId !== userId) continue;
    client.res.write(data);
  }
}

function broadcastWatch(result) {
  for (const client of clients) {
    const events = (result.events || []).filter((event) => !event.user_id || event.user_id === client.userId);
    const payload = {
      type: "watch",
      result: { ...result, events },
      stats: stats(undefined, client.userId),
    };
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function broadcastNotify(events) {
  const byUser = new Map();
  for (const event of events || []) {
    const uid = Number(event.user_id) || 0;
    if (!uid) continue;
    const list = byUser.get(uid) || [];
    list.push(event);
    byUser.set(uid, list);
  }
  for (const [userId, list] of byUser) {
    broadcast({ type: "notify", events: list, stats: stats(undefined, userId) }, userId);
  }
}

const geoBackfillState = { busy: false, queued: false };
const commuteFocusByUser = new Map();

function visibleFocusIds() {
  const now = Date.now();
  const ids = [];
  for (const rec of commuteFocusByUser.values()) {
    if (!rec || now - rec.at > 120_000) continue;
    ids.push(...(rec.ids || []));
  }
  return [...new Set(ids.map(Number).filter((id) => id > 0))];
}

let geoBackfillBusy = false;

async function ensureWorkCoords() {
  const uid = defaultUserId();
  const current = getSettings(uid);
  if (!(Number(current.commuteKm) > 0)) return current;
  const workAddress = String(current.workAddress || "").trim();
  if (!workAddress || (hasWorkPoint(current) && isTaiwanCoord(current.workLat, current.workLng))) return current;
  try {
    const geo = await geocodeAddress(workAddress, getCachedGeo, { strict: false, maxAttempts: 2, allowAdmin: false });
    if (!geo) return current;
    setCachedGeo(workAddress, geo.lat, geo.lng, geo);
    return saveSettings({ workLat: geo.lat, workLng: geo.lng, workLocationClass: geo.location_class || "" }, uid);
  } catch (error) {
    console.warn("補上班地址座標失敗：", error.message);
    return current;
  }
}

function queueGeoBackfill(settings = getSettings()) {
  settings = settingsForGeoBackfill(settings);
  if (rememberBackfillRequest(geoBackfillState) === "queued") return;
  const needCommute = needsListingGeo(settings);
  geoBackfillBusy = true;
  holdStatsCache(20_000);
  (async () => {
    try {
      const enrich = await backfillIncompleteAddresses({ limit: 8 });
      if (enrich.attempted) broadcast({ type: "geo", addressEnrich: enrich });
    } catch (error) {
      console.warn("補完整地址失敗：", error.message);
    }
    async function runRoutes() {
      const routes = await backfillListingRoutes(settings, { limit: 20, priorityIds: visibleFocusIds() });
      if (routes.attempted || (routes.listings && routes.listings.length)) {
        const commutePostIds = Array.isArray(routes.postIds) ? routes.postIds : [];
        const fingerprint = routes.fingerprint || "";
        delete routes.listings;
        delete routes.fingerprint;
        broadcast({ type: "geo", routeBackfill: routes });
        // Phase 10: targeted commute delta — only the located listings changed;
        // clients refresh their commute chips, not the whole list.
        if (commutePostIds.length) {
          broadcast({ type: "commute_updated", postIds: commutePostIds, fingerprint });
        }
      }
      const notified = await flushPendingNotifications(settings);
      if (notified.length) broadcastNotify(notified);
      return routes;
    }
    if (needCommute) {
      let emptyRouteRounds = 0;
      for (let round = 0; round < 80; round += 1) {
        try {
          const routes = await runRoutes();
          if (!routes.attempted) break;
          if (routes.located > 0) emptyRouteRounds = 0;
          else emptyRouteRounds += 1;
          if (emptyRouteRounds >= 3) break;
        } catch (error) {
          console.warn("補路線失敗：", error.message);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      for (let round = 0; round < 80; round += 1) {
        try {
          const geo = await backfillListingCoords(settings, { limit: LIST_PAGE_SIZE });
          if (geo.attempted) broadcast({ type: "geo", geoBackfill: geo });
          const notified = await flushPendingNotifications(settings);
          if (notified.length) broadcastNotify(notified);
          if (geo.located) await runRoutes();
          if (!geo.attempted) break;
        } catch (error) {
          console.warn("補定位失敗：", error.message);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      for (let round = 0; round < 40; round += 1) {
        try {
          const geo = await backfillAddressGeo(settings, { limit: 12 });
          if (geo.attempted) broadcast({ type: "geo", addressGeo: geo });
          const notified = await flushPendingNotifications(settings);
          if (notified.length) broadcastNotify(notified);
          if (geo.located) await runRoutes();
          if (!geo.attempted) break;
        } catch (error) {
          console.warn("補地址定位失敗：", error.message);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }
    for (let round = 0; round < 80; round += 1) {
      try {
        const mrt = await backfillListingMrt({ limit: 20 });
        if (mrt.attempted) broadcast({ type: "geo", mrtBackfill: mrt });
        if (!mrt.attempted) break;
      } catch (error) {
        console.warn("補捷運距離失敗：", error.message);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    try {
      broadcast({ type: "geo", stats: stats(), done: true });
      broadcast({ type: "stats_invalidated" });
    } catch (error) {
      console.warn("補定位後統計失敗：", error.message);
    }
  })()
    .finally(() => {
      geoBackfillBusy = false;
      if (finishBackfillRequest(geoBackfillState) === "restart") {
        queueGeoBackfill();
      }
    });
}

import { isSystemCoveringDueAsync } from "./coveringBookkeepingAsync.js";

async function tick(reason = "schedule") {
  if (tickGate.isBusy() && reason === "schedule") {
    if (!tickGate.isStale()) {
      return lastRun || { skipped: "busy", reason, checked_at: new Date().toISOString(), searches: [], events: [] };
    }
    tickGate.abandon();
    lastRun = {
      skipped: "stale",
      error: humanTimeoutMessage("上一輪抓取", TICK_BUDGET_MS),
      reason,
      checked_at: new Date().toISOString(),
      searches: [],
      events: [],
    };
    console.warn(lastRun.error);
  }
  const tickGen = tickGate.begin();
  try {
    expireStaleVerifyTokens({
      onExpire: (user) => {
        if (user?.email) queueSystemMail("verify_expired", user.email);
      },
    });
    try {
      pauseIdleMembers();
    } catch (error) {
      console.warn("閒置暫停失敗：", error.message);
    }
    const now = Date.now();
    const systemDue = reason === "force" || reason === "startup" || (await isSystemCoveringDueAsync(now));
    if (
      reason === "manual"
      && !systemDue
      && lastRun?.checked_at
      && !lastRun.error
      && isWatchIntervalPending(lastRun.checked_at, crawlIntervalMinutes(), now)
    ) {
      const duePlan = coveringPlan({ now, includeSystem: false });
      if (!duePlan.jobs.length) {
        return {
          ...lastRun,
          skipped: "interval",
          reason,
          message: "設定已記下，下次排程會用最新條件檢查",
        };
      }
    }
    const includeSystem = reason === "force" || reason === "startup" || (reason !== "schedule" && systemDue) || (reason === "schedule" && systemDue);
    const plan = coveringPlan({ now, includeSystem });
    if (!plan.jobs.length) {
      return {
        skipped: "idle",
        reason,
        message: "目前沒有要向外抓取的條件",
        checked_at: new Date().toISOString(),
        searches: [],
        events: [],
      };
    }
    const result = await withBudget(
      () => runWatch({
        skipHeavyGeo: true,
        jobs: plan.jobs,
        includedUserIds: plan.includedUserIds,
        includeSystem: plan.includeSystem,
      }),
      TICK_BUDGET_MS,
      "這輪抓取",
    );
    if (!tickGate.isCurrent(tickGen)) return result;
    lastRun = result;
    lastRun.reason = reason;
    broadcastWatch(lastRun);
    if (reason !== "startup") queueGeoBackfill();
    return lastRun;
  } catch (error) {
    if (!tickGate.isCurrent(tickGen)) {
      return lastRun || { error: error.message, checked_at: new Date().toISOString(), reason };
    }
    lastRun = { error: error.message, checked_at: new Date().toISOString(), reason };
    broadcast({ type: "error", error: error.message });
    throw error;
  } finally {
    tickGate.end(tickGen);
  }
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick("schedule").catch(() => {});
  }, 60 * 1000);
}

function safeStats(userId) {
  try {
    return stats(undefined, userId);
  } catch (error) {
    console.warn("讀取統計失敗：", error.message);
    return { total: 0, error: error.message };
  }
}

app.get("/api/settings", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    res.json({ settings: await getSettingsAsync(session.userId), cities: CITIES });
  } catch (error) {
    res.status(500).json({ error: error.message || "讀取設定失敗" });
  }
});

app.get("/api/member-mail", (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    res.json(getMemberMailSettings(session.userId));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "讀取郵件設定失敗" });
  }
});

app.post("/api/change-password", (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      const err = new Error("請先登入");
      err.status = 401;
      throw err;
    }
    changeUserPassword(session.userId, req.body?.currentPassword, req.body?.newPassword);
    queueSystemMail("password_changed", session.email);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || "變更密碼失敗" });
  }
});

app.post("/api/member-mail", (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    res.json(saveMemberMailSettings(session.userId, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || "儲存郵件設定失敗" });
  }
});

app.post("/api/member-mail/test", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    const uid = session.userId;
    const to = String(req.body?.to || session?.email || "").trim();
    if (!to) throw Object.assign(new Error("請先登入並確認信箱"), { status: 400 });
    if (req.body?.smtp && typeof req.body.smtp === "object") {
      saveMemberMailSettings(uid, { smtp: req.body.smtp });
    }
    const smtp = getMemberSmtp(uid);
    if (!mailConfigured(smtp)) {
      throw Object.assign(new Error("請先填 SMTP 主機、帳號與寄件 Email"), { status: 400 });
    }
    await sendMail({
      to,
      smtp,
      subject: `${APP_NAME}：測試信`,
      text: `這是用你自己的 SMTP 寄到 ${to} 的測試信。若你看得到這封，物件／屋源提醒就可以用同一組設定寄給你。註冊、忘記密碼、變更密碼、贊助通知仍走站方管理員 SMTP。\n\n——${APP_NAME}\n`,
    });
    res.json({ ok: true, to });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || "寄測試信失敗" });
  }
});

app.get("/api/state", async (req, res) => {
  await yieldEventLoop();
  const session = requireMember(req, res);
  if (!session) return;
  const uid = session.userId;
  let settings;
  try {
    settings = getSettings(uid);
  } catch (error) {
    res.status(500).json({ error: error.message || "讀取設定失敗" });
    return;
  }
  let listingStats = { total: 0 };
  let listings = [];
  let events = [];
  try {
    // The initial payload has to come from the same place the list does. GET /api/listings uses
    // searchListingsAsync() + listingStatsAsync(); this endpoint uses them too, so "first paint"
    // and "refresh" cannot disagree. With DB_DRIVER=sqlite both are the pre-existing SQLite
    // chain (awaited), so today's production response is unchanged.
    listingStats = await listingStatsAsync({ userId: uid });
    confirmExpiredOfflineFromSettings();
    const listed = await searchListingsAsync({
      filter: "all",
      sort: "newest",
      limit: 500,
      offset: 0,
      userId: uid,
      matchVoteUserId: uid,
    });
    listings = listed.listings;
    listingStats = { ...listingStats, matched: listed.totalMatched };
    events = recentEvents(30, uid);
  } catch (error) {
    console.warn("讀取物件列表失敗：", error.message);
    listingStats = { ...listingStats, error: error.message };
  }
  const run = lastRun
    ? { ...lastRun, events: (lastRun.events || []).filter((event) => !event.user_id || event.user_id === uid) }
    : lastRun;
  res.json({
    settings,
    stats: listingStats,
    lastRun: run,
    listings,
    events,
    cities: CITIES,
  });
});

app.post("/api/commute/focus", (req, res) => {
  const session = requireMember(req, res);
  if (!session) return;
  const uid = session.userId;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((id) => id > 0).slice(0, 80);
  commuteFocusByUser.set(uid, { ids, at: Date.now() });
  queueGeoBackfill(getSettings(uid));
  res.json({ ok: true, count: ids.length });
});

app.get("/api/commute/snapshot", (req, res) => {
  const session = requireMember(req, res);
  if (!session) return;
  const uid = session.userId;
  const settings = getSettings(uid);
  const ids = String(req.query.ids || "")
    .split(",")
    .map(Number)
    .filter((id) => id > 0)
    .slice(0, 80);
  res.json({
    listings: ids.map((id) => listingCommutePatch(id, uid)).filter(Boolean),
    fingerprint: commuteSettingsFingerprint(settings),
  });
});

app.get("/api/listings", async (req, res) => {
  await yieldEventLoop();
  const session = requireMember(req, res);
  if (!session) return;
  const uid = session.userId;
  const districts = String(req.query.districts || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const started = Date.now();
  confirmExpiredOfflineFromSettings();
  let cursor = null;
  if (req.query.cursor) {
    try { cursor = JSON.parse(String(req.query.cursor)); } catch { cursor = null; }
  }
  const args = {
    filter: req.query.filter || "all",
    kind: req.query.kind || "",
    sources: authorizedListingSources(req.query.sources || "", readSession(req)).join(","),
    q: req.query.q || "",
    sort: req.query.sort || "newest",
    limit: Number(req.query.limit) || 80,
    offset: Number(req.query.offset) || 0,
    cursor,
    districts,
    userId: uid,
    matchVoteUserId: uid,
    sameHouse: req.query.sameHouse !== "0",
  };
  // SQL-first fast path (Phase 7/8): push the district re-check + ORDER BY +
  // LIMIT/OFFSET into SQL. Each fast path returns null outside its
  // exact-equivalence envelope, so fall back to the Node path when it does.
  // The chain is awaited (searchListingsAsync) so the same handler can serve the
  // PostgreSQL driver; with DB_DRIVER=sqlite the returned object is unchanged.
  const listed = await searchListingsAsync(args, {
    allowUndecorated: process.env.PG_LISTINGS_UNDECORATED === "1",
  });
  const queryMs = Date.now() - started;
  const statsStarted = Date.now();
  const statsDetails = {};
  // Awaited so the PostgreSQL driver answers the counters from the store the list itself reads
  // (listingStatsAsync.js); with DB_DRIVER=sqlite the returned object is unchanged.
  const listingStats = await listingStatsAsync({ userId: uid, diagnostics: statsDetails });
  const statsMs = Date.now() - statsStarted;
  res.setHeader("Server-Timing", `list;dur=${queryMs}, stats;dur=${statsMs}`);
  res.json({
    stats: { ...listingStats, matched: listed.totalMatched },
    listings: listed.listings,
    hasMore: listed.hasMore === true,
    nextOffset: listed.nextOffset || 0,
    nextCursor: listed.nextCursor || null,
    queryVersion: listed.queryVersion || 2,
    timing: {
      query_ms: queryMs, stats_ms: statsMs, total_ms: Date.now() - started,
      dataset: listed.totalMatched, stages: listed.queryDetails, stats_stages: statsDetails,
    },
  });
});

app.post("/api/listings/hide-many", (req, res) => {
  const session = requireMember(req, res);
  if (!session) return;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) {
    res.status(400).json({ error: "請先勾選物件" });
    return;
  }
  res.json(hideMany(ids, session.userId));
});

app.post("/api/reset-listings", (req, res) => {
  if (!actorIsAdmin(req)) {
    res.status(403).json({ error: "只有管理員可以清除物件紀錄" });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "需要確認才會清除紀錄" });
    return;
  }
  const settings = resetListings();
  lastRun = null;
  const session = readSession(req);
  res.json({ ok: true, settings, stats: stats(undefined, session?.userId) });
});

app.post("/api/reset-all", (req, res) => {
  if (!actorIsAdmin(req)) {
    res.status(403).json({ error: "只有管理員可以清除全部資料" });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "需要確認才會清除全部資料" });
    return;
  }
  const settings = resetAllData();
  lastRun = null;
  res.json({ ok: true, settings, stats: { total: 0 } });
});

app.get("/api/listings/:id/history", async (req, res) => {
  const session = requireMember(req, res);
  if (!session) return;
  const uid = session.userId;
  const listing = await getListingAsync(Number(req.params.id), uid);
  if (!listing) {
    res.status(404).json({ error: "找不到這筆物件" });
    return;
  }
  res.json({ listing, history: sourceHistory(listing.source_key, uid) });
});

app.post("/api/listings/:id/flags", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    const uid = session.userId;
    const updated = setFlags(Number(req.params.id), req.body || {}, uid);
    if (!updated) {
      res.status(404).json({ error: "找不到這筆物件" });
      return;
    }
    if (req.body?.watched === true || req.body?.watched === 1) {
      queueGeoBackfill();
      if (updated && String(updated.source || "") === "houseprice") {
        await enqueueListingEnrichAsync(db, updated, { via: "watch", priority: WATCH_PRIORITY });
        kickListingEnrich();
      }
      try { await probeListingAliveBySource(updated); } catch { /* 關注後狀態探測失敗不擋回寫 */ }
    }
    res.json({ listing: updated, stats: stats(undefined, uid) });
  } catch (error) {
    res.status(error.status || 400).json({
      error: error.message || "無法更新標記",
      code: error.code || "",
      limit: error.limit,
    });
  }
});

const FRESH_RECHECK_WINDOW_MS = 60_000;
const FRESH_RECHECK_LIMIT = 8;
const FRESH_RECHECK_MIN_MS = 10_000;
const freshRecheckHits = new Map();
const freshRecheckLast = new Map();

function allowFreshRecheck(userId, postId) {
  const uid = Number(userId) || 0;
  const id = Number(postId) || 0;
  if (!uid || !id) return false;
  const now = Date.now();
  const pairKey = `${uid}:${id}`;
  const last = Number(freshRecheckLast.get(pairKey)) || 0;
  if (now - last < FRESH_RECHECK_MIN_MS) return false;
  const hits = (freshRecheckHits.get(uid) || []).filter((ts) => now - ts < FRESH_RECHECK_WINDOW_MS);
  if (hits.length >= FRESH_RECHECK_LIMIT) return false;
  hits.push(now);
  freshRecheckHits.set(uid, hits);
  freshRecheckLast.set(pairKey, now);
  return true;
}

app.post("/api/listings/:id/recheck", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入", login: true });
      return;
    }
    const postId = Number(req.params.id);
    const listing = await getListingAsync(postId);
    if (!listing) {
      res.json({ supported: false, gone: false });
      return;
    }
    const source = String(listing.source || "591") || "591";
    if (source === "self") {
      res.json({ supported: false, gone: false });
      return;
    }
    if (Number(listing.offline_confirmed) === 1) {
      res.json({ supported: true, gone: true, confirmed: true });
      return;
    }
    if (source === "houseprice") {
      const queued = await requestClickRefreshAsync(db, listing, "click");
      if (queued.wakeWorker) kickListingEnrich();
      res.json({
        supported: true,
        queued: Boolean(queued.queued),
        merged: Boolean(queued.merged),
        gone: Boolean(Number(listing.offline)),
        statusCooldown: Boolean(queued.statusCooldown),
        sourcePaused: Boolean(queued.sourcePaused),
      });
      return;
    }
    const fresh = req.query.fresh === "1" || req.body?.fresh === true || req.body?.fresh === 1;
    const lastCheck = Date.parse(listing.last_checked_at || "") || 0;
    if (!fresh && lastCheck && Date.now() - lastCheck < 60_000) {
      res.json({ supported: true, gone: Boolean(Number(listing.offline)), cooldown: true });
      return;
    }
    if (fresh && !allowFreshRecheck(session.userId, postId)) {
      res.json({ supported: true, gone: Boolean(Number(listing.offline)), cooldown: true, limited: true });
      return;
    }
    const { supported, outcome, alive } = await probeListingAliveBySource(listing, { thorough: Boolean(fresh) });
    if (!supported) {
      res.json({ supported: false, gone: false });
      return;
    }
    const decision = classifyListingProbeWrite({ outcome, alive });
    if (decision.write === "gone") {
      await markListingOfflineAsync(postId);
      res.json({ supported: true, gone: true, outcome: PROBE_GONE });
      return;
    }
    if (decision.write === "alive") {
      await markListingAliveAsync(postId, { wasOffline: Boolean(listing.offline) });
      res.json({ supported: true, gone: false, outcome: PROBE_ALIVE });
      return;
    }
    res.json({ supported: true, gone: Boolean(Number(listing.offline)), outcome: PROBE_INCONCLUSIVE });
  } catch (error) {
    res.json({ supported: true, gone: false, outcome: "inconclusive", error: error.message });
  }
});

// 硬按鈕「回報此物件已不在」：主動確認；真的不在→記錄下架（進 7 日同屋源窗口）；
// 似乎還在→打 alive_checked_at 起算 30 分鐘「全站」鎖，避免重複回報。鎖期間再按不重打。
const REPORT_GONE_LOCK_MS = 30 * 60 * 1000;
const REPORT_GONE_LOCK_MSG = "此物件正在確認中，似乎仍上架中；為避免重複回報，暫時鎖定 30 分鐘。";
app.post("/api/listings/:id/report-gone", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入", login: true });
      return;
    }
    const postId = Number(req.params.id);
    const listing = await getListingAsync(postId);
    if (!listing) {
      res.json({ supported: false });
      return;
    }
    const source = String(listing.source || "591") || "591";
    if (source === "self") {
      res.json({ supported: false });
      return;
    }
    if (Number(listing.offline_confirmed) === 1) {
      res.json({ supported: true, gone: true, confirmed: true });
      return;
    }
    if (Number(listing.offline) === 1) {
      res.json({ supported: true, gone: true, alreadyOffline: true });
      return;
    }
    // 全站鎖：近期已確認「還在」→ 直接回鎖定訊息，不重打。
    const aliveAt = Date.parse(listing.alive_checked_at || "") || 0;
    if (aliveAt && Date.now() - aliveAt < REPORT_GONE_LOCK_MS) {
      res.json({ supported: true, gone: false, locked: true, until: new Date(aliveAt + REPORT_GONE_LOCK_MS).toISOString(), message: REPORT_GONE_LOCK_MSG });
      return;
    }
    const { supported, outcome, alive } = await probeListingAliveBySource(listing, { thorough: true });
    if (!supported) {
      res.json({ supported: false });
      return;
    }
    const decision = classifyListingProbeWrite({ outcome, alive });
    if (decision.write === "gone") {
      await markListingOfflineAsync(postId);
      res.json({ supported: true, gone: true, reported: true, outcome: PROBE_GONE, message: "已記錄此物件下架，7 日內同屋源若在任一平台重現會自動接手。" });
      return;
    }
    if (decision.write === "alive") {
      await markListingAliveAsync(postId, { wasOffline: Boolean(listing.offline) });
      res.json({ supported: true, gone: false, alive: true, outcome: PROBE_ALIVE, locked: true, until: new Date(Date.now() + REPORT_GONE_LOCK_MS).toISOString(), message: REPORT_GONE_LOCK_MSG });
      return;
    }
    res.json({
      supported: true,
      gone: Boolean(Number(listing.offline)),
      alive: null,
      outcome: decision.outcome,
      inconclusive: true,
      message: "本次無法確認上下架，已保留上次狀態。",
    });
  } catch (error) {
    res.json({ supported: true, gone: false, error: error.message });
  }
});

app.post("/api/listings/:id/reject-match", (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入才能拆開同屋源" });
    return;
  }
  const result = rejectSuspectedMatch(Number(req.params.id), session.userId, {
    peerId: req.body?.peer_id,
    admin: session.role === "admin",
  });
  if (!result?.ok) {
    const status = result?.code === "not_found" ? 404 : result?.code === "rate_limit" ? 429 : 400;
    res.status(status).json({ error: result?.error || "無法拆開同屋源" });
    return;
  }
  res.json({
    listing: result.listing,
    stats: stats(undefined, session.userId),
    personal: true,
    promoted: result.promoted,
    remaining: result.remaining,
  });
});

app.post("/api/listings/:id/confirm-match", (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入才能併入同房源" });
    return;
  }
  const result = confirmSuspectedMatch(Number(req.params.id), session.userId, {
    admin: session.role === "admin",
  });
  if (!result?.ok && !result?.listing) {
    res.status(404).json({ error: "找不到這筆物件或缺少比對對象" });
    return;
  }
  res.json({
    listing: result.listing,
    stats: stats(undefined, session.userId),
    personal: result.personal !== false && !result.admin_confirmed,
    shared: result.shared === true,
    admin_confirmed: result.admin_confirmed === true,
    group_id: result.group_id || "",
    message: result.message || "",
  });
});

app.post("/api/listings/merge-same-house", (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入才能併入同房源" });
    return;
  }
  const result = mergeSameHouseForUser(session.userId, req.body?.ids || req.body?.post_ids, {
    admin: session.role === "admin",
  });
  if (!result?.ok) {
    const status = result?.code === "guest" ? 401 : 400;
    res.status(status).json({ error: result?.error || "無法併入同房源" });
    return;
  }
  res.json({
    ok: true,
    personal: result.personal !== false && !result.admin_confirmed,
    shared: result.shared === true,
    admin_confirmed: result.admin_confirmed === true,
    system_agrees: result.systemAgrees,
    message: result.message,
    post_ids: result.post_ids,
    group_id: result.group_id || "",
    listing: result.listing,
    stats: stats(undefined, session.userId),
  });
});

async function persistSettings(body = {}, userId) {
  const uid = Number(userId) || 0;
  if (!uid) {
    const err = new Error("請先登入");
    err.status = 401;
    throw err;
  }
  delete body.workLat;
  delete body.workLng;
  delete body.workLocationClass;
  const workAddress = String(body.workAddress || "").trim();
  if (body.workAddress !== undefined || Number(body.commuteKm) > 0) {
    const current = getSettings(uid);
    const resolved = resolveWorkPointForSave(current, {
      workAddress: body.workAddress !== undefined ? workAddress : current.workAddress,
      commuteKm: body.commuteKm !== undefined ? body.commuteKm : current.commuteKm,
    });
    if (resolved.error) throw new Error(resolved.error);
    if (resolved.needsGeocode) {
      const geo = await geocodeAddress(resolved.workAddress, getCachedGeo, { strict: true, maxAttempts: 2 });
      if (!geo) throw new Error("找不到這個上班地址，請再寫詳細一點");
      body.workAddress = resolved.workAddress;
      body.workLat = geo.lat;
      body.workLng = geo.lng;
      body.workLocationClass = geo.location_class || "";
      setCachedGeo(resolved.workAddress, geo.lat, geo.lng, geo);
    } else if (resolved.workAddress !== undefined) {
      body.workAddress = resolved.workAddress;
      body.workLat = resolved.workLat;
      body.workLng = resolved.workLng;
      body.workLocationClass = resolved.workLocationClass || "";
    }
  }
  const pausing = Object.prototype.hasOwnProperty.call(body, "notificationsPaused");
  let settings = await saveSettingsAsync(body, uid);
  if (pausing && settings.notificationsPaused !== true) {
    settings = await armMemberExternalFetchAsync(uid);
  }
  schedule();
  return settings;
}

app.post("/api/settings", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    const uid = session.userId;
    const settings = await persistSettings(req.body || {}, uid);
    res.json({ settings, stats: safeStats(uid) });
    queueGeoBackfill(settings);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/profiles", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    const uid = session.userId;
    const name = profileNameOrDraft(req.body?.name);
    const patch = req.body?.settings;
    if (patch && typeof patch === "object") {
      await persistSettings(patch, uid);
    }
    const overwrite = Boolean(req.body?.overwrite);
    const settings = await saveAsProfileAsync(name, undefined, uid, { overwrite });
    res.json({ settings });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/profiles/:id/load", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    const settings = await loadProfileAsync(req.params.id, session.userId);
    schedule();
    res.json({ settings });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.delete("/api/profiles/:id", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    const settings = await deleteProfileAsync(req.params.id, session.userId);
    res.json({ settings });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/exclude-region", async (req, res) => {
  try {
    if (!requireMember(req, res)) return;
    const text = String(req.body?.text || req.body?.description || "").trim();
    if (!text) {
      res.status(400).json({ error: "請輸入範圍描述" });
      return;
    }
    const box = await boxFromRoadDescription(text, {
      lookup: getCachedGeo,
      save: setCachedGeo,
    });
    res.json({ box });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/watch", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    const uid = session.userId;
    const result = await tick(req.body?.force === true ? "force" : "manual");
    const events = (result.events || []).filter((event) => !event.user_id || event.user_id === uid);
    res.json({ result: { ...result, events }, stats: stats(undefined, uid) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Reconnect catch-up (Phase 11): a client that dropped its SSE stream asks
// "what changed since revision N?" and re-reads only the delta, not the whole set.
app.get("/api/events/revision", (req, res) => {
  const session = requireMember(req, res);
  if (!session) return;
  const since = Math.max(0, Number(req.query.since) || 0);
  res.json({
    revision: currentRevision(db),
    changes: changesSince(db, since, { limit: 500 }),
  });
});

app.get("/api/events/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入" });
    return;
  }
  const userId = session.userId;
  const run = lastRun
    ? { ...lastRun, events: (lastRun.events || []).filter((event) => !event.user_id || event.user_id === userId) }
    : lastRun;
  res.write(`data: ${JSON.stringify({ type: "hello", lastRun: run })}\n\n`);
  const client = { res, userId };
  clients.add(client);
  req.on("close", () => clients.delete(client));
});

function runHousingRefresh() {
  refreshHousingData({ getData: getHousingDataRaw, writeData: writeHousingData })
    .then((s) => { if (s.count) console.log(`居住數據自動更新：${s.count} 筆${s.errors.length ? `（${s.errors.length} 個來源失敗）` : ""}`); })
    .catch((error) => console.warn("居住數據自動更新失敗：", error.message));
}

const APP_ROLE = resolveAppRole();

if (roleRunsWeb(APP_ROLE)) {
  app.listen(PORT, HOST, () => {
    if (roleRunsCrawler(APP_ROLE)) schedule();
    if (roleRunsWorker(APP_ROLE)) startWorkerLoops();
    if (roleRunsCrawler(APP_ROLE) || roleRunsWorker(APP_ROLE)) startStartupWork();
    console.log(`${APP_NAME}：http://${HOST}:${PORT}（role=${APP_ROLE}）`);
    if (envAdminConfigured()) {
      console.log(`管理員帳號：${adminEmail()}（也可註冊新會員）`);
    } else {
      console.log("可從登入頁註冊新會員。若要保留舊的單一管理員，請在 auth.env 設定 AUTH_EMAIL / AUTH_PASSWORD。");
    }
    if (!mailConfigured(getStoredSmtp())) {
      console.log("系統信（註冊、忘記密碼、變更密碼、贊助）尚未能寄信：請在後台填 SMTP，或在 auth.env 寫入 SMTP_HOST、SMTP_USER、SMTP_PASS、SMTP_FROM。");
    }
  });
} else {
  // crawler / worker 獨立行程：啟動各自的背景迴圈，不提供 HTTP。
  if (roleRunsCrawler(APP_ROLE)) schedule();
  if (roleRunsWorker(APP_ROLE)) startWorkerLoops();
  if (roleRunsCrawler(APP_ROLE) || roleRunsWorker(APP_ROLE)) startStartupWork();
  console.log(`${APP_NAME}：以 ${APP_ROLE} 角色啟動（不提供 HTTP）`);
}

function startWorkerLoops() {
  // 居住數據：開站 30 秒後補一次、之後每天自動抓開放資料（失敗不影響服務）
  setTimeout(runHousingRefresh, 30_000);
  setInterval(runHousingRefresh, 24 * 60 * 60 * 1000);
  // Phase 2：非同步 feedback → Ops 遞送。預設關閉（需 OPS_FEEDBACK_DELIVERY=1 + OPS_INGEST_URL + OPS_INGEST_SECRET）。
  const opsDelivery = deliveryConfigFromEnv();
  if (opsDelivery.enabled) {
    startDeliveryLoop(opsDeliveryDb(), opsDelivery, { log: (tag, info) => console.log(tag, JSON.stringify(info)) });
    console.log(`Ops feedback 遞送已啟用：每 ${opsDelivery.intervalMs}ms 一次 → ${opsDelivery.url}`);
  }
  startWishLifecycleLoop(() => runWishLifecycleWorkerTick(), { intervalMs: 5 * 60 * 1000, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  startWishOfferExpiryLoop(() => runWishOfferExpiryWorkerTick(), { intervalMs: 5 * 60 * 1000, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  startRentalNotifyLoop(() => runRentalNotifyWorkerTick(), { intervalMs: 5 * 60 * 1000, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  startCrmDeliveryLoop(opsDeliveryDb(), process.env, { log: (tag, info) => console.log(tag, JSON.stringify(info)), ops: crmOutboxOps() });
}

// 啟動後 20 秒做第一次爬取 + geo backfill（crawler 與 worker 共用）。
function startStartupWork() {
  setTimeout(() => {
    ensureWorkCoords()
      .then((settings) => {
        const jobs = coveringJobsFromAllUsers({ includeSystem: true });
        if (!jobs.length) {
          queueGeoBackfill(settings);
          return;
        }
        console.log(`第一次檢查：${jobs.length} 組覆蓋條件`);
        return tick("startup");
      })
      .then((result) => {
        if (result != null) queueGeoBackfill();
      })
      .catch((error) => {
        console.warn("第一次檢查失敗：", error.message);
      });
  }, 20000);
}
