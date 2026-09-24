/** 全站共用抓取節奏。會員條件只決定「要看哪些區」，不各自再爬一遍。 */
export const CRAWL_PAGES_591 = 12;
export const CRAWL_PAGES_EXTERNAL = 6;
export const SYSTEM_CRAWL_INTERVAL_MINUTES = 15;

// 一輪最多跑幾組覆蓋條件。2026-09-24 實測：19 組 × 12 頁的「取頁階段」要 10 分鐘以上才會開始落地物件，
// 整輪因此超過 TICK_BUDGET_MS（15 分）被 withBudget() 放棄 → 完成紀錄永遠寫不進去 →
// isSystemCoveringDue() 一直回 true → 爬蟲背對背重跑。限制每輪組數讓輪次能在預算內跑完。
export const COVERING_JOBS_PER_RUN = 6;

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

