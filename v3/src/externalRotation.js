// 外站來源的跨輪輪轉（2026-10-08）。
//
// 為什麼需要這個檔案（實測，不是猜）：
// `watcher.js` 裡五家外站是**寫死順序依序跑**（住商→信義→5168→租租通→好房網→樂屋），
// 而每家一輪要跑几十个行政區×頁面（沙盒實測每家約 93 頁），單頁逾時上限 8 秒
// （`crawlWatchdog.js` 的 `LIST_FETCH_TIMEOUT_MS`）。粗估一家就要 ~12 分鐘，五家 60 分鐘以上，
// 但整輪預算 `CRAWL_TICK_BUDGET_MS` 只有 40 分鐘 ⇒ 排在後面的家**每輪都被自己的取消訊號打死**：
// 正式站 `settings.crawlScheduleV1.sourceStreaks` 查得租租通／好房網 `fails=117`、
// `lastSuccessAt` 空字串（從未成功）、`last_error` 甚至是空；`listings.last_seen_at`
// 停在 2026-09-22（15 天）。這不是來源擋人，是我們自己讓它永遠排不到。
//
// 政策（這一檔負責的決策，全部可測）：
// 1. 一輪只排 `CRAWL_EXTERNAL_SOURCES_PER_RUN` 家（預設 1）。粗估 591 那 6 組×12 頁
//    加上一家外站剛好落在 40 分鐘預算內；五家輪流 ⇒ 每家約 5 輪（約 2 小時）排到一次。
// 2. 排序用**最久沒成功先跑**：`lastSuccessAt` 缺（從未成功）視為無限舊，排最前；
//    其餘依 `lastSuccessAt` 越舊越前面；同分維持傳入順序（目錄順序），確保可重現。
// 3. 還在冷卻期的家（被擋到停工，`isSourceCoolingDown`）**整輪排除**，不進 running 也不進 deferred。
// 4. 延後（deferred）**不是一種失敗**：呼叫端不對它呼叫 `noteSourceRound`，
//    所以不會累加 `fails`、不會誤裝冷卻期。這是整個改動的重點，不要「順手」記一筆。
//
// 這一檔不碰網路、不碰 DB，只用 `readCrawlSourceStreaksAsync()` 回來的 streak 形状：
// { fails, lastError, lastFailureAt, lastSuccessAt, blockedUntil }

export const EXTERNAL_SOURCES_PER_RUN_DEFAULT = 1;
export const EXTERNAL_SOURCES_PER_RUN_MAX = 6;

function envInt(raw, fallback, min, max) {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** 這一輪要排幾家外站。關不掉輪轉本身，只能調寬（1～6）。 */
export function externalSourcesPerRun(env = process.env) {
  return envInt(
    env?.CRAWL_EXTERNAL_SOURCES_PER_RUN,
    EXTERNAL_SOURCES_PER_RUN_DEFAULT,
    1,
    EXTERNAL_SOURCES_PER_RUN_MAX,
  );
}

/** streak.lastSuccessAt 距 now 多久（毫秒）；從未成功 ⇒ 無限舊（排最前）。 */
export function externalSourceStaleness(streak, now = Date.now()) {
  const raw = String(streak?.lastSuccessAt ?? "").trim();
  if (!raw) return Number.POSITIVE_INFINITY;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - at);
}

/**
 * 依「最久沒成功先跑」排序。輸入 [{ id, ... }]（要有 id），回傳**新陣列**，
 * 同分保持傳入順序（不靠 Array#sort 的實作細節，自己帶 index 比較）。
 */
export function rankExternalSources(tasks = [], streaks = {}, { now = Date.now() } = {}) {
  const rows = (Array.isArray(tasks) ? tasks : [])
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task && typeof task.id === "string" && task.id);
  const ranked = rows.sort((a, b) => {
    const left = externalSourceStaleness(streaks?.[a.task.id], now);
    const right = externalSourceStaleness(streaks?.[b.task.id], now);
    // 越餓（staleness 越大）越前面，所以是「大的排前面」而不是由小到大
    if (left !== right) return left > right ? -1 : 1;
    return a.index - b.index;
  });
  return ranked.map(({ task }) => task);
}

/**
 * 挑出這一輪要跑的几家。回傳 { running, deferred, cooling }：
 * - running：本輪要跑的（依序 await）
 * - deferred：本輪延後的（**不算失敗**，下一輪會因為更餓而排前面）
 * - cooling：還在冷卻期、這輪根本不碰的
 */
export function pickExternalSources(tasks = [], streaks = {}, {
  perRun = EXTERNAL_SOURCES_PER_RUN_DEFAULT,
  cooling = new Set(),
  now = Date.now(),
} = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const cooled = [];
  const eligible = [];
  for (const task of list) {
    if (!task || typeof task.id !== "string" || !task.id) continue;
    if (cooling instanceof Set ? cooling.has(task.id) : Array.from(cooling || []).includes(task.id)) {
      cooled.push(task);
      continue;
    }
    eligible.push(task);
  }
  const ranked = rankExternalSources(eligible, streaks, { now });
  const cap = Math.min(Math.max(Number(perRun) || 1, 1), EXTERNAL_SOURCES_PER_RUN_MAX);
  return {
    running: ranked.slice(0, cap),
    deferred: ranked.slice(cap),
    cooling: cooled,
  };
}
