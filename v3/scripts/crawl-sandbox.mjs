#!/usr/bin/env node
// 抓取沙盒（2026-09-30，第九十四批；Owner 指定「另做一個測試容器盡情測試」）。
//
// 為什麼需要這一支：第九十一～九十三批都是**部署後拿正式站當白老鼠**才發現問題——
// 「一輪 25～40 分鐘跑不完」、「連續失敗政策沒生效」、「一個 403 吃掉整批」。
// 這些全部都可以在沙盒裡先跑出來，只要有一個入口能用**真程式、真來源、隔離庫**跑完整輪次。
//
// 這一支就是那個入口，常駐容器（`docker-compose.crawl-sandbox.yml`）每 N 分鐘跑一輪：
//   reserveCoveringPlan（真實條件） → runWatch（真實抓取、真的落地） → 寫入隔離庫 → 輸出報告
//
// 安全設計（fail-closed，三個都要成立才跑）：
//   1. `DB_DRIVER=postgres`：沙盒**不得**退回節點本機 SQLite（那會測到別的東西）。
//   2. `PG_URL` 的資料庫名必須在 `assertPgTargetAllowed()` 的允許清單內
//      （沙盒庫 `crawl_sandbox`，與 live 測試用的 `repro` 分開）。
//   3. 不設任何寄信／推播的環境變數：沙盒只抓資料，不對外發通知。
//
// 用法：
//   node v3/scripts/crawl-sandbox.mjs                 # 常駐，每 CRAWL_SANDBOX_INTERVAL_MINUTES（預設 30）分鐘一輪
//   node v3/scripts/crawl-sandbox.mjs --once          # 只跑一輪（開 PR 前的驗收用）
//   node v3/scripts/crawl-sandbox.mjs --rounds 3      # 跑三輪後結束（驗證「連續失敗 N 輪」這種時間相關政策）
//   node v3/scripts/crawl-sandbox.mjs --once --json   # 只印 JSON 報告（給程式解析）
import { mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { resolveDbDriver } from "../src/dbDriver.js";
import { sharedPgDriver } from "../src/pgSharedDriver.js";
import { withPgCrawlOwner } from "../src/crawlOwnership.js";
import { withBudget, TICK_BUDGET_MS } from "../src/crawlWatchdog.js";
import { reserveCoveringPlan } from "../src/crawlScheduleAsync.js";
import { runWatch } from "../src/watcher.js";

const SCHEDULE_KEY = "crawlScheduleV1";

/** 命令列參數（純函式，可測）。 */
export function parseSandboxArgs(argv = []) {
  const once = argv.includes("--once");
  const json = argv.includes("--json");
  const index = argv.indexOf("--rounds");
  const rounds = once ? 1 : index >= 0 ? Math.max(1, Math.trunc(Number(argv[index + 1]) || 1)) : 0;
  return { once, json, rounds };
}

/** 沙盒的執行環境檢查（fail-closed）：回傳 `{ ok, driver, database, reason }`。 */
export function checkSandboxTarget(env = process.env) {
  const driver = resolveDbDriver(env);
  if (driver !== "postgres") {
    return { ok: false, driver, database: "", reason: "沙盒必須用 DB_DRIVER=postgres（不得退回節點本機 SQLite）" };
  }
  const url = String(env.PG_URL || env.DATABASE_URL || "").trim();
  try {
    const database = assertPgTargetAllowed("crawl-sandbox", url, { env });
    return { ok: true, driver, database, reason: "" };
  } catch (error) {
    return { ok: false, driver, database: "", reason: error?.message || String(error) };
  }
}

/**
 * 一輪的報告（純函式，可測）。刻意只留「能判斷來源健康與政策有沒有生效」的欄位：
 * 每來源覆蓋數／連續失敗／是否已放行、輪次耗時與是否被預算放棄、完成紀錄有沒有前進。
 */
export function buildRoundReport({ round = 1, startedAt, finishedAt, result = {}, schedule = {}, covers = [], budgetMs = TICK_BUDGET_MS } = {}) {
  const started = Number(startedAt) || 0;
  const finished = Number(finishedAt) || 0;
  const state = schedule && typeof schedule === "object" ? schedule : {};
  const rows = Array.isArray(covers) ? covers : [];
  const maxRunAt = rows.reduce((max, row) => {
    const at = String(row?.last_run_at || "");
    return at > max ? at : max;
  }, "");
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const durationMs = Math.max(0, finished - started);
  return {
    round,
    started_at: new Date(started || Date.now()).toISOString(),
    finished_at: new Date(finished || Date.now()).toISOString(),
    duration_ms: durationMs,
    // 「被 withBudget 放棄」是正式站最常見的失敗型態，一定要單獨看得出來。
    timed_out: durationMs >= budgetMs || /沒結束，已自動放棄/.test(String(result.error || "")),
    budget_ms: budgetMs,
    skipped: String(result.skipped || ""),
    error: String(result.error || ""),
    fetched: Number(result.fetched) || 0,
    jobs: Array.isArray(result.covers) ? result.covers.length : 0,
    warnings: (Array.isArray(result.warnings) ? result.warnings : []).map(String),
    errors_sample: errors.slice(0, 5).map(String),
    errors_total: errors.length,
    sources: (Array.isArray(result.sources) ? result.sources : []).map((row) => ({
      source: String(row?.source || ""),
      covered: Math.trunc(Number(row?.covered) || 0),
      total: Math.trunc(Number(row?.total) || 0),
      fails: Math.trunc(Number(row?.fails) || 0),
      tolerated: row?.tolerated === true,
      last_error: String(row?.lastError || ""),
    })),
    completed: Object.keys(state.completed || {}).length,
    last_covering_at: String(state.lastCoveringAt || ""),
    covers_rows: rows.length,
    covers_max_last_run_at: maxRunAt,
  };
}

/** 人類看得懂的一行摘要（容器日誌用）。 */
export function formatRoundReport(report) {
  const sources = (report.sources || [])
    .map((row) => `${row.source} ${row.covered}/${row.total}${row.tolerated ? "(已放行)" : ""}${row.fails ? ` fails=${row.fails}` : ""}`)
    .join("、");
  return [
    `[沙盒] 第 ${report.round} 輪 ${report.timed_out ? "逾時" : report.skipped || "完成"}`,
    `${Math.round(report.duration_ms / 1000)}s`,
    `落地 ${report.fetched} 筆`,
    `覆蓋紀錄 ${report.covers_rows} 列（最新 ${report.covers_max_last_run_at || "-"}）`,
    `completed=${report.completed}`,
    sources ? `來源：${sources}` : "",
    report.error ? `錯誤：${report.error}` : "",
  ].filter(Boolean).join("｜");
}

async function readScheduleState(driver) {
  const res = await driver.query("SELECT key, value FROM settings WHERE key = $1", [SCHEDULE_KEY]);
  try {
    return JSON.parse(res.rows[0]?.value || "{}") || {};
  } catch {
    return {};
  }
}

async function readCovers(driver) {
  const res = await driver.query("SELECT region_id, section_ids, price_min, price_max, last_run_at FROM crawl_covers ORDER BY id");
  return res.rows || [];
}

function nowIso() {
  return new Date().toISOString();
}

/** 跑一輪：與正式站同一條路徑（同樣的預算、同樣的 PG 擁有者鎖），只差在資料庫是沙盒。 */
export async function runSandboxRound({ round = 1, env = process.env } = {}) {
  const driver = await sharedPgDriver();
  const startedAt = Date.now();
  let result = {};
  try {
    result = await withBudget(async (signal) => withPgCrawlOwner(driver, async () => {
      const plan = await reserveCoveringPlan({ now: Date.now(), includeSystem: true });
      if (!plan.jobs.length) {
        return { skipped: "idle", fetched: 0, errors: [], searches: [], events: [], covers: [], sources: [] };
      }
      return runWatch({
        skipHeavyGeo: true,
        jobs: plan.jobs,
        memberRequirements: plan.memberRequirements,
        includeSystem: plan.includeSystem,
      });
    }, { signal }), TICK_BUDGET_MS, "沙盒這一輪", {});
  } catch (error) {
    // 沙盒的價值之一就是把「被放棄的輪次」變成可讀的紀錄，所以不在這裡往上丟。
    result = { error: error?.message || String(error), errors: [], fetched: 0, covers: [], sources: [] };
  }
  const finishedAt = Date.now();
  const [schedule, covers] = await Promise.all([readScheduleState(driver), readCovers(driver)]);
  return buildRoundReport({ round, startedAt, finishedAt, result, schedule, covers });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseSandboxArgs(argv);
  const check = checkSandboxTarget(env);
  if (!check.ok) {
    console.error(`[沙盒] 拒絕啟動：${check.reason}`);
    process.exitCode = 2;
    return { started: false, reason: check.reason };
  }
  const intervalMinutes = Math.max(1, Number(env.CRAWL_SANDBOX_INTERVAL_MINUTES) || 30);
  const reportFile = String(env.CRAWL_SANDBOX_REPORT || "/data/crawl-sandbox.jsonl");
  try { mkdirSync(path.dirname(reportFile), { recursive: true }); } catch { /* 目錄已存在或不可寫，下面會再試 */ }
  console.log(`[沙盒] 啟動：資料庫=${check.database}、每 ${intervalMinutes} 分鐘一輪、報告=${reportFile}`);

  let round = 0;
  for (;;) {
    round += 1;
    const report = await runSandboxRound({ round, env });
    if (args.json) console.log(JSON.stringify(report));
    else console.log(formatRoundReport(report));
    try { appendFileSync(reportFile, `${JSON.stringify(report)}\n`); } catch (error) {
      console.warn(`[沙盒] 報告寫入失敗：${error?.message || error}`);
    }
    if (args.rounds && round >= args.rounds) return { started: true, rounds: round, report };
    await new Promise((resolve) => setTimeout(resolve, intervalMinutes * 60 * 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("[沙盒] 非預期失敗：", error);
    process.exitCode = 1;
  });
}

export { nowIso };
