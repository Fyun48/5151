// Driver-aware listing enrich reads/admin stats（2.3b 第一段）。
//
// sqlite   - 原 listingEnrichQueue.js 函式（行為不變）。
// postgres - repository/listingEnrich.js 的同一份語句文字。
// 查詢結果的組裝（summarizeEnrichMetrics 的統計）**逐字沿用** listingEnrichQueue.js 的 stageSummary()。
import {
  getListingPrep as getListingPrepSync,
  listingPrepAdminStats as listingPrepAdminStatsSync,
  stageSummary,
  summarizeEnrichMetrics as summarizeEnrichMetricsSync,
} from "./listingEnrichQueue.js";
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import * as repo from "./repository/listingEnrich.js";

async function withFallback(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    if (options.exec) return await runPostgres(options.exec);
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    const exec = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
    return await runPostgres(exec);
  } catch (error) {
    if (options.strict) throw error;
    return runSqlite();
  }
}

// listingEnrichQueue.js getListingPrep()
export function getListingPrepAsync(conn, postId, options = {}) {
  const opts = { ...options, sqliteHandle: conn };
  return withFallback(opts, (exec) => repo.readPrepRow(exec, postId), () => getListingPrepSync(conn, postId));
}

// listingEnrichQueue.js summarizeEnrichMetrics()：查詢走 driver，統計用同一支 stageSummary。
export function summarizeEnrichMetricsAsync(conn, options = {}) {
  const opts = { ...options, sqliteHandle: conn };
  const stages = ["queued_ms", "start_ms", "fetch_ms", "parse_ms", "locate_ms", "route_ms", "ready_ms", "first_ready_ms", "attempt_wait_ms"];
  const shape = (rows) => {
    const out = { samples: rows.length, stages: {}, byOutcome: {} };
    for (const key of stages) out.stages[key] = stageSummary(rows, key);
    for (const outcome of ["succeeded", "failed", "waiting"]) {
      const subset = rows.filter((row) => String(row.outcome || "") === outcome);
      out.byOutcome[outcome] = { samples: subset.length, stages: {} };
      for (const key of stages) out.byOutcome[outcome].stages[key] = stageSummary(subset, key);
    }
    return out;
  };
  return withFallback(opts, async (exec) => shape(await repo.readMetricsRows(exec)), () => summarizeEnrichMetricsSync(conn));
}

// listingEnrichQueue.js listingPrepAdminStats()
export function listingPrepAdminStatsAsync(conn, options = {}) {
  const opts = { ...options, sqliteHandle: conn };
  return withFallback(
    opts,
    async (exec) => {
      const one = async (q) => ((await exec(q.sql, q.params)) || [])[0] || {};
      const pending = await one(repo.prepPendingCountQuery());
      const ready = await one(repo.prepReadyCountQuery());
      const jobs = await one(repo.enrichJobsSummaryQuery());
      const rawErrors = ((await exec(repo.enrichErrorBreakdownQuery().sql, repo.enrichErrorBreakdownQuery().params)) || []);
      const errors = rawErrors.map((row) => ({ reason: row.reason, n: Number(row.n) || 0 }));
      const metrics = await summarizeEnrichMetricsAsync(conn, { ...opts, exec });
      return {
        pendingPrep: Number(pending.n) || 0,
        readyPrep: Number(ready.n) || 0,
        waitingJobs: Number(jobs.waiting) || 0,
        runningJobs: Number(jobs.running) || 0,
        oldestWaitAt: jobs.oldest || "",
        lastSuccessAt: jobs.last_success || "",
        errors,
        metrics,
      };
    },
    () => listingPrepAdminStatsSync(conn),
  );
}

export function listingEnrichAsyncContext() {
  return repo;
}

