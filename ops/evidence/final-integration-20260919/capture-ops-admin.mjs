/**
 * OPS final-integration responsive + focus evidence (PR #369).
 * Drives a LOCAL v3 server with headless Chrome over CDP. Captures the three OPS admin
 * surfaces (CRM, similarity/pHash, feedback inbox/outbox) at 375 / 768 / 1440.
 * Run: EVIDENCE_BASE_URL=http://127.0.0.1:5199 AUTH_EMAIL=... AUTH_PASSWORD=... SESSION_SECRET=... node ops/evidence/final-integration-20260919/capture-ops-admin.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.EVIDENCE_BASE_URL || "http://127.0.0.1:5199";
const WIDTHS = (process.env.EVIDENCE_WIDTHS || "375,768,1440").split(",").map(Number);
const EMAIL = process.env.AUTH_EMAIL || "owner@evidence.test";
const PASSWORD = process.env.AUTH_PASSWORD || "";

const { issueCaptcha } = await import("../../../v3/src/captcha.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login() {
  const captcha = issueCaptcha({ code: "AEV1" });
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, captchaId: captcha.id, captchaAnswer: "AEV1" }),
  });
  const body = await res.json().catch(() => ({}));
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
  const pair = (setCookies[0] || "").split(";")[0];
  const idx = pair.indexOf("=");
  return { ok: body.ok === true, cookie: idx > 0 ? { name: pair.slice(0, idx), value: pair.slice(idx + 1) } : null };
}

function findBrowser() {
  for (const c of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]) {
    if (existsSync(c)) return c;
  }
  throw new Error("no Chrome/Edge binary found");
}
async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }); }
  send(method, params = {}) { this.id += 1; const id = this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30000); }); }
}
async function connect(wsUrl) { const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); }); return new Cdp(ws); }

const DIAGNOSTICS = `(() => {
  const vw = document.documentElement.clientWidth;
  const overflowPx = Math.max(0, document.documentElement.scrollWidth - vw);
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const nameOf = (el) => {
    const direct = (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim();
    if (direct) return direct;
    if (el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l) return (l.textContent || "").trim(); }
    const wrap = el.closest("label"); if (wrap) return (wrap.textContent || "").trim();
    return (el.textContent || "").trim();
  };
  const isCheck = (el) => el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
  const controls = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="tab"], [role="link"]')].filter(visible);
  const small = controls.filter((el) => { const node = isCheck(el) && el.closest("label") ? el.closest("label") : el; const r = node.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map((el) => { const node = isCheck(el) && el.closest("label") ? el.closest("label") : el; const r = node.getBoundingClientRect(); return { tag: el.tagName, id: el.id, w: Math.round(r.width), h: Math.round(r.height) }; });
  const unnamed = controls.filter((el) => el.tagName !== "A" && !nameOf(el)).map((el) => ({ tag: el.tagName, id: el.id }));
  const focused = document.activeElement && document.activeElement !== document.body;
  const cs = focused ? getComputedStyle(document.activeElement) : null;
  const focusRing = cs ? cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor : "";
  return { url: location.href, hash: location.hash, vw, overflowPx, small_touch_targets: small, unnamed_controls: unnamed, focus_ring: focusRing };
})()`;

const PROBE = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { stop: false };
  const nameOf = (n) => {
    const direct = (n.getAttribute("aria-label") || n.getAttribute("aria-labelledby") || n.getAttribute("title") || n.getAttribute("placeholder") || "").trim();
    if (direct) return direct;
    if (n.id) { const l = document.querySelector('label[for="' + n.id + '"]'); if (l) return (l.textContent || "").trim(); }
    const wrap = n.closest("label"); if (wrap) return (wrap.textContent || "").trim();
    return (n.textContent || "").trim();
  };
  const cs = getComputedStyle(el);
  const ring = cs.outlineStyle !== "none" && (cs.outlineWidth !== "0px" || cs.boxShadow !== "none");
  return { stop: true, tag: el.tagName, id: el.id, name: nameOf(el), ring, visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 };
})()`;

async function pressTab(cdp) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
}

const SURFACES = [
  { name: "admin-crm", hash: "#crm", expect: "crmContactForm" },
  { name: "admin-similarity", hash: "#similarity", expect: "phashForm" },
  { name: "admin-feedback-inbox", hash: "#feedback/inbox", expect: "opsOutboxCompact" },
];

async function main() {
  const browser = findBrowser();
  const profile = path.join(os.tmpdir(), `ops-evidence-${Date.now()}`);
  const child = spawn(browser, ["--headless=new", "--remote-debugging-port=9222", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1400", "about:blank"], { stdio: "ignore" });
  if (!(await waitFor("http://127.0.0.1:9222/json/version"))) throw new Error("browser debug endpoint did not start");
  const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = targets.find((t) => t.type === "page");
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable");

  const session = await login();
  const results = [];
  for (const width of WIDTHS) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 1200, deviceScaleFactor: 1, mobile: width < 700 });
    if (session.cookie) await cdp.send("Network.setCookie", { ...session.cookie, url: `${BASE}/`, httpOnly: true });
    for (const surface of SURFACES) {
      await cdp.send("Page.navigate", { url: `${BASE}/admin.html${surface.hash}` });
      await sleep(2800);
      const diag = await cdp.send("Runtime.evaluate", { expression: DIAGNOSTICS, returnByValue: true });
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(SHOTS, `${surface.name}-${width}.png`), Buffer.from(shot.data, "base64"));
      const stops = [];
      let first = null; let blanks = 0;
      for (let i = 0; i < 120; i++) {
        await pressTab(cdp);
        const probe = await cdp.send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
        const row = (probe.result && probe.result.value) || { stop: false };
        if (!row.stop) { blanks += 1; if (blanks > 4) break; continue; }
        blanks = 0;
        if (!first) first = row.id || row.tag;
        else if ((row.id || row.tag) === first) break;
        stops.push(row);
      }
      const failures = stops.filter((s) => !s.ring || !s.name || !s.visible);
      const d = diag.result.value || {};
      results.push({ name: surface.name, width, logged_in: session.ok, url: d.url, hash: d.hash, overflow_px: d.overflowPx, small_touch_targets: d.small_touch_targets, unnamed_controls: d.unnamed_controls, focus_stops: stops.length, focus_failures: failures });
      console.log(JSON.stringify({ surface: surface.name, width, logged_in: session.ok, overflow_px: d.overflowPx, small_targets: (d.small_touch_targets || []).length, unnamed: (d.unnamed_controls || []).length, focus_stops: stops.length, focus_failures: failures.length }));
    }
  }

  const report = {
    schema: "ops-final-integration-responsive-v1",
    generated_at: new Date().toISOString(),
    pr: "#369",
    target: { base_url: BASE, source: "local v3 server running the integrated code (same as deployed)", widths: WIDTHS, browser: path.basename(browser) },
    surfaces: SURFACES.map((s) => s.name),
    results,
  };
  writeFileSync(path.join(HERE, "ops-responsive.json"), `${JSON.stringify(report, null, 2)}\n`);
  const bad = results.filter((r) => !r.logged_in || r.overflow_px > 0 || (r.small_touch_targets || []).length > 0 || (r.unnamed_controls || []).length > 0 || r.focus_failures.length > 0);
  child.kill();
  if (bad.length) { console.error(`ops responsive/focus: ${bad.length} surface-width observation(s) failed`); process.exitCode = 1; }
}

main().catch((e) => { console.error("capture failed:", e.message); process.exitCode = 1; });

