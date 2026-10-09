// 啟動檢查（G4）政策測試：正式部署的「錯 driver／SQLite fallback 逃生門」必須在啟動時被拒絕。
//
// 背景（Owner 原判，docs/handoffs/5151_SQLite_Exit_PG_HA_DeepSeek_20260924.md）：
//   :65 正式部署規格必須明確指定 postgres，錯 driver／開 SQLite fallback 應在啟動檢查被拒絕
//   :57 正式業務讀寫均禁止回退節點 SQLite
//   :60 不保留 PG_SQLITE_FALLBACK=open 逃生門
//
// 這支測試釘住 runtimeGuards.js 的門禁，以及 server.js／watcher.js 的接線與 repo compose 的持久化。
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

// ② postgres + PG_SQLITE_FALLBACK=open ⇒ 拒絕；strict／未設 ⇒ 放行。
test("postgres + PG_SQLITE_FALLBACK=open ⇒ 拒絕（Owner :60 不收逃生門）", () => {
  assert.throws(
    () => assertRuntimeDbGuard({ DB_DRIVER: "postgres", PG_URL, PG_SQLITE_FALLBACK: "open" }),
    /PG_SQLITE_FALLBACK=open/,
  );
});

test("postgres + PG_SQLITE_FALLBACK=strict ⇒ 放行", () => {
  assert.doesNotThrow(() => assertRuntimeDbGuard({ DB_DRIVER: "postgres", PG_URL, PG_SQLITE_FALLBACK: "strict" }));
});

test("postgres + PG_SQLITE_FALLBACK 未設（closed）⇒ 放行", () => {
  assert.doesNotThrow(() => assertRuntimeDbGuard({ DB_DRIVER: "postgres", PG_URL }));
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
