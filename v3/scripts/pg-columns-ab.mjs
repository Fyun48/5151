// SQL 級 A/B：**同一條 WHERE**、43 欄 vs 23 欄（量化候選欄位寬度的 buffer 成本）。
//
// 動機：逐節點歸因顯示 `Index Scan listings` 吃 33,541 buffers（≈268 MB、約每列 5 buffers ✗），
// 是實測最大的成本中心。本腳本只改 SELECT 清單、其餘（WHERE／params／schema）完全同一 ✓。
//
// ⚠️ 需要一個**有匯出** `buildListListingsClauses` / `buildListRequestContextFromPg` 的建置 ✓。
// 實測：容器內的部署版 `/app/src/db.js` **沒有這兩個匯出** ✗（grep = 0 ✓）⇒ 部署映像比本分支舊 ✗
// ⇒ 先在容器跑會得到 `SyntaxError: does not provide an export named 'buildListListingsClauses'` ✗。
// ⇒ 因此本腳本的正式用途是：**本分支被部署（或 CI 的真 PG 服務）之後**，量測 43 vs 23 的 buffer 差異 ✓；
//    在此之前，縮欄位的權威驗證是 CI 的 live PG 整合測試 ✓（它跑的是本分支程式碼 ✓）。
//
// 刻意在腳本裡**字面寫死** 23／43 欄 ✓：避免依賴任何一版的 `LIST_CANDIDATE_COLUMNS` ✓，
// 讓兩側唯一差異就是欄位清單本身 ✓。
//
// 用法（容器內）：REMOTE_DIR=/app/tmpkk bash v3/scripts/run-in-container.sh v3/scripts/pg-columns-ab.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { buildListRequestContextFromPg, buildListListingsClauses } from "../src/db.js";

const COLS_43 = `post_id, source, source_id, source_key, url, price, price_num,
  extra_fee, extra_fees, extra_fee_text, price_contain_text,
  title, address, address_norm, area_name, layout, floor_name, kind_name, tags,
  role_name, contact_name, contact_role, contact_uid, agency,
  lat, lng, geo_source, location_class, match_post_id, match_level,
  match_verdict, match_rejected, offline, offline_confirmed, hidden, hidden_at,
  last_event, first_seen_at, last_seen_at, refresh_time, listed_by_user_id, self_status`;

// 實測的窄版（非 fit_desc 模式所需 23 欄 ✓；`match_level` 為 suspected 唯一額外讀取 ✓）
const COLS_23 = `post_id, source, price, price_num,
  title, address, area_name, floor_name, kind_name, tags,
  lat, lng, geo_source, location_class, match_post_id, match_level,
  match_verdict, offline, offline_confirmed, hidden, hidden_at,
  refresh_time, contact_uid`;

function summarize(root) {
  const list = [];
  const walk = (node, depth = 0) => {
    const hit = Number(node["Shared Hit Blocks"]) || 0;
    const read = Number(node["Shared Read Blocks"]) || 0;
    list.push({
      node: node["Node Type"],
      relation: node["Relation Name"] || null,
      depth,
      rows: node["Actual Rows"],
      loops: node["Actual Loops"],
      buffers: hit + read,
    });
    for (const child of node["Plans"] || []) walk(child, depth + 1);
  };
  walk(root);
  const total = list.reduce((sum, n) => sum + n.buffers, 0);
  return { total, top: list.sort((a, b) => b.buffers - a.buffers).slice(0, 3) };
}

const drv = await createPostgresDriver({ env: process.env });
try {
  const exec = async (sql, params) => (await drv.query(sql, params)).rows;
  const context = await buildListRequestContextFromPg(exec);
  const built = buildListListingsClauses({
    filter: "all", districts: ["西屯區"], settings: {}, uid: 0, voteUid: 0, context,
  });
  console.log(`COLAB-WHERE ${JSON.stringify({ where: String(built.where).slice(0, 160), params: built.params.length })}`);
  for (const [label, cols] of [["43cols", COLS_43], ["23cols", COLS_23]]) {
    const sql = `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) SELECT ${cols} FROM listings ${built.where}`;
    const json = await drv.query(sql, built.params);
    const top = json.rows[0]["QUERY PLAN"][0];
    const root = top.Plan || top;
    const { total, top: hot } = summarize(root);
    console.log(`COLAB ${JSON.stringify({
      label, execMs: top["Execution Time"], totalBuffers: total, hot,
    })}`);
  }
} finally {
  await drv.close();
}
