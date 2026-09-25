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
// astra 2026-09-25 §4.1：顯示篩選讀的是 **settings**（不是 args 最上層），
// 且 wholeFloorOnly 必須是 boolean；否則「能力」根本沒生效，量到的其實是 baseline。
// 每個能力都與 baseline 對照列數，並在 rec.effective 記錄是否確實生效。
const ABILITIES = [
  { label: "baseline", args: {}, settings: {} },
  { label: "q=電梯", args: { q: "電梯" }, settings: {} },
  { label: "kind=whole", args: { kind: "whole" }, settings: {} },
  { label: "sources=591", args: { sources: "591" }, settings: {} },
  { label: "areaMax=30", args: {}, settings: { areaMax: 30 } },
  { label: "wholeFloorOnly=1", args: {}, settings: { wholeFloorOnly: true } },
  // ★ 最壞情況：無行政區（canary 在此觸發 57014）。districtNames 留空 ⇒ 由 app 自己的
  //   districtClosureIds 決定 closure（若它回傳巨量 id，就是候選查詢變慢的真正來源）。
  { label: "full-table (districts=[])", args: {}, settings: {}, districtNames: [] },
];
let baselineRows = null;

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
  // astra §4.1：失敗時間必須從**失敗階段**起算 ⇒ 這兩個變數要宣告在 try 之外（catch 才看得到）。
  let stageStart = Date.now();
  let stageName = "setup";
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
    const closure = await districtClosureIds(runExec, { districtNames, userId: 0 });
    // districtClosureIds() 對「無名單或等於全體」會**刻意回傳 null**（＝不需要行政區條件）；
    // 探針必須容忍 null，否則會在測到候選查詢之前就先 TypeError（實測踩過）。
    rec.districtNames = districtNames;
    rec.districtIds = Array.isArray(closure) ? closure.length : null;
    const built = buildListListingsClauses({
      filter: "all", districts: districtNames, districtIds: closure ?? null,
      // astra §4.1：能力參數必須進 settings（顯示篩選讀 settings，不是 args 最上層）。
      settings: item.settings || {}, uid: 0, voteUid: 0, context, ...item.args,
    });
    const select = `SELECT ${deps.candidateColumns} FROM listings ${built.where}`;
    rec.sqlChars = select.length;
    rec.paramCount = built.params.length;
    // 記錄真正的參數數量與最大 placeholder 編號（astra §5.1 要求：不可只用 placeholder 個數推論上限）。
    rec.maxPlaceholder = built.params.length;
    rec.paramTypes = built.params.map((p) => (Array.isArray(p) ? `array[${p.length}]` : typeof p));

    // 1) 規劃（EXPLAIN 不執行查詢，但**仍受 statement_timeout 影響**：規劃本身也可能被取消）
    stageName = "explain";
    stageStart = Date.now();
    const plan = await client.query(`EXPLAIN (VERBOSE) ${toPostgresSql(select)}`, built.params);
    rec.explainMs = Date.now() - stageStart;
    rec.plan = plan.rows.map((r) => r["QUERY PLAN"]);

    // 2) 真跑一次（受閘門保護）⇒ 分類逾時 vs 斷線
    stageName = "run";
    stageStart = Date.now();
    const run = await client.query(toPostgresSql(select), built.params);
    rec.runMs = Date.now() - stageStart;
    rec.rows = run.rows.length;
    rec.outcome = "ok";
    if (baselineRows === null) baselineRows = rec.rows;
    // 能力是否真的生效（與 baseline 對照；相同 ⇒ 這個「能力」沒有作用，量到的不是它）
    rec.effective = item.label === "baseline" ? null : rec.rows !== baselineRows;
    // 3) astra §4.2：真實執行計畫（只在 ANALYZE=1 時）。用 loops × time 判斷熱點，
    //    並保留 rows／buffers（astra：seq scan 不自動代表缺索引，要看實際 rows／loops／buffers）。
    if (process.env.ANALYZE === "1") {
      stageName = "analyze";
      stageStart = Date.now();
      const json = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${toPostgresSql(select)}`,
        built.params,
      );
      rec.analyzeMs = Date.now() - stageStart;
      const root = json.rows[0]["QUERY PLAN"][0];
      const nodes = [];
      const walk = (node, depth = 0) => {
        nodes.push({
          node: node["Node Type"],
          relation: node["Relation Name"] || null,
          depth,
          rows: node["Actual Rows"],
          loops: node["Actual Loops"],
          totalMs: node["Actual Total Time"],
          workMs: Math.round((Number(node["Actual Total Time"]) || 0) * (Number(node["Actual Loops"]) || 1) * 100) / 100,
          hit: node["Shared Hit Blocks"],
          read: node["Shared Read Blocks"],
        });
        for (const child of node["Plans"] || []) walk(child, depth + 1);
      };
      walk(root);
      rec.analyze = {
        execMs: root["Execution Time"],
        planningMs: root["Planning Time"],
        nodes: nodes.length,
      };
      rec.analyzeHot = nodes.slice().sort((a, b) => b.workMs - a.workMs).slice(0, 5);
    }
  } catch (err) {
    rec.outcome = classify(err);
    // astra §4.1：失敗時間必須從**該階段開始**起算，不能沿用上一個階段（例如 EXPLAIN）的耗時。
    rec.failedAfterMs = Date.now() - stageStart;
    rec.failedStage = stageName;
  } finally {
    // 唯讀交易：一律 ROLLBACK（逾時後交易已中止，ROLLBACK 仍必要才不會把髒狀態留給下一個使用者）
    try { await client.query("ROLLBACK"); } catch { /* 唯讀；回滾失敗不影響本結論 */ }
    client.release();
  }
  console.log(`PGEX ${JSON.stringify(rec)}`);
}

await drv.pool.end();
