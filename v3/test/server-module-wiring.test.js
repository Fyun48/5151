// server.js（與其他進入點）的「接線」守衛（2026-09-30，第九十批）。
//
// 為什麼需要這一支：2026-09-30 正式站壞了兩次，兩次都是**接線**問題，而且 CI 全綠：
//
//   1. 第四十八批把 `/api/consents` 改成 async 島嶼時，順手移除了
//      `listMyConsents`／`pendingMemberDocuments` 的 import，但 `/api/me` 那兩行**還在呼叫同步版**
//      ⇒ 已登入的會員每次打 `/api/me` 都丟 `ReferenceError`（HTML 500 → 前端顯示
//      「Unexpected token '<'」／登入後仍顯示訪客）。沒有任何測試執行過「已登入的 /api/me」。
//   2. 第五十四批的 `adminMembersAsync.execFor()` 少了一個 `await`
//      （`(await import(...)).sharedPgDriver()` 回傳 Promise）⇒ `pgDriver.query is not a function`。
//      離線與 live 測試**都注入 exec／pgDriver**，所以只有正式站（島嶼自己呼叫 `sharedPgDriver()`）
//      才會踩到。
//
// 這一支把這兩類「只有正式路徑才會踩到」的接線錯誤變成 CI 會紅的斷言。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const moduleFiles = readdirSync(SRC).filter((f) => f.endsWith(".js")).sort();
const readSrc = (file) => readFileSync(path.join(SRC, file), "utf8");

/** 這一行的程式碼部分（去掉行註解；只在確定不是字串裡的情況下才切，夠用且不會誤傷 URL）。 */
function codePart(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return line;
}

/**
 * 解析一個檔案的 import 綁定（含 `a as b`）與本地宣告（含解構）。
 * 用括號配對而不是正則，避免「註解裡的逗號／括號」讓解析歪掉。
 */
function collectBindings(text) {
  const imported = new Set();
  const declared = new Set();
  for (let i = text.indexOf("import"); i !== -1; i = text.indexOf("import", i + 6)) {
    // 只認靜態 import：`import ... from "...";`（動態 import() 由 declared 的解構覆蓋）
    const braceAt = text.indexOf("{", i);
    if (braceAt === -1 || braceAt - i > 40) continue;
    const closeAt = text.indexOf("}", braceAt);
    if (closeAt === -1) continue;
    const tail = text.slice(closeAt, closeAt + 40);
    if (!/^\}\s*from\s*["']/.test(tail)) continue;
    // ⚠️ import 區塊內可以寫 `//` 註解（本專案就寫過），切逗號前要先把它去掉，
    // 否則那一段的最後一個名字會被整段連同註解一起丟掉（＝假綠，這次真的發生過）。
    const block = text.slice(braceAt + 1, closeAt).replace(/\/\/[^\n]*/g, "");
    for (const part of block.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) imported.add(name);
    }
  }
  for (const line of text.split("\n")) {
    const code = codePart(line);
    if (!code) continue;
    const fn = code.match(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (fn) declared.add(fn[1]);
    const cls = code.match(/class\s+([A-Za-z_$][\w$]*)/);
    if (cls) declared.add(cls[1]);
    // `const x = …`、`const { a, b } = …`、`const [a] = …`
    const simple = code.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (simple) declared.add(simple[1]);
    for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
      for (const part of m[1].split(",")) {
        const name = part.split(":").pop().trim().replace(/=.*$/, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
      }
    }
    for (const m of code.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().replace(/=.*$/, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
      }
    }
  }
  return { imported, declared };
}

/** 檔名 → 它 export 的頂層名字（function／const／class）。 */
function exportedNames() {
  const out = new Map();
  for (const file of moduleFiles) {
    const text = readSrc(file);
    for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g)) {
      if (!out.has(m[1])) out.set(m[1], file);
    }
  }
  return out;
}

test("server.js 呼叫的模組 export 都必須真的 import（第四十八批的 ReferenceError 型缺陷）", () => {
  const server = readSrc("server.js");
  const { imported, declared } = collectBindings(server);
  const exports = exportedNames();
  const missing = [];
  for (const [name, file] of exports) {
    if (file === "server.js") continue;
    if (imported.has(name) || declared.has(name)) continue;
    // 只在「真的被呼叫」時才算：逐行找 `name(`，並排除註解行與 `x.name(`。
    const callRe = new RegExp(`(?<![\\w$.])${name}\\s*\\(`);
    const hit = server.split("\n").some((line) => {
      const code = codePart(line);
      return code ? callRe.test(code) : false;
    });
    if (hit) missing.push(`${name}()（export 自 ${file}）`);
  }
  assert.deepEqual(missing, [],
    `server.js 呼叫了沒有 import 的名字（執行時是 ReferenceError，正式站會變 HTML 500）：\n${missing.join("\n")}`);
});

test("島嶼自己解析 sharedPgDriver() 時一定要 await（第五十四批的 Promise 型缺陷）", () => {
  // ⚠️ 不能只用「這行有沒有出現 await」判斷：出錯的那一版是
  //     (await import("./pgSharedDriver.js")).sharedPgDriver()
  // ——行內**有** await，但 await 的是 import，不是呼叫本身。
  // 判準：把「還沒關閉的 `(`」疊起來，只要有一個的內容以 `await` 開頭，就算這個呼叫被 await 住；
  // 出錯版的 `(await import(...))` 在呼叫之前就已經收合，所以疊起來是空的 ⇒ 判為沒 await。
  const awaitedAt = (line, callIdx) => {
    if (/await\s+$/.test(line.slice(0, callIdx))) return true;
    const open = [];
    for (let i = 0; i < callIdx; i += 1) {
      if (line[i] === "(") open.push(i);
      else if (line[i] === ")" && open.length) open.pop();
    }
    return open.some((at) => /^\(\s*await\b/.test(line.slice(at)));
  };
  const offenders = [];
  for (const file of moduleFiles) {
    if (file === "pgSharedDriver.js") continue;         // 定義處
    const text = readSrc(file);
    text.split("\n").forEach((line, index) => {
      const code = codePart(line);
      if (!code || !code.includes("sharedPgDriver()")) return;
      const callIdx = code.indexOf("sharedPgDriver()");
      if (awaitedAt(code, callIdx)) return;
      offenders.push(`${file}:${index + 1} ${code.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `sharedPgDriver() 是 async，少一個 await 會拿到 Promise（pgDriver.query is not a function）：\n${offenders.join("\n")}`);

  // 判準本身的單元測試（把兩種寫法都餵進去，確認它真的分得出來）
  const correct = '  const pgDriver = options.pgDriver || (await (await import("./pgSharedDriver.js")).sharedPgDriver());';
  const buggy = '  const pgDriver = options.pgDriver || (await import("./pgSharedDriver.js")).sharedPgDriver();';
  const plain = '  const pool = pgPool || (await sharedPgDriver());';
  const bare = '    const driver = options.pgDriver || await sharedPgDriver();';
  const noAwait = '  const driver = sharedPgDriver();';
  for (const [line, want] of [[correct, true], [buggy, false], [plain, true], [bare, true], [noAwait, false]]) {
    assert.equal(awaitedAt(line, line.indexOf("sharedPgDriver()")), want, `判準對這一行要回 ${want}：${line.trim()}`);
  }
});

test("collectBindings 的解析力：吃得下多行 import、別名與解構（否則上面兩條會是假綠）", () => {
  const sample = `
import {
  listMyConsentsAsync,
  // 區塊內註解是合法的，而且**註解後面那個名字**曾經因為沒被去註解而整個被丟掉
  pendingRequiredDocumentsAsync as pendingAsync,
} from "./memberConsentsAsync.js";
import {
  // 這一行的存在就是為了讓「沒去註解」的實作解析失敗：名字緊接在註解後面、同一個逗號區段。
  commentedNameAfterComment,
} from "./db.js";
import { sqliteHandle } from "./db.js";
const { a, b: c } = await import("./x.js");
const [d] = await Promise.all([]);
function local() {}
const arrow = () => {};
`;
  const { imported, declared } = collectBindings(sample);
  for (const name of ["listMyConsentsAsync", "pendingAsync", "sqliteHandle", "commentedNameAfterComment"]) {
    assert.ok(imported.has(name), `${name} 應該被解析成 import（註解緊接在名字前面時最容易漏）`);
  }
  for (const name of ["a", "c", "d", "local", "arrow"]) {
    assert.ok(declared.has(name), `${name} 應該被解析成本地宣告`);
  }
  assert.ok(!imported.has("pendingRequiredDocumentsAsync"), "別名要以本地名字為準");
});

test("回饋狀態更新走 PG 的 CRM 島嶼（第九十批：同步版是靜默失效）", () => {
  const server = readSrc("server.js");
  assert.ok(
    server.includes("await enqueueCrmFromFeedbackAsync(Number(req.params.id) || 0)"),
    "PATCH /api/admin/feedback/:id 要用 PG 島嶼",
  );
  assert.ok(
    !server.includes("enqueueCrmFromFeedback(opsDeliveryDb()"),
    "不得再呼叫同步版（讀本機 crm_cases、寫本機 crm_outbox ⇒ PG 模式下靜默失效）",
  );
});
