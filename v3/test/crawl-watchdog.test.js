import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchListings } from "../src/client591.js";
import {
  CONSECUTIVE_TIMEOUT_LIMIT,
  LIST_FETCH_TIMEOUT_MS,
  TICK_BUDGET_MS,
  createTickGate,
  humanTimeoutMessage,
  isCrawlTimeoutError,
  noteConsecutiveTimeout,
  withBudget,
} from "../src/crawlWatchdog.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("request timeout message and consecutive skip", () => {
  assert.equal(humanTimeoutMessage("591 搜尋", 8000), "591 搜尋超過 8 秒沒回應，已放棄這次請求");
  assert.equal(humanTimeoutMessage("上一輪抓取", 15 * 60 * 1000), "上一輪抓取超過 15 分鐘沒結束，已自動放棄");
  const first = noteConsecutiveTimeout(0, new Error("591 搜尋超過 8 秒沒回應，已放棄這次請求"));
  assert.equal(first.consecutive, 1);
  assert.equal(first.skipRest, false);
  const last = noteConsecutiveTimeout(CONSECUTIVE_TIMEOUT_LIMIT - 1, { name: "TimeoutError" });
  assert.equal(last.skipRest, true);
  const other = noteConsecutiveTimeout(2, new Error("591 回應 419"));
  assert.equal(other.consecutive, 0);
  assert.equal(other.skipRest, false);
});

test("tick gate skips until budget, then abandon lets the next begin", () => {
  let now = 1_000;
  const gate = createTickGate({ budgetMs: 1_000, now: () => now });
  const first = gate.begin();
  assert.equal(gate.isBusy(), true);
  assert.equal(gate.isStale(), false);
  now = 1_500;
  assert.equal(gate.isStale(), false);
  now = 2_000;
  assert.equal(gate.isStale(), true);
  gate.abandon();
  assert.equal(gate.isBusy(), false);
  assert.equal(gate.isCurrent(first), false);
  const second = gate.begin();
  gate.end(first);
  assert.equal(gate.isBusy(), true);
  gate.end(second);
  assert.equal(gate.isBusy(), false);
});

test("withBudget abandons a hung promise", async () => {
  const started = Date.now();
  await assert.rejects(
    () => withBudget(new Promise(() => {}), 40, "測試抓取"),
    (error) => {
      assert.equal(isCrawlTimeoutError(error), true);
      assert.match(error.message, /測試抓取超過 1 秒沒回應|測試抓取超過/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 500);
});

test("591 list fetch times out instead of hanging", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = (_url, opts) => new Promise((_, reject) => {
    const signal = opts?.signal;
    if (!signal) {
      reject(new Error("missing abort signal"));
      return;
    }
    const fail = () => {
      const error = new Error("aborted");
      error.name = "TimeoutError";
      reject(error);
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
  try {
    await assert.rejects(
      () => fetchListings("https://rent.591.com.tw/list?region=1&section=8", 1, { timeoutMs: 40 }),
      (error) => {
        assert.match(error.message, /591 搜尋超過 1 秒沒回應，已放棄這次請求/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = prev;
  }
});

test("server and watcher wire timeout plus stale abandon", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  const client = readFileSync(path.join(dir, "../src/client591.js"), "utf8");
  assert.match(server, /withBudget/);
  assert.match(server, /TICK_BUDGET_MS/);
  assert.match(server, /skipped: "stale"/);
  assert.match(server, /tickGate\.abandon/);
  assert.doesNotMatch(server, /let tickBusy/);
  assert.match(watcher, /noteConsecutiveTimeout/);
  assert.match(watcher, /591 連續逾時，其餘縣市本輪跳過/);
  assert.match(client, /abortSignalTimeout/);
  assert.match(client, /humanTimeoutMessage\("591 搜尋"/);
  assert.equal(LIST_FETCH_TIMEOUT_MS, 8_000);
  assert.equal(TICK_BUDGET_MS, 15 * 60 * 1000);
});
