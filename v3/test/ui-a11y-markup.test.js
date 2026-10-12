import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// ui-p1-a11y-w2：UI 稽核第一期（可及性標記＋等待回饋）的守門測試。
// 這一包只動標記與 feedback，不動任何查詢／篩選語意；色票（--watch／--same-soft）刻意不動，
// 因此在最後一條把它釘住，避免日後有人順手改掉。
//
// 觸控目標（WCAG 2.2 AA 2.5.8）量測情境，寫在這裡以免數字被誤用：
//   * `touchTargets.under24` 是稽核端 `manual.mjs` 在「找房」視圖、375px、只算 `offsetParent !== null`
//     的可見元素（含 input／button／[role=button]）。本期修掉的是卡片內的 `.kit-furnish`（原本 20px）。
//     要重現這個數字，本地必須有**會渲染出卡片**的資料（例如自備一顆含 listing 的 data-v3）；
//     沒有卡片的帳號量到 0 是「情境不對」，不是「修好了」。
//   * 通知矩陣那 36 個 checkbox 實測 24×18（高 18 < 24），**不在本期範圍**（派工單只指 `.kit-furnish`），
//     且屬 2.5.8 的「間距例外」候選：它們是表格儲存格內的勾選框、彼此間距由表格 padding 撐開，
//     沒有與其他目標互相覆蓋的情形；要主張例外必須另外量相鄰目標間距，不能只看 24×18 就宣告合規。
const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
const mascot = readFileSync(path.join(dir, "../public/mascot.js"), "utf8");
const tokens = readFileSync(path.join(dir, "../public/tokens.css"), "utf8");

const CHANNEL_TEXT = { dock: "站內通知", push: "系統推播", webhook: "Webhook通知", mail: "郵件通知" };

// 把 index.html 內某個函式的原始碼切出來（大括號配對；template literal 的 ${…} 也是成對的）。
function fnSource(name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `找不到 ${name}()`);
  // 先跳過參數列（`options = {}` 這種預設值裡也有大括號），再從函式主體的第一個 { 開始配對。
  const parenOpen = html.indexOf("(", start);
  let pdepth = 0;
  let parenClose = parenOpen;
  for (let i = parenOpen; i < html.length; i += 1) {
    if (html[i] === "(") pdepth += 1;
    else if (html[i] === ")") {
      pdepth -= 1;
      if (pdepth === 0) {
        parenClose = i;
        break;
      }
    }
  }
  const open = html.indexOf("{", parenClose);
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`找不到 ${name}() 的收尾`);
}

// 找出 `document.querySelectorAll("[data-hub-tab]").forEach((el) => { … });` 這個敘述（含 keydown 的那一個）。
function hubTabWiringSource() {
  const key = 'el.addEventListener("keydown"';
  const keyAt = html.indexOf(key);
  assert.ok(keyAt >= 0, "找不到分頁的 keydown 綁定");
  const head = 'document.querySelectorAll("[data-hub-tab]").forEach((el) => {';
  const start = html.lastIndexOf(head, keyAt);
  assert.ok(start >= 0, "找不到分頁事件綁定的開頭");
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        const end = html.indexOf(");", i);
        return html.slice(start, end + 2);
      }
    }
  }
  throw new Error("找不到分頁事件綁定的收尾");
}

function makeEl(id) {
  const classes = new Set();
  return {
    id,
    value: "",
    textContent: "",
    hidden: false,
    offsetParent: null,
    toggles: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle(c, on) {
        const next = on === undefined ? !classes.has(c) : Boolean(on);
        this._toggles.push([c, next]);
        if (next) classes.add(c);
        else classes.delete(c);
        return next;
      },
      _classes: classes,
      _toggles: [],
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
  };
}

// 用真程式碼跑 loadList：把 index.html 的 loadList／setListBusy／listRefreshBarEnabled／
// listFetchFailureText 原文放進一個最小沙箱，DOM／fetch 換成可控替身。這樣測的是行為，不是字串。
function loadListSandbox({ settings = {}, fetchImpl }) {
  const timeoutMs = Number((html.match(/const LIST_FETCH_TIMEOUT_MS = (\d+);/) || [])[1]);
  assert.equal(timeoutMs, 15000, "列表載入的逾時預算必須是 15000ms");
  const els = new Map();
  const requestedTimeouts = [];
  const sandbox = {
    performance,
    console,
    Math,
    Number,
    String,
    JSON,
    encodeURIComponent,
    DOMException,
    setTimeout,
    clearTimeout,
    window: { scrollY: 0, scrollTo() {}, setTimeout },
    document: { querySelector: () => null, querySelectorAll: () => [], documentElement: { scrollTop: 0 } },
    AbortSignal: {
      timeout(ms) {
        requestedTimeouts.push(ms);
        const ctrl = new AbortController();
        // 真等 15 秒會拖垮測試；數字本身由 requestedTimeouts 斷言，這裡立刻觸發 abort，
        // 驗的是「逾時發生之後」的收尾路徑。
        setTimeout(() => ctrl.abort(new DOMException("signal timed out", "TimeoutError")), 0);
        return ctrl.signal;
      },
    },
    fetch: fetchImpl,
    listLoadGen: 0,
    listRefreshQueued: false,
    lastStats: {},
    listHasMore: false,
    listOffset: 0,
    listCache: [],
    listCursor: null,
    guestListings: [],
    isGuest: false,
    viewDistricts: [],
    filter: "all",
    kinds: [],
    sources: [],
    sort: "newest",
    settings,
    // 任何 id 都給一個可控替身（loadList 會讀 $("q").value、$("list")、$("status")）
    $: (id) => {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    [
      `const LIST_FETCH_TIMEOUT_MS = ${timeoutMs};`,
      // loadList 在成功路徑上會碰到的替身（本測試只關心 busy／狀態列的收尾）
      "function readApi(res) { return res.json(); }",
      "function renderStats() {}",
      "function renderDistrictChips() {}",
      "function applyListView(rows) { return rows; }",
      "function rememberListings() {}",
      "function renderList() {}",
      "function syncCommutePoll() {}",
      "function reportCommuteFocus() {}",
      "function pendingCommuteWork() { return false; }",
      "function syncListMore() {}",
      "function listPageSize() { return 25; }",
      "function canFilterSources() { return false; }",
      "function watchNoteBusy() { return false; }",
      fnSource("listRefreshBarEnabled"),
      fnSource("listFetchFailureText"),
      fnSource("setListBusy"),
      fnSource("loadList"),
      "globalThis.__loadList = loadList;",
    ].join("\n"),
    ctx,
  );
  const listEl = () => sandbox.$("list");
  return {
    loadList: (options) => ctx.__loadList(options),
    status: () => sandbox.$("status").textContent,
    listEl,
    isRefreshing: () => listEl().classList.contains("is-refreshing"),
    showBar: () => listEl().classList.contains("show-refresh-bar"),
    toggles: (cls) => listEl().classList._toggles.filter(([c]) => c === cls).map(([, on]) => on),
    requestedTimeouts,
  };
}

test("P1 通知矩陣 36 個 checkbox 都有與行頭／列頭一致的可及性名稱", () => {
  const table = html.match(/<table class="notify-matrix" id="notifyMatrix">[\s\S]*?<\/table>/);
  assert.ok(table, "找不到 notifyMatrix 表格");
  const rows = [...table[0].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1])
    .filter((row) => row.includes("data-notify-ch"));
  assert.equal(rows.length, 9, "通知矩陣應為 9 列事件");

  let total = 0;
  for (const row of rows) {
    const event = row.match(/<td[^>]*>([^<]+)<\/td>/);
    assert.ok(event, "找不到列的事件名稱");
    const eventName = event[1].trim();
    for (const m of row.matchAll(/<input[^>]*data-notify-row="([^"]+)"[^>]*data-notify-ch="([^"]+)"[^>]*>/g)) {
      const label = m[0].match(/aria-label="([^"]*)"/);
      assert.ok(label, `${eventName}/${m[2]} 的 checkbox 沒有 aria-label`);
      assert.equal(label[1], `${eventName} ${CHANNEL_TEXT[m[2]]}`, `${eventName}/${m[2]} 的 aria-label 與畫面文字不一致`);
      total += 1;
    }
  }
  assert.equal(total, 36, "通知矩陣應有 36 個 checkbox");
});

test("P2 7 個 select 都有可及性名稱（既有可見 label 加 for=）", () => {
  for (const id of ["profileGender", "profileResidence", "selfCity", "selfDistrict", "selfKind", "selfRole", "selfDeposit"]) {
    const tag = html.match(new RegExp(`<select id="${id}"[^>]*>`));
    assert.ok(tag, `找不到 #${id}`);
    const aria = tag[0].match(/aria-label="([^"]*)"/);
    const lab = html.match(new RegExp(`<label for="${id}">([^<]*)</label>`));
    const name = (aria && aria[1]) || (lab && lab[1]) || "";
    assert.ok(name.trim(), `#${id} 沒有可及性名稱`);
  }
});

test("R3-3 通知 hub 的郵件本文 textarea 也有名稱（label[for] 沒有漏）", () => {
  assert.match(html, /<label for="memberMailText">[^<]+<\/label>\s*\n\s*<textarea id="memberMailText">/);
  // 反向檢查（只掃 #notifyHub 這一塊，本期範圍）：不該再有「緊鄰控制項卻沒有 for／aria-label」的 label
  const hub = html.match(/<div id="notifyHub"[\s\S]*?\n  <\/div>\n/);
  assert.ok(hub, "找不到 #notifyHub 區塊");
  const orphans = [...hub[0].matchAll(/<label>([^<]*)<\/label>\s*\n\s*<(input|select|textarea)\b([^>]*)>/g)]
    .filter(([, , , attrs]) => !/aria-label=/.test(attrs))
    .map(([, text]) => text.trim());
  assert.deepEqual(orphans, [], `hub 內還有沒有名稱的控制項 label：${orphans.join(", ")}`);
});

test("P4 通知設定分頁有 role=tab／aria-controls，面板有 role=tabpanel／aria-labelledby（data-hub-tab 原樣保留）", () => {
  const panes = new Map([...html.matchAll(/<section class="hub-pane" id="([^"]+)" data-hub-pane="([^"]+)" role="tabpanel" aria-labelledby="([^"]+)"/g)].map((m) => [m[2], m]));
  assert.equal(panes.size, 4, "應有 4 個 tabpanel");
  let tabs = 0;
  for (const m of html.matchAll(/<button([^>]*)data-hub-tab="([^"]+)"([^>]*)>/g)) {
    const attrs = m[1] + m[3];
    assert.match(attrs, /\brole="tab"/, `data-hub-tab="${m[2]}" 沒有 role="tab"`);
    const controls = attrs.match(/aria-controls="([^"]+)"/);
    assert.ok(controls, `data-hub-tab="${m[2]}" 沒有 aria-controls`);
    const pane = panes.get(m[2]);
    assert.ok(pane, `data-hub-tab="${m[2]}" 沒有對應面板`);
    assert.equal(pane[1], controls[1], `data-hub-tab="${m[2]}" 的 aria-controls 指向錯誤面板`);
    assert.equal(pane[3], attrs.match(/\bid="([^"]+)"/)?.[1], `data-hub-pane="${m[2]}" 的 aria-labelledby 沒有指回分頁`);
    tabs += 1;
  }
  assert.equal(tabs, 4, "應有 4 個分頁");
  // JS 靠 data-hub-tab 選取，值不得被動到
  assert.match(html, /el\.dataset\.hubTab/);
  assert.match(html, /document\.querySelectorAll\("\[data-hub-tab\]"\)/);
});

test("R3-2 分頁是完整的 APG tabs：靜態 roving tabindex（只有選取中的進 Tab 序）", () => {
  const buttons = [...html.matchAll(/<button[^>]*data-hub-tab="([^"]+)"[^>]*>/g)].map((m) => ({ name: m[1], tag: m[0] }));
  assert.equal(buttons.length, 4);
  let inTabOrder = 0;
  for (const { name, tag } of buttons) {
    const selected = /aria-selected="true"/.test(tag);
    const tabindex = tag.match(/tabindex="(-?\d+)"/);
    assert.ok(tabindex, `data-hub-tab="${name}" 沒有 tabindex（roving tabindex 不完整）`);
    assert.equal(tabindex[1], selected ? "0" : "-1", `data-hub-tab="${name}" 的 tabindex 與 aria-selected 不一致`);
    if (selected) inTabOrder += 1;
  }
  assert.equal(inTabOrder, 1, "任何時間只能有一個分頁在 Tab 序內");
  // setHubTab 也要同步 roving（切分頁之後不能只改 aria-selected）
  const setHubTab = fnSource("setHubTab");
  assert.match(setHubTab, /el\.tabIndex = selected \? 0 : -1;/);
});

test("R3-2 分頁的左右方向鍵會移動焦點並選取（真跑 setHubTab，不只看字串）", () => {
  const wiring = hubTabWiringSource();
  const mkTab = (name) => ({
    dataset: { hubTab: name },
    attrs: {},
    tabIndex: null,
    focused: false,
    handlers: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    focus() {
      this.focused = true;
      ctx.document.activeElement = this;
    },
    addEventListener(type, fn) {
      this.handlers[type] = fn;
    },
    click() {
      this.handlers.click?.();
    },
  });
  const tabs = ["events", "rental", "webhook", "mail"].map(mkTab);
  const panes = ["events", "rental", "webhook", "mail"].map((name) => ({ dataset: { hubPane: name }, hidden: name !== "events" }));
  const ctx = {
    document: {
      activeElement: null,
      querySelectorAll: (sel) => (sel === "[data-hub-tab]" ? tabs : panes),
    },
    String,
    console,
  };
  vm.runInContext([fnSource("setHubTab"), wiring, "globalThis.__setHubTab = setHubTab;"].join("\n"), vm.createContext(ctx));

  const selected = () => tabs.filter((t) => t.attrs["aria-selected"] === "true").map((t) => t.dataset.hubTab);
  const tabOrder = () => tabs.filter((t) => t.tabIndex === 0).map((t) => t.dataset.hubTab);
  ctx.__setHubTab("events");
  assert.deepEqual(selected(), ["events"]);
  assert.deepEqual(tabOrder(), ["events"]);

  tabs[0].handlers.keydown({ key: "ArrowRight", preventDefault() {} });
  assert.deepEqual(selected(), ["rental"], "ArrowRight 應選取右邊的分頁");
  assert.deepEqual(tabOrder(), ["rental"], "ArrowRight 應把 Tab 序移到新分頁");
  assert.equal(ctx.document.activeElement, tabs[1], "ArrowRight 應把焦點移到新分頁");
  assert.equal(panes.find((p) => p.dataset.hubPane === "rental").hidden, false, "選取的分頁面板要顯示");

  tabs[1].handlers.keydown({ key: "ArrowLeft", preventDefault() {} });
  assert.deepEqual(selected(), ["events"], "ArrowLeft 應選取左邊的分頁");
  assert.equal(ctx.document.activeElement, tabs[0]);
  tabs[0].handlers.keydown({ key: "ArrowLeft", preventDefault() {} });
  assert.deepEqual(selected(), ["mail"], "ArrowLeft 在頭端要繞到尾端");
  tabs[3].handlers.keydown({ key: "Home", preventDefault() {} });
  assert.deepEqual(selected(), ["events"], "Home 應回到第一個分頁");
  tabs[0].handlers.keydown({ key: "End", preventDefault() {} });
  assert.deepEqual(selected(), ["mail"], "End 應到最後一個分頁");
  assert.equal(selected().length, 1, "任何時間只能有一個 aria-selected=true");
  assert.equal(tabOrder().length, 1, "任何時間只能有一個 tabindex=0");
});

test("P5 吉祥物 role=dialog 有可存取名稱，且沒有把內容改成 role=img／aria-hidden", () => {
  assert.match(mascot, /wrap\.setAttribute\("role", "dialog"\);/);
  assert.match(mascot, /wrap\.setAttribute\("aria-label", "吉比"\);/);
  assert.match(mascot, /jibbyMascotClose/); // 關閉鈕必須還在（不能變成 role=img 的裝飾子樹）
});

test("P7 等待回饋預設生效：is-refreshing 不再綁 showListRefreshBar，細線才看後台開關", () => {
  const fn = fnSource("setListBusy");
  assert.match(fn, /box\.classList\.toggle\("is-refreshing", on\)/);
  assert.doesNotMatch(fn, /is-refreshing", Boolean\(busy\) && listRefreshBarEnabled\(\)/);
  assert.match(fn, /box\.classList\.toggle\("show-refresh-bar", on && listRefreshBarEnabled\(\)\)/);
  assert.match(html, /\.list\.is-refreshing \{ pointer-events: none; \}/);
  assert.match(html, /\.list\.is-refreshing\.show-refresh-bar::before \{/);
  assert.match(html, /\.filter-head \.status\.is-busy \{[\s\S]*?color: var\(--ink\);[\s\S]*?font-weight: 600;/);
});

test("R3-1 路線永不回應（hang）時：15 秒逾時會收尾，is-refreshing 不會永久卡住、狀態列不是 busy 文案", async () => {
  const s = loadListSandbox({
    fetchImpl: (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason || new DOMException("aborted", "AbortError")));
    }),
  });
  await s.loadList({ force: true }).catch(() => {});
  assert.deepEqual(s.requestedTimeouts, [15000], "fetch 必須帶 AbortSignal.timeout(15000)");
  assert.deepEqual(s.toggles("is-refreshing"), [true, false], "busy 必須被開一次、關一次");
  assert.equal(s.isRefreshing(), false, "逾時後 is-refreshing 必須清掉（不然 pointer-events 永久鎖死）");
  assert.equal(s.listEl().classList._classes.has("is-refreshing"), false);
  const status = s.status();
  assert.notEqual(status.trim(), "正在更新列表…", "逾時後狀態列不能停在 busy 文案");
  assert.match(status, /逾時/);
  assert.match(status, /請再點一次重新載入/);
});

test("R3-1 非逾時的失敗（500／網路斷）也會收尾並換成失敗文案", async () => {
  const s = loadListSandbox({ fetchImpl: () => Promise.reject(new Error("boom")) });
  await s.loadList({ force: true }).catch(() => {});
  assert.deepEqual(s.toggles("is-refreshing"), [true, false]);
  assert.equal(s.isRefreshing(), false);
  assert.match(s.status(), /boom/);
  assert.match(s.status(), /請再點一次重新載入/);
  assert.notEqual(s.status().trim(), "正在更新列表…");
});

test("R3-1 後台細線開關仍只決定樣式：等待中一樣加 is-refreshing", async () => {
  for (const [showListRefreshBar, expectedBar] of [[true, true], [false, false]]) {
    const s = loadListSandbox({ settings: { showListRefreshBar }, fetchImpl: () => new Promise(() => {}) });
    s.loadList({ force: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.isRefreshing(), true, "等待中一律要有 is-refreshing");
    assert.equal(s.showBar(), expectedBar, `showListRefreshBar=${showListRefreshBar} 時細線樣式應為 ${expectedBar}`);
  }
});

test("R3-1 舊世代的逾時不會去動新世代的狀態（世代守衛）", async () => {
  let first = true;
  const s = loadListSandbox({
    fetchImpl: () => {
      if (first) {
        first = false;
        return new Promise((_, reject) => setTimeout(() => reject(new DOMException("signal timed out", "TimeoutError")), 8));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  });
  const slow = s.loadList({ force: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1));
  await s.loadList({ force: true, silent: true, keep: true }).catch(() => {});
  await slow;
  assert.equal(s.toggles("is-refreshing").filter((on) => on === false).length, 1, "舊世代不得再關一次 busy");
  assert.equal(s.isRefreshing(), false);
});

test("P11 .kit-furnish 在任何指標裝置都不低於 24px（WCAG 2.2 AA 2.5.8）", () => {
  const media = html.match(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n    \}/);
  assert.ok(media, "找不到 hover/pointer:fine 區塊");
  assert.match(media[0], /\.kit-furnish \{ min-height: 24px; \}/);
  assert.doesNotMatch(media[0], /\.kit-furnish \{ min-height: 0; \}/);
  assert.match(html, /\.kit-furnish \{[\s\S]{0,200}?min-height: var\(--touch\);/);
  assert.match(tokens, /--touch: 44px;/);
});

test("R3-4 選取中的分頁 hover 不會掉成淺底淺字（比 .ghost:hover 更高優先度的一條新規則）", () => {
  // 審查實測：改前 fg #faf8f4 / bg #e7f1ef ⇒ 對比 1.08:1。修法只准新增這一條。
  assert.match(html, /\.hub-tabs button\[aria-selected="true"\]:hover \{\s*\n\s*background: var\(--accent\);\s*\n\s*color: var\(--primary-foreground\);\s*\n\s*border-color: var\(--accent\);\s*\n\s*\}/);
  assert.match(tokens, /--accent: #0f6f6a;/);
  assert.match(tokens, /--primary-foreground: #faf8f4;/);
  // 原本蓋掉底色的那條規則還在（我們不動它，只把選取中的優先度抬高）
  assert.match(html, /\.ghost:hover:not\(:disabled\) \{ background: var\(--accent-soft\); border-color: var\(--line\); \}/);
});

test("P12 h3 不再掛 role=button；卡片標題由 h3 改 h2（heading-order）", () => {
  assert.doesNotMatch(html, /<h3[^>]*role="button"/);
  assert.match(html, /<button type="button" class="district-city-toggle" data-city-toggle="\$\{city\.id\}"/);
  assert.doesNotMatch(html, /<h3 class="district-city-toggle"/);
  assert.match(html, /<h2 class="item-title">/);
  assert.doesNotMatch(html, /<h3 class="item-title">/);
});

test("本期刻意不動色票：--watch 與 --same-soft 原值", () => {
  assert.match(tokens, /--watch: #9a6b6b;/);
  assert.match(tokens, /--same-soft: #eceaf4;/);
});
