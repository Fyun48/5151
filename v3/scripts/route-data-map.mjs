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
// 跳過一個字串／模板字面量，回傳收尾引號之後的位置。
function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

// 🚨 2026-09-27 修正缺陷 (1)：頂層函式的本文原本是「切到下一個 `function` 宣告」，
// 那假設頂層函式相鄰。server.js 不是——`yieldEventLoop()`（約行 431）後面接著
// 51 個路由註冊，下一個 `function` 宣告在很後面，於是它的「本文」吞掉整段，
// 任何呼叫它的路由都繼承那一整段裡所有路由的函式引用。
// 實測後果：`GET /api/demo` 被判成 PG，只因為同段裡的 `/api/health` 引用了
// 一個 `*Async.js` 的函式——而 /api/demo 根本沒碰它。
//
// ⚠️ 實作順序很重要，這裡踩過一次：**不能**用「簽名後第一個 `{`」當本文起點。
// `function f(userId, { docType = "" } = {})` 的第一個 `{` 在**參數列**裡，
// 配對到參數的 `}` 就結束，本文被截斷——288 條裡 55 條判定改變，
// 連文件明寫「真的還沒轉換」的 `/api/admin/legal-copy` 都變成「無直接DB」。
// 正確做法：先跳過參數列（從 `(` 做括號配對），再取之後的第一個 `{`。
function sliceFunctionBody(text, start) {
  let i = text.indexOf("(", start);
  if (i === -1) return text.slice(start);
  let parenDepth = 0;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(text, i) - 1; continue; }
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) { i += 1; break; }
    }
  }
  const open = text.indexOf("{", i);
  if (open === -1) return text.slice(start);
  let depth = 0;
  i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = skipString(text, i); continue; }
    if (ch === "/") {
      // 正規表達式字面量的啟始判斷：前一個非空白字元不是值／識別字結尾時才算。
      let j = i - 1;
      while (j >= open && /\s/.test(text[j])) j -= 1;
      const prev = j >= open ? text[j] : "";
      const prevIsValue = /[A-Za-z0-9_$)\]}"'`]/.test(prev);
      const next = text[i + 1];
      if (!prevIsValue && next !== "/" && next !== "*") {
        i += 1;
        let inClass = false;
        while (i < text.length) {
          if (text[i] === "\\") { i += 2; continue; }
          if (text[i] === "[") inClass = true;
          else if (text[i] === "]") inClass = false;
          else if (text[i] === "/" && !inClass) break;
          i += 1;
        }
        i += 1;
        continue;
      }
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
    i += 1;
  }
  return text.slice(start);
}

//
//   (1) 過度回報 —— 頂層函式的「本文」是「切到下一個 `function` 宣告」，
//       那假設頂層函式相鄰。server.js 不是：`yieldEventLoop()`（約行 431）後面接著
//       **51 個路由註冊**，下一個 `function` 宣告在很後面。於是它吞掉整段，
//       任何呼叫它的路由都繼承那一整段裡所有路由的函式引用。
//       實測後果：`GET /api/demo` 被判成 PG，只因為同一段裡的 `/api/health` 引用了
//       一個從 `*Async.js` 匯出的函式——而 /api/demo 根本沒碰它。
//       → 已修：見下方 `sliceFunctionBody()`。
//
//   (2) 低估 —— `touches`（只走 SQLite 的函式集合）**只從 db.js 計算**。
//       但有一整類 helper 把 SQLite handle 當**參數**傳（`publicSupportConfig(db)`、
//       `listCampaignsAdmin(db)`、`ensureCommsSchema(conn)`…），它們住在自己的模組裡、
//       **沒有 import db.js**，因此永遠不進 `touches`。
//       實測：`GET /api/support/public` 明明呼叫 `publicSupportConfig(db)` 卻被判成
//       「無直接DB」；`/api/admin/campaigns` 更被低估成「只被 2 個函式卡住」，
//       實際上背後的 `comms.js` 是 812 行、約 20 個吃 handle 的函式。
//       → 已修：見下方 `sqliteNodes`（跨模組、依 (檔, 函式) 為鍵）。
//
//   ⚠️ 這兩個修正**改變了判定基準**。舊尺（未修）的數字與新尺的數字都保留在
//   docs/handoffs/PG-ISLAND-MIGRATION-PLAN-20260927.md，並列公告、不默默換掉。
//
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
  for (const hit of text.matchAll(re)) fns.set(hit[1], sliceFunctionBody(text, hit.index));
  mods.set(rel, { text, imports, fns });
}

// 「直接碰 SQLite handle」的判斷。2026-09-27 修正：**接收者要列白名單**。
// 這裡**不能**寫成 `\w+\.(prepare|exec|...)`——`re.exec()`、`dest.exec()`、`target.exec()`
// 是**正規表達式**的 exec（全站 10+13+8 處），把它們算進來會產生大量誤判。
// 實測全站 receiver 分佈：db 1027、conn 92（`conn.prepare(` 83／`conn.exec(` 9）、
// sqliteDb 7；其餘 re／dest／target／source／*Re 全是 regex。
const DIRECT = /\b(?:db|conn|sqliteDb)\.(prepare|exec|pragma|function)\s*\(|\bsqliteHandle\b/;
const DRIVER_AWARE = /resolveDbDriver|pgSharedDriver|writePath|sqliteFallback|postgresDriver|toPostgresSql/;
const callsIn = (body, name) => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\s*\\(`).test(body);

// 🚨 2026-09-27 修正缺陷 (2)：`touches` 原本**只從 db.js 計算**，於是「把 SQLite handle
// 當參數傳」的 helper（`publicSupportConfig(db)`、`listCampaignsAdmin(db)`、
// `ensureCommsSchema(conn)`…）永遠不進集合，那些路由被判成「無直接DB」。
// 實測後果：`GET /api/support/public` 一度從 MIXED 掉成「無直接DB」，
// 而它明明在寫 SQLite；`/api/admin/campaigns` 更被低估成「只被 2 個函式卡住」，
// 實際上背後的 `comms.js` 是 812 行、約 20 個吃 handle 的函式。
// 現在改成**跨模組**：任何模組裡「本文直接碰 handle 且不是 driver-aware」的函式都算 SQLite 節點。
const sqliteNodes = new Set();
const nodeKey = (rel, name) => `${rel}::${name}`;
for (const [rel, mod] of mods) {
  if (rel.endsWith("Async.js")) continue; // *Async.js 是 PG 入口，見 resolveNode 的說明
  for (const [name, body] of mod.fns) {
    if (DIRECT.test(body) && !DRIVER_AWARE.test(body)) sqliteNodes.add(nodeKey(rel, name));
  }
}
// 沿「同模組呼叫」傳遞：呼叫到 SQLite 節點的函式自己也算（builder 之類）。
for (let r = 0; r < 12; r += 1) {
  let grew = false;
  for (const [rel, mod] of mods) {
    if (rel.endsWith("Async.js")) continue;
    for (const [name, body] of mod.fns) {
      if (sqliteNodes.has(nodeKey(rel, name)) || DRIVER_AWARE.test(body)) continue;
      for (const other of mod.fns.keys()) {
        if (other === name || !sqliteNodes.has(nodeKey(rel, other))) continue;
        if (callsIn(body, other)) { sqliteNodes.add(nodeKey(rel, name)); grew = true; break; }
      }
    }
  }
  if (!grew) break;
}
// db.js 的舊集合保留：下面幾處（tablesOfNode 等）以「函式名」為索引。
const touches = new Set();
for (const name of mods.get("db.js").fns.keys()) if (sqliteNodes.has(nodeKey("db.js", name))) touches.add(name);

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
    if (sqliteNodes.has(nodeKey(target.to, target.orig))) out.sqlite.add(target.orig);
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
    if (sqliteNodes.has(nodeKey(target.to, target.orig))) sqlite.add(target.orig);
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
