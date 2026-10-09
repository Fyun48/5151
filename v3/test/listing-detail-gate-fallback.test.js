// getListingAsync 的 fail-open 拆掉驗證（開閘 D-0021 批次 ③）。
//
// 開閘後 `listingDetailAsync.getListingAsync` 的「PG 讀取失敗就回退同步 getListing」必須拆掉：
// 留著它，開閘後每次 PG 有任何異常都會把同步 SQLite 拉回路上（business SQLite is closed）。
// 這裡用子行程（跟 pg-no-sqlite-open.test.js 同一個做法）在乾淨 process 各 import 一次，
// 釘住兩件事：
//   ① 開閘（sqliteHandleIsUsable()===false）＋ PG reject ⇒ 抛**原始**錯誤，不回退同步 getListing。
//   ② 未開閘（handle 可用）＋ PG reject ⇒ 仍 fail-open 回同步 getListing（回歸，行為不變）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const listingDetailUrl = pathToFileURL(join(repoRoot, "src", "listingDetailAsync.js")).href;

const PROBE = `
const { writeFileSync } = await import("node:fs");
const { getListingAsync } = await import(process.env.LISTING_DETAIL_URL);
const err = new Error("SIMULATED_PG_DOWN");
const fakePgDriver = { query: async () => { throw new Error("pgDriver.query 不該被呼叫"); } };
let outcome;
try {
  const r = await getListingAsync(123, 0, {
    repository: { hydrate: async () => { throw err; } },
    pgDriver: fakePgDriver,
  });
  outcome = { type: "returned", value: r === undefined ? "__UNDEFINED__" : r };
} catch (e) {
  outcome = { type: "threw", message: e.message };
}
writeFileSync(process.env.RESULT_FILE, JSON.stringify(outcome));
`;

function probe(env) {
  const dataDir = mkdtempSync(join(tmpdir(), "gld-fallback-"));
  const resultFile = join(dataDir, "result.json");
  const childEnv = {
    ...process.env,
    LISTING_DETAIL_URL: listingDetailUrl,
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

test("開閘＋PG reject → 抛原始錯誤，不回退同步 getListing（db.prepare 不會被碰到）", () => {
  const out = probe({ DB_DRIVER: "postgres", PG_NO_SQLITE_OPEN: "1" });
  assert.equal(out.error, undefined, `child 不該失敗：${out.error}`);
  assert.equal(out.type, "threw", "開閘時 PG 失敗應該抛錯，不是回傳");
  assert.equal(out.message, "SIMULATED_PG_DOWN", "應抛原始 PG 錯誤（不是被 fallback 蓋掉的 business SQLite is closed）");
  assert.doesNotMatch(out.message, /business SQLite is closed/);
});

test("未開閘（handle 可用）＋PG reject → 仍 fail-open 回同步 getListing（回歸）", () => {
  const out = probe({ DB_DRIVER: "postgres" });
  assert.equal(out.error, undefined, `child 不該失敗：${out.error}`);
  assert.equal(out.type, "returned", "未開閘時仍應 fail-open 回同步 getListing");
  assert.equal(out.value, "__UNDEFINED__", "空 SQLite 下同步 getListing 對不存在的 id 回 undefined");
});
