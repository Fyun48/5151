// 43 欄 vs 23 欄 A/B（依 astra 2026-09-25 裁決 §5A 重寫）。
//
// 修正前一版的四個問題 ✗：
//   1. builder 的 SQL 沒過 `toPostgresSql()`（`?` → `$n`）✗ ⇒ 現在一律轉換 ✓。
//   2. **不得把整棵 plan 的 buffers 逐節點加總** ✗（PG：父節點已包含子節點 ✓）
//      ⇒ 改取**根節點自身**的 hit／read／temp 並分開列出 ✓；子節點只用來定位熱點 ✓。
//   3. 只跑 EXPLAIN 不能代替端到端 ✗ ⇒ 每變體另外**真正執行 SELECT**，量 wall time／rows／
//      JS 端 payload 大小 ✓（標明這只是 JS 端代理，**不等於** wire bytes ✓）。
//   4. 沒有暖機與交替 ✗ ⇒ A/B 交替執行、各自暖機，避免第一組替第二組暖快取 ✓。
//
// 仍需注意 ✓：`buffers × block size` 是**存取量**的解讀，不等於「從磁碟讀了多少不同資料」✗；
// 縮欄位可能減少傳輸／反序列化／配置／TOAST 成本，但不保證 heap buffers 必降 ✓。
//
// ⚠️ 執行前提（裁決 §6.3）：精確 SHA 的隔離 checkout／測試映像 ＋ 拋棄式或受控測試資料 ✓。
// 容器內的部署映像較舊（缺新 exports ✗），直接跑會得到 SyntaxError ✓。
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { buildListRequestContextFromPg, buildListListingsClauses } from "../src/db.js";
import { districtClosureIds } from "../src/listingSearchNodePg.js";
import { toPostgresSql } from "../src/sqlDialect.js";

const COLS_43 = `post_id, source, source_id, source_key, url, price, price_num,
  extra_fee, extra_fees, extra_fee_text, price_contain_text,
  title, address, address_norm, area_name, layout, floor_name, kind_name, tags,
  role_name, contact_name, contact_role, contact_uid, agency,
  lat, lng, geo_source, location_class, match_post_id, match_level,
  match_verdict, match_rejected, offline, offline_confirmed, hidden, hidden_at,
  last_event, first_seen_at, last_seen_at, refresh_time, listed_by_user_id, self_status`;

// 控制組（窄版；**不是**正式使用值 ✗ —— 正式仍為寬欄位 ✓）
const COLS_23 = `post_id, source, price, price_num, title, address, area_name, floor_name, kind_name, tags,
  lat, lng, geo_source, location_class, match_post_id, match_level, match_verdict,
  offline, offline_confirmed, hidden, hidden_at, refresh_time, contact_uid`;

const WARMS = Number(process.env.WARMS || 2);
const RUNS = Number(process.env.RUNS || 5);

// 根節點自身的 buffers ✓（✗ 不加總子節點 —— PG 的父節點已包含子節點 ✓）
function rootBuffers(root) {
  const num = (key) => Number(root?.[key]) || 0;
  return {
    hit: num("Shared Hit Blocks"),
    read: num("Shared Read Blocks"),
    dirtied: num("Shared Dirtied Blocks"),
    tempRead: num("Temp Read Blocks"),
    tempWritten: num("Temp Written Blocks"),
  };
}

// 子節點只用於定位熱點 ✓（分開回報，不併入總量 ✓）
function hotNodes(root, limit = 3) {
  const list = [];
  const walk = (node, depth = 0) => {
    list.push({
      node: node["Node Type"],
      relation: node["Relation Name"] || null,
      depth,
      rows: node["Actual Rows"],
      loops: node["Actual Loops"],
      buffers: (Number(node["Shared Hit Blocks"]) || 0) + (Number(node["Shared Read Blocks"]) || 0),
    });
    for (const child of node["Plans"] || []) walk(child, depth + 1);
  };
  walk(root);
  return list.sort((a, b) => b.buffers - a.buffers).slice(0, limit);
}

async function measure(drv, label, columns, where, params) {
  const explainSql = `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
    SELECT ${columns} FROM listings ${where} ORDER BY post_id`;
  const explain = await drv.query(toPostgresSql(explainSql), params);
  const top = explain.rows[0]["QUERY PLAN"][0];
  const root = top.Plan || top;

  const selectSql = `SELECT ${columns} FROM listings ${where} ORDER BY post_id`;
  const started = process.hrtime.bigint();
  const result = await drv.query(toPostgresSql(selectSql), params);
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

  return {
    label,
    explainExecMs: top["Execution Time"],
    planningMs: top["Planning Time"],
    rootBuffers: rootBuffers(root),
    hot: hotNodes(root),
    endToEnd: {
      wallMs: Math.round(wallMs * 100) / 100,
      rows: result.rows.length,
      payloadChars: JSON.stringify(result.rows).length,
    },
  };
}

const drv = await createPostgresDriver({ env: process.env });
try {
  const exec = async (sql, params = []) => (await drv.query(toPostgresSql(sql), params)).rows;

  // CI 拋棄式 PG 內 `listings` **是空的** ✗（實測 `COLAB-KEYS count 0` ✓）⇒ A/B 必須**自建 fixture** ✓。
  // 照 seed fixture 測試的作法自行 INSERT ✓：只帶 5 個無 DEFAULT 的 NOT NULL 欄 ＋ `offline` ✓
  //（其餘靠 schema DEFAULT ✓）。`source_key` 用可辨識前綴 ✓ 以便收尾清理 ✓。
  const fixtureRows = Number(process.env.FIXTURE_ROWS || 500);
  const iso = new Date().toISOString();
  const tuples = [];
  const fixtureParams = [];
  for (let i = 0; i < fixtureRows; i += 1) {
    const base = i * 6;
    tuples.push(`($${base + 1}, 'houseprice', $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, 0)`);
    fixtureParams.push(
      900100000 + i,
      `colab|${i}`,
      `fixture 標題 ${i} ${"寬欄位代表".repeat(i % 3)}`,
      `https://example.test/colab/${i}`,
      iso,
      iso,
    );
  }
  await drv.query(
    `INSERT INTO listings (post_id, source, source_key, title, url, first_seen_at, last_seen_at, offline)
     VALUES ${tuples.join(",")} ON CONFLICT (post_id) DO NOTHING`,
    fixtureParams,
  );
  const fixturePresent = await drv.query(
    "SELECT COUNT(*)::int AS n FROM listings WHERE source_key LIKE 'colab|%'",
  );
  console.log(`COLAB-FIXTURE ${JSON.stringify({ requested: fixtureRows, present: fixturePresent.rows[0].n })}`);
  const context = await buildListRequestContextFromPg(exec);
  // 官方 builder（含 district closure ✓）—— 不自行拼行政區條件 ✗
  // 行政區條件必須走 **PG 路徑** ✓（照 `listingSearchNodePg.js:204`）：
  //     districtIds = await districtClosureIds(exec, { districtNames }) ✓
  // ✗ 不可傳 `districts:` —— 那會讓 builder 走 **SQLite 的 recursive CTE** ⇒ PG 回 42P19 ✓
  //（本 CI 已實測：`recursive reference to query "district_related" ...` ✗）。
  // 其餘組裝（`SELECT … FROM listings ${built.where} ORDER BY post_id` ✓）與正式路徑逐字相同 ✓。
  const districtNames = [process.env.DISTRICT || "西屯區"];
  const districtIds = await districtClosureIds(exec, { districtNames });
  // 受測語句**必須真的回資料** ✓（§3k 教訓：`rows: 0` ⇒ 百分比只是雜訊 ✗）。
  // 鍵集改由 **PG 自身**取得 ✓ —— 不可沿用 SQLite 風味的 context 鍵（與鏡射列對不上 ⇒ 0 列 ✗）。
  const keyRows = await drv.query(
    "SELECT DISTINCT search_key FROM listings WHERE COALESCE(search_key, '') <> '' LIMIT 20",
  );
  const searchKeys = keyRows.rows.map((row) => row.search_key).filter(Boolean);
  console.log(`COLAB-KEYS ${JSON.stringify({ count: searchKeys.length })}`);
  const built = buildListListingsClauses({
    filter: "all", districts: [], districtIds, searchKeys,
    settings: {}, uid: 0, voteUid: 0, context,
  });
  console.log(`COLAB-WHERE ${JSON.stringify({ where: String(built.where).slice(0, 120), params: built.params.length })}`);

  const variants = [["43cols", COLS_43], ["23cols", COLS_23]];
  for (let i = 0; i < WARMS; i += 1) {
    for (const [label, cols] of variants) await measure(drv, label, cols, built.where, built.params);
  }
  const runs = { "43cols": [], "23cols": [] };
  for (let i = 0; i < RUNS; i += 1) {
    for (const [label, cols] of variants) {
      runs[label].push(await measure(drv, label, cols, built.where, built.params));
    }
  }
  for (const label of Object.keys(runs)) {
    const list = runs[label];
    if (!list[0].endToEnd.rows) {
      // ✗ 退化量測必須顯性標記 ✓：診斷步驟是 continue-on-error ⇒ 非零碼不會讓 job 變紅 ✓，
      // 但會在日誌留下明確的「量測無效」訊號 ✓，避免雜訊被誤讀成 43→23 的收益 ✗。
      console.log(`COLAB-INVALID ${JSON.stringify({
        label, rows: 0,
        note: "受測查詢沒回任何資料 ⇒ 本次量測無效，不可當成欄位寬度的差異",
      })}`);
      process.exitCode = 1;
    }
    const wall = list.map((r) => r.endToEnd.wallMs).sort((a, b) => a - b);
    console.log(`COLAB-SUMMARY ${JSON.stringify({
      label, runs: list.length,
      wallMsMedian: wall[Math.floor(wall.length / 2)],
      wallMsMin: wall[0],
      wallMsMax: wall[wall.length - 1],
      rows: list[0].endToEnd.rows,
      payloadKB: Math.round(list[0].endToEnd.payloadChars / 1024),
      rootBuffers: list[0].rootBuffers,
      hot: list[0].hot,
    })}`);
  }
} finally {
  // 收尾清掉自建 fixture ✓（只用可辨識前綴 ✓，不動其他資料 ✓）。
  await drv.query("DELETE FROM listings WHERE source_key LIKE 'colab|%'").catch(() => {});
  await drv.close();
}
