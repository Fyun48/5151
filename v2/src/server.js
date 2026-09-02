import "./env.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  coveringJobsFromAllUsers,
  crawlIntervalMinutes,
  defaultUserId,
  listUserIds,
  deleteProfile,
  getCachedGeo,
  getListing,
  getSettings,
  hideMany,
  listListings,
  loadProfile,
  recentEvents,
  registerUser,
  rejectSuspectedMatch,
  confirmSuspectedMatch,
  resetListings,
  resetAllData,
  saveAsProfile,
  saveSettings,
  setCachedGeo,
  setFlags,
  sourceHistory,
  stats,
  requestTempPassword,
  listAdminMembers,
  adminPatchMember,
  getUserById,
  getMailTemplates,
  changeUserPassword,
  getAdminMailSettings,
  saveAdminMailSettings,
  getAdminSponsorSettings,
  saveAdminSponsorSettings,
  publicSponsorSettings,
  getAdminMapsSettings,
  saveAdminMapsSettings,
  settingsForGeoBackfill,
  getMemberMailSettings,
  getMemberSmtp,
  saveMemberMailSettings,
} from "./db.js";
import { adminEmail, clearSessionCookie, envAdminConfigured, readSession, requireAuth, sessionCookie, verifyLogin } from "./auth.js";
import { boxFromRoadDescription, geocodeAddress, needsListingGeo, hasWorkPoint } from "./geo.js";
import { rent591Url } from "./openLink.js";
import { CITIES } from "./regions.js";
import { DISCLAIMER_TEXT, DISCLAIMER_VERSION } from "./members.js";
import { mailConfigured, sendMail } from "./mail.js";
import { queueAccountMail } from "./systemMail.js";
import { assertHuman, issueCaptcha } from "./captcha.js";
import { assertCaptchaIssuable, assertDemoReadable, authAttemptKeys, clientIp } from "./rateLimit.js";
import { buildDemoState } from "./demo.js";
import { backfillListingCoords, backfillListingMrt, backfillListingRoutes, flushPendingNotifications, runWatch } from "./watcher.js";
import { LIST_PAGE_SIZE } from "./client591.js";
import { APP_NAME } from "./brand.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 5152);
const HOST = process.env.HOST || "0.0.0.0";

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.get("/index.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.get("/api/demo", (req, res) => {
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

/** 點通知／Discord 連結：已登入才標記已瀏覽，再導向 591。訪客只轉址、不寫入。 */
app.get("/go/:id", (req, res) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id) && id > 0) {
    try {
      const session = readSession(req);
      if (session?.userId && getListing(id, session.userId)) {
        setFlags(id, { viewed: true }, session.userId);
      }
    } catch (error) {
      console.warn("標記已瀏覽失敗：", error.message);
    }
  }
  res.redirect(302, rent591Url(id));
});

app.use("/vendor", express.static(path.join(__dirname, "../public/vendor"), { maxAge: "7d" }));

app.get("/api/me", (req, res) => {
  const session = readSession(req);
  res.json({
    ok: Boolean(session),
    email: session?.email || "",
    role: session?.role || "",
    plan: session?.plan || "",
    configured: true,
    canRegister: true,
    hint: "",
    sponsor: session ? publicSponsorSettings(session) : { show: false, links: [], sponsored: false, intro: "", thanks: "" },
  });
});

app.get("/api/disclaimer", (_req, res) => {
  res.json({ version: DISCLAIMER_VERSION, text: DISCLAIMER_TEXT });
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
  });
}

app.post("/api/register", (req, res) => {
  try {
    assertHuman(req.body);
    const user = registerUser({
      email: req.body?.email,
      password: req.body?.password,
      acceptDisclaimer: req.body?.acceptDisclaimer === true,
    });
    setSession(req, res, user.email);
    queueSystemMail("welcome", user.email);
    res.json({ ok: true, email: user.email, role: user.role, plan: user.plan });
  } catch (error) {
    sendAuthError(res, error);
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

app.get("/api/admin/members", requireAdminApi, (_req, res) => {
  const members = listAdminMembers();
  const payload = { members };
  if (/password_hash|"password"|scrypt:/.test(JSON.stringify(payload))) {
    res.status(500).json({ error: "會員列表不得含密碼" });
    return;
  }
  res.json(payload);
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

app.post("/api/admin/mail/test", requireAdminApi, async (req, res) => {
  try {
    const session = readSession(req);
    const to = String(req.body?.to || session?.email || "").trim();
    if (!to) throw new Error("請先填收件信箱");
    if (!mailConfigured()) throw Object.assign(new Error("請先儲存 SMTP 設定"), { status: 400 });
    await sendMail({
      to,
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
  (async () => {
    if (needCommute) {
      for (let round = 0; round < 200; round += 1) {
        try {
          const routes = await backfillListingRoutes(settings, { limit: 20 });
          if (routes.attempted) broadcast({ type: "geo", stats: stats(), routeBackfill: routes });
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
          broadcast({ type: "geo", stats: stats(), geoBackfill: geo });
          const notified = await flushPendingNotifications(settings);
          if (notified.length) broadcastNotify(notified);
          if (!geo.attempted) break;
        } catch (error) {
          console.warn("補定位失敗：", error.message);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }
    for (let round = 0; round < 80; round += 1) {
      try {
        const mrt = await backfillListingMrt({ limit: 20 });
        if (mrt.attempted) broadcast({ type: "geo", stats: stats(), mrtBackfill: mrt });
        if (!mrt.attempted) break;
      } catch (error) {
        console.warn("補捷運距離失敗：", error.message);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  })()
    .finally(() => {
      geoBackfillBusy = false;
    });
}

async function tick(reason = "schedule") {
  try {
    lastRun = await runWatch({ skipHeavyGeo: true });
    lastRun.reason = reason;
    broadcastWatch(lastRun);
    queueGeoBackfill();
    return lastRun;
  } catch (error) {
    lastRun = { error: error.message, checked_at: new Date().toISOString(), reason };
    broadcast({ type: "error", error: error.message });
    throw error;
  }
}

function schedule() {
  if (timer) clearInterval(timer);
  const minutes = crawlIntervalMinutes();
  timer = setInterval(() => {
    tick("schedule").catch(() => {});
  }, minutes * 60 * 1000);
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

app.get("/api/state", (req, res) => {
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
    const listed = listListings({ filter: "all", sort: "newest", limit: 500, userId: uid });
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

app.get("/api/listings", (req, res) => {
  const uid = actorUserId(req);
  const districts = String(req.query.districts || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const listed = listListings({
    filter: req.query.filter || "all",
    kind: req.query.kind || "",
    q: req.query.q || "",
    sort: req.query.sort || "newest",
    limit: Number(req.query.limit) || 500,
    districts,
    userId: uid,
  });
  res.json({
    stats: { ...stats(undefined, uid), matched: listed.totalMatched },
    listings: listed.listings,
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

app.post("/api/listings/:id/flags", (req, res) => {
  const uid = actorUserId(req);
  const updated = setFlags(Number(req.params.id), req.body || {}, uid);
  if (!updated) {
    res.status(404).json({ error: "找不到這筆物件" });
    return;
  }
  res.json({ listing: updated, stats: stats(undefined, uid) });
});

app.post("/api/listings/:id/reject-match", (req, res) => {
  const uid = actorUserId(req);
  const updated = rejectSuspectedMatch(Number(req.params.id), uid);
  if (!updated) {
    res.status(404).json({ error: "找不到這筆物件" });
    return;
  }
  res.json({ listing: updated, stats: stats(undefined, uid) });
});

app.post("/api/listings/:id/confirm-match", (req, res) => {
  const uid = actorUserId(req);
  const updated = confirmSuspectedMatch(Number(req.params.id), uid);
  if (!updated) {
    res.status(404).json({ error: "找不到這筆物件或缺少比對對象" });
    return;
  }
  res.json({ listing: updated, stats: stats(undefined, uid) });
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
  const settings = saveSettings(body, uid);
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
    const name = String(req.body?.name || "").trim();
    if (!name) throw new Error("請先填設定檔名稱");
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
    const result = await tick("manual");
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

app.listen(PORT, HOST, () => {
  schedule();
  console.log(`${APP_NAME}：http://${HOST}:${PORT}`);
  if (envAdminConfigured()) {
    console.log(`管理員帳號：${adminEmail()}（也可註冊新會員）`);
  } else {
    console.log("可從登入頁註冊新會員。若要保留舊的單一管理員，請在 auth.env 設定 AUTH_EMAIL / AUTH_PASSWORD。");
  }
  if (!mailConfigured()) {
    console.log("系統信（註冊、忘記密碼、變更密碼、贊助）尚未能寄信：請在後台填 SMTP，或在 auth.env 寫入 SMTP_HOST、SMTP_USER、SMTP_PASS、SMTP_FROM。");
  }
  setTimeout(() => {
    ensureWorkCoords()
      .then((settings) => {
        const jobs = coveringJobsFromAllUsers();
        if (!jobs.length) return;
        queueGeoBackfill(settings);
        return tick("startup");
      })
      .catch((error) => {
        console.warn("第一次檢查失敗：", error.message);
      });
  }, 8000);
});

