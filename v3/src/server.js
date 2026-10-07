import "./env.js";
import { resolveAppRole, roleRunsWeb, roleRunsCrawler, roleRunsWorker } from "./appRole.js";
// `/api/*` 的 JSON 保底（404／錯誤中介層）：原本這兩種情況會回 HTML，前端 `res.json()` 直接爆
// 「Unexpected token '<'」（第八十九批，正式站實際回報）。
import { apiErrorHandler, apiNotFoundHandler, statusOfApiError } from "./apiFallbacks.js";
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
  settingsForGeoBackfillAsync,
} from "./settingsAsync.js";
// 帳號維護（過期驗證碼、閒置暫停）：PG 模式下與其他節點同源。
import { expireStaleVerifyTokensAsync, pauseIdleMembersAsync } from "./accountMaintenanceAsync.js";
// 個人旗標（收藏／隱藏／已看過）：站上讀 PG 的 user_listing_flags，寫入也必須進 PG。
import { setFlagsAsync } from "./personalFlagsAsync.js";
import { getListingAsync } from "./listingDetailAsync.js";
// 需求統計／首頁需求曝險的 PG 島嶼入口。
import { aggregateDemandAsync, homepageDemandExposureAsync } from "./demandAggregateAsync.js";
// 站內刊登的屋主配對讀取島嶼（第八十批）。
import {
  listMineSelfListingsAsync,
  listingToolsInfoAsync,
  ownerListingMatchSummaryAsync,
  ownerListingMatchesAsync,
  pairStillHardEligibleAsync,
  rentalMatchOwnerMetaAsync,
} from "./rentalMatchAsync.js";
// 站內複製島嶼
import {
  assertOwnsMemberMediaUrlsAsync,
  copyOwnListingAsync,
  createSelfListingAsync,
  publishImportedDraftListingAsync,
} from "./selfListingsAsync.js";
// 匯入的「確認後刊登」PG 島嶼入口（第八十三批）。
import { publishConfirmedImportAsync } from "./listingImportAsync.js";
// 配對候選的 PG 讀取（`publishImportedDraftListingAsync` 會用它挑同類物件）。
import { matchCandidatesAsync } from "./crawlerReads.js";
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
  getSettings,
  hideMany,
  listListings,
  loadProfile,
  registerUser,
  confirmVerifyToken,
  confirmSuspectedMatch,
  listPublicListings,
  listPublicListingsFast,
  publicSearchSettings,
  GUEST_MAX_DISTRICTS,
  sameHouseBackfillStatus,
  mergeSameHouseForUser,
  saveAsProfile,
  saveSettings,
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
  getMailTemplates,
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
  getAdminProviderSettings,
  saveAdminProviderSettings,
  saveAdminSiteBudget,
  testAdminProvider,
  getAdminSimilaritySettings,
  saveAdminPhashSettings,
  reviewAdminSimilarity,
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
  applyWishLifecycleFor,
  runWishLifecycleWorkerTick,
  getSpirit,
  saveSpirit,
  getHousingData,
  saveHousingData,
  getHousingDataRaw,
  writeHousingData,
  getCrawlSources,
  saveCrawlSources,
  armMemberExternalFetch,
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
  rentalMatchAdminRules,
  rentalMatchOwnerMeta,
  getWishOfferFor,
  reportWishOfferFor,
  runWishOfferExpiryWorkerTick,
  recordShareEventFor,
  runRentalNotifyWorkerTick,
  listingToolsInfo,
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
  saveMemberMediaFor,
  listMemberMediaFor,
  deleteMemberMediaFor,
  listMediaTagsFor,
  createMediaTagFor,
  renameMediaTagFor,
  deleteMediaTagFor,
  setMediaTagsFor,
  mediaUrlsForTagIdsFor,
  closeSelfListing,
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
  DOC_TYPES,
  publicDocumentView,
  getCommsConfig,
  saveCommsConfig,
  db,
} from "./db.js";
// 變更紀錄的讀取（PG 島嶼）：寫入端已經是 driver-aware（`createWritePath.bumpRevision`），
// 這一半補上之後寫／讀才同源。
import { changesSinceAsync, currentRevisionAsync } from "./dataRevisionAsync.js";
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
import { adminEmail, clearSessionCookie, envAdminConfigured, readSession, requireAuth, resolveSession, sessionCookie, verifyLogin, verifyLoginAsync } from "./auth.js";
// 刊登生產力工具（說明範本／聯絡人）的 PG 島嶼入口。
// `listingToolsMeta` 是**純函式**：上限只取決於 plan／role，而 session 已經每請求從 PG
// 解析出來了，所以不必再 `getUserById()` 查一次 users（那正是這 10 條路由原本的 SQLite 卡點）。
import { listingToolsMeta } from "./listingTools.js";
import { deletePushSubscriptionAsync, savePushSubscriptionAsync } from "./webPushAsync.js";
import {
  applyBrandUploadAsync,
  getAdminAdsSettingsAsync,
  getAdminBroadcastsSettingsAsync,
  getAdminMapsSettingsAsync,
  saveAdminMapsSettingsAsync,
  saveAdminMailSettingsAsync,
  saveAdminOauthSettingsAsync,
} from "./adminSettingsAsync.js";
// 註冊信箱確認與忘記密碼的 PG 島嶼入口。
import { confirmVerifyTokenAsync, issueVerifyTokenAsync } from "./emailVerifyAsync.js";
// 通勤快照（地圖卡片的通勤欄位）的 PG 島嶼入口。
import { listingCommutePatchesAsync } from "./listingCommuteAsync.js";
import { requestTempPasswordAsync } from "./forgotPasswordAsync.js";
import { recordShareEventAsync, sharePageExtrasAsync } from "./rentalShareGrowthAsync.js";
// 法律文案（免責聲明／個資說明）的 PG 島嶼入口：一份文案、兩個 store
// （settings 與 content_documents），同步版在 PG 站是「寫本機、訪客讀不到」的靜默失效。
import { getLegalCopyAsync, saveLegalCopyAsync } from "./legalCopyAsync.js";
import {
  cancelListingImportAsync,
  confirmListingImportAsync,
  getOwnedListingImportViewAsync,
  importMetaAsync,
  listAdminListingImportsAsync,
  listMineListingImportsAsync,
  reviewListingImportAsync,
  startListingImportAsync,
} from "./listingImportAsync.js";
// 會員帳號的 PG 島嶼入口（登入、身分來源）。
// `defaultUserIdAsync` 特別重要：沒有 session 時同步版會在**本機**建一個 admin 帳號、
// 回傳**本機** id，之後拿它去讀 PG 設定就會跨店錯位。
// 第九十批補回 `registerUserWithConsentsAsync`：`/api/register` 與 OAuth callback 都在呼叫它
// （少了 import ⇒ 註冊直接 500）。
import {
  changeUserPasswordAsync,
  registerUserWithConsentsAsync,
  defaultUserIdAsync,
  findUserByEmailAsync,
  listUserIdsAsync,
  getUserByIdAsync,
  linkOauthIdentityAsync,
  resumeIdleIfNeededAsync,
  touchLastLoginAsync,
  updateUserProfileWithLegalAsync,
} from "./usersAsync.js";
// 後台會員管理（列表／停權／復原／改方案）的 PG 島嶼入口。
import {
  adminDeleteMemberAsync,
  adminPatchMemberAsync,
  adminRestoreMemberAsync,
  countOpenSelfListingsAsync,
  deleteOwnAccountAsync,
  listAdminMembersAsync,
} from "./adminMembersAsync.js";
import { runSameHouseBackfillAsync, sameHouseBackfillStatusAsync } from "./sameHouseAsync.js";
import { createCaseFromFeedbackAsync, enqueueCrmFromFeedbackAsync, setCrmEnabledAsync } from "./crmAsync.js";
import { deleteWishExampleAsync, getWishExampleAsync, saveWishExampleAsync } from "./wishExampleAsync.js";
import { closeSelfListingAsync, hideSelfListingAsync, reportSelfListingAsync } from "./selfListingsAsync.js";
// 許願房的 PG 島嶼入口：檢舉／回覆／關閉＋列表／詳情＋生命週期寫入（更新／刊登／重開）。
// 讀取先搬是關鍵——在那之前「寫 PG、讀 SQLite」會讓新寫入看不到；現在兩邊同源。
import {
  addDemandReplyAsync,
  closeDemandPostAsync,
  createDemandAsync,
  getDemandPostAsync,
  listDemandPostsAsync,
  publishWishRoomAsync,
  reopenWishRoomAsync,
  reportDemandAsync,
  updateWishRoomAsync,
  wishRoomOwnerSummaryAsync,
} from "./demandAsync.js";
// 許願房提案（wishOffers）的 PG 島嶼入口：讀取、檢舉、封鎖名單、後台清單、聯絡方式與狀態機。
import {
  acceptWishOfferAsync,
  blockOwnerFromOfferAsync,
  createWishOfferAsync,
  declineWishOfferAsync,
  listAdminOfferReportsAsync,
  listMyBlocksAsync,
  listOwnerWishOffersAsync,
  listTenantWishOffersAsync,
  loadVisibleOfferAsync,
  projectOfferContactAsync,
  publicOfferViewAsync,
  reportVisibleOfferAsync,
  runWishOfferExpiryTickAsync,
  unblockByRefAsync,
  withdrawWishOfferAsync,
} from "./wishOffersAsync.js";
import { getRemoteCsControlAsync, setRemoteCsStopAsync } from "./siteCommandAsync.js";
import { getWishConditionsAsync, saveWishConditionsAsync } from "./rentalCatalogAsync.js";
// Admin 營運分析的 PG 島嶼入口（30 幾個彙總查詢；中位數那一句是方言分支）。
import {
  rentalOpsDrilldownAsync,
  rentalOpsSummaryAsync,
} from "./rentalOpsAnalyticsAsync.js";
// 會員同意紀錄（consents）的 PG 島嶼入口：列表、批次同意、歷史文件。
import {
  acceptPendingDocumentsAsync,
  getOwnConsentDocumentAsync,
  listMyConsentsAsync,
  pendingRequiredDocumentsAsync,
} from "./memberConsentsAsync.js";
// 租屋通知偏好／配對訂閱／取消訂閱的 PG 島嶼入口。
import {
  applyUnsubscribeTokenAsync,
  getMatchSubscriptionAsync,
  getRentalNotifyPrefsForAsync,
  saveMatchSubscriptionAsync,
  saveRentalNotifyPrefsForAsync,
} from "./rentalNotifyPrefsAsync.js";
// 完成問卷（survey）的 PG 島嶼入口：讀取、送出，以及 admin 的 survey_breakdown 零件。
import {
  getCompletionSurveyAsync,
  submitCompletionSurveyAsync,
} from "./rentalSurveyAsync.js";
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
  saveRentalMarketplaceFlagsAsync,
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
  saveMemberMediaAsync,
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
import { MRT_CACHE_CONTRACT, fetchMrtAccessWithin } from "./mrt.js";
import { setCachedMrtAsync } from "./crawlerWrites.js";
// geo_cache（跨節點共用的地理編碼快取）的 PG 島嶼入口。
import { geoLookupAsync, getCachedGeoAsync, setCachedGeoAsync } from "./geoCacheAsync.js";
// 「已下線但還沒確認」的自動確認掃描（原本只寫本機 SQLite）。
import { confirmExpiredOfflineAsync } from "./crawlerWrites.js";
// 通知佇列的 PG 島嶼入口（`GET /api/state` 的事件清單讀 `user_events`）。
import { recentEventsAsync } from "./notifyQueueAsync.js";
// 「清除物件紀錄／清除全部資料」的 PG 島嶼入口（管理員的核彈按鈕）。
import { resetAllDataAsync, resetListingsAsync } from "./siteResetAsync.js";
import { isTaiwanCoord } from "./geoPrecision.js";
import { listingRedirectTarget, publicBaseUrl as publicBaseUrlEnv } from "./openLink.js";
import { catalogTraitLabelMap, isSelfListingId, publicListingView, stripServerVerifiedFields } from "./selfListings.js";
import {
  absoluteAssetUrl,
  buildListingShareOgMeta,
  firstListingShareImage,
  injectListingShareMeta,
  listingShareDescription,
  listingShareUrl,
} from "./listingShare.js";
import {
  createListingShareLinkAsync,
  getListingShareFlagsAsync,
  listingShareOverviewAsync,
  listingShareStatsForAdminAsync,
  listingShareStatsForUserAsync,
  recordListingShareEventAsync,
} from "./listingShareAsync.js";
import {
  getSponsorEntitlementFlagsAsync,
  getSponsorEntitlementRulesAsync,
  setSponsorEntitlementFlagsAsync,
  setSponsorEntitlementRulesAsync,
  issueMemberSupportCodeAsync,
  currentMemberSupportCodeAsync,
  listEntitlementQueueAsync,
} from "./sponsorEntitlementAsync.js";
import { buildSponsorOutbound } from "./sponsorEntitlement.js";
import { handleSponsorEntitlementWebhookAsync } from "./sponsorEntitlementWebhook.js";
import { normalizeSponsorConfig, publicSponsorLinks } from "./sponsorLinks.js";
import { getSiteSettingAsync } from "./settingsKvAsync.js";
import { rentAmount } from "./listingCost.js";
import {
  buildPublicListingDetailResponse,
  isPublicListingDetail,
  listingDetailOgDescription,
  listingDetailOgTitle,
  similarPublicListingsAsync,
} from "./listingDetailPublic.js";
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
import { hideManyAsync, clearListingFlagsByUserAsync } from "./personalFlagsAsync.js";
// 第九十批補回 `getSystemCrawlAsync` 等三支：`/api/admin/system-crawl` 還在呼叫它們
// （少了 import 就是 ReferenceError → HTML 500）。
import {
  getCommsConfigAsync, getCrawlSourcesAsync, getHelpQaAsync, getHousingDataAsync,
  getHousingDataRawAsync, writeHousingDataAsync, getSpiritAsync,
  saveCommsConfigAsync, saveCrawlSourcesAsync, saveHelpQaAsync, saveHousingDataAsync, saveSpiritAsync,
  getSystemCrawlAsync, refreshSiteCatalogStatsAsync, saveSystemCrawlAsync,
} from "./siteContentAsync.js";
import { crawlSourceHealthAsync, searchAdminListingsAsync } from "./adminOverviewAsync.js";
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
import { buildDemoStateAsync } from "./demo.js";
import { backfillAddressGeo, backfillIncompleteAddresses, backfillListingCoords, backfillListingMrt, backfillListingRoutes, flushPendingNotifications, isWatchIntervalPending, listingEnrichHelpers, runWatch } from "./watcher.js";
import { LIST_PAGE_SIZE, isListingGoneError, probeListingAlive } from "./client591.js";
import { probeListingAliveBySource } from "./probe.js";
import { PROBE_ALIVE, PROBE_GONE, PROBE_INCONCLUSIVE, classifyListingProbeWrite } from "./probeOutcomes.js";
import { processListingEnrichBatch, wakeListingEnrichWorker, WATCH_PRIORITY } from "./listingEnrichQueue.js";
import { enrichClockConfig, startListingEnrichClock } from "./listingEnrichClock.js";
// 2.3b 第二段：入列與點擊複查走 driver-aware 版本（PG 模式才不會寫到本機 SQLite）。
import { enqueueListingEnrichAsync, requestClickRefreshAsync } from "./listingEnrichQueueAsync.js";
import { deliveryConfigFromEnv, startDeliveryLoop } from "./opsDelivery.js";
import { startWishLifecycleLoop } from "./wishLifecycleLoop.js";
import { startWishOfferExpiryLoop } from "./wishOfferWorker.js";
import { startRentalNotifyLoop } from "./rentalNotifyWorker.js";
// 三支 5 分鐘 tick 的 PG 島嶼入口（PG 模式下 worker 必須跑 PG 的資料，否則同步版讀寫本機）。
import { runWishLifecycleTickAsync } from "./wishLifecycleAsync.js";
import { runRentalNotifyTickAsync } from "./rentalNotifyWorkerAsync.js";
import { catalogDiff, isSystemCatalogTemplate, publicAdminCatalog } from "./rentalCatalog.js";
import { isRentalCatalogV2Enabled, publicRentalMarketplaceFlags } from "./rentalMarketplaceFlags.js";
import { startCrmDeliveryLoop } from "./crmDelivery.js";
import { opsDeliveryDb } from "./db.js";
import { startCrmDeliveryLoopAsync } from "./crmOutboxAsync.js";
// Ops 遞送（worker 與後台控制）的 PG 島嶼：PG 模式下 worker 必須送 **PG** 的佇列，
// 否則 `POST /api/feedback` 寫進 PG 的事件永遠不會被送出（靜默失效）。
import {
  deliveryControlAsync,
  setLocalDeliveryStoppedAsync,
  startDeliveryLoopAsync,
} from "./opsDeliveryAsync.js";
import { compactSentOutboxPayloadsAsync, outboxCapacityAlertAsync } from "./feedbackOutboxAsync.js";
// 物件來源歷史（同一 source_key 的其他刊登 ＋ 個人旗標）的 PG 島嶼入口。
import { sourceHistoryAsync } from "./sourceHistoryAsync.js";
// Ops 反向指令（套用 Ops 的處理結果）的 PG 島嶼。
import { handleApplyRequestAsync } from "./siteCommandApplyAsync.js";
// 回饋（feedback）的 PG 島嶼：送出時「feedback ＋ 初始 outbox 事件」必須在同一個交易裡，
// 否則會出現「回饋進去了、事件沒進去」的半套狀態（Ops 唯一來源就是那個事件）。
import {
  feedbackStatsAsync,
  listFeedbackAsync,
  submitFeedbackAsync,
  updateFeedbackAsync,
} from "./feedbackAsync.js";
import {
  FEEDBACK_ATTACHMENT_MAX,
  FEEDBACK_ATTACHMENT_MAX_BYTES,
} from "./feedbackMedia.js";
import {
  countOpenFeedbackAttachmentsAsync,
  deleteFeedbackAttachmentAsync,
  getFeedbackAttachmentAsync,
  getOpenFeedbackAttachmentAsync,
  listFeedbackAttachmentsForAsync,
  listOpenFeedbackAttachmentsAsync,
  listFeedbackAttachmentsAsync,
  saveFeedbackAttachmentAsync,
  streamFeedbackAttachment,
  sweepOrphanFeedbackAttachmentsAsync,
} from "./feedbackMediaAsync.js";
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
// 第九十批補回 `getMailTemplatesAsync`：`queueSystemMailAsync()` 用它讀 PG 的範本
// （少了 import 就寄不出任何系統信，而且會是 HTML 500）。
import {
  getAdminMailSettingsAsync,
  getStoredSmtpAsync,
  getAdminOauthSettingsAsync,
  getStoredOauthAsync,
  getAdminSponsorSettingsAsync,
  getBrandMascotAsync,
  publicSponsorSettingsAsync,
  saveAdminSponsorSettingsAsync,
  saveBrandMascotAsync,
  getMailTemplatesAsync,
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
import { crawlSourceHealth, getAdminDataHealthAsync, getAdminOverviewAsync } from "./adminOverview.js";
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
// 站內刊登分享頁：啟動時讀一次＋快取；檔案變動不必 hot reload（OG 注入用同一份快取）。
const LISTING_SHARE_TEMPLATE = readFileSync(path.join(__dirname, "../public/listing.html"), "utf8");
// 通用物件公開內頁：啟動時讀一次＋快取（與 listing.html 相同，不 hot reload）。
// detail.html 由前端同事建立；尚未存在時留空字串，`/p/:id` 會 fail-soft 回退到 listing.html 範本。
let LISTING_DETAIL_TEMPLATE = "";
try {
  LISTING_DETAIL_TEMPLATE = readFileSync(path.join(__dirname, "../public/detail.html"), "utf8");
} catch {
  LISTING_DETAIL_TEMPLATE = "";
}

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
    const path = req.originalUrl || req.url || "";
    if (path.startsWith("/api/ops/commands/apply") || path.startsWith("/api/support/webhook/")) {
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
    // 訪客示範的會員掃描、清單與統計全部走 PG 島嶼（同步版在 PG 模式下只看得到這台節點的資料）。
    // 清單刻意用**訪客列表頁同一條管線**（`searchPublicListingsAsync`），兩個 driver 才會一致。
    res.json(await buildDemoStateAsync({
      listUserIdsAsync,
      getSettingsAsync,
      defaultUserIdAsync,
      listListingsAsync: searchPublicListingsAsync,
      statsAsync: listingStatsAsync,
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
  // 快取讀寫都走 PG 島嶼（`geo_cache` 跨節點共用；本機那份只有 crawler 在寫）。
  const cached = await getCachedGeoAsync(address);
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
    const geo = await geocodeAddress(address, geoLookupAsync(), {
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
      await setCachedGeoAsync(address, geo.lat, geo.lng, geo);
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

// `actorUserId()` 的 PG 版。沒有 session 時同步版會呼叫 `defaultUserId()`：
// 那會在**節點本機**建一個 admin 帳號並回傳**本機** id，PG 模式下等於拿錯 store 的 id。
async function actorUserIdAsync(req) {
  const session = readSession(req);
  if (session?.userId) return session.userId;
  return defaultUserIdAsync();
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

function kickListingEnrich({ limit = 4, stats = null } = {}) {
  return wakeListingEnrichWorker(() =>
    processListingEnrichBatch(db, listingEnrichHelpersWithEvents(), { limit })
      .then((result) => {
        // stats 只給時鐘讀（要拿得到「本輪真的嘗試了幾筆」才能判斷要不要退避）；
        // 事件 kick 不傳 stats ⇒ 行為與改動前完全一致。
        if (stats) stats.attempted += Number(result?.attempted) || 0;
        return result;
      })
      .catch((error) => {
        console.warn("5168 補抓失敗：", error.message);
      }),
  );
}

/** 點通知／Discord 連結：已登入才標記已瀏覽，再導向原站。站內刊登：會員開站內詳情、訪客開公開分享頁。訪客只轉址、不寫入。 */
app.get("/go/:id", async (req, res) => {
  const id = Number(req.params.id);
  let listing = null;
  const session = readSession(req);
  const ref = String(req.query?.ref || "").trim();
  if (Number.isFinite(id) && id > 0) {
    try {
      // Awaited so the redirect follows the store the list came from (listingDetailAsync.js).
      listing = await getListingAsync(id);
      if (ref) {
        // 分享落地：query 有合法 ref 時，**先** server 端記一筆 view（不依賴 cookie），
        // 再照原邏輯 302。token 無效／限流只損失該筆歸因，不擋住轉址。
        await recordListingShareEventAsync({
          shareToken: ref,
          eventType: "view",
          userId: session?.userId || null,
          ip: clientIp(req),
          userAgent: req.get("user-agent") || "",
          source: "public",
        }).catch(() => {});
      }
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
  // ⚠️ 這一條是**啟動路徑**（前端 `loadState()` 第一支就打它）：它原本沒有 try/catch，
  // 只要其中一支 async 查詢丟錯就會變成 Express 預設的 HTML 500，前端 `res.json()` 直接爆
  // 「Unexpected token '<'」。現在失敗一律回 JSON（並保留 `ok:false` 的訪客語意）。
  try {
  const session = readSession(req);
  // 這一頁的會員欄位與「開著的自主刊登數」都必須讀 PG（`readSession` 的身分也來自 PG）：
  // 讀本機在 PG 站會顯示別台節點看不到的舊資料（第七十一批）。
  if (session?.userId) await touchLastLoginAsync(session.userId, { minIntervalMs: 12 * 60 * 60 * 1000 });
  const user = session?.userId ? await getUserByIdAsync(session.userId) : null;
  const nickname = String(user?.nickname || "").trim();
  // 法律文案走 PG 島嶼：這一頁顯示的是「使用者同意的那一份」，讀本機在 PG 站會顯示舊版。
  const legal = await getLegalCopyAsync();
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
    privacy_text: legal.privacy,
    disclaimer_text: legal.disclaimer,
    privacy_check: legal.privacyCheck,
    disclaimer_check: legal.disclaimerCheck,
    // ⚠️ 這兩支必須用 **async 島嶼**（PG 模式要讀 PG；同步版讀的是節點本機的舊資料）。
    // 第四十八批把 `/api/consents` 改成 async 版時，連這兩支的 import 一起移除了，
    // 但 `/api/me` 這兩行**還在呼叫同步版** ⇒ 已登入的會員每次打 `/api/me` 都丟
    // `ReferenceError: pendingMemberDocuments is not defined`（HTML 500 → 前端顯示
    // 「Unexpected token '<'」／登入後仍顯示訪客）。第八十九批修的是訊息形狀，這一包修的是根因。
    pending_documents: session?.userId ? await pendingRequiredDocumentsAsync(session.userId) : [],
    consents: session?.userId ? await listMyConsentsAsync(session.userId) : [],
    open_self_listings: session?.userId ? await countOpenSelfListingsAsync(session.userId) : 0,
    configured: true,
    canRegister: true,
    hint: "",
    version: APP_VERSION,
    vapidPublicKey: publicVapidKey(),
    sponsor: session ? await publicSponsorSettingsAsync(session) : { show: false, links: [], sponsored: false, intro: "", thanks: "" },
  });
  } catch (error) {
    // 這條是啟動路徑：寧可回「訪客 + 需要重試」，也不要讓前端拿到 HTML 而顯示天書。
    console.error("[api] GET /api/me 失敗：", error?.message || error);
    res.status(statusOfApiError(error)).json({ error: "個人資料暫時無法載入，請稍後再試", code: error?.code || "me_failed" });
  }
});

app.patch("/api/profile", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    // 個人資料在 PG 上；連法律文案（`withLegalProfile()`）也要讀 PG，否則會員看到的是本機那一份。
    const user = await updateUserProfileWithLegalAsync(session.userId, req.body || {});
    res.json({ ok: true, ...user });
  } catch (error) {
    sendAuthError(res, error);
  }
});

app.get("/api/disclaimer", async (_req, res) => {
  try {
    res.json(await getLegalCopyAsync());
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
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

app.post("/api/consents", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json({
      ok: true,
      consents: await acceptPendingDocumentsAsync(session.userId, req.body?.consents, { source: "reaccept" }),
      pending_documents: await pendingRequiredDocumentsAsync(session.userId),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/consents", async (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入" });
    return;
  }
  res.json({ items: await listMyConsentsAsync(session.userId), pending_documents: await pendingRequiredDocumentsAsync(session.userId) });
});

app.get("/api/consents/:id/document", async (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入" });
    return;
  }
  const doc = await getOwnConsentDocumentAsync(session.userId, req.params.id);
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

async function wishListPayload(req) {
  const session = readSession(req);
  const query = wishListQuery(req);
  // 目錄（性質清單）已有 driver-aware 入口，直接用；列表與屋主摘要都走 PG 島嶼。
  await getWishConditionsAsync();
  const posts = await listDemandPostsAsync(query);
  return {
    ...demandMeta(),
    posts,
    rooms: posts,
    mine: query.mine ? await wishRoomOwnerSummaryAsync(session.userId) : undefined,
  };
}

app.get("/api/demand", async (req, res) => {
  try {
    res.json(await wishListPayload(req));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/wish-rooms", async (req, res) => {
  try {
    res.json(await wishListPayload(req));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/demand/aggregate", async (req, res) => {
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
    // PG 模式下同步版讀的是節點本機的 demand_posts ⇒ 訪客看到的「需求熱區」是這台節點的樣本
    // （別的節點收到的心願不算），樣本不足時還會誤判成「需求樣本不足」（第七十九批）。
    res.json(await aggregateDemandAsync({
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

app.get("/api/demand/exposure", async (req, res) => {
  try {
    res.json(await homepageDemandExposureAsync());
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.get("/api/wish-rooms/mine", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json({
      ...demandMeta(),
      ...(await wishRoomOwnerSummaryAsync(session.userId)),
      posts: await listDemandPostsAsync({ viewerId: session.userId, mine: true }),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/wish-rooms/example", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json({ example: await getWishExampleAsync(session.userId) });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.put("/api/wish-rooms/example", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json({ example: await saveWishExampleAsync(session.userId, req.body || {}) });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.delete("/api/wish-rooms/example", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await deleteWishExampleAsync(session.userId));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/demand/:id", async (req, res) => {
  try {
    const session = readSession(req);
    res.json(await getDemandPostAsync(req.params.id, { viewerId: session?.userId || 0 }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/wish-rooms/:id", async (req, res) => {
  try {
    const session = readSession(req);
    const viewerId = session?.userId || 0;
    res.json(await getDemandPostAsync(req.params.id, { viewerId, publicOnly: !viewerId }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/public/wish-room/:id", async (req, res) => {
  try {
    const post = await getDemandPostAsync(req.params.id, { viewerId: 0, publicOnly: true });
    const extras = await sharePageExtrasAsync();
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ ...(publicWishRoomView(post) || post), ...extras });
  } catch (error) {
    res.status(error.status === 404 ? 404 : 400).json({ error: error.message });
  }
});

app.post("/api/public/wish-room/:id/share-events", async (req, res) => {
  try {
    // 同一組旗標就該同一個來源：分享頁與分享事件都用 PG 的 settings
    // （這一條路由本身還有 `recordShareEvent`／`bumpAnalytics` 兩個同步卡點，不在這一批）。
    const extras = await sharePageExtrasAsync();
    if (!extras.share_v2) {
      res.status(404).json({ error: "分享追蹤尚未開放", code: "share_disabled" });
      return;
    }
    const post = await getDemandPostAsync(req.params.id, { viewerId: 0, publicOnly: true });
    const token = post?.public_token || post?.public_ref || req.params.id;
    const eventType = String(req.body?.event_type || "view");
    if (!["view", "cta"].includes(eventType)) {
      res.status(403).json({ error: "無法記錄轉換", code: "share_conversion_forbidden" });
      return;
    }
    const session = readSession(req);
    setShareCookie(res, token);
    res.json(await recordShareEventAsync({
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

// 物件一鍵分享（Phase 1）：公開事件落地端點。只收 view/cta；flag 關閉時 204 no-op。
app.post("/api/public/listings/:id/share-events", async (req, res) => {
  try {
    const flags = await getListingShareFlagsAsync();
    if (!flags.enabled) {
      res.status(204).end();
      return;
    }
    const shareToken = String(req.body?.shareToken || "").trim();
    const eventType = String(req.body?.eventType || "");
    const channel = String(req.body?.channel || "");
    if (!["view", "cta"].includes(eventType)) {
      res.status(403).json({ error: "無法記錄轉換", code: "share_conversion_forbidden" });
      return;
    }
    if (!shareToken) {
      res.status(404).json({ error: "找不到分享", code: "share_not_found" });
      return;
    }
    const session = readSession(req);
    await recordListingShareEventAsync({
      shareToken,
      eventType,
      channel,
      userId: session?.userId || null,
      ip: clientIp(req),
      userAgent: req.get("user-agent") || "",
      source: "public",
    });
    res.status(204).end();
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.post("/api/public/unsubscribe/:token", async (req, res) => {
  try {
    res.json(await applyUnsubscribeTokenAsync(req.params.token));
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

app.post("/api/login", async (req, res) => {
  const keys = authAttemptKeys(req, req.body?.email);
  try {
    assertHuman(req.body);
    // PG 模式要讀 PG 的 users；同步版只讀得到節點本機（別的節點建立的成員一律登不進去）。
    const user = await verifyLoginAsync(req.body?.email, req.body?.password, { keys });
    await afterMemberSessionAsync(user);
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

// `queueSystemMail()` 的 PG 版（範本與 SMTP 從 PG 的 settings 讀）。
async function queueSystemMailAsync(kind, to, vars = {}, options = {}) {
  const [templates, smtp] = await Promise.all([getMailTemplatesAsync(options), getStoredSmtpAsync(options)]);
  return queueAccountMail({ kind, to, vars, templates, smtp });
}

function publicBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim() || "https";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) return "";
  return `${proto}://${host}`;
}

app.post("/api/register", async (req, res) => {
  try {
    assertHuman(req.body);
    // SMTP 設定與「帳號 ＋ 同意紀錄 ＋ 開通信」全部走 PG：同步版只寫本機，而登入讀 PG
    // ⇒ PG 模式下新註冊的會員**登不進去**（第七十五批）。
    if (!mailConfigured(await getStoredSmtpAsync())) {
      const err = new Error("尚未設定寄信，無法寄出註冊確認信。請聯絡管理員到後台填 SMTP。");
      err.status = 503;
      throw err;
    }
    const user = await registerUserWithConsentsAsync({
      email: req.body?.email,
      password: req.body?.password,
      acceptDisclaimer: req.body?.acceptDisclaimer === true,
      acceptPrivacy: req.body?.acceptPrivacy,
      consents: req.body?.consents,
      emailVerified: false,
    });
    const issued = await issueVerifyTokenAsync(user.id);
    const base = publicBaseUrl(req);
    await queueSystemMailAsync("welcome", user.email, {
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

// 登入後的兩個副作用（記登入時間、恢復閒置暫停）。
// 第八十五批之後**只剩 PG 版**：`afterMemberSession()` 同步版最後一個呼叫端（OAuth callback）
// 已改走島嶼，留著會是「沒有人呼叫、卻把同步 `touchLastLogin`／`resumeIdleIfNeeded` 拉進
// 檔案」的死碼，所以連同那兩個同步 import 一起移除。
async function afterMemberSessionAsync(user, options = {}) {
  const id = Number(user?.id) || 0;
  if (!id) return;
  await touchLastLoginAsync(id, {}, options);
  await resumeIdleIfNeededAsync(id, options);
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

// `attributeShare()` 的 PG 版：同步版寫的是節點本機的 `rental_share_events`
// ⇒ PG 模式下「分享帶來的註冊」永遠是 0，而且是靜默的（catch 會把錯誤吞掉）。
async function attributeShareAsync(req, userId, eventType, options = {}) {
  const token = shareTokenFrom(req);
  if (!token || !userId) return;
  try {
    await recordShareEventAsync({
      shareToken: token,
      eventType,
      userId,
      ip: clientIp(req),
      userAgent: req.get("user-agent") || "",
      source: "server",
    }, options);
  } catch { /* attribution never blocks */ }
}

app.get("/verify-email", async (req, res) => {
  try {
    // 三段語意（找不到／已用過／過期）與 `emailVerify.js` 完全共用，只換資料層：
    // 同步版讀本機 `users`，別的管理節點建立的新帳號會拿到「連結壞了」。
    const user = await confirmVerifyTokenAsync(String(req.query?.token || ""));
    await afterMemberSessionAsync(user);
    await attributeShareAsync(req, user.id, "signup");
    setSession(req, res, user.email);
    const base = publicBaseUrl(req);
    try {
      await queueSystemMailAsync("verified_welcome", user.email, {
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

app.get("/auth/:provider", async (req, res) => {
  try {
    const provider = String(req.params.provider || "");
    if (!OAUTH_PROVIDERS.includes(provider)) {
      const err = new Error("不支援的登入方式");
      err.status = 404;
      throw err;
    }
    // 設定與同意文件都走 PG 島嶼：同步版會讀節點本機，非來源節點會「管理員明明開了卻說沒開通」。
    const cfg = (await getStoredOauthAsync())[provider];
    if (!cfg?.enabled || !cfg.clientId || !cfg.clientSecret) {
      const err = new Error("管理員尚未開通這個社群登入");
      err.status = 503;
      throw err;
    }
    const accept = String(req.query.accept || "") === "1";
    const consents = accept ? await getRequiredRegistrationDocumentsAsync() : [];
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
    // 與 /auth/:provider 同一個 store：設定寫在 PG（settings.oauth）時，讀本機就會「查無設定」。
    const cfg = (await getStoredOauthAsync())[provider];
    const base = publicBaseUrl(req);
    const redirectUri = `${base}/auth/${provider}/callback`;
    const profile = await exchangeOauthCode(provider, {
      code: String(req.query.code || ""),
      redirectUri,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
    });
    let user = await findUserByEmailAsync(profile.email);
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
      if (!mailConfigured(await getStoredSmtpAsync())) {
        const err = new Error("尚未設定寄信，無法完成社群註冊開通信。請聯絡管理員到後台填 SMTP。");
        err.status = 503;
        throw err;
      }
      user = await registerUserWithConsentsAsync({
        email: profile.email,
        password: randomOauthPassword(),
        acceptDisclaimer: true,
        acceptPrivacy: true,
        consents: state.consents,
        emailVerified: false,
      });
    }
    await linkOauthIdentityAsync(user.id, { provider, subject: profile.subject });
    if (!String(user.nickname || "").trim()) {
      const nick = nicknameFromOauthName(profile.name);
      if (nick) {
        try {
          await updateUserProfileWithLegalAsync(user.id, { nickname: nick });
          user = { ...user, nickname: nick };
        } catch {
          // 顯示名不合暱稱規則就略過，不擋開通信
        }
      }
    }
    if (planOauthSession(user, { verified: isEmailVerified(user) }).action === "pending_verify") {
      if (!mailConfigured(await getStoredSmtpAsync())) {
        const err = new Error("尚未設定寄信，無法寄出開通信。請改用信箱註冊或聯絡管理員。");
        err.status = 503;
        throw err;
      }
      const issued = await issueVerifyTokenAsync(user.id);
      await queueSystemMailAsync("welcome", user.email, {
        verifyUrl: `${base}/verify-email?token=${encodeURIComponent(issued.token)}`,
      });
      res.setHeader("Set-Cookie", oauthStateCookie(req, "", { clear: true }));
      res.redirect(303, `/login.html?oauth=pending&email=${encodeURIComponent(user.email)}`);
      return;
    }
    await afterMemberSessionAsync(user);
    if (oauthIsNewRegister) await attributeShareAsync(req, user.id, "signup");
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
    const result = await requestTempPasswordAsync(req.body?.email);
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

app.post("/api/ops/commands/apply", async (req, res) => {
  // PG 模式要把 Ops 的指令套在 PG 上（同步版套在本機 ⇒ Ops 說「已套用」但產品端沒變）。
  const result = await handleApplyRequestAsync({
    headers: req.headers,
    rawBody: req.rawBody || JSON.stringify(req.body || {}),
  });
  res.status(result.httpStatus).json(result.body);
});

app.use(requireAuth);

function requireAdminApi(req, res, next) {
  if (actorIsAdmin(req)) return next();
  res.status(403).json({ error: "只有管理員可以做這個" });
}

// 物件一鍵分享（Phase 1）：以「訪客視角」解析物件是否公開可見。
async function resolvePublicListing(id) {
  const n = Number(id) || 0;
  if (!n) return null;
  try {
    if (isSelfListingId(n)) return await getSelfListingAsync(n, { viewerId: 0 });
    return (await getListingAsync(n)) || null;
  } catch {
    return null;
  }
}

app.post("/api/listings/:id/share-link", async (req, res) => {
  try {
    const session = readSession(req);
    const actorId = Number(session?.userId) || 0;
    if (!actorId) {
      res.status(401).json({ error: "請先登入", code: "AUTH_REQUIRED" });
      return;
    }
    const flags = await getListingShareFlagsAsync();
    if (!flags.enabled) {
      res.status(409).json({ error: "分享功能尚未開放", code: "feature_disabled" });
      return;
    }
    const id = Number(req.params.id) || 0;
    const listing = await resolvePublicListing(id);
    if (!listing) {
      res.status(404).json({ error: "找不到物件", code: "listing_not_found" });
      return;
    }
    const result = await createListingShareLinkAsync({ listingId: id, actorId, now: new Date() });
    if (!result.ok) {
      if (result.code === "daily_limit") {
        res.status(429).json({
          error: "今日分享連結已達上限",
          code: "daily_limit",
          dailyUsed: result.dailyUsed,
          dailyLimit: result.dailyLimit,
        });
      } else {
        res.status(404).json({ error: "找不到物件", code: result.code || "listing_not_found" });
      }
      return;
    }
    const url = listingShareUrl(id, result.shareToken, publicBaseUrlEnv() || publicBaseUrl(req), String(listing?.source || ""));
    res.json({ shareToken: result.shareToken, url, dailyUsed: result.dailyUsed, dailyLimit: result.dailyLimit });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法建立分享連結", code: error.code || "" });
  }
});

app.get("/api/me/listings/share-stats", async (req, res) => {
  try {
    const session = readSession(req);
    const userId = Number(session?.userId) || 0;
    if (!userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await listingShareStatsForUserAsync(userId, {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法讀取分享統計" });
  }
});

app.get("/api/admin/listings/share-stats", requireAdminApi, async (req, res) => {
  try {
    const days = Number(req.query?.days) || 7;
    res.json(await listingShareStatsForAdminAsync(days, {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法讀取分享統計" });
  }
});

// ---- 贊助連動 Phase 3（flags 全預設關；關時一律 409 feature_disabled，行為與現況相同）----

app.get("/api/me/support/code", async (req, res) => {
  try {
    const session = readSession(req);
    const userId = Number(session?.userId) || 0;
    if (!userId) { res.status(401).json({ error: "請先登入", login: true }); return; }
    const flags = await getSponsorEntitlementFlagsAsync({});
    if (!flags.codeAttribution) { res.status(409).json({ error: "贊助代碼功能未開啟", code: "feature_disabled" }); return; }
    res.json({ code: await currentMemberSupportCodeAsync({ userId }, {}) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法讀取贊助代碼" });
  }
});

app.post("/api/me/support/code", async (req, res) => {
  try {
    const session = readSession(req);
    const userId = Number(session?.userId) || 0;
    if (!userId) { res.status(401).json({ error: "請先登入", login: true }); return; }
    const flags = await getSponsorEntitlementFlagsAsync({});
    if (!flags.codeAttribution) { res.status(409).json({ error: "贊助代碼功能未開啟", code: "feature_disabled" }); return; }
    const existing = await currentMemberSupportCodeAsync({ userId }, {});
    if (existing) { res.json(existing); return; }
    const issued = await issueMemberSupportCodeAsync({ userId }, {});
    if (!issued) { res.status(500).json({ error: "無法產生贊助代碼" }); return; }
    res.json(issued);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法產生贊助代碼" });
  }
});

app.post("/api/support/outbound", async (req, res) => {
  try {
    const session = readSession(req);
    const userId = Number(session?.userId) || 0;
    if (!userId) { res.status(401).json({ error: "請先登入", login: true }); return; }
    const flags = await getSponsorEntitlementFlagsAsync({});
    if (!flags.codeAttribution) { res.status(409).json({ error: "贊助代碼功能未開啟", code: "feature_disabled" }); return; }
    const providerId = String(req.body?.providerId || "").trim();
    const config = normalizeSponsorConfig(await getSiteSettingAsync("sponsorLinks", {}));
    const link = publicSponsorLinks(config).find((row) => row.id === providerId);
    if (!link) { res.status(404).json({ error: "找不到贊助管道", code: "provider_not_found" }); return; }
    const current = await currentMemberSupportCodeAsync({ userId }, {});
    const user = await getUserByIdAsync(userId, {});
    const displayName = String(user?.nickname || "").trim();
    const sendEmail = req.body?.sendEmail === true;
    res.json(buildSponsorOutbound(providerId, link.url, {
      code: current?.code || "",
      displayName,
      sendEmail,
      email: sendEmail ? String(user?.email || "") : "",
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法組出贊助連結" });
  }
});

app.get("/api/admin/support/entitlement", requireAdminApi, async (_req, res) => {
  res.json({
    flags: await getSponsorEntitlementFlagsAsync({}),
    rules: await getSponsorEntitlementRulesAsync({}),
  });
});

app.put("/api/admin/support/entitlement", requireAdminApi, async (req, res) => {
  const flags = req.body?.flags !== undefined ? await setSponsorEntitlementFlagsAsync(req.body.flags, {}) : await getSponsorEntitlementFlagsAsync({});
  const rules = req.body?.rules !== undefined ? await setSponsorEntitlementRulesAsync(req.body.rules, {}) : await getSponsorEntitlementRulesAsync({});
  res.json({ flags, rules });
});

app.get("/api/admin/support/entitlement/queue", requireAdminApi, async (req, res) => {
  try {
    const days = Number(req.query?.days) || 30;
    res.json(await listEntitlementQueueAsync({ days }, {}));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "無法讀取對帳佇列" });
  }
});

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

app.get("/api/admin/members", requireAdminApi, async (req, res) => {
  try {
    // 每一個人都要「PG 的 users ＋ PG 的 settings ＋ PG 的關注／刊登數」才算得出來；
    // 同步版三份都讀本機 ⇒ 別的節點的會員在後台會顯示成 0 筆／預設間隔，而且不會報錯。
    const members = await listAdminMembersAsync({
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
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/members/:id/delete", requireAdminApi, async (req, res) => {
  try {
    const result = await adminDeleteMemberAsync(req.params.id, {
      reasonCode: req.body?.reasonCode,
      reasonText: req.body?.reasonText,
    });
    schedule();
    await queueSystemMailAsync("account_deleted", result.member.email, { reason: result.reason.text || result.reason.label });
    auditReq(req, "member_delete", result.member.email, { id: result.member.id }, { deleted: true });
    res.json({ member: result.member, reason: result.reason });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/members/:id/restore", requireAdminApi, async (req, res) => {
  try {
    const member = await adminRestoreMemberAsync(req.params.id);
    schedule();
    res.json({ member });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/account/delete", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      const err = new Error("請先登入");
      err.status = 401;
      throw err;
    }
    await deleteOwnAccountAsync(session.userId, req.body?.reason);
    schedule();
    sendLogout(req, res);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.patch("/api/admin/members/:id", requireAdminApi, async (req, res) => {
  try {
    const before = await getUserByIdAsync(req.params.id);
    const member = await adminPatchMemberAsync(req.params.id, req.body || {});
    schedule();
    if ((before?.plan || "free") !== "sponsor" && member.plan === "sponsor") {
      await queueSystemMailAsync("sponsor_thanks", member.email);
    }
    res.json({ member });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/mail", requireAdminApi, async (_req, res) => {
  res.json(await getAdminMailSettingsAsync());
});

app.put("/api/admin/mail", requireAdminApi, async (req, res) => {
  try {
    // 設定進 PG、auth.env 留節點本機（Owner 第五十五批決定）。
    res.json(await saveAdminMailSettingsAsync(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/oauth", requireAdminApi, async (_req, res) => {
  res.json(await getAdminOauthSettingsAsync());
});

app.put("/api/admin/oauth", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveAdminOauthSettingsAsync(req.body || {}));
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
    const entitlement = await handleSponsorEntitlementWebhookAsync({
      provider: req.params.provider,
      body: req.body,
      rawBody: req.rawBody,
      headers: req.headers,
    }, {});
    if (entitlement.handled) {
      res.status(entitlement.status).json(entitlement.json);
      return;
    }
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

app.put("/api/admin/rental-marketplace-flags", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveRentalMarketplaceFlagsAsync(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/rental-match-rules", requireAdminApi, async (_req, res) => {
  res.json(await rentalMatchAdminRulesAsync());
});

// 檢舉列由 PG 島嶼寫入，所以後台清單也必須讀 PG（否則管理員看到的是舊資料）。
app.get("/api/admin/wish-offer-reports", requireAdminApi, async (req, res) => {
  try {
    res.json(await listAdminOfferReportsAsync({ limit: req.query?.limit }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

// C3：後台列表要能看到附件。一次查完（不是每列查一次），附件形狀與上傳時一致。
async function withFeedbackAttachments(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return rows;
  try {
    const byId = await listFeedbackAttachmentsForAsync(rows.map((row) => Number(row.id) || 0));
    return rows.map((row) => ({ ...row, attachments: byId.get(Number(row.id)) || [] }));
  } catch (error) {
    // 附件是額外資訊：查不到不該讓整個後台回饋清單掛掉。
    console.error("[api] 讀取回饋附件失敗：", error?.message || error);
    return rows.map((row) => ({ ...row, attachments: [] }));
  }
}

app.get("/api/admin/feedback", requireAdminApi, async (req, res) => {
  try {
    res.json({
      ...feedbackMeta(),
      // 名單、統計與遞送狀態三者都必須來自 PG：同步版會顯示「別的節點送的回饋 0 筆」。
      stats: await feedbackStatsAsync(),
      items: await withFeedbackAttachments(await listFeedbackAsync({ status: req.query?.status, kind: req.query?.kind })),
      ops_delivery: await deliveryControlAsync(),
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.patch("/api/admin/feedback/:id", requireAdminApi, async (req, res) => {
  try {
    const row = await updateFeedbackAsync(req.params.id, req.body || {});
    // CRM 連結是可選的（同步版也是 try/catch 後忽略）：失敗不該擋住狀態更新。
    // 第九十批：改走 PG 島嶼——同步版讀本機 `crm_cases`、寫本機 `crm_outbox`，
    // PG 模式下是靜默失效（別的節點開的案件看不到、站上也永遠不會送出）。
    try { await enqueueCrmFromFeedbackAsync(Number(req.params.id) || 0); } catch { /* 可選 */ }
    res.json(row);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/ops-delivery", requireAdminApi, async (_req, res) => {
  try {
    res.json(await deliveryControlAsync());
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.put("/api/admin/ops-delivery", requireAdminApi, async (req, res) => {
  const stop = req.body?.stop === true || req.body?.stop === 1 || req.body?.stop === "1";
  try {
    // ⚠️ 這個鍵存的是**原始字串** `"1"`／`"0"`（原生 SQL 讀者比對原始文字），不可走 settingsKvAsync。
    await setLocalDeliveryStoppedAsync(stop);
    res.json(await deliveryControlAsync());
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/remote-cs", requireAdminApi, async (_req, res) => {
  res.json(await getRemoteCsControlAsync());
});

app.put("/api/admin/remote-cs", requireAdminApi, async (req, res) => {
  const stop = req.body?.stop === true || req.body?.stop === 1 || req.body?.stop === "1";
  res.json(await setRemoteCsStopAsync(stop));
});

app.post("/api/admin/ops-delivery/compact-outbox", requireAdminApi, async (req, res) => {
  const olderThanMs = Number(req.body?.older_than_ms);
  try {
    const result = await compactSentOutboxPayloadsAsync({
      olderThanMs: Number.isFinite(olderThanMs) && olderThanMs >= 0 ? olderThanMs : undefined,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
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
  res.json({ module: await setCrmEnabledAsync(enabled), sync: await getCrmDeliveryControl() });
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
    res.status(201).json(await createCrmContact(req.body || {}, { actorUserId: await actorUserIdAsync(req) }));
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
    res.status(201).json(await addCrmNote(req.params.id, req.body || {}, { actorUserId: await actorUserIdAsync(req) }));
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
    res.status(201).json(await createCaseFromFeedbackAsync(req.params.id));
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

app.get("/api/admin/legal-copy", requireAdminApi, async (_req, res) => {
  try {
    res.json(await getLegalCopyAsync());
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.put("/api/admin/legal-copy", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveLegalCopyAsync(req.body || {}));
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
      item: await reviewAdminSimilarity(req.params.id, req.body || {}, await actorUserIdAsync(req)),
      overview: await getAdminSimilaritySettings(),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/maps", requireAdminApi, async (_req, res) => {
  try {
    // 開關、用量與 provider 預算都要讀 PG（同步版會顯示別的節點的開關與用量）。
    res.json(await getAdminMapsSettingsAsync());
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.put("/api/admin/maps", requireAdminApi, async (req, res) => {
  try {
    const body = req.body || {};
    // 開關與用量都要讀寫 PG（同步版只寫本機 ⇒ 管理員以為開了，只有他按下去的那一台生效）。
    const before = await getAdminMapsSettingsAsync();
    const settings = await saveAdminMapsSettingsAsync(body);
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

app.get("/api/admin/system-crawl", requireAdminApi, async (_req, res) => {
  res.json({
    ...(await getSystemCrawlAsync()),
    catalog: await refreshSiteCatalogStatsAsync(),
  });
});

app.put("/api/admin/system-crawl", requireAdminApi, async (req, res) => {
  try {
    res.json(await saveSystemCrawlAsync(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/same-house/reconcile", requireAdminApi, async (_req, res) => {
  res.json({
    ...(await sameHouseBackfillStatusAsync()),
    note: "POST 此路徑執行一批歷史 reconciliation，可中斷續跑。",
  });
});

app.post("/api/admin/same-house/reconcile", requireAdminApi, async (req, res) => {
  try {
    // 走 driver-aware 入口：PG 模式下「重掃的結果」與游標都必須落在站上讀的那一份。
    const result = await runSameHouseBackfillAsync({
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
    const [overview, listingShare] = await Promise.all([
      getAdminOverviewAsync(),
      listingShareOverviewAsync(7, {}),
    ]);
    res.json({ ...overview, listingShare });
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

app.get("/api/admin/listings/search", requireAdminApi, async (req, res) => {
  res.json({ items: await searchAdminListingsAsync(req.query?.q, Number(req.query?.limit) || 20) });
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

// 這兩條是**同一個 handler 本體**（都建立許願房），所以一起改接 PG 島嶼入口：
// PG 模式下寫本機 SQLite 等於「刊登成功、站上讀不到」。
app.post("/api/demand", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能刊登許願房" });
      return;
    }
    res.json(await createDemandAsync(session.userId, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.post("/api/wish-rooms", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能刊登許願房" });
      return;
    }
    res.json(await createDemandAsync(session.userId, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.patch("/api/wish-rooms/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await updateWishRoomAsync(session.userId, req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.post("/api/wish-rooms/:id/publish", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await publishWishRoomAsync(session.userId, req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.post("/api/wish-rooms/:id/reopen", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await reopenWishRoomAsync(session.userId, req.params.id));
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

app.post("/api/demand/:id/reply", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能回覆" });
      return;
    }
    res.json(await addDemandReplyAsync(session.userId, req.params.id, req.body?.body));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/demand/:id/close", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await closeDemandPostAsync(session.userId, req.params.id, { admin: session.role === "admin" }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/demand/:id/report", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能檢舉" });
      return;
    }
    res.json(await reportDemandAsync(session.userId, {
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

app.post("/api/feedback", async (req, res) => {
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
    res.json(await submitFeedbackAsync(session.userId, { ...body, context }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/self-listings", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能看自己的刊登" });
      return;
    }
    // 自己的刊登、配對摘要、方案額度與 marketplace 開關全部走 PG 島嶼：同步版會讀到
    // **這台節點**的刊登與會員（別的節點建立的完全看不到），配對候選也只算本機的許願房（第八十批）。
    const flags = await getRentalMarketplaceFlagsAsync();
    const v2 = isRentalCatalogV2Enabled(flags);
    // A3：已發布的共用條件目錄一律要讀 —— `catalog` 決定表單**結構**（只有 v2 開時才由目錄決定），
    // `catalogLabels` 決定**顯示名稱**（任何情況都要套用，後台改名才會同步到前台）。
    const catalog = await getRentalCatalogAsync();
    res.json({
      ...selfListingMeta({ catalog: v2 ? catalog : null, catalogLabels: v2 ? {} : catalogTraitLabelMap(catalog) }),
      tools: await listingToolsInfoAsync(session.userId),
      owner_matching: await rentalMatchOwnerMetaAsync(),
      listings: await listMineSelfListingsAsync(session.userId),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

/**
 * R2：把「地址 → 座標 → 步行捷運查證」綁到即將寫入的房源上。
 *
 * 這是**發布路徑**用的版本：失敗一律 fail-soft（回一個空物件），刊登不會因此卡住；
 * 沒有查證結果時配對看到的就是「未確認」，而不是被推定成符合。
 * 回傳的欄位直接餵給 `resolveSelfListingMeta()`。
 */
async function resolveSelfListingGeo(address) {
  const text = String(address || "").trim();
  if (text.length < 4) return {};
  try {
    const geo = await geocodeAddress(text, geoLookupAsync(), { strict: false, maxAttempts: 1, allowAdmin: false });
    const lat = Number(geo?.lat);
    const lng = Number(geo?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return {};
    const out = { lat, lng, geo_source: "self" };
    // 步行捷運用同一條 1 公里的定義查證一次。服務忙碌／沒查完 ⇒ **不寫狀態**，維持未確認。
    try {
      const access = await fetchMrtAccessWithin(lat, lng);
      if (access.resolved) {
        // `within` 與 `none` 都是已查證的結果，**狀態也要存下來**：
        // 只存「符合的距離」會讓「已查證超過 1 公里」掉回未確認，配對就不會產生硬衝突。
        const state = access.status === "within" ? "within" : "outside";
        out.mrt_state = state;
        out.mrt_source = MRT_CACHE_CONTRACT;
        out.mrt_checked_at = new Date().toISOString();
        out.mrt_station = state === "within" ? String(access.station || "") : "";
        out.mrt_walk_m = state === "within" ? access.walk_m : null;
        // 「最近但超過」的那一筆（沒有候選站時是 null，仍然代表已查證不符合）。
        out.mrt_nearest_m = access.walk_m ?? access.nearest_walk_m ?? null;
        // 同一份快取，讓內頁顯示與配對共用。
        await setCachedMrtAsync(lat, lng, { ...access, source: MRT_CACHE_CONTRACT }).catch(() => {});
      }
    } catch { /* 外部服務失敗 ⇒ 維持未確認 */ }
    return out;
  } catch {
    return {};
  }
}

// ── A4：刊登表單的「1 公里內可步行捷運」查詢 ──
// 一定要註冊在 `/api/self-listings/:id` 之前，否則 `mrt-access` 會被當成一個 id。
//
// 判定一律用**真實步行路線**（`fetchMrtAccessWithin` 走 foot profile 的 OSRM）：
// 直線距離只用來挑候選站，不可以當成結果。狀態刻意分得開，讓前端能區分
// 「已查證符合」「已查證沒有」「還沒查證完成」「地址定位不到」「服務失敗」。
app.get("/api/self-listings/mrt-access", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    const address = String(req.query?.address || "").trim().slice(0, 120);
    if (address.length < 4) {
      res.json({ status: "unlocatable", address, message: "地址還太短，無法定位。" });
      return;
    }
    const geo = await geocodeAddress(address, geoLookupAsync(), {
      strict: false,
      maxAttempts: 2,
      allowAdmin: false,
    });
    if (geo?.busy) {
      res.json({ status: "unknown", address, retryable: true, message: "地圖定位服務暫時忙碌，請稍後重試。" });
      return;
    }
    const lat = Number(geo?.lat);
    const lng = Number(geo?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      res.json({ status: "unlocatable", address, message: "這個地址定位不到，請補上門牌或改用鄰近地標。" });
      return;
    }
    const access = await fetchMrtAccessWithin(lat, lng);
    // A4：把查證過的結果寫進**同一份** `mrt_cache`（內頁裝飾與背景補齊都讀它）。
    // 這樣「表單看到的數字」與「內頁顯示的數字」是同一份資料，不會各算一套而互相矛盾。
    // 快取寫入失敗不影響這次查詢結果（它只是快取）。
    // 只有「已查證」的結果才寫快取；`unknown`（部分候選失敗／被截斷）不寫，
    // 免得把待確認寫成一份看起來像已查證的資料。
    if (access.resolved && (access.status === "within" || access.status === "none")) {
      try { await setCachedMrtAsync(lat, lng, { ...access, source: MRT_CACHE_CONTRACT }); } catch { /* 快取非必要 */ }
    }
    const base = {
      address,
      status: access.status,
      station: access.station || "",
      // walk_m 是未四捨五入的原始公尺；walk_km 只給顯示。
      walk_m: access.walk_m ?? null,
      walk_km: access.walk_km ?? null,
      walk_min: access.walk_min ?? null,
      nearest_walk_m: access.nearest_walk_m ?? null,
      nearest_walk_km: access.nearest_walk_km ?? null,
      searched_m: access.searched_m ?? null,
    };
    if (access.status === "within") {
      res.json({ ...base, verified: true, message: `捷運${String(access.station).replace(/站$/, "")}站，步行路線約 ${Math.round(access.walk_m)} 公尺（1 公里內）。` });
      return;
    }
    if (access.status === "none") {
      res.json({ ...base, verified: true, message: "已查證：1 公里內沒有可步行到達的捷運站。" });
      return;
    }
    // unknown：還有候選站沒查完／服務沒有給出可用結果。**不能**當成「符合」，也不能當成「確定沒有」。
    const nearest = Number(access.nearest_walk_m);
    res.json({
      ...base,
      verified: false,
      retryable: true,
      message: Number.isFinite(nearest)
        ? `最近的候選站步行約 ${Math.round(nearest)} 公尺，但還有站點沒查完，所以這不是「符合」也不是「確定沒有」，請稍後重試。`
        : "步行路線還沒查證完成，這不是「符合」也不是「確定沒有」，請稍後重試。",
    });
  } catch (error) {
    // 外部服務失敗要讓表單還能用：回一個可重試的狀態，不要 500 把整頁打斷。
    console.error("[api] 步行捷運查詢失敗：", error?.message || error);
    res.json({ status: "error", retryable: true, verified: false, message: "步行路線服務暫時無法使用，請稍後重試；不影響你繼續填寫與刊登。" });
  }
});

app.get("/api/self-listings/:id/matches/summary", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await ownerListingMatchSummaryAsync(req.params.id, session.userId));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});

app.get("/api/self-listings/:id/matches", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    // 配對清單、游標分頁與「提供我的房源」按鈕狀態全部走 PG 島嶼（同步版讀本機的
    // 許願房／提案／封鎖名單 ⇒ PG 模式下按鈕狀態與站上其他地方不一致）（第八十一批）。
    res.json(await ownerListingMatchesAsync(req.params.id, session.userId, {
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

app.post("/api/self-listings/:id/matches/:wishRef/offers", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    // PG 島嶼（第八十七批）：刊登列、許願房、封鎖名單、每日上限與提案本體都要讀寫 PG，
    // 否則 PG 站只查得到本機那幾筆（別的節點的刊登／許願房一律 409），提案也寫進本機。
    const created = await createWishOfferAsync(session.userId, req.params.id, req.params.wishRef, {
      idempotencyKey: req.body?.idempotency_key || req.get("idempotency-key"),
      actorKey: `owner:${session.userId}`,
    });
    await attributeShareAsync(req, session.userId, "offer");
    res.json(created);
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/rental-notify/prefs", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await getRentalNotifyPrefsForAsync(session.userId));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.put("/api/rental-notify/prefs", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await saveRentalNotifyPrefsForAsync(session.userId, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.get("/api/self-listings/:id/match-subscription", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await getMatchSubscriptionAsync(session.userId, req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.put("/api/self-listings/:id/match-subscription", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await saveMatchSubscriptionAsync(session.userId, req.params.id, req.body?.mode));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.get("/api/wish-rooms/:id/survey", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await getCompletionSurveyAsync(session.userId, req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.post("/api/wish-rooms/:id/survey", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await submitCompletionSurveyAsync(session.userId, req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.get("/api/admin/rental-ops", requireAdminApi, async (req, res) => {
  try {
    res.json(await rentalOpsSummaryAsync({ from: req.query?.from, to: req.query?.to }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message, code: error.code || "" });
  }
});
app.get("/api/admin/rental-ops/drill", requireAdminApi, async (req, res) => {
  try {
    res.json(await rentalOpsDrilldownAsync({
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

app.get("/api/wish-offers/inbox", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await listTenantWishOffersAsync(session.userId, {
      status: req.query?.status,
      limit: req.query?.limit,
      cursor: req.query?.cursor,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/wish-offers/owner", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await listOwnerWishOffersAsync(session.userId, {
      status: req.query?.status,
      limit: req.query?.limit,
      cursor: req.query?.cursor,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/wish-offers/blocks", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json({ items: await listMyBlocksAsync(session.userId) });
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/blocks/:blockRef/remove", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await unblockByRefAsync(session.userId, req.params.blockRef));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/wish-offers/:offerRef/contact", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    // 這一條會先寫稽核事件（`contact_projection_accessed`）才回聯絡方式 ⇒ 走島嶼的寫入路徑。
    res.json(await projectOfferContactAsync(req.params.offerRef, session.userId, {
      actorKey: `contact:${session.userId}`,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.get("/api/wish-offers/:offerRef", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    // 詳情＝「可見性檢查（loadVisibleOffer）＋ 投影（publicOfferView）」，兩者都在 PG 島嶼上；
    // 投影與安全檢查重用 wishOffers.js 的 `publicOfferViewWith()`，所以只有一份實作。
    const offer = await loadVisibleOfferAsync(req.params.offerRef, session.userId);
    if (!offer) {
      res.status(404).json({ error: "找不到這筆提案", code: "offer_not_found" });
      return;
    }
    res.json(await publicOfferViewAsync(offer, session.userId));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/:offerRef/accept", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await acceptWishOfferAsync(session.userId, req.params.offerRef, {
      actorKey: `tenant:${session.userId}`,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/:offerRef/decline", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await declineWishOfferAsync(session.userId, req.params.offerRef, {
      actorKey: `tenant:${session.userId}`,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/:offerRef/withdraw", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await withdrawWishOfferAsync(session.userId, req.params.offerRef, {
      actorKey: `owner:${session.userId}`,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/:offerRef/block", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await blockOwnerFromOfferAsync(session.userId, req.params.offerRef, {
      actorKey: `tenant:${session.userId}`,
    }));
  } catch (error) {
    sendOfferError(res, error);
  }
});

app.post("/api/wish-offers/:offerRef/report", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    // 可見性、角色檢查（只有房客能檢舉）與寫入＋稽核事件都收在島嶼入口裡，
    // 與同步版 `reportWishOffer()` 的行為逐條相同。
    res.json(await reportVisibleOfferAsync(req.params.offerRef, session.userId, {
      reason: req.body?.reason,
      detail: req.body?.detail,
      actorKey: `report:${session.userId}`,
    }));
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

app.post("/api/self-listings", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能刊登" });
      return;
    }
    // 安全：素材庫照片必須屬於本人（擋以猜測 URL 盜連他人 media）。
    const body = req.body || {};
    const media = [...(Array.isArray(body.photos) ? body.photos : []), body.cover].filter(Boolean);
    // 可刊登條件、草稿列、夾具 registry、頭像／條件值與配對候選全部走 PG 島嶼：
    // 同步版只寫本機 ⇒ **剛刊登的物件不在站上的清單裡**（第八十四批）。
    await assertOwnsMemberMediaUrlsAsync(session.userId, media);
    // R2：地址定位與步行捷運查證結果要綁在這則刊登上（外部服務失敗不擋刊登）。
    // R2（第二輪）：只認**站方查證**的欄位。會員在 body 裡自己帶 lat／mrt_walk_m／mrt_source
    // 一律剝掉（只檢查契約字串不足以防偽造 —— 那個字串是公開的）。
    const geo = await resolveSelfListingGeo(body.street || body.address);
    const created = await createSelfListingAsync(session.userId, { ...stripServerVerifiedFields(body), ...geo }, {
      matchCandidates: (listing) => matchCandidatesAsync(listing.post_id, listing),
    });
    await attributeShareAsync(req, session.userId, "listing");
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
    // 上傳＝「配額檢查 ＋ INSERT」必須在同一個 PG 交易裡（同步版是 BEGIN IMMEDIATE），
    // 否則兩個並行上傳會各自通過檢查而超過方案上限。
    const item = await saveMemberMediaAsync(session.userId, buf, {
      plan: session.plan || "free",
      originalName: String(req.query.name || ""),
    });
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

// ── C3：意見回饋附圖 ──
// 三個刻意的設計：
//   1. 沿用既有的 `express.raw` 單檔上傳（前端逐檔 POST），不引入 multipart 相依。
//   2. 附件只寫本機 `DATA_DIR/feedback-media/`，**不推 R2、不掛 express.static**，
//      也**不會**出現在 `auth.js publicPath()`（那兩條 GET 必須先過 requireAdminApi）。
//   3. 先上傳取得 id，送出回饋時在同一筆交易內 claim 綁定；中途放棄的孤兒由 sweep 清掉。
app.post("/api/feedback/attachments",
  // limit 比 1,000,000 稍寬一點：讓「剛剛好超過 1MB」由 validateFeedbackImage() 回精確的 413 訊息，
  // 而不是被 body-parser 用通用的「請求內容過大」攔掉（那只會發生在離譜的大檔）。
  express.raw({ type: () => true, limit: FEEDBACK_ATTACHMENT_MAX_BYTES + 4096 }),
  async (req, res) => {
    try {
      const session = readSession(req);
      if (!session?.userId) { res.status(401).json({ error: "請先登入才能上傳圖片" }); return; }
      const used = await countOpenFeedbackAttachmentsAsync(session.userId);
      if (used >= FEEDBACK_ATTACHMENT_MAX) {
        // 上一次沒送完就關掉瀏覽器時，伺服器端還留著未綁定的附件。把清單一起回給前端，
        // 讓使用者可以直接在對話框裡刪掉它們 —— 否則他會卡在「已達上限」卻看不到那幾張圖。
        let open = [];
        try { open = await listOpenFeedbackAttachmentsAsync(session.userId); } catch { /* 清單拿不到就只回訊息 */ }
        res.status(409).json({
          error: `每則回饋最多 ${FEEDBACK_ATTACHMENT_MAX} 張圖片，請先刪除再上傳`,
          code: "attachment_limit",
          attachments: open,
        });
        return;
      }
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json(await saveFeedbackAttachmentAsync(session.userId, buf));
    } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
  });

// R3：**本人、且還沒送出**的附件縮圖／原圖。會員在回饋對話框裡的預覽走這一條。
// 已送出的附件不在此列（`feedback_id = 0` 是條件之一），仍然只有管理員讀得到。
app.get("/api/feedback/attachments/:id/thumb", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    const row = await getOpenFeedbackAttachmentAsync(session.userId, req.params.id);
    if (!row) { res.status(404).end(); return; }
    streamFeedbackAttachment(row, res, { thumb: true });
  } catch { res.status(404).end(); }
});
app.get("/api/feedback/attachments/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    const row = await getOpenFeedbackAttachmentAsync(session.userId, req.params.id);
    if (!row) { res.status(404).end(); return; }
    streamFeedbackAttachment(row, res);
  } catch { res.status(404).end(); }
});

app.delete("/api/feedback/attachments/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await deleteFeedbackAttachmentAsync(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

// 站方專用讀取：縮圖／原圖。私有快取，不進 CDN。
app.get("/api/feedback-attachments/:id/thumb", requireAdminApi, async (req, res) => {
  try {
    const row = await getFeedbackAttachmentAsync(req.params.id);
    if (!row) { res.status(404).end(); return; }
    streamFeedbackAttachment(row, res, { thumb: true });
  } catch { res.status(404).end(); }
});
app.get("/api/feedback-attachments/:id", requireAdminApi, async (req, res) => {
  try {
    const row = await getFeedbackAttachmentAsync(req.params.id);
    if (!row) { res.status(404).end(); return; }
    streamFeedbackAttachment(row, res);
  } catch { res.status(404).end(); }
});

// ── 公開分享：站內會員刊登（未登入可看主要內容；只輸出白名單公開欄位） ──
app.get("/api/public/self-listing/:id", async (req, res) => {
  try {
    const listing = await getSelfListingAsync(req.params.id, { viewerId: 0 });
    // 這一支刻意維持「訪客視角」：viewerId 固定 0，回傳的是純公開欄位。
    // 因此它可以公開快取；但 A5 的登入狀態**不可**混進這裡（前端另外打 /api/me），
    // 否則 public 快取會把屋主版內容餵給訪客。
    // max-age 由 60 降到 15：共用條件目錄改名後，分享頁的條件 chips 要跟著更新（A3）。
    res.setHeader("Cache-Control", "public, max-age=15");
    res.json(publicListingView(listing, req.params.id));
  } catch (error) {
    res.status(error.status === 404 ? 404 : 400).json({ error: error.message });
  }
});

// ── 通用物件公開內頁（Phase 2）：`/p/:id` 頁面 ＋ 兩支公開資料 API ──

// 公開內頁資料。contact 依 D6 收斂：訪客遮蔽，登入會員才露電話／LINE。
// 不存在或 hidden／站內已關閉 → 404；前端在頁面上另行處理 empty 態。
app.get("/api/public/listings/:id/detail", async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    const session = readSession(req);
    const loggedIn = Boolean(session?.userId);
    const listing = id ? await getListingAsync(id) : null;
    const { status, body } = buildPublicListingDetailResponse(listing, id, { loggedIn });
    res.status(status).json(body);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || "無法讀取物件", code: error.code || "" });
  }
});

// 相似物件：同行政區＋租金 ±20%＋排除自身與同屋源群，限 4 筆、更新時間倒序。
// 單查詢失敗 fail-soft 回空陣列（前端顯示 empty 文案）。
app.get("/api/public/listings/:id/similar", async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 4, 10));
    const listing = id ? await getListingAsync(id) : null;
    if (!listing || !isPublicListingDetail(listing, id)) {
      res.json({ items: [] });
      return;
    }
    const items = await similarPublicListingsAsync({
      postId: id,
      district: String(listing.district || ""),
      rent: rentAmount(listing),
      limit,
    }, { db });
    res.json({ items });
  } catch (error) {
    console.warn("相似物件查詢失敗：", error.message);
    res.json({ items: [] });
  }
});

// 公開內頁：從快取範本注入 OG meta（title/description/url/canonical/og:image 首圖）。
// 物件不存在或 hidden 也回頁面（前端顯示 empty 態），但 OG 用品牌 fallback。
// 注入失敗 fail-soft：回原始範本內容，不得 500。
app.get("/p/:id", async (req, res) => {
  const id = Number(req.params.id) || 0;
  const base = publicBaseUrlEnv() || publicBaseUrl(req);
  const template = LISTING_DETAIL_TEMPLATE || LISTING_SHARE_TEMPLATE;
  let html = template;
  try {
    let title = "吉比租房物件追蹤";
    let description = "租房物件追蹤，租金、格局、交通與聯絡方式一次看齊。";
    let image = absoluteAssetUrl("/brand/mark.png", base);
    if (id) {
      const listing = await getListingAsync(id);
      if (listing && isPublicListingDetail(listing, id)) {
        title = listingDetailOgTitle(listing) || title;
        description = listingDetailOgDescription(listing) || description;
        image = firstListingShareImage(listing, base) || image;
      }
    }
    const meta = buildListingShareOgMeta({ title, description, image, url: `${base}/p/${id}` });
    html = injectListingShareMeta(template, meta, title);
  } catch {
    // fail-soft：注入失敗回原始範本
  }
  res.type("html").send(html);
});

// 站內刊登公開分享頁：從快取範本注入 OG meta（供 LINE／Threads／FB 爬蟲預覽）後回傳。
// 注入失敗 fail-soft：回原始檔案內容，不得 500。
app.get("/l/:id", async (req, res) => {
  try {
    const id = Number(req.params.id) || 0;
    let html = LISTING_SHARE_TEMPLATE;
    if (id) {
      const listing = await getSelfListingAsync(id, { viewerId: 0 });
      const view = publicListingView(listing, id);
      const title = String(view.title || "").trim() || "物件分享 · 吉比租房物件追蹤";
      const description = listingShareDescription(view).slice(0, 160);
      const base = publicBaseUrlEnv() || publicBaseUrl(req);
      const canonical = `${base}/l/${id}`;
      const image = firstListingShareImage(view, base) || absoluteAssetUrl("/brand/mark.png", base);
      const meta = buildListingShareOgMeta({ title, description, image, url: canonical });
      html = injectListingShareMeta(LISTING_SHARE_TEMPLATE, meta, title);
    }
    res.type("html").send(html);
  } catch {
    res.sendFile(path.join(__dirname, "../public/listing.html"));
  }
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
app.get("/api/listing-imports", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json({ items: await listMineListingImportsAsync(session.userId) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.post("/api/listing-imports", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    assertImportAllowed(session.userId, clientIp(req));
    // PG 島嶼（第八十六批）：匯入列與草稿都要落在 PG，否則別的節點看不到這筆匯入，
    // 而且確認後公開不了（草稿在別台節點的本機檔裡）。
    const row = await startListingImportAsync(session.userId, req.body || {}, { plan: session.plan || "free", role: session.role || "" });
    res.json(row);
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.get("/api/listing-imports/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await getOwnedListingImportViewAsync(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.patch("/api/listing-imports/:id", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await reviewListingImportAsync(session.userId, req.params.id, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.post("/api/listing-imports/:id/cancel", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await cancelListingImportAsync(session.userId, req.params.id));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.post("/api/listing-imports/:id/confirm", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    res.json(await confirmListingImportAsync(session.userId, req.params.id, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.post("/api/listing-imports/:id/publish", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入才能刊登" }); return; }
    const body = req.body || {};
    const media = [...(Array.isArray(body.photos) ? body.photos : []), body.cover].filter(Boolean);
    await assertOwnsMemberMediaUrlsAsync(session.userId, media);
    res.json(await publishConfirmedImportAsync(session.userId, req.params.id, body, {
      matchCandidates: (listing) => matchCandidatesAsync(listing.post_id, listing),
    }));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.get("/api/admin/listing-imports", requireAdminApi, async (req, res) => {
  try {
    res.json({ items: await listAdminListingImportsAsync({ limit: Number(req.query?.limit) || 50 }) });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

app.post("/api/self-listings/:id/copy", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入" }); return; }
    // 來源列、冪等表、素材所有權與新草稿列全部走 PG 島嶼（同步版只寫本機 ⇒ 別的節點看不到
    // 複製出來的草稿，素材所有權還會誤判成「不是自己的」）（第八十二批）。
    res.json(await copyOwnListingAsync(session.userId, req.params.id, req.body || {}));
  } catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code || "" }); }
});
app.post("/api/self-listings/:id/publish", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) { res.status(401).json({ error: "請先登入才能刊登" }); return; }
    const body = req.body || {};
    const media = [...(Array.isArray(body.photos) ? body.photos : []), body.cover].filter(Boolean);
    // 草稿、可刊登條件（停權／註冊滿 24 小時／同時上限）、素材所有權與配對候選全部走 PG 島嶼：
    // 同步版只寫本機 ⇒ 公開動作看起來成功、刊登卻不在站上的清單裡（第八十三批）。
    await assertOwnsMemberMediaUrlsAsync(session.userId, media);
    // R2：地址定位與步行捷運查證結果綁在這則刊登上（外部服務失敗不擋刊登）。
    const geo = await resolveSelfListingGeo(body.street || body.address);
    res.json(await publishImportedDraftListingAsync(session.userId, req.params.id, { ...stripServerVerifiedFields(body), ...geo }, {
      matchCandidates: (listing) => matchCandidatesAsync(listing.post_id, listing),
    }));
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
app.post("/api/self-listings/:id/close", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入" });
      return;
    }
    res.json(await closeSelfListingAsync(session.userId, req.params.id, { admin: session.role === "admin" }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/self-listings/:id/report", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入才能檢舉" });
      return;
    }
    res.json(await reportSelfListingAsync(session.userId, req.params.id, req.body?.reason));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/self-listings/:id/hide", requireAdminApi, async (req, res) => {
  try {
    res.json(await hideSelfListingAsync(req.params.id));
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

// ⚠️ 這幾處原本呼叫同步的 `stats()`（db.js）：PG 模式下它讀的是**節點本機**的
// `listings`／`user_listing_flags`／`users` ⇒ 推給瀏覽器的統計是別台節點的（或空的），
// 而且整條鏈（`countWatched`／`loadFlagMap`／`ensureUser`／`getUserById`／`listUserIds`／
// `getActiveSearchProfile`／`sqlExcludeFixtureRows`）都被拉進 `queueGeoBackfill` 的卡點裡
// （第七十七批）。改用既有的 `safeStats()`（`listingStatsAsync`，PG 讀 PG）。
async function broadcastWatch(result) {
  for (const client of clients) {
    const events = (result.events || []).filter((event) => !event.user_id || event.user_id === client.userId);
    const payload = {
      type: "watch",
      result: { ...result, events },
      stats: await safeStats(client.userId),
    };
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

async function broadcastNotify(events) {
  const byUser = new Map();
  for (const event of events || []) {
    const uid = Number(event.user_id) || 0;
    if (!uid) continue;
    const list = byUser.get(uid) || [];
    list.push(event);
    byUser.set(uid, list);
  }
  for (const [userId, list] of byUser) {
    broadcast({ type: "notify", events: list, stats: await safeStats(userId) }, userId);
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
  // 身分來源必須與設定同一個 store：本機 id 拿去讀 PG 設定會錯位（同一個人的兩份資料）。
  const uid = await defaultUserIdAsync();
  // 上班地址與座標是會員設定，必須與其他節點同源：PG 模式下讀寫本機 SQLite 會讓
  // 「在 A 儲存的地址、B 讀不到」而重複補座標或覆蓋新值。
  const current = await getSettingsAsync(uid);
  if (!(Number(current.commuteKm) > 0)) return current;
  const workAddress = String(current.workAddress || "").trim();
  if (!workAddress || (hasWorkPoint(current) && isTaiwanCoord(current.workLat, current.workLng))) return current;
  try {
    const geo = await geocodeAddress(workAddress, geoLookupAsync(), { strict: false, maxAttempts: 2, allowAdmin: false });
    if (!geo) return current;
    await setCachedGeoAsync(workAddress, geo.lat, geo.lng, geo);
    return await saveSettingsAsync({ workLat: geo.lat, workLng: geo.lng, workLocationClass: geo.location_class || "" }, uid);
  } catch (error) {
    console.warn("補上班地址座標失敗：", error.message);
    return current;
  }
}

// ⚠️ 同步預設值改成 async 入口：`getSettings()` 讀的是節點本機 SQLite，
// PG 模式（正式站）會拿到另一份設定。呼叫端若已經有 settings 就傳進來（不要重讀）。
async function queueGeoBackfill(settings = null) {
  const resolved = settings || await getSettingsAsync(0);
  settings = await settingsForGeoBackfillAsync(resolved);
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
      if (notified.length) await broadcastNotify(notified);
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
          if (notified.length) await broadcastNotify(notified);
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
          if (notified.length) await broadcastNotify(notified);
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
      broadcast({ type: "geo", stats: await safeStats(0), done: true });
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
      // 第九十一批：回「這一輪還在跑」而不是 `lastRun`。`lastRun` 可能還留著**上一輪**的逾時錯誤，
      // 排程器每秒/每分鐘印一次就會變成「一直在報錯」的假象（實際上是同一輪還在跑）。
      return {
        skipped: "busy",
        busy_ms: tickGate.ageMs(),
        reason,
        checked_at: new Date().toISOString(),
        searches: [],
        events: [],
      };
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
    await broadcastWatch(lastRun);
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

// `db.js confirmExpiredOfflineFromSettings()` 的 async 版：設定讀 PG（`getSettingsAsync`），
// 掃描走 `crawlerWrites.confirmExpiredOfflineAsync()`（PG 模式寫 PostgreSQL）。節流在那支裡面。
async function confirmExpiredOfflineFromSettingsAsync() {
  try {
    const settings = await getSettingsAsync(0);
    await confirmExpiredOfflineAsync({ days: settings?.offlineConfirmDays });
  } catch (error) {
    console.warn("確認逾期下線失敗：", error.message);
  }
}

// `stats()`（db.js）的 driver-aware 版：PG 模式讀 PG 的統計島嶼（`listingStatsAsync`），
// 失敗時回同一個安全形狀（與同步版同一個契約：統計壞掉不該讓整個回應 500）。
async function safeStats(userId) {
  try {
    return await listingStatsAsync({ userId });
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

app.post("/api/change-password", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      const err = new Error("請先登入");
      err.status = 401;
      throw err;
    }
    // 密碼必須寫進「登入讀的那一份」（`verifyLoginAsync` 讀 PG）；通知則走 async 的寄信佇列。
    await changeUserPasswordAsync(session.userId, req.body?.currentPassword, req.body?.newPassword);
    await queueSystemMailAsync("password_changed", session.email);
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
    settings = await getSettingsAsync(uid);
  } catch (error) {
    res.status(500).json({ error: error.message || "讀取設定失敗" });
    return;
  }
  let listingStats = { total: 0 };
  let listings = [];
  let events = [];
  try {
    await confirmExpiredOfflineFromSettingsAsync();
    const page = await loadListingPage({
      filter: "all", sort: "newest", limit: 500, offset: 0,
      userId: uid, matchVoteUserId: uid,
    });
    listings = page.listings;
    listingStats = page.stats;
    // 事件清單要走 PG：站上的通知事件在 `user_events`（PG），讀本機只看得到這一台的。
    events = await recentEventsAsync(uid, 30);
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

app.post("/api/commute/focus", async (req, res) => {
  const session = requireMember(req, res);
  if (!session) return;
  const uid = session.userId;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((id) => id > 0).slice(0, 80);
  commuteFocusByUser.set(uid, { ids, at: Date.now() });
  await queueGeoBackfill(await getSettingsAsync(uid));
  res.json({ ok: true, count: ids.length });
});

app.get("/api/commute/snapshot", async (req, res) => {
  const session = requireMember(req, res);
  if (!session) return;
  const uid = session.userId;
  const settings = await getSettingsAsync(uid);
  const ids = String(req.query.ids || "")
    .split(",")
    .map(Number)
    .filter((id) => id > 0)
    .slice(0, 80);
  // PG 模式下同步版讀的是節點本機：PG 才有的刊登會拿到 null（地圖卡片沒有通勤資訊），
  // 觀看者旗標與個人同戶狀態也可能與另一台節點不同（第七十六批）。
  res.json({
    listings: await listingCommutePatchesAsync(ids, uid, { settings }),
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
  await confirmExpiredOfflineFromSettingsAsync();
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

app.post("/api/reset-listings", async (req, res) => {
  if (!actorIsAdmin(req)) {
    res.status(403).json({ error: "只有管理員可以清除物件紀錄" });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "需要確認才會清除紀錄" });
    return;
  }
  // PG 模式下 DELETE 必須下在站上讀的那一份（同步版只清本機，畫面卻回「已清除」）。
  const settings = await resetListingsAsync();
  lastRun = null;
  const session = readSession(req);
  res.json({ ok: true, settings, stats: await safeStats(session?.userId) });
});

app.post("/api/reset-all", async (req, res) => {
  if (!actorIsAdmin(req)) {
    res.status(403).json({ error: "只有管理員可以清除全部資料" });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "需要確認才會清除全部資料" });
    return;
  }
  const settings = await resetAllDataAsync();
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
  res.json({ listing, history: await sourceHistoryAsync(listing.source_key, uid) });
});

// 「全部清除」特別關注／已隱藏：整批歸零指定旗標，只影響呼叫者自己的資料。
app.post("/api/me/listings/clear-flags", async (req, res) => {
  try {
    const session = requireMember(req, res);
    if (!session) return;
    const kind = String(req.body?.kind || "");
    const result = await clearListingFlagsByUserAsync(kind, session.userId, {});
    res.json({ kind, count: result.count, stats: result.stats });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || "無法清除標記", code: error.code || "" });
  }
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
    res.json({ listing: updated, stats: await safeStats(uid) });
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
    const current = await getSettingsAsync(uid);
    const resolved = resolveWorkPointForSave(current, {
      workAddress: body.workAddress !== undefined ? workAddress : current.workAddress,
      commuteKm: body.commuteKm !== undefined ? body.commuteKm : current.commuteKm,
    });
    if (resolved.error) throw new Error(resolved.error);
    if (resolved.needsGeocode) {
      const geo = await geocodeAddress(resolved.workAddress, geoLookupAsync(), { strict: true, maxAttempts: 2 });
      if (!geo) throw new Error("找不到這個上班地址，請再寫詳細一點");
      body.workAddress = resolved.workAddress;
      body.workLat = geo.lat;
      body.workLng = geo.lng;
      body.workLocationClass = geo.location_class || "";
      await setCachedGeoAsync(resolved.workAddress, geo.lat, geo.lng, geo);
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
    res.json({ settings, stats: await safeStats(uid) });
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
    // `boxFromRoadDescription()` 會逐個路名查快取（PG 島嶼）並把新查到的座標寫回去。
    const box = await boxFromRoadDescription(text, {
      lookup: geoLookupAsync(),
      save: (road, lat, lng, meta) => setCachedGeoAsync(road, lat, lng, meta),
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
app.get("/api/events/revision", async (req, res) => {
  const session = requireMember(req, res);
  if (!session) return;
  try {
    const since = Math.max(0, Number(req.query.since) || 0);
    res.json({
      revision: await currentRevisionAsync(),
      changes: await changesSinceAsync(since, { limit: 500 }),
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
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

// 第八十九批：`/api/*` 的 JSON 保底（順序很重要）
//   1. 未知的 API 路徑 → JSON 404（原本是 Express 預設的 HTML 404 ⇒ 前端 `res.json()` 爆
//      「Unexpected token '<'」）。
//   2. 錯誤中介層最後註冊（Express 只認最後一個錯誤中介層）。
// ⚠️ 兩個都必須在**最後一條路由之後**：`/api/events/revision` 與 `/api/events/stream`
//    註冊在檔案後段（4.7k 行附近），第一版把 404 掛在 static 之前 ⇒ 那兩條被 404 蓋掉
//    （本機煙霧測試才發現）。`v3/test/api-fallbacks.test.js` 有一條守衛盯著這個順序。
app.use("/api", apiNotFoundHandler());
app.use(apiErrorHandler());

// C3：清理「已上傳但回饋沒送出」的孤兒附件（正常情況前端會自己刪；這裡是最後一道）。
// 每 6 小時一次；只清 feedback_id = 0 且超過 24 小時的列，已綁定的一律不動。
function startFeedbackAttachmentSweep() {
  const run = () => sweepOrphanFeedbackAttachmentsAsync({ olderThanMs: 24 * 60 * 60 * 1000 })
    .then((r) => { if (r?.removed) console.log(`回饋附件清理：移除 ${r.removed} 張未綁定的暫存圖`); })
    .catch((error) => console.warn("回饋附件清理失敗：", error?.message || error));
  setTimeout(run, 60_000);
  setInterval(run, 6 * 60 * 60 * 1000);
}

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
  startFeedbackAttachmentSweep();
  setInterval(runHousingRefresh, 24 * 60 * 60 * 1000);
  // Phase 2：非同步 feedback → Ops 遞送。預設關閉（需 OPS_FEEDBACK_DELIVERY=1 + OPS_INGEST_URL + OPS_INGEST_SECRET）。
  const opsDelivery = deliveryConfigFromEnv();
  if (opsDelivery.enabled) {
    // PG 模式要送 PG 的佇列（同步版讀寫本機 ⇒ 送出的永遠是本機那一份，PG 的事件永遠 pending）。
    if (resolveDbDriver() === "postgres") {
      startDeliveryLoopAsync(opsDelivery, { log: (tag, info) => console.log(tag, JSON.stringify(info)) });
    } else {
      startDeliveryLoop(opsDeliveryDb(), opsDelivery, { log: (tag, info) => console.log(tag, JSON.stringify(info)) });
    }
    console.log(`Ops feedback 遞送已啟用：每 ${opsDelivery.intervalMs}ms 一次 → ${opsDelivery.url}`);
  }
  // listing_enrich 時鐘：這支佇列原本**只靠事件**才被叫（關注 houseprice、爬蟲輪次結束、
  // 點通知導向），沒事件就不消化 ⇒ 2026-10-07 實測 8759 筆 queued、每小時只處理 20～36 筆。
  // 這裡只加「按期叫一次」，每輪筆數與事件版同量級（預設 4），退避照既有的走
  // （transient 60s→5m→15m、parse_failed 24h、source_limited 12h），**不動 claim 語意**。
  // 關掉：LISTING_ENRICH_CLOCK=0（回到只有事件 kick 的舊行為）。
  const enrichClock = enrichClockConfig(process.env);
  if (enrichClock.enabled) {
    startListingEnrichClock(async ({ tickLimit }) => {
      const stats = { attempted: 0 };
      await kickListingEnrich({ limit: tickLimit, stats });
      return stats.attempted;
    }, enrichClock, { log: (tag, info) => console.log(tag, JSON.stringify(info)) });
    console.log(
      `listing_enrich 時鐘已啟用：每 ${enrichClock.intervalMs}ms 一輪、每輪最多 ${enrichClock.tickLimit} 筆（關掉：LISTING_ENRICH_CLOCK=0）`,
    );
  }
  // 三支 5 分鐘 tick：PG 模式走 async 入口（讀寫 PG），其餘保持同步版（讀寫本機 SQLite）。
  if (resolveDbDriver() === "postgres") {
    startWishLifecycleLoop(() => runWishLifecycleWorkerTickAsync(), { intervalMs: 5 * 60 * 1000, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
    startWishOfferExpiryLoop(() => runWishOfferExpiryWorkerTickAsync(), { intervalMs: 5 * 60 * 1000, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
    startRentalNotifyLoop(() => runRentalNotifyWorkerTickAsync(), { intervalMs: 5 * 60 * 1000, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  } else {
    startWishLifecycleLoop(() => runWishLifecycleWorkerTick(), { intervalMs: 5 * 60 * 1000, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
    startWishOfferExpiryLoop(() => runWishOfferExpiryWorkerTick(), { intervalMs: 5 * 60 * 1000, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
    startRentalNotifyLoop(() => runRentalNotifyWorkerTick(), { intervalMs: 5 * 60 * 1000, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  // CRM 遞送 loop：PG 模式要送 PG 的 crm_outbox（同步版讀寫本機 ⇒ 送出的永遠是本機那一份）。
  if (resolveDbDriver() === "postgres") {
    startCrmDeliveryLoopAsync(process.env, { log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  } else {
    startCrmDeliveryLoop(opsDeliveryDb(), process.env, { log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
}

// PG 模式的許願房生命週期 tick 入口（旗標先從 PG 收斂）。
async function runWishLifecycleWorkerTickAsync(now = new Date()) {
  const flags = await getRentalMarketplaceFlagsAsync({ driver: "postgres" });
  return runWishLifecycleTickAsync(now, { flags }, { driver: "postgres" });
}

// PG 模式的提案逾期 tick 入口（旗標先從 PG 收斂）。
async function runWishOfferExpiryWorkerTickAsync(now = new Date()) {
  const flags = await getRentalMarketplaceFlagsAsync({ driver: "postgres" });
  return runWishOfferExpiryTickAsync(now, { flags }, { driver: "postgres" });
}

// PG 模式的租屋通知 tick 入口：先從 PG 收斂旗標與目錄快取（配對 hard gate 需要目錄），
// 再把 async 的 matchFn／hardGateFn 注入（對齊 db.js:runRentalNotifyWorkerTick 的同步版）。
async function runRentalNotifyWorkerTickAsync(now = new Date(), extra = {}) {
  const flags = await getRentalMarketplaceFlagsAsync({ driver: "postgres" });
  await getRentalCatalogAsync({ driver: "postgres" });
  return runRentalNotifyTickAsync(now, {
    flags,
    matchFn: (listingId, ownerId) => ownerListingMatchesAsync(listingId, ownerId, { limit: 20, driver: "postgres" }),
    hardGateFn: (listingId, ownerId, wishRef) => pairStillHardEligibleAsync(listingId, ownerId, wishRef, { driver: "postgres" }),
    ...extra,
  }, { driver: "postgres" });
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
