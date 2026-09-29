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

// 🚨 缺陷 (3)（2026-09-27 發現並修正）：原本用兩個 regexp 剝註解，**不會辨識字串與正規表達式**。
// 症狀：`/^https:\/\/(line\.me|lin\.ee)\//i` 這種「跳脫斜線後面緊接結尾斜線」會形成 `//`，
// 而它的前一個字元是 `\` 不是 `:`，所以 `(^|[^:])` 的保護沒生效 ⇒ **整行被當成註解刪掉**。
// 後果連鎖：刪掉的那段含 `))`，括號配對因此失衡，`sliceFunctionBody` 的本文往後吞掉
// 下一個函式 ⇒ `normalizeLineUrl()`（**純函式**，只做字串與 regex）被誤判成 SQLite，
// 再沿同模組呼叫擴散，一次虛報 **18 條路由**的缺口。
// 修法：逐字元走訪，字串與正規表達式字面量整段照抄，只移除真正的註解。
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "/") {
      // 正規表達式字面量？前一個非空白字元不是「值」的結尾時才算（與 sliceFunctionBody 同一套判斷）。
      let j = i - 1;
      while (j >= 0 && /\s/.test(text[j])) j -= 1;
      const prev = j >= 0 ? text[j] : "";
      const prevIsValue = /[A-Za-z0-9_$)\]}"'`]/.test(prev);
      if (!prevIsValue) {
        let k = i + 1;
        let inClass = false;
        while (k < text.length) {
          if (text[k] === "\\") { k += 2; continue; }
          if (text[k] === "[") inClass = true;
          else if (text[k] === "]") inClass = false;
          else if (text[k] === "/" && !inClass) break;
          k += 1;
        }
        out += text.slice(i, k + 1);
        i = k + 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}
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
// 🚨 2026-09-29 修正缺陷 (7)：**方法呼叫不是函式呼叫**。
//
// `budgetStore({…}).saveSiteBudget(partial)` 這種寫法，會被舊版算成「呼叫了 `saveSiteBudget()`」，
// 而 `fnOwner` 把它指到 `budgetGuard.js` 的同步實作 ⇒ `PUT /api/admin/providers/site-budget`
// 被判成 MIXED，**但那個 store 其實是 driver-aware 的**（PG 模式走 `saveSiteBudgetAsync`）。
// 這是**假陽性**：它讓一條已經移植好的路由永遠留在缺口裡，而且掩蓋了真正的卡點。
//
// 修法：名字前面是 `.`（或 `?.`）的不算 —— 那是物件上的同名方法，不是這個模組的函式。
// ⚠️ 宣告（`saveSiteBudget: …`）不受影響：那些是 `name:` 而不是 `name(`。
const callsIn = (body, name) => {
  const escaped = name.replace(/\$/g, "\\$");
  const re = new RegExp(`(^|[^.\\w$])${escaped}\\s*\\(`, "m");
  return re.test(body);
};

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

// 🚨 2026-09-29 修正缺陷 (8)：**driver-aware 的 wrapper 把 driver 判斷放在 helper 裡**。
//
// 例：`crawlerWrites.js` 的
//     export function markListingAliveAsync(postId, options = {}) {
//       return write(options, (exec) => markListingAliveRepo(…), () => markListingAliveSync(postId));
//     }
// 真正的 `resolveDbDriver()` 在**同模組的 `write()`** 裡，不在這一支的本體 ⇒ 舊規則
// （`/resolveDbDriver\s*\(/.test(body)`）看不到，於是 `markListingAliveSync` 被算成 SQLite 節點，
// 一路傳上去讓 `/api/listings/:id/recheck` 永遠留在缺口裡（**假陽性**：PG 模式下那個 fallback
// 是 `sqliteFallbackAllowed(…, {write:true})` fail-closed 的緊急出口，正常情況跑不到）。
//
// 修法（保守）：如果一個函式把某個名字**只**用在「呼叫同模組 driver-aware 函式」的引數裡
// （例如 `write(options, …, () => xxxSync(id))`），那個名字就不算這個函式在用 SQLite。
// 只要有任何一個 mention 落在那個呼叫之外，就照舊計入。
const driverAwareLocalNames = (rel) => {
  const mod = mods.get(rel);
  const out = new Set();
  if (!mod) return out;
  for (const [name, body] of mod.fns) {
    // 只有「本體自己就有 driver 判斷」的才算（保守：不做遞移）。
    if (!DRIVER_AWARE.test(body) || sqliteNodes.has(nodeKey(rel, name))) continue;
    out.add(name);
  }
  // 同模組的 driver-aware 函式也可能再委派給另一個（`write` → `postgresExec` 之類），
  // 但不做遞移（保守：只認本體就有 driver 判斷的）。
  return out;
};

// `name(` 的引數範圍（配對括號；找不到結尾就回 null）。
function callArgSpans(body, name) {
  const spans = [];
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");
  let m;
  while ((m = re.exec(body)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") { depth -= 1; if (depth === 0) break; }
    }
    if (depth === 0) spans.push([m.index, i + 1]);
  }
  return spans;
}

// 這個名字在 body 裡的**所有**出現是否都落在 driver-aware 呼叫的引數裡。
function onlyInsideDriverCalls(body, name, awareNames) {
  const spans = [];
  for (const aware of awareNames) spans.push(...callArgSpans(body, aware));
  if (!spans.length) return false;
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  let m;
  let seen = false;
  while ((m = re.exec(body)) !== null) {
    seen = true;
    if (!spans.some(([a, b]) => m.index >= a && m.index < b)) return false;
  }
  return seen;
}

const memo = new Map();
let resolving = new Map();

// 2026-09-27（Owner 方案 A）：session 不再必然讀節點本機 SQLite。
//
// 背景：`readSession()` → `findUserByEmail()` → `v3.db` 是步驟 3 最大的單一卡點，
// 137 條路由因此被判成 SQLite／MIXED。修法是 `server.js` 在**第一條路由之前**掛
// `app.use(resolveSession())`：那個中介層用 `readSessionAsync()` 向 PG 取身分、把結果
// 快取在 req 上，`readSession()` 只是讀快取（113 個呼叫點不必改）。
//
// ⚠️ 這裡是**實際去 server.js 檢查那個掛載點**，不是假設它存在：只有
//   (1) 找得到 `app.use(resolveSession(`
//   (2) 它出現在第一條 `app.<method>(` 之前
// 兩個條件都成立，`auth.js::readSession` 才不計入 SQLite 缺口。把中介層移走、改名、
// 或排到路由後面，判定就會自己退回 SQLite——這條規則可以被否證，不是信任宣告。
const SERVER_TEXT = mods.get("server.js").text;
const sessionMountIndex = SERVER_TEXT.search(/app\.use\(\s*resolveSession\s*\(/);
const firstRouteIndex = SERVER_TEXT.search(/app\.(get|post|put|delete|patch)\(\s*"/);
const sessionResolvedByPg = sessionMountIndex !== -1
  && (firstRouteIndex === -1 || sessionMountIndex < firstRouteIndex);

function resolveNode(rel, name) {
  const key = `${rel}::${name}`;
  if (memo.has(key)) return memo.get(key);
  // *Async.js 是 driver-aware 的入口：它內部為了 sqlite 模式會呼叫同步函式，
  // 但那是**同一個函式的替代分支**，不是呼叫端在用 SQLite。展開它會把每條
  // 已移植的路由都誤判成 MIXED（實測：/api/member-mail 就是這樣被誤判）。
  if (rel.endsWith("Async.js")) { const e = { sqlite: new Set(), pg: new Set() }; memo.set(key, e); return e; }
  // 已由 PG 解析的 session：殘留的同步 `findUserByEmail` 是「中介層沒跑到」的備援分支，
  // 與上面 *Async.js 的 sqlite 分支同理，不算這條路由在用 SQLite。
  if (sessionResolvedByPg && rel === "auth.js" && name === "readSession") {
    const e = { sqlite: new Set(), pg: new Set(["readSessionAsync"]) };
    memo.set(key, e);
    return e;
  }
  const mod = mods.get(rel);
  const body = mod?.fns.get(name);
  const out = { sqlite: new Set(), pg: new Set() };
  if (!body) return out;
  // 循環：回傳**目前累積的部分結果**，而不是一個全新的空集合。
  // 舊版回空集合會讓「先被走到的節點」靜靜吃掉循環另一端的函式——加邊竟然會讓
  // 別的節點的 sqlite 集合**變小**（單調性被破壞）。這裡先把 out 掛進 inProgress，
  // 讓重新進入的那一輪至少看得到已累積的部分。
  const inFlight = resolving.get(key);
  if (inFlight) return inFlight;
  resolving.set(key, out);
  // 這一支自己有沒有「同模組 driver-aware 委派」（見 onlyInsideDriverCalls 的說明）。
  const awareNames = driverAwareLocalNames(rel);
  const delegated = awareNames.size
    ? new Set([...mod.fns.keys()].filter((other) => other !== name && awareNames.has(other) && callsIn(body, other)))
    : new Set();
  for (const [local, target] of mod.imports) {
    if (!callsIn(body, local)) continue;
    // 只在 driver-aware 呼叫的引數裡出現 ⇒ 那是 fallback，不是這個函式在用 SQLite。
    // ⚠️ 要**整條邊**跳過（含下面的遞移展開）：只跳過「直接計入」的話，
    // `resolveNode(db.js::markListingAlive)` 還是會把 ensureUser／groupIdForPost 那串拉回來。
    if (delegated.size && onlyInsideDriverCalls(body, local, delegated)) continue;
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
// 迭代到**不再變動**為止（上限 20 輪）：固定跑 5 輪在有循環時可能還沒收斂，
// 而沒收斂的結果會隨走訪順序改變——同一個輸入卻因不相干的編輯而得到不同判定。
// 每次重算前清掉 memo，讓部分結果能被更完整的結果取代。
let tallyKey = "";
for (let r = 0; r < 20; r += 1) {
  memo.clear();
  resolving = new Map();
  for (const [rel, mod] of mods) for (const name of mod.fns.keys()) resolveNode(rel, name);
  const snapshot = [...memo.entries()]
    .map(([k, v]) => `${k}|${[...v.sqlite].sort().join(",")}|${[...v.pg].sort().join(",")}`)
    .sort().join("\n");
  if (snapshot === tallyKey) break;
  tallyKey = snapshot;
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

// 🚨 缺陷 (6)（2026-09-27 發現並修正）：**傳參考**的函式在路由本文裡看不到。
//
// `callsIn()` 要求名字後面接 `(`，所以 `buildDemoState({ listUserIds, getSettings,
// defaultUserId, listListings, stats })` 這種**把函式當參數傳**的寫法一條邊都建不起來
// ——`listUserIds`…`stats` 全是 db.js 的 SQLite 讀取，`/api/demo` 卻被判成 PG。
//
// 這個低估一直被掩蓋著：`/api/demo` 本文有 `readSession(req)`，而那條邊會拉到
// `findUserByEmail`，於是它「剛好」顯示成 SQLite。2026-09-27 session 改成 PG 解析之後，
// 掩蓋消失，`/api/demo` 立刻變成 `PG` 且 `sqlite=[]`——**低估是真的，不是新壞的**。
// 這一條同時是 route-data-map.test.js 的 ground truth（人工核對過 /api/demo 讀 SQLite），
// 不修的話那條守衛會變成永遠失敗、失去鑑別力。
//
// 保守度：只在**路由本文**這一層放寬（函式本文仍用 `callsIn`），而且排除
// `const/let/var/function <name>` 這種「同名區域變數宣告」——否則 `const stats = …`
// 會被誤認成引用到 db.js 的 `stats()`。
// 🚨 2026-09-29 修正缺陷 (9)：**字串裡的名字不是引用**。
//
// `GET /api/listings` 有一行
//     res.setHeader("Server-Timing", `list;dur=${…}, stats;dur=${…}`);
// 那個 `stats` 是**字串內容**，卻讓 `mentionsIn()` 把 db.js 的 `stats()` 整條鏈
// （countWatched／loadFlagMap／ensureUser／getUserById／listUserIds／sqlExcludeFixtureRows）
// 全部算進這條路由（7 個假卡點）。
// 修法：裸提及的檢查先**去掉字串與樣板字面值**。⚠️ 只在這一層做——`callsIn()` 仍然用原始
// 本文，所以真的寫在 `${…}` 裡的呼叫不會被吃掉（`callsIn` 也優先於這條）。
const stripStrings = (text) => String(text)
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/`(?:[^`\\]|\\.)*`/g, "``");

const mentionsIn = (body, name) => {
  const n = name.replace(/\$/g, "\\$");
  // 有「呼叫」就一定算引用——這一條優先於下面的同名守衛。
  // 🚨 這裡踩過一次：第一版先套同名守衛，於是 `const getSystemCrawl = …` 這種
  // 「區域變數與匯入同名」的 handler 連**原本看得到的呼叫邊**都被吃掉，
  // 4 條路由的 sqlite 集合反而**變小**（單調性被破壞）。順序反過來就單調了。
  if (callsIn(body, name)) return true;
  // `(?!\\s*:)`：**物件字面量的鍵**不算引用。實測踩到——reject-match 的
  // `res.json({ stats: await listingStatsAsync(…) })` 因為鍵叫 `stats`，把 db.js 的
  // `stats()` 整條鏈（countWatched／loadFlagMap／sqlExcludeFixtureRows…）拉了進來，
  // 7 個 SQLite 函式全部誤報。`{ stats }` 這種 shorthand 沒有冒號，仍然算值。
  if (!new RegExp(`(?<![\\w$.])${n}(?![\\w$])(?!\\s*:)`).test(stripStrings(body))) return false;
  // 只有「裸提及」才需要排除同名區域變數宣告（否則 `const stats = …` 會被誤認成 db.js 的 stats()）。
  return !new RegExp(`\\b(?:const|let|var|function|class)\\s+${n}\\b`).test(body);
};

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
    if (!mentionsIn(body, local)) continue;
    if (sqliteNodes.has(nodeKey(target.to, target.orig))) sqlite.add(target.orig);
    if (target.to.endsWith("Async.js") && pgFns.has(target.orig)) pg.add(target.orig);
    const next = resolveNode(target.to, target.orig);
    for (const n of next.sqlite) sqlite.add(n);
    for (const n of next.pg) pg.add(n);
  }
  for (const other of server.fns.keys()) {
    if (!mentionsIn(body, other)) continue;
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

// `--json`：給下游分析用的機器可讀輸出（**不改變預設行為、不改變基準**）。
// 為什麼要：後續要拿這份判定排優先順序（例如「哪些卡點是真的在**寫** SQLite」），
// 那些分析不該自己重寫一份「模組載入 ＋ 函式本文切片」的邏輯——兩份一定會漂移。
// ⚠️ **不要在這裡用 `process.exit(0)`**：輸出被**管線**接走時 stdout 是非同步的，
// `process.exit()` 會在 flush 之前把行程收掉 ⇒ 下游收到**被截斷的 JSON**。
// （實測：`> file` 正常、`execFileSync()` 拿到 Invalid JSON——我就在這裡踩了一次。）
// 用 if/else 讓行程自然結束即可。
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total: rows.length, tally, rows }, null, 2));
} else {
  console.log("<!-- 由 v3/scripts/route-data-map.mjs 產生，請勿手改 -->\n");
  console.log(`共 **${rows.length}** 條入口。\n`);
  console.log("| 判定 | 條數 |\n|---|---:|\n" + Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join("\n"));
  console.log("\n| # | method | path | handler | 判定 | 證據 | SQLite 函式 | PG 函式 | 涉及表 |");
  console.log("|---:|---|---|---|---|---|---|---|---|");
  rows.forEach((r, i) => {
    console.log(`| ${i + 1} | ${r.method} | \`${esc(r.path)}\` | ${r.isAsyncHandler ? "async" : "sync"} | **${r.verdict}** | ${r.evidence} | ${esc(r.sqlite.join(", ")) || "—"} | ${esc(r.pg.join(", ")) || "—"} | ${esc(r.tables.join(", ")) || "—"} |`);
  });
}
