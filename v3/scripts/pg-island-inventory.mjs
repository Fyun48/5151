// 機械化盤點：還有哪些正式路由／模組仍在呼叫 db.js 的同步（節點本機 SQLite）函式。
//
// 為什麼要做：2026-09-27 的會員 SMTP 問題是「誤打誤撞」發現的，代表人工抽查會漏。
// 這支腳本用靜態分析把所有呼叫點列出來，並標示是否已有 async/PG 對應版本。
//
// 方法：
//   1. 解析 db.js 的所有頂層函式，建立「會碰 SQLite」的集合
//      （直接出現 db.prepare／db.exec／db.pragma／sqliteHandle，或呼叫到集合內的其他函式），
//      以 fixpoint 迭代到收斂。**函式體以配對大括號切出來，且先遮掉註解與字串**，
//      所以「隔壁的 SQL 常數提到某個函式名」不會被誤算成呼叫（2026-10-11 精度修正 ①）。
//   2. 解析每個 v3/src/*.js 從 ./db.js 匯入的名稱。
//   3. 在 server.js 抓出每個路由的處理函式本文，找出它引用了哪些「會碰 SQLite」的同步函式。
//   4. 收集所有 *Async.js 的 export，標示是否已有 ...Async 對應版本。
//   5. **可達性分級**（2026-10-11 精度修正 ②③）：對每個呼叫點判斷「PG 模式下可不可達」，
//      只有可達的才算 error：
//        (a) 閘後死碼：`if (<driver> === "postgres") return …;` 之後、同一大括號區塊內的程式碼；
//            以及 `if (<driver> !== "postgres") { … }`／`if (!isPg(options)) …` 這種
//            「只有非 PG 才會執行」的區塊與單行 early-return。
//        (b) `??` fallback：`candidates ?? listMatchCandidates(…)`。RHS 是「呼叫端注入值」
//            （外層函式的參數）為 null 時的退路，PG 呼叫端一定把值注入進來 ⇒ 非 PG 可達。
//        (c) SQLite-only 鏈：某個同步函式（含 db.js 入口）的所有呼叫點都在上述死區內，
//            或只被另一個死函式呼叫 ⇒ 整條鏈標記為「非 PG 可達」。
//      判定依據必須是**結構性的**（驅動閘門表示式、參數注入、呼叫鏈），不是檔名白名單。
//
// 已知限制（必須跟報告一起講，不能假裝完備）：
//   - 只看**直接**引用；路由呼叫 A、A 再呼叫 db.js 的情況抓不到（跨檔沒有完整呼叫圖）。
//   - 路由本文以「到下一個行首 });」近似，巢狀結構多層時可能多抓或少抓。
//   - 同名遮蔽、動態取用（db["foo"]）無法處理。
//   - PG 閘門只認「由 resolveDbDriver()/driver/dbDriver 組出來的 postgres 比較」與同檔定義的
//     isPg() 謂詞；`options.driver !== "postgres"` 這種「只認顯式選項」的比較**不算**閘門
//     （未傳 options.driver 時它仍是 true ⇒ SQLite 路徑真的會跑），寧可保守留在 error。
//   - `??` fallback 的判定只看「LHS 是外層函式參數」；若 PG 呼叫端實際上傳 null，
//     這個 fallback 就會是可達的，本尺規分辨不出來（需要資料流分析）。
//   - `withFallback(…, runPostgres, runSqlite)` 這種回呼：runSqlite 在 catch 分支（PG 讀取失敗、
//     且 sqliteFallbackAllowed() 允許）仍會被呼叫 ⇒ 一律留在 error，不當死碼。
//   因此輸出是**候選清單**，不是證明；要據此修改前仍須人工確認。
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_SRC = fileURLToPath(new URL("../src/", import.meta.url));
const IDENT = /[A-Za-z0-9_$]/;

// ---------- 文字層工具：遮罩 + 配對 ----------

// 把註解、字串、樣板字串、regex literal 換成空白（保留長度與換行），
// 讓所有「找呼叫／找大括號」的工作都在純程式碼上做。
function maskCode(text) {
  const out = text.split("");
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const prevSignificant = (from) => {
    for (let k = from - 1; k >= 0; k -= 1) {
      if (/\s/.test(text[k])) continue;
      return text[k];
    }
    return "";
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      let j = text.indexOf("\n", i);
      if (j === -1) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] !== "/" && text[i + 1] !== "*" && /[([{,;=:!&|?+%*~^<>]/.test(prevSignificant(i))) {
      // regex literal：掃到下一個未轉義的 /
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const ch = text[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) { j += 1; break; }
        else if (ch === "\n") break;
        j += 1;
      }
      if (j <= n && text[j - 1] === "/") {
        blank(i, j);
        i = j;
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === c) { j += 1; break; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

// masked[openIdx] 必須是 ( { [ 之一；回傳對應結尾索引，找不到回 -1。
function matchPair(masked, openIdx) {
  const open = masked[openIdx];
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return -1;
  let depth = 0;
  for (let i = openIdx; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 從 start 起算一個敘述句的結尾（跳過巢狀括號；遇到外層 } 或 limit 就停）。
function endOfStatement(masked, start, limit) {
  let depth = 0;
  for (let i = start; i < limit; i += 1) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "}") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (c === ";" && depth === 0) return i + 1;
  }
  return limit;
}

function mergeIntervals(list) {
  const sorted = [...list].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function inIntervals(list, idx) {
  return list.some(([s, e]) => idx >= s && idx < e);
}

// 把某些區間挖成空白（用來只保留「PG 可達」的函式體）。
function blankIntervals(text, intervals) {
  if (!intervals.length) return text;
  const out = text.split("");
  for (const [s, e] of intervals) {
    for (let k = s; k < e && k < out.length; k += 1) if (out[k] !== "\n") out[k] = " ";
  }
  return out.join("");
}

// ---------- 函式解析 ----------

function paramNames(masked, openIdx) {
  const close = matchPair(masked, openIdx);
  if (close === -1) return [];
  const inner = masked.slice(openIdx + 1, close);
  const names = new Set();
  let depth = 0;
  let cur = "";
  const parts = [];
  for (const ch of inner) {
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (part.startsWith("{")) {
      const end = matchPair(part, 0);
      const body = end === -1 ? part : part.slice(1, end);
      for (const m of body.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) names.add(m[0]);
    } else if (part.startsWith("[")) {
      const end = matchPair(part, 0);
      const body = end === -1 ? part : part.slice(1, end);
      for (const m of body.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) names.add(m[0]);
    } else {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(part);
      if (m) names.add(m[1]);
    }
  }
  return [...names];
}

// 找出所有函式（含巢狀 function；`const f = (…) => …` 只處理區塊體或單敘述體）。
function findFunctions(masked) {
  const fns = [];
  const push = (name, exported, paramsStart, bodyStart, bodyEnd, index) => {
    if (!name || bodyStart === -1) return;
    fns.push({ name, exported, paramsStart, bodyStart, bodyEnd, index, params: paramNames(masked, paramsStart) });
  };
  const declRe = /(?:^|[\s;{}()])(export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  for (const m of masked.matchAll(declRe)) {
    const name = m[2];
    const paramsStart = m.index + m[0].length - 1;
    const paramsEnd = matchPair(masked, paramsStart);
    if (paramsEnd === -1) continue;
    let i = paramsEnd + 1;
    while (i < masked.length && /\s/.test(masked[i])) i += 1;
    if (masked[i] !== "{") continue;
    const bodyEnd = matchPair(masked, i);
    if (bodyEnd === -1) continue;
    push(name, Boolean(m[1]), paramsStart, i, bodyEnd, m.index);
  }
  const arrowRe = /(?:^|[\n;{}])\s*(export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/g;
  for (const m of masked.matchAll(arrowRe)) {
    const name = m[2];
    const paramsStart = m.index + m[0].length - 1;
    const paramsEnd = matchPair(masked, paramsStart);
    if (paramsEnd === -1) continue;
    let i = paramsEnd + 1;
    while (i < masked.length && /\s/.test(masked[i])) i += 1;
    if (!masked.startsWith("=>", i)) continue;
    i += 2;
    while (i < masked.length && /\s/.test(masked[i])) i += 1;
    if (masked[i] === "{") {
      const bodyEnd = matchPair(masked, i);
      if (bodyEnd === -1) continue;
      push(name, Boolean(m[1]), paramsStart, i, bodyEnd, m.index);
    } else {
      const bodyEnd = endOfStatement(masked, i, masked.length);
      push(name, Boolean(m[1]), paramsStart, i, bodyEnd, m.index);
    }
  }
  return fns.filter((f, idx, arr) => arr.findIndex((g) => g.index === f.index && g.name === f.name) === idx);
}

function innermostFunction(fns, idx) {
  let best = null;
  for (const f of fns) {
    if (idx >= f.bodyStart && idx <= f.bodyEnd && (!best || f.bodyStart > best.bodyStart)) best = f;
  }
  return best;
}

function isTopLevelFunction(fns, fn) {
  return !fns.some((g) => g !== fn && g.bodyStart <= fn.index && fn.index <= g.bodyEnd);
}

// ---------- PG 閘門判定 ----------

const PG_TRUE = /(?:^|[^=!<>])(?:===|==)\s*["']postgres["']/;
const PG_FALSE = /!==?\s*["']postgres["']/;
const DRIVER_WORD = /(?:^|[^\w$.])(driver|dbDriver)\b/;
const RESOLVE_DRIVER = /resolveDbDriver\s*\(/;
const PROP_DRIVER = /[\w$\])]\s*\.\s*driver\b/;

// 去掉最外層多餘的括號，回傳 { text, orAtTop }。
function stripParens(cond) {
  let t = cond.trim();
  while (t.startsWith("(") && matchPair(t, 0) === t.length - 1 && t.length > 2) t = t.slice(1, -1).trim();
  return t;
}

// 條件式裡有沒有「頂層」的 ||（把 (…) 群組內部的 || 視為驅動表示式的一部分）。
function hasTopLevelOr(cond) {
  const depth0 = cond.replace(/\([^()]*\)/g, "()");
  return depth0.includes("||");
}

// PG 閘門謂詞：同檔定義 isPg()/isPostgres() 這類「driver === postgres」的 helper。
// 結構以遮罩文字找（大括號配對比較穩），「body 裡是否真的在比 postgres」用原始文字判斷
// （`"postgres"` 在遮罩後會變成空白）。
function pgPredicateNames(rawText, maskedText) {
  const names = new Set();
  const isPgBody = (from, to) => {
    const body = rawText.slice(from, to);
    return /postgres/.test(body) && /resolveDbDriver\s*\(/.test(body);
  };
  const scanArrowOrFn = (m, nameGroup) => {
    const name = m[nameGroup];
    const paramsStart = m.index + m[0].length - 1;
    const paramsEnd = matchPair(maskedText, paramsStart);
    if (paramsEnd === -1) return;
    let i = paramsEnd + 1;
    while (i < maskedText.length && /\s/.test(maskedText[i])) i += 1;
    if (maskedText.startsWith("=>", i)) {
      i += 2;
      while (i < maskedText.length && /\s/.test(maskedText[i])) i += 1;
      let bodyEnd;
      if (maskedText[i] === "{") bodyEnd = matchPair(maskedText, i) + 1;
      else {
        bodyEnd = i;
        while (bodyEnd < maskedText.length && !/[;\n]/.test(maskedText[bodyEnd])) bodyEnd += 1;
      }
      if (bodyEnd > i && isPgBody(i, bodyEnd)) names.add(name);
      return;
    }
    if (maskedText[i] !== "{") return;
    const bodyEnd = matchPair(maskedText, i);
    if (bodyEnd !== -1 && isPgBody(i, bodyEnd)) names.add(name);
  };
  for (const m of maskedText.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*\(/g)) scanArrowOrFn(m, 1);
  for (const m of maskedText.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g)) scanArrowOrFn(m, 1);
  return names;
}

// 回傳 "pgTrue" | "pgFalse" | null。
// 只有「driver/dbDriver，或 resolveDbDriver()，或同檔 isPg() 謂詞」參與的 postgres 比較才算閘門。
function classifyGate(cond, predicates, driverVars) {
  const text = stripParens(cond);
  if (!text || hasTopLevelOr(text)) return null;
  const predList = [...predicates];
  const mentionsDriver = RESOLVE_DRIVER.test(text) || predList.some((p) => new RegExp(`(?:^|[^\\w$.])${p}\\s*\\(`).test(text));
  let mentionsLocalDriver = false;
  const word = DRIVER_WORD.exec(text);
  if (word && driverVars.has(word[1])) mentionsLocalDriver = true;
  // `options.driver === "postgres"` 這種「只認呼叫端顯式選項」的比較**不算**閘門：
  // 未傳 options.driver 時它仍是 false，SQLite 路徑照樣會跑 ⇒ 保守留在 error。
  if (PROP_DRIVER.test(text) && !RESOLVE_DRIVER.test(text)) return null;
  if (!mentionsDriver && !mentionsLocalDriver) return null;
  const negated = predList.some((p) => new RegExp(`!\\s*${p}\\s*\\(`).test(text));
  if (PG_FALSE.test(text) || negated) return "pgFalse";
  if (PG_TRUE.test(text)) return "pgTrue";
  return null;
}

// 一個函式內被判為「PG 不可達」的偏移區間。
// 條件式必須用**原始文字**（`"postgres"` 在遮罩後會變成空白），其他結構掃描用遮罩文字。
function deadRegions(rawText, masked, fn, predicates) {
  const driverVars = new Set();
  const bodyText = masked.slice(fn.bodyStart, fn.bodyEnd);
  for (const m of bodyText.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=[^;]*resolveDbDriver\s*\(/g)) driverVars.add(m[1]);
  for (const p of fn.params) driverVars.add(p);
  const regions = [];
  const re = /\bif\s*\(/g;
  re.lastIndex = fn.bodyStart;
  let m;
  while ((m = re.exec(masked)) !== null) {
    if (m.index >= fn.bodyEnd) break;
    const condStart = m.index + m[0].length - 1;
    const condEnd = matchPair(masked, condStart);
    if (condEnd === -1 || condEnd > fn.bodyEnd) continue;
    const kind = classifyGate(rawText.slice(condStart + 1, condEnd), predicates, driverVars);
    if (!kind) continue;
    let i = condEnd + 1;
    while (i < fn.bodyEnd && /\s/.test(masked[i])) i += 1;
    const consStart = i;
    const consEnd = masked[i] === "{" ? matchPair(masked, i) + 1 : endOfStatement(masked, i, fn.bodyEnd);
    if (consEnd <= consStart) continue;
    let j = consEnd;
    while (j < fn.bodyEnd && /\s/.test(masked[j])) j += 1;
    let elseStart = -1;
    let elseEnd = -1;
    if (masked.startsWith("else", j) && !IDENT.test(masked[j + 4] || "")) {
      let k = j + 4;
      while (k < fn.bodyEnd && /\s/.test(masked[k])) k += 1;
      elseStart = k;
      elseEnd = masked[k] === "{" ? matchPair(masked, k) + 1 : endOfStatement(masked, k, fn.bodyEnd);
    }
    if (kind === "pgFalse") {
      regions.push([consStart, consEnd]);
      continue;
    }
    // pgTrue
    if (elseStart !== -1 && elseEnd > elseStart) regions.push([elseStart, elseEnd]);
    const consText = masked.slice(consStart, consEnd).replace(/^\{/, "").replace(/\}$/, "").trim();
    if (elseStart === -1 && /^(return|throw)\b/.test(consText)) {
      // early return：同一大括號區塊內、這句之後都不會在 PG 模式跑到
      let open = -1;
      for (let k = fn.bodyStart; k < m.index; k += 1) {
        if (masked[k] === "{") {
          const close = matchPair(masked, k);
          if (close > m.index) open = k;
        }
      }
      const blockEnd = open === -1 ? fn.bodyEnd : matchPair(masked, open);
      regions.push([consEnd, blockEnd]);
    }
  }
  return mergeIntervals(regions);
}

// `candidates ?? listMatchCandidates(…)`：RHS 是外層函式「注入參數」為 null 時的退路。
function isInjectedNullishFallback(masked, idx, fn) {
  if (!fn) return false;
  let i = idx - 1;
  while (i >= 0 && /\s/.test(masked[i])) i -= 1;
  if (!(masked[i] === "?" && masked[i - 1] === "?")) return false;
  let j = i - 2;
  while (j >= 0 && /\s/.test(masked[j])) j -= 1;
  let s = j;
  while (s >= 0 && IDENT.test(masked[s])) s -= 1;
  const lhs = masked.slice(s + 1, j + 1);
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(lhs) && fn.params.includes(lhs);
}

// ---------- 舊版（粗切片）判定：只用來列出「曾經被誤報、現在排除」的符號 ----------
// 保留舊演算法輸出的唯一目的是讓三份清單可以對照（沒有任何一項會憑空消失）；
// 它**不參與** error/info 分級。
function legacyTouchSet(dbSrc) {
  const topFns = new Map();
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  const hits = [...dbSrc.matchAll(re)];
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : dbSrc.length;
    topFns.set(hits[i][1], dbSrc.slice(start, end));
  }
  // 允許 `db\n  .prepare(` 這種換行鏈式寫法（曾經只有 `\bdb\.` 會漏掉它們）。
  const DIRECT = /\bdb\s*\.\s*(prepare|exec|pragma|function)\s*\(|\bsqliteHandle\b/;
  const DRIVER_AWARE = /resolveDbDriver|pgSharedDriver|sharedPgDriver|writePath|sqliteFallback|postgresDriver|toPostgresSql/;
  const touches = new Set();
  const driverAware = new Set();
  for (const [name, body] of topFns) {
    if (!DIRECT.test(body)) continue;
    if (DRIVER_AWARE.test(body)) driverAware.add(name);
    else touches.add(name);
  }
  for (let round = 0; round < 10; round += 1) {
    let grew = false;
    for (const [name, body] of topFns) {
      if (touches.has(name)) continue;
      if (DRIVER_AWARE.test(body)) { driverAware.add(name); grew = true; continue; }
      for (const callee of touches) {
        if (new RegExp(`\\b${callee}\\s*\\(`).test(body)) { touches.add(name); grew = true; break; }
      }
    }
    if (!grew) break;
  }
  return touches;
}

// ---------- 主分析 ----------

export function analyzeInventory({ srcDir = DEFAULT_SRC } = {}) {
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".js")).sort();
  const raw = new Map(files.map((f) => [f, readFileSync(path.join(srcDir, f), "utf8")]));
  const masked = new Map(files.map((f) => [f, maskCode(raw.get(f))]));
  const fnsByFile = new Map(files.map((f) => [f, findFunctions(masked.get(f))]));
  const predicatesByFile = new Map(files.map((f) => [f, pgPredicateNames(raw.get(f), masked.get(f))]));

  // 檔內「識別字後接 (」的呼叫點索引（跳過 obj.name( 這種屬性存取）
  const callsByFile = new Map();
  // 檔內所有「識別字出現的位置」（含只是被當成值傳遞的參考）
  const occurrencesByFile = new Map();
  // import/export 宣告的區間：那裡的名字不是「使用」，不能拿來當可達性證據
  const declRangesByFile = new Map();
  for (const f of files) {
    const map = new Map();
    const occ = new Map();
    const text = masked.get(f);
    for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
      const name = m[1];
      const pos = m.index + m[0].indexOf(name);
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(pos);
    }
    for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      const name = m[1];
      const pos = m.index + m[0].indexOf(name);
      if (!occ.has(name)) occ.set(name, []);
      occ.get(name).push(pos);
    }
    callsByFile.set(f, map);
    occurrencesByFile.set(f, occ);
    const ranges = [];
    for (const m of text.matchAll(/\bimport\b[\s\S]*?\bfrom\b\s*["'][^"']*["']\s*;?/g)) ranges.push([m.index, m.index + m[0].length]);
    for (const m of text.matchAll(/\bexport\s*\{[^}]*\}\s*;?/g)) ranges.push([m.index, m.index + m[0].length]);
    declRangesByFile.set(f, ranges);
  }
  const callSites = (file, name) => callsByFile.get(file)?.get(name) || [];
  const occurrenceSites = (file, name) => occurrencesByFile.get(file)?.get(name) || [];

  // 誰從哪個檔匯入了什麼（跨檔呼叫點）
  const importers = new Map(); // `${target}|${name}` -> [file]
  const importsOf = new Map(); // file -> [{name,target}]
  for (const f of files) {
    const list = [];
    for (const m of raw.get(f).matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/([^"']+)["']/g)) {
      for (const decl of m[1].split(",")) {
        const name = decl.trim().split(/\s+as\s+/).pop().trim();
        if (!name) continue;
        list.push({ name, target: m[2] });
        const key = `${m[2]}|${name}`;
        if (!importers.has(key)) importers.set(key, []);
        importers.get(key).push(f);
      }
    }
    importsOf.set(f, list);
  }

  const regionsByFn = new Map(); // fn -> dead intervals
  const regionsOf = (file, fn) => {
    if (!regionsByFn.has(fn)) regionsByFn.set(fn, deadRegions(raw.get(file), masked.get(file), fn, predicatesByFile.get(file)));
    return regionsByFn.get(fn);
  };

  // ---- 可達性 fixpoint：本地／匯出函式在所有（檔內＋跨檔）呼叫點都死 ⇒ 整支死 ----
  const allFns = [];
  for (const f of files) for (const fn of fnsByFile.get(f)) allFns.push({ file: f, fn });
  const fnKey = (file, fn) => `${file}:${fn.index}:${fn.name}`;
  const fnDead = new Map();
  // 同名函式的「定義處」也會被 `name(` 的規則命中；定義標頭（含名稱到大括號前）一律不算呼叫點。
  const defHeader = (file, name) => (fnsByFile.get(file) || [])
    .filter((f) => f.name === name)
    .map((f) => [f.index, f.paramsStart]);
  const realSites = (file, name) => {
    const headers = defHeader(file, name);
    return callSites(file, name).filter((idx) => !headers.some(([s, e]) => idx >= s && idx <= e));
  };
  // 一個函式的「使用點」＝識別字出現的位置（呼叫、或只是被當值傳遞／回呼），
  // 扣掉 import/export 宣告與自己的定義標頭。只有所有使用點都死，這支函式才死。
  // （教訓：`withPgCrawlOwner(driver, execute, …)` 這種傳參考的用法，用「只看呼叫」會誤判成死。）
  const usesOf = (file, name) => {
    const headers = defHeader(file, name);
    const decls = declRangesByFile.get(file) || [];
    return occurrenceSites(file, name).filter(
      (idx) => !headers.some(([a, b]) => idx >= a && idx <= b) && !decls.some(([a, b]) => idx >= a && idx < b),
    );
  };
  const sitesOfFn = (file, fn) => {
    const out = usesOf(file, fn.name).map((idx) => ({ file, idx }));
    for (const other of importers.get(`${file.replace(/^.*\//, "")}|${fn.name}`) || []) {
      for (const idx of usesOf(other, fn.name)) out.push({ file: other, idx });
    }
    return out;
  };
  const siteDead = (file, idx, { skipChain = false } = {}) => {
    const fn = innermostFunction(fnsByFile.get(file) || [], idx);
    if (!fn) return false;
    if (!skipChain && fnDead.get(fnKey(file, fn))) return true;
    if (inIntervals(regionsOf(file, fn), idx)) return true;
    if (isInjectedNullishFallback(masked.get(file), idx, fn)) return true;
    return false;
  };
  for (let round = 0; round < 10; round += 1) {
    let changed = false;
    for (const { file, fn } of allFns) {
      if (fnDead.get(fnKey(file, fn))) continue;
      const sites = sitesOfFn(file, fn);
      if (!sites.length) continue;
      if (sites.every((s) => siteDead(s.file, s.idx))) {
        fnDead.set(fnKey(file, fn), true);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // ---- db.js：精確的「會碰 SQLite」函式集（函式體精準切片 + 遮罩 + 只算 PG 可達的呼叫） ----
  const dbFile = "db.js";
  const dbFns = fnsByFile.get(dbFile) || [];
  // 只挖掉「函式內的閘後死碼」；一個函式是否 PG 可達是**呼叫點**的事，
  // 不能拿來挖自己的函式體（否則整條 SQLite-only 鏈會從 touches 掉出去，反而看不見）。
  const deadInDb = [];
  for (const fn of dbFns) deadInDb.push(...regionsOf(dbFile, fn));
  const liveDb = blankIntervals(masked.get(dbFile), mergeIntervals(deadInDb));
  const topFns = dbFns.filter((fn) => isTopLevelFunction(dbFns, fn));
  const bodyOf = (fn) => liveDb.slice(fn.bodyStart, fn.bodyEnd);
  // 允許 `db\n  .prepare(` 這種換行鏈式寫法（曾經只有 `\bdb\.` 會漏掉它們）。
  const DIRECT = /\bdb\s*\.\s*(prepare|exec|pragma|function)\s*\(|\bsqliteHandle\b/;
  const DRIVER_AWARE = /resolveDbDriver|pgSharedDriver|sharedPgDriver|writePath|sqliteFallback|postgresDriver|toPostgresSql/;
  const touches = new Set();
  const driverAware = new Set();
  for (const fn of topFns) {
    // `sqliteHandle()` 本身就是「取得同步 handle」，即使函式體只有 `return db;` 也算 SQLite 存取。
    const isTouch = DIRECT.test(bodyOf(fn)) || fn.name === "sqliteHandle";
    if (!isTouch) continue;
    if (DRIVER_AWARE.test(bodyOf(fn))) driverAware.add(fn.name);
    else touches.add(fn.name);
  }
  for (let round = 0; round < 10; round += 1) {
    let grew = false;
    for (const fn of topFns) {
      if (touches.has(fn.name)) continue;
      const body = bodyOf(fn);
      if (DRIVER_AWARE.test(body)) { driverAware.add(fn.name); grew = true; continue; }
      for (const callee of touches) {
        if (new RegExp(`(?<![\\w$.])${callee}\\s*\\(`).test(body)) { touches.add(fn.name); grew = true; break; }
      }
    }
    if (!grew) break;
  }
  for (const name of [...touches]) if (driverAware.has(name)) touches.delete(name);
  const legacyTouches = legacyTouchSet(raw.get(dbFile));
  const pureExcluded = [...legacyTouches].filter((n) => !touches.has(n) && !driverAware.has(n));

  // ---- 每個模組呼叫了哪些同步 DB 函式，逐呼叫點分級 ----
  const hasAsync = new Set();
  for (const f of files) {
    if (!f.endsWith("Async.js")) continue;
    for (const m of masked.get(f).matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) hasAsync.add(m[1]);
  }

  const dbImportsOf = (f) => (importsOf.get(f) || []).filter((i) => i.target === "db.js").map((i) => i.name);
  const errors = [];
  const infos = [];
  const excluded = [];
  // 舊版是在**原始文字**上比對 `\bsym\s*\(`，註解與字串裡的出現也會被算成呼叫點。
  // 這裡重現同一個比對，只是為了把「舊版命中、新版確認不是程式碼」的符號列進第 3 段，
  // 讓三份清單可以完全對照（沒有任何一項會憑空消失）。
  const legacyMention = (f, sym) => new RegExp(`\\b${sym}\\s*\\(`).test(raw.get(f));
  for (const f of files) {
    if (f === dbFile) continue;
    const imported = new Set(dbImportsOf(f));
    for (const sym of imported) {
      const sites = realSites(f, sym);
      if (!sites.length) {
        if (legacyTouches.has(sym) && legacyMention(f, sym)) {
          excluded.push({ file: f, symbol: sym, reason: "舊版在原始文字命中 name(；新版確認那不是程式碼裡的呼叫點（註解／字串）" });
        }
        continue;
      }
      // driver-aware 的函式自己會在內部分 driver（例如 persistListing 走 repository/writePath 寫 PG），
      // 依本腳本原本的設計排除，不列為島（要改這個判定必須另外舉證）。
      if (touches.has(sym)) {
        const live = sites.filter((idx) => !siteDead(f, idx));
        if (live.length) {
          errors.push({ file: f, symbol: sym, hops: live.length, hasAsync: hasAsync.has(`${sym}Async`) });
          continue;
        }
        const reasons = new Set();
        for (const idx of sites) {
          const fn = innermostFunction(fnsByFile.get(f), idx);
          if (fn && fnDead.get(fnKey(f, fn))) reasons.add("chain:SQLite-only 鏈");
          else if (fn && inIntervals(regionsOf(f, fn), idx)) reasons.add("gate:driver 閘後死碼");
          else if (isInjectedNullishFallback(masked.get(f), idx, fn)) reasons.add("fallback:?? 注入值");
        }
        infos.push({ file: f, symbol: sym, reasons: [...reasons] });
      } else if (pureExcluded.includes(sym)) {
        excluded.push({ file: f, symbol: sym, reason: "舊版粗篩誤報：函式體沒有真實 SQLite 存取" });
      }
    }
  }

  // ---- server.js：路由 → 用到的同步 DB 函式（保守：命中一律 error） ----
  const serverFile = "server.js";
  const serverRaw = raw.get(serverFile) || "";
  const serverMasked = masked.get(serverFile) || "";
  const serverImports = new Set(dbImportsOf(serverFile));
  const routes = [];
  for (const m of serverRaw.matchAll(/app\.(get|post|put|delete|patch)\(\s*"([^"]+)"\s*,/g)) {
    const rest = serverMasked.slice(m.index);
    const stop = rest.indexOf("\n});");
    const body = stop === -1 ? rest.slice(0, 2000) : rest.slice(0, stop + 4);
    const used = [...serverImports].filter((n) => touches.has(n) && new RegExp(`(?<![\\w$.])${n}\\s*\\(`).test(body));
    if (used.length) {
      routes.push({ method: m[1].toUpperCase(), path: m[2], used, isAsync: /app\.\w+\([^)]*,\s*async\s/.test(body.slice(0, 200)) });
    }
  }

  const counts = {
    error: errors.length + routes.length,
    info: infos.length,
    excluded: excluded.length,
  };
  return {
    srcDir,
    touches,
    driverAware,
    pureExcluded,
    routes,
    errors,
    infos,
    excluded,
    hasAsync,
    counts,
  };
}

export function formatReport(result) {
  const lines = [];
  lines.push(
    `## db.js「只走 SQLite」的函式：${result.touches.size} 個（另有 ${result.driverAware.size} 個已 driver-aware，已排除）`,
  );
  lines.push(`## 已有的 *Async 版本數：${result.hasAsync.size}`);
  lines.push("");
  lines.push("【PG 可達・仍碰同步 SQLite（error）】");
  for (const r of [...result.routes].sort((a, b) => a.path.localeCompare(b.path))) {
    const flag = r.used.map((n) => `${n}${result.hasAsync.has(`${n}Async`) ? "→有Async" : ""}`).join(", ");
    lines.push(`ROUTE ${r.method} ${r.path}  [${r.isAsync ? "async" : "sync"}]  ${flag}`);
  }
  for (const e of result.errors.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol))) {
    lines.push(`${e.file}: ${e.symbol}${e.hasAsync ? "→有Async" : ""}（PG 可達呼叫點 ${e.hops} 個）`);
  }
  lines.push(`（共 ${result.counts.error} 項）`);
  lines.push("");
  lines.push("【PG 不可達（死碼／早退之後）（info）】");
  for (const i of result.infos.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol))) {
    const why = i.reasons.length ? i.reasons.join("＋") : "非 PG 可達";
    lines.push(`${i.file}: ${i.symbol}（${why}）`);
  }
  lines.push(`（共 ${result.counts.info} 項）`);
  lines.push("");
  lines.push("【純函式／非 SQLite 存取（已排除）（info）】");
  for (const x of result.excluded.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol))) {
    lines.push(`${x.file}: ${x.symbol}（${x.reason}）`);
  }
  lines.push(`（共 ${result.counts.excluded} 項）`);
  lines.push("");
  lines.push(`PG-REACHABLE-SYNC-SQLITE: ${result.counts.error}`);
  return `${lines.join("\n")}\n`;
}

function cliSrcDir() {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith("--src=") || a.startsWith("--root="));
  if (eq) return path.resolve(eq.split("=").slice(1).join("="));
  const i = argv.findIndex((a) => a === "--src" || a === "--root");
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return DEFAULT_SRC;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.stdout.write(formatReport(analyzeInventory({ srcDir: cliSrcDir() })));
}
