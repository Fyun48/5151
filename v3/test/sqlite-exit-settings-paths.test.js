// sqlite-exit 批次 E：三條「開閘後 settingKey 這族同步 settings 讀取」炸點的路徑守衛。
//
// 正式站實測（PG_NO_SQLITE_OPEN=1）炸出的三條：
//   ① 第一次檢查（startStartupWork → coveringJobsFromAllUsers → coveringPlan → settingKey）
//   ② 5168 補抓（processListingEnrichBatch → isSourceEnabled → isCrawlSourceEnabled → settingKey）
//   ③ ops-delivery（startDeliveryLoopAsync → ensureFeedbackOutboxStoreOnce → ensurePgSchema）
//
// 這裡只驗「呼叫鏈不再同步讀本機 SQLite」的形狀，不重跑整段抓取：
//   - 開閘 proxy（帶 DSH_NO_OPEN_MARKER、碰 method 就拋）當 sqlite handle 時，
//     各路徑不得拋「business SQLite is closed」，而且要走 PG 原生讀／DDL。
//   - 有可用 SQLite handle 時，行為逐字回歸（仍走原本鏡射路徑）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DSH_NO_OPEN_MARKER } from "../src/sqliteHandle.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-settings-paths-"));
process.env.DATA_DIR = dataDir;

const db = await import("../src/db.js");

// 與 db.js 的 createNoOpenSqliteProxy 同形的開閘 proxy（帶不可枚舉 marker、碰 method 就拋）。
function noOpenProxy() {
  const target = function sqliteClosed() {};
  Object.defineProperty(target, DSH_NO_OPEN_MARKER, { value: true });
  return new Proxy(target, {
    get(_target, prop) {
      if (prop === "then" || prop === "catch" || prop === "finally" || prop === "inspect") return undefined;
      if (typeof prop === "symbol") return undefined;
      return () => {
        throw new Error(`business SQLite is closed (PG_NO_SQLITE_OPEN=1, DB_DRIVER=postgres): synchronous SQLite handle access "${String(prop)}"`);
      };
    },
    apply() {
      throw new Error("business SQLite is closed (PG_NO_SQLITE_OPEN=1, DB_DRIVER=postgres): synchronous SQLite handle was invoked");
    },
  });
}

function fakePgDriver() {
  const exec = [];
  const query = [];
  return {
    exec: async (sql) => { exec.push(String(sql)); },
    query: async (sql, _params = []) => { query.push(String(sql)); return { rows: [] }; },
    _exec: exec,
    _query: query,
  };
}

test("①第一次檢查：startStartupWork 改走 coveringPlanAsync，不再同步讀 coveringJobsFromAllUsers", () => {
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(src, /await coveringPlanAsync\(\{ includeSystem: true \}\)/,
    "startStartupWork 的第一次檢查要用 PG 的 coveringPlanAsync");
  assert.doesNotMatch(src, /coveringJobsFromAllUsers\(\{/,
    "不得再同步呼叫 coveringJobsFromAllUsers（coveringPlan → settingKey → db.prepare）");
});

test("②5168 補抓：PG bundle 只給 isSourceEnabledAsync，SQLite bundle 兩種都給", async () => {
  const { listingEnrichHelpers } = await import("../src/watcher.js");
  const pg = listingEnrichHelpers({ driver: "postgres" });
  assert.equal(typeof pg.isSourceEnabledAsync, "function", "PG bundle 必須有 async 的 isSourceEnabledAsync");
  assert.equal(typeof pg.isSourceEnabled, "undefined", "PG bundle 不得再有同步 isSourceEnabled（讀本機 SQLite）");
  const lite = listingEnrichHelpers({ driver: "sqlite" });
  assert.equal(typeof lite.isSourceEnabled, "function", "SQLite bundle 要保留同步 isSourceEnabled");
  assert.equal(typeof lite.isSourceEnabledAsync, "function", "SQLite bundle 也要有 isSourceEnabledAsync");
});

test("②5168 補抓：開閘 proxy 下 preparePgEnrichStore 不碰 SQLite（不鏡射、不抛）", async () => {
  const { preparePgEnrichStore } = await import("../src/listingEnrichQueueAsync.js");
  const fake = fakePgDriver();
  await preparePgEnrichStore(fake, noOpenProxy());
  const all = [...fake._exec, ...fake._query].join("\n");
  assert.equal(all, "", "開閘時不該對 SQLite handle 鏡射（零 DDL／零序號對齊）");
});

test("②5168 補抓：可用 SQLite handle 下 preparePgEnrichStore 仍走鏡射（回歸）", async () => {
  const { preparePgEnrichStore } = await import("../src/listingEnrichQueueAsync.js");
  const sqlite = new DatabaseSync(":memory:");
  // 三張表的 DDL 由 listingEnrichQueue.js 的 ensure* 產生；這裡至少建 listing_prep 讓 ensurePgSchema 有來源。
  sqlite.exec("CREATE TABLE listing_prep (post_id INTEGER PRIMARY KEY, source TEXT, display_ready INTEGER)");
  sqlite.exec("CREATE TABLE listing_enrich_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER)");
  sqlite.exec("CREATE TABLE listing_enrich_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, outcome TEXT)");
  const fake = fakePgDriver();
  await preparePgEnrichStore(fake, sqlite);
  sqlite.close();
  const all = [...fake._exec, ...fake._query].join("\n");
  assert.match(all, /listing_prep/, "可用 handle 時仍要鏡射建表");
});

test("③ops-delivery：開閘 proxy 下 ensureFeedbackOutboxStoreOnce 走 PG 原生 DDL、不碰 sqlite_master", async () => {
  const { ensureFeedbackOutboxStoreOnce } = await import("../src/feedbackOutboxAsync.js");
  const fake = fakePgDriver();
  await ensureFeedbackOutboxStoreOnce(fake, noOpenProxy());
  const ddl = fake._exec;
  const resync = fake._query;
  assert.ok(
    ddl.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS feedback_outbox")),
    "開閘時要有 feedback_outbox 的 PG 原生建表",
  );
  assert.ok(
    ddl.some((sql) => sql.includes("BIGINT GENERATED BY DEFAULT AS IDENTITY")),
    "id 應是 identity 欄",
  );
  assert.ok(
    resync.some((sql) => sql.includes("setval") && sql.includes("pg_get_serial_sequence('feedback_outbox', 'id')")),
    "要對齊 feedback_outbox 的 identity 序號",
  );
  const all = [...ddl, ...resync].join("\n");
  assert.ok(!all.includes("sqlite_master"), "PG 原生路徑不得出現 sqlite_master");
});

test("③ops-delivery：可用 SQLite handle 下 ensureFeedbackOutboxStoreOnce 仍走鏡射（回歸）", async () => {
  const { ensureFeedbackOutboxStoreOnce } = await import("../src/feedbackOutboxAsync.js");
  const { ensureFeedbackOutboxSchema } = await import("../src/feedbackOutbox.js");
  const sqlite = new DatabaseSync(":memory:");
  ensureFeedbackOutboxSchema(sqlite);
  const fake = fakePgDriver();
  await ensureFeedbackOutboxStoreOnce(fake, sqlite);
  sqlite.close();
  const all = [...fake._exec, ...fake._query].join("\n");
  assert.match(all, /feedback_outbox/, "可用 handle 時仍要走鏡射建表");
});
