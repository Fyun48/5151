// sqlite-exit 批次 P1：兩條「還沒搬完的同步讀取路徑」＋ 一個靜默吞錯（2026-10-10）。
//
// 正式站 `591-tracker-v3`（三隻容器都開閘 `PG_NO_SQLITE_OPEN=1`）24 小時 82 行
// `business SQLite is closed`，逐行來源（`docker logs --since 24h | grep -c` ＝ 82）：
//   • 80 行 `reached at listUserIds (file:///app/src/members.js:50)`，全部被 server.js 補路線
//     重試圈的 `console.warn("補路線失敗：", error.message)` 吞掉。兩條來源：
//       ① `watcher.js:1357` 的同步 `collectCommuteSettings()`（每輪先炸在這一行）；
//       ② 同一個迴圈裡的 PG 掃描 `needingRouteAsync()` → `selectRouteCandidates()` →
//          `deps.routeScanPlan()` → `db.js` 的同步 `collectCommuteSettings()`／`commuteRushEnabled()`。
//   • 1 行 `reached at getCommunityCache (file:///app/src/db.js:8724)` —— `watcher.js:375` 的
//     同步讀，**未捕捉的 rejection** 直接把 worker 打掛（stack：`pool.js worker`）。
//   • 1 行是原始碼自身的 `${caller}` 回顯（堆疊傾印的一部分，不是第二個錯誤）。
//
// 這一包釘住：這些路徑在 PG 模式下改讀 PG（或明確失敗）、不再有靜默吞錯，且開閘
// （沒有本機 handle）時**不回退**同步版把根源錯誤蓋掉。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-p1-sync-reads-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
});

const dbMod = await import("../src/db.js");
const ccAsync = await import("../src/communityCacheAsync.js");
const settingsAsync = await import("../src/settingsAsync.js");
const crawlerReads = await import("../src/crawlerReads.js");
const { selectRouteCandidates } = await import("../src/repository/crawlerScans.js");

const PG = { driver: "postgres" };

// 注入式 exec（既有島嶼測試的同一種形狀）：記下每一句 SQL，回傳呼叫端指定的列。
function recordingExec(rowsFor = () => []) {
  const sqls = [];
  const exec = async (sql, params = []) => {
    sqls.push({ sql: String(sql), params });
    return rowsFor(String(sql), params) || [];
  };
  return { exec, sqls };
}

const USER_IDS_SQL_RE = /FROM users WHERE deleted_at IS NULL OR deleted_at = '' ORDER BY id/;

// ---- ① `listUserIds` 同步讀：PG 模式下改走 PG 版 ------------------------------------------

test("PG：collectCommuteSettingsAsync 讀 PG 的會員清單（不再同步 listUserIds、不碰本機 SQLite）", async () => {
  const { exec, sqls } = recordingExec();
  const list = await settingsAsync.collectCommuteSettingsAsync({ ...PG, exec });
  assert.ok(Array.isArray(list), "回傳形狀不變（設定陣列）");
  assert.ok(
    sqls.some((q) => USER_IDS_SQL_RE.test(q.sql)),
    "PG 模式一定要用 LIST_USER_IDS_SQL 問 PG 的會員清單",
  );
  assert.ok(
    sqls.every((q) => !/sqlite/i.test(q.sql)),
    "PG 模式不得出現任何本機 SQLite 語句",
  );
});

test("PG：routeScanPlanAsync 的 jobs／wantRush 都來自 PG（含注入值優先）", async () => {
  const { exec, sqls } = recordingExec();
  const plan = await dbMod.routeScanPlanAsync({ limit: 5 }, { ...PG, exec });
  assert.ok(
    sqls.some((q) => USER_IDS_SQL_RE.test(q.sql)),
    "plan 的 jobs 要用 PG 的會員清單算（不是本機 listUserIds）",
  );
  assert.equal(plan.cap, 5, "cap 與其他欄位仍由 db.js 的 routeScanPlan() 產出");
  assert.equal(typeof plan.wantRush, "boolean");

  // 注入值（PG 端算好的）優先，形狀仍由同一支 routeScanPlan() 決定。
  const injected = dbMod.routeScanPlan({ jobs: ["j"], wantRush: true, limit: 3 });
  assert.deepEqual(injected.jobs, ["j"]);
  assert.equal(injected.wantRush, true);
  assert.equal(injected.cap, 3);

  // sqlite driver 走同步版（逐字回歸）。
  const lite = await dbMod.routeScanPlanAsync({ limit: 7 }, { driver: "sqlite" });
  assert.deepEqual(lite.jobs, dbMod.routeScanPlan({ limit: 7 }).jobs, "sqlite driver 的 plan 與同步版相同");
});

test("PG：selectRouteCandidates() 用呼叫端算好的 plan，不再呼叫 deps.routeScanPlan()", async () => {
  const deps = {
    ...dbMod.crawlerReadsBuildContext(),
    routeScanPlan: () => { throw new Error("sync routeScanPlan() must not be called in PG mode"); },
  };
  const result = await selectRouteCandidates(async () => [], { deps, plan: { jobs: [] } });
  assert.deepEqual(result, { rows: [], cursor: 0 }, "空 plan 直接回空結果（沒有碰到同步 planner）");
});

test("PG：needingRouteAsync 整條路徑不碰同步 routeScanPlan；失敗時也不回退 SQLite", async () => {
  const deps = {
    ...dbMod.crawlerReadsBuildContext(),
    routeScanPlan: () => { throw new Error("sync routeScanPlan() must not be called in PG mode"); },
  };
  const { exec } = recordingExec();
  const rows = await crawlerReads.needingRouteAsync(
    { limit: 5 },
    { ...PG, exec, deps },
  );
  assert.deepEqual(rows, [], "PG 掃描完成（沒有炸在同步 planner 上）");

  // PG 讀失敗時不吞：把來源錯誤原樣往上丟（`strict` 關掉 fail-open 回退）。
  const marker = Object.assign(new Error("pg-down-marker"), { code: "ECONNRESET" });
  await assert.rejects(
    () => crawlerReads.needingRouteAsync(
      { limit: 5 },
      { ...PG, strict: true, exec: async () => { throw marker; }, deps },
    ),
    /pg-down-marker/,
    "PG 失敗要往上丟原始錯誤",
  );
  // 開閘（沒有本機 handle）時連 fail-open 回退都不准發生 ⇒ 由子行程探針驗（見下一個測試）。
});

// ---- ② `getCommunityCache` 同步讀：補上 PG 版 --------------------------------------------

test("getCommunityCacheAsync 的 SQL 與回傳形狀與同步版一致（lat 是 Number）", async () => {
  dbMod.db.prepare(
    "INSERT OR REPLACE INTO community_cache(community_id,name,address,lat,lng,updated_at) VALUES(?,?,?,?,?,?)",
  ).run(900001, "", "台北市信義區", "25.0330", "121.5654", "2026-10-10T00:00:00.000Z");
  dbMod.db.prepare(
    "INSERT OR REPLACE INTO community_cache(community_id,name,address,lat,lng,updated_at) VALUES(?,?,?,?,?,?)",
  ).run(900002, "零座標社區", "x", 0, 0, "2026-10-10T00:00:00.000Z");

  // PG 替身：記憶體 SQLite，逐字跑同一句 SQL（＝PG 上同一句的值）。
  const mem = new DatabaseSync(":memory:");
  mem.exec("CREATE TABLE community_cache (community_id INTEGER PRIMARY KEY, name TEXT, address TEXT, lat REAL, lng REAL, updated_at TEXT)");
  for (const row of dbMod.db.prepare("SELECT community_id AS id, name, address, lat, lng FROM community_cache").all()) {
    mem.prepare("INSERT INTO community_cache(community_id,name,address,lat,lng) VALUES(?,?,?,?,?)")
      .run(row.id, row.name, row.address, row.lat, row.lng);
  }
  const { exec, sqls } = recordingExec((sql, params) => mem.prepare(sql).all(...params));

  for (const id of [900001, 900002, 999999]) {
    const pgRow = await ccAsync.getCommunityCacheAsync(id, { ...PG, strict: true, exec });
    const sqliteRow = dbMod.getCommunityCache(id);
    assert.deepEqual(pgRow, sqliteRow, `id=${id} 的兩個 driver 回傳形狀必須逐欄位相同`);
    if (pgRow) assert.deepEqual(Object.keys(pgRow), ["id", "name", "address", "lat", "lng"]);
  }
  const row = await ccAsync.getCommunityCacheAsync(900001, { ...PG, strict: true, exec });
  assert.equal(typeof row.lat, "number", "lat 必須是 Number（不是 PG 回的字串）");
  assert.equal(row.lat, 25.033);
  const zero = await ccAsync.getCommunityCacheAsync(900002, { ...PG, strict: true, exec });
  assert.equal(zero.lat, null, "0 視為沒有座標（與同步版同義）");
  assert.equal(await ccAsync.getCommunityCacheAsync(0, { ...PG, strict: true, exec }), null);
  assert.equal(sqls[0].sql, dbMod.COMMUNITY_CACHE_SELECT_SQL, "PG 版跑的就是同步版那一句 SQL");
  assert.deepEqual(sqls[0].params, [900001]);
  mem.close();
});

// ---- ③ 開閘 probe：不得再出現 business SQLite is closed ------------------------------------

test("開閘 probe（子行程）：改過的模組都不得出現 business SQLite is closed", () => {
  const probeDir = mkdtempSync(path.join(os.tmpdir(), "v3-p1-gate-"));
  const script = `
    const out = [];
    const run = async () => {
      const cc = await import(${JSON.stringify(path.join(dir, "../src/communityCacheAsync.js"))});
      try {
        await cc.getCommunityCacheAsync(1, { driver: "postgres", exec: () => {
          throw Object.assign(new Error("pg-down-marker"), { code: "ECONNRESET" });
        } });
        out.push("injected=NO-ERROR");
      } catch (e) { out.push("injected=" + e.message); }
      for (const [name, load, call] of [
        ["getCommunityCacheAsync", () => import(${JSON.stringify(path.join(dir, "../src/communityCacheAsync.js"))}), (m) => m.getCommunityCacheAsync(12345)],
        ["listUserIdsAsync", () => import(${JSON.stringify(path.join(dir, "../src/usersAsync.js"))}), (m) => m.listUserIdsAsync()],
        ["collectCommuteSettingsAsync", () => import(${JSON.stringify(path.join(dir, "../src/settingsAsync.js"))}), (m) => m.collectCommuteSettingsAsync()],
        ["routeScanPlanAsync", () => import(${JSON.stringify(path.join(dir, "../src/db.js"))}), (m) => m.routeScanPlanAsync({ limit: 5 })],
      ]) {
        try {
          const m = await load();
          const r = await call(m);
          out.push(name + "=OK:" + JSON.stringify(r).slice(0, 40));
        } catch (e) { out.push(name + "=ERR:" + e.name + ":" + String(e.message).slice(0, 80)); }
      }
      // 開閘下「不回退同步掃描」：用注入的 exec 丟一個 PG 錯誤，必須原樣冒出來，
      // 而不是被 sqliteHandle() 的 proxy 換成 business SQLite is closed。
      {
        const db = await import(${JSON.stringify(path.join(dir, "../src/db.js"))});
        const cr = await import(${JSON.stringify(path.join(dir, "../src/crawlerReads.js"))});
        const deps = {
          ...db.crawlerReadsBuildContext(),
          routeScanPlan: () => { throw new Error("sync routeScanPlan() called"); },
        };
        try {
          await cr.needingRouteAsync({ limit: 5 }, {
            driver: "postgres",
            deps,
            exec: async () => { throw Object.assign(new Error("pg-down-marker-route"), { code: "ECONNRESET" }); },
          });
          out.push("needingRouteAsync-gate=NO-ERROR");
        } catch (e) { out.push("needingRouteAsync-gate=" + e.message); }
      }
      console.log(out.join("\\n"));
    };
    run().catch((e) => { console.log("FATAL:" + e.message); });
  `;
  // 只給必要變數（不繼承 PG_* 連線設定）：探針打 127.0.0.1:5432，拿不到就 ECONNREFUSED，
  // 那就足以證明「沒有回退本機 SQLite、也沒有把錯誤換成 business SQLite is closed」。
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DATA_DIR: probeDir,
    DB_DRIVER: "postgres",
    PG_NO_SQLITE_OPEN: "1",
  };
  const stdout = execFileSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 60_000 });
  rmSync(probeDir, { recursive: true, force: true });
  assert.doesNotMatch(stdout, /business SQLite is closed/, `開閘探針不得出現 business SQLite is closed：\n${stdout}`);
  assert.match(stdout, /injected=pg-down-marker/, "PG 的原始錯誤要原樣往上丟（沒有回退本機 SQLite）");
  assert.match(stdout, /needingRouteAsync-gate=pg-down-marker-route/, "補路線掃描在開閘時也不得回退同步版");
  for (const name of ["getCommunityCacheAsync", "listUserIdsAsync", "collectCommuteSettingsAsync", "routeScanPlanAsync"]) {
    assert.match(stdout, new RegExp(`^${name}=(OK|ERR)`, "m"), `${name} 要有結果（不得被 SQLite proxy 的錯誤取代）`);
  }
});

// ---- ④ 原始碼守衛（接線形狀；改回同步版就會紅） --------------------------------------------

const src = (file) => readFileSync(path.join(dir, "../src", file), "utf8");

test("watcher.js：兩條 community_cache 讀取與補路線設定清單都改走 async 版", () => {
  const watcher = src("watcher.js");
  assert.doesNotMatch(watcher, /\bgetCommunityCache,/, "不得再從 db.js 匯入同步的 getCommunityCache");
  assert.doesNotMatch(watcher, /\bcollectCommuteSettings,/, "不得再從 db.js 匯入同步的 collectCommuteSettings");
  assert.match(watcher, /import \{ getCommunityCacheAsync \} from "\.\/communityCacheAsync\.js";/);
  assert.match(watcher, /getCommunity: getCommunityCacheAsync,/);
  assert.match(watcher, /let community = await getCommunityCacheAsync\(commId\);/);
  assert.match(watcher, /commuteWorkJobs\(\[settings, \.\.\.\(await collectCommuteSettingsAsync\(options\)\)\]\)\[0\]/);
  assert.doesNotMatch(watcher, /\.\.\.collectCommuteSettings\(\)/, "不得再有裸的同步 collectCommuteSettings() 呼叫");
});

test("client591.js：getCommunity 的 async 回傳值要 await（否則拿到 Promise 當真相值）", () => {
  const client = src("client591.js");
  assert.match(client, /let community = ref\.id \? await options\.getCommunity\?\.\(ref\.id\) : null;/);
});

test("crawlerReads.js：PG 的補路線掃描把 plan 算好傳進去（不再讓 repository 走同步 planner）", () => {
  const reads = src("crawlerReads.js");
  assert.match(reads, /await routeScanPlanAsync\(\{ limit, priorityIds, cursor: nextCursor, now: scanNow \}, options\)/);
  assert.match(reads, /if \(!sqliteHandleIsUsable\(sqliteHandle\(\)\)\) throw error;/);
});

test("server.js：補路線重試圈留下可搜的失敗前綴與輪次（不再只吞 error.message）", () => {
  const server = src("server.js");
  assert.doesNotMatch(server, /console\.warn\("補路線失敗：", error\.message\)\s*;/, "不得再只印 error.message");
  assert.match(server, /route-backfill-failed round=\$\{round\} consecutive=\$\{routeBackfillConsecutive\}/);
  assert.match(server, /name=\$\{error\?\.name \|\| "Error"\} code=\$\{error\?\.code \?\? ""\}/);
  assert.match(server, /route-backfill-failed total=\$\{routeBackfillFailures\} of 80 rounds/);
  assert.match(server, /for \(let round = 0; round < 80; round \+= 1\) \{/, "重試上限不能變成無限迴圈");
});
