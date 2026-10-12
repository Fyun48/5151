// 爬蟲沙盒開閘（2026-10-12，sqlite-exit P7）：落地階段的讀路徑不得再撞同步 SQLite。
//
// 背景：沙盒原本是全 repo 唯一「允許不開閘」的例外，因為 watcher 落地階段逐批的 baseline 判定
// 會走到 db.js 的同步 `storedSearchKeys()`（`SELECT DISTINCT search_key` 走節點 SQLite handle），
// 開閘（PG_NO_SQLITE_OPEN=1）時在該點以
// `business SQLite is closed (PG_NO_SQLITE_OPEN=1, DB_DRIVER=postgres): synchronous SQLite handle
// access "prepare" reached at storedSearchKeys` 失敗，實跑 3 輪 fetched:0／jobs:0
// （evidence/sqlite-exit/next-package.md:9-16）。那個同步讀點已遷到 PG 原生
// （crawlerReads.listingCountForSearchAsync ＋ db.js storedSearchKeysFromPg），本檔釘住收尾：
//
//   1. PG 島模式下，落地階段讀路徑只走 PG、回傳真實計數，子行程**不得**出現
//      `business SQLite is closed`（含 stderr／未捕捉 rejection），也不得建立節點 v3.db。
//   2. 同一模式下，同步入口（db.js `listingCountForSearch` → `storedSearchKeys`）要 fail-closed，
//      而且訊息要**點名 PG 對應版本**——改動前它只丟通用的 `business SQLite is closed`，
//      日誌看不出是哪一條業務路徑、也不知道該改走哪一支。
//   3. 閘**未設**的 PG 模式行為逐字不變（handle 還在，同步版照常可用）。
//   4. watcher 落地階段接的是 async 入口，不是同步版（source 錨點，防迴歸）。
//
// db.js 的開閘行為發生在 import 階段，所以 1～3 都在**子行程**裡跑（同 pg-no-sqlite-open.test.js）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbJsUrl = pathToFileURL(join(repoRoot, "src", "db.js")).href;
const crawlerReadsUrl = pathToFileURL(join(repoRoot, "src", "crawlerReads.js")).href;
const read = (rel) => readFileSync(join(repoRoot, "..", rel), "utf8");

// 落地階段的 baseline 判定：同一組搜尋鍵 ＋ 一個 sameSearch 別名，共 7 筆。
const PROBE = `
import { existsSync, writeFileSync } from "node:fs";
const crawlerReads = await import(process.env.CRAWLER_READS_URL);
const dbMod = await import(process.env.DB_JS_URL);
const K1 = "https://rent.591.com.tw/?regionid=1&section=3";
const K1_ALIAS = "https://rent.591.com.tw/?regionid=1&section=3&kind=2";
const listings = [
  { search_key: K1 }, { search_key: K1 }, { search_key: K1 },
  { search_key: K1_ALIAS }, { search_key: K1_ALIAS }, { search_key: K1_ALIAS }, { search_key: K1_ALIAS },
];
const calls = [];
let pgDriver = {
  async query(sql, params = []) {
    calls.push({ sql: String(sql), params: [...params] });
    if (/DISTINCT\\s+search_key/i.test(String(sql))) {
      return { rows: [...new Set(listings.map((l) => l.search_key))].map((search_key) => ({ search_key })) };
    }
    if (/COUNT\\(\\*\\)/i.test(String(sql))) {
      return { rows: [{ n: String(listings.filter((l) => params.includes(l.search_key)).length) }] };
    }
    return { rows: [] };
  },
};
let client = null;
if (process.env.PROBE_MODE === "live") {
  // 真 PG 靶（隔離庫，唯讀查詢）：證明落地讀路徑在 PG 島模式下真的打得到 PG。
  const pg = (await import("pg")).default;
  client = new pg.Client({ connectionString: process.env.PG_URL });
  await client.connect();
  pgDriver = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params: [...params] });
      return await client.query(sql, params);
    },
  };
}
const out = { count: null, calls: 0, sqls: [], asyncError: "", syncError: "", syncReturned: null, v3dbCreated: null };
crawlerReads.resetSearchKeyCountMemoForTest();
try {
  out.count = await crawlerReads.listingCountForSearchAsync(K1, { driver: "postgres", pgDriver });
} catch (error) {
  out.asyncError = String(error && error.message);
}
out.calls = calls.length;
out.sqls = calls.map((c) => c.sql);
try {
  out.syncReturned = dbMod.listingCountForSearch(K1);
  out.syncError = "";
} catch (error) {
  out.syncError = String(error && error.message);
}
if (client) await client.end();
out.v3dbCreated = existsSync(process.env.DATA_DIR + "/v3.db");
writeFileSync(process.env.RESULT_FILE, JSON.stringify(out));
`;

function probe(env = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "sandbox-gate-"));
  const resultFile = join(dataDir, "result.json");
  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DB_DRIVER: "postgres",
        PG_URL: "postgres://probe:probe@127.0.0.1:1/probe",
        PG_SQLITE_FALLBACK: "strict",
        PG_NO_SQLITE_OPEN: "1",
        DB_JS_URL: dbJsUrl,
        CRAWLER_READS_URL: crawlerReadsUrl,
        DATA_DIR: dataDir,
        RESULT_FILE: resultFile,
        PROBE_MODE: "",
        ...env,
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    if (r.status !== 0 || !existsSync(resultFile)) {
      throw new Error(`child 失敗（exit ${r.status}）：${String(r.stderr).slice(0, 800)}`);
    }
    return {
      out: JSON.parse(readFileSync(resultFile, "utf8")),
      noise: `${String(r.stdout || "")}\n${String(r.stderr || "")}`,
    };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("PG 島模式：落地讀路徑只走 PG、回傳真實計數，全程無 business SQLite is closed", () => {
  const { out, noise } = probe();
  assert.equal(out.asyncError, "", `PG 路徑不該失敗：${out.asyncError}`);
  assert.equal(out.count, 7, "回傳真實計數（K1 3 筆 ＋ sameSearch 別名 4 筆）");
  assert.equal(out.calls, 2, "只該發 DISTINCT 與 COUNT 兩條 PG 查詢");
  assert.match(out.sqls[0], /DISTINCT\s+search_key/i);
  assert.match(out.sqls[1], /COUNT\(\*\)/i);
  assert.equal(out.v3dbCreated, false, "開閘時不得建立節點 v3.db");
  assert.doesNotMatch(noise, /business SQLite is closed/, `子行程不得出現同步 SQLite 錯誤：${noise.slice(0, 400)}`);
});

test("PG 島模式：同步入口 fail-closed，且訊息點名 storedSearchKeysFromPg／listingCountForSearchAsync", () => {
  const { out } = probe();
  assert.match(out.syncError, /storedSearchKeysFromPg/, "訊息要指出 PG 的 async 對應版本");
  assert.match(out.syncError, /listingCountForSearchAsync/, "訊息要指出 crawler／watcher 用的 async 入口");
  assert.match(out.syncError, /PG_NO_SQLITE_OPEN=1/, "訊息要點名開閘旗標");
  assert.doesNotMatch(out.syncError, /business SQLite is closed/, "不得再是通用的「SQLite 已關閉」訊息");
});

test("閘未開的 PG 模式：同步版行為逐字不變（handle 還在）", () => {
  const { out } = probe({ PG_NO_SQLITE_OPEN: "" });
  assert.equal(out.syncError, "", "閘未開時同步版必須照常可用");
  assert.equal(out.syncReturned, 0, "空庫的 baseline 計數是 0");
  assert.equal(out.count, 7, "PG 路徑照常");
  assert.match(out.sqls[0], /DISTINCT\s+search_key/i);
});

test("watcher 落地階段接的是 async 入口（不得退回同步 listingCountForSearch）", () => {
  const watcher = read("v3/src/watcher.js");
  assert.match(
    watcher,
    /const isSearchBaseline = \(await listingCountForSearchAsync\(batch\.searchUrl\)\) === 0;/,
    "落地階段的 baseline 判定要走 listingCountForSearchAsync",
  );
  assert.doesNotMatch(
    watcher,
    /listingCountForSearch\(batch\.searchUrl\)/,
    "watcher 不得再有同步 listingCountForSearch 的直接呼叫",
  );
  const crawlerReads = read("v3/src/crawlerReads.js");
  assert.match(
    crawlerReads,
    /if \(driver !== "postgres"\) return listingCountForSearchSync\(searchKey\);/,
    "同步版只能留在 SQLite 分支（driver 閘後）",
  );
  assert.match(read("v3/src/db.js"), /stored-search-keys-unavailable/, "db.js 要有同步路徑的明確失敗訊息");
});

test(
  "live（PG_LIVE_REPRO_URL）：PG 島模式下拿真 PG 跑落地讀路徑，無 business SQLite is closed",
  { skip: process.env.PG_LIVE_REPRO_URL ? false : "PG_LIVE_REPRO_URL 未設（隔離庫靶）" },
  () => {
    const { out, noise } = probe({ PROBE_MODE: "live", PG_URL: process.env.PG_LIVE_REPRO_URL });
    assert.equal(out.asyncError, "", `live PG 落地讀取不該失敗：${out.asyncError}`);
    assert.ok(Number.isFinite(Number(out.count)) && Number(out.count) >= 0, `計數要是數字（得到 ${out.count}）`);
    assert.equal(out.calls, 2, "只發 DISTINCT ＋ COUNT 兩條唯讀查詢");
    assert.doesNotMatch(noise, /business SQLite is closed/, `不得出現同步 SQLite 錯誤：${noise.slice(0, 400)}`);
  },
);
