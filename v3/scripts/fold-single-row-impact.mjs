// Owner 2026-10-16 裁示「同群只顯示 1 列＝代表列」的唯讀量測（V4／V5 的可重跑證據）。
//
// 兩個問題各自一條查詢：
//   V4「591 平台優先」層的行為中性：同一批 elig、兩份只差 591 層的 ORDER BY，
//      逐群比對 rn=1（代表列）的 post_id ⇒ rep_changed 必須是 0。
//   V5 補償條款的影響面：old_keep＝舊補償條款下會顯示的列（primary ∪ 主卡暫離而自己還在線的
//      affiliate）；new_keep＝修後會顯示的列（只有 primary）⇒ extra_rows_before 是舊行為多顯示的列數，
//      修後 new_groups_with_multiple 必須是 0（每群最多 1 列）。
//
// **只 SELECT**：連線後第一句就是 `SET default_transaction_read_only = on`，
// 就算被指向可寫庫也寫不進去（正式庫請另外加 `PGOPTIONS="-c default_transaction_read_only=on"`）。
// 目標庫仍需通過 `assertPgTargetAllowed`；要對不在白名單的庫（例如正式庫）執行，必須明示
// `ALLOW_PRODUCTION_PG_TARGET=1`（見 v3/src/domainToolGuards.js 的 `PG_TARGET_OVERRIDE_ENV`）。
// 用於正式庫時請一併加 `PGOPTIONS="-c default_transaction_read_only=on"`（雙重保險）。
// 用法（隔離庫）：`set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a; PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-single-row-impact.mjs`
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";

assertPgTargetAllowed("fold-single-row-impact", process.env.PG_URL || "");
const drv = await createPostgresDriver({ env: process.env });

// 只量有折疊分組鍵的列（與 foldRoleCte 的 cand 同一組條件）；FOLD_ROOTS_ONLY=0 可量全部。
const ROOT_FILTER = process.env.FOLD_ROOTS_ONLY === "0" ? "" : "WHERE fold_component_root IS NOT NULL";
// 排名輸入與 foldRoleCte 的 ranked 逐條對齊（spec §2 比較式表）。
const ORDER_KEYS = `(rent IS NULL) ASC, rent ASC,
    (CASE WHEN k = 1 THEN $1::bigint - rel ELSE abs END) DESC,
    last_seen_at DESC,
    {{EXTRA}}
    (COALESCE(NULLIF(source,''),'591')||':'||COALESCE(NULLIF(source_id,''),NULLIF(url,''),NULLIF(post_id,0)::text,'')||':'||COALESCE(post_id,0)::text) ASC,
    post_id ASC`;
const CTE = `cand AS (
  SELECT post_id, fold_component_root AS root, COALESCE(offline,0) AS offline, COALESCE(offline_confirmed,0) AS oconf,
         fold_rent_num AS rent, fold_refresh_kind AS k, fold_refresh_rel_ms AS rel, fold_refresh_abs_ms AS abs,
         last_seen_at, source, source_id, url
  FROM listings ${ROOT_FILTER}
), elig AS (SELECT * FROM cand WHERE oconf <> 1)`;
const ranked = (extra) => `SELECT *, row_number() OVER (PARTITION BY root ORDER BY ${ORDER_KEYS.replace("{{EXTRA}}", extra)}) AS rn FROM elig`;

const client = await drv.pool.connect();
try {
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '300s'");
  const now = Date.now();

  // ── V4：加 591 層前後的 rn=1 逐群比對 ──
  const v4 = await client.query(
    `WITH ${CTE}, before591 AS (${ranked("")}), after591 AS (${ranked("(COALESCE(NULLIF(source,''),'591') = '591') DESC,")})
     SELECT (SELECT count(*) FROM before591 WHERE rn = 1)::int AS groups_before,
            (SELECT count(*) FROM after591 WHERE rn = 1)::int AS groups_after,
            (SELECT count(*) FROM before591 b JOIN after591 a ON a.root = b.root AND a.rn = 1
              WHERE b.rn = 1 AND b.post_id <> a.post_id)::int AS rep_changed,
            (SELECT count(*) FROM before591 b JOIN after591 a ON a.root = b.root AND a.rn = 1
              WHERE b.rn = 1 AND b.source IS DISTINCT FROM a.source)::int AS rep_source_changed`,
    [now],
  );

  // ── V5：舊補償條款 vs 修後（每群一列）──
  const v5 = await client.query(
    `WITH ${CTE}, ranked AS (${ranked("")}),
     win AS (SELECT root, post_id AS pid, offline AS prim_off FROM ranked WHERE rn = 1),
     role AS (SELECT e.post_id, e.root, e.offline, (w.pid = e.post_id) AS is_primary, w.prim_off
              FROM elig e JOIN win w ON w.root = e.root),
     old_keep AS (SELECT * FROM role WHERE is_primary OR (prim_off = 1 AND offline <> 1)),
     new_keep AS (SELECT * FROM role WHERE is_primary)
     SELECT (SELECT count(*) FROM role)::int AS eligible_rows,
            (SELECT count(DISTINCT root) FROM role)::int AS groups,
            (SELECT count(*) FROM new_keep)::int AS new_rows_shown,
            (SELECT count(*) FROM old_keep)::int - (SELECT count(*) FROM new_keep)::int AS extra_rows_before,
            (SELECT count(DISTINCT root) FROM old_keep WHERE NOT is_primary)::int AS groups_with_extra_before,
            (SELECT coalesce(max(cnt),0) FROM (SELECT count(*) cnt FROM new_keep GROUP BY root) t)::int AS new_max_rows_per_group,
            (SELECT count(*) FROM (SELECT root FROM new_keep GROUP BY root HAVING count(*) > 1) t2)::int AS new_groups_with_multiple`,
    [now],
  );

  const out = { v4_zero_diff: v4.rows[0], v5_compensation: v5.rows[0] };
  const ok = Number(out.v4_zero_diff.rep_changed) === 0 && Number(out.v5_compensation.new_groups_with_multiple) === 0;
  console.log(JSON.stringify({ ...out, allOk: ok }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  client.release();
  await drv.pool.end();
}
