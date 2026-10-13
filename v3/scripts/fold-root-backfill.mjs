// `listings.fold_component_root` 全表回填（冪等、分批寫、可中斷續跑）。
//
// Owner 2026-10-12 裁示（准 (B)）：連通分量固化成一欄，SQL 端不再算分量。此腳本是**唯一**
// 的回填路徑，用的是與讀取端同一份 union-find（v3/src/foldComponentRoot.js）。
//
// 寫入權限紅線：assertPgTargetAllowed 白名單（repro／crawl_sandbox）。正式庫由 Owner 在
// 發版時執行（見 PR 描述的「部署後需執行的一次性指令清單」）。
//
// 用法（批次大小預設 2000；budgetMs＝超過就停，下次續跑）：
//   PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-root-backfill.mjs [batchSize] [budgetMs]
//
// 為什麼「可續跑」不是靠水位而是靠重算：root 只取決於邊集合（與列順序、時間無關），
// 每次執行都重算全表再只寫「與現值不同」的列 ⇒ 中斷後直接重跑即可，不會寫錯、不會漏。
// 分批只作用在 UPDATE 的交易粒度（每批一個交易，失敗整批回滾），批次大小寫在這裡：
const DEFAULT_BATCH = 2000;
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { componentRootMap, enabledSourcesFromPg, bumpFoldRootWriteGen } from "../src/foldComponentRoot.js";

assertPgTargetAllowed("fold-root-backfill", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });

const drv = await createPostgresDriver({ env: process.env });
const batchSize = Math.max(1, Math.min(Number(process.argv[2]) || DEFAULT_BATCH, 20000));
const budgetMs = Number(process.argv[3]) || 0;
const startedAt = Date.now();

// 1) 冪等 DDL（與 v3/migrations/007_listings_fold_component_root.sql 相同；ALTER 是 metadata-only）
const DDL = [
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_component_root bigint",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_fold_component_root ON listings (fold_component_root) WHERE fold_component_root IS NOT NULL",
];
for (const sql of DDL) await drv.pool.query(sql);
console.log("DDL ensured:", DDL.length, "statements");

// 2) 關係輸入（分量成員只看這三樣：match 邊、群組、未就緒判定）
const rows = (await drv.pool.query(
  `SELECT l.post_id, l.source, l.match_post_id, l.match_verdict, l.offline_confirmed,
          l.fold_component_root, COALESCE(p.display_ready, 0) AS prep_display_ready
     FROM listings l LEFT JOIN listing_prep p ON p.post_id = l.post_id
    ORDER BY l.post_id`,
)).rows;
const groupRows = (await drv.pool.query(
  "SELECT post_id, group_id FROM listing_group_members ORDER BY post_id, group_id",
)).rows;
const gidOf = new Map();
for (const row of groupRows) gidOf.set(Number(row.post_id), String(row.group_id || ""));
const enabled = await enabledSourcesFromPg((sql, params = []) => drv.pool.query(toPostgresSql(sql), params).then((r) => r.rows));
console.log(`listings=${rows.length} group_members=${groupRows.length} enabledSources=${[...enabled].sort().join(",")} batchSize=${batchSize}`);

// 3) 同一份 union-find（讀取端／刷新端／回填端共用）
const isNotDisplayReady = (row) => {
  const source = String(row?.source || "591") || "591";
  if (!enabled.has(source)) return true;
  if (source !== "houseprice") return false;
  return Number(row?.prep_display_ready) === 1 ? false : true;
};
const roots = componentRootMap({
  rows,
  groupIdOf: (pid) => gidOf.get(Number(pid)) || "",
  splits: new Set(), // uid=0：個人範圍的 split 不固化（spec §6.5）
  isNotDisplayReady,
});

// 4) 只寫有差的列
const writes = [];
let components = 0;
let members = 0;
for (const row of rows) {
  const pid = Number(row.post_id);
  const before = row.fold_component_root == null ? null : Number(row.fold_component_root);
  const after = roots.get(pid) == null ? null : Number(roots.get(pid));
  if (before !== after) writes.push([after, pid]);
}
for (const [pid, root] of roots) { if (root != null) { members += 1; if (Number(root) === pid) components += 1; } }
console.log(`components=${components} members_materialized=${members} differ=${writes.length}`);

// 5) 分批 UPDATE（每批一個交易）
let written = 0;
const client = await drv.pool.connect();
try {
  for (let i = 0; i < writes.length; i += batchSize) {
    if (budgetMs && Date.now() - startedAt > budgetMs) {
      console.log(`budget ${budgetMs}ms reached after ${written} rows; rerun to continue (idempotent)`);
      break;
    }
    const batch = writes.slice(i, i + batchSize);
    await client.query("BEGIN");
    try {
      for (const [root, pid] of batch) {
        // 只寫 NULL 或非 NULL 的 root 值；WHERE 比對現值 ⇒ 併發寫入不會被覆蓋成過期值的情況最小化。
        await client.query(toPostgresSql("UPDATE listings SET fold_component_root = ? WHERE post_id = ? AND fold_component_root IS DISTINCT FROM ?"), [root, pid, root]);
      }
      // 寫入世代鍵（升級層 2026-10-13 開閘硬條件）：與本批的 UPDATE **同一個交易** +1，
      // 回填改到任何一列都會讓既有的零差戳記失效（回填後照 runbook §1 重跑 `--stamp` 才會再放行）。
      // 沒寫任何列的一批不 bump：資料沒動 ⇒ 戳記仍然是真的。
      if (batch.length) {
        await bumpFoldRootWriteGen((sql, params = []) => client.query(toPostgresSql(sql), params).then((r) => r.rows));
      }
      await client.query("COMMIT");
      written += batch.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    if (writes.length > batchSize) console.log(`  batch ${Math.min(i + batchSize, writes.length)}/${writes.length} written=${written}`);
  }
} finally {
  client.release();
}
const ms = Date.now() - startedAt;
console.log(JSON.stringify({ total: rows.length, batches: Math.ceil(writes.length / batchSize) || 0, written, unchanged: rows.length - writes.length, ms, perRowMs: Number((ms / Math.max(1, rows.length)).toFixed(4)) }));
await drv.pool.end();
