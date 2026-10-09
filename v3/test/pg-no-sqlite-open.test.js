// PG_NO_SQLITE_OPEN 閘（2026-10-09，SQLite 退場主線 C(2)）。
//
// 當 DB_DRIVER=postgres 且 PG_NO_SQLITE_OPEN=1 時，db.js 在 module import 階段「根本不開啟」
// 業務 SQLite：不建立 DatabaseSync、不跑 PRAGMA/DDL/migrations，`sqliteHandle()` 回傳一個
// 碰任何 method 就明確拋錯、錯誤訊息帶呼叫點名稱的 proxy。預設（旗標未設）行為完全不變。
//
// 因為 db.js 的開關行為發生在 import 階段，而 ESM 模組會被快取，這裡用「子行程」在乾淨的
// process 裡各自 import 一次，避免快取／重複 import 互相污染。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbJsUrl = pathToFileURL(join(repoRoot, "src", "db.js")).href;

const PROBE = `
const { existsSync, writeFileSync } = await import("node:fs");
const dbMod = await import(process.env.DB_JS_URL);
const v3db = process.env.DATA_DIR + "/v3.db";
function attemptSyncRead() {
  return dbMod.sqliteHandle().prepare("SELECT 1").get();
}
let threw = false;
let message = "";
try { attemptSyncRead(); } catch (e) { threw = true; message = e.message; }
writeFileSync(process.env.RESULT_FILE, JSON.stringify({
  created: existsSync(v3db),
  prepareType: typeof (dbMod.sqliteHandle() && dbMod.sqliteHandle().prepare),
  threw,
  message,
}));
`;

function probe(env) {
  const dataDir = mkdtempSync(join(tmpdir(), "noopen-"));
  const resultFile = join(dataDir, "result.json");
  const childEnv = {
    ...process.env,
    DB_JS_URL: dbJsUrl,
    DATA_DIR: dataDir,
    RESULT_FILE: resultFile,
    ...env,
  };
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (r.status !== 0) {
      return { error: `child exited ${r.status}: ${String(r.stderr).slice(0, 500)}` };
    }
    return JSON.parse(readFileSync(resultFile, "utf8"));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("PG_NO_SQLITE_OPEN=1＋DB_DRIVER=postgres → 不建立 DatabaseSync，且同步讀取拋出帶呼叫點的錯誤", () => {
  const out = probe({ DB_DRIVER: "postgres", PG_NO_SQLITE_OPEN: "1" });
  assert.equal(out.error, undefined, `child 不該失敗：${out.error}`);
  assert.equal(out.created, false, "PG_NO_SQLITE_OPEN=1 不該建立 v3.db");
  assert.equal(out.threw, true, "同步讀取應該拋錯");
  assert.match(out.message, /business SQLite is closed/);
  assert.match(out.message, /PG_NO_SQLITE_OPEN=1/);
  // 呼叫點名稱：本測試用 attemptSyncRead 呼叫，錯誤訊息必須帶上它。
  assert.match(out.message, /attemptSyncRead/);
  // 不洩漏任何連線字串／密碼。
  assert.doesNotMatch(out.message, /postgres(ql)?:\/\/|password|secret|token/i);
});

test("旗標未設＋DB_DRIVER=postgres → 行為不變（仍照舊開啟 SQLite handle）", () => {
  const out = probe({ DB_DRIVER: "postgres" });
  assert.equal(out.error, undefined, `child 不該失敗：${out.error}`);
  assert.equal(out.created, true, "旗標未設時仍應建立 v3.db（向後相容）");
  assert.equal(out.prepareType, "function", "sqliteHandle().prepare 應仍是 function");
  assert.equal(out.threw, false, "旗標未設時同步讀取不應拋錯");
});

test("DB_DRIVER=sqlite（本地／測試）→ 旗標完全不起作用", () => {
  const out = probe({ DB_DRIVER: "sqlite", PG_NO_SQLITE_OPEN: "1" });
  assert.equal(out.error, undefined, `child 不該失敗：${out.error}`);
  assert.equal(out.created, true, "sqlite driver 下仍應建立 v3.db");
  assert.equal(out.prepareType, "function", "sqlite driver 下 handle 應是真正的 DatabaseSync");
  assert.equal(out.threw, false, "sqlite driver 下同步讀取不應拋錯");
});
