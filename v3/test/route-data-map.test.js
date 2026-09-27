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
// 每一條都對應一個曾經壞掉的地方：
//   * `/api/health`  → 無直接DB：它只讀行程內計數器。曾被誤判成 PG，因為引用了一個
//                       住在 `*Async.js` 的函式（但那個函式根本不碰 DB）。
//   * `/api/demo`    → SQLite + findUserByEmail：經 buildDemoState 落到 db.js 的 SQLite 讀取。
//                       曾被「函式本文吞掉整段路由」的缺陷蓋掉。
//   * `/api/support/public` → SQLite + publicSupportConfig：吃 handle 參數的 helper。
//                       缺陷 (2) 讓它變成「無直接DB」。
//   * `/api/admin/campaigns` → SQLite + listCampaignsAdmin：同上，而且它是被低估的那一批。
//   * `/api/admin/legal-copy` → SQLite：交接文件本來就明寫「真的還沒轉換」，可以當交叉驗證。
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

test("分析器仍然涵蓋全部 288 條入口（不能因為改壞而少抓）", () => {
  assert.equal(matched, 288, `應解析到 288 列，實際 ${matched}`);
  assert.match(out, /共 \*\*288\*\* 條入口/);
});

test("/api/health 必須是「無直接DB」——它只讀行程內計數器，不碰 DB", () => {
  const r = rows.get("GET /api/health");
  assert.ok(r, "找不到 /api/health");
  assert.equal(r.verdict, "無直接DB",
    `曾被誤判成 PG：引用了一個住在 *Async.js 的函式，但那個函式不碰 DB。實際：${JSON.stringify(r)}`);
  assert.deepEqual(r.sqlite, [], "不該有任何 SQLite 函式");
});

test("/api/demo 必須看得到 findUserByEmail（經 buildDemoState 落到 SQLite）", () => {
  const r = rows.get("GET /api/demo");
  assert.ok(r, "找不到 /api/demo");
  assert.equal(r.verdict, "SQLite", `實際：${JSON.stringify(r)}`);
  assert.ok(r.sqlite.includes("findUserByEmail"),
    `缺陷 (1)（函式本文吞掉整段路由）修好前後差在這裡。實際 sqlite=${JSON.stringify(r.sqlite)}`);
});

test("吃 handle 參數的 helper 必須被看見：/api/support/public", () => {
  const r = rows.get("GET /api/support/public");
  assert.ok(r, "找不到 /api/support/public");
  assert.equal(r.verdict, "SQLite",
    `缺陷 (2) 讓它變成「無直接DB」。實際：${JSON.stringify(r)}`);
  assert.ok(r.sqlite.includes("publicSupportConfig"),
    `必須看得到 publicSupportConfig(db)。實際 sqlite=${JSON.stringify(r.sqlite)}`);
});

test("被低估的那一批：/api/admin/campaigns 必須看得到 listCampaignsAdmin", () => {
  const r = rows.get("GET /api/admin/campaigns");
  assert.ok(r, "找不到 GET /api/admin/campaigns");
  assert.equal(r.verdict, "SQLite", `實際：${JSON.stringify(r)}`);
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

test("交叉驗證：交接文件明寫「真的還沒轉換」的 /api/admin/legal-copy 必須是 SQLite", () => {
  const r = rows.get("GET /api/admin/legal-copy");
  assert.ok(r, "找不到 GET /api/admin/legal-copy");
  assert.equal(r.verdict, "SQLite", `實際：${JSON.stringify(r)}`);
});

test("函式本文被截斷的守衛：/api/admin/members 必須看得到 listAdminMembers", () => {
  // 這一條專門鎖「函式本文起點算錯」的那個修法錯誤。
  // 我第一版用「簽名後第一個 `{`」當起點，遇到 `function f(a, { b = "" } = {})` 會配對到
  // **參數的 `}`** 就結束，本文被截斷 ⇒ `listAdminMembers`（`db.js:904`，內部用 global `db`）
  // 掉了 DIRECT 判定 ⇒ 這條路由被誤降成「無直接DB」。
  // 實測：那個錯誤版本會讓 55 條判定改變，但**我原本的 5 條 ground truth 一條都沒抓到**——
  // 是變異測試把它逼出來的。
  const r = rows.get("GET /api/admin/members");
  assert.ok(r, "找不到 GET /api/admin/members");
  assert.equal(r.verdict, "SQLite", `實際：${JSON.stringify(r)}`);
  assert.ok(r.sqlite.includes("listAdminMembers"),
    `必須看得到 listAdminMembers（db.js:904 內部用 global db）。實際 sqlite=${JSON.stringify(r.sqlite)}`);
});

test("已移植的路由不得被誤報成 PG：reject-match 必須同時列出 PG 寫入與 SQLite 讀取", () => {
  const r = rows.get("POST /api/listings/:id/reject-match");
  assert.ok(r, "找不到 POST /api/listings/:id/reject-match");
  // 這一條是「新尺比舊尺誠實」的代表：寫入走 PG，但 readSession 仍在讀節點本機 SQLite。
  assert.ok(r.pg.includes("rejectSuspectedMatchAsync"), `PG 寫入入口必須在。實際 pg=${JSON.stringify(r.pg)}`);
  assert.ok(r.sqlite.includes("findUserByEmail"),
    `session 解析仍讀節點 SQLite，必須誠實列出。實際 sqlite=${JSON.stringify(r.sqlite)}`);
  assert.equal(r.verdict, "MIXED", `實際：${JSON.stringify(r)}`);
});
