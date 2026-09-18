/**
 * Keyboard focus-visible probe for the PR D responsive pass (Issue #325 PART N).
 * Presses Tab with real key events and records whether the focused element gets a
 * visible indicator (:focus-visible + outline/box-shadow).
 *
 * Run: node v3/evidence/pr-d-20260918/focus-probe.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.EVIDENCE_BASE_URL || "http://127.0.0.1:5199";
const PAGES = [{ name: "public-home", url: `${BASE}/` }, { name: "admin-console", url: `${BASE}/admin.html` }];
const WIDTHS = [375, 1440];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const el = document.activeElement;
  if (!el) return { active: null };
  const style = getComputedStyle(el);
  return {
    active: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""),
    text: String(el.textContent || "").trim().slice(0, 24),
    focus_visible: el.matches(":focus-visible"),
    outline: style.outlineStyle + " " + style.outlineWidth + " " + style.outlineColor,
    box_shadow: style.boxShadow === "none" ? "none" : style.boxShadow.slice(0, 60),
    background: style.backgroundColor,
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

  const rows = [];
  for (const target of PAGES) {
    for (const width of WIDTHS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 700 });
      await cdp.send("Page.navigate", { url: target.url });
      await sleep(2000);
      const sequence = [];
      for (let i = 0; i < 4; i += 1) {
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await sleep(250);
        const probe = await cdp.send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
        sequence.push(probe.result.value);
      }
      rows.push({ page: target.name, width, sequence });
    }
  }
  writeFileSync(path.join(HERE, "focus.json"), `${JSON.stringify({ schema: "pr-d-focus-probe-v1", generated_at: new Date().toISOString(), rows }, null, 2)}\n`);
  console.log(JSON.stringify(rows, null, 2));
  child.kill();
}

main().catch((error) => {
  console.error("focus probe failed:", error.message);
  process.exitCode = 1;
});
