// 材料化「配對圖連通分量」的**新鮮度**驗證（L-0873 的第二層：一致性不等於新鮮度）。
//
// 為什麼要獨立一支：
//   • `district-closure-parity.mjs` 比的是「新舊兩條路徑的答案相同」——那是**一致性**。
//     如果兩邊都讀同一個過時的固化欄，它們會一起錯。
//   • 這一支對**當前** `listings` 全量重算一次連通分量，與材料化表**逐列**比對 ⇒ `drift=0`；
//     而且每次比對都綁在**當下的資料版本**（`data_revision.MAX(id)` ＋ 邊集合指紋）上，
//     版本在比對期間一變就直接判失敗（不是只看時間）。
//
// 用法（只在隔離靶上跑；會建立／覆寫本功能的兩張衍生表與 `listings` 的幾條測試邊）：
//   PG_URL=<隔離庫> node v3/scripts/match-component-drift.mjs [--scenario additions|removals|both] [--json]
//
// 連線字串只從環境變數讀，不印出、不落地。目標庫必須通過 `assertPgTargetAllowed()`。
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { districtKeyLists } from "../src/listDistrictSql.js";
import { componentLabels, loadMaterializedDistrictClosure, MATCH_COMPONENT_TABLE } from "../src/listingMatchComponents.js";
import { ensureMatchComponentsOnce, rebuildMatchComponents, absorbMatchComponentDelta } from "../src/repository/writePath.js";
import { districtClosureIds, districtClosureIdsLive } from "../src/listingSearchNodePg.js";

process.env.DATA_DIR ||= "/tmp/dc2-drift";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const scenario = String(flag("scenario", "both"));
const asJson = argv.includes("--json");
const URL_ = String(process.env.PG_URL || "").trim();
if (!URL_) {
  console.error("需要 PG_URL（隔離靶；本腳本會寫本功能的衍生表與幾條測試邊）");
  process.exit(2);
}
const dbName = assertPgTargetAllowed("match-component-drift", URL_);

const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
const driver = await createPostgresDriver({ connectionString: URL_ });
const query = (sql, params = []) => driver.query(toPostgresSql(sql), params);
const exec = async (sql, params = []) => (await query(sql, params)).rows;

const stamp = async () => {
  const rows = await exec(
    `SELECT (SELECT COALESCE(MAX(id), 0) FROM data_revision) AS revision,
            (SELECT count(*) FROM listings WHERE match_post_id > 0 OR match_post_id < 0) AS edges,
            (SELECT COALESCE(sum(post_id), 0) FROM listings WHERE match_post_id > 0 OR match_post_id < 0) AS sum_ids,
            (SELECT COALESCE(sum(COALESCE(match_post_id, 0)), 0) FROM listings WHERE match_post_id > 0 OR match_post_id < 0) AS sum_matches`,
  );
  return `${rows[0].revision}|${rows[0].edges}|${rows[0].sum_ids}|${rows[0].sum_matches}`;
};

/** 對**當前** listings 全量重算分量（與寫入端共用 `componentLabels`），回傳 post_id → 分量代表。 */
async function recomputeLabels() {
  const edges = await exec("SELECT post_id, match_post_id FROM listings WHERE match_post_id > 0 OR match_post_id < 0");
  const pairs = [];
  for (const row of edges) {
    const a = Number(row.post_id) || 0;
    const b = Number(row.match_post_id) || 0;
    if (a && b) pairs.push([a, b]);
  }
  return componentLabels(pairs).allLabels();
}

/** 逐列比對材料化表與全量重算：回傳 drift（含少了／多了／分量不同／前綴不同）。 */
async function driftRows(expected) {
  const rows = await exec(`SELECT post_id, component_id, district_prefix FROM ${MATCH_COMPONENT_TABLE}`);
  const seen = new Set();
  const out = { missing: [], extra: [], wrongComponent: [], wrongPrefix: 0, rows: rows.length, expected: expected.size };
  const prefixRows = await exec(
    `SELECT post_id, (split_part(COALESCE(source_key, ''), '|', 1) || '|' || split_part(COALESCE(source_key, ''), '|', 2)) AS district_prefix
       FROM listings WHERE post_id = ANY($1::bigint[])`,
    [[...expected.keys()]],
  );
  const prefixOf = new Map(prefixRows.map((row) => [Number(row.post_id), row.district_prefix == null ? null : String(row.district_prefix)]));
  for (const row of rows) {
    const id = Number(row.post_id);
    seen.add(id);
    if (!expected.has(id)) { out.extra.push(id); continue; }
    if (Number(row.component_id) !== Number(expected.get(id))) out.wrongComponent.push(id);
    const live = prefixOf.has(id) ? prefixOf.get(id) : null;
    const stored = row.district_prefix == null ? null : String(row.district_prefix);
    if (live !== stored) out.wrongPrefix += 1;
  }
  for (const id of expected.keys()) if (!seen.has(id)) out.missing.push(id);
  out.drift = out.missing.length + out.extra.length + out.wrongComponent.length + out.wrongPrefix;
  return out;
}

const sorted = (ids) => [...(ids || [])].sort((a, b) => a - b);
async function closurePair(districtNames) {
  const keys = districtKeyLists(districtNames);
  const live = await districtClosureIdsLive(exec, { districtNames, userId: 0, relatedOnly: false });
  const materialized = await loadMaterializedDistrictClosure(exec, {
    allowed: keys.allowed, allKeys: keys.allKeys, userId: 0, relatedOnly: false,
  });
  const a = sorted(live);
  const b = sorted(materialized);
  return {
    liveCount: a.length, materializedCount: b.length,
    equal: JSON.stringify(a) === JSON.stringify(b),
    onlyLive: a.filter((id) => !b.includes(id)).slice(0, 10),
    onlyMaterialized: b.filter((id) => !a.includes(id)).slice(0, 10),
  };
}

const report = { db: dbName, scenario, steps: [] };
try {
  await ensureMatchComponentsOnce(driver);
  const before = await stamp();
  await rebuildMatchComponents(driver, { reason: "drift-bootstrap", force: true });
  report.bootstrap = { stamp: await stamp(), drift: await driftRows(await recomputeLabels()) };

  // 「新增邊」＝在一條**本來沒有邊**的列上放一條邊（`match_post_id = 0`）：
  // 這樣才是「只增不減」（把既有邊換目標是 retarget＝有減，會走受影響分量重建那條路）。
  const pick = async () => {
    const rows = await exec(
      `SELECT post_id, match_post_id FROM listings WHERE match_post_id > 0 OR match_post_id < 0 ORDER BY post_id LIMIT 200`,
    );
    const b = Number(rows[0].post_id);
    const free = await exec(
      `SELECT post_id FROM listings WHERE COALESCE(match_post_id, 0) = 0 AND post_id <> $1 ORDER BY post_id LIMIT 1`, [b],
    );
    return [Number(free[0]?.post_id) || 0, b];
  };

  if (scenario === "additions" || scenario === "both") {
    const [a, b] = await pick();
    const beforeStamp = await stamp();
    const beforeDrift = await driftRows(await recomputeLabels());
    // 模擬爬蟲：把 a 的邊指到 b（a 自己原本的舊邊留著不動——這是「只增」）
    // ⚠️ 一定要**同時 bump data_revision**：正式站的寫入端（listingMatchAsync／crawlerWrites）
    // 就是在同一個交易裡 bump，讀取端的逐列證明才看得到這一筆（不 bump 等於帶外寫入，
    // 那是文件裡明列的殘留窗口，不是這支腳本要測的情境）。
    await exec("UPDATE listings SET match_post_id = $1 WHERE post_id = $2", [b, a]);
    await exec(
      "INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES ('listing', $1, 'same_house_match', $2)",
      [a, Date.now()],
    );
    const afterChangeStamp = await stamp();
    const closureWithOverlay = await closurePair(["中山區"]);
    const absorbStarted = Date.now();
    const absorbed = await absorbMatchComponentDelta(driver, { kind: "added", nodes: [a, b] });
    const absorbMs = Date.now() - absorbStarted;
    const afterAbsorbStamp = await stamp();
    const closureAfterAbsorb = await closurePair(["中山區"]);
    const drift = await driftRows(await recomputeLabels());
    report.steps.push({
      name: "additions",
      edge: [a, b],
      beforeStamp, afterChangeStamp, afterAbsorbStamp,
      versionStable: afterChangeStamp === afterAbsorbStamp,
      closureWithOverlay, closureAfterAbsorb, absorbMs, absorbed, drift,
      ok: closureWithOverlay.equal && closureAfterAbsorb.equal && drift.drift === 0 && afterChangeStamp === afterAbsorbStamp,
    });
    await exec("UPDATE listings SET match_post_id = 0 WHERE post_id = $1", [a]);
    await exec(
      "INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES ('listing', $1, 'same_house_match', $2)",
      [a, Date.now()],
    );
    const repaired = await absorbMatchComponentDelta(driver, { kind: "affected", nodes: [a, b] });
    await rebuildMatchComponents(driver, { reason: "drift-restore", force: true });
    report.steps.push({ name: "restore-after-additions", repaired, drift: await driftRows(await recomputeLabels()) });
    void beforeStamp; void beforeDrift;
  }

  if (scenario === "removals" || scenario === "both") {
    const rows = await exec(
      `SELECT post_id, match_post_id FROM listings WHERE (match_post_id > 0 OR match_post_id < 0) AND post_id = match_post_id ORDER BY post_id LIMIT 1`,
    );
    const selfLoops = await exec(
      `SELECT post_id, match_post_id FROM listings WHERE match_post_id > 0 OR match_post_id < 0 ORDER BY post_id LIMIT 200`,
    );
    void rows;
    const target = selfLoops.find((row) => Number(row.match_post_id) !== Number(row.post_id));
    const node = Number(target?.post_id) || 0;
    const oldMatch = Number(target?.match_post_id) || 0;
    if (node && oldMatch) {
      const beforeStamp = await stamp();
      await exec("UPDATE listings SET match_post_id = 0 WHERE post_id = $1", [node]);
      await exec(
        "INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES ('listing', $1, 'same_house_match', $2)",
        [node, Date.now()],
      );
      const afterChangeStamp = await stamp();
      // 讀取端必須「退回即時算」（邊消失＝有減），不是硬用舊分量。
      const materializedAfterRemoval = await loadMaterializedDistrictClosure(exec, {
        allowed: [], allKeys: [], userId: 0, relatedOnly: false,
      });
      void materializedAfterRemoval;
      const keys = districtKeyLists(["中山區"]);
      const overlayAfterRemoval = await loadMaterializedDistrictClosure(exec, {
        allowed: keys.allowed, allKeys: keys.allKeys, userId: 0, relatedOnly: false,
      });
      const absorbStarted = Date.now();
      const absorbed = await absorbMatchComponentDelta(driver, { kind: "affected", nodes: [node, oldMatch] });
      const absorbMs = Date.now() - absorbStarted;
      const afterAbsorbStamp = await stamp();
      const closureAfterAbsorb = await closurePair(["中山區"]);
      const drift = await driftRows(await recomputeLabels());
      report.steps.push({
        name: "removals",
        node, oldMatch, beforeStamp, afterChangeStamp, afterAbsorbStamp,
        versionStable: afterChangeStamp === afterAbsorbStamp,
        bailedToLiveOnRemoval: Array.isArray(overlayAfterRemoval) === false,
        closureAfterAbsorb, absorbMs, absorbed, drift,
        ok: Array.isArray(overlayAfterRemoval) === false && closureAfterAbsorb.equal && drift.drift === 0 && afterChangeStamp === afterAbsorbStamp,
      });
      await exec("UPDATE listings SET match_post_id = $1 WHERE post_id = $2", [oldMatch, node]);
      await absorbMatchComponentDelta(driver, { kind: "affected", nodes: [node, oldMatch] });
      report.steps.push({ name: "restore-after-removal", drift: await driftRows(await recomputeLabels()) });
    } else {
      report.steps.push({ name: "removals", skipped: "找不到可移除的邊" });
    }
  }

  report.stampStart = before;
  report.stampEnd = await stamp();
  report.allOk = report.steps.filter((step) => step.ok !== undefined).every((step) => step.ok === true);
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`DRIFT db=${report.db} scenario=${report.scenario} allOk=${report.allOk}`);
    for (const step of report.steps) {
      if (step.ok === undefined) { console.log(`  - ${step.name}: ${JSON.stringify(step)}`); continue; }
      console.log(`  - ${step.name}: ok=${step.ok} drift=${step.drift.drift} absorbMs=${step.absorbMs} 版本穩定=${step.versionStable} 閉包相同=${step.closureAfterAbsorb.equal}`);
      if (step.drift.drift) console.log(`      drift 明細 ${JSON.stringify(step.drift)}`);
      if (!step.closureAfterAbsorb.equal) console.log(`      onlyLive=${JSON.stringify(step.closureAfterAbsorb.onlyLive)} onlyMaterialized=${JSON.stringify(step.closureAfterAbsorb.onlyMaterialized)}`);
    }
  }
  process.exit(report.allOk ? 0 : 1);
} finally {
  await driver.close();
}
