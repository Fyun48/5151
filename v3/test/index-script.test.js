import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const pub = (rel) => readFileSync(path.join(dir, "../public", rel), "utf8");

test("index.html inline script parses", () => {
  const html = pub("index.html");
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({
    attrs: m[1],
    source: m[2],
  }));
  const inline = blocks.filter((block) => !/\bsrc\s*=/i.test(block.attrs));
  assert.ok(inline.length >= 2, "watchdog and main script should be separate tags");
  for (const block of inline) {
    const trimmed = block.source.trim();
    if (!trimmed) continue;
    assert.doesNotThrow(() => new Function(block.source));
  }
});

test("boot watchdog still runs if the main page script never parses", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /id="bootFail"/);
  assert.match(html, /window\.__showBootFail/);
  assert.match(html, /window\.__APP_PARSED = true/);
  assert.match(html, /window\.__APP_BOOTED = true/);
  assert.match(html, /不要按清除資料/);
  const watchdogIdx = html.indexOf("window.__showBootFail");
  const parsedIdx = html.indexOf("window.__APP_PARSED = true");
  const bootedIdx = html.lastIndexOf("window.__APP_BOOTED = true");
  assert.ok(watchdogIdx > 0 && parsedIdx > watchdogIdx, "watchdog script must come before main script");
  assert.ok(bootedIdx > parsedIdx, "boot flag must be set after main script body");
});

test("watch fly animation is non-blocking and targets the watched chip", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /id="watchFlyLayer"/);
  assert.match(html, /pointer-events:\s*none/);
  assert.match(html, /function flyCardToChip/);
  assert.match(html, /function flyCardToWatchChip/);
  assert.match(html, /function flyCardToAllChip/);
  assert.match(html, /data-filter="watched"/);
  assert.match(html, /data-filter="all"/);
  assert.match(html, /flyCardToChip\(card, "watched"\)/);
  assert.match(html, /flyCardToChip\(card, "all"\)/);
  assert.match(html, /1\.15s/);
  assert.match(html, /noteDrafts/);
});

test("watch draft note ignores IME composition and list redraw", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /compositionstart/);
  assert.match(html, /compositionend/);
  assert.match(html, /noteComposing/);
  assert.match(html, /noteJustComposed/);
  assert.match(html, /listLoadGen/);
  assert.match(html, /replaceListHtml/);
  assert.match(html, /data-watch-draft-commit/);
  assert.match(html, /選字不會送出/);
  assert.match(html, /if \(gen !== listLoadGen\) return/);
  assert.match(html, /if \(!draftWatch\.has\(key\)\) return/);
  assert.match(html, /if \(noteComposing\) return true/);
  assert.doesNotMatch(html, /點欄位外即加入/);
  const keydown = html.slice(
    html.indexOf('$("list").addEventListener("keydown"'),
    html.indexOf('$("list").addEventListener("focusout"'),
  );
  assert.match(keydown, /commitWatchDraft\(id, ev\.target\.value\)/);
  assert.match(keydown, /noteJustComposed/);
  assert.doesNotMatch(keydown, /\.blur\(\)/);
  const focusout = html.slice(
    html.indexOf('$("list").addEventListener("focusout"'),
    html.indexOf('$("list").addEventListener("change"'),
  );
  assert.match(focusout, /listRendering \|\| skipDraftBlur \|\| noteComposing/);
  assert.match(focusout, /if \(!goingTo\) return/);
  assert.match(focusout, /watchDraftCommit/);
});

test("unwatch flies to the all chip before reloading", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  const unwatch = html.slice(html.indexOf("if (watched)"), html.indexOf("if (!viewed)"));
  assert.match(unwatch, /flyCardToAllChip\(card\)/);
  assert.match(unwatch, /watched: false/);
  assert.match(unwatch, /visibility = "hidden"/);
});

test("housing kind chips stay independent of 特別關注", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /data-kind="elevator"/);
  assert.match(html, /data-kind="apartment"/);
  assert.match(html, /data-kind="suite"/);
  assert.doesNotMatch(html, /data-kind="building"/);
  assert.match(html, /kind=\$\{encodeURIComponent\(kind\)\}/);
  assert.match(html, /document\.querySelectorAll\("\[data-kind\]"\)/);
  assert.doesNotMatch(html, /data-filter="elevator"/);
  assert.doesNotMatch(html, /data-filter="apartment"/);
  assert.doesNotMatch(html, /data-filter="suite"/);
});

test("page defaults to 全部 + 最新", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /class="chip on" data-filter="all"/);
  assert.match(html, /class="chip on" data-sort="newest"/);
  assert.match(html, /let sort = "newest"/);
  assert.doesNotMatch(html, /class="chip on" data-sort="price_asc"/);
  assert.match(html, /class="chip-row"/);
  assert.match(html, /class="list-search"/);
  assert.match(html, /class="item-title"/);
  assert.match(html, /viewport-fit=cover/);
  assert.doesNotMatch(html, /width:1px;height:22px/);
  assert.match(html, />更多條件</);
  assert.match(html, /FILTER_COMPACT_KEY\) !== "0"/);
  assert.match(html, /filter-compact \.chip-row/);
  assert.match(html, /filter-compact \.filter-body \{\s*display: block;/);
  assert.match(html, /max-width: 880px[\s\S]*#expandPanelBtn \{ display: none; /);
});

test("non-admin members do not see the shared reset link after boot", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /id="resetLink"/);
  assert.match(html, /role !== "admin"/);
});

test("member profiles cap districts and include usable ping in notify copy", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /MEMBER_MAX_DISTRICTS = 10/);
  assert.match(html, /MEMBER_MAX_PROFILES = 3/);
  assert.match(html, /每個設定檔最多選/);
  assert.match(html, /notify_facts/);
  assert.match(html, /housing_type/);
  assert.match(html, /已存 \$\{list\.length\}／\$\{cap\}/);
  assert.match(html, /另存新名稱會提示已滿；同名可覆蓋/);
  assert.match(html, /setSettingsReady\(settingsLoaded\)/);
  assert.match(html, /\$\{label\}路線約 \$\{item\.commute_km\} 公里/);
  assert.doesNotMatch(html, /上約/);
  assert.doesNotMatch(html, /下約/);
  assert.match(html, /確定要覆蓋嗎？/);
  assert.match(html, /設定檔已滿（最多 \$\{cap\} 個）/);
  assert.match(html, /overwrite: existing/);
  assert.doesNotMatch(html, /saveAsBtn"\)\.disabled = atCap/);
  assert.doesNotMatch(html, /disabled = !ok \|\| Boolean\(cap && have >= cap\)/);
  const profilesFn = html.slice(html.indexOf("function renderProfiles"), html.indexOf("function fillNotifyMatrix"));
  assert.equal(profilesFn.includes("if (label)"), false);
});

test("dock has mark-read buttons and renders content diffs", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, />全部已讀</);
  assert.doesNotMatch(html, />全部關閉</);
  assert.match(html, /data-dock-read=/);
  assert.match(html, /function parseNotifyChanges/);
  assert.match(html, /function dockChangeHtml/);
  assert.match(html, /DOCK_READ_KEY/);
  assert.match(html, /markDockRead\(loadDock\(\)\)/);
  assert.match(html, /stored\.filter\(\(item\) => !read\.has\(dockItemKey\(item\)\)\)/);
  assert.match(html, /class="dock-change-from"/);
  assert.match(html, /class="dock-change-to"/);
});

test("guest demo is read-only and work prompt can be skipped", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.doesNotMatch(html, /id="guestBanner"/);
  assert.doesNotMatch(html, /示範瀏覽/);
  assert.match(html, /id="guestToast"/);
  assert.match(html, /class="guest-toast"/);
  assert.match(html, /GUEST_LOCK_TOAST_AFTER = 2/);
  assert.match(html, /function showGuestToast/);
  assert.match(html, /function remindGuest/);
  assert.match(html, /成為會員後就能使用這項功能/);
  assert.match(html, /\$\("who"\)\.textContent = "訪客"/);
  assert.match(html, /classList\.toggle\("is-guest", isGuest\)/);
  assert.match(html, /DFKai-SB/);
  assert.match(html, /標楷體/);
  assert.match(html, /font-size: 21px/);
  assert.match(html, /color: #000/);
  assert.match(html, /class="role-guest"/);
  assert.match(html, /let isGuest = true/);
  assert.match(html, /591_session=/);
  assert.match(html, /html\.no-session #logoutBtn/);
  assert.match(html, /html\.has-session #loginBtn/);
  assert.match(html, /<span>全部<\/span>/);
  assert.match(html, /<span>有電梯<\/span>/);
  assert.match(html, /data-tour="guestWho"/);
  assert.match(html, /class="site-footer"/);
  assert.match(html, /reversal play tech \| 逆遊科技/);
  assert.match(html, /這是示範列表/);
  assert.match(html, /id="workAddress"/);
  assert.doesNotMatch(html, /id="workPrompt"/);
  assert.doesNotMatch(html, /591_v3_work_prompt_skip/);
  assert.doesNotMatch(html, /請至少選一個行政區/);
  assert.match(html, /功能表展開/);
  assert.match(html, /panel-fab-label/);
  assert.match(html, /\/api\/demo/);
  assert.match(html, /function setGuestMode/);
  assert.match(html, /function applyGuestQuery/);
  assert.match(html, /guestListings/);
  assert.match(html, /if \(isGuest\) \{/);
  assert.match(html, /https:\/\/rent\.591\.com\.tw\//);
  assert.match(html, /row\?\.url && !is591Source\(row\)/);
  assert.match(html, /if \(!settingsLoaded \|\| isGuest\) return/);
  assert.match(html, /workAddress: \$\("workAddress"\)\.value\.trim\(\)/);
  assert.match(html, /commuteMode: selectedCommuteMode\("commuteMode"\)/);
  assert.doesNotMatch(html, /collectSettingsSafe/);
  assert.match(html, /body\.role-guest #sponsorBar/);
  assert.match(html, /body\.role-guest #logoutBtn/);
  assert.match(html, /if \(isGuest \|\| !commuteOn\(\)\) return ""/);
  assert.match(html, /一般會員每 8 分鐘檢查一次，贊助會員為 5 分鐘/);
  assert.match(html, /贊助會員為 5 分鐘/);
  assert.match(html, /if \(isGuest\) \{\s*bar\.hidden = true/s);
  const server = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/server.js"), "utf8");
  assert.doesNotMatch(server, /請至少選一個行政區/);
});

test("member settings copy hides advanced hints and locks schedule defaults", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /此通知預設只會訊息已是特別關注之物件/);
  assert.match(html, /物件／屋源提醒若要用信/);
  assert.match(html, /站方管理員 SMTP/);
  assert.match(html, /data-notify-ch="mail"/);
  assert.match(html, /dock: true, push: true, webhook: false, mail: false/);
  assert.match(html, /本系統每8分鐘會重新檢本物件來源比對篩選/);
  assert.match(html, /id="adminLink"/);
  assert.match(html, /後台管理/);
  assert.match(html, /id="sponsorBar"/);
  assert.match(html, /paintSponsorOffer/);
  assert.match(html, /classList\.toggle\("role-admin", meIsAdmin\)/);
  assert.match(html, /meIsAdmin \? Number\(\$\("intervalMinutes"\)\.value\) : undefined/);
  assert.match(html, /meIsAdmin \? \(Number\(\$\("offlineConfirmDays"\)\.value\) \|\| 7\) : 7/);
  assert.match(html, /meIsAdmin \? Number\(\$\("pagesPerWatch"\)\.value\) : 40/);
  assert.match(html, /body:not\(\.role-admin\) \.admin-only/);
  assert.match(html, /class="hint member-only"/);
  assert.doesNotMatch(html, /站內是右下角「待看更新」/);
  assert.doesNotMatch(html, /路徑用 591 物件頁「點地址」/);
  assert.doesNotMatch(html, /每次最多抓取頁數（每頁約 30 筆/);
  assert.doesNotMatch(html, /排程會依這個間隔抓 591 搜尋/);
  assert.doesNotMatch(html, /591 回「不存在／已關閉」後先標/);
  assert.doesNotMatch(html, /搜尋行政區（台北市 region=1/);
  assert.doesNotMatch(html, /以下數量只算 591 搜尋條件/);
  assert.doesNotMatch(html, /stat-note/);
});

test("example work address and exclusive commute modes", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /臺北市南港區經貿一路170號/);
  assert.match(html, /DEFAULT_COMMUTE_KM = 25/);
  assert.match(html, /name="commuteMode" value="scooter"/);
  assert.match(html, /name="commuteMode" value="car"/);
  assert.match(html, /同時只能選一種/);
  assert.match(html, /function selectedCommuteMode/);
  assert.match(html, /function setCommuteMode/);
  assert.match(html, /commuteMode: selectedCommuteMode\("commuteMode"\)/);
  assert.doesNotMatch(html, /workPromptMode/);
});

test("product name is 吉比租房物件追蹤 without v2 開發版 copy", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  const login = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/login.html"), "utf8");
  assert.match(html, /<title>吉比租房物件追蹤<\/title>/);
  assert.match(html, /<h1>吉比租房物件追蹤<\/h1>/);
  assert.equal(html.includes("v2 開發版"), false);
  assert.equal(html.includes("v3 開發版"), false);
  assert.equal(html.includes("與線上版分開的資料庫"), false);
  assert.match(html, /ver\. 3\.17/);
  assert.doesNotMatch(html, /<h1>[^<]*v3/i);
  assert.match(login, /<h1>吉比租房物件追蹤<\/h1>/);
  assert.equal(login.includes("v2 開發版"), false);
  assert.equal(login.includes("v3 開發版"), false);
  assert.equal(login.includes("資料與線上版分開"), false);
  assert.match(login, /ver\. 3\.17/);
});

test("MRT toggle and guest tour are in the page", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /id="showMrt"/);
  assert.match(html, /id="helpQaBtn"/);
  assert.match(html, /html\.no-session #helpQaBtn/);
  assert.match(html, /顯示最近捷運站步行距離/);
  assert.match(html, /function mrtText/);
  assert.match(html, /步行約 \$\{esc\(walkKm\)\} 公里/);
  assert.doesNotMatch(html, /騎車約/);
  assert.match(html, /walkKm < 1\.5/);
  assert.match(html, /id="guestTour"/);
  assert.match(html, /GUEST_TOUR_STEPS/);
  assert.match(html, /function maybeStartGuestTour/);
  assert.match(html, /\[data-tour=guestWho\]/);
  assert.match(html, /前往註冊/);
  assert.match(html, /#listHeadSticky/);
  assert.match(html, /behavior: "instant"/);
  assert.match(html, /\$\("showMrt"\)\?\.addEventListener\("change"/);
  assert.match(html, /id="notifyHub"/);
  assert.match(html, /data-open-hub="webhook"/);
  assert.equal(html.includes('showMrt: $("showMrt") ? $("showMrt").checked : true'), true);
});

test("listing commute copy is kilometers only and does not show rush minutes", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  const start = html.indexOf("function commuteText");
  const end = html.indexOf("function mrtOn");
  assert.ok(start > 0 && end > start);
  const fn = html.slice(start, end);
  assert.match(fn, /\$\{label\}路線約 \$\{item\.commute_km\} 公里/);
  assert.doesNotMatch(fn, /上約/);
  assert.doesNotMatch(fn, /下約/);
  assert.doesNotMatch(fn, /commute_min_am/);
});

test("listing chips use Hermes orange and do not escape chip HTML", () => {
  const html = pub("index.html");
  const tokens = pub("tokens.css");
  assert.match(tokens, /--hermes:\s*#E65326/);
  assert.match(tokens, /--hermes-deep:\s*#C2410C/);
  assert.match(tokens, /--hermes-light:\s*#F47A2A/);
  assert.match(html, /\.mrt-chip/);
  assert.match(html, /\.route-chip/);
  assert.match(html, /\.fee-chip/);
  assert.match(html, /\.rent-price/);
  assert.match(html, /function mrtChip/);
  assert.match(html, /function routeChip/);
  assert.match(html, /class="mrt-chip"/);
  assert.match(html, /class="route-chip"/);
  assert.match(html, /class="fee-chip"/);
  assert.match(html, /class="rent-price"/);
  const routeCss = html.slice(html.indexOf(".route-chip"), html.indexOf(".fee-chip"));
  assert.match(routeCss, /background:\s*none/);
  assert.doesNotMatch(routeCss, /linear-gradient/);
  const feeCss = html.slice(html.indexOf(".fee-chip"), html.indexOf(".rent-price"));
  assert.match(feeCss, /background:\s*none/);
  assert.match(feeCss, /font-weight:\s*800/);
  assert.match(feeCss, /color:\s*var\(--ink\)/);
  assert.doesNotMatch(feeCss, /linear-gradient/);
  const rentCss = html.slice(html.indexOf(".rent-price"), html.indexOf(".guest-tour"));
  assert.match(rentCss, /font-weight:\s*700/);
  assert.match(rentCss, /color:\s*var\(--ink\)/);
  assert.match(html, /<div class="mrt-line">\$\{mrtText\(item\)\}<\/div>/);
  assert.doesNotMatch(html, /esc\(mrtText\(item\)\)/);
});

test("extra-fee and high-deposit text use fee chips, two-month deposit does not", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  const start = html.indexOf("function chineseMonthCount");
  const end = html.indexOf("function offlineLine");
  assert.ok(start > 0 && end > start);
  const { depositMonths, isHighDeposit, feeLines } = new Function(
    "esc",
    `${html.slice(start, end)}; return { depositMonths, isHighDeposit, feeLines };`,
  )((value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  assert.equal(depositMonths("押金 二個月"), 2);
  assert.equal(depositMonths("押金 兩個月"), 2);
  assert.equal(depositMonths("押金 3個月"), 3);
  assert.equal(depositMonths("押金 60,000元", 20000), 3);
  assert.equal(isHighDeposit("押金 二個月", 20000), false);
  assert.equal(isHighDeposit("押金 三個月", 20000), true);
  assert.equal(isHighDeposit("押金 40000元", 20000), false);
  assert.equal(isHighDeposit("押金 60000元", 20000), true);
  const high = feeLines({
    extra_fees: [
      { name: "押金", value: "三個月" },
      { name: "管理費", value: "1000元" },
    ],
    extra_fee: 1500,
    price_num: 20000,
  });
  assert.match(high.html, /class="fee-chip">押金 三個月/);
  assert.match(high.html, /管理費 1000元/);
  assert.doesNotMatch(high.html, /class="fee-chip">管理費/);
  assert.match(high.html, /class="fee-chip">含額外費用約 21,500 元\/月/);
  const normal = feeLines({
    extra_fees: [{ name: "押金", value: "二個月" }],
    extra_fee: 0,
    price_num: 20000,
  });
  assert.match(normal.html, /押金 二個月/);
  assert.doesNotMatch(normal.html, /fee-chip/);
});

test("only acefengyun admin gets a red frame on 社子島 listings", () => {
  const html = pub("index.html");
  assert.match(html, /function isAcefengyunAdmin/);
  assert.match(html, /function isShezidaoAddress/);
  assert.match(html, /\/acefengyun\/i\.test\(meEmail/);
  assert.match(html, /meIsAdmin && \/acefengyun\/i/);
  assert.match(html, /社子島\|社之島\|葫蘆堵/);
  assert.match(html, /延平北路\(五\|六\|七\|八\|九\|\[5-9\]\)段/);
  assert.match(html, /class="item .*shezidao/);
  assert.match(html, /\.item\.shezidao/);
  assert.match(pub("tokens.css"), /--shezi-red:\s*#DC2626/);
  const start = html.indexOf("function isShezidaoAddress");
  const end = html.indexOf("function commuteOn");
  assert.ok(start > 0 && end > start);
  const isShezidaoAddress = new Function(`${html.slice(start, end)}; return isShezidaoAddress;`)();
  assert.equal(isShezidaoAddress("台北市士林區延平北路七段88號"), true);
  assert.equal(isShezidaoAddress("延平北路6段12號"), true);
  assert.equal(isShezidaoAddress("士林區延平北路五段83巷"), true);
  assert.equal(isShezidaoAddress("士林區社子街20號"), true);
  assert.equal(isShezidaoAddress("社子島抽水站附近"), true);
  assert.equal(isShezidaoAddress("士林區社正路"), true);
  assert.equal(isShezidaoAddress("士林區葫蘆街30巷37號"), true);
  assert.equal(isShezidaoAddress("台北市士林區葫東街"), true);
  assert.equal(isShezidaoAddress("士林區中正路"), true);
  assert.equal(isShezidaoAddress("台北市士林區中正路601號"), true);
  assert.equal(isShezidaoAddress("士林區重慶北路四段"), true);
  assert.equal(isShezidaoAddress("士林區中山北路五段"), false);
    assert.equal(isShezidaoAddress("士林區中正路80號"), false);
    assert.equal(isShezidaoAddress("台北市士林區中正路一段200號"), false);
    assert.equal(isShezidaoAddress("中正路100號"), false);
    assert.equal(isShezidaoAddress("文林路100號"), false);
    assert.equal(isShezidaoAddress({ address: "士林區延平北路五段83巷", title: "海光新村", area_name: "士林區" }), true);
    assert.equal(isShezidaoAddress({ address: "士林區中正路", title: "近重陽橋", area_name: "士林區" }), true);
  const aceStart = html.indexOf("function isAcefengyunAdmin");
  const aceEnd = html.indexOf("function isShezidaoAddress");
  const isAcefengyunAdmin = new Function(
    "meIsAdmin",
    "meEmail",
    `${html.slice(aceStart, aceEnd)}; return isAcefengyunAdmin();`,
  );
  assert.equal(isAcefengyunAdmin(true, "acefengyun@gmail.com"), true);
  assert.equal(isAcefengyunAdmin(true, "other-admin@example.com"), false);
  assert.equal(isAcefengyunAdmin(false, "acefengyun@gmail.com"), false);
});

test("panel toggle sits above scroll-top and uses expand/collapse glyphs", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  const expandIdx = html.indexOf('id="expandPanelBtn"');
  const topIdx = html.indexOf('id="scrollTopBtn"');
  assert.ok(expandIdx > 0 && topIdx > expandIdx);
  assert.match(html, /bottom:\s*80px/);
  assert.match(html, /#scrollTopBtn \{[\s\S]*bottom:\s*24px/);
  assert.match(html, /#scrollTopBtn\.on/);
  assert.match(html, /function syncScrollTopBtn/);
  assert.match(html, /icon\.textContent = collapsed \? "<|>" : ">|<"/);
  assert.match(html, /id="deleteAccountBtn"/);
  assert.match(html, /\/api\/account\/delete/);
  assert.match(html, /理由（可空白）/);
});

test("self listing form and in-site detail stay on this site", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /id="selfListingForm"/);
  assert.match(html, /\/api\/self-listings/);
  assert.match(html, /function openSelfDetail/);
  assert.match(html, /id="selfPhotos"/);
  assert.match(html, /\/api\/self-listings\/photos/);
  assert.match(html, /source === "self"/);
  assert.match(html, /站內刊登/);
  assert.match(html, /hbhousing/);
  assert.match(html, /打開住商/);
  assert.match(html, /打開信義/);
  assert.match(html, /打開5168/);
  assert.match(html, /打開租租通/);
  assert.match(html, /打開好房/);
  assert.doesNotMatch(html, /model_score/);
});
