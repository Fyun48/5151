// 入口 × 資料對照表產生器 v2（2026-09-27）——跨模組呼叫圖。
//
// 為什麼要 v2：v1 只看 server.js 的直接引用，把 `/api/state` 判成 SQLite——但它呼叫的
// `loadListingPage`（`listingSearchPage.js`）匯入 `searchListingsAsync` / `listingStatsAsync`，
// 實際上走 PG。**主要入口判錯，這張表就不能用來決定要改什麼。** 所以改成跨模組追蹤。
//
// 方法：
//   1. 載入 v3/src/*.js 與 v3/src/repository/*.js，解析每個檔的 import 與頂層函式。
//   2. 由 db.js 算出「只走 SQLite」的函式集合（直接碰 db.prepare/exec 且本文無 driver 判斷，
//      再沿呼叫鏈傳遞）。
//   3. 由各 *Async.js 收集 async(PG) export 名稱。
//   4. 建 (檔, 函式) 節點與呼叫邊，沿邊做 fixpoint：每個節點可達的 SQLite 函式與 PG 函式。
//   5. 對 server.js 每條路由，取「本文直接引用 ＋ 呼叫到的本地/匯入函式」的聯集。
//
// 判定：
//   PG       只用得到 PG 函式
//   SQLite   只用得到 SQLite 函式
//   MIXED    兩者都到得了（需人工看哪一段走哪邊）
//   無直接DB 兩者都沒有
//
// 仍存在的限制（會寫進文件）：
//   - 動態組字串的 SQL、`db["x"]` 這類取用抓不到。
//   - 同名遮蔽、匿名回呼內的呼叫不追。
//   - 路由本文以「到下一個行首 });」近似。
//
// 🚨 2026-09-27 實測到**兩個方向相反的缺陷**，動手改這支之前務必先讀：
//
//   (1) 過度回報 —— 頂層函式的「本文」是「切到下一個 `function` 宣告」，
//       那假設頂層函式相鄰。server.js 不是：`yieldEventLoop()`（約行 431）後面接著
//       **51 個路由註冊**，下一個 `function` 宣告在很後面。於是它吞掉整段，
//       任何呼叫它的路由都繼承那一整段裡所有路由的函式引用。
//       實測後果：`GET /api/demo` 被判成 PG，只因為同一段裡的 `/api/health` 引用了
//       一個從 `*Async.js` 匯出的函式——而 /api/demo 根本沒碰它。
//
//   (2) 低估 —— `touches`（只走 SQLite 的函式集合）**只從 db.js 計算**。
//       但有一整類 helper 把 SQLite handle 當**參數**傳（`publicSupportConfig(db)`、
//       `listAnnouncementsAdmin(db)`…），它們住在自己的模組裡、**沒有 import db.js**，
//       因此永遠不進 `touches`。這些路由會被判成「無直接DB」，即使它們確實在寫 SQLite。
//       實測：`GET /api/support/public` 舊版 MIXED（一長串 sqlite 函式）、
//       把 (1) 修好之後變「無直接DB」——但它明明呼叫 `publicSupportConfig(db)`。
//
//   兩者都會讓判定失真，而且方向相反 ⇒ **不能只修一個就重新基準化**。
//   文件上的進度數字（SQLite 80／MIXED 36／PG 55）是用**現在這版**量的；
//   要換尺之前請先知會 Owner，並且兩個缺陷一起修、重跑一次完整基準。
//   詳見 docs/handoffs/PG-ISLAND-MIGRATION-PLAN-20260927.md。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const stripComments = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const read = (rel) => stripComments(readFileSync(path.join(SRC, rel), "utf8"));

const files = [
  ...readdirSync(SRC).filter((f) => f.endsWith(".js")),
  ...(existsSync(path.join(SRC, "repository"))
    ? readdirSync(path.join(SRC, "repository")).filter((f) => f.endsWith(".js")).map((f) => `repository/${f}`)
    : []),
];

const mods = new Map();
for (const rel of files) {
  const text = read(rel);
  const imports = new Map();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[2]));
    const target = base.endsWith(".js") ? base : `${base}.js`;
    for (const raw of m[1].split(",")) {
      const parts = raw.trim().split(/\s+as\s+/);
      const orig = (parts[0] || "").trim();
      const local = (parts[1] || parts[0] || "").trim();
      if (local) imports.set(local, { to: target, orig });
    }
  }
  const fns = new Map();
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  const hits = [...text.matchAll(re)];
  for (let i = 0; i < hits.length; i += 1) {
    fns.set(hits[i][1], text.slice(hits[i].index, i + 1 < hits.length ? hits[i + 1].index : text.length));
  }
  mods.set(rel, { text, imports, fns });
}

const DIRECT = /\bdb\.(prepare|exec|pragma|function)\s*\(|\bsqliteHandle\b/;
const DRIVER_AWARE = /resolveDbDriver|pgSharedDriver|writePath|sqliteFallback|postgresDriver|toPostgresSql/;
const dbMod = mods.get("db.js");
const touches = new Set();
for (const [name, body] of dbMod.fns) if (DIRECT.test(body) && !DRIVER_AWARE.test(body)) touches.add(name);
const callsIn = (body, name) => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\s*\\(`).test(body);
for (let r = 0; r < 12; r += 1) {
  let grew = false;
  for (const [name, body] of dbMod.fns) {
    if (touches.has(name) || DRIVER_AWARE.test(body)) continue;
    for (const callee of touches) if (callsIn(body, callee)) { touches.add(name); grew = true; break; }
  }
  if (!grew) break;
}

const pgFns = new Set();
for (const [rel, mod] of mods) {
  if (!rel.endsWith("Async.js")) continue;
  for (const name of mod.fns.keys()) pgFns.add(name);
}

const memo = new Map();
let resolving = new Set();
function resolveNode(rel, name) {
  const key = `${rel}::${name}`;
  if (memo.has(key)) return memo.get(key);
  // *Async.js 是 driver-aware 的入口：它內部為了 sqlite 模式會呼叫同步函式，
  // 但那是**同一個函式的替代分支**，不是呼叫端在用 SQLite。展開它會把每條
  // 已移植的路由都誤判成 MIXED（實測：/api/member-mail 就是這樣被誤判）。
  if (rel.endsWith("Async.js")) { const e = { sqlite: new Set(), pg: new Set() }; memo.set(key, e); return e; }
  const mod = mods.get(rel);
  const body = mod?.fns.get(name);
  const out = { sqlite: new Set(), pg: new Set() };
  if (!body) return out;
  if (resolving.has(key)) return out;
  resolving.add(key);
  for (const [local, target] of mod.imports) {
    if (!callsIn(body, local)) continue;
    if (target.to === "db.js" && touches.has(target.orig)) out.sqlite.add(target.orig);
    if (target.to.endsWith("Async.js") && pgFns.has(target.orig)) out.pg.add(target.orig);
    const next = resolveNode(target.to, target.orig);
    for (const n of next.sqlite) out.sqlite.add(n);
    for (const n of next.pg) out.pg.add(n);
  }
  for (const other of mod.fns.keys()) {
    if (other === name || !callsIn(body, other)) continue;
    const next = resolveNode(rel, other);
    for (const n of next.sqlite) out.sqlite.add(n);
    for (const n of next.pg) out.pg.add(n);
  }
  // 2026-09-27：**driver-aware 的函式不計入 SQLite 缺口**。
  // 例：server.js 的 `auditReq()` 保留同步 `appendAdminAudit` 給非 PG 分支用，
  // 但 `DB_DRIVER=postgres` 時走的是 `appendAdminAuditAsync`（PG）。分析器是靜態的，
  // 若不套這條規則，已轉換的路由會一直顯示 MIXED——我先前記錄過三次的那個過度回報。
  // ⚠️ 這是**保守度換取可用度**的取捨：若某個 driver-aware 函式在兩個分支都呼叫了
  // 只走 SQLite 的 helper，這裡會低估。判定本來就標「機械判定」，據此動手前仍須人工確認。
  if (/resolveDbDriver\s*\(/.test(body)) out.sqlite.clear();
  resolving.delete(key);
  memo.set(key, out);
  return out;
}
for (let r = 0; r < 5; r += 1) {
  memo.clear();
  resolving = new Set();
  for (const [rel, mod] of mods) for (const name of mod.fns.keys()) resolveNode(rel, name);
}

const TABLE_RE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
const BAD = new Set(["select", "where", "set", "values", "as", "on", "and", "or", "the", "a", "an", "it", "its", "this", "that", "not"]);
const fnOwner = new Map();
for (const [rel, mod] of mods) for (const n of mod.fns.keys()) if (!fnOwner.has(n)) fnOwner.set(n, rel);

// 表名也要沿呼叫鏈傳：getHousingData() 自己沒有 SQL，SQL 在它呼叫的 settingKey() 裡。
// 用跟判定同一張圖做 fixpoint，否則表名欄會全空（v2 第一版就是這樣）。
const tableMemo = new Map();
function tablesOfNode(rel, name) {
  const key = `${rel}::${name}`;
  if (tableMemo.has(key)) return tableMemo.get(key);
  const mod = mods.get(rel);
  const body = mod?.fns.get(name);
  const out = new Set();
  if (!body) return out;
  tableMemo.set(key, out);
  for (const m of body.matchAll(TABLE_RE)) {
    const t = m[1].toLowerCase();
    if (!BAD.has(t) && t.length > 2) out.add(t);
  }
  for (const [local, target] of mod.imports) {
    if (!callsIn(body, local)) continue;
    for (const t of tablesOfNode(target.to, target.orig)) out.add(t);
  }
  for (const other of mod.fns.keys()) {
    if (other === name || !callsIn(body, other)) continue;
    for (const t of tablesOfNode(rel, other)) out.add(t);
  }
  return out;
}
function tablesFor(names) {
  const out = new Set();
  for (const n of names) {
    const rel = fnOwner.get(n);
    if (!rel) continue;
    for (const t of tablesOfNode(rel, n)) out.add(t);
  }
  return out;
}

const server = mods.get("server.js");
const routeRe = /app\.(get|post|put|delete|patch)\(\s*"([^"]+)"\s*,/g;
const rows = [];
for (const m of server.text.matchAll(routeRe)) {
  const rest = server.text.slice(m.index);
  const stop = rest.indexOf("\n});");
  const body = stop === -1 ? rest.slice(0, 2500) : rest.slice(0, stop + 4);
  const isAsyncHandler = /app\.\w+\(\s*"[^"]+"\s*,\s*async\s/.test(body.slice(0, 200));

  const sqlite = new Set();
  const pg = new Set();
  for (const [local, target] of server.imports) {
    if (!callsIn(body, local)) continue;
    if (target.to === "db.js" && touches.has(target.orig)) sqlite.add(target.orig);
    if (target.to.endsWith("Async.js") && pgFns.has(target.orig)) pg.add(target.orig);
    const next = resolveNode(target.to, target.orig);
    for (const n of next.sqlite) sqlite.add(n);
    for (const n of next.pg) pg.add(n);
  }
  for (const other of server.fns.keys()) {
    if (!callsIn(body, other)) continue;
    const next = resolveNode("server.js", other);
    for (const n of next.sqlite) sqlite.add(n);
    for (const n of next.pg) pg.add(n);
  }

  const tables = new Set(tablesFor(sqlite));
  for (const t of tablesFor(pg)) tables.add(t);

  let verdict, evidence;
  if (pg.size && !sqlite.size) { verdict = "PG"; evidence = "機械判定"; }
  else if (sqlite.size && !pg.size) { verdict = "SQLite"; evidence = "機械判定"; }
  else if (sqlite.size && pg.size) { verdict = "MIXED"; evidence = "需人工確認"; }
  else { verdict = "無直接DB"; evidence = "未確認（可能間接）"; }

  rows.push({
    method: m[1].toUpperCase(), path: m[2], isAsyncHandler,
    sqlite: [...sqlite].sort(), pg: [...pg].sort(), tables: [...tables].sort(), verdict, evidence,
  });
}

const esc = (s) => String(s).replace(/\|/g, "\\|");
const tally = {};
for (const r of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;

console.log("<!-- 由 v3/scripts/route-data-map.mjs 產生，請勿手改 -->\n");
console.log(`共 **${rows.length}** 條入口。\n`);
console.log("| 判定 | 條數 |\n|---|---:|\n" + Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join("\n"));
console.log("\n| # | method | path | handler | 判定 | 證據 | SQLite 函式 | PG 函式 | 涉及表 |");
console.log("|---:|---|---|---|---|---|---|---|---|");
rows.forEach((r, i) => {
  console.log(`| ${i + 1} | ${r.method} | \`${esc(r.path)}\` | ${r.isAsyncHandler ? "async" : "sync"} | **${r.verdict}** | ${r.evidence} | ${esc(r.sqlite.join(", ")) || "—"} | ${esc(r.pg.join(", ")) || "—"} | ${esc(r.tables.join(", ")) || "—"} |`);
});
