import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ui-p1-a11y-w2：UI 稽核第一期（可及性標記＋等待回饋）的靜態守門測試。
// 這一包只動標記與 feedback，不動任何查詢／篩選語意；色票（--watch／--same-soft）刻意不動，
// 因此在最後一條把它釘住，避免日後有人順手改掉。
const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
const mascot = readFileSync(path.join(dir, "../public/mascot.js"), "utf8");
const tokens = readFileSync(path.join(dir, "../public/tokens.css"), "utf8");

const CHANNEL_TEXT = { dock: "站內通知", push: "系統推播", webhook: "Webhook通知", mail: "郵件通知" };

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

test("P5 吉祥物 role=dialog 有可存取名稱，且沒有把內容改成 role=img／aria-hidden", () => {
  assert.match(mascot, /wrap\.setAttribute\("role", "dialog"\);/);
  assert.match(mascot, /wrap\.setAttribute\("aria-label", "吉比"\);/);
  assert.match(mascot, /jibbyMascotClose/); // 關閉鈕必須還在（不能變成 role=img 的裝飾子樹）
});

test("P7 等待回饋預設生效：is-refreshing 不再綁 showListRefreshBar，細線才看後台開關", () => {
  const fn = html.match(/function setListBusy\(busy, text\) \{[\s\S]*?\n    \}/);
  assert.ok(fn, "找不到 setListBusy");
  assert.match(fn[0], /box\.classList\.toggle\("is-refreshing", on\)/);
  assert.doesNotMatch(fn[0], /is-refreshing", Boolean\(busy\) && listRefreshBarEnabled\(\)/);
  assert.match(fn[0], /box\.classList\.toggle\("show-refresh-bar", on && listRefreshBarEnabled\(\)\)/);
  assert.match(html, /\.list\.is-refreshing \{ pointer-events: none; \}/);
  assert.match(html, /\.list\.is-refreshing\.show-refresh-bar::before \{/);
  assert.match(html, /\.filter-head \.status\.is-busy \{[\s\S]*?color: var\(--ink\);[\s\S]*?font-weight: 600;/);
});

test("P11 .kit-furnish 在任何指標裝置都不低於 24px（WCAG 2.2 AA 2.5.8）", () => {
  const media = html.match(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n    \}/);
  assert.ok(media, "找不到 hover/pointer:fine 區塊");
  assert.match(media[0], /\.kit-furnish \{ min-height: 24px; \}/);
  assert.doesNotMatch(media[0], /\.kit-furnish \{ min-height: 0; \}/);
  assert.match(html, /\.kit-furnish \{[\s\S]{0,200}?min-height: var\(--touch\);/);
  assert.match(tokens, /--touch: 44px;/);
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
