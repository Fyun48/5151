// listing_enrich_jobs 的「時鐘」（2026-10-07）。
//
// 為什麼要這支：`processListingEnrichBatch()` 一次只做**一趟**（queueSeed 40 ＋ claim limit），
// 而叫它的只有**事件**（使用者把 houseprice 物件加入關注、爬蟲輪次結束、點通知導向）。
// 沒有事件就沒有時鐘 ⇒ 正式站實測每小時只消化 20～36 筆，8759 筆 queued 要十幾天。
//
// 這支只負責「按期叫一次」，**不改 claim／退避的語意**：
//   * 每輪的筆數上限（tickLimit）保持與事件版同一個量級（預設 4），不要一次放數百筆去壓來源；
//     真出了事（403／限流）既有機制會自己退避（transient 60s→5m→15m、parse_failed 24h、
//     source_limited 12h），所以「節奏」由佇列的退避決定，時鐘只保證節奏不會停。
//   * 空轉要退避：連續 idleN 輪都沒撈到東西就跳 ticks（省查詢、省 log），一旦有工作就歸零。
//   * 重入保護：上一輪還沒結束就不疊加新一輪（`wakeListingEnrichWorker` 本身也只會有一條
//     worker promise，這裡再多一層是為了讓 idle 計數與 log 不會亂）。
//
// 開關（都走環境變數，**預設啟用**；關掉：`LISTING_ENRICH_CLOCK=0`）：
//   * `LISTING_ENRICH_CLOCK`        ＝ 0 ⇒ 不起時鐘（只剩事件 kick，等於 2026-10-07 前的行為）
//   * `LISTING_ENRICH_INTERVAL_MS`  ＝ 每輪間隔，預設 30000，夾在 5000～600000
//   * `LISTING_ENRICH_TICK_LIMIT`   ＝ 每輪最多 claim 幾筆，預設 4，夾在 1～12
//
// 角色：只在 `startWorkerLoops()` 內註冊（見 server.js），所以 `APP_ROLE=web` 的節點永遠不會跑它。
export const ENRICH_CLOCK_DEFAULTS = { intervalMs: 30_000, tickLimit: 4, idleTicksBeforeBackoff: 3, backoffFactor: 4 };

// 本輪節奏直接決定「每 30 秒最多打幾次外部站台」，所以这两个数字一定要夾住：
// 有人誤設成 5000 就會變成對來源掃射。取不到數字一律回預設值（不是 NaN）。
function envInt(raw, fallback, min, max) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function enrichClockConfig(env = process.env) {
  return {
    enabled: env.LISTING_ENRICH_CLOCK !== "0",
    intervalMs: envInt(env.LISTING_ENRICH_INTERVAL_MS, ENRICH_CLOCK_DEFAULTS.intervalMs, 5_000, 600_000),
    tickLimit: envInt(env.LISTING_ENRICH_TICK_LIMIT, ENRICH_CLOCK_DEFAULTS.tickLimit, 1, 12),
    idleTicksBeforeBackoff: ENRICH_CLOCK_DEFAULTS.idleTicksBeforeBackoff,
    backoffFactor: ENRICH_CLOCK_DEFAULTS.backoffFactor,
  };
}

// runTick 可以回傳數字（本輪嘗試幾筆）、回傳 { attempted } 、或回傳 Promise（含上述任一種）。
// 回傳 undefined 一律當成「有做事」（保守：不因為拿不到數字就退避）。
function attemptedOf(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  if (typeof value.attempted === "number") return value.attempted;
  return null;
}

export function startListingEnrichClock(runTick, config = {}, deps = {}) {
  const cfg = { ...enrichClockConfig(process.env), ...config };
  const setIntervalImpl = deps.setIntervalImpl || ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = deps.clearIntervalImpl || ((h) => clearInterval(h));
  const log = deps.log || (() => {});
  const fail = deps.fail || ((error) => console.warn("listing_enrich 時鐘失敗：", error?.message || error));

  let running = false;
  let idleTicks = 0;
  let ticks = 0;
  let handle = setIntervalImpl(() => {
    ticks += 1;
    if (running) {
      log("listing-enrich-clock-skip", { reason: "in-flight", ticks });
      return;
    }
    if (idleTicks >= cfg.idleTicksBeforeBackoff && ticks % cfg.backoffFactor !== 0) {
      return;
    }
    running = true;
    const finish = (value) => {
      running = false;
      const attempted = attemptedOf(value);
      idleTicks = attempted === 0 ? idleTicks + 1 : 0;
      if (attempted) log("listing-enrich-clock", { attempted, ticks });
    };
    const bail = (error) => {
      running = false;
      idleTicks = 0;
      fail(error);
    };
    try {
      const result = runTick({ tickLimit: cfg.tickLimit, intervalMs: cfg.intervalMs });
      if (result && typeof result.then === "function") result.then(finish, bail);
      else finish(result);
    } catch (error) {
      bail(error);
    }
  }, cfg.intervalMs);

  if (typeof handle?.unref === "function") handle.unref();

  return {
    handle,
    config: cfg,
    isRunning: () => running,
    idleTicks: () => idleTicks,
    stop() {
      if (handle) clearIntervalImpl(handle);
      handle = null;
    },
  };
}
