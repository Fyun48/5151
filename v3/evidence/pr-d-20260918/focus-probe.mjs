/**
 * Keyboard focus probe for the PR D responsive pass (Issue #325 PART N).
 *
 * For every PR D acceptance surface at 375 / 768 / 1440 it walks the complete visible
 * tabbable sequence with real Tab key events (cycling until the first stop repeats or
 * EVIDENCE_MAX_STOPS is reached) and records, per stop, whether the element matches
 * :focus-visible, the visible focus indicator (outline or box-shadow) and the
 * accessible name. A stop without a visible indicator or without an accessible name
 * fails the run.
 *
 * Run: node v3/evidence/pr-d-20260918/focus-probe.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.EVIDENCE_BASE_URL || "http://127.0.0.1:5199";
const WIDTHS = (process.env.EVIDENCE_WIDTHS || "375,768,1440").split(",").map(Number);
const MAX_STOPS = Number(process.env.EVIDENCE_MAX_STOPS || 140);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tokens = { listing_id: "2100000001", wish_token: "" };
const tokensPath = path.join(HERE, "data", "tokens.json");
if (existsSync(tokensPath)) {
  try { tokens = { ...tokens, ...JSON.parse(readFileSync(tokensPath, "utf8")) }; } catch { /* defaults */ }
}
const WISH_TOKEN = process.env.EVIDENCE_WISH_TOKEN || tokens.wish_token;

let creds = { owner: "owner@evidence.test", tenant: "tenant@evidence.test", password: process.env.EVIDENCE_PASSWORD || "" };
const credsPath = path.join(HERE, "data", "credentials.json");
if (existsSync(credsPath)) {
  try { creds = { ...creds, ...JSON.parse(readFileSync(credsPath, "utf8")) }; } catch { /* defaults */ }
}

const { issueCaptcha } = await import("../../src/captcha.js");
const sessionCache = new Map();

/** Logs in through the real /api/login endpoint (captcha minted in-process, no bypass). */
async function sessionFor(role) {
  const email = creds[role] || creds.owner;
  if (sessionCache.has(email)) return sessionCache.get(email);
  const captcha = issueCaptcha({ code: "AEV1" });
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: creds.password, captchaId: captcha.id, captchaAnswer: "AEV1" }),
  });
  const body = await res.json().catch(() => ({}));
  const raw = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")]).filter(Boolean)[0] || "";
  const pair = raw.split(";")[0];
  const idx = pair.indexOf("=");
  const result = { ok: body.ok === true, cookie: idx > 0 ? { name: pair.slice(0, idx), value: pair.slice(idx + 1) } : null };
  sessionCache.set(email, result);
  return result;
}

const TARGETS = [
  { name: "public-share-cta", url: `${BASE}/w/${WISH_TOKEN}` },
  {
    name: "tenant-notify-prefs",
    url: `${BASE}/`,
    login: "tenant",
    steps: [{ select: '[data-nav="notify"]', wait: 1400 }, { select: '[data-hub-tab="rental"]', wait: 1000 }],
  },
  { name: "tenant-wish-room", url: `${BASE}/w/${WISH_TOKEN}`, login: "tenant" },
  {
    name: "tenant-wish-lifecycle",
    url: `${BASE}/#wish`,
    login: "tenant",
    steps: [{ select: '[data-nav="demand"]', wait: 1600 }],
  },
  {
    name: "tenant-survey",
    url: `${BASE}/#wish`,
    // Each width completes a different seeded tenant's wish, so the flow stays deterministic.
    loginByWidth: { 375: "tenant", 768: "tenant2", 1440: "tenant3" },
    steps: [{ select: "#wishCompleteBtn", wait: 3000 }],
  },
  {
    name: "owner-match-subscription",
    url: `${BASE}/`,
    login: "owner",
    steps: [{ select: '[data-nav="post"]', wait: 2000 }, { select: "[data-self-matches]", wait: 3200 }],
  },
  {
    name: "admin-rental-ops",
    url: `${BASE}/admin.html#rental/ops`,
    login: "owner",
    steps: [{ select: "#rentalOpsLoad", wait: 2400 }],
  },
];

const PROBE = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { stop: false };
  const style = getComputedStyle(el);
  const text = (node) => (node ? String(node.textContent || "").trim() : "");
  let name = "";
  let source = "none";
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    name = labelledBy.split(/\\s+/).map((id) => text(document.getElementById(id))).join(" ").trim();
    if (name) source = "aria-labelledby";
  }
  if (!name && el.getAttribute("aria-label")) { name = el.getAttribute("aria-label").trim(); source = "aria-label"; }
  if (!name && el.labels && el.labels.length) { name = [...el.labels].map(text).join(" ").trim(); source = "label"; }
  if (!name && el.getAttribute("title")) { name = el.getAttribute("title").trim(); source = "title"; }
  if (!name) { name = text(el); if (name) source = "text"; }
  if (!name && el.getAttribute("placeholder")) { name = el.getAttribute("placeholder").trim(); source = "placeholder"; }
  const rect = el.getBoundingClientRect();
  const outlineVisible = style.outlineStyle !== "none" && style.outlineWidth !== "0px";
  const shadowVisible = style.boxShadow !== "none";
  return {
    stop: true,
    element: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.split(" ")[0] : ""),
    text: name.slice(0, 24),
    name_source: source,
    focus_visible: el.matches(":focus-visible"),
    outline: style.outlineStyle + " " + style.outlineWidth + " " + style.outlineColor,
    box_shadow: shadowVisible ? style.boxShadow.slice(0, 48) : "none",
    has_visible_indicator: outlineVisible || shadowVisible,
    accessible_name: name.length > 0,
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
})()`;

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg.result);
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
      }, 20000);
    });
  }
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up */ }
    await sleep(400);
  }
  return false;
}

async function pressTab(cdp) {
  const key = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await sleep(180);
}

/** Per-surface summary over the distinct tab stops (a date input reports one stop per segment). */
function summarise(sequence) {
  const distinct = [];
  const seen = new Set();
  for (const row of sequence) {
    if (!row.stop || seen.has(row.element)) continue;
    seen.add(row.element);
    distinct.push(row);
  }
  const bad = distinct.filter((row) => !row.has_visible_indicator || !row.accessible_name || !row.focus_visible);
  return {
    stops: distinct.length,
    raw_key_events: sequence.length,
    with_visible_indicator: distinct.filter((row) => row.has_visible_indicator).length,
    focus_visible: distinct.filter((row) => row.focus_visible).length,
    named: distinct.filter((row) => row.accessible_name).length,
    name_sources: distinct.reduce((acc, row) => {
      acc[row.name_source] = (acc[row.name_source] || 0) + 1;
      return acc;
    }, {}),
    failures: bad.map((row) => `${row.element} (${row.text || "no name"})`),
  };
}

async function main() {
  const browser = existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe")
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const profile = path.join(os.tmpdir(), `prd-focus-${Date.now()}`);
  const child = spawn(browser, ["--headless=new", "--remote-debugging-port=9223", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
  if (!(await waitFor("http://127.0.0.1:9223/json/list"))) throw new Error("browser did not start");
  const targets = await (await fetch("http://127.0.0.1:9223/json/list")).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

  const rows = [];
  const only = process.env.EVIDENCE_ONLY ? process.env.EVIDENCE_ONLY.split(",") : null;
  for (const target of TARGETS) {
    if (only && !only.includes(target.name)) continue;
    for (const width of WIDTHS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 1100, deviceScaleFactor: 1, mobile: width < 700 });
      const role = (target.loginByWidth && target.loginByWidth[width]) || target.login;
      let loggedIn = null;
      if (role) {
        const session = await sessionFor(role);
        loggedIn = session.ok === true;
        if (session.cookie) await cdp.send("Network.setCookie", { ...session.cookie, url: `${BASE}/`, httpOnly: true });
      }
      await cdp.send("Page.navigate", { url: target.url });
      await sleep(2600);
      for (const step of target.steps || []) {
        await cdp.send("Runtime.evaluate", {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(step.select)}); if (!el) return false; el.click(); return true; })()`,
          returnByValue: true,
        });
        await sleep(step.wait || 1000);
      }
      await cdp.send("Runtime.evaluate", { expression: "(() => { document.activeElement && document.activeElement.blur(); return true; })()", returnByValue: true });

      if (process.env.EVIDENCE_JS) {
        const debug = await cdp.send("Runtime.evaluate", { expression: process.env.EVIDENCE_JS, returnByValue: true });
        console.log(`${target.name} @${width} debug: ${JSON.stringify(debug.result ? debug.result.value : debug)}`);
      }

      const sequence = [];
      let first = null;
      let blanks = 0;
      for (let i = 0; i < MAX_STOPS; i += 1) {
        await pressTab(cdp);
        const probe = await cdp.send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
        const row = probe.result.value || { stop: false };
        if (!row.stop) {
          blanks += 1;
          if (blanks > 3) break;
          continue;
        }
        blanks = 0;
        if (!first) first = row.element;
        else if (row.element === first) break; // full cycle: focus wrapped back to the first stop
        sequence.push(row);
      }
      rows.push({ page: target.name, width, logged_in: loggedIn, summary: summarise(sequence), sequence });
    }
  }
  // Runs can be split per width; keep rows from earlier runs for widths not covered here.
  const outPath = path.join(HERE, "focus.json");
  let previous = [];
  if (existsSync(outPath)) {
    try {
      previous = (JSON.parse(readFileSync(outPath, "utf8")).rows || []).filter((row) => !WIDTHS.includes(row.width));
    } catch { previous = []; }
  }
  const allRows = [...previous, ...rows].sort((a, b) => a.width - b.width || a.page.localeCompare(b.page));
  const focusDoc = JSON.stringify({
    schema: "pr-d-focus-probe-v2",
    generated_at: new Date().toISOString(),
    issue: "#325 PART N / PART R items 31-33",
    method: "real Tab key events on each PR D surface; the walk ends when focus wraps to the first stop",
    widths: [...new Set(allRows.map((row) => row.width))].sort((a, b) => a - b),
    rows: allRows,
  }, null, 2);
  writeFileSync(outPath, focusDoc + String.fromCharCode(10));
  console.log(JSON.stringify(rows.map((r) => ({ page: r.page, width: r.width, ...r.summary })), null, 2));
  const failed = rows.filter((r) => r.summary.failures.length > 0 || r.summary.stops === 0);
  child.kill();
  if (failed.length) {
    console.error(`focus probe: ${failed.length} surface(s) failed`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("focus probe failed:", error.message);
  process.exitCode = 1;
});
