// 補通勤路線／補座標迴圈的「單一請求牆鐘預算」。
//
// 為什麼要有這支（2026-10-17）：
//   `queueGeoBackfill()` 的兩個迴圈（補路線、補定位）原本都是 `for (round < 80)`：
//   每輪最多 20 筆、失敗時再加睡 1.5 秒 ⇒ 單次背景 job 最壞 80 輪 × 1.5 秒 = 120 秒，
//   路線計算最多 1600 筆，而且**完全沒有時間上限**。外部路線 API 一慢，job 就掛在那裡，
//   promise／middle rows／route_jobs 狀態沿著輪次一直累積：
//     * 2026-10-16T03:31Z 正式站 `Connection terminated unexpectedly` 後重啟；
//     * 2026-10-17 開發站 `FATAL ERROR: Reached heap limit … JavaScript heap out of memory`
//       （heap ~2042MB，日誌同時有 `route-backfill-failed … consecutive=10`）。
//   觸發條件是「使用者存了上班地址＋通勤距離 > 0」——之後每次排到補路線 job 都會跑這條路。
//
// 這一支只做「迴圈的煞車」，不改 backfillListingRoutes／backfillListingCoords 的語意：
//   * 到預算就**收手**，already-written 的 route_cache 不會回滾；
//   * 連續失敗達 N 次就停止重試（不再 80 輪 × 1.5 秒）；
//   * 兩種收手都留一行可 grep 的結構化日誌，讓「這次沒補完」看得見。
//
// 預算值（為什麼是 8 秒、為什麼要 clamp）：
//   * 8 秒 ≈ 3～4 個「20 筆路線」的輪次（實測單輪 1～3 秒），足以推進進度，
//     又遠低於 HAProxy 的 `timeout server 30s`（deploy/shadow-ha/haproxy/haproxy.cfg）
//     與使用者願意等一個列表請求的時間；
//   * 沒補完的物件**不會消失**：`needingRouteAsync()` 有輪轉游標，下一輪（背景 job 重啟、
//     watcher 輪次、設定變更）會再排；route_cache 已寫入的列下一輪直接跳過；
//   * 下限 1 秒：短於一次外部路線請求，設得更小只會讓每個 job 都立刻收手、永遠補不完；
//   * 上限 30 秒：等於 HAProxy 的 server timeout，預算設到那裡就等於沒有煞車，
//     因此允許用環境變數調大，但一律夾在 30 秒內。

export const DEFAULT_BUDGET_MS = 8_000;
export const MIN_BUDGET_MS = 1_000;
export const MAX_BUDGET_MS = 30_000;
export const DEFAULT_MAX_ROUNDS = 80;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_RETRY_SLEEP_MS = 1_500;

/** 環境變數覆寫（毫秒）；解析失敗或非正數回預設，並夾在 [MIN, MAX]。 */
export function resolveBackfillBudgetMs(env = process.env) {
  const raw = Number(env?.ROUTE_BACKFILL_BUDGET_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BUDGET_MS;
  return Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, Math.round(raw)));
}

/**
 * 建立「同一個背景 job／同一個請求」共用的截止時間。
 * `now` 可注入（測試用假時鐘）；正式路徑用 `Date.now`。
 */
export function createBackfillDeadline({ budgetMs = DEFAULT_BUDGET_MS, now = () => Date.now() } = {}) {
  const ms = Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, Number(budgetMs) || DEFAULT_BUDGET_MS));
  const startedAt = now();
  const elapsedMs = () => Math.max(0, now() - startedAt);
  return {
    budgetMs: ms,
    startedAt,
    elapsedMs,
    remainingMs: () => Math.max(0, ms - elapsedMs()),
    expired: () => elapsedMs() >= ms,
  };
}

function defaultLog(line) {
  console.warn(line);
}

/**
 * 跑一個「最多 N 輪、每輪一件 async 工作」的迴圈，加上牆鐘預算與連續失敗上限。
 *
 * 回傳的統計只給日誌／測試用，**不改變**呼叫端原本回傳或廣播的物件形狀。
 *
 * @param {() => Promise<any>} runRound 一輪的工作（回傳值原樣交給 shouldStop／lastResult）
 * @param {object} options
 *  - deadline: createBackfillDeadline() 的結果；未給則不設時間上限（僅測試會這樣用）
 *  - maxRounds / maxConsecutiveFailures / retrySleepMs：輪數與失敗上限（預設沿用原本的 80／3／1500ms）
 *  - label / stage：日誌前綴（固定 `route-backfill`）與階段（routes／coords），方便 grep
 *  - shouldStop(result, stats)：回傳 true 代表「這一輪已經補完／沒事做」，正常收手
 *  - onResult(result, round)：每輪成功後的副作用（廣播、更新 emptyRouteRounds 等）
 *  - log / sleep / now：注入用（測試替換掉真的 console 與 setTimeout）
 */
export async function runBackfillRounds(runRound, {
  deadline = null,
  maxRounds = DEFAULT_MAX_ROUNDS,
  maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
  retrySleepMs = DEFAULT_RETRY_SLEEP_MS,
  label = "route-backfill",
  stage = "routes",
  shouldStop = null,
  onResult = null,
  log = defaultLog,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const stats = {
    rounds: 0,
    failures: 0,
    consecutiveFailures: 0,
    attempted: 0,
    located: 0,
    lastAttempted: 0,
    stoppedBy: "max_rounds",
    budgetMs: deadline?.budgetMs ?? null,
    elapsedMs: 0,
    lastResult: null,
  };
  for (let round = 0; round < Math.max(1, Number(maxRounds) || DEFAULT_MAX_ROUNDS); round += 1) {
    if (deadline?.expired()) {
      stats.stoppedBy = "budget";
      break;
    }
    stats.rounds += 1;
    try {
      const result = await runRound(round);
      stats.lastResult = result ?? null;
      stats.lastAttempted = Number(result?.attempted) || 0;
      stats.attempted += stats.lastAttempted;
      stats.located += Number(result?.located) || 0;
      // 只要有一輪成功就重設連續失敗（與原本 `if (routeBackfillConsecutive) …=0` 相同）。
      stats.consecutiveFailures = 0;
      if (onResult) await onResult(result, round, stats);
      if (shouldStop && shouldStop(result, stats)) {
        stats.stoppedBy = "idle";
        break;
      }
    } catch (error) {
      stats.failures += 1;
      stats.consecutiveFailures += 1;
      // 固定前綴可 grep；保留 name／code，讓下一輪排查不用再猜。
      log(
        `${label}-failed stage=${stage} round=${round} consecutive=${stats.consecutiveFailures}`
        + ` name=${error?.name || "Error"} code=${error?.code ?? ""} ${error?.message || error}`,
      );
      if (stats.consecutiveFailures >= Math.max(1, Number(maxConsecutiveFailures) || DEFAULT_MAX_CONSECUTIVE_FAILURES)) {
        stats.stoppedBy = "failures";
        break;
      }
      await sleep(retrySleepMs);
    }
  }
  stats.elapsedMs = deadline ? deadline.elapsedMs() : 0;
  if (stats.stoppedBy === "budget") {
    // 一行講清楚「這次沒補完」：跑了幾輪、花多久、預算多少、最後一輪還想補幾筆。
    // 不寫 `pending` 是因為這一層沒有便宜又準確的待補筆數；`last_attempted` 是可靠的替代訊號
    // （等於 20 代表上一輪仍然拿滿 20 筆要補）。
    log(
      `${label}-budget-exhausted stage=${stage} rounds=${stats.rounds}`
      + ` elapsed_ms=${stats.elapsedMs} budget_ms=${stats.budgetMs}`
      + ` attempted=${stats.attempted} located=${stats.located} last_attempted=${stats.lastAttempted}`,
    );
  } else if (stats.stoppedBy === "failures") {
    log(
      `${label}-gave-up stage=${stage} failures=${stats.failures} consecutive=${stats.consecutiveFailures}`
      + ` rounds=${stats.rounds}：連續失敗達上限，停止重試（不再 sleep 重試）。`,
    );
  }
  return stats;
}
