// 會員列表候選列的「舊／新」等價性驗證（唯讀；只在隔離量測庫上跑）。
//
// 舊路徑＝SQL 端 `ORDER BY post_id`（PG 在 work_mem 不足時會把整組排序溢寫磁碟）。
// 新路徑＝同一段 SQL **不帶 ORDER BY**，改由 Node 端 `orderCandidateRowsByPostId()` 排序。
//
// 這支腳本對同一組參數逐案斷言兩邊的 `post_id` 序列**逐筆相同**，並印出 EXPLAIN 的
// buffers read／temp（磁碟溢寫）差異。任何一筆不同就 exit 1。
//
// 用法：
//   PG_URL=<隔離庫連線字串> node v3/scripts/member-candidate-order-parity.mjs
//   （連線字串只從環境變數讀，腳本不印出、不落地。）
import { buildListRequestContextFromPg, buildListListingsClauses } from "../src/db.js";
import { loadSearchCandidateRows, orderCandidateRowsByPostId } from "../src/listingSearchNodePg.js";
import { sharedPgDriver, closeSharedPgDriver } from "../src/pgSharedDriver.js";
import { readPgRows, withPgReadSnapshot } from "../src/pgReadSnapshot.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { LIST_CANDIDATE_COLUMNS } from "../src/listingCandidateRow.js";

process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";
const uid = Number(process.env.MEMBER_UID || 1) || 1;
const pg = await sharedPgDriver();
const exec = (sql, params = []) => pg.query(toPostgresSql(sql), params).then((r) => r.rows);

const failures = await withPgReadSnapshot(pg, async (snapshot) => {
  const exec = (sql, params = []) => snapshot.query(toPostgresSql(sql), params).then((r) => r.rows);
  const context = await buildListRequestContextFromPg(exec, { asOf: null, resolvedSearchKeys: undefined });
  let settings = context.settingsForUser(uid);
  // PARITY_BROAD=1：行政區放全台 ⇒ 行政區子句不縮減候選，重現正式站最大候選集（17 萬列）。
  if (process.env.PARITY_BROAD === "1") {
    const { CITIES } = await import("../src/regions.js");
    settings = { ...settings, watchDistricts: CITIES.flatMap(city => city.districts.map(d => `${city.id}|${d.id}`)), searchUrls: [] };
  }

  // 邊界參數：空篩選、行政區（含單一與空）、q（行政區名／post_id 子字串／命中不到）、
  // 租金上下限、以及 fixture_namespace 有值的隔離子句。
  const samplePostId = Number((await exec("SELECT post_id FROM listings ORDER BY post_id LIMIT 1"))[0]?.post_id) || 0;
  const numericFragment = String(samplePostId).slice(-4);
  const CASES = [
    { name: "default(空篩選)", args: {} },
    { name: "districts=[中山區]", args: { districts: ["中山區"] } },
    { name: "q=行政區名", args: { q: "中山區" } },
    { name: `q=${numericFragment}(post_id 子字串)`, args: { q: numericFragment } },
    { name: "q=命中不到的字串", args: { q: "zzz-no-such-listing-zzz" } },
    { name: "租金 3000-8000", args: { settings: { ...settings, priceMin: 3000, priceMax: 8000 } } },
    { name: "租金 13500-36000", args: { settings: { ...settings, priceMin: 13500, priceMax: 36000 } } },
    { name: "多條件(行政區+q)", args: { districts: ["中山區"], q: "路" } },
    { name: "offline 混合(filter=all 已排除確認下架)", args: { filter: "all" } },
  ];

  async function buildFor(args, namespace = "") {
    const ctx = namespace
      ? await buildListRequestContextFromPg(exec, { namespace, asOf: null, resolvedSearchKeys: undefined })
      : context;
    return buildListListingsClauses({
      filter: args.filter || "all", kind: "", sources: "", q: args.q || "",
      searchKeys: args.searchKeys, districts: args.districts || [],
      settings: args.settings || settings, uid, voteUid: uid, context: ctx,
      // 一律用「已算好的關係 id 集合」形狀：PG 不接受 `appendDistrictCandidates` 的遞迴 CTE
      // （多個 recursive 分支），正式路徑也是走這一支（見 listingSearchNodePg.districtClosureIds）。
      districtRelatedIds: args.districtRelatedIds || [],
    }, { sqliteDb: null });
  }

  let failures = 0;
  const report = [];
  for (const testCase of CASES) {
    const built = await buildFor(testCase.args);
    const oldRows = await readPgRows(snapshot,
      toPostgresSql(`SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings ${built.where} ORDER BY post_id`),
      built.params, { arrayRows: true });
    const newRows = await loadSearchCandidateRows(snapshot, {
      candidateColumns: LIST_CANDIDATE_COLUMNS, built, reusableCandidates: null,
    });
    const oldIds = oldRows.map((row) => Number(row.post_id));
    const newIds = newRows.map((row) => Number(row.post_id));
    const sameOrder = oldIds.length === newIds.length && oldIds.every((id, i) => id === newIds[i]);
    // 也檢查「新路徑的輸出本身是 post_id 遞增」——那才是契約，不是碰巧。
    const ascending = newIds.every((id, i) => i === 0 || newIds[i - 1] <= id);
    if (!sameOrder || !ascending) failures += 1;
    report.push({ case: testCase.name, rows: newIds.length, sameOrder, ascending,
      oldHead: oldIds.slice(0, 5), newHead: newIds.slice(0, 5) });
    console.log(`${sameOrder && ascending ? "OK  " : "FAIL"} ${testCase.name}: rows=${newIds.length} sameOrder=${sameOrder} ascending=${ascending}`);
  }

  // fixture_namespace 有值的隔離子句（同一段 SQL、不同 context.isolation）。
  {
    const built = await buildFor({}, "stage1-fixture");
    const oldRows = await readPgRows(snapshot,
      toPostgresSql(`SELECT ${LIST_CANDIDATE_COLUMNS} FROM listings ${built.where} ORDER BY post_id`),
      built.params, { arrayRows: true });
    const newRows = await loadSearchCandidateRows(snapshot, { candidateColumns: LIST_CANDIDATE_COLUMNS, built, reusableCandidates: null });
    const oldIds = oldRows.map((row) => Number(row.post_id));
    const newIds = newRows.map((row) => Number(row.post_id));
    const sameOrder = oldIds.length === newIds.length && oldIds.every((id, i) => id === newIds[i]);
    if (!sameOrder) failures += 1;
    report.push({ case: "fixture_namespace=stage1-fixture", rows: newIds.length, sameOrder });
    console.log(`${sameOrder ? "OK  " : "FAIL"} fixture_namespace=stage1-fixture: rows=${newIds.length} sameOrder=${sameOrder}`);
  }

  const explain = async (sql, params) => {
    const rows = await exec(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const plan = rows[0]["QUERY PLAN"][0];
    const flat = [];
    const walk = (node) => { flat.push(node); (node.Plans || []).forEach(walk); };
    walk(plan.Plan);
    return {
      ms: Math.round(plan["Execution Time"]),
      read: flat.reduce((sum, node) => sum + (node["Shared Read Blocks"] || 0), 0),
      written: flat.reduce((sum, node) => sum + (node["Shared Written Blocks"] || 0), 0),
      temp_kb: Math.max(0, ...flat.map((node) => node["Sort Space Used"] || 0)),
      nodes: flat[0]?.["Node Type"],
    };
  };

  const built = await buildFor({});
  const columns = process.env.PARITY_EXPLAIN_COLUMNS || "post_id";
  console.log("EXPLAIN(舊=SQL ORDER BY)   ", JSON.stringify(await explain(`SELECT ${columns} FROM listings ${built.where} ORDER BY post_id`, built.params)));
  console.log("EXPLAIN(新=Node 端排序)    ", JSON.stringify(await explain(`SELECT ${columns} FROM listings ${built.where}`, built.params)));

  console.log(JSON.stringify({ memberUid: uid, cases: report.length, failures, report }, null, 2));
  return failures;
});
await closeSharedPgDriver();
process.exit(failures ? 1 : 0);
