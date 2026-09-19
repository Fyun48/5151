/**
 * OPS Console responsive + focus evidence (PR #369 BLOCKER 6).
 * Drives a LOCAL ops server (ops/src/server.js) with headless Chrome over CDP.
 * Captures the OPS Console at 375 / 768 / 1440 with overflow / touch / a11y diagnostics.
 * Run: OPS_BASE=http://127.0.0.1:5154 AUTH_EMAIL=... AUTH_PASSWORD=... node ops/evidence/final-integration-20260919/capture-ops-console.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.OPS_BASE || "http://127.0.0.1:5154";
const WIDTHS = (process.env.EVIDENCE_WIDTHS || "375,768,1440").split(",").map(Number);
const EMAIL = process.env.AUTH_EMAIL || "owner@evidence.test";
const PASSWORD = process.env.AUTH_PASSWORD || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function login() {
  const res = await fetch(`${BASE}/ops/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const body = await res.json().catch(() => ({}));
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
  const pair = (setCookies[0] || "").split(";")[0];
  const idx = pair.indexOf("=");
  return { ok: body.ok === true, cookie: idx > 0 ? { name: pair.slice(0, idx), value: pair.slice(idx + 1) } : null };
}
function findBrowser() {
  for (const c of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]) if (existsSync(c)) return c;
  throw new Error("no Chrome/Edge binary found");
}
async function waitFor(url, tries = 60) { for (let i = 0; i < tries; i++) { try { if ((await fetch(url)).ok) return true; } catch {} await sleep(500); } return false; }
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }); }
  send(method, params = {}) { this.id += 1; const id = this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 30000); }); }
}
async function connect(wsUrl) { const ws = new WebSocket(wsUrl); await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); }); return new Cdp(ws); }

const DIAGNOSTICS = `(() => {
  const vw = document.documentElement.clientWidth;
  const overflowPx = Math.max(0, document.documentElement.scrollWidth - vw);
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
  const nameOf = (el) => { const d = (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim(); if (d) return d; if (el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l) return (l.textContent || "").trim(); } const w = el.closest("label"); if (w) return (w.textContent || "").trim(); return (el.textContent || "").trim(); };
  const isCheck = (el) => el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
  const controls = [...document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="tab"]')].filter(visible);
  const small = controls.filter((el) => { const n = isCheck(el) && el.closest("label") ? el.closest("label") : el; const r = n.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map((el) => ({ tag: el.tagName, id: el.id }));
  const unnamed = controls.filter((el) => el.tagName !== "A" && !nameOf(el)).map((el) => ({ tag: el.tagName, id: el.id }));
  const loginCard = document.querySelector("#loginCard");
  return { url: location.href, vw, overflowPx, small_touch_targets: small, unnamed_controls: unnamed, login_visible: !!loginCard && !loginCard.hidden };
})()`;

async function main() {
  const browser = findBrowser();
  const profile = path.join(os.tmpdir(), `ops-console-${Date.now()}`);
  const child = spawn(browser, ["--headless=new", "--remote-debugging-port=9223", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1400", "about:blank"], { stdio: "ignore" });
  if (!(await waitFor("http://127.0.0.1:9223/json/version"))) throw new Error("browser debug endpoint did not start");
  const targets = await (await fetch("http://127.0.0.1:9223/json/list")).json();
  const cdp = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable");

  const session = await login();
  const results = [];
  for (const width of WIDTHS) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 1200, deviceScaleFactor: 1, mobile: width < 700 });
    if (session.cookie) await cdp.send("Network.setCookie", { ...session.cookie, url: `${BASE}/`, httpOnly: true });
    await cdp.send("Page.navigate", { url: `${BASE}/` });
    await sleep(3000);
    const diag = await cdp.send("Runtime.evaluate", { expression: DIAGNOSTICS, returnByValue: true });
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOTS, `ops-console-${width}.png`), Buffer.from(shot.data, "base64"));
    const d = diag.result.value || {};
    results.push({ name: "ops-console", width, logged_in: session.ok, url: d.url, overflow_px: d.overflowPx, small_touch_targets: d.small_touch_targets, unnamed_controls: d.unnamed_controls, login_visible: d.login_visible });
    console.log(JSON.stringify({ surface: "ops-console", width, logged_in: session.ok, overflow_px: d.overflowPx, small_targets: (d.small_touch_targets || []).length, unnamed: (d.unnamed_controls || []).length, login_visible: d.login_visible }));
  }
  const report = { schema: "ops-console-responsive-v1", generated_at: new Date().toISOString(), pr: "#369", target: { base_url: BASE, source: "local ops server", widths: WIDTHS, browser: path.basename(browser) }, results };
  writeFileSync(path.join(HERE, "ops-console-responsive.json"), `${JSON.stringify(report, null, 2)}\n`);
  const bad = results.filter((r) => !r.logged_in || r.overflow_px > 0 || (r.small_touch_targets || []).length > 0 || (r.unnamed_controls || []).length > 0);
  child.kill();
  if (bad.length) { console.error(`ops console: ${bad.length} width observation(s) failed`); process.exitCode = 1; }
}
main().catch((e) => { console.error("capture failed:", e.message); process.exitCode = 1; });

