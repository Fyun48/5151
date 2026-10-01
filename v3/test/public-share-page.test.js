// A5：公開分享頁（`/l/<post_id>`）要正確辨識已登入狀態。
//
// 症狀：已登入會員開分享頁卻被當成訪客，還顯示「免費註冊」。
// 根因：`v3/public/listing.html` 完全沒有登入狀態初始化（頁首與 CTA 都寫死訪客文案）。
// 修法：分享頁自己打 `/api/me` 取得身分；**公開房源內容維持訪客視角**（後端 viewerId 固定 0），
//       兩者不共用快取、也不把 session 塞進網址。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../public/listing.html", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("A5：分享頁會取得登入狀態，而且預設是載入中（不是先畫成訪客）", () => {
  assert.match(page, /fetch\("\/api\/me", \{ cache: "no-store"/);
  assert.match(page, /let sessionState = "loading"/);
  assert.match(page, /id="authLoading"/);
  assert.match(page, /id="authLogin"/);
  assert.match(page, /id="authMember"/);
  // 三種狀態互斥：預設只露出「身分確認中…」
  assert.match(page, /身分確認中…/);
  assert.match(page, /loading\.hidden = sessionState !== "loading"/);
  // 身分確認失敗要退回訪客（可讀、可登入），不能卡在載入中
  assert.match(page, /sessionState = "guest";\s*\n\s*\}\s*\n\s*applySession\(\);/);
});

test("A5：已登入會員不會再看到「免費註冊」，訪客仍然看得到登入入口", () => {
  // CTA 由 renderCta() 依 sessionState 決定，不是寫死的 HTML
  assert.match(page, /function renderCta\(\)/);
  assert.match(page, /sessionState === "member"/);
  assert.match(page, /免費註冊/); // 訪客分支仍要有
  assert.match(page, /id="shareCta"/);
  // 頁首的訪客連結要可切換（不能是寫死顯示）
  assert.match(page, /guest\.hidden = sessionState !== "guest"/);
});

test("A5：物件說明要用白名單渲染，不是把標籤當純文字印出來", () => {
  // 分享頁原本用 esc(d.body) 輸出，畫面會直接出現 `<p>` 這幾個字；
  // 但改成 innerHTML 就必須自己過一次白名單（後端已 sanitize，這裡是第二層）。
  assert.match(page, /function safeListingHtml\(/);
  assert.match(page, /safeListingHtml\(d\.body\)/);
  assert.doesNotMatch(page, /esc\(d\.body\)/);
});

test("A5：公開房源內容維持訪客視角，登入狀態不混進公開快取", () => {
  // 後端那支公開 API 固定 viewerId: 0（純公開欄位），且仍可公開快取
  assert.match(server, /getSelfListingAsync\(req\.params\.id, \{ viewerId: 0 \}\)/);
  assert.match(server, /"Cache-Control", "public, max-age=15"/);
  // 分享頁不得用網址／localStorage 自行宣告身分
  assert.doesNotMatch(page, /localStorage/);
  assert.doesNotMatch(page, /searchParams.*(userId|role|token)/);
  // `/l/:id` 仍然只是送靜態檔（訪客可讀；權限不會因為這包而緊縮）
  assert.match(server, /app\.get\("\/l\/:id", \(_req, res\) => \{\s*\n\s*res\.sendFile/);
});
