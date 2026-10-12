// 行政區關係閉包（`districtClosureIds`）的**真資料**逐列等價 ＋ 前後耗時腳本。
//
// 為什麼要獨立一支：`member-district-closure-parity.test.js` 用的是合成資料、離線測試用的是 PG 替身。
// 這一支在**真的 listings 表**上，對每一組真實輸入把兩條路徑的 id 集合逐筆相減，並印出
// 「只有舊實作有／只有新實作有」兩個集合（空集合也要印）。
//
// 用法（只在隔離靶上跑；會建立／覆寫本功能的兩張衍生表）：
//   PG_URL=<隔離庫> node v3/scripts/district-closure-parity.mjs [--rebuild] [--runs 3]
//   PG_URL=... node v3/scripts/district-closure-parity.mjs --compare before.json after.json
//
// 連線字串只從環境變數讀，不印出、不落地。目標庫必須通過 `assertPgTargetAllowed()`
// （預設允許清單：repro／repro2／tracker_test／crawl_sandbox；自建庫要明確設
// `ALLOW_PRODUCTION_PG_TARGET=1` —— 這是 repo 既有的那道登記過的閘）。
import { readFileSync, writeFileSync } from "node:fs";
import { districtKeyLists } from "../src/listDistrictSql.js";
import { resolveListDistrictNames } from "../src/db.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";

process.env.DATA_DIR ||= "/tmp/dc1-closure-parity";

const argv = process.argv.slice(2);
const flagValue = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const sorted = (ids) => [...(ids || [])].sort((a, b) => a - b);
const diff = (a, b) => {
  const other = new Set(b);
  return [...a].filter((id) => !other.has(id));
};

if (argv.includes("--compare")) {
  const beforePath = flagValue("compare");
  const afterPath = argv[argv.indexOf("--compare") + 2];
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const after = JSON.parse(readFileSync(afterPath, "utf8"));
  const failures = [];
  const byCase = new Map(after.cases.map((c) => [c.case, c]));
  for (const b of before.cases) {
    const a = byCase.get(b.case);
    if (!a) { failures.push(`${b.case}: 改動後缺這個案例`); continue; }
    if (a.onlyOld.length || a.onlyNew.length) failures.push(`${b.case}: 兩側差集不是空的`);
    if (a.materializedNull) failures.push(`${b.case}: 材料化沒有回答（退回即時算）`);
    if (a.oldCount !== a.newCount) failures.push(`${b.case}: 兩側數量不同 ${a.oldCount} -> ${a.newCount}`);
  }
  console.log(JSON.stringify({ compared: before.cases.length, identical: failures.length === 0, failures }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

const URL_ = String(process.env.PG_URL || process.env.PG_LIVE_REPRO_URL || "").trim();
if (!URL_) {
  console.error("需要 PG_URL（隔離靶；本腳本會建立本功能的衍生表）");
  process.exit(2);
}
const dbName = assertPgTargetAllowed("district-closure-parity", URL_);
const runs = Math.max(1, Number(flagValue("runs", 3)) || 3);

const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
const {
  districtClosureIdsLive,
} = await import("../src/listingSearchNodePg.js");
const {
  loadMaterializedDistrictClosure,
} = await import("../src/listingMatchComponents.js");
const {
  ensureMatchComponentsOnce, rebuildMatchComponents,
} = await import("../src/repository/writePath.js");
const { buildListRequestContextFromPg } = await import("../src/db.js");

const driver = await createPostgresDriver({ connectionString: URL_ });
const query = (sql, params = []) => driver.query(toPostgresSql(sql), params);
const exec = async (sql, params = []) => (await query(sql, params)).rows;

async function timed(fn) {
  const samples = [];
  let value = null;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    value = await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { value, median: samples[Math.floor(samples.length / 2)], min: samples[0], max: samples[samples.length - 1], samples };
}

try {
  await ensureMatchComponentsOnce(driver);
  const graph = (await exec("SELECT count(*) AS n FROM listings WHERE match_post_id > 0 OR match_post_id < 0"))[0];
  const probe = await buildListRequestContextFromPg(exec, { asOf: null, resolvedSearchKeys: undefined });
  const settings2 = probe.settingsForUser(2);
  const memberNames = resolveListDistrictNames({ districts: "", settings: settings2, uid: 2 });

  const cases = [
    {
      name: "① 會員 uid=2（settings 逐字複製、沒指定行政區）",
      districtNames: memberNames.length ? memberNames : ["中山區"],
      userId: 2, relatedOnly: true, keyword: "",
      note: memberNames.length ? "settings 解出的行政區" : "settings 解不出行政區 ⇒ 用中山區保底",
    },
    {
      name: "② 會員 uid=2 ＋ 明確選了行政區（中山區、大安區）",
      districtNames: ["中山區", "大安區"], userId: 2, relatedOnly: true, keyword: "",
    },
    {
      name: "③ 會員 uid=2 ＋ 沒選行政區但有關鍵字 q=101",
      districtNames: memberNames.length ? memberNames : ["中山區"],
      userId: 2, relatedOnly: true, keyword: "101",
    },
    {
      name: "④ 訪客 ＋ 明確選了行政區（中山區）",
      districtNames: ["中山區"], userId: 0, relatedOnly: false, keyword: "",
    },
    {
      name: "⑤ 訪客 ＋ 兩個行政區（松山區、信義區）",
      districtNames: ["松山區", "信義區"], userId: 0, relatedOnly: false, keyword: "",
    },
    {
      name: "⑥ 會員 uid=2 ＋ 未知行政區名（保底）",
      districtNames: ["不存在的區"], userId: 2, relatedOnly: true, keyword: "",
    },
  ];

  const rebuild = argv.includes("--rebuild")
    ? await timed(() => rebuildMatchComponents(driver, { reason: "parity", force: true }))
    : { value: null, median: null, min: null, max: null };

  const out = [];
  for (const item of cases) {
    const { allowed, allKeys } = districtKeyLists(item.districtNames);
    const opts = { districtNames: item.districtNames, userId: item.userId, relatedOnly: item.relatedOnly };
    const oldRun = await timed(() => districtClosureIdsLive(exec, opts));
    const newRun = await timed(() => loadMaterializedDistrictClosure(exec, {
      allowed, allKeys, userId: item.userId, relatedOnly: item.relatedOnly,
    }));
    const oldIds = oldRun.value || [];
    const newIds = newRun.value;
    // `allowed` 為空（例如查無此行政區名）時，兩條路徑都回 `null`（＝不需要縮減）⇒ 這一組不適用。
    const notApplicable = allowed.length === 0;
    const materializedNull = !notApplicable && !Array.isArray(newIds);
    const onlyOld = notApplicable ? [] : (materializedNull ? sorted(oldIds) : diff(oldIds, newIds));
    const onlyNew = materializedNull || notApplicable ? [] : diff(newIds, oldIds);
    out.push({
      case: item.name,
      note: item.note || "",
      districts: allowed.length,
      allDistricts: allowed.length === allKeys.length,
      notApplicable,
      userId: item.userId,
      relatedOnly: item.relatedOnly,
      keyword: item.keyword,
      oldCount: notApplicable ? 0 : oldIds.length,
      newCount: Array.isArray(newIds) ? newIds.length : 0,
      onlyOld, onlyNew, materializedNull,
      oldMs: { median: oldRun.median, min: oldRun.min, max: oldRun.max },
      newMs: Array.isArray(newIds) ? { median: newRun.median, min: newRun.min, max: newRun.max } : null,
    });
  }

  const report = {
    db: dbName,
    runs,
    graphRows: Number(graph.n),
    memberDistrictNames: memberNames.length,
    rebuild: rebuild.value ? { ...rebuild.value, ms: rebuild.median } : null,
    cases: out,
    allIdentical: out.every((c) => c.notApplicable || (!c.materializedNull && c.onlyOld.length === 0 && c.onlyNew.length === 0)),
  };
  const outPath = flagValue("out");
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    db: report.db, graphRows: report.graphRows, runs,
    rebuild: report.rebuild,
    allIdentical: report.allIdentical,
    cases: out.map((c) => ({
      case: c.case, oldCount: c.oldCount, newCount: c.newCount,
      onlyOld: c.onlyOld, onlyNew: c.onlyNew,
      oldMs: c.oldMs, newMs: c.newMs, materializedNull: c.materializedNull,
    })),
  }, null, 2));
  process.exit(report.allIdentical ? 0 : 1);
} finally {
  await driver.close();
}
