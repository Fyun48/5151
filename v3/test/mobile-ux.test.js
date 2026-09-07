import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
const sw = readFileSync(path.join(dir, "../public/sw.js"), "utf8");

// A — 手機 Q&A / 意見 就地入口
test("A: mobile help dock exists, reuses existing dialogs, hidden on desktop/guest", () => {
  assert.match(html, /id="mobileHelpDock"/);
  assert.match(html, /id="mobileHelpQaBtn"/);
  assert.match(html, /id="mobileFeedbackBtn"/);
  assert.match(html, /\$\("mobileHelpQaBtn"\)\?\.addEventListener\("click", openHelpQaDialog\)/);
  assert.match(html, /\$\("mobileFeedbackBtn"\)\?\.addEventListener\("click", openFeedbackDialog\)/);
  // 預設隱藏；只在手機列表頁顯示；guest/no-session 隱藏；safe-area
  assert.match(html, /\.mobile-help-dock \{ display: none; \}/);
  assert.match(html, /body\[data-app-view="listings"\] \.mobile-help-dock \{[\s\S]*?position: fixed; left: 12px; z-index: 117;/);
  assert.match(html, /bottom: calc\(120px \+ env\(safe-area-inset-bottom, 0px\)\);/);
  assert.match(html, /html\.no-session \.mobile-help-dock,\s*\n\s*body\.role-guest \.mobile-help-dock \{ display: none !important; \}/);
});

// Q — 手機通知不再展開「待看更新」浮層
test("Q: notify tab hides alertDock on mobile; setAppView does not force-open on mobile", () => {
  assert.match(html, /body\[data-app-view="notify"\] #alertDock \{\s*\n\s*display: none !important;/);
  assert.match(html, /if \(window\.matchMedia\("\(min-width: 881px\)"\)\.matches\) \$\("alertDock"\)\?\.classList\.add\("open"\);\s*\n\s*else \$\("alertDock"\)\?\.classList\.remove\("open"\);/);
});

// R — 通知設定預設「通知種類」
test("R: default notification-settings tab is 通知種類 (events)", () => {
  assert.match(html, /data-hub-tab="events" aria-selected="true">通知種類/);
  assert.match(html, /data-hub-tab="webhook" aria-selected="false">Discord Webhook/);
  assert.match(html, /data-hub-tab="mail" aria-selected="false">/);
  assert.match(html, /<section class="hub-pane" data-hub-pane="webhook" hidden>/);
  assert.match(html, /<section class="hub-pane" data-hub-pane="events">/); // events 預設可見
  assert.match(html, /const tab = String\(name \|\| "events"\);/);
  // 不強制每次 rerender 切回：進 notify 時保留目前選取
  assert.match(html, /setHubTab\(document\.querySelector\("\[data-hub-tab\]\[aria-selected='true'\]"\)\?\.dataset\.hubTab \|\| "events"\)/);
});

// S — 推播 permission / subscription 狀態機
test("S: push state machine distinguishes browser permission vs site subscription", () => {
  assert.match(html, /function refreshPushUi\(\)/);
  assert.match(html, /function pushSupported\(\)/);
  assert.match(html, /function unsubscribeWebPush\(\)/);
  // 四種狀態文案
  assert.match(html, /等待允許系統推播/);
  assert.match(html, /可解除系統推播/);
  assert.match(html, /啟用系統推播/);
  assert.match(html, /瀏覽器未允許通知/);
  // default 只在 user gesture request；page load 不 requestPermission（唯一 requestPermission 在 subscribeWebPush）
  const reqHits = (html.match(/Notification\.requestPermission\(\)/g) || []).length;
  assert.equal(reqHits, 1);
  // unsubscribe 呼叫本站 endpoint、有確認、不假裝改瀏覽器權限
  assert.match(html, /\/api\/push\/unsubscribe/);
  assert.match(html, /是否解除系統推播？/);
  // denied 不重複 requestPermission（action=denied 時直接 return）
  assert.match(html, /if \(action === "denied" \|\| action === "unsupported"\)/);
  // push 偏好在未訂閱時 disabled
  assert.match(html, /const pushOn = pushPermission === "granted" && pushSubscribed === true;/);
  assert.match(html, /\[data-notify-ch="push"\]/);
  // 進 notify 時刷新推播 UI
  assert.match(html, /refreshPushUi\(\)\.catch\(\(\) => \{\}\);/);
});

// #190 Service Worker 快取策略未被破壞
test("does not regress #190 service-worker cache versioning", () => {
  assert.match(sw, /const CACHE_PREFIX = "jibi-shell-";/);
  assert.match(sw, /const CACHE_VERSION = "v\d+";/);
  assert.match(sw, /startsWith\(CACHE_PREFIX\)/);
  assert.match(sw, /self\.skipWaiting\(\)/);
  assert.match(sw, /self\.clients\.claim\(\)/);
});
