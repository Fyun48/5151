/** 抓取期限會取消請求，並使該輪後續資料庫操作拒絕執行。 */
import { crawlRequestSignal, throwIfCrawlCancelled, withCrawlExecution } from "./crawlExecution.js";

export const LIST_FETCH_TIMEOUT_MS = 8_000;
export const TICK_BUDGET_MS = 15 * 60 * 1000;
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
