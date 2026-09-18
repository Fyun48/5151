/**
 * PR D responsive evidence pass (Issue #325 PART N / PART R items 31-33).
 *
 * Drives the LOCAL evidence server (same code as the deployed master) with headless
 * Chrome over CDP. Captures 375 / 768 / 1440 screenshots plus layout diagnostics
 * (horizontal overflow, undersized touch targets, aria names, focus ring).
 *
 * Run: node v3/evidence/pr-d-20260918/capture-responsive.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

const BASE = process.env.EVIDENCE_BASE_URL || "http://127.0.0.1:5199";
const WIDTHS = [375, 768, 1440];
const VIEWPORT_HEIGHT = 1400;

// Seeded ids/tokens come from the gitignored tokens.json written by seed-local.mjs.
let tokens = { listing_id: "2100000001", wish_token: "", completed_wish_token: "" };
const tokensPath = path.join(HERE, "data", "tokens.json");
if (existsSync(tokensPath)) {
  try {
    tokens = { ...tokens, ...JSON.parse(readFileSync(tokensPath, "utf8")) };
  } catch { /* keep the defaults above */ }
}
const WISH_TOKEN = process.env.EVIDENCE_WISH_TOKEN || tokens.wish_token;
const SURVEY_TOKEN = process.env.EVIDENCE_SURVEY_TOKEN || tokens.completed_wish_token || tokens.wish_token;
const LISTING_ID = process.env.EVIDENCE_LISTING_ID || String(tokens.listing_id);

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no Chrome/Edge binary found");
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return new Cdp(ws);
}

const DIAGNOSTICS = `(() => {
  const vw = window.innerWidth;
  const doc = document.documentElement;
  const overflowPx = Math.max(0, doc.scrollWidth - doc.clientWidth);
  const wide = [];
  for (const el of document.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.position === "fixed" && rect.right > vw + 1) continue;
    if (rect.right > vw + 1) {
      wide.push({ tag: el.tagName.toLowerCase(), id: el.id || "", cls: String(el.className || "").slice(0, 60), right: Math.round(rect.right) });
      if (wide.length >= 8) break;
    }
  }
  const small = [];
  // A checkbox/radio is a 24px box whose 44px target is the wrapping label, so the label
  // is measured as the control (documented in README.md) and the box is not counted twice.
  const controlSelector = "a,button,select,textarea,[role=button],[role=tab],input:not([type=checkbox]):not([type=radio]),label:has(> input[type=checkbox]),label:has(> input[type=radio])";
  for (const el of document.querySelectorAll(controlSelector)) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.height < 44 || rect.width < 24) {
      small.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        cls: String(el.className || "").slice(0, 60),
        text: String(el.textContent || el.value || "").trim().slice(0, 24),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
      if (small.length >= 14) break;
    }
  }
  const unnamed = [];
  for (const el of document.querySelectorAll("button,[role=button]")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const name = String(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
    if (!name) {
      unnamed.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 60) });
      if (unnamed.length >= 8) break;
    }
  }
  const tables = [...document.querySelectorAll("table")].map((t) => ({ w: Math.round(t.getBoundingClientRect().width), overflows: t.scrollWidth > t.clientWidth + 1 }));
  const charts = [...document.querySelectorAll("canvas,svg")].slice(0, 6).map((c) => ({ tag: c.tagName.toLowerCase(), w: Math.round(c.getBoundingClientRect().width) }));
  return {
    url: location.pathname + location.search,
    title: document.title,
    viewport: vw,
    overflowPx,
    widest_element: wide[0] || null,
    wide_elements: wide,
    small_touch_targets: small,
    unnamed_controls: unnamed,
    tables,
    charts,
    body_height: doc.scrollHeight,
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tokens/refs are redacted in the written evidence so no random-looking identifier is
// stored in the repository.
const redactToken = (text) => String(text)
  .replace(/\/w\/[A-Za-z0-9_-]{12,}/g, "/w/<token>")
  .replace(/self=\d+/g, "self=<post_id>")
  .replace(/[A-Za-z0-9_-]{24,}/g, "<redacted-token>");

const { issueCaptcha } = await import("../../src/captcha.js");
const sessionCache = new Map();

// Local evidence credentials: generated per run by seed-local.mjs into a gitignored file.
const credsPath = path.join(HERE, "data", "credentials.json");
let creds = { owner: "owner@evidence.test", tenant: "tenant@evidence.test", password: process.env.EVIDENCE_PASSWORD || "" };
if (existsSync(credsPath)) {
  try {
    creds = { ...creds, ...JSON.parse(readFileSync(credsPath, "utf8")) };
  } catch { /* keep the defaults above */ }
}

function credsFor(role) {
  return { email: creds[role] || creds.owner, password: creds.password };
}

/**
 * Logs in through the real /api/login endpoint. The captcha is minted in-process
 * with the same SESSION_SECRET the local evidence server runs with, so the
 * anti-bot path stays intact instead of being bypassed.
 */
async function sessionFor(role) {
  const { email, password } = credsFor(role);
  if (sessionCache.has(email)) return sessionCache.get(email);
  const captcha = issueCaptcha({ code: "AEV1" });
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, captchaId: captcha.id, captchaAnswer: "AEV1" }),
  });
  const body = await res.json().catch(() => ({}));
  const raw = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")]).filter(Boolean)[0] || "";
  const pair = raw.split(";")[0];
  const index = pair.indexOf("=");
  const result = {
    status: res.status,
    ok: body.ok === true,
    role: body.role || null,
    cookie: index > 0 ? { name: pair.slice(0, index), value: pair.slice(index + 1) } : null,
  };
  sessionCache.set(email, result);
  return result;
}

async function capture(cdp, { name, url, width, login, loginByWidth, steps = [] }) {
  const role = (loginByWidth && loginByWidth[width]) || login;
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: VIEWPORT_HEIGHT,
    deviceScaleFactor: 1,
    mobile: width < 700,
  });
  let loginResult = null;
  if (role) {
    const session = await sessionFor(role);
    loginResult = { status: session.status, ok: session.ok, role: session.role, cookie: session.cookie ? session.cookie.name : null };
    if (session.cookie) {
      await cdp.send("Network.setCookie", {
        name: session.cookie.name,
        value: session.cookie.value,
        url: `${BASE}/`,
        httpOnly: true,
      });
    }
  }
  await cdp.send("Page.navigate", { url });
  await sleep(2600);

  const stepResults = [];
  for (const step of steps) {
    let clicked = null;
    if (step.select) {
      clicked = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(step.select)});
          if (!el) return { found: false };
          el.click();
          return { found: true, id: el.id || "", cls: String(el.className || "").slice(0, 40) };
        })()`,
        returnByValue: true,
      });
    } else if (step.js) {
      clicked = await cdp.send("Runtime.evaluate", { expression: step.js, returnByValue: true });
    }
    await sleep(step.wait || 900);
    let expectation = null;
    if (step.expect) {
      const probe = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(step.expect)});
          if (!el) return { found: false, visible: false };
          const rect = el.getBoundingClientRect();
          return { found: true, visible: rect.width > 0 && rect.height > 0, w: Math.round(rect.width), h: Math.round(rect.height) };
        })()`,
        returnByValue: true,
      });
      expectation = probe.result.value;
    }
    stepResults.push({
      step: step.label || step.select || "js",
      result: clicked && clicked.result ? clicked.result.value : null,
      expect: expectation,
    });
  }

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(SHOTS, `${name}-${width}.png`), Buffer.from(shot.data, "base64"));
  const diag = await cdp.send("Runtime.evaluate", { expression: DIAGNOSTICS, returnByValue: true });
  const diagnostics = diag.result.value || {};
  if (diagnostics.url) diagnostics.url = redactToken(diagnostics.url);
  if (diagnostics.title) diagnostics.title = redactToken(diagnostics.title);
  return { name, width, login: loginResult, steps: stepResults, diagnostics };
}

const TARGETS = [
  {
    name: "public-share-cta",
    url: `${BASE}/w/${WISH_TOKEN}`,
    label: "public share page v2 CTA as an anonymous visitor",
  },
  {
    name: "tenant-notify-prefs",
    url: `${BASE}/`,
    login: "tenant",
    steps: [
      { label: "open the notify view", select: '[data-nav="notify"]', wait: 1400, expect: "#notifyHub" },
      { label: "select the 租屋通知 pane", select: '[data-hub-tab="rental"]', wait: 1000, expect: "#rentalNotifyPrefs" },
    ],
  },
  { name: "tenant-wish-room", url: `${BASE}/w/${WISH_TOKEN}`, login: "tenant" },
  {
    name: "tenant-wish-lifecycle",
    url: `${BASE}/#wish`,
    login: "tenant",
    steps: [
      { label: "open the tenant wish view (lifecycle controls)", select: '[data-nav="demand"]', wait: 1600, expect: "#wishLifecycleBar" },
    ],
  },
  {
    name: "tenant-survey",
    url: `${BASE}/#wish`,
    login: "tenant",
    // Each width completes a different seeded tenant's wish, so the flow stays deterministic.
    loginByWidth: { 375: "tenant", 768: "tenant2", 1440: "tenant3" },
    steps: [
      { label: "completion-survey entry 已找到房", select: "#wishCompleteBtn", wait: 3000, expect: "#wishSurveyOverlay" },
    ],
  },
  {
    name: "owner-match-subscription",
    url: `${BASE}/`,
    login: "owner",
    steps: [
      { label: "open the owner listings view", select: '[data-nav="post"]', wait: 2000, expect: "[data-self-matches]" },
      { label: "open the match overlay (new-match subscription controls)", select: "[data-self-matches]", wait: 3200, expect: "#matchSubBar" },
    ],
  },
  {
    name: "admin-rental-ops",
    url: `${BASE}/admin.html#rental/ops`,
    login: "owner",
    steps: [
      { label: "load the rental operations analytics panel", select: "#rentalOpsLoad", wait: 2400, expect: "#rentalOpsSummary" },
    ],
  },
];

async function main() {
  const browser = findBrowser();
  const profile = path.join(os.tmpdir(), `prd-evidence-${Date.now()}`);
  const child = spawn(browser, [
    "--headless=new",
    "--remote-debugging-port=9222",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1440,1400",
    "about:blank",
  ], { stdio: "ignore" });

  const versionUrl = "http://127.0.0.1:9222/json/version";
  if (!(await waitFor(versionUrl))) throw new Error("browser debug endpoint did not start");
  const listUrl = "http://127.0.0.1:9222/json/list";
  if (!(await waitFor(listUrl))) throw new Error("no page target list");
  const targets = await (await fetch(listUrl)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target to attach to");
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

  const results = [];
  const only = process.env.EVIDENCE_ONLY ? process.env.EVIDENCE_ONLY.split(",") : null;
  const widths = process.env.EVIDENCE_WIDTHS ? process.env.EVIDENCE_WIDTHS.split(",").map(Number) : WIDTHS;
  for (const width of widths) {
    for (const target of TARGETS) {
      if (only && !only.includes(target.name)) continue;
      results.push(await capture(cdp, { ...target, width }));
    }
  }

  const report = {
    schema: "pr-d-responsive-evidence-v1",
    generated_at: new Date().toISOString(),
    issue: "#325 PART N / PART R items 31-33",
    target: {
      base_url: BASE,
      source: "local evidence server running the deployed master code (same app as Production)",
      widths: WIDTHS,
      viewport_height: VIEWPORT_HEIGHT,
      browser: path.basename(browser),
    },
    results,
  };
  writeFileSync(path.join(HERE, "responsive.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(results.map((r) => ({
    page: r.name,
    width: r.width,
    url: r.diagnostics ? r.diagnostics.url : null,
    overflow_px: r.diagnostics ? r.diagnostics.overflowPx : null,
    small_targets: r.diagnostics ? r.diagnostics.small_touch_targets.length : null,
    unnamed_controls: r.diagnostics ? r.diagnostics.unnamed_controls.length : null,
    steps: (r.steps || []).map((s) => ({ step: s.step, ok: s.result ? s.result.found : null, expect: s.expect })),
  })), null, 2));

  child.kill();
}

main().catch((error) => {
  console.error("capture failed:", error.message);
  process.exitCode = 1;
});

