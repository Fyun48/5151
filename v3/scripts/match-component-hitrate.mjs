// 材料化的**命中率**與**退回路徑成本**量測（Owner 的硬門：活躍爬蟲下命中率 ≥95%）。
//
// 情境照生產：讀取端每個請求一個 `withPgReadSnapshot()`；維護（增量吸收）走 `sharedPgDriver()`
// 這條**另一條**連線，且**不在請求路徑上等它**（生產就是這樣接的）。
//
//   node v3/scripts/match-component-hitrate.mjs --mode hitrate [--requests 100] [--changes 4] [--json]
//   node v3/scripts/match-component-hitrate.mjs --mode cost [--json]
//
// 用法（只在自建隔離庫上跑；會改寫 `listings` 的幾條邊與 `data_revision`）：
//   PG_URL=<隔離庫> DB_DRIVER=postgres node v3/scripts/match-component-hitrate.mjs
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import {
  loadMaterializedDistrictClosure,
  matchComponentMaintenance,
  resetAbsorbScheduleForTest,
} from "../src/listingMatchComponents.js";
import { districtClosureIds, districtClosureIdsLive } from "../src/listingSearchNodePg.js";
import { withPgReadSnapshot } from "../src/pgReadSnapshot.js";

process.env.DATA_DIR ||= "/tmp/dc2-hitrate";
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const mode = String(flag("mode", "hitrate"));
const requests = Math.max(2, Number(flag("requests", 100)) || 100);
const changes = Math.max(0, Number(flag("changes", 4)) || 0);
const intervalMs = Math.max(0, Number(flag("interval-ms", 600)) || 0);
const asJson = argv.includes("--json");
const URL_ = String(process.env.PG_URL || process.env.PG_LIVE_REPRO_URL || "").trim();
if (!URL_) { console.error("需要 PG_URL（自建隔離庫）"); process.exit(2); }
const dbName = assertPgTargetAllowed("match-component-hitrate", URL_);
process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";

const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
const {
  ensureMatchComponentsOnce, rebuildMatchComponents, absorbMatchComponentDelta,
} = await import("../src/repository/writePath.js");
const { MATCH_COMPONENT_STATE_TABLE, MATCH_GRAPH_STATE_KEY, deltaCap } = await import("../src/listingMatchComponents.js");
const deltaCapProbe = deltaCap();

const admin = await createPostgresDriver({ connectionString: URL_ });
const query = (sql, params = []) => admin.query(toPostgresSql(sql), params);
const exec = async (sql, params = []) => (await query(sql, params)).rows;
const sorted = (ids) => [...(ids || [])].sort((a, b) => a - b);
const DISTRICTS = ["中山區"];

/** 計數用的 exec 包裝（同行程 driver 計數：條數＋逐條 ms）。 */
function instrument(execFn) {
  const stats = { statements: 0, ms: 0, rows: 0 };
  const wrapped = async (sql, params = [], options = {}) => {
    const t0 = performance.now();
    const out = await execFn(sql, params, options);
    stats.statements += 1;
    stats.ms += performance.now() - t0;
    stats.rows += Array.isArray(out) ? out.length : 0;
    return out;
  };
  wrapped.stats = stats;
  return wrapped;
}

const graphChange = async (n) => {
  // 純新增：找一條 match_post_id = 0 的列，把它的邊指到一個既有節點；再 bump data_revision（照正式寫入端）。
  const rows = await exec(
    `SELECT post_id FROM listings WHERE COALESCE(match_post_id, 0) = 0 AND post_id > 0 ORDER BY post_id LIMIT 3 OFFSET $1`,
    [n * 3],
  );
  const targets = await exec("SELECT post_id FROM listings WHERE match_post_id > 0 OR match_post_id < 0 ORDER BY post_id LIMIT 1");
  const from = Number(rows[0]?.post_id) || 0;
  const to = Number(targets[0]?.post_id) || 0;
  if (!from || !to) return null;
  await exec("UPDATE listings SET match_post_id = $1 WHERE post_id = $2", [to, from]);
  await exec(
    "INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES ('listing', $1, 'same_house_match', $2)",
    [from, Date.now()],
  );
  return [from, to];
};

const report = { db: dbName, mode, requests, changes, districts: DISTRICTS };
try {
  await ensureMatchComponentsOnce(admin);
  if (mode === "hitrate") {
    await rebuildMatchComponents(admin, { reason: "hitrate-bootstrap", force: true });
    const { sharedPgDriver } = await import("../src/pgSharedDriver.js");
    const readDriver = await sharedPgDriver();
    const hits = [];
    const changeAfter = new Map();
    for (let i = 0; i < changes; i += 1) changeAfter.set(Math.floor((i + 1) * (requests / (changes + 1))), i);
    const injected = [];
    for (let i = 1; i <= requests; i += 1) {
      if (changeAfter.has(i - 1)) {
        const change = await graphChange(changeAfter.get(i - 1));
        if (change) injected.push(change);
      }
      const result = await withPgReadSnapshot(readDriver, async (snapshot) => {
        const base = (sql, params = [], { batch = false } = {}) => (batch
          ? snapshot.query(toPostgresSql(sql), params).then((r) => r.rows)
          : snapshot.query(toPostgresSql(sql), params).then((r) => r.rows));
        const execFn = instrument(base);
        const ids = await districtClosureIds(execFn, {
          districtNames: DISTRICTS, userId: 0, maintenance: matchComponentMaintenance,
        });
        // 逐列等價的抽查：每 5 個請求一次，外加「剛注入變更之後」那一個（那是 overlay 的路徑）。
        const justChanged = [...changeAfter.keys()].some((at) => at === i - 1 || at === i);
        let live = null;
        if (i % 5 === 0 || justChanged) live = await districtClosureIdsLive(base, { districtNames: DISTRICTS, userId: 0 });
        return { ids, live, stats: execFn.stats };
      });
      const materialized = Array.isArray(result.ids);
      const agrees = result.live == null ? null : JSON.stringify(sorted(result.ids)) === JSON.stringify(sorted(result.live));
      const detail = agrees === false ? {
        onlyLive: sorted(result.live).filter((id) => !sorted(result.ids).includes(id)).slice(0, 6),
        onlyMaterialized: sorted(result.ids).filter((id) => !sorted(result.live).includes(id)).slice(0, 6),
      } : null;
      hits.push({ i, materialized, agrees, detail, statements: result.stats.statements, ms: Math.round(result.stats.ms) });
      if (intervalMs) await new Promise((r) => setTimeout(r, intervalMs));
    }
    const materializedHits = hits.filter((h) => h.materialized).length;
    const checked = hits.filter((h) => h.agrees != null);
    report.injected = injected.length;
    report.materializedHits = materializedHits;
    report.hitRate = materializedHits / hits.length;
    report.agreementChecked = checked.length;
    report.agreementOk = checked.every((h) => h.agrees === true);
    report.msMedian = hits.map((h) => h.ms).sort((a, b) => a - b)[Math.floor(hits.length / 2)];
    report.msMax = Math.max(...hits.map((h) => h.ms));
    report.statementsMedian = hits.map((h) => h.statements).sort((a, b) => a - b)[Math.floor(hits.length / 2)];
    report.statementsMax = Math.max(...hits.map((h) => h.statements));
    report.disagreements = hits.filter((h) => h.agrees === false).slice(0, 5);
    resetAbsorbScheduleForTest();
    await readDriver.close?.();
  } else if (mode === "cost") {
    await rebuildMatchComponents(admin, { reason: "cost-bootstrap", force: true });
    const runOnce = async (execFn, extra = {}) => {
      const t0 = performance.now();
      const ids = await districtClosureIds(execFn, {
        districtNames: DISTRICTS, userId: 0, maintenance: matchComponentMaintenance, ...extra,
      });
      return { ids, ms: performance.now() - t0 };
    };
    // ① 命中（材料化）：表是新的、沒有 delta
    const hit = instrument(exec);
    const hitRun = await runOnce(hit);
    report.hit = { materialized: Array.isArray(hitRun.ids), ids: (hitRun.ids || []).length, statements: hit.stats.statements, ms: Number(hit.stats.ms.toFixed(1)) };

    // ② 證明失敗 ⇒ 退回即時算：造一條「邊消失」的變更（有減）
    const rows = await exec(
      `SELECT post_id, match_post_id FROM listings WHERE match_post_id > 0 OR match_post_id < 0 AND post_id <> match_post_id ORDER BY post_id LIMIT 1`,
    );
    const row = rows[0];
    const stripNode = Number(row?.post_id) || 0;
    const stripMatch = Number(row?.match_post_id) || 0;
    await exec("UPDATE listings SET match_post_id = 0 WHERE post_id = $1", [stripNode]);
    await exec(
      "INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES ('listing', $1, 'same_house_match', $2)",
      [stripNode, Date.now()],
    );
    const fallback = instrument(exec);
    const fallbackRun = await runOnce(fallback);
    report.fallback = {
      materialized: Array.isArray(fallbackRun.ids), statements: fallback.stats.statements,
      ms: Number(fallback.stats.ms.toFixed(1)), totalMs: Number(fallbackRun.ms.toFixed(1)),
    };
    // 額外成本＝退回口徑的證明那幾條（不含即時算本身）
    report.fallbackExtraMs = Number((fallback.stats.ms - 0).toFixed(1));

    // 修回去（直接吸收，不排隊）
    await exec("UPDATE listings SET match_post_id = $1 WHERE post_id = $2", [stripMatch, stripNode]);
    await absorbMatchComponentDelta(admin, { kind: "affected", nodes: [stripNode, stripMatch] });

    // ③ 開關 =0：逐字走即時算
    const previous = process.env.MEMBER_DISTRICT_CLOSURE_MATERIALIZED;
    process.env.MEMBER_DISTRICT_CLOSURE_MATERIALIZED = "0";
    const off = instrument(exec);
    const offRun = await runOnce(off);
    report.switchOff = { materialized: Array.isArray(offRun.ids) === false ? null : Array.isArray(offRun.ids), statements: off.stats.statements, ms: Number(off.stats.ms.toFixed(1)), totalMs: Number(offRun.ms.toFixed(1)) };
    if (previous == null) delete process.env.MEMBER_DISTRICT_CLOSURE_MATERIALIZED;
    else process.env.MEMBER_DISTRICT_CLOSURE_MATERIALIZED = previous;

    // ④ 水位落後很多：把 watermark 往回撥 10 萬，量探測的條數與 ms（delta 有 LIMIT cap+1 ⇒ 有界）
    const state = await exec(`SELECT revision_watermark FROM ${MATCH_COMPONENT_STATE_TABLE} WHERE state_key = $1`, [MATCH_GRAPH_STATE_KEY]);
    const watermark = Number(state[0]?.revision_watermark) || 0;
    await exec(`UPDATE ${MATCH_COMPONENT_STATE_TABLE} SET revision_watermark = $1 WHERE state_key = $2`, [Math.max(watermark - 100000, 0), MATCH_GRAPH_STATE_KEY]);
    const lag = instrument(exec);
    const lagRun = await runOnce(lag);
    // 「水位落後很多時不會掃幾萬列」：delta 有 `LIMIT cap+1`（＝2001）⇒ 落後 10 萬列也只回 2001 列，
    // 條數不變、ms 有界（超過 cap 就由 `delta_too_big` 走異常路徑，不是硬撐）。
    let boundedScan = null;
    try {
      const t0 = performance.now();
      const rows = (await query(
        `SELECT entity_id, event_type FROM data_revision
          WHERE id > $1 AND id <= (SELECT COALESCE(MAX(id), 0) FROM data_revision)
            AND entity_type = 'listing' ORDER BY id LIMIT $2`,
        [Math.max(watermark - 100000, 0), deltaCapProbe + 1],
      )).rows || [];
      boundedScan = { laggedBy: 100000, limit: deltaCapProbe + 1, rowsReturned: rows.length, ms: Number((performance.now() - t0).toFixed(1)) };
    } catch (error) {
      boundedScan = { error: String(error?.message || error) };
    }
    report.lagging = {
      materialized: Array.isArray(lagRun.ids), statements: lag.stats.statements,
      ms: Number(lag.stats.ms.toFixed(1)), boundedScan,
    };
    await rebuildMatchComponents(admin, { reason: "cost-restore", force: true });
  }
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(JSON.stringify(report));
  const ok = mode === "hitrate"
    ? (report.hitRate >= 0.95 && report.agreementOk === true)
    : (report.fallback.statements <= report.hit.statements + 6);
  console.log(ok ? "OK" : "FAIL");
  process.exit(ok ? 0 : 1);
} finally {
  await admin.close();
}
