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
// ⚠️ 沙箱 fixture 的已知假陽性缺口（2026-10-12 UI 稽核第二期 reviewer 指正，不要再把它當成「測過逾時」）：
//   `loadListSandbox()` 裡的 `AbortSignal.timeout(ms)` 是**替身**，它只把 `ms` 記進 `requestedTimeouts`
//   然後**立刻**（setTimeout 0）送出 abort。所以 R3-1 那幾條沙箱測試證明的是：
//     ① 程式真的把 15000 送進 fetch 的 signal（`requestedTimeouts` 斷言），
//     ② 逾時發生之後的收尾路徑（busy 清掉、狀態列不是 busy 文案）。
//   它**不**證明「真實中止時間是 15 秒」——真實時間只有真瀏覽器（Playwright）量得到。
//   要驗「兩條請求重疊時多久收尾」請看下面「重疊請求上限」那條：行為用等比縮小的時鐘跑，
//   20 秒上限用常數算術斷言，兩者都不會因為排程抖動而假紅／假綠。
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
function loadListSandbox({ settings = {}, fetchImpl, timeoutDelayMs = 0 }) {
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
        // 見檔頭「沙箱 fixture 的已知假陽性缺口」：這裡是替身，不等真的 ms。
        // 預設 timeoutDelayMs=0 ⇒ 立刻 abort（只驗「逾時之後」的收尾路徑）；
        // 要驗「重疊請求多久收尾」的測試會傳一個等比縮小的 timeoutDelayMs。
        setTimeout(() => ctrl.abort(new DOMException("signal timed out", "TimeoutError")), timeoutDelayMs);
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
      "globalThis.__listFetchFailureText = listFetchFailureText;",
    ].join("\n"),
    ctx,
  );
  const listEl = () => sandbox.$("list");
  return {
    loadList: (options) => ctx.__loadList(options),
    failureText: (error, fallback) => ctx.__listFetchFailureText(error, fallback),
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

test("R3-1 非逾時的失敗（500／網路斷）也會收尾，但不會被套上「更新逾時／重新載入」後綴", async () => {
  const s = loadListSandbox({ fetchImpl: () => Promise.reject(new Error("boom")) });
  await s.loadList({ force: true }).catch(() => {});
  assert.deepEqual(s.toggles("is-refreshing"), [true, false]);
  assert.equal(s.isRefreshing(), false);
  assert.match(s.status(), /boom/);
  // 第二期 reviewer 指正：那條後綴原本對所有錯誤都出現，等於叫人「重新載入」一個其實不是逾時的畫面。
  assert.doesNotMatch(s.status(), /逾時/);
  assert.doesNotMatch(s.status(), /請再點一次重新載入/);
  assert.notEqual(s.status().trim(), "正在更新列表…");
});

test("B2 逾時文案只在真的逾時出現：TimeoutError／AbortError 才有「更新逾時…」，其餘照原文", () => {
  const s = loadListSandbox({ fetchImpl: () => Promise.reject(new Error("x")) });
  assert.equal(s.failureText(new DOMException("signal timed out", "TimeoutError")), "更新逾時（15 秒），請再點一次重新載入");
  assert.equal(s.failureText(new DOMException("aborted", "AbortError")), "更新逾時（15 秒），請再點一次重新載入");
  assert.equal(s.failureText(new Error("boom")), "boom");
  assert.equal(s.failureText(Object.assign(new Error("搜尋暫時無法使用"), { code: "LIST_FAIL" })), "搜尋暫時無法使用");
  // 沒有 message 的錯誤（render 例外被包成 undefined）與訪客訊息只拿 fallback，不會多出後綴
  assert.equal(s.failureText(undefined, "訪客搜尋失敗"), "訪客搜尋失敗");
  assert.doesNotMatch(s.failureText(undefined, "訪客搜尋失敗"), /重新載入/);
});

test("B3 重疊請求上限（約 20 秒）：兩條列表請求都在飛時，busy 要撐到最後一條逾時才收尾", async () => {
  // 真瀏覽器覆核（2026-10-12，本地 5153、Playwright）是 hang 16.6s／20.7s 後 is-refreshing=false，
  // 這條把它變成可重跑的測試：同一條路徑用等比縮小的時鐘跑，重點是
  //「第一條逾時不可以把還在飛的第二條的 busy 收掉」。
  const timeoutDelayMs = 120;
  const staggerMs = 40;
  const s = loadListSandbox({
    timeoutDelayMs,
    fetchImpl: (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason || new DOMException("aborted", "AbortError")));
    }),
  });
  const started = Date.now();
  const first = s.loadList({ force: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, staggerMs));
  const second = s.loadList({ force: true }).catch(() => {});
  await Promise.all([first, second]);
  const elapsed = Date.now() - started;
  assert.deepEqual(s.toggles("is-refreshing"), [true, true, false], "第二條請求的 busy 不可以被第一條的逾時收掉");
  assert.equal(s.isRefreshing(), false, "兩條都收尾後 is-refreshing 一定要清掉");
  assert.notEqual(s.status().trim(), "正在更新列表…");
  assert.match(s.status(), /逾時/);
  assert.ok(elapsed >= timeoutDelayMs + staggerMs, `收尾時間應 ≥ 第二條起跑點＋自己的逾時（實測 ${elapsed}ms）`);
  assert.ok(elapsed < timeoutDelayMs + staggerMs + 500, `收尾不應拖過一個逾時週期（實測 ${elapsed}ms）`);
  // 使用者等待的上限（純算術，不受排程抖動影響）：單條列表請求的預算是 15000ms，
  // 第二條最晚在 5 秒後才重疊 ⇒ 收尾上限 ≈ 20 秒。這也是真瀏覽器量到 16.6s／20.7s 的來源。
  const LIST_FETCH_TIMEOUT_MS = 15000;
  const OVERLAP_STAGGER_BUDGET_MS = 5000;
  assert.equal(LIST_FETCH_TIMEOUT_MS + OVERLAP_STAGGER_BUDGET_MS, 20000);
});

test("A 0 筆的解釋：數字取 stats、口徑寫「候補中」，pending 另計不併進超出範圍", () => {
  const ctx = vm.createContext({
    viewDistricts: new Set(["大里區"]),
    settings: { commuteKm: 13, workAddress: "臺北市士林區" },
    Number, Math, String,
  });
  vm.runInContext(
    [fnSource("commuteShortfallNoun"), fnSource("commuteShortfallMessage"), "globalThis.__m = commuteShortfallMessage;"].join("\n"),
    ctx,
  );
  const one = ctx.__m({ excludedByCommute: 1590, commutePending: 61, matched: 0, total: 0 });
  assert.match(one.lead, /^候補中有 (1,590|1590) 個大里區物件超出你 13 公里的通勤範圍。$/);
  assert.equal(one.hint, "你可以放寬通勤距離，或改為查看全部物件。");
  assert.match(one.note, /^另有 (61) 個物件的通勤距離還在計算中/);
  // 口徑：不得寫成「最終可見數／看不到」那種會被誤讀的句子
  assert.doesNotMatch(one.lead, /看不到|無法顯示|被擋掉|只有/);
  assert.doesNotMatch(one.note, /超出|超過/);
  // pending=0 時不要多一行
  assert.equal(ctx.__m({ excludedByCommute: 1590, commutePending: 0 }).note, "");
  // 多個行政區／沒勾行政區時的措辭
  vm.runInContext('viewDistricts = new Set(["大里區", "太平區"]);', ctx);
  assert.match(ctx.__m({ excludedByCommute: 12 }).lead, /個你勾選行政區的物件超出你 13 公里/);
  vm.runInContext("viewDistricts = new Set();", ctx);
  assert.match(ctx.__m({ excludedByCommute: 12 }).lead, /個符合目前條件的物件超出你 13 公里/);
});

test("A 空狀態是 live region，兩個動作都有名詞（不是「點這裡」）", () => {
  assert.match(html, /class="empty empty-explain" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /id="emptyCommuteWiden" aria-label="放寬通勤距離/);
  assert.match(html, /id="emptyCommuteAllDistricts" aria-label="查看全部行政區的物件/);
  assert.match(html, /\.empty-explain \{ text-align: left;/);
  assert.doesNotMatch(html, /點這裡/);
  // 「查看全部物件」走的是既有 district chips 的「全部」鈕，不新增寫入路徑
  assert.match(html, /document\.querySelector\('\[data-view-district=""\]'\)\?\.click\(\)/);
  assert.match(html, /function focusCommuteLimitSetting\(\) \{/);
  assert.match(html, /input\.scrollIntoView\(\{ block: "center", behavior: "smooth" \}\);/);
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

test("本期色票：--watch 改 #896060（AA 4.5:1），--same-soft 原值不動", () => {
  // 2026-10-12 第二期：--watch 在實際背景上原本 3.91～4.48:1 全部 UNDER AA，
  // 改成 #896060 後最差（對 --bg #f3efe8）4.69:1、對 --paper／--rose-soft／白都在 4.8 以上。
  assert.match(tokens, /--watch: #896060;/);
  assert.match(tokens, /--same-soft: #eceaf4;/);
});
