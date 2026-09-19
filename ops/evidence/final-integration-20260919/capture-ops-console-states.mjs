/**
 * OPS Console state-rendering evidence (PR #369 BLOCKER E).
 * Injects a deterministic fetch fixture and renders all 9 console states, then asserts each
 * rendered marker. 375 / 768 / 1440 responsive coverage is preserved.
 * Run: OPS_BASE=http://127.0.0.1:5154 AUTH_EMAIL=... AUTH_PASSWORD=... node ops/evidence/final-integration-20260919/capture-ops-console-states.mjs
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

const CAPS = { feedback_copy: true, crm_sync: false, remote_cs: false, cross_site_insight: false, stats: false, followup_service: false, retain_after_exit: false };
const FIXTURE_OVERRIDE = `(() => {
  const CAPS = ${JSON.stringify(CAPS)};
  const product = (status) => ({ items: [{ id: "v3", display_name: "吉比租房", status, subscription: { generation: 1, status, capabilities: CAPS }, environments: [], consent_events: [] }] });
  const STATES = {
    loading: () => new Promise(() => {}),
    empty: () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }),
    normal: () => ({ ok: true, status: 200, json: async () => product("connected") }),
    error: () => ({ ok: false, status: 500, json: async () => ({ error: "無法讀取產品" }) }),
    retry: () => ({ ok: true, status: 200, json: async () => product("failed_retry") }),
    blocked: () => ({ ok: true, status: 200, json: async () => product("blocked") }),
    cancelled: () => ({ ok: true, status: 200, json: async () => product("cancelled") }),
    unknown: () => ({ ok: true, status: 200, json: async () => product("unknown") }),
    completed: () => ({ ok: true, status: 200, json: async () => product("completed") }),
  };
  const orig = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    const s = String(url || "");
    if (s.includes("/ops/api/products")) {
      const state = (location.hash.match(/state=(\\w+)/) || [])[1] || "normal";
      return STATES[state] ? STATES[state]() : STATES.normal();
    }
    return orig(url, opts);
  };
})()`;

const STATES = [
  { name: "loading", marker: "載入中" },
  { name: "empty", marker: "尚無產品卡" },
  { name: "normal", marker: "已連接" },
  { name: "error", marker: "無法讀取產品" },
  { name: "retry", marker: "失敗可重試" },
  { name: "blocked", marker: "已封鎖" },
  { name: "cancelled", marker: "已取消" },
  { name: "unknown", marker: "狀態不明" },
  { name: "completed", marker: "已完成" },
];

async function main() {
  const browser = findBrowser();
  const profile = path.join(os.tmpdir(), `ops-states-${Date.now()}`);
  const child = spawn(browser, ["--headless=new", "--remote-debugging-port=9224", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1400", "about:blank"], { stdio: "ignore" });
  if (!(await waitFor("http://127.0.0.1:9224/json/version"))) throw new Error("browser debug endpoint did not start");
  const targets = await (await fetch("http://127.0.0.1:9224/json/list")).json();
  const cdp = await connect(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Network.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FIXTURE_OVERRIDE });

  const session = await login();
  const results = [];
  for (const width of WIDTHS) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 1200, deviceScaleFactor: 1, mobile: width < 700 });
    if (session.cookie) await cdp.send("Network.setCookie", { ...session.cookie, url: `${BASE}/`, httpOnly: true });
    for (const state of STATES) {
      await cdp.send("Page.navigate", { url: `${BASE}/#state=${state.name}` });
      await sleep(2200);
      // 切換到「產品」分頁（預設是總覽，產品卡在 hidden pane 內）。
      await cdp.send("Runtime.evaluate", { expression: `(() => { const b = document.querySelector('[data-tab="products"]'); if (b) b.click(); return true; })()`, returnByValue: true });
      await sleep(700);
      const text = await cdp.send("Runtime.evaluate", { expression: `(() => { const b = document.getElementById("productCards"); const m = document.getElementById("productMsg"); return (b ? b.innerText : "") + "\\n" + (m ? m.innerText : ""); })()`, returnByValue: true });
      const body = String(text.result && text.result.value ? text.result.value : "");
      const ok = body.includes(state.marker);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path.join(SHOTS, `ops-console-${state.name}-${width}.png`), Buffer.from(shot.data, "base64"));
      results.push({ state: state.name, width, ok, marker: state.marker, rendered: ok });
      console.log(JSON.stringify({ state: state.name, width, ok, marker: state.marker }));
    }
  }
  const report = { schema: "ops-console-states-v1", generated_at: new Date().toISOString(), pr: "#369", target: { base_url: BASE, widths: WIDTHS }, results };
  writeFileSync(path.join(HERE, "ops-console-states.json"), `${JSON.stringify(report, null, 2)}\n`);
  const bad = results.filter((r) => !r.ok);
  child.kill();
  if (bad.length) { console.error(`ops console states: ${bad.length} state-width observation(s) failed`); process.exitCode = 1; }
}
main().catch((e) => { console.error("capture failed:", e.message); process.exitCode = 1; });

