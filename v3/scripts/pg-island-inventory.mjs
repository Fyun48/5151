// 機械化盤點：還有哪些正式路由／模組仍在呼叫 db.js 的同步（節點本機 SQLite）函式。
//
// 為什麼要做：2026-09-27 的會員 SMTP 問題是「誤打誤撞」發現的，代表人工抽查會漏。
// 這支腳本用靜態分析把所有呼叫點列出來，並標示是否已有 async/PG 對應版本。
//
// 方法：
//   1. 解析 db.js 的所有頂層函式，建立「會碰 SQLite」的集合
//      （直接出現 db.prepare／db.exec／db.pragma／sqliteHandle，或呼叫到集合內的其他函式），
//      以 fixpoint 迭代到收斂。
//   2. 解析每個 v3/src/*.js 從 ./db.js 匯入的名稱。
//   3. 在 server.js 抓出每個路由的處理函式本文，找出它引用了哪些「會碰 SQLite」的同步函式。
//   4. 收集所有 *Async.js 的 export，標示是否已有 ...Async 對應版本。
//
// 已知限制（必須跟報告一起講，不能假裝完備）：
//   - 只看**直接**引用；路由呼叫 A、A 再呼叫 db.js 的情況抓不到（跨檔沒有做呼叫圖）。
//   - 路由本文以「到下一個行首 });」近似，巢狀結構多層時可能多抓或少抓。
//   - 同名遮蔽、動態取用（db["foo"]）無法處理。
//   因此輸出是**候選清單**，不是證明；要據此修改前仍須人工確認。
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (f) => readFileSync(path.join(SRC, f), "utf8");

// ---- 1. db.js：哪些函式會碰 SQLite ----
const dbSrc = read("db.js");
const topFns = new Map();
{
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  const hits = [...dbSrc.matchAll(re)];
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : dbSrc.length;
    topFns.set(hits[i][1], dbSrc.slice(start, end));
  }
}
const DIRECT = /\bdb\.(prepare|exec|pragma|function)\s*\(|\bsqliteHandle\b/;
// 同步簽名但**內部已經分 driver**的函式（PG 島嶼模式）。這些不是缺口，必須排除，
// 否則清單會被偽陽性灌爆（例如 persistListing 會走 repository/writePath 寫 PG）。
const DRIVER_AWARE = /resolveDbDriver|pgSharedDriver|writePath|sqliteFallback|postgresDriver|toPostgresSql/;
const touches = new Set();
const driverAware = new Set();
for (const [name, body] of topFns) {
  if (!DIRECT.test(body)) continue;
  if (DRIVER_AWARE.test(body)) driverAware.add(name);
  else touches.add(name);
}
// fixpoint：呼叫到已知會碰 SQLite 的函式
for (let round = 0; round < 10; round += 1) {
  let grew = false;
  for (const [name, body] of topFns) {
    if (touches.has(name)) continue;
    // 若本文直接出現 driver 判斷，代表它自己會處理 PG，不算缺口。
    if (DRIVER_AWARE.test(body)) { driverAware.add(name); grew = true; continue; }
    for (const callee of touches) {
      if (new RegExp(`\\b${callee}\\s*\\(`).test(body)) { touches.add(name); grew = true; break; }
    }
  }
  if (!grew) break;
}

// ---- 2. 每個模組從 ./db.js 匯入了什麼 ----
function dbImports(text) {
  const names = new Set();
  const re = /import\s*\{([^}]*)\}\s*from\s*["']\.\/db\.js["']/g;
  for (const m of text.matchAll(re)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

// ---- 3. 所有 *Async.js 的 export（用來判斷是否已有 PG 對應版本）----
const asyncExports = new Set();
for (const file of readdirSync(SRC)) {
  if (!file.endsWith("Async.js")) continue;
  for (const m of read(file).matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) {
    asyncExports.add(m[1]);
  }
}

// ---- 4. server.js：路由 → 用到的同步 DB 函式 ----
const server = read("server.js");
const importedFromDb = dbImports(server);
const routeRe = /app\.(get|post|put|delete|patch)\(\s*"([^"]+)"\s*,/g;
const routes = [];
for (const m of server.matchAll(routeRe)) {
  const start = m.index;
  const rest = server.slice(start);
  const stop = rest.indexOf("\n});");
  const body = stop === -1 ? rest.slice(0, 2000) : rest.slice(0, stop + 4);
  const used = [...importedFromDb].filter((n) => touches.has(n) && new RegExp(`\\b${n}\\s*\\(`).test(body));
  if (used.length) routes.push({ method: m[1].toUpperCase(), path: m[2], used, isAsync: /app\.\w+\([^)]*,\s*async\s/.test(body.slice(0, 200)) });
}

// ---- 5. 其他模組的呼叫點 ----
const others = [];
for (const file of readdirSync(SRC).filter((f) => f.endsWith(".js") && f !== "db.js" && f !== "server.js")) {
  const text = read(file);
  const imported = dbImports(text);
  const used = [...imported].filter((n) => touches.has(n) && new RegExp(`\\b${n}\\s*\\(`).test(text));
  if (used.length) others.push({ file, used });
}

// ---- 輸出 ----
const hasAsync = (name) => asyncExports.has(`${name}Async`);
console.log(`## db.js「只走 SQLite」的函式：${touches.size} 個（另有 ${driverAware.size} 個已 driver-aware，已排除）\n`);
console.log(`## server.js 仍直接呼叫同步 DB 函式的路由：${routes.length} 條\n`);
for (const r of routes.sort((a, b) => a.path.localeCompare(b.path))) {
  const flag = r.used.map((n) => `${n}${hasAsync(n) ? "→有Async" : ""}`).join(", ");
  console.log(`${r.method} ${r.path}  [${r.isAsync ? "async" : "sync"}]  ${flag}`);
}
console.log(`\n## 其他模組仍直接呼叫同步 DB 函式：${others.length} 個檔案\n`);
for (const o of others) console.log(`${o.file}: ${o.used.join(", ")}`);
console.log(`\n## 已有的 *Async 版本數：${asyncExports.size}`);
