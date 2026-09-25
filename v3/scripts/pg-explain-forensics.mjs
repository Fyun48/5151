// astra6 §0.1：唯讀 EXPLAIN 收證（真實鏡像）。
//
// 目的：把「30 秒」這件事拆成可驗證的事實 —— 實際 statement_timeout、後端 pid、SQL 形狀、
// 規劃（EXPLAIN VERBOSE），以及真跑一次時的分類：是 **57014（statement_timeout）** ✗
// 還是「連線被切」（例如 57P01 / ECONNRESET）✗ —— 兩者修法完全不同，必須分清楚。
//
// 唯讀保證：整個流程在 `BEGIN READ ONLY` 內，並以 `SET LOCAL statement_timeout='3s'` 當閘門，
// 讓慢查詢在 3 秒被中止而不是拖到 30 秒（避免量測本身變成黑洞）。
//
// 用法：
//   REMOTE_DIR=/app/tmpkk bash v3/scripts/run-in-container.sh v3/scripts/pg-explain-forensics.mjs
import { createPostgresDriver } from "./src/dbDriverPostgres.js";
import { toPostgresSql } from "./src/sqlDialect.js";
import { districtClosureIds } from "./src/listingSearchNodePg.js";
import { buildListListingsClauses, buildListRequestContextFromPg, listingSearchBuildContext } from "./src/db.js";

const drv = await createPostgresDriver({ env: process.env });
const deps = listingSearchBuildContext();
// ⚠️ 不可自己把 `?` 換成 `$n`：builder 會產生 PG 的 JSONB 運算子（`?`／`?|`／`?&`），
// naive 取代會把它們一起改掉 ⇒ 42601 syntax error（實測踩過）。一律用 sqlDialect 的版本。
const exec = (client) => async (sql, params = []) => (await client.query(toPostgresSql(sql), params)).rows;

const district = process.env.DISTRICTS || "西屯區";
const GATE = process.env.GATE_TIMEOUT || "3s";
const ABILITIES = [
  { label: "baseline", args: {} },
  { label: "q=電梯", args: { q: "電梯" } },
  { label: "kind=whole", args: { kind: "whole" } },
  { label: "sources=591", args: { sources: "591" } },
  { label: "areaMax=30", args: { areaMax: 30 } },
  { label: "wholeFloorOnly=1", args: { wholeFloorOnly: 1 } },
  // ★ 最壞情況：無行政區（canary 在此觸發 57014）。districtNames 留空 ⇒ 由 app 自己的
  //   districtClosureIds 決定 closure（若它回傳巨量 id，就是候選查詢變慢的真正來源）。
  { label: "full-table (districts=[])", args: {}, districtNames: [] },
];

function classify(err) {
  const code = String(err?.code || "");
  if (code === "57014") return `statement_timeout(57014)`;
  if (code === "57P01" || code === "57P02" || code === "57P03") return `connection_terminated(${code})`;
  if (err?.name === "AbortError" || /timeout/i.test(String(err?.message || "")) && !code) return `client_timeout(${err?.name || "?"})`;
  return `error(${code || err?.name || "?"}): ${String(err?.message || "").slice(0, 140)}`;
}

// 連線層預設值（未加 SET LOCAL 前）
const probe = await drv.pool.connect();
const defaults = {
  pid: (await probe.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
  statement_timeout: (await probe.query("SELECT current_setting('statement_timeout') AS t")).rows[0].t,
  version: (await probe.query("SELECT version() AS v")).rows[0].v.slice(0, 60),
  idle_in_transaction: (await probe.query("SELECT current_setting('idle_in_transaction_session_timeout') AS t")).rows[0].t,
};
probe.release();
console.log(`PGEX-DEFAULTS ${JSON.stringify(defaults)}`);

for (const item of ABILITIES) {
  const client = await drv.pool.connect();
  const rec = { label: item.label, gate: GATE };
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${GATE}'`);
    rec.pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    rec.effectiveTimeout = (await client.query("SELECT current_setting('statement_timeout') AS t")).rows[0].t;

    const runExec = exec(client);
    const context = await buildListRequestContextFromPg(runExec);
    // ⚠️ 必須像 app 一樣先算好 closure 再以 districtIds 傳入（PG 走 `= ANY(?::bigint[])`）；
    // 否則會掉進 SQLite 專用的 recursive CTE 分支 ⇒ 42P19（實測踩過），量到的就不是真實 SQL。
    const districtNames = item.districtNames ?? [district];
    const districtIds = await districtClosureIds(runExec, { districtNames, userId: 0 });
    rec.districtNames = districtNames;
    rec.districtIds = districtIds.length;
    const built = buildListListingsClauses({
      filter: "all", districts: districtNames, districtIds, settings: {}, uid: 0, voteUid: 0, context, ...item.args,
    });
    const select = `SELECT ${deps.candidateColumns} FROM listings ${built.where}`;
    rec.sqlChars = select.length;
    rec.paramCount = built.params.length;

    // 1) 只規劃、不執行 ⇒ 不受 statement_timeout 影響
    const t0 = Date.now();
    const plan = await client.query(`EXPLAIN (VERBOSE) ${toPostgresSql(select)}`, built.params);
    rec.explainMs = Date.now() - t0;
    rec.plan = plan.rows.map((r) => r["QUERY PLAN"]);

    // 2) 真跑一次（受 3 秒閘門保護）⇒ 分類逾時 vs 斷線
    const t1 = Date.now();
    const run = await client.query(toPostgresSql(select), built.params);
    rec.runMs = Date.now() - t1;
    rec.rows = run.rows.length;
    rec.outcome = "ok";
  } catch (err) {
    rec.outcome = classify(err);
    rec.failedAfterMs = rec.runMs ?? rec.explainMs ?? null;
  } finally {
    // 唯讀交易：一律 ROLLBACK（逾時後交易已中止，ROLLBACK 仍必要才不會把髒狀態留給下一個使用者）
    try { await client.query("ROLLBACK"); } catch { /* 唯讀；回滾失敗不影響本結論 */ }
    client.release();
  }
  console.log(`PGEX ${JSON.stringify(rec)}`);
}

await drv.pool.end();
