// 進度量尺（`v3/scripts/route-data-map.mjs`）的回歸鎖（2026-09-27）。
//
// 為什麼需要這支：這支工具是整個遷移專案的**進度尺**，而它有過兩個方向相反的缺陷，
// 害我實際排錯過一次優先順序（把「10 條路由只被 2 個函式卡住」當成最划算的一批，
// 實際上背後的 `comms.js` 是 812 行、約 20 個吃 handle 的函式）。
//
// 這支測試**故意不驗總數**——總數會隨著工作進度變動，把它寫死只會製造假失敗。
// 它驗的是「幾個我逐條讀過程式碼、確認過正確答案的路由」。
// 換句話說：這裡的期望值是**人工核對過的 ground truth**，不是工具自己的輸出。
//
// ⚠️ 2026-09-27 這一批期望值**整批換過**，原因是兩個真實的程式改動（不是為了讓測試變綠）：
//   1. session 改成 PG 解析（Owner 方案 A）：`readSession()` 不再必然讀節點本機 SQLite。
//   2. 尺規修掉缺陷 (6)「傳參考的函式／中介層看不到」：先前 `requireAdminApi` 這類
//      **以參考傳入的中介層**一條邊都建不起來，於是已移植的 PG session 完全隱形。
// 兩者都讓「SQLite 卡點」變少、判定由 SQLite 變 MIXED／PG。舊的期望值在這裡如實記錄，
// 不默默換掉：`/api/demo` 曾是 `SQLite + findUserByEmail`、`/api/media` 曾是 `SQLite`、
// `/api/admin/*` 四條曾是 `SQLite`、`reject-match` 曾是 `MIXED + findUserByEmail`。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const SCRIPT = "v3/scripts/route-data-map.mjs";

function runMap() {
  const out = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows = new Map();
  let matched = 0;
  for (const line of out.split("\n")) {
    // ⚠️ 判定欄用 `([^*]+)`，**不能**用 `\w+`：`無直接DB` 是中文，JS 的 `\w` 不含 CJK，
    // 用 `\w+` 會讓這一類的列整條被跳過（第一版就是這樣，於是「找不到 /api/health」）。
    const m = line.match(/^\|\s*(\d+)\s*\|\s*(\w+)\s*\|\s*`([^`]+)`\s*\|\s*(\w+)\s*\|\s*\*\*([^*]+)\*\*\s*\|[^|]*\|\s*([^|]*)\|\s*([^|]*)\|/);
    if (!m) continue;
    matched += 1;
    const key = `${m[2]} ${m[3]}`;
    const entry = {
      verdict: m[5].trim(),
      sqlite: m[6].split(",").map((s) => s.trim()).filter((s) => s && s !== "—"),
      pg: m[7].split(",").map((s) => s.trim()).filter((s) => s && s !== "—"),
    };
    // 同一條 method+path 可能註冊多次（不同中介層）；合併避免覆蓋。
    const prev = rows.get(key);
    rows.set(key, prev ? {
      verdict: prev.verdict === entry.verdict ? prev.verdict : `${prev.verdict}|${entry.verdict}`,
      sqlite: [...new Set([...prev.sqlite, ...entry.sqlite])],
      pg: [...new Set([...prev.pg, ...entry.pg])],
    } : entry);
  }
  return { out, rows, matched };
}

const { out, rows, matched } = runMap();

const route = (key) => {
  const r = rows.get(key);
  assert.ok(r, `找不到 ${key}`);
  return r;
};

test("分析器仍然涵蓋全部 288 條入口（不能因為改壞而少抓）", () => {
  assert.equal(matched, 288, `應解析到 288 列，實際 ${matched}`);
  assert.match(out, /共 \*\*288\*\* 條入口/);
});

test("/api/health 必須是「無直接DB」——它只讀行程內計數器，不碰 DB", () => {
  const r = route("GET /api/health");
  assert.equal(r.verdict, "無直接DB",
    `曾被誤判成 PG：引用了一個住在 *Async.js 的函式，但那個函式不碰 DB。實際：${JSON.stringify(r)}`);
  assert.deepEqual(r.sqlite, [], "不該有任何 SQLite 函式");
});

test("函式本文被截斷的守衛：/api/admin/members 必須看得到 listAdminMembers", () => {
  // 這一條專門鎖「函式本文起點算錯」的那個修法錯誤。
  // 我第一版用「簽名後第一個 `{`」當起點，遇到 `function f(a, { b = "" } = {})` 會配對到
  // **參數的 `}`** 就結束，本文被截斷 ⇒ `listAdminMembers`（`db.js:904`，內部用 global `db`）
  // 掉了 DIRECT 判定 ⇒ 這條路由被誤降成「無直接DB」。
  // 實測：那個錯誤版本會讓 55 條判定改變，但**我原本的 5 條 ground truth 一條都沒抓到**——
  // 是變異測試把它逼出來的。
  // 2026-09-27：判定由 `SQLite` 變 `MIXED`（session 改走 PG），但「看得到 listAdminMembers」
  // 這個**缺陷 (1) 的可觀察點**沒變，所以斷言保留。
  const r = route("GET /api/admin/members");
  assert.equal(r.verdict, "MIXED", `實際：${JSON.stringify(r)}`);
  assert.ok(r.sqlite.includes("listAdminMembers"),
    `必須看得到 listAdminMembers（db.js:904 內部用 global db）。實際 sqlite=${JSON.stringify(r.sqlite)}`);
});

test("傳參考的函式必須被看見：/api/demo 的 buildDemoState({ listUserIds, … })", () => {
  // 🚨 缺陷 (6)：`callsIn()` 要求名字後面接 `(`，所以
  // `buildDemoState({ listUserIds, getSettings, defaultUserId, listListings, stats })`
  // 這種**把函式當參數傳**的寫法一條邊都建不起來——那 5 個全是 db.js 的 SQLite 讀取，
  // `/api/demo` 卻被判成 PG。
  // 這個低估被掩蓋了很久：`/api/demo` 本文有 `readSession(req)`，那條邊會拉到
  // `findUserByEmail`，於是它「剛好」顯示成 SQLite。session 改成 PG 解析之後掩蓋消失，
  // `/api/demo` 立刻變成 `PG` 且 `sqlite=[]`——**低估是真的，不是新壞的**。
  const r = route("GET /api/demo");
  assert.equal(r.verdict, "MIXED", `實際：${JSON.stringify(r)}`);
  for (const fn of ["listUserIds", "listListings", "getSettings", "stats"]) {
    assert.ok(r.sqlite.includes(fn),
      `${fn} 是**傳參考**傳進 buildDemoState 的 db.js 函式，必須被看見。實際 sqlite=${JSON.stringify(r.sqlite)}`);
  }
});

test("函式本文吞掉整段路由的守衛：/api/support/public 不得被塞進 132 個 SQLite 函式", () => {
  // 缺陷 (1)：`yieldEventLoop()`（server.js 約 477 行）後面緊接著約 51 條路由註冊，
  // 「切到下一個 function 宣告」的本文切片會把那一整段吞進去（下一個宣告是 563 行的
  // `resolveGuestWorkPoint`），任何呼叫它的路由都繼承那一段裡所有路由的函式引用。
  //
  // ⚠️ 這一條**原本是拿 `/api/demo` 當標的**，2026-09-27 換成 `/api/support/public`，
  // 原因是實測：缺陷 (1) 對 `/api/demo` 已經**完全沒有影響**（它的本文在 538 行，
  // 自己那一小段本來就在被吞的範圍內，所以看不出差別）。真正有差別的是
  // `/api/support/public`：正常 `PG / sqlite=[]`，缺陷 (1) 下變成 `MIXED / sqlite=132 個`。
  // 也就是說，**缺陷 (1) 的殺手必須挑「被污染到的路由」，不能挑「污染源自己」**。
  const r = route("GET /api/support/public");
  assert.equal(r.verdict, "PG",
    `support.js 21 條路由已全部移植成 PG，被污染時會退回 MIXED。實際：${JSON.stringify(r)}`);
  assert.deepEqual(r.sqlite, [],
    `不得有 SQLite 卡點（缺陷 (1) 會塞進 132 個）。實際 sqlite=${JSON.stringify(r.sqlite)}`);
});

test("傳參考的中介層必須被看見：/api/admin/* 的 requireAdminApi 要帶出 PG session", () => {
  // 🚨 缺陷 (6) 的另一半，而且這一半在 session 改成 PG 之後才變得關鍵：
  // `app.get("/api/admin/providers", requireAdminApi, …)` 這種**以參考傳入的中介層**
  // 名字後面沒有 `(`，所以整條路由看不到 `requireAdminApi` → `readSession` → PG session。
  // 後果是 50+ 條管理路由明明已經用 PG 解析身分，尺規卻完全看不到。
  for (const key of ["GET /api/admin/providers", "PUT /api/admin/ads", "GET /api/admin/members"]) {
    const r = route(key);
    assert.ok(r.pg.includes("readSessionAsync"),
      `${key} 的 requireAdminApi 會用 PG 解析 session，必須被看見。實際 pg=${JSON.stringify(r.pg)}`);
  }
});

test("session 改由 PG 解析：/api/me 不得再把 findUserByEmail 算成自己的 SQLite 卡點", () => {
  // 這是 Owner 方案 A 的驗收點，同時是**尺規那條規則的否證條件**。
  // 尺規只有在 `server.js` 真的把 `app.use(resolveSession())` 掛在**第一條路由之前**時，
  // 才會把 `auth.js::readSession` 當成已由 PG 解析。把那個掛載移走、改名、或排到路由後面，
  // 這一條就會失敗（`findUserByEmail` 會回來）——所以它不是信任宣告，是可否證的檢查。
  const r = route("GET /api/me");
  assert.ok(r.pg.includes("readSessionAsync"), `實際 pg=${JSON.stringify(r.pg)}`);
  assert.ok(!r.sqlite.includes("findUserByEmail"),
    `session 已由 resolveSession() 中介層向 PG 解析，不該再列 findUserByEmail。實際 sqlite=${JSON.stringify(r.sqlite)}`);
});

test("已完全移植的路由必須是 PG：reject-match 不得再有 SQLite 卡點", () => {
  // 這條路由的寫入（rejectSuspectedMatchAsync）、統計（listingStatsAsync）與 session
  // （readSessionAsync）三條路都已經是 PG，所以它應該完全沒有 SQLite 卡點。
  // 舊期望值（2026-09-27 session 修正前）是 `MIXED + findUserByEmail`，如實記錄於此。
  const r = route("POST /api/listings/:id/reject-match");
  assert.equal(r.verdict, "PG", `實際：${JSON.stringify(r)}`);
  assert.deepEqual(r.sqlite, [], `不得有 SQLite 卡點。實際 sqlite=${JSON.stringify(r.sqlite)}`);
  for (const fn of ["rejectSuspectedMatchAsync", "listingStatsAsync", "readSessionAsync"]) {
    assert.ok(r.pg.includes(fn), `缺少 PG 入口 ${fn}。實際 pg=${JSON.stringify(r.pg)}`);
  }
});

test("吃 handle 參數的 helper 必須被看見：/api/media 的 listMemberMedia", () => {
  // 📌 這條**已經換過兩次標的**，換的原因值得記下來：
  //   1. 原本用 `/api/support/public`（`publicSupportConfig(db)`）→ 第十一批移植成 PG ⇒ 失效。
  //   2. 改用 `/api/admin/support/dashboard`（`supportDashboard(db)`）→ 同一批的下一步又移植掉 ⇒ 失效。
  // **凡是拿「目前還沒移植」當 ground truth 的守衛，都會在移植完成那一刻失效。**
  // 這次刻意挑一個**短期內不會動的模組**：`/api/media` 的 `listMemberMedia(db)`
  // （memberMedia.js，9 條路由／15 個函式，排在後面的批次）。
  // ⚠️ 移植 memberMedia.js 時，這一條要再換標的，**不要刪掉斷言**。
  // 2026-09-27：判定由 `SQLite` 變 `MIXED`（session 改走 PG），斷言主體不變。
  const r = route("GET /api/media");
  assert.equal(r.verdict, "MIXED", `缺陷 (2) 會讓它變成「無直接DB」。實際：${JSON.stringify(r)}`);
  assert.ok(r.sqlite.includes("listMemberMedia"),
    `必須看得到 listMemberMedia(db)。實際 sqlite=${JSON.stringify(r.sqlite)}`);
});

test("被低估的那一批：/api/admin/campaigns 必須看得到 listCampaignsAdmin", () => {
  const r = route("GET /api/admin/campaigns");
  assert.equal(r.verdict, "MIXED", `實際：${JSON.stringify(r)}`);
  assert.ok(r.sqlite.includes("listCampaignsAdmin"),
    `舊尺只顯示 getCommsConfig，於是這批看起來「只被 2 個函式卡住」。實際 sqlite=${JSON.stringify(r.sqlite)}`);
});

test("純函式不得被列為 SQLite 卡點：normalizeLineUrl 必須完全不出現", () => {
  // `normalizeLineUrl()`（selfListings.js:502）只做字串處理、一個 regex 與 `throw`，**完全不碰 DB**。
  // 它一度出現在 **18 條**路由的 sqlite 欄裡，根因是剝註解用 regexp 而**不辨識正規表達式字面量**：
  // `/^https:\/\/(line\.me|lin\.ee)\//i` 的「跳脫斜線 ＋ 結尾斜線」形成 `//`，
  // 前一個字元是 `\` 不是 `:` ⇒ 整行被當註解刪掉 ⇒ 括號失衡 ⇒ 本文往後吞掉下一個函式。
  // 這種誤報會虛增缺口，所以釘住它。
  const bad = [...rows.entries()]
    .filter(([, r]) => r.sqlite.includes("normalizeLineUrl"))
    .map(([key]) => key);
  assert.deepEqual(bad, [],
    `normalizeLineUrl 是純函式，出現在 sqlite 欄代表剝註解又把它的本文弄壞了：${bad.join(" / ")}`);
});

test("交叉驗證：交接文件明寫「真的還沒轉換」的 /api/admin/legal-copy 必須看得到 SQLite 讀取", () => {
  const r = route("GET /api/admin/legal-copy");
  assert.equal(r.verdict, "MIXED", `實際：${JSON.stringify(r)}`);
  assert.ok(r.sqlite.includes("getLegalCopy"),
    `實際 sqlite=${JSON.stringify(r.sqlite)}`);
});
