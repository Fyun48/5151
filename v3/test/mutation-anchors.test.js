// 變異套組的「錨點唯一性」守衛（2026-09-28，第六十批）。
//
// 為什麼需要這一條：變異工具的前置檢查要求每個 `from` 字串在目標檔案裡**恰好出現一次**；
// 一旦某個改動讓它變成 0 次或 2 次，那整套變異會**直接中止**——而輸出看起來只是「沒跑」，
// 很容易被當成「沒事」。實例：第五十四批在 `usersAsync.js` 加了第二處
// `if (!id) return null;` 之後，`USERS_MUTATIONS` 就靜靜地停擺了好幾批。
//
// 這一條把所有測試檔對應的變異套組各跑一次 `--check-anchors-only`（只驗錨點、不跑測試），
// 所以很快，而且任何一套的錨點壞掉都會當場變紅。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(dir, "../..");
const script = path.join(dir, "../scripts/mutation-check.mjs");

// 從工具的 dispatch 鏈把「測試檔名」抽出來（`/xxx/.test(testFile) ? SUITE`），
// 這樣新增一套變異時不必再來這裡補一次清單。
function dispatchedTestFiles() {
  const text = readFileSync(script, "utf8");
  const names = new Set();
  for (const m of text.matchAll(/\/\(?([a-z0-9-]+)\)?\/\.test\(testFile\)/g)) names.add(m[1]);
  return [...names].sort();
}

test("每一套變異的錨點都必須恰好出現一次（否則整套會靜靜中止）", () => {
  const names = dispatchedTestFiles();
  assert.ok(names.length >= 20, `應該要抓到足夠多的變異套組（實際 ${names.length}）`);
  const failures = [];
  let checked = 0;
  for (const name of names) {
    const testFile = path.join(root, "v3/test", `${name}.test.js`);
    if (!existsSync(testFile)) continue; // 有些 dispatch 條目指向非測試檔（少見）
    checked += 1;
    try {
      execFileSync(process.execPath, [script, testFile, "--check-anchors-only"], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      failures.push(`${name}: ${String(error.stdout || "")}${String(error.stderr || "")}`.trim().slice(0, 400));
    }
  }
  assert.ok(checked >= 15, `至少要有十幾套真的被檢查到（實際 ${checked}）`);
  assert.deepEqual(failures, [], `有變異套組的錨點不唯一（整套會中止）：\n${failures.join("\n")}`);
});
