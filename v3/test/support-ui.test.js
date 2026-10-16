import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  FORBIDDEN_COPY,
  SUPPORT_AMOUNT_MAX,
  SUPPORT_AMOUNT_MESSAGE,
  SUPPORT_AMOUNT_MIN,
} from "../src/supportDomain.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(dir, "..", p), "utf8");
const html = read("public/index.html");
const support = read("public/support.html");
const supportPage = read("public/support-page.js");
const cta = read("public/support-cta.js");
const admin = read("public/admin.html");
const adminJs = read("public/admin-support.js");
const ia = read("public/admin-ia.js");

function assertScriptsParse(source) {
  const blocks = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    if (/\bsrc\s*=/i.test(block[1])) continue;
    assert.doesNotThrow(() => new Function(block[2]));
  }
}

test("support page uses CMS copy, abstract checkout, and free-site language", () => {
  assert.match(support, /讓吉比租房追蹤持續免費/);
  assert.match(support, /吉比租房物件追蹤免費提供/);
  assert.doesNotMatch(support, /讓 5151 持續免費/);
  assert.match(support, /不支持也不會減少任何功能/);
  assert.match(support, /rel="canonical"/);
  assert.match(support, /og:title/);
  assert.doesNotMatch(support, /buymeacoffee\.com/);
  assert.doesNotMatch(support, /急需資金|救救本站|Donate|捐款給我們/);
  assert.match(supportPage, /讓吉比租房追蹤持續免費/);
  assert.match(supportPage, /感謝支持吉比租房追蹤/);
  assert.doesNotMatch(supportPage, /5151/);
  assert.match(supportPage, /\/api\/support\/checkout/);
  assert.match(supportPage, /checkoutType|available/);
  assert.match(supportPage, /visualPercent/);
  assert.doesNotMatch(supportPage, /buymeacoffee\.com/);
  assertScriptsParse(support);
});

test("site entries and CTA stay out of the way of search chrome", () => {
  assert.match(html, /id="supportHeaderLink"/);
  assert.match(html, /id="supportFooterLink"/);
  assert.match(html, /id="supportCtaCard"/);
  assert.match(html, /id="supportMeLink"/);
  assert.match(html, /support-cta-card/);
  assert.match(html, /\.support-cta-card \{ bottom: calc\(64px \+ env\(safe-area-inset-bottom/);
  assert.match(html, /z-index: 90/);
  assert.match(html, /src="\/support-cta.js"/);
  assert.match(cta, /dismissedUntil/);
  assert.match(cta, /data-support-dismiss/);
  assert.match(cta, /Escape/);
  assert.match(cta, /if \(data\?\.state\) writeJson\(STORAGE_KEY, \{ \.\.\.clientState, \.\.\.data\.state \}\)/);
  assert.doesNotMatch(cta, /kind:\s*"support_cta_shown"/);
  assert.doesNotMatch(cta, /shownCount = \(Number\(state\.shownCount\)/);
  assert.doesNotMatch(cta, /buymeacoffee\.com/);
  assertScriptsParse(html);
});

test("support page still lists the configured sponsor ways while the domain stays closed", () => {
  assert.match(support, /id="directWays"/);
  assert.match(support, /id="directWaysList"/);
  assert.match(supportPage, /function renderDirectWays\(/);
  assert.match(supportPage, /sponsor_links/);
  assert.match(supportPage, /heroCta\.href = "#directWays"/);
  // 前端仍不得寫死第三方收款網址，一律用 API 回來的連結。
  assert.doesNotMatch(support, /buymeacoffee\.com/);
  assert.doesNotMatch(supportPage, /buymeacoffee\.com/);
  assertScriptsParse(support);
  assertScriptsParse(html);
});

test("admin support page covers dashboard, preview, and legacy comms form", () => {
  assert.match(admin, /id="supportAdminRoot"/);
  assert.match(admin, /id="supportConfigForm"/);
  assert.match(admin, /data-support-tab="dash"/);
  assert.match(admin, /預覽桌面/);
  assert.match(admin, /預覽手機/);
  assert.match(admin, /id="supportPreviewFrame"/);
  assert.match(admin, /support.enabled/);
  assert.match(adminJs, /\/api\/admin\/support\/dashboard/);
  assert.match(adminJs, /\/support.html\?preview=1/);
  assert.match(ia, /支持總覽/);
  assertScriptsParse(admin);
});

// ---------------------------------------------------------------------------
// 「支持本站」自訂金額（B1）
//
// 這一組不是 grep 原始碼，而是用一個最小 DOM stub 真的把 public/support-page.js
// 跑起來（vm + 假 document／fetch），斷言它建出來的節點、驗證與導外順序。
// ---------------------------------------------------------------------------

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: {},
    children: [],
    listeners: {},
    hidden: false,
    disabled: false,
    value: "",
    className: "",
    style: {},
    _text: "",
    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? "" : String(v); },
    setAttribute(name, value) { this.attrs[String(name)] = String(value); },
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
    removeAttribute(name) { delete this.attrs[String(name)]; },
    append(...nodes) { for (const node of nodes) this.children.push(node); },
    appendChild(node) { this.children.push(node); return node; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatch(type, event) { for (const fn of [...(this.listeners[type] || [])]) fn(event || {}); },
    focus() { this.focused = true; },
    querySelectorAll() { return []; },
  };
  return el;
}

function walk(root, out = []) {
  out.push(root);
  for (const child of root.children || []) walk(child, out);
  return out;
}

function supportPayload(overrides = {}) {
  return {
    enabled: true,
    copy: { cta_label: "支持本站" },
    tiers: [
      { id: 1, title: "請喝杯咖啡", description: "請開發者喝杯咖啡", amount: 30, icon: "☕" },
      { id: 4, title: "自訂支持", description: "自行決定金額", amount: 0, icon: "❤" },
    ],
    provider: { id: 1, kind: "buy_me_a_coffee", display_name: "Buy Me a Coffee", is_active: true },
    checkout_available: true,
    sponsor_links: [],
    ...overrides,
  };
}

/** 真的執行 public/support-page.js；回傳 stub 出來的節點、呼叫紀錄與待執行的 timer。 */
function runSupportPage({ payload = supportPayload(), checkout = { available: false } } = {}) {
  const nodes = new Map();
  const calls = [];
  const timers = [];
  const nav = { search: "", href: "" };
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeEl("div"));
      return nodes.get(id);
    },
    createElement: (tag) => makeEl(tag),
  };
  const fetchStub = (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    const body = String(url).includes("/api/support/checkout") ? checkout : payload;
    return Promise.resolve({ ok: true, json: async () => body });
  };
  const context = {
    document,
    fetch: fetchStub,
    location: nav,
    window: { location: nav },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    console,
  };
  vm.runInNewContext(supportPage, context);
  return { nodes, calls, timers, nav, document, flush: () => new Promise((resolve) => setImmediate(resolve)) };
}

test("custom-amount card renders a labelled number input and never shows NT$ 0", async () => {
  const page = runSupportPage();
  await page.flush();

  const all = walk(page.nodes.get("tierList"));
  const inputs = all.filter((el) => el.tagName === "INPUT");
  assert.equal(inputs.length, 1, "只有「自訂支持」卡片該有金額輸入框");
  const input = inputs[0];
  assert.equal(input.getAttribute("type"), "number");
  assert.equal(input.getAttribute("inputmode"), "numeric");
  assert.equal(input.getAttribute("min"), String(SUPPORT_AMOUNT_MIN));
  assert.equal(input.getAttribute("max"), String(SUPPORT_AMOUNT_MAX));
  assert.equal(input.getAttribute("step"), "1");

  const label = all.find((el) => el.tagName === "LABEL");
  assert.equal(label.getAttribute("for"), input.getAttribute("id"), "label 要用 for 連到輸入框");
  assert.match(label.textContent, /自訂金額/);

  // aria-describedby 同時指到提示與錯誤訊息；錯誤訊息是 aria-live="polite"。
  const describedBy = String(input.getAttribute("aria-describedby")).split(/\s+/);
  const [hintId, errorId] = describedBy;
  const hint = all.find((el) => el.getAttribute("id") === hintId);
  const error = all.find((el) => el.getAttribute("id") === errorId);
  assert.ok(hint && error, "aria-describedby 指到的節點要存在");
  assert.equal(error.getAttribute("aria-live"), "polite");
  assert.equal(error.hidden, true);

  // 卡片金額顯示：固定方案 NT$ 30；自訂卡不得是 NT$ 0。
  const amounts = all.filter((el) => el.className === "amt").map((el) => el.textContent);
  assert.deepEqual(amounts, ["NT$ 30", "自訂金額"]);

  // 打字之後自訂卡顯示實際金額。
  input.value = "500";
  input.dispatch("input");
  assert.equal(all.filter((el) => el.className === "amt")[1].textContent, "NT$ 500");

  // 固定金額方案不送 amount（後端以方案金額為準），但自訂卡送驗證過的金額。
  const buttons = all.filter((el) => el.tagName === "BUTTON");
  buttons[0].dispatch("click");
  await page.flush();
  buttons[1].dispatch("click");
  await page.flush();
  const checkouts = page.calls.filter((c) => c.url === "/api/support/checkout");
  assert.equal(checkouts.length, 2);
  assert.deepEqual(checkouts[0].body, { tierId: 1, amount: 30 });
  assert.deepEqual(checkouts[1].body, { tierId: 4, amount: 500 });
});

test("invalid custom amounts stay client-side: no API call, error announced, focus returns", async () => {
  const page = runSupportPage();
  await page.flush();
  const all = walk(page.nodes.get("tierList"));
  const input = all.find((el) => el.tagName === "INPUT");
  const error = all.find((el) => el.getAttribute("aria-live") === "polite");
  const customButton = all.filter((el) => el.tagName === "BUTTON")[1];

  for (const bad of ["", "0", "9", "100001", "12.5", "abc"]) {
    input.value = bad;
    customButton.dispatch("click");
    await page.flush();
    assert.equal(error.hidden, false, `amount=${bad} 應該顯示錯誤訊息`);
    // 空白另外給一句更白話的提示；其他不合法一律用與後端同一句。
    const expected = bad === "" ? "請先填寫自訂金額。" : SUPPORT_AMOUNT_MESSAGE;
    assert.equal(error.textContent, expected, `amount=${bad} 的錯誤訊息`);
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(input.focused, true, "焦點要回到輸入框");
  }
  assert.equal(page.calls.filter((c) => c.url === "/api/support/checkout").length, 0, "不合法不得送出");
  assert.equal(page.nav.href, "", "不合法不得導外");
});

test("checkout confirms the provider and amount on the page before redirecting", async () => {
  const page = runSupportPage({
    checkout: { available: true, amount: 500, provider: "buy_me_a_coffee", checkoutType: "external", url: "https://example.test/pay" },
  });
  await page.flush();
  const all = walk(page.nodes.get("tierList"));
  const input = all.find((el) => el.tagName === "INPUT");
  input.value = "500";
  all.filter((el) => el.tagName === "BUTTON")[1].dispatch("click");
  await page.flush();

  const note = page.nodes.get("checkoutConfirm");
  assert.equal(note.hidden, false, "導外前要先顯示確認訊息");
  assert.match(note.textContent, /將前往「Buy Me a Coffee」完成支持 NT\$ 500/);
  assert.equal(page.nav.href, "", "確認訊息還沒顯示完不該先導外");

  // 時間到才真的導外（stub 把 setTimeout 收起來，這裡手動觸發）。
  assert.equal(page.timers.length, 1);
  page.timers[0].fn();
  assert.equal(page.nav.href, "https://example.test/pay");

  // 事件 meta 也要帶金額。
  const tierClicked = page.calls.find((c) => c.url === "/api/support/event" && c.body?.kind === "support_tier_clicked");
  assert.deepEqual(tierClicked.body.meta, { tierId: 4, amount: 500 });
});

test("custom amount copy stays inside the site rules and mirrors the backend limits", () => {
  // 禁字：站規清單（supportDomain.FORBIDDEN_COPY）＋大小寫不敏感的 donate。
  assert.deepEqual(FORBIDDEN_COPY, ["donate", "捐款給我們", "急需資金", "救救本站"]);
  for (const word of [...FORBIDDEN_COPY, "捐款"]) {
    assert.doesNotMatch(support, new RegExp(word, "i"), `support.html 不該出現 ${word}`);
    assert.doesNotMatch(supportPage, new RegExp(word, "i"), `support-page.js 不該出現 ${word}`);
  }
  // 前端寫死的範圍與訊息必須和後端 supportDomain 一致。
  assert.match(supportPage, new RegExp(`const AMOUNT_MIN = ${SUPPORT_AMOUNT_MIN};`));
  assert.match(supportPage, new RegExp(`const AMOUNT_MAX = ${SUPPORT_AMOUNT_MAX};`));
  assert.ok(supportPage.includes(`自訂金額請填 \${AMOUNT_MIN} 到 \${AMOUNT_MAX} 之間的整數。`));
  assert.equal(SUPPORT_AMOUNT_MESSAGE, `自訂金額請填 ${SUPPORT_AMOUNT_MIN} 到 ${SUPPORT_AMOUNT_MAX} 之間的整數。`);
  // 觸控目標與 focus-visible 沿用 tokens，不新造顏色。
  assert.match(support, /\.tier input\[type="number"\][\s\S]{0,220}min-height: var\(--touch\)/);
  assert.match(support, /\.tier input\[type="number"\]:focus-visible/);
  assert.match(support, /id="checkoutConfirm" role="status" aria-live="polite"/);
});
