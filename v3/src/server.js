import "./env.js";
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
  getListing,
  markListingOffline,
  restoreListingOnline,
  markListingAlive,
  touchListingChecked,
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
  settingsForGeoBackfill,
  getMemberMailSettings,
  getMemberSmtp,
  saveMemberMailSettings,
  getHelpQa,
  saveHelpQa,
  getWishConditions,
  saveWishConditions,
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
  armMemberExternalFetch,
  touchLastLogin,
  resumeIdleIfNeeded,
  pauseIdleMembers,
  linkOauthIdentity,
  isSystemCoveringDue,
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
import { assertCaptchaIssuable, assertDemoReadable, assertImportAllowed, authAttemptKeys, clientIp } from "./rateLimit.js";
import { buildDemoState } from "./demo.js";
import { backfillAddressGeo, backfillIncompleteAddresses, backfillListingCoords, backfillListingMrt, backfillListingRoutes, flushPendingNotifications, isWatchIntervalPending, runWatch } from "./watcher.js";
import { LIST_PAGE_SIZE, isListingGoneError, probeListingAlive } from "./client591.js";
import { probeHpListingAlive } from "./houseprice.js";
import { probeListingAliveBySource } from "./probe.js";
import { deliveryConfigFromEnv, startDeliveryLoop } from "./opsDelivery.js";
import { startCrmDeliveryLoop } from "./crmDelivery.js";
import { opsDeliveryDb } from "./db.js";
import { refreshHousingData } from "./housingFetch.js";
import { APP_NAME, APP_VERSION } from "./brand.js";
import { profileNameOrDraft } from "./settingsState.js";
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

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: APP_VERSION });
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

function actorUserId(req) {
  const session = readSession(req);
  if (session?.userId) return session.userId;
  return defaultUserId();
}

function actorIsAdmin(req) {
  return readSession(req)?.role === "admin";
}

function setSession(req, res, email) {
  const cookie = sessionCookie(req, email);
  res.setHeader("Set-Cookie", cookie);
}

/** 點通知／Discord 連結：已登入才標記已瀏覽，再導向原站。站內刊登：會員開站內詳情、訪客開公開分享頁。訪客只轉址、不寫入。 */
app.get("/go/:id", (req, res) => {
  const id = Number(req.params.id);
  let listing = null;
  const session = readSession(req);
  if (Number.isFinite(id) && id > 0) {
    try {
      listing = getListing(id);
      if (session?.userId && getListing(id, session.userId)) {
        setFlags(id, { viewed: true }, session.userId);
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
    res.json(getDemand(req.params.id, { viewerId: session?.userId || 0 }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/public/wish-room/:id", (req, res) => {
  try {
    const post = getDemand(req.params.id, { viewerId: 0, publicOnly: true });
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(publicWishRoomView(post) || post);
  } catch (error) {
    res.status(error.status === 404 ? 404 : 400).json({ error: error.message });
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

app.get("/verify-email", (req, res) => {
  try {
    const user = confirmVerifyToken(String(req.query?.token || ""));
    afterMemberSession(user);
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

app.use(requireAuth);

function requireAdminApi(req, res, next) {
  if (actorIsAdmin(req)) return next();
  res.status(403).json({ error: "只有管理員可以做這個" });
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
    res.json(publishAnnouncement(db, commsActor(req), Number(req.params.id)));
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
  res.json(publicCommsBundle(db, {
    config: getCommsConfig(),
    sponsorOffer: session ? publicSponsorSettings(session) : {},
    user: session ? { id: session.userId, plan: session.plan, role: session.role } : {},
  }));
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

app.post("/api/admin/ops-delivery/compact-outbox", requireAdminApi, (req, res) => {
  const olderThanMs = Number(req.body?.older_than_ms);
  res.json({ ok: true, ...compactOpsOutbox({ olderThanMs: Number.isFinite(olderThanMs) && olderThanMs >= 0 ? olderThanMs : undefined }) });
});

app.get("/api/admin/crm", requireAdminApi, (req, res) => {
  res.json({
    ...getCrmOverview({ q: req.query?.q }),
    sync: getCrmDeliveryControl(),
  });
});

app.put("/api/admin/crm/module", requireAdminApi, (req, res) => {
  const enabled = !(req.body?.enabled === false || req.body?.enabled === 0 || req.body?.enabled === "0");
  res.json({ module: setCrmModuleEnabled(enabled), sync: getCrmDeliveryControl() });
});

app.put("/api/admin/crm/sync", requireAdminApi, (req, res) => {
  const stop = req.body?.stop === true || req.body?.stop === 1 || req.body?.stop === "1";
  res.json(setCrmDeliveryStop(stop));
});

app.get("/api/admin/crm/contacts/:id", requireAdminApi, (req, res) => {
  try {
    res.json(getCrmContact(req.params.id));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/contacts", requireAdminApi, (req, res) => {
  try {
    res.status(201).json(createCrmContact(req.body || {}, { actorUserId: actorUserId(req) }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.patch("/api/admin/crm/contacts/:id", requireAdminApi, (req, res) => {
  try {
    res.json(updateCrmContact(req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/contacts/:id/cases", requireAdminApi, (req, res) => {
  try {
    res.status(201).json(createCrmCase(req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.patch("/api/admin/crm/cases/:id", requireAdminApi, (req, res) => {
  try {
    res.json(updateCrmCase(req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/contacts/:id/notes", requireAdminApi, (req, res) => {
  try {
    res.status(201).json(addCrmNote(req.params.id, req.body || {}, { actorUserId: actorUserId(req) }));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/contacts/:id/todos", requireAdminApi, (req, res) => {
  try {
    res.status(201).json(addCrmTodo(req.params.id, req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/todos/:id/done", requireAdminApi, (req, res) => {
  try {
    res.json(setCrmTodoDone(req.params.id, req.body?.done !== false));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/admin/crm/from-feedback/:id", requireAdminApi, (req, res) => {
  try {
    res.status(201).json(createCrmFromFeedback(req.params.id));
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

app.get("/api/admin/providers", requireAdminApi, (_req, res) => {
  res.json(getAdminProviderSettings());
});

app.put("/api/admin/providers/site-budget", requireAdminApi, (req, res) => {
  try {
    res.json({ ok: true, ...saveAdminSiteBudget(req.body || {}), overview: getAdminProviderSettings() });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.put("/api/admin/providers", requireAdminApi, (req, res) => {
  try {
    res.json({ ok: true, item: saveAdminProviderSettings(req.body || {}), overview: getAdminProviderSettings() });
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

app.get("/api/admin/providers/usage", requireAdminApi, (_req, res) => {
  res.json(getAdminProviderSettings());
});

app.get("/api/admin/maps", requireAdminApi, (_req, res) => {
  res.json(getAdminMapsSettings());
});

app.put("/api/admin/maps", requireAdminApi, (req, res) => {
  try {
    const body = req.body || {};
    const settings = saveAdminMapsSettings(body);
    if (settings.enabled && body.clearKey !== true) queueGeoBackfill();
    res.json(settings);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/crawl-sources", requireAdminApi, (_req, res) => {
  res.json(getCrawlSources());
});

app.put("/api/admin/crawl-sources", requireAdminApi, (req, res) => {
  try {
    res.json(saveCrawlSources(req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.get("/api/admin/system-crawl", requireAdminApi, (_req, res) => {
  res.json(getSystemCrawl());
});

app.put("/api/admin/system-crawl", requireAdminApi, (req, res) => {
  try {
    res.json(saveSystemCrawl(req.body || {}));
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
      ...selfListingMeta(),
      tools: listingToolsInfo(session.userId),
      listings: listMineSelfListings(session.userId),
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
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
    res.json(createSelfListing(session.userId, body));
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
    res.json({ ok: true, to });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.use(express.static(path.join(__dirname, "../public")));

let timer = null;
let lastRun = null;
let tickBusy = false;
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

let geoBackfillBusy = false;

async function ensureWorkCoords() {
  const uid = defaultUserId();
  const current = getSettings(uid);
  if (!(Number(current.commuteKm) > 0)) return current;
  const workAddress = String(current.workAddress || "").trim();
  if (!workAddress || hasWorkPoint(current)) return current;
  try {
    const geo = await geocodeAddress(workAddress, getCachedGeo, { strict: false, maxAttempts: 2 });
    if (!geo) return current;
    setCachedGeo(workAddress, geo.lat, geo.lng);
    return saveSettings({ workLat: geo.lat, workLng: geo.lng }, uid);
  } catch (error) {
    console.warn("補上班地址座標失敗：", error.message);
    return current;
  }
}

function queueGeoBackfill(settings = getSettings()) {
  settings = settingsForGeoBackfill(settings);
  if (geoBackfillBusy) return;
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
    if (needCommute) {
      for (let round = 0; round < 200; round += 1) {
        try {
          const routes = await backfillListingRoutes(settings, { limit: 20 });
          if (routes.attempted) broadcast({ type: "geo", routeBackfill: routes });
          const notified = await flushPendingNotifications(settings);
          if (notified.length) broadcastNotify(notified);
          if (!routes.attempted) break;
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
    } catch (error) {
      console.warn("補定位後統計失敗：", error.message);
    }
  })()
    .finally(() => {
      geoBackfillBusy = false;
    });
}

async function tick(reason = "schedule") {
  if (tickBusy && reason === "schedule") {
    return lastRun || { skipped: "busy", reason, checked_at: new Date().toISOString(), searches: [], events: [] };
  }
  tickBusy = true;
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
    const systemDue = reason === "force" || reason === "startup" || isSystemCoveringDue(now);
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
    lastRun = await runWatch({
      skipHeavyGeo: true,
      jobs: plan.jobs,
      includedUserIds: plan.includedUserIds,
      includeSystem: plan.includeSystem,
    });
    lastRun.reason = reason;
    broadcastWatch(lastRun);
    if (reason !== "startup") queueGeoBackfill();
    return lastRun;
  } catch (error) {
    lastRun = { error: error.message, checked_at: new Date().toISOString(), reason };
    broadcast({ type: "error", error: error.message });
    throw error;
  } finally {
    tickBusy = false;
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

app.get("/api/settings", (req, res) => {
  try {
    res.json({ settings: getSettings(actorUserId(req)), cities: CITIES });
  } catch (error) {
    res.status(500).json({ error: error.message || "讀取設定失敗" });
  }
});

app.get("/api/member-mail", (req, res) => {
  try {
    res.json(getMemberMailSettings(actorUserId(req)));
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
    res.json(saveMemberMailSettings(actorUserId(req), req.body || {}));
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || "儲存郵件設定失敗" });
  }
});

app.post("/api/member-mail/test", async (req, res) => {
  try {
    const uid = actorUserId(req);
    const session = readSession(req);
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
  const uid = actorUserId(req);
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
    listingStats = stats(undefined, uid);
    const listed = listListings({
      filter: "all",
      sort: "newest",
      limit: 500,
      userId: uid,
      matchVoteUserId: readSession(req)?.userId || 0,
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

app.get("/api/listings", async (req, res) => {
  await yieldEventLoop();
  const uid = actorUserId(req);
  const districts = String(req.query.districts || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const started = Date.now();
  const listed = listListings({
    filter: req.query.filter || "all",
    kind: req.query.kind || "",
    sources: authorizedListingSources(req.query.sources || "", readSession(req)).join(","),
    q: req.query.q || "",
    sort: req.query.sort || "newest",
    limit: Number(req.query.limit) || 500,
    districts,
    userId: uid,
    matchVoteUserId: readSession(req)?.userId || 0,
    sameHouse: req.query.sameHouse !== "0",
  });
  const queryMs = Date.now() - started;
  res.setHeader("Server-Timing", `list;dur=${queryMs}`);
  res.json({
    stats: { ...stats(undefined, uid), matched: listed.totalMatched },
    listings: listed.listings,
    timing: { query_ms: queryMs, dataset: listed.totalMatched },
  });
});

app.post("/api/listings/hide-many", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) {
    res.status(400).json({ error: "請先勾選物件" });
    return;
  }
  res.json(hideMany(ids, actorUserId(req)));
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
  res.json({ ok: true, settings, stats: stats(undefined, actorUserId(req)) });
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

app.get("/api/listings/:id/history", (req, res) => {
  const uid = actorUserId(req);
  const listing = getListing(Number(req.params.id), uid);
  if (!listing) {
    res.status(404).json({ error: "找不到這筆物件" });
    return;
  }
  res.json({ listing, history: sourceHistory(listing.source_key, uid) });
});

app.post("/api/listings/:id/flags", async (req, res) => {
  try {
    const uid = actorUserId(req);
    const updated = setFlags(Number(req.params.id), req.body || {}, uid);
    if (!updated) {
      res.status(404).json({ error: "找不到這筆物件" });
      return;
    }
    if (req.body?.watched === true || req.body?.watched === 1) {
      queueGeoBackfill();
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

app.post("/api/listings/:id/recheck", async (req, res) => {
  try {
    const session = readSession(req);
    if (!session?.userId) {
      res.status(401).json({ error: "請先登入", login: true });
      return;
    }
    const postId = Number(req.params.id);
    const listing = getListing(postId);
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
    const lastCheck = Date.parse(listing.last_checked_at || "") || 0;
    if (lastCheck && Date.now() - lastCheck < 60_000) {
      res.json({ supported: true, gone: Boolean(Number(listing.offline)), cooldown: true });
      return;
    }
    const { supported, alive } = await probeListingAliveBySource(listing);
    if (!supported) {
      res.json({ supported: false, gone: false });
      return;
    }
    if (alive === false) {
      markListingOffline(postId);
      res.json({ supported: true, gone: true });
      return;
    }
    markListingAlive(postId);
    res.json({ supported: true, gone: false });
  } catch (error) {
    res.json({ supported: true, gone: false, error: error.message });
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
    const listing = getListing(postId);
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
    const { supported, alive } = await probeListingAliveBySource(listing);
    if (!supported) {
      res.json({ supported: false });
      return;
    }
    if (alive === false) {
      markListingOffline(postId);
      res.json({ supported: true, gone: true, reported: true, message: "已記錄此物件下架，7 日內同屋源若在任一平台重現會自動接手。" });
      return;
    }
    markListingAlive(postId);
    res.json({ supported: true, gone: false, alive: true, locked: true, until: new Date(Date.now() + REPORT_GONE_LOCK_MS).toISOString(), message: REPORT_GONE_LOCK_MSG });
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
  const updated = confirmSuspectedMatch(Number(req.params.id), session.userId);
  if (!updated) {
    res.status(404).json({ error: "找不到這筆物件或缺少比對對象" });
    return;
  }
  res.json({ listing: updated, stats: stats(undefined, session.userId), personal: true, shared: false });
});

app.post("/api/listings/merge-same-house", (req, res) => {
  const session = readSession(req);
  if (!session?.userId) {
    res.status(401).json({ error: "請先登入才能併入同房源" });
    return;
  }
  const result = mergeSameHouseForUser(session.userId, req.body?.ids || req.body?.post_ids);
  if (!result?.ok) {
    const status = result?.code === "guest" ? 401 : 400;
    res.status(status).json({ error: result?.error || "無法併入同房源" });
    return;
  }
  res.json({
    ok: true,
    personal: true,
    shared: false,
    system_agrees: result.systemAgrees,
    message: result.message,
    post_ids: result.post_ids,
    listing: result.listing,
    stats: stats(undefined, session.userId),
  });
});

async function persistSettings(body = {}, userId) {
  const uid = userId || defaultUserId();
  const workAddress = String(body.workAddress || "").trim();
  if (Number(body.commuteKm) > 0) {
    if (!workAddress) throw new Error("請先填上班地址，才能篩通勤距離");
    const current = getSettings(uid);
    const sameAddress =
      String(current.workAddress || "").replace(/\s+/g, "") === workAddress.replace(/\s+/g, "") &&
      hasWorkPoint(current);
    if (sameAddress) {
      body.workAddress = workAddress;
      body.workLat = current.workLat;
      body.workLng = current.workLng;
    } else {
      const geo = await geocodeAddress(workAddress, getCachedGeo, { strict: true, maxAttempts: 2 });
      if (!geo) throw new Error("找不到這個上班地址，請再寫詳細一點");
      body.workAddress = workAddress;
      body.workLat = geo.lat;
      body.workLng = geo.lng;
      setCachedGeo(workAddress, geo.lat, geo.lng);
    }
  } else if (body.workAddress !== undefined) {
    body.workAddress = workAddress;
    if (!workAddress) {
      body.workLat = null;
      body.workLng = null;
    }
  }
  const pausing = Object.prototype.hasOwnProperty.call(body, "notificationsPaused");
  let settings = saveSettings(body, uid);
  if (pausing && settings.notificationsPaused !== true) {
    settings = armMemberExternalFetch(uid);
  }
  schedule();
  return settings;
}

app.post("/api/settings", async (req, res) => {
  try {
    const uid = actorUserId(req);
    const settings = await persistSettings(req.body || {}, uid);
    res.json({ settings, stats: safeStats(uid) });
    queueGeoBackfill(settings);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/profiles", async (req, res) => {
  try {
    const uid = actorUserId(req);
    const name = profileNameOrDraft(req.body?.name);
    const patch = req.body?.settings;
    if (patch && typeof patch === "object") {
      await persistSettings(patch, uid);
    }
    const overwrite = Boolean(req.body?.overwrite);
    const settings = saveAsProfile(name, undefined, uid, { overwrite });
    res.json({ settings });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/profiles/:id/load", (req, res) => {
  try {
    const settings = loadProfile(req.params.id, actorUserId(req));
    schedule();
    res.json({ settings });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.delete("/api/profiles/:id", (req, res) => {
  try {
    const settings = deleteProfile(req.params.id, actorUserId(req));
    res.json({ settings });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/exclude-region", async (req, res) => {
  try {
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
    const uid = actorUserId(req);
    const result = await tick(req.body?.force === true ? "force" : "manual");
    const events = (result.events || []).filter((event) => !event.user_id || event.user_id === uid);
    res.json({ result: { ...result, events }, stats: stats(undefined, uid) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/events/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const userId = actorUserId(req);
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

app.listen(PORT, HOST, () => {
  schedule();
  // 居住數據：開站 30 秒後補一次、之後每天自動抓開放資料（失敗不影響服務）
  setTimeout(runHousingRefresh, 30_000);
  setInterval(runHousingRefresh, 24 * 60 * 60 * 1000);
  // Phase 2：非同步 feedback → Ops 遞送。預設關閉（需 OPS_FEEDBACK_DELIVERY=1 + OPS_INGEST_URL + OPS_INGEST_SECRET）。
  const opsDelivery = deliveryConfigFromEnv();
  if (opsDelivery.enabled) {
    startDeliveryLoop(opsDeliveryDb(), opsDelivery, { log: (tag, info) => console.log(tag, JSON.stringify(info)) });
    console.log(`Ops feedback 遞送已啟用：每 ${opsDelivery.intervalMs}ms 一次 → ${opsDelivery.url}`);
  }
  startCrmDeliveryLoop(opsDeliveryDb(), process.env, { log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  console.log(`${APP_NAME}：http://${HOST}:${PORT}`);
  if (envAdminConfigured()) {
    console.log(`管理員帳號：${adminEmail()}（也可註冊新會員）`);
  } else {
    console.log("可從登入頁註冊新會員。若要保留舊的單一管理員，請在 auth.env 設定 AUTH_EMAIL / AUTH_PASSWORD。");
  }
  if (!mailConfigured(getStoredSmtp())) {
    console.log("系統信（註冊、忘記密碼、變更密碼、贊助）尚未能寄信：請在後台填 SMTP，或在 auth.env 寫入 SMTP_HOST、SMTP_USER、SMTP_PASS、SMTP_FROM。");
  }
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
});

