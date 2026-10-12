// 啟動檢查（G4）政策測試：正式部署的「錯 driver／SQLite fallback 逃生門」必須在啟動時被拒絕。
//
// 背景（Owner 原判，docs/handoffs/5151_SQLite_Exit_PG_HA_DeepSeek_20260924.md）：
//   :65 正式部署規格必須明確指定 postgres，錯 driver／開 SQLite fallback 應在啟動檢查被拒絕
//   :57 正式業務讀寫均禁止回退節點 SQLite
//   :60 不保留 PG_SQLITE_FALLBACK=open 逃生門
//
// 這支測試釘住 runtimeGuards.js 的門禁，以及 server.js／watcher.js 的接線與 repo compose 的持久化。
//
// P5b 補的兩刀（有 PG 連線 env 就必須是完整開閘規格）：
//   ④ 未設 PG_NO_SQLITE_OPEN=1 ⇒ 拒絕（否則節點照樣開業務 SQLite，回退路徑還在）
//   ⑤ PG_SQLITE_FALLBACK 不是 strict（未設＝closed）⇒ 拒絕（closed 的讀取仍會回退，
//      真 PG 錯誤會被「business SQLite is closed」蓋掉）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRuntimeDbGuard, DB_RUNTIME_GUARD_ENV, pgConnectionKeys } from "../src/runtimeGuards.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const PG_URL = "postgres://user:pw@192.168.0.140:25433/5151_shadow";

// ① 錯 driver：有 PG 連線但 resolveDbDriver() 不是 postgres（含未設與拼錯）。
test("錯 driver：有 PG_URL 但 DB_DRIVER 未設（回 sqlite）⇒ 拒絕", () => {
  assert.throws(() => assertRuntimeDbGuard({ PG_URL }), /啟動拒絕/);
  assert.throws(() => assertRuntimeDbGuard({ DB_DRIVER: "sqlite", PG_URL }), /啟動拒絕/);
});

test("錯 driver：DB_DRIVER 拼錯（postgress）＋ PG_URL ⇒ 拒絕", () => {
  assert.throws(() => assertRuntimeDbGuard({ DB_DRIVER: "postgress", PG_URL }), /DB_DRIVER 解析成「sqlite」/);
  // DATABASE_URL 也是 PG 連線 env；driver 拼成 postgresx 仍要拒絕。
  assert.throws(() => assertRuntimeDbGuard({ DB_DRIVER: "postgresx", DATABASE_URL: PG_URL }), /啟動拒絕/);
});

// ② postgres + PG_SQLITE_FALLBACK=open ⇒ 拒絕（Owner :60 不收逃生門）。
test("postgres + PG_SQLITE_FALLBACK=open ⇒ 拒絕（Owner :60 不收逃生門）", () => {
  assert.throws(
    () => assertRuntimeDbGuard({ DB_DRIVER: "postgres", PG_URL, PG_NO_SQLITE_OPEN: "1", PG_SQLITE_FALLBACK: "open" }),
    /PG_SQLITE_FALLBACK=open/,
  );
});

// ④＋⑤ 正式部署規格＝「閘開（PG_NO_SQLITE_OPEN=1）＋ strict」；缺一鍵就拒絕啟動。
test("postgres + 閘開=1 + PG_SQLITE_FALLBACK=strict ⇒ 放行（正式部署規格）", () => {
  assert.doesNotThrow(() =>
    assertRuntimeDbGuard({ DB_DRIVER: "postgres", PG_URL, PG_NO_SQLITE_OPEN: "1", PG_SQLITE_FALLBACK: "strict" }),
  );
});

test("postgres + PG_NO_SQLITE_OPEN 未設／非 1 ⇒ 拒絕（訊息要讀出缺哪一鍵）", () => {
  for (const env of [
    { DB_DRIVER: "postgres", PG_URL, PG_SQLITE_FALLBACK: "strict" },
    { DB_DRIVER: "postgres", PG_URL, PG_SQLITE_FALLBACK: "strict", PG_NO_SQLITE_OPEN: "0" },
    { DB_DRIVER: "postgres", PG_URL, PG_SQLITE_FALLBACK: "strict", PG_NO_SQLITE_OPEN: "" },
  ]) {
    assert.throws(() => assertRuntimeDbGuard(env), /PG_NO_SQLITE_OPEN=1/, JSON.stringify(env));
  }
});

// ④ 沙盒也**不再有例外**（2026-10-12，sqlite-exit P7）。
//
// 原本沙盒（`CRAWL_SANDBOX_REPORT` 有值）是全 repo 唯一一個放行分支，理由是爬蟲落地路徑的
// db.js `storedSearchKeys()` 還是同步 `db.prepare`，開閘跑 3 輪全在該點以「business SQLite
// is closed」失敗、`fetched:0`（實跑紀錄 evidence/sqlite-exit/next-package.md:9-16）。
// 那個同步讀點已於 #676（`d007176`）遷到 PG 原生（`crawlerReads.listingCountForSearchAsync()`
// ＋ `storedSearchKeysFromPg()`），沙盒 compose 的 `:-0` 也一起翻成 `:-1`，所以例外拆除：
// **有 PG 連線就必須開閘，不分沙盒**；第⑤刀（fallback 必須 strict）照舊對沙盒生效。
test("沙盒也不再例外：CRAWL_SANDBOX_REPORT 有值且閘未開 ⇒ 一樣拒絕", () => {
  for (const gate of [undefined, "", "0", "true"]) {
    const env = {
      DB_DRIVER: "postgres",
      PG_URL,
      PG_SQLITE_FALLBACK: "strict",
      CRAWL_SANDBOX_REPORT: "/data/crawl-sandbox.jsonl",
      ...(gate === undefined ? {} : { PG_NO_SQLITE_OPEN: gate }),
    };
    assert.throws(() => assertRuntimeDbGuard(env), /PG_NO_SQLITE_OPEN=1/, `沙盒 env 也應拒：${JSON.stringify(env)}`);
  }
});

// 沙盒本身要走的是「閘開 1 ＋ strict」的完整規格（compose 已翻成 `:-1`）。
test("沙盒規格（閘開 1 ＋ strict ＋ CRAWL_SANDBOX_REPORT）⇒ 放行", () => {
  assert.doesNotThrow(() =>
    assertRuntimeDbGuard({
      DB_DRIVER: "postgres",
      PG_URL,
      PG_NO_SQLITE_OPEN: "1",
      PG_SQLITE_FALLBACK: "strict",
      CRAWL_SANDBOX_REPORT: "/data/crawl-sandbox.jsonl",
    }),
  );
});

// 例外是**整條**拆掉，不是只改判定式：runtimeGuards.js 不得再出現那個變數名。
// （環境變數本身沒被移除——沙盒仍用它指定 jsonl 報告路徑，只是它不再能放行啟動檢查。）
test("runtimeGuards.js 不得再讀 CRAWL_SANDBOX_REPORT（例外已整條拆除）", () => {
  const src = read("v3/src/runtimeGuards.js");
  // 註解可以（也應該）留下「這個變數已經不能再放行」的來由；判定只看程式碼本身。
  const code = src
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(code, /CRAWL_SANDBOX_REPORT/);
  assert.doesNotMatch(code, /sandboxReport/);
  assert.doesNotMatch(code, /export const CRAWL_SANDBOX_REPORT_ENV/, "舊的放行常數不得再匯出");
});

test("compose：沙盒的開閘預設是 1（與正式站同一條規則）", () => {
  const sandbox = serviceBlock(read("docker-compose.crawl-sandbox.yml"), "5151-crawl-sandbox");
  assert.ok(sandbox.includes("PG_NO_SQLITE_OPEN: ${PG_NO_SQLITE_OPEN:-1}"), "沙盒 compose 的閘預設必須是 1");
});

// 沙盒舊例外留下來的兩個「窄度」斷言仍然有效：沒有標記的正式 env 一律照 ④ 拒絕；
// 而且沙盒不豁免第⑤刀（fallback 必須 strict）。
test("閘規則對沙盒同樣窄：無標記仍拒；沙盒也不豁免第⑤刀", () => {
  const sandbox = { DB_DRIVER: "postgres", PG_URL, CRAWL_SANDBOX_REPORT: "/data/crawl-sandbox.jsonl" };
  // 沙盒（閘未設⇒實務上是 0）＋ fallback=closed／未設 ⇒ 第⑤刀之前的第④刀就會先拒絕。
  assert.throws(() => assertRuntimeDbGuard({ ...sandbox, PG_SQLITE_FALLBACK: "closed" }), /PG_NO_SQLITE_OPEN=1/);
  assert.throws(() => assertRuntimeDbGuard(sandbox), /PG_NO_SQLITE_OPEN=1/);
  // 沙盒 ＋ 閘開 1 ＋ fallback=closed ⇒ 仍被第⑤刀拒絕（閘開不能當逃生門）。
  assert.throws(
    () => assertRuntimeDbGuard({ ...sandbox, PG_NO_SQLITE_OPEN: "1", PG_SQLITE_FALLBACK: "closed" }),
    /PG_SQLITE_FALLBACK=strict/,
  );
});

test("postgres + 閘開但 PG_SQLITE_FALLBACK 未設（closed）／closed ⇒ 拒絕（只准 strict）", () => {
  for (const env of [
    { DB_DRIVER: "postgres", PG_URL, PG_NO_SQLITE_OPEN: "1" },
    { DB_DRIVER: "postgres", PG_URL, PG_NO_SQLITE_OPEN: "1", PG_SQLITE_FALLBACK: "closed" },
  ]) {
    assert.throws(() => assertRuntimeDbGuard(env), /PG_SQLITE_FALLBACK=strict/, JSON.stringify(env));
  }
});

// PGHOST 系列（不只 PG_URL）也走同一組開閘規則。
test("PGHOST 系列也算「有 PG 連線 env」：缺閘／缺 strict 一樣拒絕", () => {
  const host = { DB_DRIVER: "postgres", PGHOST: "192.168.0.140", PGDATABASE: "5151_shadow" };
  assert.throws(() => assertRuntimeDbGuard({ ...host, PG_SQLITE_FALLBACK: "strict" }), /PG_NO_SQLITE_OPEN=1/);
  assert.throws(() => assertRuntimeDbGuard({ ...host, PG_NO_SQLITE_OPEN: "1" }), /PG_SQLITE_FALLBACK=strict/);
  assert.doesNotThrow(() => assertRuntimeDbGuard({ ...host, PG_NO_SQLITE_OPEN: "1", PG_SQLITE_FALLBACK: "strict" }));
});

// ③ sqlite + 無 PG 連線 ⇒ 放行（本機開發／npm test 不受影響）。
test("sqlite + 無 PG 連線 ⇒ 放行", () => {
  assert.doesNotThrow(() => assertRuntimeDbGuard({ DB_DRIVER: "sqlite" }));
  assert.doesNotThrow(() => assertRuntimeDbGuard({}));
});

// DB_DRIVER=sqlite 時 PG_SQLITE_FALLBACK 不參與決策：fallback 值再怎麼設都不影響放行。
test("DB_DRIVER=sqlite 時 PG_SQLITE_FALLBACK 不參與決策", () => {
  assert.doesNotThrow(() => assertRuntimeDbGuard({ DB_DRIVER: "sqlite", PG_SQLITE_FALLBACK: "open" }));
  assert.doesNotThrow(() => assertRuntimeDbGuard({ DB_DRIVER: "sqlite", PG_SQLITE_FALLBACK: "strict" }));
  assert.doesNotThrow(() => assertRuntimeDbGuard({ DB_DRIVER: "sqlite", PG_SQLITE_FALLBACK: "open", PG_URL: "" }));
});

// ④ 逃生旗標：只有 DB_RUNTIME_GUARD=off 才跳過，而且要高調警告（不偷偷放行）。
test("逃生旗標 DB_RUNTIME_GUARD=off：放行並打警告", () => {
  const warns = [];
  const original = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    // 最嚴重的「錯 driver＋PG_URL」與「postgres＋open」也要放行（逃生旗標是最後手段）。
    assert.doesNotThrow(() => assertRuntimeDbGuard({ [DB_RUNTIME_GUARD_ENV]: "off", PG_URL }));
    assert.doesNotThrow(() =>
      assertRuntimeDbGuard({ [DB_RUNTIME_GUARD_ENV]: "off", DB_DRIVER: "postgres", PG_URL, PG_SQLITE_FALLBACK: "open" }),
    );
  } finally {
    console.warn = original;
  }
  assert.equal(warns.length, 2);
  assert.match(warns[0], /DB_RUNTIME_GUARD=off/);
  assert.match(warns[0], /啟動檢查已停用/);
});

// 訊息不得印出任何連線字串／密碼，只能印鍵名與 driver 值。
test("拒絕訊息只印鍵名與 driver 值，不印連線字串／密碼", () => {
  const secret = "super-secret-pw-9f3a";
  try {
    assertRuntimeDbGuard({ DB_DRIVER: "postgress", PG_URL: `postgres://user:${secret}@192.168.0.140:25433/db` });
    assert.fail("應拒絕");
  } catch (error) {
    const msg = String(error.message);
    assert.doesNotMatch(msg, new RegExp(secret));
    assert.match(msg, /PG_URL/); // 只印鍵名
    assert.match(msg, /sqlite/); // 只印 resolved driver 值
    assert.doesNotMatch(msg, /postgress/); // 不印 raw DB_DRIVER 值
  }
});

// pgConnectionKeys 只回鍵名、不回值。
test("pgConnectionKeys 只回鍵名，且涵蓋 URL 與 host 變數", () => {
  assert.deepEqual(
    pgConnectionKeys({ PG_URL: "postgres://u:p@h/db", PGHOST: "h", PGUSER: "u" }),
    ["PG_URL", "PGHOST", "PGUSER"],
  );
  assert.deepEqual(pgConnectionKeys({}), []);
  assert.deepEqual(pgConnectionKeys({ PG_URL: "  " }), []);
});

// ⑤ 接線：server.js 與 watcher.js 的啟動路徑都真的呼叫 guard。
function serviceBlock(yaml, name) {
  const start = yaml.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  assert.notEqual(start, -1, `missing service ${name}`);
  const rest = yaml.slice(start + `  ${name}:\n`.length);
  const next = rest.search(/^  [A-Za-z0-9._-]+:\s*$/m);
  return rest.slice(0, next === -1 ? rest.length : next);
}

test("server.js 與 watcher.js 都接到 runtime guard", () => {
  const server = read("v3/src/server.js");
  const watcher = read("v3/src/watcher.js");
  for (const [name, src] of [["server.js", server], ["watcher.js", watcher]]) {
    assert.match(src, /import \{ assertRuntimeDbGuard \} from "\.\/runtimeGuards\.js";/, `${name} import guard`);
    assert.match(src, /assertRuntimeDbGuard\(\);/, `${name} call guard`);
  }
  // watcher 的 guard 要在 runWatch 開頭（抓取開始前 fail-fast）。
  const runWatchHead = watcher.slice(
    watcher.indexOf("export async function runWatch"),
    watcher.indexOf("const runtime = await crawlRuntimeAsync()"),
  );
  assert.match(runWatchHead, /assertRuntimeDbGuard\(\);/, "runWatch 開頭先跑 guard");
});

test("compose：正式站範本都持久化 PG_SQLITE_FALLBACK=strict", () => {
  const tracker = serviceBlock(read("docker-compose.yml"), "591-tracker-v3");
  assert.ok(tracker.includes("PG_SQLITE_FALLBACK: ${PG_SQLITE_FALLBACK:-strict}"), "docker-compose.yml（tracker）");

  assert.ok(read("casaos-compose.yml").includes("PG_SQLITE_FALLBACK: ${PG_SQLITE_FALLBACK:-strict}"), "casaos-compose.yml");

  const sandbox = serviceBlock(read("docker-compose.crawl-sandbox.yml"), "5151-crawl-sandbox");
  assert.ok(sandbox.includes("PG_SQLITE_FALLBACK: strict"), "docker-compose.crawl-sandbox.yml");

  const webA = serviceBlock(read("deploy/shadow-ha/web/web-a/docker-compose.yml"), "5151-web-A");
  assert.ok(webA.includes("PG_SQLITE_FALLBACK: ${PG_SQLITE_FALLBACK:-strict}"), "web-a");

  const webB = read("deploy/shadow-ha/web/web-b/docker-compose.yml");
  assert.ok(serviceBlock(webB, "5151-web-B").includes("PG_SQLITE_FALLBACK: ${PG_SQLITE_FALLBACK:-strict}"), "web-b web");
  assert.ok(serviceBlock(webB, "5151-worker").includes("PG_SQLITE_FALLBACK: ${PG_SQLITE_FALLBACK:-strict}"), "web-b worker");
});
