import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getListing,
  getSettings,
  listListings,
  recentEvents,
  saveSettings,
  setFlags,
  sourceHistory,
  stats,
} from "./db.js";
import { parseSearchUrl } from "./client591.js";
import { runWatch } from "./watcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 5151);
const HOST = process.env.HOST || "0.0.0.0";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "../public")));

let timer = null;
let lastRun = null;
const clients = new Set();

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

async function tick(reason = "schedule") {
  try {
    lastRun = await runWatch();
    lastRun.reason = reason;
    broadcast({ type: "watch", result: lastRun, stats: stats() });
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
    listings: listListings({ filter: "all", sort: "price_asc", limit: 80 }),
    events: recentEvents(30),
  });
});

app.get("/api/listings", (req, res) => {
  res.json({
    stats: stats(),
    listings: listListings({
      filter: req.query.filter || "all",
      q: req.query.q || "",
      sort: req.query.sort || "price_asc",
      limit: Number(req.query.limit) || 80,
    }),
  });
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

app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  if (Array.isArray(body.searchUrls)) {
    for (const url of body.searchUrls) {
      if (String(url).trim()) parseSearchUrl(url);
    }
  }
  const settings = saveSettings(body);
  schedule();
  res.json({ settings });
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
  console.log(`591 追蹤已啟動：http://${HOST}:${PORT}`);
  tick("startup").catch((error) => {
    console.warn("第一次檢查失敗：", error.message);
  });
});
