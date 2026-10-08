/** 全站共用抓取節奏。會員條件只決定「要看哪些區」，不各自再爬一遍。 */
export const CRAWL_PAGES_591 = 12;
export const CRAWL_PAGES_EXTERNAL = 6;
export const SYSTEM_CRAWL_INTERVAL_MINUTES = 15;

// 一輪最多跑幾組覆蓋條件。2026-09-24 實測：19 組 × 12 頁的「取頁階段」要 10 分鐘以上才會開始落地物件，
// 整輪因此超過 TICK_BUDGET_MS（15 分）被 withBudget() 放棄 → 完成紀錄永遠寫不進去 →
// isSystemCoveringDue() 一直回 true → 爬蟲背對背重跑。限制每輪組數讓輪次能在預算內跑完。
export const COVERING_JOBS_PER_RUN = 6;

// ── 591 覆蓋階段的時間上限（2026-10-08 加）───────────────────────────────
// 為什麼還要有：外站已經有「每家階段預算」了，但正式站實測**地板是 591 自己**：
//   2026-10-08 07:12Z 那一輪，591 從 07:13:52 一路跑到 07:42:31（29 分鐘、1561 筆），
//   外站階段只分到「剩餘 9.5 分扣 2 分收尾＝7.5 分」；整輪 07:52:08 才收在預算內，
//   差一點點就又爆 40 分鐘。所以 591 段落不能吃整輪，要吃「本輪剩餘時間的一個比例」。
// 語意：上限只決定「這一輪跑到這裡先停」，**未跑完的覆蓋條件不會被記成完成**，
//       下一輪 `reserveCoveringPlan` 照樣把它們排在前面（沿用 rotateCoveringJobs 那套「續跑」骨架）。
export const COVERING_PHASE_SHARE_DEFAULT = 55;   // 本輪剩餘時間的 55% 給 591
export const COVERING_PHASE_SHARE_MIN = 30;
export const COVERING_PHASE_SHARE_MAX = 80;
export const COVERING_PHASE_MAX_MINUTES_DEFAULT = 20;
export const COVERING_PHASE_MAX_MINUTES_MIN = 5;
export const COVERING_PHASE_MAX_MINUTES_MAX = 30;
export const COVERING_PHASE_TAIL_MS = 120_000;    // 留 2 分鐘給輪尾收尾
export const COVERING_PHASE_MIN_MS = 300_000;     // 算出來少於 5 分就不設限（這一輪本來就快結束了）

function clampInt(raw, fallback, min, max) {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * 這一輪「591 覆蓋階段」應該在什麼時候停（回 epoch 毫秒；回 0 代表不設限）。
 *
 * `remainingMs` 是**這一輪的預算還剩多少**（由 `currentCrawlExecution().deadline` 換算）。
 * 拿不到就回 0：寧可維持舊行為，也不要憑空造一個上限把輪次咬死。
 */
export function coveringPhaseDeadlineMs({ now = Date.now(), remainingMs = 0, env = process.env } = {}) {
  const remaining = Number(remainingMs);
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  const share = clampInt(env?.CRAWL_COVERING_PHASE_SHARE, COVERING_PHASE_SHARE_DEFAULT, COVERING_PHASE_SHARE_MIN, COVERING_PHASE_SHARE_MAX);
  const capMs = clampInt(env?.CRAWL_COVERING_PHASE_MAX_MINUTES, COVERING_PHASE_MAX_MINUTES_DEFAULT, COVERING_PHASE_MAX_MINUTES_MIN, COVERING_PHASE_MAX_MINUTES_MAX) * 60_000;
  const usable = Math.max(0, remaining - COVERING_PHASE_TAIL_MS);
  const phase = Math.min(usable * (share / 100), capMs);
  if (phase < COVERING_PHASE_MIN_MS) return 0;
  return now + Math.round(phase);
}

/**
 * 取出這一輪要跑的覆蓋條件。超過上限時以「第幾輪」為步進輪替，所以連續兩輪一定接著跑
 * （不會每輪都只跑前幾組、後面的行政區永遠輪不到），掃完全部後回到開頭。
 */
export function rotateCoveringJobs(jobs = [], {
  limit = COVERING_JOBS_PER_RUN,
  now = Date.now(),
  intervalMs = SYSTEM_CRAWL_INTERVAL_MINUTES * 60 * 1000,
} = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.length <= 1) return list.slice();
  const cap = Math.max(1, Math.min(Number(limit) || COVERING_JOBS_PER_RUN, list.length));
  if (list.length <= cap) return list.slice();
  const windowCount = Math.ceil(list.length / cap);
  const stepMs = Math.max(60 * 1000, Number(intervalMs) || SYSTEM_CRAWL_INTERVAL_MINUTES * 60 * 1000);
  const round = Math.floor(Number(now) / stepMs);
  const windowIndex = ((round % windowCount) + windowCount) % windowCount;
  const start = (windowIndex * cap) % list.length;
  const slice = list.slice(start, start + cap);
  return slice.length === cap ? slice : [...slice, ...list.slice(0, cap - slice.length)];
}


/**
 * 來源每輪的行政區上限（2026-10-01 第九十七批，Owner 指定「給上限用輪詢的方式」）。
 *
 * 為什麼：5168（houseprice）只有台北／新北有 sid，而一輪可能同時派到台北(12 區)＋新北(29 區)
 * ⇒ 一輪最多 41 個行政區、兩百多個列表請求。實測（正式站容器）12 個行政區、89 個請求是安全的
 * （全部 200、取回 1,427 筆）；41 個行政區那種爆量才是把自己推進對方封鎖窗口的形狀。
 * 所以每一輪只抓「上限」個行政區，其餘**輪詢**到下一輪（時間窗推進，掃完一輪再從頭）。
 *
 * 演算法刻意與 `rotateCoveringJobs()` 共用同一份（同一個時間窗步進），不要另寫一套輪替。
 */
export function rotateSourceTargets(targets = [], {
  limit = 12,
  now = Date.now(),
  intervalMs = SYSTEM_CRAWL_INTERVAL_MINUTES * 60 * 1000,
} = {}) {
  return rotateCoveringJobs(targets, { limit, now, intervalMs });
}
