// 匯入匯出的一致性檢查（靜態，不執行任何模組）。
//
// 為什麼要有：2026-09-26 的 personalFlagsAsync.js 誤把 `setFlags` 從 personalFlags.js 匯入
// （它其實在 db.js）。離線測試沒涵蓋那個模組，所以 CI 全綠、PR 也合併了，直到
// build-production-image 的隔離 smoke test 才以
// `SyntaxError: does not provide an export named 'setFlags'` 擋下來——這種錯誤會讓服務起不來。
//
// 這裡**不執行**模組（v3/src 有些模組在匯入時會做網路檢查、開計時器），只用文字掃描：
// 對每個 `import { … } from "./x.js"`，確認 x.js 真的匯出了那些名字。
// 這是刻意的近似：`export *` 或不存在的檔案一律跳過，寧可漏報也不要誤報。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const srcDir = path.join(import.meta.dirname, "..", "src");

function moduleFiles() {
  const out = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) out.push(path.join(srcDir, entry.name));
    if (entry.isDirectory() && entry.name === "repository") {
      for (const sub of readdirSync(path.join(srcDir, entry.name))) {
        if (sub.endsWith(".js")) out.push(path.join(srcDir, entry.name, sub));
      }
    }
  }
  return out.sort();
}

// 收集一個檔案「送出來的名字」：export function/const/let/var/class、export { a, b as c }、
// export { x } from "…"。有 export * 時回 null（代表無法靜態判定，跳過檢查）。
function exportedNames(source) {
  const names = new Set();
  if (/^\s*export\s*\*/m.test(source)) return null;
  const declRe = /^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of source.matchAll(declRe)) names.add(m[1]);
  const listRe = /^\s*export\s*\{([^}]*)\}/gm;
  for (const m of source.matchAll(listRe)) {
    for (const part of m[1].split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.add(asMatch ? asMatch[1] : piece.split(/\s+/)[0]);
    }
  }
  if (/^\s*export\s+default\b/m.test(source)) names.add("default");
  return names;
}

// `import { a, b as c } from "./x.js"`；`import * as ns` 與 `import d from` 另外處理。
function namedImports(source) {
  const out = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g;
  for (const m of source.matchAll(re)) {
    const names = [];
    for (const part of m[1].split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const asMatch = piece.match(/^([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*$/);
      names.push(asMatch ? asMatch[1] : piece.split(/\s+/)[0]);
    }
    out.push({ spec: m[2], names, raw: m[0] });
  }
  return out;
}

test("每個具名 import 都存在於目標模組的 export（靜態掃描，不執行模組）", () => {
  const files = moduleFiles();
  assert.ok(files.length > 50, `來源模組數量不合理：${files.length}`);
  const problems = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const { spec, names } of namedImports(source)) {
      const target = path.resolve(path.dirname(file), spec);
      if (!existsSync(target)) {
        problems.push(`${path.relative(srcDir, file)} → ${spec}：目標檔案不存在`);
        continue;
      }
      const exported = exportedNames(readFileSync(target, "utf8"));
      if (exported === null) continue; // export * → 無法靜態判定
      for (const name of names) {
        checked += 1;
        if (!exported.has(name)) {
          problems.push(`${path.relative(srcDir, file)}：從 ${spec} 匯入的 '${name}' 不存在`);
        }
      }
    }
  }
  assert.ok(checked > 200, `檢查到的具名匯入太少（${checked}），掃描器可能失效`);
  assert.deepEqual(problems, [], `發現 ${problems.length} 個匯入不一致`);
});

test("這個檢查抓得到 2026-09-26 那種錯誤（自我測試）", () => {
  // 直接把出錯的那一行餵給掃描器，確認它會被抓出來。
  const bad = 'import {\n  adminEmailForUser,\n  setFlags as setFlagsSync,\n} from "./personalFlags.js";';
  const exported = exportedNames(readFileSync(path.join(srcDir, "personalFlags.js"), "utf8"));
  assert.notEqual(exported, null);
  assert.equal(exported.has("setFlags"), false, "personalFlags.js 不該有 setFlags（它在 db.js）");
  const [entry] = namedImports(bad).filter((e) => e.names.includes("setFlags"));
  assert.ok(entry, "掃描器要能解析出這一行");
  assert.equal(exported.has("setFlags"), false, "→ 所以這一行的匯入會被本測試判定為問題");
});
