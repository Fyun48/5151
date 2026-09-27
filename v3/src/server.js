import "./env.js";
import { resolveAppRole, roleRunsWeb, roleRunsCrawler, roleRunsWorker } from "./appRole.js";
import { searchPublicListingsAsync } from "./publicListingSearchAsync.js";
import { resolveDbDriver } from "./dbDriver.js";
import { loadListingPage } from "./listingSearchPage.js";
import { sendListingSearchUnavailable } from "./listingSearchHttp.js";
import {
  armMemberExternalFetchAsync,
  deleteProfileAsync,
  getSettingsAsync,
  loadProfileAsync,
  saveAsProfileAsync,
  saveSettingsAsync,
} from "./settingsAsync.js";
// 帳號維護（過期驗證碼、閒置暫停）：PG 模式下與其他節點同源。
import { expireStaleVerifyTokensAsync, pauseIdleMembersAsync } from "./accountMaintenanceAsync.js";
// 個人旗標（收藏／隱藏／已看過）：站上讀 PG 的 user_listing_flags，寫入也必須進 PG。
import { setFlagsAsync } from "./personalFlagsAsync.js";
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
import { adminEmail, clearSessionCookie, envAdminConfigured, readSession, requireAuth, resolveSession, sessionCookie, verifyLogin } from "./auth.js";
// 刊登生產力工具（說明範本／聯絡人）的 PG 島嶼入口。
// `listingToolsMeta` 是**純函式**：上限只取決於 plan／role，而 session 已經每請求從 PG
// 解析出來了，所以不必再 `getUserById()` 查一次 users（那正是這 10 條路由原本的 SQLite 卡點）。
import { listingToolsMeta } from "./listingTools.js";
import { deletePushSubscriptionAsync, savePushSubscriptionAsync } from "./webPushAsync.js";
import { applyBrandUploadAsync, getAdminAdsSettingsAsync, getAdminBroadcastsSettingsAsync } from "./adminSettingsAsync.js";
import { importMetaAsync } from "./listingImportAsync.js";
import { getRemoteCsControlAsync, setRemoteCsStopAsync } from "./siteCommandAsync.js";
import { getWishConditionsAsync, saveWishConditionsAsync } from "./rentalCatalogAsync.js";
// 租屋目錄的 PG 島嶼入口（目錄本體是 settings 裡的 JSON blob）。
import {
  applyRentalCatalogTemplateAsync,
  deleteRentalCatalogTemplateAsync,
  getRentalCatalogAsync,
  getRentalCatalogDraftAsync,
  getRentalCatalogTemplatesAsync,
  getRentalMarketplaceFlagsAsync,
  mutateRentalCatalogAsync,
  publishRentalCatalogDraftAsync,
  renameRentalCatalogTemplateAsync,
  rentalMatchAdminRulesAsync,
  saveRentalCatalogAsync,
  saveRentalCatalogTemplateAsync,
} from "./rentalCatalogAsync.js";
// 站內公告與贊助活動的 PG 島嶼入口。
import {
  announcementInboxForUserAsync,
  bannerAnnouncementsAsync,
  createAnnouncementAsync,
  createCampaignAsync,
  dismissAnnouncementAsync,
  listAnnouncementsAdminAsync,
  listCampaignsAdminAsync,
  listingCampaignsAsync,
  markAnnouncementReadAsync,
  publicActiveAnnouncementsAsync,
  publicCommsBundleAsync,
  publishAnnouncementAsync,
  recordSponsoredEventAsync,
  updateAnnouncementAsync,
  updateCampaignAsync,
} from "./commsAsync.js";
// 內容文件（條款／隱私權）的 PG 島嶼入口。
// `legalCopyFromDocumentsAsync` 是很多條路由的共用卡點（/api/disclaimer、/api/me、註冊流程…）。
import {
  createDraftAsync as createContentDraftAsync,
  createDraftFromPublishedAsync as newContentVersionAsync,
  getDocumentByIdAsync as getContentDocumentAsync,
  getEffectiveDocumentAsync,
  getRequiredRegistrationDocumentsAsync,
  legalCopyFromDocumentsAsync,
  listDocumentEventsAsync as listContentEventsAsync,
  listDocumentsAsync as listContentDocumentsAsync,
  publishDocumentAsync as publishContentDocumentAsync,
  updateDraftAsync as updateContentDraftAsync,
} from "./contentDocumentsAsync.js";
// 會員照片素材庫的 PG 島嶼入口（8 條 /api/media* 路由）。
// ⚠️ 不含 `POST /api/media`（上傳）：`saveMemberMedia()` 的交易橫跨影像處理與 R2 上傳，
// 那是獨立一批（見 memberMediaAsync.js 檔頭）。
import {
  createMediaTagAsync,
  deleteMediaTagAsync,
  deleteMemberMediaAsync,
  listMediaTagsAsync,
  listMemberMediaAsync,
  mediaUrlsForTagIdsAsync,
  renameMediaTagAsync,
  setMediaTagsAsync,
} from "./memberMediaAsync.js";

import {
  createContactProfileAsync,
  createDescriptionTemplateAsync,
  deleteContactProfileAsync,
  deleteDescriptionTemplateAsync,
  getOwnedContactProfileAsync,
  getOwnedDescriptionTemplateAsync,
  listContactProfilesAsync,
  listDescriptionTemplatesAsync,
  updateContactProfileAsync,
  updateDescriptionTemplateAsync,
} from "./listingToolsAsync.js";
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
import { getMemberMailBundleAsync, getMemberMailSettingsAsync, saveMemberMailSettingsAsync } from "./memberMailAsync.js";
import { hideManyAsync } from "./personalFlagsAsync.js";
import {
  getCommsConfigAsync, getCrawlSourcesAsync, getHelpQaAsync, getHousingDataAsync,
  getHousingDataRawAsync, writeHousingDataAsync, getSpiritAsync,
  saveCommsConfigAsync, saveCrawlSourcesAsync, saveHelpQaAsync, saveHousingDataAsync, saveSpiritAsync,
} from "./siteContentAsync.js";
import { crawlSourceHealthAsync } from "./adminOverviewAsync.js";
import {
  confirmSuspectedMatchAsync,
  mergeSameHouseForUserAsync,
  rejectSuspectedMatchAsync,
} from "./sameHouseAsync.js";
// 後台總覽的統計在 PG 模式下必須走 listingStatsAsync（已是既有的 PG 路徑，
// 內部會 resolveDbDriver 並在有快照的情況下回同一組計數）。
import { listingStatsAsync } from "./listingStatsAsync.js";
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
import { appendAdminAuditAsync, listAdminAuditAsync } from "./adminAuditAsync.js";
import { auditFailureStats } from "./adminAuditHealth.js";
// 後台設定（郵件／OAuth／贊助／品牌）的 driver-aware 入口。寫入的兩個
// （saveAdminMailSettings／saveAdminOauthSettings）刻意還沒移植——它們會寫節點本機的 auth.env。
import {
  getAdminMailSettingsAsync,
  getStoredSmtpAsync,
  getAdminOauthSettingsAsync,
  getAdminSponsorSettingsAsync,
  getBrandMascotAsync,
  publicSponsorSettingsAsync,
  saveAdminSponsorSettingsAsync,
  saveBrandMascotAsync,
} from "./adminSettingsAsync.js";
// Support 後台列表（卡點全在 handler 內的那一群）。
import {
  adminSupportConfigAsync,
  createManualTransactionAsync,
  getSupportFlagsAsync,
  previewSupportConfigAsync,
  publicSupportConfigAsync,
  createSupportCheckoutAsync,
  dismissSupportCtaAsync,
  handleSupportCtaRequestAsync,
  createSupportCostAsync,
  createSupportSponsorAsync,
  createSupportTierAsync,
  listCtaRulesAsync,
  listSupportCostsAsync,
  listSupportProvidersAsync,
  listSupportSponsorsAsync,
  listSupportTiersAsync,
  listSupportTransactionsAsync,
  publishSupportConfigAsync,
  recordSupportEventAsync,
  saveSupportConfigAsync,
  supportDashboardAsync,
  updateCtaRuleAsync,
  updateSupportCostAsync,
  updateSupportProviderAsync,
  updateSupportSponsorAsync,
  updateSupportTierAsync,
  updateSupportTransactionAsync,
} from "./supportAsync.js";
// 站內刊登讀取（含過期清理）。同步版被 listingImport.js／listingTools.js 深層呼叫的部分仍未移植。
import { getSelfListingAsync } from "./selfListingsAsync.js";
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

// Session 解析必須在**任何**路由之前（本檔第一條路由在下面幾行就註冊了），
// 而且要在 requireAuth 之前，讓 `readSession()` 一率讀到已解析的快取。
// 這一條同時解掉「187 條路由的 session 讀的是節點本機 SQLite」這個步驟 3 的卡點。
app.use(resolveSession());

app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.get("/api/health", (_req, res) => {
  // audit_failures：PG 稽核寫入的累計失敗數。正常應該是 0。
  // 2026-09-27 之所以加這個欄位：稽核的 fire-and-forget 契約讓「每一筆都失敗」
  // 完全隱形（序列落後造成，見 docs/handoffs/PG-IDENTITY-SEQUENCE-DEFECT-20260927.md）。
  // 契約仍然是「稽核失敗不得擋住管理操作」，所以 `ok` 不因此變成 false——
  // 但監控可以只看這一個數字。
  res.json({ ok: true, version: APP_VERSION, audit_failures: auditFailureStats().failures });
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
    const listed = await getCachedPublicListings(query, () => searchPublicListingsAsync({
      ...query,
      settings: publicSearchSettings(query),
    }), { namespace: resolveDbDriver() === "postgres" ? null : "sqlite:guest:v2" });
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
    if (sendListingSearchUnavailable(res, error)) return;
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
        await setFlagsAsync(id, { viewed: true }, session.userId);
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

app.get("/api/me", async (req, res) => {
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
    sponsor: session ? await publicSponsorSettingsAsync(session) : { show: false, links: [], sponsored: false, intro: "", thanks: "" },
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

app.get("/api/public/documents", async (_req, res) => {
  try {
    res.json({
      types: Object.values(DOC_TYPES).map((row) => ({ id: row.id, label: row.label, required_at: row.required_at })),
      required: await getRequiredRegistrationDocumentsAsync(),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/public/documents/:type", async (req, res) => {
  try {
    const doc = await getEffectiveDocumentAsync(req.params.type);
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

app.get("/api/help-qa", async (_req, res) => {
  res.json(await getHelpQaAsync());
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

app.get("/api/oauth", async (_req, res) => {
  res.json(await getAdminOauthSettingsAsync());
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
    const payload = {
      actorId: session?.userId,
      actorEmail: session?.email,
      action,
      target,
      before,
      after,
    };
    if (resolveDbDriver() !== "postgres") {
      appendAdminAudit(payload);
      return;
    }
    // PG 是非同步，而這個函式被 **19 處**（多為同步）handler 呼叫
    // （2026-09-27 實測：19 個呼叫點，其中 16 個在同步 handler 內）。
    // 原本就明訂「稽核失敗不得擋住管理操作」，所以這裡刻意 fire-and-forget。
    // 代價要講清楚：沒有 await，行程若在寫入完成前結束就會少一筆稽核。
    //
    // ⚠️ 2026-09-27 修正一個**本來會讓全損故障隱形**的設計：
    // 這裡原本是 `.catch(() => {})`，把錯誤**完全**吞掉。配上正式站
    // `admin_audit.id` 序列落後，結果是「每一筆稽核都失敗」長達 12 天卻沒有任何痕跡
    // （詳見 docs/handoffs/PG-IDENTITY-SEQUENCE-DEFECT-20260927.md）。
    // 現在 `appendAdminAuditAsync()` 內部會自己記數並寫 log（第一次 + 每 100 次），
    // 失敗筆數也接到 `/api/health` 的 `audit_failures`。**契約不變**：不 await、不擋管理操作。
    appendAdminAuditAsync(payload).catch(() => {});
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

app.get("/api/admin/mail", requireAdminApi, async (_req, res) => {
  res.json(await getAdminMailSettingsAsync());
});

app.put("/api/admin/mail", requireAdminApi, (req, res) => {
  try {
    res.json(saveAdminMailSettings(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/oauth", requireAdminApi, async (_req, res) => {
  res.json(await getAdminOauthSettingsAsync());
});

app.put("/api/admin/oauth", requireAdminApi, (req, res) => {
  try {
    res.json(saveAdminOauthSettings(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/sponsor", requireAdminApi, async (_req, res) => {
  res.json(await getAdminSponsorSettingsAsync());
});

app.put("/api/admin/sponsor", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveAdminSponsorSettingsAsync(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/ads", requireAdminApi, async (_req, res) => {
  res.json(await getAdminAdsSettingsAsync());
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

app.get("/api/brand", async (_req, res) => {
  res.json(await getBrandMascotAsync());
});

app.get("/api/admin/brand", requireAdminApi, async (_req, res) => {
  res.json(await getBrandMascotAsync());
});

app.put("/api/admin/brand", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveBrandMascotAsync(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/brand/file", requireAdminApi, express.raw({ type: () => true, limit: BRAND_UPLOAD_MAX_BYTES }), async (req, res) => {
  try {
    const upload = saveBrandUpload(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    const slot = String(req.query.slot || req.headers["x-brand-slot"] || "").trim();
    res.json({ ...upload, brand: await applyBrandUploadAsync(slot, upload) });
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

app.get("/api/admin/broadcasts", requireAdminApi, async (_req, res) => {
  res.json(await getAdminBroadcastsSettingsAsync());
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

app.get("/api/admin/announcements", requireAdminApi, async (_req, res) => {
  res.json({ items: await listAnnouncementsAdminAsync(), meta: commsMeta() });
});

app.post("/api/admin/announcements", requireAdminApi, async (req, res) => {
  try {
    res.status(201).json(await createAnnouncementAsync(commsActor(req), req.body || {}));
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.patch("/api/admin/announcements/:id", requireAdminApi, async (req, res) => {
  try {
    res.json(await updateAnnouncementAsync(commsActor(req), Number(req.params.id), req.body || {}));
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.post("/api/admin/announcements/:id/publish", requireAdminApi, async (req, res) => {
  try {
    const published = await publishAnnouncementAsync(commsActor(req), Number(req.params.id));
    auditReq(req, "announcement_publish", published?.title || req.params.id, { status: "draft" }, { status: "published" });
    res.json(published);
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.get("/api/admin/campaigns", requireAdminApi, async (_req, res) => {
  res.json({ items: await listCampaignsAdminAsync(), config: await getCommsConfigAsync(), meta: commsMeta() });
});

app.post("/api/admin/campaigns", requireAdminApi, async (req, res) => {
  try {
    res.status(201).json(await createCampaignAsync(commsActor(req), req.body || {}));
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.patch("/api/admin/campaigns/:id", requireAdminApi, async (req, res) => {
  try {
    res.json(await updateCampaignAsync(commsActor(req), Number(req.params.id), req.body || {}));
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.get("/api/admin/comms-config", requireAdminApi, async (_req, res) => {
  res.json({ config: await getCommsConfigAsync(), meta: commsMeta() });
});

app.put("/api/admin/comms-config", requireAdminApi, async (req, res) => {
  try {
    res.json({ config: await saveCommsConfigAsync(req.body || {}), meta: commsMeta() });
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.get("/api/announcements", async (_req, res) => {
  res.json({ items: await publicActiveAnnouncementsAsync(), banner: await bannerAnnouncementsAsync() });
});

app.get("/api/announcements/inbox", async (req, res) => {
  const session = readSession(req);
  res.json({ items: await announcementInboxForUserAsync(session?.userId || null) });
});

app.post("/api/announcements/:id/read", async (req, res) => {
  const session = readSession(req);
  res.json(await markAnnouncementReadAsync(session?.userId || null, Number(req.params.id)));
});

app.post("/api/announcements/:id/dismiss", async (req, res) => {
  const session = readSession(req);
  res.json(await dismissAnnouncementAsync(session?.userId || null, Number(req.params.id)));
});

app.get("/api/sponsored", async (_req, res) => {
  const config = await getCommsConfigAsync();
  res.json({
    interval: config.listing_ad_interval,
    listing_enabled: config.sponsored_master_enabled && config.listing_placement_enabled,
    session_cap: 3,
    cards: (await listingCampaignsAsync({ config })).map((row) => publicCampaignView(row)),
  });
});

app.post("/api/sponsored/:id/event", async (req, res) => {
  try {
    const kind = String(req.body?.kind || "");
    const placement = String(req.body?.placement || "listing");
    res.json(await recordSponsoredEventAsync(Number(req.params.id), kind, placement));
  } catch (error) {
    sendCommsError(res, error);
  }
});

app.get("/api/comms", async (req, res) => {
  const session = readSession(req);
  // 支持方式（後台「贊助連結」）是公開資訊：未登入訪客也要拿得到，才不會在「支持本站」看到死路。
  const publicSponsorOffer = await publicSponsorSettingsAsync({});
  res.json(await publicCommsBundleAsync({
    config: await getCommsConfigAsync(),
    sponsorOffer: session ? await publicSponsorSettingsAsync(session) : {},
    sponsorLinks: publicSponsorOffer.links,
    user: session ? { id: session.userId, plan: session.plan, role: session.role } : {},
  }));
});

function sendSupportError(res, error) {
  res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
}

async function publicSupportFallback() {
  return {
    enabled: false,
    flags: await getSupportFlagsAsync(),
    entry: { show: false, label: "支持本站", href: "/support.html" },
    cta: { enabled: false },
  };
}

app.get("/api/support/public", async (_req, res) => {
  try {
    res.json(await publicSupportConfigAsync());
  } catch {
    res.json(await publicSupportFallback());
  }
});

app.get("/api/support/tiers", async (_req, res) => {
  try {
    const pub = await publicSupportConfigAsync();
    res.json({ items: pub.tiers || [] });
  } catch {
    res.json({ items: [] });
  }
});

app.post("/api/support/checkout", async (req, res) => {
  try {
    assertSupportCheckoutAllowed(clientIp(req));
    const result = await createSupportCheckoutAsync({
      tierId: req.body?.tierId,
      amount: req.body?.amount,
    });
    const session = readSession(req);
    await recordSupportEventAsync("support_checkout_opened", {
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

app.post("/api/support/cta", async (req, res) => {
  try {
    const session = readSession(req);
    const result = await handleSupportCtaRequestAsync({
      userId: session?.userId || null,
      usage: req.body?.usage,
      clientState: req.body?.clientState,
    });
    res.json(result);
  } catch {
    res.json({ show: false, reason: "unavailable" });
  }
});

app.post("/api/support/cta/dismiss", async (req, res) => {
  try {
    const session = readSession(req);
    const state = await dismissSupportCtaAsync({
      userId: session?.userId || null,
      days: req.body?.days,
      clientState: req.body?.clientState,
    });
    await recordSupportEventAsync("support_cta_dismissed", {
      userId: session?.userId || null,
      meta: { days: req.body?.days },
    });
    res.json({ ok: true, state });
  } catch {
    res.json({ ok: true, state: req.body?.clientState || {} });
  }
});

app.post("/api/support/event", async (req, res) => {
  try {
    const session = readSession(req);
    res.json(await recordSupportEventAsync(String(req.body?.kind || ""), {
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

app.get("/api/admin/support/dashboard", requireAdminApi, async (req, res) => {
  try {
    res.json(await supportDashboardAsync({
      period: String(req.query.period || "month"),
      from: req.query.from,
      to: req.query.to,
    }));
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/config", requireAdminApi, async (_req, res) => {
  res.json(await adminSupportConfigAsync());
});

app.get("/api/admin/support/preview", requireAdminApi, async (_req, res) => {
  res.json(await previewSupportConfigAsync());
});

app.put("/api/admin/support/config", requireAdminApi, async (req, res) => {
  try {
    const before = await adminSupportConfigAsync();
    const after = await saveSupportConfigAsync(req.body || {});
    auditReq(req, "support.config.update", "support_page_config", before, after);
    res.json(after);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.post("/api/admin/support/config/publish", requireAdminApi, async (req, res) => {
  try {
    const before = await adminSupportConfigAsync();
    const after = await publishSupportConfigAsync();
    auditReq(req, "support.page.publish", "support_page_config", before, after);
    res.json(after);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/costs", requireAdminApi, async (_req, res) => {
  res.json({ items: await listSupportCostsAsync() });
});

app.post("/api/admin/support/costs", requireAdminApi, async (req, res) => {
  try {
    const row = await createSupportCostAsync(req.body || {});
    auditReq(req, "support.cost.create", `support_operating_cost:${row.id}`, null, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.put("/api/admin/support/costs/:id", requireAdminApi, async (req, res) => {
  try {
    const before = (await listSupportCostsAsync()).find((row) => Number(row.id) === Number(req.params.id));
    const row = await updateSupportCostAsync(Number(req.params.id), req.body || {});
    auditReq(req, "support.cost.update", `support_operating_cost:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/tiers", requireAdminApi, async (_req, res) => {
  res.json({ items: await listSupportTiersAsync() });
});

app.post("/api/admin/support/tiers", requireAdminApi, async (req, res) => {
  try {
    const row = await createSupportTierAsync(req.body || {});
    auditReq(req, "support.tier.create", `support_tier:${row.id}`, null, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.put("/api/admin/support/tiers/:id", requireAdminApi, async (req, res) => {
  try {
    const before = (await listSupportTiersAsync()).find((row) => Number(row.id) === Number(req.params.id));
    const row = await updateSupportTierAsync(Number(req.params.id), req.body || {});
    auditReq(req, "support.tier.update", `support_tier:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/providers", requireAdminApi, async (_req, res) => {
  res.json({ items: await listSupportProvidersAsync() });
});

app.put("/api/admin/support/providers/:id", requireAdminApi, async (req, res) => {
  try {
    const before = (await listSupportProvidersAsync()).find((row) => Number(row.id) === Number(req.params.id));
    const row = await updateSupportProviderAsync(Number(req.params.id), req.body || {});
    auditReq(req, before?.page_url !== row.page_url ? "support.checkout_url.update" : "support.provider.update", `support_provider:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/transactions", requireAdminApi, async (req, res) => {
  res.json({
    items: await listSupportTransactionsAsync({ from: req.query.from, to: req.query.to }),
  });
});

app.post("/api/admin/support/transactions/manual", requireAdminApi, async (req, res) => {
  try {
    const row = await createManualTransactionAsync(req.body || {});
    auditReq(req, "support.transaction.manual", `support_transaction:${row.id}`, null, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.put("/api/admin/support/transactions/:id", requireAdminApi, async (req, res) => {
  try {
    const before = (await listSupportTransactionsAsync()).find((row) => Number(row.id) === Number(req.params.id));
    const row = await updateSupportTransactionAsync(Number(req.params.id), req.body || {});
    const action = row.status === "refunded" ? "support.transaction.refund" : "support.transaction.update";
    auditReq(req, action, `support_transaction:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/sponsors", requireAdminApi, async (_req, res) => {
  res.json({ items: await listSupportSponsorsAsync() });
});

app.post("/api/admin/support/sponsors", requireAdminApi, async (req, res) => {
  try {
    const row = await createSupportSponsorAsync(req.body || {});
    auditReq(req, "support.sponsor.create", `support_sponsor:${row.id}`, null, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.put("/api/admin/support/sponsors/:id", requireAdminApi, async (req, res) => {
  try {
    const before = (await listSupportSponsorsAsync()).find((row) => Number(row.id) === Number(req.params.id));
    const row = await updateSupportSponsorAsync(Number(req.params.id), req.body || {});
    const action = ["active", "disabled"].includes(row.status) ? "support.sponsor.publish" : "support.sponsor.update";
    auditReq(req, action, `support_sponsor:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/support/cta-rules", requireAdminApi, async (_req, res) => {
  res.json({ items: await listCtaRulesAsync() });
});

app.put("/api/admin/support/cta-rules/:id", requireAdminApi, async (req, res) => {
  try {
    const before = (await listCtaRulesAsync()).find((row) => Number(row.id) === Number(req.params.id));
    const row = await updateCtaRuleAsync(Number(req.params.id), req.body || {});
    auditReq(req, "support.cta.update", `support_cta_rule:${row.id}`, before, row);
    res.json(row);
  } catch (error) {
    sendSupportError(res, error);
  }
});

app.get("/api/admin/help-qa", requireAdminApi, async (_req, res) => {
  res.json(await getHelpQaAsync());
});

app.put("/api/admin/help-qa", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveHelpQaAsync(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/wish-conditions", requireAdminApi, async (_req, res) => {
  res.json(await getWishConditionsAsync());
});

app.put("/api/admin/wish-conditions", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveWishConditionsAsync(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/rental-catalog", requireAdminApi, async (_req, res) => {
  const published = await getRentalCatalogAsync();
  const draft = await getRentalCatalogDraftAsync();
  res.json({
    published: publicAdminCatalog(published, { revealIds: true }),
    draft,
    diff: draft ? catalogDiff(published, draft) : null,
    templates: (await getRentalCatalogTemplatesAsync()).map((row) => ({
      id: row.id,
      label: row.label,
      system: isSystemCatalogTemplate(row.id),
    })),
    flags: publicRentalMarketplaceFlags(await getRentalMarketplaceFlagsAsync()),
  });
});

app.put("/api/admin/rental-catalog", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveRentalCatalogAsync(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/rental-catalog/mutate", requireAdminApi, async (req, res) => {
  try {
    res.json(await mutateRentalCatalogAsync(req.body?.action, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/rental-catalog/templates", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveRentalCatalogTemplateAsync(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.patch("/api/admin/rental-catalog/templates/:id", requireAdminApi, async (req, res) => {
  try {
    res.json(await renameRentalCatalogTemplateAsync(req.params.id, req.body?.label));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.delete("/api/admin/rental-catalog/templates/:id", requireAdminApi, async (req, res) => {
  try {
    res.json(await deleteRentalCatalogTemplateAsync(req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/rental-catalog/templates/:id/apply", requireAdminApi, async (req, res) => {
  try {
    res.json(await applyRentalCatalogTemplateAsync(req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/rental-catalog/draft/publish", requireAdminApi, async (_req, res) => {
  try {
    res.json(await publishRentalCatalogDraftAsync());
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/rental-marketplace-flags", requireAdminApi, async (_req, res) => {
  res.json(publicRentalMarketplaceFlags(await getRentalMarketplaceFlagsAsync()));
});

app.put("/api/admin/rental-marketplace-flags", requireAdminApi, (req, res) => {
  try {
    res.json(saveRentalMarketplaceFlags(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/rental-match-rules", requireAdminApi, async (_req, res) => {
  res.json(await rentalMatchAdminRulesAsync());
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

app.get("/api/admin/remote-cs", requireAdminApi, async (_req, res) => {
  res.json(await getRemoteCsControlAsync());
});

app.put("/api/admin/remote-cs", requireAdminApi, async (req, res) => {
  const stop = req.body?.stop === true || req.body?.stop === 1 || req.body?.stop === "1";
  res.json(await setRemoteCsStopAsync(stop));
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

app.get("/api/spirit", async (_req, res) => {
  res.json(await getSpiritAsync());
});

app.get("/api/housing-data", async (_req, res) => {
  res.json(await getHousingDataAsync());
});

app.get("/api/admin/housing-data", requireAdminApi, async (_req, res) => {
  res.json(await getHousingDataAsync());
});

app.put("/api/admin/housing-data", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveHousingDataAsync(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/housing-data/refresh", requireAdminApi, async (_req, res) => {
  try {
    // 這三個都改走 driver-aware 版本：PG 模式下讀寫 PostgreSQL，不再只寫回答你那台的本機檔。
    const summary = await refreshHousingData({
      getData: () => getHousingDataRawAsync(),
      writeData: (data) => writeHousingDataAsync(data),
    });
    res.json({ ok: true, ...summary, data: await getHousingDataAsync() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/admin/spirit", requireAdminApi, async (_req, res) => {
  res.json(await getSpiritAsync());
});

app.put("/api/admin/spirit", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveSpiritAsync(req.body || {}));
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

app.get("/api/admin/documents", requireAdminApi, async (req, res) => {
  res.json({
    types: Object.values(DOC_TYPES),
    items: await listContentDocumentsAsync({ type: req.query?.type, includeDrafts: true }),
  });
});

app.get("/api/admin/documents/:id/events", requireAdminApi, async (req, res) => {
  res.json({ items: await listContentEventsAsync({ documentId: req.params.id }) });
});

app.get("/api/admin/documents/:id", requireAdminApi, async (req, res) => {
  const doc = await getContentDocumentAsync(req.params.id);
  if (!doc) {
    res.status(404).json({ error: "找不到文件" });
    return;
  }
  res.json({ ...doc, html: renderSafeContent(doc.body, doc.format), events: await listContentEventsAsync({ documentId: doc.id }) });
});

app.post("/api/admin/documents", requireAdminApi, async (req, res) => {
  try {
    const session = readSession(req);
    res.status(201).json(await createContentDraftAsync(req.body || {}, { actorId: session?.userId || 0 }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.patch("/api/admin/documents/:id", requireAdminApi, async (req, res) => {
  try {
    const session = readSession(req);
    res.json(await updateContentDraftAsync(req.params.id, req.body || {}, { actorId: session?.userId || 0 }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/documents/:id/publish", requireAdminApi, async (req, res) => {
  try {
    const session = readSession(req);
    res.json(await publishContentDocumentAsync(req.params.id, { actorId: session?.userId || 0 }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/documents/:id/new-version", requireAdminApi, async (req, res) => {
  try {
    const session = readSession(req);
    res.status(201).json(await newContentVersionAsync(req.params.id, { actorId: session?.userId || 0 }));
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

app.get("/api/admin/crawl-sources", requireAdminApi, async (_req, res) => {
  const base = await getCrawlSourcesAsync();
  const health = Object.fromEntries((await crawlSourceHealthAsync()).map((row) => [row.id, row]));
  res.json({
    items: (base.items || []).map((row) => ({ ...health[row.id], ...row, label: row.label })),
  });
});

app.put("/api/admin/crawl-sources", requireAdminApi, async (req, res) => {
  try {
    const before = await getCrawlSourcesAsync();
    const saved = await saveCrawlSourcesAsync(req.body || {});
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

app.get("/api/admin/audit", requireAdminApi, async (req, res) => {
  res.json({ items: await listAdminAuditAsync({ limit: Number(req.query?.limit) || 80 }) });
});

app.get("/api/admin/listings/search", requireAdminApi, (req, res) => {
  res.json({ items: searchAdminListings(req.query?.q, Number(req.query?.limit) || 20) });
});

app.post("/api/admin/same-house/confirm", requireAdminApi, async (req, res) => {
  try {
    const session = readSession(req);
    const ids = req.body?.postIds || req.body?.ids || [];
    const result = await mergeSameHouseForUserAsync(session.userId, ids, { admin: true });
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

app.get("/api/self-listings/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await getSelfListingAsync(req.params.id, { viewerId: session.userId }));
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
app.get("/api/media", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    const tagIds = String(req.query.tag_ids || "").split(",").map(Number).filter((n) => n > 0);
    res.json(await listMemberMediaAsync(session.userId, { plan: session.plan || "free", tagIds }));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.get("/api/media/tags", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json({ items: await listMediaTagsAsync(session.userId) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.post("/api/media/tags", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await createMediaTagAsync(session.userId, req.body?.name));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.patch("/api/media/tags/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await renameMediaTagAsync(session.userId, req.params.id, req.body?.name));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.delete("/api/media/tags/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await deleteMediaTagAsync(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.put("/api/media/:id/tags", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await setMediaTagsAsync(session.userId, req.params.id, req.body?.tag_ids || req.body?.tags));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.get("/api/media/by-tags", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    const tagIds = String(req.query.tag_ids || "").split(",").map(Number).filter((n) => n > 0);
    res.json({ urls: await mediaUrlsForTagIdsAsync(session.userId, tagIds) });
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

app.delete("/api/media/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await deleteMemberMediaAsync(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

// 素材庫公開顯示檔（主圖／已浮水印縮圖）。未浮水印 original 不經此路由解析。
app.get("/media/lib/:file", servePublicMemberMedia);

// ── 公開分享：站內會員刊登（未登入可看主要內容；只輸出白名單公開欄位） ──
app.get("/api/public/self-listing/:id", async (req, res) => {
  try {
    const listing = await getSelfListingAsync(req.params.id, { viewerId: 0 });
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

app.get("/api/listing-imports/meta", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await importMetaAsync({ plan: session.plan || "free" }));
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
app.get("/api/listing-description-templates", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json({
      items: await listDescriptionTemplatesAsync(session.userId),
      limit: listingToolsMeta(session).description_template_limit,
    });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.post("/api/listing-description-templates", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await createDescriptionTemplateAsync(session.userId, req.body || {}, { plan: session.plan, role: session.role }));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.get("/api/listing-description-templates/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await getOwnedDescriptionTemplateAsync(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.patch("/api/listing-description-templates/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await updateDescriptionTemplateAsync(session.userId, req.params.id, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.delete("/api/listing-description-templates/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await deleteDescriptionTemplateAsync(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.get("/api/listing-contact-profiles", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json({
      items: await listContactProfilesAsync(session.userId),
      limit: listingToolsMeta().contact_profile_limit,
    });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.post("/api/listing-contact-profiles", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await createContactProfileAsync(session.userId, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.get("/api/listing-contact-profiles/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await getOwnedContactProfileAsync(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.patch("/api/listing-contact-profiles/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await updateContactProfileAsync(session.userId, req.params.id, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.delete("/api/listing-contact-profiles/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await deleteContactProfileAsync(session.userId, req.params.id));
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

app.post("/api/push/subscribe", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await savePushSubscriptionAsync(session.userId, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/push/unsubscribe", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await deletePushSubscriptionAsync(session.userId, req.body?.endpoint));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/mail/test", requireAdminApi, async (req, res) => {
  try {
    const session = readSession(req);
    const to = String(req.body?.to || session?.email || "").trim();
    if (!to) throw new Error("請先填收件信箱");
    const smtp = await getStoredSmtpAsync();
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
  // 上班地址與座標是會員設定，必須與其他節點同源：PG 模式下讀寫本機 SQLite 會讓
  // 「在 A 儲存的地址、B 讀不到」而重複補座標或覆蓋新值。
  const current = await getSettingsAsync(uid);
  if (!(Number(current.commuteKm) > 0)) return current;
  const workAddress = String(current.workAddress || "").trim();
  if (!workAddress || (hasWorkPoint(current) && isTaiwanCoord(current.workLat, current.workLng))) return current;
  try {
    const geo = await geocodeAddress(workAddress, getCachedGeo, { strict: false, maxAttempts: 2, allowAdmin: false });
    if (!geo) return current;
    setCachedGeo(workAddress, geo.lat, geo.lng, geo);
    return await saveSettingsAsync({ workLat: geo.lat, workLng: geo.lng, workLocationClass: geo.location_class || "" }, uid);
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
import { withPgCrawlOwner } from "./crawlOwnership.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { coveringPlanAsync, reserveCoveringPlan } from "./crawlScheduleAsync.js";

// 2026-09-27 診斷用：`CRAWL_TRACE=1` 時把每一輪抓取拆成階段並記下耗時。
// 背景：正式站首次檢查固定耗時 30 秒後失敗，且 HAProxy 的終止代碼是 `cD`
// （應用端 30 秒沒送資料才被切斷），但 DB 端沒有任何查詢超過 1 秒，
// 對外網路也正常。所以那 30 秒花在應用端某個「不碰 DB」的工作上，需要逐步定位。
const CRAWL_TRACE = process.env.CRAWL_TRACE === "1";

function traceStep(label, promise) {
  if (!CRAWL_TRACE) return promise;
  const started = Date.now();
  return promise.then(
    (value) => {
      console.log(`[trace] ${label} ${Date.now() - started}ms`);
      return value;
    },
    (error) => {
      console.log(`[trace] ${label} 失敗 ${Date.now() - started}ms :: ${error?.message || error}`);
      throw error;
    },
  );
}

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
    const execute = async () => {
      // 帳號維護必須與其他節點同源：PG 模式下只寫本機 SQLite 會讓兩台各自標記過期／暫停。
      await traceStep("expireStaleVerifyTokens", expireStaleVerifyTokensAsync({
        onExpire: (user) => {
          if (user?.email) queueSystemMail("verify_expired", user.email);
        },
      }));
      try {
        await traceStep("pauseIdleMembers", pauseIdleMembersAsync());
      } catch (error) {
        console.warn("閒置暫停失敗：", error.message);
      }
      const now = Date.now();
      const systemDue = reason === "force" || reason === "startup" || (await traceStep("isSystemCoveringDue", isSystemCoveringDueAsync(now)));
      if (
        reason === "manual"
        && !systemDue
        && lastRun?.checked_at
        && !lastRun.error
        && isWatchIntervalPending(lastRun.checked_at, crawlIntervalMinutes(), now)
      ) {
        const duePlan = await traceStep("coveringPlan(due)", coveringPlanAsync({ now, includeSystem: false }));
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
      const plan = await traceStep("reserveCoveringPlan", reserveCoveringPlan({ now, includeSystem }));
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
      const result = await traceStep("runWatch", runWatch({
        skipHeavyGeo: true,
        jobs: plan.jobs,
        memberRequirements: plan.memberRequirements,
        includeSystem: plan.includeSystem,
      }));
      return result;
    };
    const result = await withBudget(async signal => {
      if (resolveDbDriver() !== "postgres") return execute();
      return withPgCrawlOwner(await sharedPgDriver(), execute, { signal });
    }, TICK_BUDGET_MS, "這輪抓取", { signal: tickGate.signal(tickGen) });
    if (!tickGate.isCurrent(tickGen) || ["owner_busy", "idle", "interval"].includes(result?.skipped)) return result;
    lastRun = result;
    lastRun.reason = reason;
    // Independent background jobs must not inherit the finished crawl's owner.
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
    // 2026-09-27：這裡原本是 `.catch(() => {})`，把每一輪的失敗完全吞掉，
    // 所以一次長達 5 小時的 crawler 停擺，在日誌裡只留下一行啟動失敗。
    // 排程 60 秒才一輪，記下耗時與結果不會造成噪音，卻是唯一能看出「週期有沒有跑完」的地方。
    const started = Date.now();
    tick("schedule")
      .then((result) => {
        const ms = Date.now() - started;
        if (result?.skipped) console.log(`排程抓取略過：${result.skipped}（${ms}ms）`);
        else if (result?.error) console.warn(`排程抓取回報錯誤（${ms}ms）：${result.error}`);
        else console.log(`排程抓取完成（${ms}ms）`);
      })
      .catch((error) => {
        console.warn(`排程抓取失敗（${Date.now() - started}ms）：`, error?.message || error);
      });
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

app.get("/api/member-mail", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    res.json(await getMemberMailSettingsAsync(session.userId));
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

app.post("/api/member-mail", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    res.json(await saveMemberMailSettingsAsync(session.userId, req.body || {}));
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
      await saveMemberMailSettingsAsync(uid, { smtp: req.body.smtp });
    }
    const smtp = (await getMemberMailBundleAsync(uid)).smtp || {};
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
    confirmExpiredOfflineFromSettings();
    const page = await loadListingPage({
      filter: "all", sort: "newest", limit: 500, offset: 0,
      userId: uid, matchVoteUserId: uid,
    });
    listings = page.listings;
    listingStats = page.stats;
    events = recentEvents(30, uid);
  } catch (error) {
    if (sendListingSearchUnavailable(res, error)) return;
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
  try {
    const page = await loadListingPage(args);
    res.setHeader("Server-Timing", `list;dur=${page.timing.query_ms}, stats;dur=${page.timing.stats_ms}`);
    page.timing.total_ms = Date.now() - started;
    res.json(page);
  } catch (error) {
    if (sendListingSearchUnavailable(res, error)) return;
    throw error;
  }
});

app.post("/api/listings/hide-many", async (req, res) => {
  const session = requireMember(req, res);
  if (!session) return;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) {
    res.status(400).json({ error: "請先勾選物件" });
    return;
  }
  try {
    res.json(await hideManyAsync(ids, session.userId));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "批次隱藏失敗" });
  }
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
    const updated = await setFlagsAsync(Number(req.params.id), req.body || {}, uid);
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

app.post("/api/listings/:id/reject-match", async (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入才能拆開同屋源" });
    return;
  }
  const result = await rejectSuspectedMatchAsync(Number(req.params.id), session.userId, {
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
    stats: await listingStatsAsync({ userId: session.userId }),
    personal: true,
    promoted: result.promoted,
    remaining: result.remaining,
  });
});

app.post("/api/listings/:id/confirm-match", async (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入才能併入同房源" });
    return;
  }
  const result = await confirmSuspectedMatchAsync(Number(req.params.id), session.userId, {
    admin: session.role === "admin",
  });
  if (!result?.ok && !result?.listing) {
    res.status(404).json({ error: "找不到這筆物件或缺少比對對象" });
    return;
  }
  res.json({
    listing: result.listing,
    stats: await listingStatsAsync({ userId: session.userId }),
    personal: result.personal !== false && !result.admin_confirmed,
    shared: result.shared === true,
    admin_confirmed: result.admin_confirmed === true,
    group_id: result.group_id || "",
    message: result.message || "",
  });
});

app.post("/api/listings/merge-same-house", async (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入才能併入同房源" });
    return;
  }
  const result = await mergeSameHouseForUserAsync(session.userId, req.body?.ids || req.body?.post_ids, {
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
    stats: await listingStatsAsync({ userId: session.userId }),
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
    res.json({ result: { ...result, events }, stats: await listingStatsAsync({ userId: uid }) });
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
  // ⚠️ 這是**排程**的居住數據自動更新（日誌「居住數據自動更新：N 筆」就是它）。
  // 原本用同步的 SQLite 讀寫 ⇒ PG 模式下自動抓到的居住成本只寫進回答你那台的本機檔，
  // 另一台看不到、PG 也永遠不會更新（`housingData` 本來就已經是「三個來源各一版」）。
  // 改走 driver-aware 版本才是真正修掉分歧，不只是讓判定變綠。
  refreshHousingData({ getData: () => getHousingDataRawAsync(), writeData: (data) => writeHousingDataAsync(data) })
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
  const startedAt = Date.now();
  setTimeout(() => {
    console.log("啟動後首次抓取：開始");
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
        // 2026-09-27：這裡原本只印 error.message，看不出「跑了多久」。
        // 正式站的 HAProxy 對 PG 有 timeout client／server 各 30 秒，跑滿 30 秒就代表
        // 某個查詢超過了 timeout server；幾乎瞬間失敗則代表拿到已被切斷的閒置連線。
        // 沒有這個耗時，兩種完全不同的原因在日誌裡長得一模一樣。
        console.warn(
          `第一次檢查失敗（啟動後 ${Date.now() - startedAt}ms）：`,
          error?.message || error,
        );
      });
  }, 20000);
}
