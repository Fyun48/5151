// 抓取來源的「連續失敗」狀態與放行政策（2026-09-30，第九十二批；Owner 當次同意政策變更）。
//
// 為什麼需要這一支：一輪抓取的完成紀錄，原本要求「該覆蓋條件在**每一個**啟用來源都成功」
// （`watcher.js` 的 `sourceSuccess.every(...)`）。這是刻意的保守設計，但正式站在 2026-09-27～09-30
// 出現了它的副作用：只要**任何一個**來源／分頁失敗，`successfulJobs` 就是空集合
// ⇒ 覆蓋完成紀錄永遠寫不進去（`crawl_covers.last_run_at` 38 列全部凍結在 09-27T04:05:35Z、
// `settings.lastCoveringAt` 停在 09-27T04:08:05Z、`crawlScheduleV1.completed` 是空的），
// 而輪次其實一直在跑（`lastSystemCoveringAt` 持續更新、591 房源持續落地）。
//
// 政策（本批起）：
//   1. 每個來源逐輪記錄 `sourceStreaks[source]`：連續失敗輪數、最後錯誤樣本、最後成功時間。
//   2. **連續失敗達門檻**（預設 3 輪）的來源不再阻擋完成紀錄，但一定伴隨明確 warning
//      （輪次結果的 `warnings` ＋ server log）與後台可見的來源健康狀態。
//   3. 來源一旦恢復成功，連續失敗立刻歸零、照舊從嚴。
//   4. 安全閥：如果**所有**來源都在容忍名單裡（等於全滅），就不記完成紀錄——
//      那種輪次不該被當成「已覆蓋」，寧可維持現狀並大聲告警。
//   5. 被擋而停工的來源會記下 `blockedUntil`（冷卻期）：下一輪若還在冷卻就跳過這一家，
//      不要每一輪開頭都去撞同一面牆（2026-09-30 第九十六批）。
//
// 這一支只有純函式（沒有 DB、沒有 driver），落地的讀寫在 `crawlScheduleAsync.js`
// （`recordCrawlSourceRoundAsync`／`readCrawlSourceStreaksAsync`），設定鍵沿用 `crawlScheduleV1`。
import { CRAWL_SOURCE_CATALOG } from "./crawlSources.js";
import { sourceBlockedUntil } from "./crawlWatchdog.js";

/** 連續失敗幾輪之後，該來源不再阻擋完成紀錄（政策門檻）。 */
export const SOURCE_FAILURE_ROUNDS_BEFORE_TOLERATED = 3;

/** 最後錯誤樣本的最長長度（狀態要寫進 settings，不外洩整包 HTML／stack）。 */
export const SOURCE_ERROR_SAMPLE_MAX = 240;

/** 來源 id → 人看得懂的標籤（沿用來源清單，只有一份）。 */
export function crawlSourceLabel(id) {
  const key = String(id || "");
  return CRAWL_SOURCE_CATALOG.find((row) => row.id === key)?.label || key;
}

/** 單一來源的連續失敗紀錄（壞資料一律收斂成安全形狀，不要讓舊狀態弄壞整輪）。 */
export function normalizeSourceStreak(row) {
  return {
    fails: Math.max(0, Math.trunc(Number(row?.fails) || 0)),
    lastError: String(row?.lastError || "").slice(0, SOURCE_ERROR_SAMPLE_MAX),
    lastFailureAt: String(row?.lastFailureAt || ""),
    lastSuccessAt: String(row?.lastSuccessAt || ""),
    // 第九十六批：被擋而停工的來源要「記住冷卻到什麼時候」，下一輪才不會一開頭就去撞同一面牆。
    blockedUntil: String(row?.blockedUntil || ""),
  };
}

/** 這一輪這個來源算不算成功：**該輪的每一個 job 都要成功**（部分成功仍算失敗輪，保守）。 */
export function isCoveredRound(round) {
  const total = Math.trunc(Number(round?.total) || 0);
  const covered = Math.trunc(Number(round?.covered) || 0);
  return total > 0 && covered >= total;
}

/** 目前已在容忍名單（連續失敗達門檻）的來源：判定只有一份，讀寫兩邊共用。 */
export function toleratedCrawlSources(streaks, options = {}) {
  const threshold = Math.max(1, Math.trunc(Number(options.threshold) || SOURCE_FAILURE_ROUNDS_BEFORE_TOLERATED));
  return Object.entries(streaks && typeof streaks === "object" ? streaks : {})
    .filter(([, row]) => normalizeSourceStreak(row).fails >= threshold)
    .map(([id]) => id);
}

/**
 * 把這一輪各來源的結果併進連續失敗狀態。
 *
 * @param {Record<string, object>} streaks 先前的狀態（`crawlScheduleV1.sourceStreaks`）。
 * @param {Array<{source: string, covered: number, total: number, error?: string}>} rounds 這一輪各來源的結果。
 * @param {{at?: string, threshold?: number}} [options]
 * @returns {{streaks: Record<string, object>, tolerated: string[], toleratedNow: string[],
 *            recovered: string[], failed: string[]}}
 *   `tolerated` 是「這一輪起不再阻擋完成紀錄」的來源（含先前就已達門檻的），
 *   `toleratedNow` 是這一輪才越過門檻的（用來產生一次性的 warning）。
 */
export function applySourceRound(streaks, rounds, options = {}) {
  const at = String(options.at || new Date().toISOString());
  const threshold = Math.max(1, Math.trunc(Number(options.threshold) || SOURCE_FAILURE_ROUNDS_BEFORE_TOLERATED));
  const next = {};
  for (const [id, row] of Object.entries(streaks && typeof streaks === "object" ? streaks : {})) {
    next[id] = normalizeSourceStreak(row);
  }
  const failed = [];
  const recovered = [];
  const toleratedNow = [];
  const blocked = [];
  const notApplicable = [];
  for (const round of Array.isArray(rounds) ? rounds : []) {
    const id = String(round?.source || "");
    if (!id) continue;
    // 「這一輪這個來源沒有可抓的行政區」⇒ 不算成功、也不算失敗，狀態原封不動。
    if (round?.applicable === false) { notApplicable.push(id); continue; }
    const prev = next[id] || normalizeSourceStreak();
    if (isCoveredRound(round)) {
      // 恢復成功立刻歸零（照舊從嚴）；最後錯誤樣本留著當歷史，不影響判定。
      if (prev.fails > 0) recovered.push(id);
      next[id] = { ...prev, fails: 0, lastSuccessAt: at, blockedUntil: "" };
      continue;
    }
    const fails = prev.fails + 1;
    if (fails === threshold) toleratedNow.push(id);
    failed.push(id);
    if (round?.blocked === true) blocked.push(id);
    next[id] = {
      ...prev,
      fails,
      lastFailureAt: at,
      lastError: String(round?.error || prev.lastError || "").slice(0, SOURCE_ERROR_SAMPLE_MAX),
      // 這一輪因為被擋而停工 ⇒ 記下冷卻到什麼時候；否則保留原本的值（下一輪若還在冷卻就跳過）。
      blockedUntil: round?.blocked === true
        ? sourceBlockedUntil(at, Number(round?.cooldownMs) || undefined)
        : prev.blockedUntil,
    };
  }
  return { streaks: next, tolerated: toleratedCrawlSources(next, { threshold }), toleratedNow, recovered, failed, blocked, notApplicable };
}

/**
 * 這一輪的批次裡有沒有「被擋到停工」的來源？
 *
 * 抽成純函式有兩個理由：(1) watcher 的 `collectExternal` 在 try/catch 之後才用得到它，
 * 寫成行內運算式很容易踩到作用域錯誤（2026-09-30 沙盒第一輪就是 `batches is not defined`）；
 * (2) 這樣才有單元測試蓋得到（純函式可測，不必驅動整個 runWatch）。
 */
export function sourceRoundBlocked(batches) {
  return (Array.isArray(batches) ? batches : []).some((batch) => batch?.blocked === true);
}

/** 這一輪「還算嚴格」的來源：只有它們會阻擋完成紀錄。 */
export function blockingCrawlSources(entries, tolerated) {
  const toleratedSet = new Set((tolerated || []).map(String));
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    // 這一輪「沒有可抓行政區」的來源不可能覆蓋任何條件，不可以讓它擋住完成紀錄。
    if (entry?.applicable === false) return false;
    return !toleratedSet.has(String(entry?.source || ""));
  });
}

/**
 * 該 job 是否被「所有還在嚴格的來源」覆蓋。
 * ⚠️ `blocking` 空集合時回 **false**（不是 `every` 的 true）：全體來源都在容忍名單裡
 * ＝全滅，這種輪次不記完成紀錄（安全閥，見檔頭第 4 點）。
 */
export function jobCoveredByBlockingSources(job, blocking) {
  const list = Array.isArray(blocking) ? blocking : [];
  if (!list.length) return false;
  return list.every((entry) => entry?.urls?.has?.(job?.searchUrl) === true);
}

/** 輪次結果與日誌要留的 warning（純文字陣列，方便直接 push 進 `warnings`／`console.warn`）。 */
export function sourceRoundWarnings(applied, rounds) {
  const byId = new Map((Array.isArray(rounds) ? rounds : []).map((round) => [String(round?.source || ""), round]));
  const failsOf = (id) => Math.trunc(Number(applied?.streaks?.[String(id)]?.fails) || 0);
  const lines = [];
  for (const id of applied?.toleratedNow || []) {
    const round = byId.get(String(id)) || {};
    const detail = [
      `這一輪覆蓋 ${Math.trunc(Number(round.covered) || 0)}/${Math.trunc(Number(round.total) || 0)} 組條件`,
      round.error ? `最後錯誤：${String(round.error).slice(0, SOURCE_ERROR_SAMPLE_MAX)}` : "",
    ].filter(Boolean).join("；");
    lines.push(`抓取來源「${crawlSourceLabel(id)}」已連續失敗 ${failsOf(id)} 輪，這一輪起不再阻擋覆蓋完成紀錄（${detail}；後台「抓取來源」卡片可見）`);
  }
  for (const id of applied?.recovered || []) {
    lines.push(`抓取來源「${crawlSourceLabel(id)}」恢復成功，連續失敗已歸零（恢復從嚴）`);
  }
  return lines;
}
