// `listings.fold_component_root` **全量 drift 檢查**（Owner 2026-10-12 R2／R5）：
// 在凍結（或部署當下）的資料上把連通分量**整表重算一遍**，與固化欄逐列比對，
// 輸出 mismatch 筆數與 post_id。目標 0。
//
// 為什麼不是抽樣：升級層明言「抽樣不能保證零漏」。`fold-freshness-check.mjs` 是 fold_* 的抽樣
// 過時檢查；`projection-freshness-check.mjs` 的 foldRoot 也是抽樣。本腳本是**全量**那一條，
// 依 runbook §1 的部署順序：007 DDL → 全表回填 → **本腳本全量零差** → 才部署程式 → Owner 開閘。
//
// 語意：輸入與 `fold-root-backfill.mjs` **逐字相同**（同一支 componentRootMap、同一組邊、
// 同一個 isNotDisplayReady、splits＝空集合），所以「零差」＝固化欄就是回填端此刻會算出的值。
// NULL 是**合法值**（單節點分量／被三道閘否決的邊），因此比對的是「欄值 vs 重算值」而不是
// 「有邊就必須非 NULL」。
//
// 唯讀（只 SELECT）。`--stamp` 會在全量零差時把結果寫進 `settings.foldRootDriftStamp`
// ——那是**開閘前檢**（`foldSqlGateReady`）要求的依賴戳記，屬部署步驟，由 Owner 執行。
//
// 用法：
//   PG_URL=$PG_SNAPSHOT_REPRO2_URL node v3/scripts/fold-root-drift-check.mjs            # 唯讀
//   PG_URL=$PG_URL node v3/scripts/fold-root-drift-check.mjs --stamp                    # 部署步驟
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { componentRootMap, enabledSourcesFromPg, FOLD_DRIFT_STAMP_KEY, resetFoldSqlGate } from "../src/foldComponentRoot.js";

assertPgTargetAllowed("fold-root-drift-check", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const stamp = process.argv.includes("--stamp");
const drv = await createPostgresDriver({ env: process.env });

// 欄位存在與否（缺欄 ⇒ 直接 fail-closed，不做任何重算）
const hasColumn = (await drv.pool.query(
  "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'listings' AND column_name = 'fold_component_root' LIMIT 1",
)).rows.length > 0;
if (!hasColumn) {
  console.log(JSON.stringify({ script: "fold-root-drift-check", ok: false, reason: "fold_component_root_missing" }));
  await drv.pool.end();
  process.exit(1);
}

// 與 fold-root-backfill.mjs 第 2 步完全相同的輸入
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

const isNotDisplayReady = (row) => {
  const source = String(row?.source || "591") || "591";
  if (!enabled.has(source)) return true;
  if (source !== "houseprice") return false;
  return Number(row?.prep_display_ready) === 1 ? false : true;
};
const recomputed = componentRootMap({
  rows,
  groupIdOf: (pid) => gidOf.get(Number(pid)) || "",
  splits: new Set(),
  isNotDisplayReady,
});

const mismatches = [];
let nonNull = 0;
let components = 0;
for (const row of rows) {
  const pid = Number(row.post_id);
  const stored = row.fold_component_root == null ? null : Number(row.fold_component_root);
  const fresh = recomputed.get(pid) == null ? null : Number(recomputed.get(pid));
  if (stored != null) nonNull += 1;
  if (fresh != null && fresh === pid) components += 1;
  if (stored !== fresh) mismatches.push({ post_id: pid, stored, fresh });
}

const at = new Date().toISOString();
const summary = {
  script: "fold-root-drift-check",
  at,
  listings: rows.length,
  groupMembers: groupRows.length,
  enabledSources: [...enabled].sort(),
  nonNullStored: nonNull,
  components,
  mismatch: mismatches.length,
  mismatchIds: mismatches.slice(0, 50).map((m) => m.post_id),
  ok: mismatches.length === 0,
  stamped: false,
};
if (stamp) {
  if (mismatches.length === 0) {
    await drv.pool.query(
      toPostgresSql("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"),
      [FOLD_DRIFT_STAMP_KEY, JSON.stringify({ at, rows: rows.length, components, mismatches: 0 })],
    );
    resetFoldSqlGate();
    summary.stamped = true;
  } else {
    summary.stamped = false;
    summary.stampSkippedBecause = "mismatch_nonzero";
  }
}
console.log(JSON.stringify(summary));
await drv.pool.end();
process.exit(mismatches.length === 0 ? 0 : 1);
