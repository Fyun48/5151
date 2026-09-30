/** 抓取期限會取消請求，並使該輪後續資料庫操作拒絕執行。 */
import { crawlRequestSignal, throwIfCrawlCancelled, withCrawlExecution } from "./crawlExecution.js";

export const LIST_FETCH_TIMEOUT_MS = 8_000;
// 一輪抓取的預算。2026-09-30（第九十一批）改成可用環境變數覆寫：
// 正式站實測「取頁 ~10-13 分鐘 ＋ 落地（PG 寫入／配對）~10 分鐘以上」⇒ 15 分鐘會在落地階段
// 被 withBudget() 放棄，`completeCoveringPlan()` 永遠跑不到，`crawl_covers.last_run_at` 從此凍結
// （2026-09-27 起就沒再更新），覆蓋條件每輪重跑。預設值不變（15 分），正式站用
// `CRAWL_TICK_BUDGET_MINUTES` 調高。
export const TICK_BUDGET_MS = (() => {
  const raw = Number(process.env.CRAWL_TICK_BUDGET_MINUTES);
  if (Number.isFinite(raw) && raw > 0) return Math.round(raw * 60 * 1000);
  return 15 * 60 * 1000;
})();
export const CONSECUTIVE_TIMEOUT_LIMIT = 3;

export function isAbortError(error) {
  const name = String(error?.name || "");
  const code = String(error?.code || "");
  return name === "TimeoutError" || name === "AbortError" || code === "ABORT_ERR" || code === "TIMEOUT";
}

export function humanTimeoutMessage(label, timeoutMs) {
  const ms = Math.max(1, Number(timeoutMs) || 0);
  if (ms >= 60_000) {
    const min = Math.max(1, Math.round(ms / 60_000));
    return `${label}超過 ${min} 分鐘沒結束，已自動放棄`;
  }
  const sec = Math.max(1, Math.round(ms / 1000));
  return `${label}超過 ${sec} 秒沒回應，已放棄這次請求`;
}

export function isCrawlTimeoutError(error) {
  if (isAbortError(error)) return true;
  return /沒回應，已放棄|沒結束，已自動放棄/.test(String(error?.message || ""));
}

/** 來源被封鎖／限速的錯誤碼。這些碼代表「別再打這個站台」，與一般查詢失敗不同。 */
export const SOURCE_BLOCKED_CODES = Object.freeze(["FETCH_BLOCKED", "RATE_LIMITED", "SOURCE_UNAVAILABLE"]);

/**
 * 這個錯誤是不是「整個來源暫時不能打」？
 *
 * 逐頁 fail-soft 的暫停條件：被擋（403／401）或限速（429／503）就別再打同一家，
 * 但**已經抓到的批次要照樣回報**；其他錯誤（逾時、解析失敗）只跳過那一頁。
 * 訊息比對是為了相容注入式 fetcher／舊呼叫端丟出的純 Error（沒有 `code`）。
 */
export function isSourceBlocked(error) {
  const code = String(error?.code || "");
  if (SOURCE_BLOCKED_CODES.includes(code)) return true;
  return /HTTP\s*(401|403|429|503)\b/.test(String(error?.message || ""));
}

/** 被擋幾次才放棄這一家（逐頁 fail-soft 的暫停門檻）。 */
export const SOURCE_BLOCK_PAUSE_LIMIT = 2;

/**
 * 逐頁 fail-soft 的「被擋幾次才暫停這一家」計數器。
 *
 * 為什麼不是第一次被擋就暫停（2026-09-30 沙盒實測）：5168 只在**部分行政區**被擋，
 * 第一次就暫停會讓整輪 0 筆（正式站 09-30 就是這樣：`houseprice` 的 `last_seen_at` 停在 09-26）；
 * 連續 2 次才暫停時，被擋之前抓到的行政區照樣留下來（沙盒同一輪落了 239 筆）。
 * 中間只要有一頁成功就歸零：WAF 的偶發阻擋不該讓整個來源整輪停工。
 */
export function noteSourceBlock(consecutive, error, limit = SOURCE_BLOCK_PAUSE_LIMIT) {
  if (!isSourceBlocked(error)) return { consecutive: 0, pause: false };
  const next = Math.trunc(Number(consecutive) || 0) + 1;
  const cap = Math.max(1, Math.trunc(Number(limit) || SOURCE_BLOCK_PAUSE_LIMIT));
  return { consecutive: next, pause: next >= cap };
}

/**
 * 來源的 HTTP 錯誤（帶 `code` 與**出事的網址**）。
 *
 * 為什麼一定要帶網址：2026-09-30 診斷 5168 的 403 時，輪次結果只留下
 * 「5168 暫時無法抓取（HTTP 403）」，看不出是哪一頁、哪個行政區中槍，只能靠人工重跑站台才找得到。
 * 錯誤樣本（`crawlScheduleV1.sourceStreaks[].lastError`）直接吃這個訊息。
 */
export function sourceHttpError(label, status, url = "") {
  const blocked = status === 401 || status === 403 || status === 429 || status === 503;
  const code = status === 429 ? "RATE_LIMITED"
    : (status === 401 || status === 403) ? "FETCH_BLOCKED"
      : status === 503 ? "SOURCE_UNAVAILABLE" : "FETCH_FAILED";
  const where = url ? `；${url}` : "";
  const message = blocked ? `${label}暫時無法抓取（HTTP ${status}${where}）` : `${label}搜尋 ${status}${where}`;
  return Object.assign(new Error(message), { code, status, url });
}

export function noteConsecutiveTimeout(consecutive, error, limit = CONSECUTIVE_TIMEOUT_LIMIT) {
  if (!isCrawlTimeoutError(error)) return { consecutive: 0, skipRest: false };
  const next = Number(consecutive || 0) + 1;
  const cap = Math.max(1, Number(limit) || CONSECUTIVE_TIMEOUT_LIMIT);
  return { consecutive: next, skipRest: next >= cap };
}

export function abortSignalTimeout(timeoutMs = LIST_FETCH_TIMEOUT_MS) {
  throwIfCrawlCancelled();
  const wait = Math.max(1, Number(timeoutMs) || LIST_FETCH_TIMEOUT_MS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    error.code = "TIMEOUT";
    ctrl.abort(error);
  }, wait);
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  const signal = crawlRequestSignal(ctrl.signal);
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  if (signal.aborted) clearTimeout(timer);
  return signal;
}

export async function withBudget(work, timeoutMs, label = "這輪抓取", { signal: parentSignal } = {}) {
  const ms = Math.max(1, Number(timeoutMs) || TICK_BUDGET_MS);
  let timer;
  const err = () => {
    const error = new Error(humanTimeoutMessage(label, ms));
    error.code = "TIMEOUT";
    error.name = "TimeoutError";
    return error;
  };
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  const timeoutError = err();
  const context = { controller, signal, deadline: Date.now() + ms, timeoutError };
  let onAbort;
  try {
    signal.throwIfAborted();
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    timer = setTimeout(() => controller.abort(timeoutError), ms);
    return await Promise.race([
      withCrawlExecution(context, async () => {
        throwIfCrawlCancelled();
        const result = await (typeof work === "function" ? work(signal) : work);
        throwIfCrawlCancelled();
        return result;
      }),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function createTickGate({ budgetMs = TICK_BUDGET_MS, now = () => Date.now() } = {}) {
  const budget = Math.max(1, Number(budgetMs) || TICK_BUDGET_MS);
  let busy = false;
  let startedAt = 0;
  let generation = 0;
  let controller = null;
  const superseded = () => Object.assign(new Error("抓取工作已被取消或取代"), { name: "AbortError", code: "ABORT_ERR" });

  return {
    isBusy() {
      return busy;
    },
    ageMs() {
      return busy ? Math.max(0, now() - startedAt) : 0;
    },
    isStale() {
      return busy && now() - startedAt >= budget;
    },
    isCurrent(gen) {
      return gen === generation;
    },
    signal(gen) {
      return gen === generation && controller ? controller.signal : AbortSignal.abort(superseded());
    },
    begin() {
      controller?.abort(superseded());
      controller = new AbortController();
      generation += 1;
      busy = true;
      startedAt = now();
      return generation;
    },
    abandon() {
      controller?.abort(superseded());
      generation += 1;
      busy = false;
      startedAt = 0;
      return generation;
    },
    end(gen) {
      if (gen === generation) {
        busy = false;
        startedAt = 0;
      }
    },
  };
}
