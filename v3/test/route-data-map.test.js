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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const dir = path.dirname(new URL(import.meta.url).pathname);

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

test("分析器仍然涵蓋全部 302 條入口（不能因為改壞而少抓）", () => {
  // 288 → 292：第九十九批（C3 回饋附圖）新增四條
  //   POST   /api/feedback/attachments
  //   DELETE /api/feedback/attachments/:id
  //   GET    /api/feedback-attachments/:id/thumb
  //   GET    /api/feedback-attachments/:id
  // 292 → 293：同批的 A4 步行捷運查詢
  //   GET    /api/self-listings/mrt-access
  // 293 → 295：第一百批（R3）會員自己的未送出附件預覽（與 admin 路由分開）
  //   GET    /api/feedback/attachments/:id/thumb
  //   GET    /api/feedback/attachments/:id
  // 295 → 299：物件一鍵分享 Phase1 新增四條
  //   POST /api/listings/:id/share-link
  //   POST /api/public/listings/:id/share-events
  //   GET  /api/me/listings/share-stats
  //   GET  /api/admin/listings/share-stats
  // （`/l/:id` 也從「無直接DB」改為 PG：原本只送靜態檔，現在查 getSelfListingAsync 再注入 OG meta）
  // 299 → 302：物件內頁 Phase2 新增三條（皆 PG）
  //   GET /p/:id
  //   GET /api/public/listings/:id/detail
  //   GET /api/public/listings/:id/similar
  // 302 → 307：贊助連動 Phase3 新增五條（皆 PG）
  // 307 → 308：Phase3b 新增 GET /api/admin/support/entitlement/queue（PG）
  // 308 → 309：新增 POST /api/me/listings/clear-flags（PG）
  //   GET/POST /api/me/support/code
  //   POST /api/support/outbound
  //   GET/PUT /api/admin/support/entitlement
  // （`/api/support/webhook/:provider` 也從「無直接DB」改 PG：現在先讀 sponsorEntitlement flags）
  assert.equal(matched, 309, `應解析到 309 列，實際 ${matched}`);
  assert.match(out, /共 \*\*309\*\* 條入口/);
});

test("/api/health 必須是「無直接DB」——它只讀行程內計數器，不碰 DB", () => {
  const r = route("GET /api/health");
  assert.equal(r.verdict, "無直接DB",
    `曾被誤判成 PG：引用了一個住在 *Async.js 的函式，但那個函式不碰 DB。實際：${JSON.stringify(r)}`);
  assert.deepEqual(r.sqlite, [], "不該有任何 SQLite 函式");
});

test("函式本文被截斷的守衛：/api/admin/members 必須看得到它的呼叫（不得被判成「無直接DB」）", () => {
  // 這一條鎖的是「函式本文起點算錯」的那個修法錯誤：第一版用「簽名後第一個 `{`」當起點，
  // 遇到 `function f(a, { b = "" } = {})` 會配對到**參數的 `}`** 就結束 ⇒ 本文被截斷，
  // 整段路由的呼叫都看不到，判定被誤降成「無直接DB」（實測會讓 55 條判定改變）。
  //
  // ⚠️ 這一條**換過三次真值**：`SQLite ＋ listAdminMembers`（原始）→ `MIXED`（session 改走 PG，
  // 2026-09-27）→ 第五十四批把這條路由搬上 PG 之後**第九次過期**。
  // 現在改成**不隨進度過期**的性質：這條路由的分析結果必須「看得到東西」——
  // 被吞掉的路由會變成 `無直接DB` 而且 sqlite／pg 兩個集合都是空的
  // （另外，缺陷 (1) 的行為本身由 `MAP_MUTATIONS` 的合成來源樹守衛負責）。
  const r = route("GET /api/admin/members");
  assert.notEqual(r.verdict, "無直接DB",
    `路由本文被吞掉時會變成「無直接DB」。實際：${JSON.stringify(r)}`);
  const seen = [...r.sqlite, ...r.pg];
  assert.ok(seen.length > 0, `必須看得到至少一個呼叫。實際：${JSON.stringify(r)}`);
  assert.ok(seen.some((name) => /AdminMember|readSession/.test(name)),
    `必須看得到這一叢的進入點（listAdminMembers…Async／readSession…）。實際：${JSON.stringify(seen)}`);
});

test("傳參考的函式必須被看見（合成來源樹，不隨進度過期）", () => {
  // 🚨 缺陷 (6)：`callsIn()` 要求名字後面接 `(`，所以「**把函式當參數傳**」的寫法
  // （`buildDemoState({ listUserIds, getSettings, … })`）一條邊都建不起來——那些全是 db.js 的
  // SQLite 讀取，路由卻被判成 PG。
  //
  // ⚠️ 這一條原本拿 `/api/demo` 當真值，**第七十八批把該路由搬上 PG 之後第十次過期**
  // （路由本文已經只剩 `*Async` 名稱）。依既有紀律改成**合成來源樹**：在暫存目錄放一份尺規的
  // 複本 ＋ 最小 app，直接鎖住「以參考傳入的名字要被看見」這個**行為**。
  const tmp = mkdtempSync(path.join(tmpdir(), "v3-ruler-byref-"));
  try {
    mkdirSync(path.join(tmp, "v3/scripts"), { recursive: true });
    mkdirSync(path.join(tmp, "v3/src"), { recursive: true });
    copyFileSync(path.join(dir, "../scripts/route-data-map.mjs"), path.join(tmp, "v3/scripts/route-data-map.mjs"));
    writeFileSync(path.join(tmp, "v3/src/db.js"), [
      'import { DatabaseSync } from "node:sqlite";',
      'export const db = new DatabaseSync(":memory:");',
      "export function readThing() {",
      '  return db.prepare("SELECT 1 AS n").get();',
      "}",
      "export function statsOf() {",
      '  return db.prepare("SELECT COUNT(*) AS n FROM things").get();',
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(tmp, "v3/src/builder.js"), [
      'import { readThing, statsOf } from "./db.js";',
      "",
      "export function buildState({ readThing: read = readThing, statsOf: stats = statsOf } = {}) {",
      "  return { n: read().n, s: stats().n };",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(tmp, "v3/src/server.js"), [
      'import { readThing, statsOf } from "./db.js";',
      'import { buildState } from "./builder.js";',
      "const app = { get() {} };",
      "",
      'app.get("/api/byref", (req, res) => {',
      "  res.json(buildState({ readThing, statsOf }));",
      "});",
      "",
    ].join("\n"));
    const json = JSON.parse(execFileSync(process.execPath, ["v3/scripts/route-data-map.mjs", "--json"], {
      cwd: tmp, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    }));
    const row = json.rows.find((r) => r.path === "/api/byref");
    assert.ok(row, "合成樹要抓得到 /api/byref");
    assert.equal(row.verdict, "SQLite", `以參考傳入的 db.js 函式必須被看見。實際：${JSON.stringify(row)}`);
    for (const fn of ["readThing", "statsOf"]) {
      assert.ok(row.sqlite.includes(fn),
        `${fn} 是**傳參考**傳進 buildState 的 db.js 函式，必須被看見。實際 sqlite=${JSON.stringify(row.sqlite)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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

test("缺陷 (1)(2)(7)(8)(9) 的守衛（合成來源樹）：跨模組 helper、destructured default、方法呼叫、driver-aware 委派與字串內的名字", () => {
  // 📌 這一條**已經換過七次標的**，換的原因值得記下來（前六次都是「拿『目前還沒移植』
  // 當 ground truth」）：
  //   1. `/api/support/public`（`publicSupportConfig(db)`）→ 第十一批移植 ⇒ 失效。
  //   2. `/api/admin/support/dashboard`（`supportDashboard(db)`）→ 失效。
  //   3. `/api/media`（`listMemberMedia(db)`）→ 第十四批 ⇒ 失效。
  //   4. `/api/admin/campaigns`（`listCampaignsAdmin(db)`）→ 第十七批 ⇒ 失效。
  //   5. `/api/wish-rooms/example`（`getWishExample(db, …)`）→ 第二十七批 ⇒ 失效。
  //   6. `GET /api/admin/listings/search`（`searchAdminListings`）→ 第四十四批 ⇒ 失效。
  //   7. `GET /api/events/revision`（`changesSince`／`currentRevision`）→ 第四十九批 ⇒ 失效。
  //      **而這一次全站已經沒有「還沒移植」的標的了**（實測：把缺陷 (2) 套回去跑，
  //      288 條的判定一條都不會變）——所以不能再換標的。
  //
  // ✅ 這次改成**合成來源樹**：在暫存目錄裡放一份尺規的複本 ＋ 一個最小的合成 app，
  //    然後**同時**驗「修好的尺規看得到」與「套回缺陷 (2) 之後看不到」。
  //    這樣守衛直接鎖住尺規的**行為**，不再依賴任何真實路由的移植進度（不會再到期）。
  const tmp = mkdtempSync(path.join(tmpdir(), "v3-ruler-guard-"));
  try {
    mkdirSync(path.join(tmp, "v3/scripts"), { recursive: true });
    mkdirSync(path.join(tmp, "v3/src"), { recursive: true });
    copyFileSync(path.join(dir, "../scripts/route-data-map.mjs"), path.join(tmp, "v3/scripts/route-data-map.mjs"));
    // 合成 app：`external.js` 是「住在 db.js 以外、吃 handle 參數」的 helper（缺陷 (2) 的標的）。
    writeFileSync(path.join(tmp, "v3/src/db.js"), [
      'import { DatabaseSync } from "node:sqlite";',
      "export const db = new DatabaseSync(\":memory:\");",
      "export function readThing() {",
      '  return db.prepare("SELECT 1 AS n").get();',
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(tmp, "v3/src/external.js"), [
      "export function loadThing(db) {",
      '  return db.prepare("SELECT * FROM things").all();',
      "}",
      "",
      // 缺陷 (1) 的標的：簽名裡有 destructured default（`{ limit = 10 } = {}`），
      // 「簽名後第一個 `{`」會配對到**參數的 `}`** ⇒ 本文被截斷。
      "export function loadPaged(db, { limit = 10 } = {}) {",
      '  return db.prepare(`SELECT * FROM things LIMIT ${Number(limit) || 10}`).all();',
      "}",
      "",
    ].join("\n"));
    // 缺陷 (7) 的標的：一個**物件方法**剛好與 external.js 的 SQLite 函式同名。
    // 舊版 `callsIn()` 用 `\bname\s*\(`，會把 `store().saveThing()` 也當成呼叫那個函式。
    // `saveThing`：住在 db.js 以外、吃 handle 的 SQLite 節點（同時也是缺陷 (7) 的名字來源）。
    writeFileSync(path.join(tmp, "v3/src/saveThing.js"), [
      "export function saveThing(db) {",
      '  return db.prepare("SELECT 1 AS n").get();',
      "}",
      "",
    ].join("\\n"));
    // 缺陷 (8) 的標的：driver 判斷在**同模組的另一支**（`writeThings()`），wrapper 本體看不到
    // `resolveDbDriver()`，卻把同步 fallback 當引數傳進去。
    writeFileSync(path.join(tmp, "v3/src/dbDriver.js"), [
      "export function resolveDbDriver() { return process.env.DB_DRIVER || 'sqlite'; }",
      "",
    ].join("\n"));
    writeFileSync(path.join(tmp, "v3/src/fallback.js"), [
      "export function markThingDone(db) {",
      '  return db.prepare("SELECT 1 AS n").get();',
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(tmp, "v3/src/writes.js"), [
      'import { db } from "./db.js";',
      'import { markThingDone } from "./fallback.js";',
      'import { resolveDbDriver } from "./dbDriver.js";',
      "",
      "export function writeThings(options, runPostgres, runSqlite) {",
      "  const driver = options.driver || resolveDbDriver();",
      '  if (driver !== "postgres") return runSqlite();',
      "  return runPostgres();",
      "}",
      "",
      "export function markThingAsync(options = {}) {",
      '  return writeThings(options, () => ({ ok: true }), () => markThingDone(db));',
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(tmp, "v3/src/store.js"), [
      "export function makeStore() {",
      "  return { saveThing: () => 1 };",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(tmp, "v3/src/server.js"), [
      'import { db, readThing } from "./db.js";',
      // ⚠️ `saveThing` 一定要在 import 清單裡：缺陷 (7) 的假陽性正是「方法名剛好與
      // **已匯入的**同名函式撞名」（真實案例：`db.js` 匯入 `saveSiteBudget`，而 store 上
      // 也有一個同名方法）。
      'import { loadPaged, loadThing } from "./external.js";',
      'import { saveThing } from "./saveThing.js";',
      'import { makeStore } from "./store.js";',
      'import { markThingAsync } from "./writes.js";',
      "",
      "const app = { get() {} };",
      "",
      'app.get("/api/thing", (req, res) => {',
      "  res.json(loadThing(db));",
      "});",
      "",
      'app.get("/api/other", (req, res) => {',
      "  res.json(readThing());",
      "});",
      "",
      'app.get("/api/paged", (req, res) => {',
      "  res.json(loadPaged(db));",
      "});",
      "",
      'app.get("/api/methodcall", (req, res) => {',
      "  res.json(makeStore().saveThing());",
      "});",
      "",
      'app.get("/api/driverdelegate", (req, res) => {',
      "  res.json(markThingAsync({}));",
      "});",
      "",
      // 缺陷 (9) 的標的：SQLite 函式的名字只出現在**字串**裡（真實案例：
      // `res.setHeader("Server-Timing", `… stats;dur=…`)` 讓 `stats()` 整條鏈被算進來）。
      'app.get("/api/stringmention", (req, res) => {',
      '  res.setHeader("Server-Timing", `loadThing;dur=1`);',
      "  res.json({ ok: true });",
      "});",
      "",
    ].join("\n"));

    const runRuler = () => {
      const out = execFileSync(process.execPath, ["v3/scripts/route-data-map.mjs", "--json"], {
        cwd: tmp, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      });
      return new Map(JSON.parse(out).rows.map((r) => [`${r.method} ${r.path}`, r]));
    };

    const fixed = runRuler();
    const thing = fixed.get("GET /api/thing");
    assert.equal(thing.verdict, "SQLite", `合成樹的 /api/thing 應該被判成 SQLite。實際：${JSON.stringify(thing)}`);
    assert.ok(thing.sqlite.includes("loadThing"),
      `db.js 以外的 handle helper 必須被看見。實際 sqlite=${JSON.stringify(thing.sqlite)}`);
    // 缺陷 (1) 的標的：簽名有 destructured default 的 helper 也必須被看見。
    const paged = fixed.get("GET /api/paged");
    assert.equal(paged.verdict, "SQLite", `合成樹的 /api/paged 應該被判成 SQLite。實際：${JSON.stringify(paged)}`);
    assert.ok(paged.sqlite.includes("loadPaged"),
      `destructured default 的 helper 不得被截斷。實際 sqlite=${JSON.stringify(paged.sqlite)}`);

    // 缺陷 (7)：**方法呼叫不是函式呼叫**。`saveThing` 這個名字在 external.js 是 SQLite 節點，
    // 但 `/api/methodcall` 用的是 store.js 物件上的同名方法 ⇒ 不得被算成 SQLite 卡點。
    const methodRoute = fixed.get("GET /api/methodcall");
    assert.equal(methodRoute.verdict, "無直接DB",
      `物件方法不得被當成同名函式。實際：${JSON.stringify(methodRoute)}`);
    assert.deepEqual(methodRoute.sqlite, [], "方法呼叫不得帶進 external.js 的 saveThing");

    // 套回缺陷 (2)：sqlite 歸屬只看 db.js ⇒ `loadThing` 必須消失（沒消失代表守衛沒有牙齒）。
    const rulerPath = path.join(tmp, "v3/scripts/route-data-map.mjs");
    const original = readFileSync(rulerPath, "utf8");
    const anchor = "    if (sqliteNodes.has(nodeKey(target.to, target.orig))) sqlite.add(target.orig);";
    assert.ok(original.includes(anchor), "缺陷 (2) 的錨點必須還在（尺規改寫時要同步更新這一條）");
    writeFileSync(rulerPath, original.replace(anchor,
      '    if (target.to === "db.js" && touches.has(target.orig)) sqlite.add(target.orig);'));
    const defective = runRuler();
    const broken = defective.get("GET /api/thing");
    assert.equal(broken.verdict, "無直接DB", `缺陷 (2) 下應該完全看不到那個 helper。實際：${JSON.stringify(broken)}`);
    assert.deepEqual(broken.sqlite, [], "缺陷 (2) 下 sqlite 必須是空的");
    // 對照：另一條路由（helper 住在 db.js）在缺陷下不受影響——確保上面驗的是「跨模組」而不是全部消失。
    assert.ok(defective.get("GET /api/other").sqlite.includes("readThing"),
      "db.js 內的 helper 在缺陷 (2) 下仍然要被看見（這才是缺陷的定義）");

    // ---- 缺陷 (7)：把 `callsIn()` 還原成舊的 `\bname\s*\(`（方法呼叫也算） ----
    // ⚠️ 這裡用「切出區塊再換掉」而不是比對整段字串：那段程式碼裡有反引號與多層跳脫，
    // 用字串比對很容易因為一個反斜線就變成 no-op（第一版就是這樣，守衛看起來有跑其實沒換）。
    const callsInStart = original.indexOf("const callsIn = (body, name) => {");
    assert.ok(callsInStart > 0, "缺陷 (7) 的錨點必須還在（尺規改寫時要同步更新這一條）");
    const callsInEnd = original.indexOf("\n};", callsInStart) + 3;
    assert.ok(callsInEnd > callsInStart, "缺陷 (7) 的區塊結尾必須找得到");
    const oldCallsIn = [
      "const callsIn = (body, name) => {",
      "  const escaped = name.replace(/\\$/g, \"\\\\$\");",
      "  return new RegExp(`(^|[^.\\\\w$])${escaped}\\\\s*\\\\(`).test(body);",
      "};",
    ].join("\n") + "\n";
    assert.ok(original.slice(callsInStart, callsInEnd).includes("^|[^."), "切出來的必須是修好的那一版");
    writeFileSync(rulerPath, original.slice(0, callsInStart)
      + "const callsIn = (body, name) => new RegExp(`\\\\b${name.replace(/\\$/g, \"\\\\$\")}\\\\s*\\\\(`).test(body);\n"
      + original.slice(callsInEnd));
    const defective7 = runRuler();
    const brokenMethod = defective7.get("GET /api/methodcall");
    assert.equal(brokenMethod.verdict, "SQLite",
      `缺陷 (7) 下方法呼叫會被誤算。實際：${JSON.stringify(brokenMethod)}`);
    assert.ok(brokenMethod.sqlite.includes("saveThing"), "缺陷 (7) 下會把同名方法算成 SQLite 節點");
    // 對照：真正呼叫那個函式的路由在缺陷 (7) 下仍然正確（缺陷只影響「方法呼叫」那一類）。
    assert.ok(defective7.get("GET /api/thing").sqlite.includes("loadThing"));

    // ---- 缺陷 (8)：driver-aware 委派（driver 判斷在 helper 裡）----
    // 修好的尺規：`markThingDone` 只出現在傳給同模組 `writeThings()`（它自己含 `resolveDbDriver()`）
    // 的 fallback 引數裡 ⇒ 不算這條路由在用 SQLite。
    const delegateFixed = fixed.get("GET /api/driverdelegate");
    assert.equal(delegateFixed.verdict, "無直接DB",
      `driver-aware 委派的同步 fallback 不得被算成 SQLite。實際：${JSON.stringify(delegateFixed)}`);
    assert.deepEqual(delegateFixed.sqlite, [],
      "只在 fallback 引數裡出現的同步函式（含它的遞移卡點）都要被排除");
    // 套回缺陷 (8)：拿掉那條排除規則 ⇒ `markThingDone` 必須回來（沒回來代表守衛沒有牙齒）。
    const skipLine = "    if (delegated.size && onlyInsideDriverCalls(body, local, delegated)) continue;";
    assert.ok(original.includes(skipLine), "缺陷 (8) 的錨點必須還在（尺規改寫時要同步更新這一條）");
    writeFileSync(rulerPath, original.replace(skipLine, "    if (false) continue;"));
    const defective8 = runRuler();
    const delegateBroken = defective8.get("GET /api/driverdelegate");
    assert.equal(delegateBroken.verdict, "SQLite",
      `缺陷 (8) 下 fallback 會被誤算成 SQLite。實際：${JSON.stringify(delegateBroken)}`);
    assert.ok(delegateBroken.sqlite.includes("markThingDone"), "缺陷 (8) 下那個 fallback 會被算進去");
    // 對照：不經 driver-aware 委派的路由在缺陷 (8) 下不受影響。
    assert.ok(defective8.get("GET /api/thing").sqlite.includes("loadThing"));

    // ---- 缺陷 (9)：字串裡的名字不是引用 ----
    const stringFixed = fixed.get("GET /api/stringmention");
    assert.equal(stringFixed.verdict, "無直接DB",
      `字串裡的函式名不得被當成引用。實際：${JSON.stringify(stringFixed)}`);
    assert.deepEqual(stringFixed.sqlite, [], "字串內容不得帶進任何 SQLite 卡點");
    const stripAnchor = "  .replace(/`(?:[^`\\\\]|\\\\.)*`/g, \"``\");";
    assert.ok(original.includes(stripAnchor), "缺陷 (9) 的錨點必須還在（尺規改寫時要同步更新這一條）");
    writeFileSync(rulerPath, original.replace(stripAnchor, "  .replace(/__never__/g, \"`\");"));
    const defective9 = runRuler();
    const stringBroken = defective9.get("GET /api/stringmention");
    assert.equal(stringBroken.verdict, "SQLite",
      `缺陷 (9) 下字串內容會被誤算。實際：${JSON.stringify(stringBroken)}`);
    assert.ok(stringBroken.sqlite.includes("loadThing"), "缺陷 (9) 下字串裡的名字會被算進去");
    // 對照：真正呼叫那個函式的路由在缺陷 (9) 下不受影響。
    assert.ok(defective9.get("GET /api/thing").sqlite.includes("loadThing"));

    // ---- 缺陷 (1)：函式本文起點算錯（「簽名後第一個 {」＝ 參數的 }） ----
    const defect1From = `  let i = text.indexOf("(", start);
  if (i === -1) return text.slice(start);
  let parenDepth = 0;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "\u0060") { i = skipString(text, i) - 1; continue; }
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) { i += 1; break; }
    }
  }
  const open = text.indexOf("{", i);`;
    const defect1To = `  let i = start;
  const open = text.indexOf("{", i);`;
    assert.ok(original.includes(defect1From), "缺陷 (1) 的錨點必須還在（尺規改寫時要同步更新這一條）");
    writeFileSync(rulerPath, original.replace(defect1From, defect1To));
    const defective1 = runRuler();
    const brokenPaged = defective1.get("GET /api/paged");
    assert.deepEqual(brokenPaged.sqlite, [],
      `缺陷 (1) 下 destructured default 的 helper 必須消失。實際：${JSON.stringify(brokenPaged)}`);
    // 對照：沒有 destructured default 的那條在缺陷 (1) 下不受影響。
    assert.ok(defective1.get("GET /api/thing").sqlite.includes("loadThing"),
      "缺陷 (1) 只影響「簽名含 destructured default」的函式，其他 helper 仍要被看見");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("副檔名路由的守衛：符合靜態副檔名的路由只能是「不讀 session 的檔案伺服」", () => {
  // `isStaticAssetPath()`（auth.js）用「符合靜態副檔名、且不在 /api/ 底下」決定要不要
  // 跳過 session 解析。這個判斷的**前提**是「沒有動態路由長得像靜態檔」。
  // 目前唯一符合的是 `GET /sw.js`（純 sendFile，用 `_req`）。
  // 之後若有人加了會讀 session 的副檔名路由，這一條會紅——那時要把它加進
  // auth.js 的 `DYNAMIC_ASSET_PATHS`，**不要**直接把這一條刪掉。
  const EXT = /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot)$/i;
  const known = ["GET /sw.js"];
  const found = [...rows.keys()].filter((k) => EXT.test(k.slice(k.indexOf(" ") + 1)));
  assert.deepEqual(found.sort(), known,
    `出現新的「像靜態檔」的路由了。它會讀 session 嗎？會的話加進 DYNAMIC_ASSET_PATHS。`
    + `實際：${found.join(" / ") || "（無）"}`);
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

test("交接文件的「現況」表必須與尺規一致（兩邊都是解析來的，不會過期）", () => {
  // 📌 這一條取代了原本的「交叉驗證：/api/admin/legal-copy 必須看得到 SQLite 讀取」。
  // 舊寫法拿「某條路由還沒移植」當真值，**第八次過期**就發生在第五十批
  // （`getLegalCopy` 一移植，那條路由變 PG，守衛就從「會紅」變成什麼都驗不到）。
  //
  // ✅ 新寫法不寫死任何數字：文件那張表和尺規的 `--json` 統計**都是解析出來的**，
  //    所以不會隨進度過期；但「改了程式卻忘了更新交接文件」會當場變紅（這才是要守的紀律）。
  const docPath = path.join(dir, "../../docs/handoffs/PG-ISLAND-MIGRATION-PLAN-20260927.md");
  const doc = readFileSync(docPath, "utf8");
  const start = doc.indexOf("### 現況（可重跑）");
  assert.ok(start > 0, "交接文件裡必須有「### 現況（可重跑）」那一節");
  const end = doc.indexOf("\n## ", start);
  const section = doc.slice(start, end === -1 ? undefined : end);

  const json = JSON.parse(execFileSync(process.execPath, [SCRIPT, "--json"], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  }));
  const documented = (label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = section.match(new RegExp(`^\\|\\s*\\**${escaped}\\**\\s*\\|[^|]*\\|\\s*\\*\\*(\\d+)\\*\\*\\s*\\|\\s*$`, "m"));
    assert.ok(m, `交接文件的現況表裡找不到「${label}」那一列的「現在」值`);
    return Number(m[1]);
  };
  for (const verdict of ["SQLite", "MIXED", "無直接DB", "PG"]) {
    assert.equal(documented(verdict), json.tally[verdict] || 0,
      `交接文件與尺規的「${verdict}」不一致（跑 node v3/scripts/route-data-map.mjs --json 之後要同步改文件）`);
  }
  assert.equal(documented("缺口（SQLite＋MIXED）"), (json.tally.SQLite || 0) + (json.tally.MIXED || 0),
    "交接文件與尺規的「缺口」不一致");
});
