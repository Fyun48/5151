// 開閘前檢的「一次性人工作業」腳本（runbook `docs/runbooks/5151_same_house_fold_deploy.md` §1.1
// 的第 1／3／4／5 條）——把「僅有 stamp 不足」補成可驗的形狀。
//
// 逐項驗（全部唯讀 SELECT）：
//   1. 欄位存在：`pg_attribute` ＋ `to_regclass('listings')`（跟著 search_path；**不用
//      information_schema**，那是跨 schema 的會誤判，L-0869）。
//   2. `settings.foldRootDriftStamp` 存在且 `mismatches === 0`。
//   3. 戳記綁的資料版本＝當前資料重算：`rows`／`maxPostId`／`rootsMd5` **三者逐項相同**
//      （rootsMd5 是全表聚合，只在這支離線腳本比對，不進每請求路徑）。
//   4. 用「真 PG exec」呼叫 `foldSqlGateReady()`（＝線上那一條判定）並要求 `ok:true`。
//
// 用法：PG_URL=$PG_SNAPSHOT_REPRO2_URL node v3/scripts/fold-gate-stamp-verify.mjs
// 退出碼：全數通過 0；任一項不通過 1（fail-closed，拿不到「期望」值就不開閘）。
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { foldSqlGateReady, resetFoldSqlGate, FOLD_DRIFT_STAMP_KEY } from "../src/foldComponentRoot.js";

assertPgTargetAllowed("fold-gate-stamp-verify", process.env.PG_URL || "", { allow: ["repro", "repro2", "tracker_test", "crawl_sandbox"] });
const drv = await createPostgresDriver({ env: process.env });
const exec = (sql, params = []) => drv.pool.query(toPostgresSql(sql), params).then((r) => r.rows);

const columnPresent = (await exec(
  "SELECT 1 AS ok FROM pg_attribute WHERE attrelid = to_regclass('listings') AND attname = 'fold_component_root' AND attnum > 0 AND NOT attisdropped LIMIT 1",
)).length > 0;

const stampRows = await exec("SELECT value FROM settings WHERE key = ?", [FOLD_DRIFT_STAMP_KEY]);
let stamp = null;
try { const raw = stampRows?.[0]?.value; stamp = raw == null ? null : (typeof raw === "string" ? JSON.parse(raw) : raw); } catch { stamp = null; }

const live = (await exec(
  "SELECT count(*) AS n, max(post_id) AS max_post_id, "
  + "md5(string_agg(post_id::text || '|' || COALESCE(fold_component_root::text, '-'), '' ORDER BY post_id)) AS roots_md5 "
  + "FROM listings",
))[0] || {};
const liveVersion = { rows: Number(live.n), maxPostId: Number(live.max_post_id), rootsMd5: live.roots_md5 == null ? null : String(live.roots_md5) };
const stamped = stamp?.dataVersion || null;
const dataVersionMatch = Boolean(stamped)
  && Number(stamped.rows) === liveVersion.rows
  && Number(stamped.maxPostId) === liveVersion.maxPostId
  && String(stamped.rootsMd5 || "") === String(liveVersion.rootsMd5 || "");

resetFoldSqlGate();
const gate = await foldSqlGateReady(exec);
resetFoldSqlGate();

const checks = {
  column_present: columnPresent,
  stamp_present: Boolean(stamp),
  stamp_mismatches_zero: Number(stamp?.mismatches) === 0,
  dataVersion_match: dataVersionMatch,
  gate_ok: gate.ok === true,
};
const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  script: "fold-gate-stamp-verify",
  at: new Date().toISOString(),
  checks,
  stamp: stamp ? { at: stamp.at || null, rows: stamp.rows ?? null, components: stamp.components ?? null, mismatches: stamp.mismatches } : null,
  stampedVersion: stamped,
  liveVersion,
  gate,
  ok,
}));
await drv.pool.end();
process.exit(ok ? 0 : 1);
