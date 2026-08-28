import "./env.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteProfile,
  getCachedGeo,
  getListing,
  getSettings,
  hideMany,
  listListings,
  loadProfile,
  recentEvents,
  rejectSuspectedMatch,
  resetListings,
  saveAsProfile,
  saveSettings,
  setCachedGeo,
  setFlags,
  sourceHistory,
  stats,
} from "./db.js";
import { adminEmail, authConfigured, clearSessionCookie, readSession, requireAuth, sessionCookie, verifyLogin } from "./auth.js";
import { boxFromRoadDescription, geocodeAddress, needsListingGeo } from "./geo.js";
import { CITIES } from "./regions.js";
import { backfillListingCoords, backfillListingRoutes, runWatch } from "./watcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 5151);
const HOST = process.env.HOST || "0.0.0.0";

app.use(express.json({ limit: "1mb" }));

app.get("/api/me", (req, res) => {
  const session = readSession(req);
  res.json({
    ok: Boolean(session),
    email: session?.email || "",
    configured: authConfigured(),
    hint: authConfigured() ? adminEmail() : "",
  });
});

app.post("/api/login", (req, res) => {
  try {
    const user = verifyLogin(req.body?.email, req.body?.password);
    res.setHeader("Set-Cookie", sessionCookie(req));
    res.json({ ok: true, email: user.email });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", clearSessionCookie(req));
  res.json({ ok: true });
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "../public")));

let timer = null;
let lastRun = null;
const clients = new Set();

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

let geoBackfillBusy = false;

function queueGeoBackfill(settings = getSettings()) {
  if (geoBackfillBusy || !needsListingGeo(settings)) return;
  geoBackfillBusy = true;
  (async () => {
    for (let round = 0; round < 12; round += 1) {
      try {
        const geo = await backfillListingCoords(settings, { limit: 12 });
        broadcast({ type: "geo", stats: stats(), geoBackfill: geo });
        if (!geo.attempted && !geo.located) break;
      } catch (error) {
        console.warn("補定位失敗：", error.message);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    for (let round = 0; round < 20; round += 1) {
      try {
        const routes = await backfillListingRoutes(settings, { limit: 15 });
        if (routes.attempted) broadcast({ type: "geo", stats: stats(), routeBackfill: routes });
        if (!routes.attempted) break;
      } catch (error) {
        console.warn("補路線失敗：", error.message);
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
    broadcast({ type: "watch", result: lastRun, stats: stats() });
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
  const minutes = Math.max(2, Number(getSettings().intervalMinutes) || 5);
  timer = setInterval(() => {
    tick("schedule").catch(() => {});
  }, minutes * 60 * 1000);
}

app.get("/api/state", (_req, res) => {
  const settings = getSettings();
  res.json({
    settings,
    stats: stats(),
    lastRun,
    listings: listListings({ filter: "all", sort: "price_asc", limit: 500 }),
    events: recentEvents(30),
    cities: CITIES,
  });
});

app.get("/api/listings", (req, res) => {
  res.json({
    stats: stats(),
    listings: listListings({
      filter: req.query.filter || "all",
      q: req.query.q || "",
      sort: req.query.sort || "price_asc",
      limit: Number(req.query.limit) || 500,
    }),
  });
});

app.post("/api/listings/hide-many", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) {
    res.status(400).json({ error: "請先勾選物件" });
    return;
  }
  res.json(hideMany(ids));
});

app.post("/api/reset-listings", (req, res) => {
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "需要確認才會清除紀錄" });
    return;
  }
  const settings = resetListings();
  lastRun = null;
  res.json({ ok: true, settings, stats: stats() });
});

app.get("/api/listings/:id/history", (req, res) => {
  const listing = getListing(Number(req.params.id));
  if (!listing) {
    res.status(404).json({ error: "找不到這筆物件" });
    return;
  }
  res.json({ listing, history: sourceHistory(listing.source_key) });
});

app.post("/api/listings/:id/flags", (req, res) => {
  const updated = setFlags(Number(req.params.id), req.body || {});
  if (!updated) {
    res.status(404).json({ error: "找不到這筆物件" });
    return;
  }
  res.json({ listing: updated, stats: stats() });
});

app.post("/api/listings/:id/reject-match", (req, res) => {
  const updated = rejectSuspectedMatch(Number(req.params.id));
  if (!updated) {
    res.status(404).json({ error: "找不到這筆物件" });
    return;
  }
  res.json({ listing: updated, stats: stats() });
});

app.post("/api/settings", async (req, res) => {
  try {
    const body = req.body || {};
    if (Array.isArray(body.watchDistricts) && body.watchDistricts.length === 0) {
      throw new Error("請至少選一個行政區");
    }
    const workAddress = String(body.workAddress || "").trim();
    if (Number(body.commuteKm) > 0) {
      if (!workAddress) throw new Error("請先填上班地址，才能篩通勤距離");
      const current = getSettings();
      const sameAddress =
        String(current.workAddress || "").replace(/\s+/g, "") === workAddress.replace(/\s+/g, "") &&
        Number.isFinite(Number(current.workLat)) &&
        Number.isFinite(Number(current.workLng));
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
    const settings = saveSettings(body);
    schedule();
    res.json({ settings, stats: stats() });
    queueGeoBackfill(settings);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/profiles", (req, res) => {
  try {
    const settings = saveAsProfile(req.body?.name);
    res.json({ settings });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.post("/api/profiles/:id/load", (req, res) => {
  try {
    const settings = loadProfile(req.params.id);
    schedule();
    res.json({ settings });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

app.delete("/api/profiles/:id", (req, res) => {
  try {
    const settings = deleteProfile(req.params.id);
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

app.post("/api/watch", async (_req, res) => {
  try {
    const result = await tick("manual");
    res.json({ result, stats: stats() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/events/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: "hello", stats: stats(), lastRun })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

app.listen(PORT, HOST, () => {
  schedule();
  queueGeoBackfill();
  console.log(`591 追蹤已啟動：http://${HOST}:${PORT}`);
  if (!authConfigured()) {
    console.warn("尚未設定 AUTH_EMAIL / AUTH_PASSWORD，網站會要求登入但無法登入。請寫入 .env 或 data/auth.env。");
  } else {
    console.log(`登入帳號：${adminEmail()}`);
  }
  tick("startup").catch((error) => {
    console.warn("第一次檢查失敗：", error.message);
  });
});
